import axios from 'axios';

let subscribedUsers = new Set(); // A Set to keep track of subscribed users.

export const sendTelegramMessage = async (token, chatId, message) => {
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const response = await axios.post(url, {
      chat_id: chatId,
      text: message,
      parse_mode: 'Markdown',
    });
    console.log('Message sent to Telegram:', message);
    return response.data.result.message_id;
  } catch (error) {
    console.error('Error sending message to Telegram:', error);
  }
};

export const editTelegramMessage = async (token, chatId, messageId, newMessage) => {
  try {
    const url = `https://api.telegram.org/bot${token}/editMessageText`;
    await axios.post(url, {
      chat_id: chatId,
      message_id: messageId,
      text: newMessage,
      parse_mode: 'Markdown',
    });
    console.log('Message edited successfully:', newMessage);
  } catch (error) {
    console.error('Error editing Telegram message:', error);
  }
};

// Function to handle incoming messages
export const handleMessage = async (token, chatId, message) => {
  const lowerMessage = message.toLowerCase();

  if (lowerMessage === '/start') {
    // Add user to the subscription list
    if (!subscribedUsers.has(chatId)) {
      subscribedUsers.add(chatId);
      await sendTelegramMessage(token, chatId, "🎉 You've successfully subscribed to receive signals!");
    } else {
      await sendTelegramMessage(token, chatId, "✅ You're already subscribed to receive signals.");
    }
  } else if (lowerMessage === '/stop') {
    // Remove user from the subscription list
    if (subscribedUsers.has(chatId)) {
      subscribedUsers.delete(chatId);
      await sendTelegramMessage(token, chatId, "⛔ You've unsubscribed from receiving signals.");
    } else {
      await sendTelegramMessage(token, chatId, "❌ You're not subscribed to any signals.");
    }
  }
};

// Function to send signals to all subscribed users
export const sendSignalToSubscribers = async (token, message) => {
  for (const chatId of subscribedUsers) {
    await sendTelegramMessage(token, chatId, message);
  }
};
