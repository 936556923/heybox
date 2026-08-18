const HttpClient = require("./http");
const tools = require("./tools");

const client = new HttpClient({ timeoutMs: 10000 });

async function sendServerChan(key, title, content) {
  if (!key) return false;
  try {
    const url = `https://sctapi.ftqq.com/${key}.send`;
    await client.post({
      url,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `title=${encodeURIComponent(title)}&desp=${encodeURIComponent(content)}`,
    });
    return true;
  } catch (e) {
    tools.log(`Server酱推送失败: ${e.message}`);
    return false;
  }
}

async function sendPushPlus(token, title, content) {
  if (!token) return false;
  try {
    await client.post({
      url: "https://www.pushplus.plus/send",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        title,
        content,
        template: "markdown",
      }),
    });
    return true;
  } catch (e) {
    tools.log(`PushPlus推送失败: ${e.message}`);
    return false;
  }
}

async function sendBark(barkUrl, title, content) {
  if (!barkUrl) return false;
  try {
    const baseUrl = barkUrl.replace(/\/$/, "");
    const url = `${baseUrl}/${encodeURIComponent(title)}/${encodeURIComponent(content)}`;
    await client.get({ url });
    return true;
  } catch (e) {
    tools.log(`Bark推送失败: ${e.message}`);
    return false;
  }
}

async function sendTelegram(botToken, chatId, title, content) {
  if (!botToken || !chatId) return false;
  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    await client.post({
      url,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: `*${title}*\n\n${content}`,
        parse_mode: "Markdown",
      }),
    });
    return true;
  } catch (e) {
    tools.log(`Telegram推送失败: ${e.message}`);
    return false;
  }
}

async function sendNotify(title, content) {
  const env = process.env;
  const serverChanKey = env.push_key || env.SERVERCHAN_KEY || env.PUSH_KEY;
  const pushPlusToken = env.pushplus_token || env.PUSHPLUS_TOKEN;
  const barkUrl = env.bark_url || env.BARK_URL;
  const tgBotToken = env.tg_bot_token || env.TG_BOT_TOKEN;
  const tgChatId = env.tg_chat_id || env.TG_CHAT_ID;

  let sent = false;
  if (serverChanKey) sent = (await sendServerChan(serverChanKey, title, content)) || sent;
  if (pushPlusToken) sent = (await sendPushPlus(pushPlusToken, title, content)) || sent;
  if (barkUrl) sent = (await sendBark(barkUrl, title, content)) || sent;
  if (tgBotToken && tgChatId) sent = (await sendTelegram(tgBotToken, tgChatId, title, content)) || sent;

  if (sent) {
    tools.log("消息推送发送成功");
  }
  return sent;
}

module.exports = {
  sendNotify,
  sendServerChan,
  sendPushPlus,
  sendBark,
  sendTelegram,
};
