import express from "express";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import crypto from "crypto";
import { Pool } from "pg";
import Parser from "rss-parser";

const app = express();
app.use(express.json({ limit: "2mb" })); // поддержка больших апдейтов

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
if (!TELEGRAM_TOKEN) {
  console.error("❌ Ошибка: TELEGRAM_TOKEN не задан!");
  process.exit(1);
}
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

const rssParser = new Parser();

// 🔧 Предустановленные селекторы
const PRESET_SELECTORS = {
  "instagram.com": ".x1lliihq", // посты
  "twitter.com": "article",     // твиты
  "reddit.com": ".Post",        // посты
  "tumblr.com": ".post"         // посты
};

// 🔧 RSS-зеркала
const RSS_MIRRORS = {
  "twitter.com": url => {
    const username = url.split("/").filter(Boolean).pop();
    return `https://nitter.net/${username}/rss`;
  },
  "x.com": url => {
    const username = url.split("/").filter(Boolean).pop();
    return `https://nitter.net/${username}/rss`;
  },
  "instagram.com": url => {
    const username = url.split("/").filter(Boolean).pop();
    return `https://rsshub.app/instagram/user/${username}`;
  },
  "reddit.com": url => {
    return url.endsWith("/") ? `${url}.rss` : `${url}/.rss`;
  }
};

// 📩 Отправка сообщений
async function sendTelegramMessage(chatId, text) {
  try {
    const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML"
      })
    });
    const data = await res.json();
    if (!data.ok) {
      console.error("❌ Ошибка при отправке:", data);
    }
  } catch (err) {
    console.error("❌ Ошибка fetch:", err.message);
  }
}

// 📌 Проверка обновлений
async function checkUpdates() {
  const res = await pool.query("SELECT * FROM sites");
  for (const row of res.rows) {
    const { chat_id, url, selector, last_hash } = row;

    try {
      const domain = new URL(url).hostname.replace("www.", "");

      // 1) Если есть RSS-зеркало → берём его
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
              `🔔 Обновление на <b>${url}</b>\n\n${latestItem.title}\n${latestItem.link}`
            );
          }
        }
      } else {
        // 2) Fallback: HTML + селектор
        const response = await fetch(url);
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
      console.error(`❌ Ошибка проверки ${url}:`, err.message);
    }
  }
}

// 🕒 Запускаем проверку каждые 2 минуты
setInterval(checkUpdates, 120000);

// 📩 Вебхук Telegram
app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  console.log("📩 Update:", JSON.stringify(req.body, null, 2));

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
        if (!selector) {
          selector = PRESET_SELECTORS[domain] || null;
        }

        await pool.query(
          "INSERT INTO sites (chat_id, url, selector, last_hash, last_update) VALUES ($1,$2,$3,'',NOW()) ON CONFLICT DO NOTHING",
          [chatId, url, selector]
        );

        await sendTelegramMessage(
          chatId,
          `✅ Буду следить за: <b>${url}</b>${selector ? ` (селектор: <code>${selector}</code>)` : ""}`
        );
      } catch (e) {
        await sendTelegramMessage(chatId, "❌ Ошибка: некорректный URL");
      }
    }
  }

  res.sendStatus(200);
});

// 🚀 Запуск сервера + установка вебхука
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);

  const webhookUrl = `https://${process.env.RENDER_EXTERNAL_HOSTNAME}/webhook/${TELEGRAM_TOKEN}`;
  console.log("🌍 Устанавливаю вебхук:", webhookUrl);

  try {
    const res = await fetch(`${TELEGRAM_API}/setWebhook?url=${webhookUrl}`);
    const data = await res.json();
    console.log("Ответ Telegram на setWebhook:", data);
  } catch (err) {
    console.error("❌ Ошибка установки вебхука:", err.message);
  }
});
