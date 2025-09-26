// server.js
const express = require("express");
const fetch = require("node-fetch");
const crypto = require("crypto");
const { Pool } = require("pg");
const cheerio = require("cheerio"); // 👈 для работы с селекторами

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
if (!TELEGRAM_TOKEN) {
  console.error("❌ Ошибка: TELEGRAM_TOKEN не задан в переменных окружения!");
  process.exit(1);
}

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const app = express();
app.use(express.json());

// 📩 обработка сообщений от Telegram
app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  const update = req.body;
  console.log("📩 Пришло обновление:", JSON.stringify(update, null, 2));

  if (update.message && update.message.text) {
    const chatId = String(update.message.chat.id);
    const text = update.message.text.trim();

    // 🟢 кнопки
    if (text === "/start") {
      await pool.query(
        "INSERT INTO users (chat_id, monitoring) VALUES ($1,true) ON CONFLICT (chat_id) DO NOTHING",
        [chatId]
      );

      await sendTelegramMessage(
        chatId,
        "👋 Привет! Я бот для мониторинга сайтов.\n\nВыбери действие:",
        {
          reply_markup: {
            keyboard: [
              [{ text: "➕ Добавить сайт" }, { text: "📋 Список сайтов" }],
              [{ text: "🔍 Проверить обновления" }],
              
             [{ text: "ℹ️ Помощь" }]
            ],
            resize_keyboard: true
          }
        }
      );
    }
    else if (text === "➕ Добавить сайт") {
      await sendTelegramMessage(chatId, "Чтобы добавить сайт, напиши:\n/monitor <url> [selector=<css-селектор>]");
    }
    else if (text === "📋 Список сайтов") {
      const result = await pool.query("SELECT * FROM sites WHERE chat_id=$1", [chatId]);
      if (result.rows.length === 0) {
        await sendTelegramMessage(chatId, "Сайтов для мониторинга нет. Используй /monitor <url>");
      } else {
        let msg = "📋 Сайты в мониторинге:\n";
        for (const [i, row] of result.rows.entries()) {
          const time = row.last_update
            ? new Date(row.last_update).toLocaleString("ru-RU", { timeZone: "Asia/Almaty" })
            : "—";
          msg += `${i + 1}. ${row.url} ${row.selector ? `(селектор: ${row.selector})` : ""} (посл. изм: ${time})\n`;
        }
        await sendTelegramMessage(chatId, msg);
      }
    }
    else if (text === "🔍 Проверить обновления") {
      await checkUpdates(chatId);
    }
    else if (text === "⛔ Остановить мониторинг") {
      await pool.query("UPDATE users SET monitoring=false WHERE chat_id=$1", [chatId]);
      await sendTelegramMessage(chatId, "⛔ Мониторинг приостановлен.");
    }
    else if (text === "▶️ Возобновить мониторинг") {
      await pool.query("UPDATE users SET monitoring=true WHERE chat_id=$1", [chatId]);
      await sendTelegramMessage(chatId, "▶️ Мониторинг возобновлён.");
    }
    else if (text === "ℹ️ Помощь") {
      await sendTelegramMessage(
        chatId,
        "📖 Доступные команды:\n\n" +
        "/monitor <url> — начать следить за страницей\n" +
        "/monitor <url> selector=<css> — следить за конкретным блоком\n" +
        "/list — список отслеживаемых сайтов\n" +
        "/remove <номер|url> — удалить сайт\n" +
        "🔍 Проверить обновления — вручную проверить изменения"
      );
    }
    else if (text.startsWith("/monitor ")) {
      const parts = text.split(" ");
      const url = parts[1];
      let selector = null;

      const selectorArg = parts.find(p => p.startsWith("selector="));
      if (selectorArg) {
        selector = selectorArg.replace("selector=", "").trim();
      }

      if (!url) {
        await sendTelegramMessage(chatId, "Использование: /monitor <url> [selector=<css-селектор>]");
      } else {
        await pool.query(
          "INSERT INTO sites (chat_id, url, selector, last_hash, last_update) VALUES ($1,$2,$3,'',NOW()) ON CONFLICT DO NOTHING",
          [chatId, url, selector]
        );
        await sendTelegramMessage(chatId, `✅ Буду следить за: <b>${url}</b>${selector ? ` (селектор: ${selector})` : ""}`);
      }
    }
    else if (text.startsWith("/remove ")) {
      const param = text.split(" ")[1];
      const result = await pool.query("SELECT * FROM sites WHERE chat_id=$1", [chatId]);
      let removed = false;

      if (/^\d+$/.test(param)) {
        const idx = parseInt(param, 10) - 1;
        if (result.rows[idx]) {
          await pool.query("DELETE FROM sites WHERE id=$1", [result.rows[idx].id]);
          removed = true;
        }
      } else {
        const row = result.rows.find(r => r.url === param);
        if (row) {
          await pool.query("DELETE FROM sites WHERE id=$1", [row.id]);
          removed = true;
        }
      }
      await sendTelegramMessage(chatId, removed ? "✅ Удалено" : "❌ Не найдено");
    }
  }

  res.sendStatus(200);
});

// 🔍 функция ручной проверки
async function checkUpdates(chatId) {
  const sites = await pool.query("SELECT * FROM sites WHERE chat_id=$1", [chatId]);
  if (sites.rows.length === 0) {
    await sendTelegramMessage(chatId, "Нет сайтов для проверки. Добавь через /monitor <url>");
    return;
  }

  for (const site of sites.rows) {
    try {
      const res = await fetch(site.url);
      const html = await res.text();
      let content;

      if (site.selector) {
        const $ = cheerio.load(html);
        content = $(site.selector).text();
      } else {
        const $ = cheerio.load(html);
        content = $("body").text(); // 👈 только текст без тегов
      }

      const hash = crypto.createHash("md5").update(content).digest("hex");

      if (site.last_hash && site.last_hash !== hash) {
        const now = new Date();
        const formatted = now.toLocaleString("ru-RU", { timeZone: "Asia/Almaty" });
        await sendTelegramMessage(
          chatId,
          `⚡ Обновление на <b>${site.url}</b>\n🕒 Время: ${formatted}`
        );
        await pool.query(
          "UPDATE sites SET last_hash=$1, last_update=NOW() WHERE id=$2",
          [hash, site.id]
        );
      } else if (!site.last_hash) {
        const now = new Date();
        await sendTelegramMessage(chatId, `🔍 Начал мониторинг: <b>${site.url}</b>`);
        await pool.query(
          "UPDATE sites SET last_hash=$1, last_update=$2 WHERE id=$3",
          [hash, now, site.id]
        );
      } else {
        await sendTelegramMessage(chatId, `✅ На <b>${site.url}</b> изменений нет.`);
      }
    } catch (err) {
      await sendTelegramMessage(chatId, `❌ Ошибка при проверке <b>${site.url}</b>: ${err.message}`);
    }
  }
}

// 📩 отправка сообщений
async function sendTelegramMessage(chatId, text, extra = {}) {
  try {
    const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...extra
      })
    });

    const data = await res.json();
    console.log("Ответ Telegram:", data);
  } catch (err) {
    console.error("Ошибка отправки сообщения:", err);
  }
}

// 🚀 запуск сервера
app.listen(PORT, async () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);

  const url = `https://${process.env.RENDER_EXTERNAL_HOSTNAME}/webhook/${TELEGRAM_TOKEN}`;
  const res = await fetch(`${TELEGRAM_API}/setWebhook?url=${url}`);
  const data = await res.json();
  console.log("🌍 Webhook ответ:", data);
});
