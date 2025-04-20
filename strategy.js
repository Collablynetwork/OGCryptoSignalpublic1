import axios from 'axios';
import moment from 'moment';
import { sendTelegramMessage, editTelegramMessage } from './telegram.js';
import fs from 'fs';

// Define log file paths
const RSI_LOG_FILE = './rsi_data.csv';
const BUY_SIGNAL_LOG_FILE = './buy_signals.csv';

// Global constants
const RSI_PERIOD = 14;

// Global trackers
const lastNotificationTimes = {};
const sellPrices = {};
const bottomPrices = {};
const entryPrices = {};
let lastBTCPrice = null;
const btcPriceHistory = [];

// Initialize log files
const initializeLogFiles = () => {
  if (!fs.existsSync(RSI_LOG_FILE)) {
    fs.writeFileSync(
      RSI_LOG_FILE,
      'Timestamp,Symbol,MACD_6h_Crossover,MACD_4h,RSI_4h,RSI_15m,RSI_1m,Current Price\n'
    );
  }
  if (!fs.existsSync(BUY_SIGNAL_LOG_FILE)) {
    fs.writeFileSync(
      BUY_SIGNAL_LOG_FILE,
      'Timestamp,Symbol,MACD_6h_Crossover,MACD_4h,RSI_4h,RSI_15m,RSI_1m,Buy Price,Sell Price,Duration,Bottom Price,Percentage Drop,BTC Change,BTC 30m Change\n'
    );
  }
};
initializeLogFiles();

// --- Active 4h Signal Windows (UTC) ---
const isSignalWindow = () => {
  const now = moment().utc();
  const totalMin = now.hour() * 60 + now.minute();
  const windows = [
    [  30,   90],   // 00:30–01:30
    [ 270,  330],   // 04:30–05:30
    [ 510,  570],   // 08:30–09:30
    [ 750,  810],   // 12:30–13:30
    [ 990, 1050],   // 16:30–17:30
    [1230, 1290],   // 20:30–21:30
  ];
  return windows.some(([start, end]) => totalMin >= start && totalMin < end);
};

// --- Indicator Calculations ---

