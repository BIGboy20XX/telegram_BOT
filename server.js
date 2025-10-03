import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import cheerio from "cheerio";
import TelegramBot from "node-telegram-bot-api";

// === Настройки ===
const TOKEN = process.env.TELEGRAM_TOKEN;
const URL = `https://api.telegram.org/bot${TOKEN}`;
const PORT = process.env.PORT || 3000;

const app = express();
app.use(bodyParser.json());

// === Telegram Bot ===
const bot = new TelegramBot(TOKEN);
bot.setWebHook(`${process.env.RENDER_EXTERNAL_URL}/webhook/${TOKEN}`);

app.post(`/webhook/${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// === БД (в памяти) ===
let userSites = {}; // { chatId: [ { url, lastHash } ] }

// === Хэширование контента ===
import crypto from "crypto";
function getHash(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

// === Зеркала для сайтов ===
const RSS_MIRRORS = {
  "tumblr.com": url => {
    const u = new URL(url);
    let blogName = null;

    // Вариант 1: username.tumblr.com
    if (u.hostname.endsWith(".tumblr.com")) {
      blogName = u.hostname.split(".")[0];
    }
    // Вариант 2: www.tumblr.com/blog/username
    else if (u.hostname === "www.tumblr.com" && u.pathname.startsWith("/blog/")) {
      blogName = u.pathname.split("/")[2];
    }
    // Вариант 3: www.tumblr.com/username
    else if (u.hostname === "www.tumblr.com" && u.pathname.split("/")[1]) {
      blogName = u.pathname.split("/")[1];
    }

    if (!blogName) return [];

    return [
      `https://${blogName}.tumblr.com/rss`,
      `https://rsshub.app/tumblr/blog/${blogName}`
    ];
  }
};

// === Проверка сайта ===
async function checkSite(url) {
  try {
    console.log(`👀 Проверка ${url}`);

    // Если есть RSS-зеркала
    for (const domain in RSS_MIRRORS) {
      if (url.includes(domain)) {
        const mirrors = RSS_MIRRORS[domain](url);
        for (const m of mirrors) {
          try {
            const r = await fetch(m, { timeout: 10000 });
            if (r.ok) {
              const text = await r.text();
              return getHash(text.slice(0, 10000));
            } else {
              console.log(`⚠️ Зеркало ${m} не сработало: Status code ${r.status}`);
            }
          } catch (e) {
            console.log(`⚠️ Ошибка при зеркале ${m}: ${e.message}`);
          }
        }
      }
    }

    // Если RSS не сработал — парсим HTML
    const res = await fetch(url, { timeout: 10000 });
    if (!res.ok) {
      console.log(`⚠️ Прямая проверка ${url}: Status ${res.status}`);
      return null;
    }

    const html = await res.text();
    const $ = cheerio.load(html);
    const content = $("body").text().slice(0, 10000);
    return getHash(content);
  } catch (err) {
    console.log(`❌ Ошибка при проверке ${url}: ${err.message}`);
    return null;
  }
}

// === Автопроверка ===
async function checkUpdates() {
  for (const chatId in userSites) {
    for (const site of userSites[chatId]) {
      const newHash = await checkSite(site.url);
      if (newHash && site.lastHash && newHash !== site.lastHash) {
        bot.sendMessage(chatId, `♻️ Обновления на сайте: ${site.url}`);
      }
      if (newHash) site.lastHash = newHash;
    }
  }
}
setInterval(checkUpdates, 120000);

// === Команды ===
bot.onText(/\/start/, msg => {
  const chatId = msg.chat.id;
  userSites[chatId] = [];
  bot.sendMessage(
    chatId,
    "Привет! Я бот для мониторинга сайтов.\n\nКоманды:\n" +
      "/add <url> — добавить сайт\n" +
      "/list — список сайтов\n" +
      "/remove <url> — удалить сайт\n" +
      "/check — проверить сайты вручную"
  );
});

bot.onText(/\/add (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const url = match[1];
  if (!userSites[chatId]) userSites[chatId] = [];
  const hash = await checkSite(url);
  userSites[chatId].push({ url, lastHash: hash });
  bot.sendMessage(chatId, `✅ Сайт добавлен: ${url}`);
});

bot.onText(/\/list/, msg => {
  const chatId = msg.chat.id;
  const sites = userSites[chatId] || [];
  if (sites.length === 0) {
    bot.sendMessage(chatId, "❌ У тебя нет добавленных сайтов.");
  } else {
    const list = sites.map((s, i) => `${i + 1}. ${s.url}`).join("\n");
    bot.sendMessage(chatId, `📄 Твои сайты:\n${list}`);
  }
});

bot.onText(/\/remove (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const url = match[1];
  userSites[chatId] = (userSites[chatId] || []).filter(s => s.url !== url);
  bot.sendMessage(chatId, `🗑️ Удалён сайт: ${url}`);
});

bot.onText(/\/check/, async msg => {
  const chatId = msg.chat.id;
  const sites = userSites[chatId] || [];
  if (sites.length === 0) {
    bot.sendMessage(chatId, "❌ Нет сайтов для проверки.");
    return;
  }

  for (const site of sites) {
    const newHash = await checkSite(site.url);
    if (newHash && site.lastHash && newHash !== site.lastHash) {
      bot.sendMessage(chatId, `♻️ Обновления на сайте: ${site.url}`);
    } else {
      bot.sendMessage(chatId, `✅ Нет изменений: ${site.url}`);
    }
    if (newHash) site.lastHash = newHash;
  }
});

// === Запуск сервера ===
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});

