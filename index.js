import dotenv from 'dotenv';
import { trackedPairs } from './pairs.js';
import { EXCLUDED_PAIRS } from './excludedPairs.js';
import { handleRSI, checkTargetAchieved } from './strategy.js';

dotenv.config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_IDS = process.env.TELEGRAM_CHAT_ID.split(','); // Split multiple chat IDs into an array

// Function to monitor tokens
const monitorTokens = async () => {
  console.log('Monitoring started...');
  const usdtPairs = trackedPairs.filter(
    (pair) => !EXCLUDED_PAIRS.includes(pair) && pair.endsWith('USDT')
  );

  if (usdtPairs.length > 0) {
    console.log('Monitoring pairs:', usdtPairs.join(', '));
    const promises = usdtPairs.map((pair) =>
      handleRSI(pair, TELEGRAM_TOKEN, CHAT_IDS) // Pass CHAT_IDS to handleRSI
    );
    await Promise.all(promises);
  } else {
    console.log('No valid USDT pairs found.');
  }

  console.log('Monitoring completed.');
};

// Main function
const main = async () => {
  await monitorTokens();
  setInterval(monitorTokens, 61000);
  setInterval(() => checkTargetAchieved(TELEGRAM_TOKEN, CHAT_IDS), 61000); // Pass CHAT_IDS to checkTargetAchieved
};

// Start monitoring
main();
