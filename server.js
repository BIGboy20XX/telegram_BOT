import express from "express";
import fetch from "node-fetch";
import * as cheerio from "cheerio"; // ✅ правильный импорт cheerio
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

// Предустановленные селекторы
const PRESET_SELECTORS = {
  "reddit.com": ".Post",
  "tumblr.com": ".post"
};

// 🔗 Зеркала для проблемных сайтов
const RSS_MIRRORS = {
  "twitter.com": url => {
    const username = url.split("/").filter(Boolean).pop();
    return [
      `https://nitter.net/${username}/rss`,
      `https://nitter.lacontrevoie.fr/${username}/rss`,
      `https://nitter.poast.org/${username}/rss`,
      `https://nitter.fdn.fr/${username}/rss`
    ];
  },
  "x.com": url => {
    const username = url.split("/").filter(Boolean).pop();
    return [
      `https://nitter.net/${username}/rss`,
      `https://nitter.lacontrevoie.fr/${username}/rss`,
      `https://nitter.poast.org/${username}/rss`,
      `https://nitter.fdn.fr/${username}/rss`
    ];
  },
  "instagram.com": url => {
    const username = url.split("/").filter(Boolean).pop();
    return [
      `https://rsshub.app/instagram/user/${username}`,
      `https://ig-rss.com/rss/${username}`,
      `https://insta-rss.vercel.app/${username}`
    ];
  },
  "reddit.com": url => {
    return [url.endsWith("/") ? `${url}.rss` : `${url}/.rss`];
  },
 "tumblr.com": url => {
  try {
    const u = new URL(url);
    let blogName = null;

    if (u.hostname.endsWith(".tumblr.com")) {
      blogName = u.hostname.split(".")[0];
    } else if (u.hostname === "www.tumblr.com") {
      // Примеры:
      // https://www.tumblr.com/blog/unseenwarriorsellsword
      // https://www.tumblr.com/unseenwarriorsellsword
      const parts = u.pathname.split("/").filter(Boolean);
      blogName = parts.includes("blog") ? parts[parts.indexOf("blog") + 1] : parts[0];
    }


      if (!blogName || blogName === "www" || blogName === "undefined") {
      console.error("⚠️ Не удалось определить Tumblr-блог для URL:", url);
      return [];
    }

      return [
      `https://${blogName}.tumblr.com/rss`,
      `https://rsshub.app/tumblr/blog/${blogName}`
    ];
  } catch (err) {
    console.error("⚠️ Ошибка Tumblr-парсера:", err.message);
    return [];
  }
},
};


