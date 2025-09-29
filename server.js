import express from "express";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import crypto from "crypto";
import { Pool } from "pg";
import Parser from "rss-parser";

const app = express();
app.use(express.json({ limit: "2mb" }));

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
  "instagram.com": ".x1lliihq",
  "twitter.com": "article",
  "reddit.com": ".Post",
  "tumblr.com": ".post"
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

// 🔧 Постоянная клавиатура
const MAIN_KEYBOARD = {
  keyboard: [
    [{ text: "➕ Добавить сайт" }, { text: "📋 Мои сайты" }],
    [{ text: "❌ Удалить сайт" }, { text: "🔄 Проверить обновления" }],
    [{ text: "ℹ️ Помощь" }]
  ],
  resize_keyboard: true
};

// 🔧 Безопасный fetch
async function safeFetch(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000); // 15 сек
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Status ${res.status}`);
    return await res.text();
  } catch (err) {
    throw new Error(`Fetch error: ${err.message}`);
  }
}

// 📩 Отправка сообщений
async function sendTelegramMessage(chatId, text, keyboard = null) {
  try {
    const body = {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: keyboard || MAIN_KEYBOARD
    };

    const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
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
              `🔔 Обновление на <b>${url}</b>\n\n${latestItem.title}\n<code>${latestItem.link}</code>`
            );
          }
        }
      } else {
        const html = await safeFetch(url);
        const $ = cheerio.load(html);

        let elements = selector ? $(selector) : $(PRESET_SELECTORS[domain] || "body");
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

// 🕒 Автопроверка каждые 5 минуты
setInterval(checkUpdates, 150000);

// 📌 Ручная проверка
async function manualCheckUpdates(chatId) {
  const res = await pool.query("SELECT * FROM sites WHERE chat_id=$1", [chatId]);
  for (const row of res.rows) {
    try {
      const domain = new URL(row.url).hostname.replace("www.", "");
      let updated = false;

      if (RSS_MIRRORS[domain]) {
        const rssUrl = RSS_MIRRORS[domain](row.url);
        const feed = await rssParser.parseURL(rssUrl);
        if (feed.items && feed.items.length > 0) {
          await sendTelegramMessage(chatId, `🔔 Последний пост с <b>${row.url}</b>:\n${feed.items[0].title}\n<code>${feed.items[0].link}</code>`);
          updated = true;
        }
      }

      if (!updated) {
        await sendTelegramMessage(chatId, `ℹ️ Данных по <b>${row.url}</b> не найдено.`);
      }
    } catch (err) {
      await sendTelegramMessage(chatId, `❌ Ошибка при проверке <b>${row.url}</b>: ${err.message}`);
    }
  }
}

// 📩 Вебхук Telegram
app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  console.log("📩 Update:", JSON.stringify(req.body, null, 2));

  if (req.body.message && req.body.message.text) {
    const message = req.body.message;
    const chatId = message.chat.id;
    const text = message.text.trim();

    if (text === "/start") {
      await sendTelegramMessage(chatId, "👋 Привет! Я бот для мониторинга обновлений.\nКнопки снизу помогут управлять мной!");
    }

    else if (text === "🔄 Проверить обновления") {
      await sendTelegramMessage(chatId, "⏳ Проверяю сайты...");
      await manualCheckUpdates(chatId);
      await sendTelegramMessage(chatId, "✅ Проверка завершена!");
    }

    else if (text === "➕ Добавить сайт") {
      await sendTelegramMessage(chatId, "Введите команду:\n<code>/monitor &lt;url&gt; [selector=...]</code>");
    }

    else if (text === "📋 Мои сайты") {
      const result = await pool.query("SELECT url FROM sites WHERE chat_id=$1", [chatId]);
      if (result.rows.length === 0) {
        await sendTelegramMessage(chatId, "📭 У вас пока нет сайтов.");
      } else {
        const list = result.rows.map(r => `• <code>${r.url}</code>`).join("\n");
        await sendTelegramMessage(chatId, `📋 Ваши сайты:\n${list}`);
      }
    }

    else if (text === "❌ Удалить сайт") {
      await sendTelegramMessage(chatId, "Удаление пока доступно только через команду:\n<code>/delete &lt;url&gt;</code>");
    }

    else if (text === "ℹ️ Помощь") {
      await sendTelegramMessage(chatId,
        "ℹ️ Справка по командам:\n\n" +
        "• <b>/start</b> — открыть меню\n" +
        "• <b>/monitor &lt;url&gt; [selector=...]</b> — добавить сайт для мониторинга\n" +
        "• 🔄 Проверить обновления — ручная проверка сайтов\n" +
        "• 📋 Мои сайты — список ваших сайтов\n" +
        "• ❌ Удалить сайт — удалить сайт из списка (или через <b>/delete &lt;url&gt;</b>)\n" +
        "• ℹ️ Помощь — показать это сообщение"
      );
    }

    else if (text.startsWith("/monitor ")) {
      const args = text.split(" ");
      const url = args[1];
      const selectorArg = args.find(a => a.startsWith("selector="));
      let selector = selectorArg ? selectorArg.replace("selector=", "") : null;

      if (!url) {
        await sendTelegramMessage(chatId, "Использование:\n<code>/monitor &lt;url&gt; [selector=...]</code>");
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
  }

  res.sendStatus(200);
});

// 🚀 Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
});
