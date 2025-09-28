import express from "express";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import crypto from "crypto";
import { Pool } from "pg";
import bodyParser from "body-parser";
import Parser from "rss-parser";

const app = express();
app.use(bodyParser.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

const rssParser = new Parser();

// 🔧 Предустановленные селекторы (если RSS недоступен)
const PRESET_SELECTORS = {
  "reddit.com": ".Post",
  "tumblr.com": ".post"
};

// 🔧 RSS-зеркала
const RSS_MIRRORS = {
  "twitter.com": url => {
    const username = url.split("/").filter(Boolean)[3];
    return `https://nitter.net/${username}/rss`;
  },
  "x.com": url => {
    const username = url.split("/").filter(Boolean)[3];
    return `https://nitter.net/${username}/rss`;
  },
  "instagram.com": url => {
    const username = url.split("/").filter(Boolean)[3];
    return `https://rsshub.app/instagram/user/${username}`;
  },
  "reddit.com": url => {
    return url.endsWith("/") ? `${url}.rss` : `${url}/.rss`;
  }
};

// 📨 Отправка сообщений
async function sendTelegramMessage(chatId, text) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML"
    })
  });
}

// 📌 Проверка обновлений
async function checkUpdates() {
  const res = await pool.query("SELECT * FROM sites");
  for (const row of res.rows) {
    const { chat_id, url, selector, last_hash } = row;

    try {
      const domain = new URL(url).hostname.replace("www.", "");

      // 1) Если сайт поддерживает RSS
      if (RSS_MIRRORS[domain]) {
        const rssUrl = RSS_MIRRORS[domain](url);
        const feed = await rssParser.parseURL(rssUrl);

        if (feed.items && feed.items.length > 0) {
          const latestItem = feed.items[0];
          const contentToHash = latestItem.link || latestItem.title;
          const hash = crypto.createHash("md5").update(contentToHash).digest("hex");

          if (hash !== last_hash) {
            await pool.query(
              "UPDATE sites SET last_hash=$1, last_update=NOW() WHERE chat_id=$2 AND url=$3",
              [hash, chat_id, url]
            );

            await sendTelegramMessage(
              chat_id,
              `🔔 Новый пост на <b>${url}</b>\n\n${latestItem.title || ""}\n${latestItem.link || ""}`
            );
          }
        }
      } else {
        // 2) Если RSS нет → парсим HTML
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const html = await response.text();
        const $ = cheerio.load(html);

        let elements;
        if (selector) {
          elements = $(selector);
        } else {
          elements = $(PRESET_SELECTORS[domain] || "body");
        }

        const content = elements.text().trim().slice(0, 500);
        const hash = crypto.createHash("md5").update(content).digest("hex");

        if (hash !== last_hash) {
          await pool.query(
            "UPDATE sites SET last_hash=$1, last_update=NOW() WHERE chat_id=$2 AND url=$3",
            [hash, chat_id, url]
          );

          await sendTelegramMessage(
            chat_id,
            `🔔 Обновление на <b>${url}</b>`
          );
        }
      }
    } catch (err) {
      console.error(`Ошибка проверки ${url}:`, err.message);
    }
  }
}

// 🕒 Запускаем проверку каждые 2 минуты
setInterval(checkUpdates, 120000);

// 📩 Вебхук Telegram
app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  const message = req.body.message;
  if (!message || !message.text) return res.sendStatus(200);

  const chatId = message.chat.id;
  const text = message.text;

  if (text.startsWith("/monitor ")) {
    const args = text.split(" ");
    const url = args[1];
    const selectorArg = args.find(a => a.startsWith("selector="));
    let selector = selectorArg ? selectorArg.replace("selector=", "") : null;

    if (!url) {
      await sendTelegramMessage(chatId, "Использование: /monitor <url> [selector=...]");
    } else {
      try {
        const domain = new URL(url).hostname.replace("www.", "");

        // если у домена есть RSS → селектор не нужен
        if (!selector && !RSS_MIRRORS[domain]) {
          selector = PRESET_SELECTORS[domain] || null;
        }

        await pool.query(
          "INSERT INTO sites (chat_id, url, selector, last_hash, last_update) VALUES ($1,$2,$3,'',NOW()) ON CONFLICT DO NOTHING",
          [chatId, url, selector]
        );

        await sendTelegramMessage(
          chatId,
          `✅ Буду следить за: <b>${url}</b>${
            selector ? ` (селектор: <code>${selector}</code>)` : " (RSS)"
          }`
        );
      } catch (e) {
        await sendTelegramMessage(chatId, "❌ Ошибка: некорректный URL");
      }
    }
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Сервер запущен на порту ${PORT}`));