// 📩 Отправка сообщений
async function sendTelegramMessage(chatId, text, keyboard = null) {
  try {
    const body = {
      chat_id: chatId,
      text,
      parse_mode: "HTML"
    };
    if (keyboard) {
      body.reply_markup = keyboard;
    }
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


// 📌 Рандомный User-Agent
function getRandomUserAgent() {
  const agents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/125.0",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile Safari/604.1",
    "Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile Safari/604.1"
  ];
  return agents[Math.floor(Math.random() * agents.length)];
}

// 📌 Задержка
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 📌 Проверка обновлений (через RSS или fallback)
async function checkUpdates() {
  const res = await pool.query("SELECT * FROM sites WHERE chat_id != 0");
  for (const row of res.rows) {
    const { chat_id, url, selector, last_hash } = row;

    try {
      const domain = new URL(url).hostname.replace("www.", "");
      let feed = null;
let mirrors = [];
if (domain.includes("tumblr.com")) {
  mirrors = RSS_MIRRORS["tumblr.com"](url);
} else if (RSS_MIRRORS[domain]) {
  mirrors = RSS_MIRRORS[domain](url);
}

      // 📰 Пробуем RSS зеркала
      if (RSS_MIRRORS[domain]) {
        const mirrors = RSS_MIRRORS[domain](url);
        for (const mirror of mirrors) {
          try {
            feed = await rssParser.parseURL(mirror);
            console.log(`✅ RSS зеркало сработало: ${mirror}`);
            break;
          } catch (err) {
            console.error(`⚠️ Зеркало ${mirror} не сработало: ${err.message}`);
            // если 429 или 503 → пробуем следующее зеркало
            if (err.message.includes("429") || err.message.includes("503")) {
              continue;
            }
          }
        }
      }

      // 📰 Если удалось получить RSS
      if (feed && feed.items && feed.items.length > 0) {
        const latestItem = feed.items[0];
        const contentToHash = (latestItem.link || "") + (latestItem.title || "");
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
        await sleep(1000 + Math.random() * 1500);
        continue;
      }

      // 🌐 Fallback: HTML-парсинг
      const response = await fetch(url, {
        headers: {
          "User-Agent": getRandomUserAgent(),
          "Accept-Language": "en-US,en;q=0.9"
        }
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const html = await response.text();
      const $ = cheerio.load(html);

      let elements = selector ? $(selector) : $(PRESET_SELECTORS[domain] || "body");

      const content = (
        elements.text().trim() +
        elements.find("a").map((i, el) => $(el).attr("href")).get().join(" ")
      ).slice(0, 5000);

      console.log(`👀 Проверка ${url}`);
      console.log("➡️ Используем селектор:", selector || PRESET_SELECTORS[domain] || "body");
      console.log("📄 Извлечённый контент:", content.slice(0, 300) + "...");

      const hash = crypto.createHash("md5").update(content).digest("hex");

      if (hash !== last_hash) {
        await pool.query(
          "UPDATE sites SET last_hash=$1, last_update=NOW() WHERE chat_id=$2 AND url=$3",
          [hash, chat_id, url]
        );
        await sendTelegramMessage(chat_id, `🔔 Обновление на <b>${url}</b>`);
      }
    } catch (err) {
      console.error(`❌ Ошибка проверки ${url}:`, err.message);
      await sendTelegramMessage(chat_id, `❌ Ошибка при проверке <b>${url}</b>: ${err.message}`);
    }

    await sleep(1000 + Math.random() * 2000);
  }
}


// 📌 Ручная проверка (теперь как checkUpdates)
async function manualCheckUpdates(chatId) {
  const res = await pool.query("SELECT * FROM sites WHERE chat_id=$1", [chatId]);
  for (const row of res.rows) {
    const { url, selector, last_hash } = row;

    try {
      const domain = new URL(url).hostname.replace("www.", "");
      let feed = null;

      if (RSS_MIRRORS[domain]) {
        const mirrors = RSS_MIRRORS[domain](url);
        for (const mirror of mirrors) {
          try {
            feed = await rssParser.parseURL(mirror);
            console.log(`✅ Ручная проверка: зеркало сработало ${mirror}`);
            break;
          } catch (err) {
            console.error(`⚠️ Ручная проверка: зеркало ${mirror} не сработало: ${err.message}`);
            if (err.message.includes("429") || err.message.includes("503")) {
              continue;
            }
          }
        }
      }

      if (feed && feed.items && feed.items.length > 0) {
        await sendTelegramMessage(
          chatId,
          `🔔 Последний пост с <b>${url}</b>:\n${feed.items[0].title}\n<code>${feed.items[0].link}</code>`
        );
        await sleep(1000 + Math.random() * 1500);
        continue;
      }

      // 🌐 Fallback
      const response = await fetch(url, {
        headers: {
          "User-Agent": getRandomUserAgent(),
          "Accept-Language": "en-US,en;q=0.9"
        }
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const html = await response.text();
      const $ = cheerio.load(html);

      let elements = selector ? $(selector) : $(PRESET_SELECTORS[domain] || "body");

      const content = (
        elements.text().trim() +
        elements.find("a").map((i, el) => $(el).attr("href")).get().join(" ")
      ).slice(0, 5000);

      const hash = crypto.createHash("md5").update(content).digest("hex");

      if (hash !== last_hash) {
        await pool.query(
          "UPDATE sites SET last_hash=$1, last_update=NOW() WHERE chat_id=$2 AND url=$3",
          [hash, chatId, url]
        );
        await sendTelegramMessage(chatId, `🔔 Обновление на <b>${url}</b>`);
      } else {
        await sendTelegramMessage(chatId, `ℹ️ Новых обновлений на <b>${url}</b> нет.`);
      }
    } catch (err) {
      await sendTelegramMessage(chatId, `❌ Ошибка при проверке <b>${url}</b>: ${err.message}`);
    }

    await sleep(1000 + Math.random() * 2000);
  }
}



// 🕒 Автопроверка каждые 15 минут
setInterval(checkUpdates, 900000);

// 📩 Вебхук Telegram
const waitingForURL = {};

app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  if (req.body.message && req.body.message.text) {
    const message = req.body.message;
    const chatId = message.chat.id;
    const text = message.text.trim();

    const mainKeyboard = {
      keyboard: [
        ["➕ Добавить сайт", "📋 Мои сайты"],
        ["❌ Удалить сайт", "🔄 Проверить обновления"],
        ["ℹ️ Помощь"]
      ],
      resize_keyboard: true
    };

    if (waitingForURL[chatId]) {
      try {
        const url = text;
        let selector = PRESET_SELECTORS[new URL(url).hostname.replace("www.", "")] || null;
        await pool.query(
          "INSERT INTO sites (chat_id, url, selector, last_hash, last_update) VALUES ($1,$2,$3,'',NOW()) ON CONFLICT DO NOTHING",
          [chatId, url, selector]
        );
        await sendTelegramMessage(chatId, `✅ Буду следить за: <b>${url}</b>`, mainKeyboard);
      } catch {
        await sendTelegramMessage(chatId, "❌ Ошибка: некорректный URL", mainKeyboard);
      }
      delete waitingForURL[chatId];
      return res.sendStatus(200);
    }

    if (text === "/start") {
      await sendTelegramMessage(chatId, "👋 Привет! Я бот для мониторинга обновлений.\nВыбери действие:", mainKeyboard);
    } else if (text === "📋 Мои сайты") {
      const result = await pool.query("SELECT url FROM sites WHERE chat_id=$1", [chatId]);
      if (result.rows.length === 0) {
        await sendTelegramMessage(chatId, "📭 У вас пока нет сайтов.", mainKeyboard);
      } else {
        const list = result.rows.map((r, i) => `${i + 1}. <code>${r.url}</code>`).join("\n");
        await sendTelegramMessage(chatId, `📋 Ваши сайты:\n${list}\n\nДля удаления введите номер сайта после выбора «❌ Удалить сайт».`, mainKeyboard);
      }
    } else if (text === "❌ Удалить сайт") {
      await sendTelegramMessage(chatId, "Введите номер сайта, который хотите удалить.", mainKeyboard);
    } else if (/^\d+$/.test(text)) {
      const index = parseInt(text);
      const result = await pool.query("SELECT url FROM sites WHERE chat_id=$1", [chatId]);
      if (index > 0 && index <= result.rows.length) {
        const urlToDelete = result.rows[index - 1].url;
        await pool.query("DELETE FROM sites WHERE chat_id=$1 AND url=$2", [chatId, urlToDelete]);
        await sendTelegramMessage(chatId, `❌ Сайт <code>${urlToDelete}</code> удалён.`, mainKeyboard);
      } else {
        await sendTelegramMessage(chatId, "❌ Неверный номер сайта.", mainKeyboard);
      }
    } else if (text === "🔄 Проверить обновления") {
      await sendTelegramMessage(chatId, "⏳ Проверяю сайты...", mainKeyboard);
      await manualCheckUpdates(chatId);
      await sendTelegramMessage(chatId, "✅ Проверка завершена!", mainKeyboard);
    } else if (text === "ℹ️ Помощь") {
      await sendTelegramMessage(chatId,
        "ℹ️ Справка по командам:\n\n" +
        "• <b>/start</b> — открыть меню\n" +
        "• <b>➕ Добавить сайт</b> — добавить сайт для мониторинга\n" +
        "• <b>📋 Мои сайты</b> — список ваших сайтов\n" +
        "• <b>❌ Удалить сайт</b> — удалить сайт по номеру\n" +
        "• <b>🔄 Проверить обновления</b> — ручная проверка сайтов\n" +
        "• <b>ℹ️ Помощь</b> — показать это сообщение", mainKeyboard);
    } else if (text === "➕ Добавить сайт") {
      waitingForURL[chatId] = true;
      await sendTelegramMessage(chatId, "Введите URL сайта для мониторинга:", mainKeyboard);
    }
  }
  res.sendStatus(200);
});

// 🚀 Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);

  try {
    await pool.query(
      "INSERT INTO sites (chat_id, url, selector, last_hash, last_update) VALUES ($1,$2,$3,'',NOW()) ON CONFLICT DO NOTHING",
      [0, "https://example.com", "body"]
    );
    console.log("🔧 Тестовый сайт https://example.com добавлен в базу (chat_id=0).");
  } catch (err) {
    console.error("❌ Ошибка при добавлении тестового сайта:", err.message);
  }

  console.log("⏳ Выполняю тестовую проверку...");
  await checkUpdates();
  console.log("✅ Тестовая проверка завершена!");
});