// Calculate RSI
const calculateRSI = (prices, period = RSI_PERIOD) => {
  if (prices.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const delta = prices[i] - prices[i - 1];
    if (delta > 0) gains += delta;
    else losses -= delta;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
};

// Calculate EMA series
const calculateEMA = (prices, period) => {
  const k = 2 / (period + 1);
  const ema = [];
  const sma = prices.slice(0, period).reduce((sum, p) => sum + p, 0) / period;
  ema[period - 1] = sma;
  for (let i = period; i < prices.length; i++) {
    ema[i] = prices[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
};

// Calculate complete MACD data (MACD line, signal line, and histogram)
const calculateCompleteMACD = (prices) => {
  if (prices.length < 35) return null; // Need at least 26 + 9 periods
  
  const ema12 = calculateEMA(prices, 12);
  const ema26 = calculateEMA(prices, 26);
  
  // Calculate MACD line (ema12 - ema26)
  const macdLine = [];
  for (let i = 25; i < prices.length; i++) {
    macdLine.push(ema12[i] - ema26[i]);
  }
  
  // Calculate signal line (9-period EMA of MACD line)
  const signalLine = calculateEMA(macdLine, 9);
  
  // Calculate histogram (MACD line - signal line)
  const histogram = [];
  for (let i = 8; i < macdLine.length; i++) {
    histogram.push(macdLine[i] - signalLine[i]);
  }
  
  return {
    macdLine,
    signalLine,
    histogram,
    current: {
      macd: macdLine[macdLine.length - 1],
      signal: signalLine[signalLine.length - 1],
      histogram: histogram[histogram.length - 1]
    },
    previous: {
      macd: macdLine[macdLine.length - 2],
      signal: signalLine[signalLine.length - 2],
      histogram: histogram[histogram.length - 2]
    }
  };
};

// Original MACD calculation for backward compatibility
const calculateMACD = (prices) => {
  if (prices.length < 26) return null;
  const ema12 = calculateEMA(prices, 12);
  const ema26 = calculateEMA(prices, 26);
  return ema12[ema12.length - 1] - ema26[ema26.length - 1];
};

// Detect MACD bullish crossover with lookback period
const isMACDBullishCrossover = (macdData, lookbackPeriods = 5) => {
  if (!macdData || !macdData.macdLine || !macdData.signalLine) return false;
  
  // First check if MACD is currently above signal (bullish condition)
  const currentIndex = macdData.macdLine.length - 1;
  if (macdData.macdLine[currentIndex] > macdData.signalLine[currentIndex]) {
    // If currently bullish, check for a crossover within the lookback period
    const startIndex = Math.max(0, currentIndex - lookbackPeriods);
    
    for (let i = startIndex; i < currentIndex; i++) {
      // Check for the moment when MACD crosses above signal
      if (macdData.macdLine[i] <= macdData.signalLine[i] && 
          macdData.macdLine[i+1] > macdData.signalLine[i+1]) {
        return true; // Found a crossover within lookback period
      }
    }
    
    // If we're in the early stages of a strong bullish trend,
    // even without a recent crossover, we might want to consider it valid
    if (macdData.macdLine[currentIndex] > macdData.signalLine[currentIndex] * 1.05) {
      return true; // MACD is at least 5% above signal line (strong bullish)
    }
  }
  
  return false;
};

// --- Data Fetching ---

// Fetch candlestick closing prices
const fetchCandlestickData = async (symbol, interval, limit = RSI_PERIOD + 1) => {
  try {
    const resp = await axios.get('https://api.binance.com/api/v3/klines', {
      params: { symbol, interval, limit }
    });
    return resp.data.map(c => parseFloat(c[4])); // close prices
  } catch (err) {
    console.error(`Error fetching ${interval} data for ${symbol}:`, err.message);
    return null;
  }
};

// Fetch and compute RSI for any interval
const fetchAndCalculateRSI = async (symbol, interval) => {
  const prices = await fetchCandlestickData(symbol, interval, RSI_PERIOD + 1);
  return prices ? calculateRSI(prices) : null;
};

// Fetch and check for 6h MACD bullish crossover
const fetch6hMACDCrossover = async (symbol) => {
  // We need at least 35 days of data to calculate MACD and signal line
  const prices = await fetchCandlestickData(symbol, '6h', 50);
  if (!prices) return { hasCrossover: false, macdData: null };
  
  const macdData = calculateCompleteMACD(prices);
  const hasCrossover = isMACDBullishCrossover(macdData);
  
  console.log(`MACD 6h analysis for ${symbol}:`);
  if (macdData && macdData.current) {
    console.log(`- Current MACD: ${macdData.current.macd}`);
    console.log(`- Current Signal: ${macdData.current.signal}`);
    console.log(`- Current Histogram: ${macdData.current.histogram}`);
    console.log(`- MACD > Signal: ${macdData.current.macd > macdData.current.signal}`);
    console.log(`- Bullish Crossover detected: ${hasCrossover}`);
  }
  
  return { hasCrossover, macdData };
};

// Fetch current BTC price and maintain 30m history
const fetchBTCPrice = async () => {
  try {
    const resp = await axios.get('https://api.binance.com/api/v3/ticker/price', {
      params: { symbol: 'BTCUSDT' }
    });
    const price = parseFloat(resp.data.price);
    btcPriceHistory.push({ price, timestamp: moment() });
    const cutoff = moment().subtract(31, 'minutes');
    while (btcPriceHistory.length && btcPriceHistory[0].timestamp.isBefore(cutoff)) {
      btcPriceHistory.shift();
    }
    return price;
  } catch (err) {
    console.error('Error fetching BTC price:', err.message);
    return null;
  }
};

// Compute BTC % change now vs last and vs 30m ago
const calculateBTCChanges = async () => {
  const current = await fetchBTCPrice();
  if (!current) return { price: null, change: null, change30m: null };
  const change = lastBTCPrice
    ? ((current - lastBTCPrice) / lastBTCPrice * 100).toFixed(2)
    : null;
  let change30m = null;
  const cutoff = moment().subtract(30, 'minutes');
  const old = btcPriceHistory.find(e => e.timestamp.isSameOrBefore(cutoff));
  if (old) change30m = ((current - old.price) / old.price * 100).toFixed(2);
  lastBTCPrice = current;
  return { price: current, change, change30m };
};

// --- Logging ---

const logRSIAndPrice = (symbol, rsi4h, macd4h, rsi15m, rsi1m, price, macd6hCrossover) => {
  const ts = moment().format('YYYY-MM-DD HH:mm:ss');
  // Updated order: timestamp, symbol, macd6hCrossover, macd4h, rsi4h, rsi15m, rsi1m, price
  const line = `${ts},${symbol},${macd6hCrossover},${macd4h},${rsi4h},${rsi15m},${rsi1m},${price}\n`;
  fs.appendFile(RSI_LOG_FILE, line, err => {
    if (err) console.error('Error logging RSI data:', err.message);
  });
};

const logBuySignal = (
  symbol,
  rsi4h,
  macd4h,
  rsi15m,
  rsi1m,
  buyPrice,
  sellPrice,
  duration,
  bottomPrice,
  drop,
  btcChange,
  btcChange30m,
  macd6hCrossover
) => {
  const ts = moment().format('YYYY-MM-DD HH:mm:ss');
  const line = `${ts},${symbol},${rsi4h},${macd4h},${rsi15m},${rsi1m},${buyPrice},${sellPrice},${duration},${bottomPrice},${drop},${btcChange},${btcChange30m},${macd6hCrossover}\n`;
  fs.appendFile(BUY_SIGNAL_LOG_FILE, line, err => {
    if (err) console.error('Error logging buy signal:', err.message);
  });
};

// --- Core Logic ---

export const handleRSI = async (symbol, token, chatIds) => {
  // 1) fetch all indicators
  const [ rsi4h, rsi15m, prices1m ] = await Promise.all([
    fetchAndCalculateRSI(symbol, '4h'),
    fetchAndCalculateRSI(symbol, '15m'),
    fetchCandlestickData(symbol, '1m', RSI_PERIOD + 1),
  ]);
  if (rsi4h === null || rsi15m === null || !prices1m) return;
  const rsi1m = calculateRSI(prices1m);
  const currentPrice = prices1m[prices1m.length - 1];

  // compute MACD4h
  const prices4h = await fetchCandlestickData(symbol, '4h', 50);
  const macd4h = prices4h ? calculateMACD(prices4h) : null;

  // check for 6h MACD bullish crossover
  const { hasCrossover: macd6hCrossover } = await fetch6hMACDCrossover(symbol);

  const btcData = await calculateBTCChanges();

  console.log(
    `Indicators for ${symbol} → 6h MACD Crossover: ${macd6hCrossover}, MACD4h: ${macd4h}, 4h RSI: ${rsi4h}, ` +
    `15m RSI: ${rsi15m}, 1m RSI: ${rsi1m}, Price: ${currentPrice}`
  );
  logRSIAndPrice(symbol, rsi4h, macd4h, rsi15m, rsi1m, currentPrice, macd6hCrossover);

  // 2) check existing open signal
  const existing = sellPrices[symbol];
  if (existing) {
    // update entry if price drops further
    if (
      currentPrice < existing.sellPrice &&
      (existing.entryPrices.length === 0 || currentPrice <= existing.entryPrices[0] * 0.99)
    ) {
      existing.entryPrices.unshift(currentPrice);
      const text = `
📢 **Buy Signal Update**
💎 Token: #${symbol}
💰 Entry Prices: ${existing.entryPrices.join(' - ')}
💰 Sell Price: ${existing.sellPrice}
🕒 Timeframes: 1m update
💹 Trade Now on: [Binance](https://www.binance.com/en/trade/${symbol})
`;
      for (const id of chatIds) {
        await editTelegramMessage(token, id, existing.messageId, text);
      }
    }
    return;
  }

  // 3) new buy condition only during active windows
  if (
    isSignalWindow() &&
    macd4h > 0 &&
    rsi4h > 55 &&
    rsi15m < 45 &&
    rsi1m < 30 &&
    macd6hCrossover  // Added 6h MACD bullish crossover condition
  ) {
    const now = moment().utc();
    const lastNotified = lastNotificationTimes[symbol];
    if (lastNotified && now.diff(lastNotified, 'minutes') < 30) return;
    lastNotificationTimes[symbol] = now;

    // record entry
    entryPrices[symbol] = [ currentPrice ];
    const sellPrice = (currentPrice * 1.023).toFixed(8);

    // send message
    const msg = `
🚀 **Buy Signal**
💎 Token: #${symbol}
💰 Entry Price: ${currentPrice}
💰 Target Sell: ${sellPrice}
💹 Trade Now on: [Binance](https://www.binance.com/en/trade/${symbol})
`;
    const mIds = [];
    for (const id of chatIds) {
      const mid = await sendTelegramMessage(token, id, msg);
      mIds.push(mid);
    }

    // store open signal
    sellPrices[symbol] = {
      entryPrices: [ currentPrice ],
      sellPrice,
      messageId: mIds[0],
      buyTime: now,
      btcPriceAtBuy: btcData.price,
      macd6hCrossover
    };
    bottomPrices[symbol] = currentPrice;
  }
};

export const checkTargetAchieved = async (token, chatIds) => {
  for (const symbol in sellPrices) {
    const { sellPrice, entryPrices, messageId, buyTime, btcPriceAtBuy, macd6hCrossover } = sellPrices[symbol];
    const prices = await fetchCandlestickData(symbol, '1m', RSI_PERIOD + 1);
    if (!prices) continue;

    const current = prices[prices.length - 1];
    const btcData = await calculateBTCChanges();

    // track bottom
    bottomPrices[symbol] = Math.min(bottomPrices[symbol], current);

    if (current >= sellPrice) {
      const dur = moment.duration(moment().diff(buyTime));
      const period = `${dur.hours()}h ${dur.minutes()}m ${dur.seconds()}s`;
      const bottom = bottomPrices[symbol];
      const drop = (((entryPrices[0] - bottom) / entryPrices[0]) * 100).toFixed(2);
      const btcChange = btcData.price != null
        ? ((btcData.price - btcPriceAtBuy) / btcPriceAtBuy * 100).toFixed(2)
        : null;

      const text = `
✅ **Target Achieved**
💎 Token: #${symbol}
💰 Entry: ${entryPrices[0]}
💰 Target: ${sellPrice}
📉 Bottom: ${bottom} (${drop}% drawdown)
⏱️ Duration: ${period}
💹 Trade Now on: [Binance](https://www.binance.com/en/trade/${symbol})
`;
      for (const id of chatIds) {
        await editTelegramMessage(token, id, messageId, text);
      }

      // **CORRECTED**: use `drop` (not `drawdown`)
      logBuySignal(
        symbol,
        '',     // rsi4h
        '',     // macd4h
        '',     // rsi15m
        '',     // rsi1m
        entryPrices[0],
        sellPrice,
        period,
        bottom,
        drop,
        btcChange,
        btcData.change30m,
        macd6hCrossover ? 'true' : 'false'
      );

      delete sellPrices[symbol];
      delete bottomPrices[symbol];
      delete entryPrices[symbol];
    }
  }
};
