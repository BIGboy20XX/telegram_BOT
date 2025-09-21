// server.js
const express = require("express");
const fetch = require("node-fetch");
const crypto = require("crypto");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
if (!TELEGRAM_TOKEN) {
  console.error("❌ Ошибка: TELEGRAM_TOKEN не задан в переменных окружения!");
  process.exit(1);
}

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const PORT = process.env.PORT || 3000;

let users = {}; // { chatId: { sites: [], lastHashes: {}, monitoring: true } }

const app = express();
app.use(express.json());

// 📩 обработка webhook
app.post(`/webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
  const update = req.body;
  console.log("📩 Пришло обновление:", JSON.stringify(update, null, 2));

  // обработка нажатий кнопок
  if (update.callback_query) {
    const chatId = String(update.callback_query.message.chat.id);
    const action = update.callback_query.data;

    if (action === "list") {
      const list = users[chatId]?.sites || [];
      if (list.length === 0) {
        await sendTelegramMessage(chatId, "📭 Нет сайтов для мониторинга.");
      } else {
        let msg = "📋 Сайты в мониторинге:\n";
        list.forEach((u, i) => (msg += `${i + 1}. ${u}\n`));
        await sendTelegramMessage(chatId, msg);
      }
    } else if (action === "stop") {
      users[chatId].monitoring = false;
      await sendTelegramMessage(chatId, "⛔ Мониторинг приостановлен.");
    } else if (action === "resume") {
      users[chatId].monitoring = true;
      await sendTelegramMessage(chatId, "▶️ Мониторинг возобновлён.");
    }

    return res.sendStatus(200);
  }

  // обработка текстовых сообщений
  if (update.message && update.message.text) {
    const chatId = String(update.message.chat.id);
    const text = update.message.text.trim();

    if (!users[chatId]) {
      users[chatId] = { sites: [], lastHashes: {}, monitoring: true };
    }

    if (text.startsWith("/monitor ")) {
      const url = text.split(" ")[1];
      if (!url) {
        await sendTelegramMessage(chatId, "Использование: /monitor <url>");
      } else if (!users[chatId].sites.includes(url)) {
        users[chatId].sites.push(url);
        users[chatId].lastHashes[url] = "";
        await sendTelegramMessage(chatId, `✅ Буду следить за: ${url}`);
      } else {
        await sendTelegramMessage(chatId, `ℹ️ Уже слежу за: ${url}`);
      }
    } else if (text === "/start") {
      await sendTelegramMessage(
        chatId,
        "👋 Привет! Я бот для мониторинга сайтов.\n" +
          "Выбери действие из меню:",
        {
          reply_markup: {
            inline_keyboard: [
               [{ text: "➕ Добавить сайт" }, { text: "📋 Список сайтов" }],
          [{ text: "⛔ Остановить мониторинг" }, { text: "▶️ Возобновить мониторинг" }],
          [{ text: "ℹ️ Помощь" }]
            ],
            resize_keyboard: true
          }
        }
      );
    }
  }
  else if (text === "➕ Добавить сайт") {
  await sendTelegramMessage(chatId, "Чтобы добавить сайт, напиши:\n/monitor <url>");
}
else if (text === "📋 Список сайтов") {
  const list = users[chatId].sites;
  if (!list || list.length === 0) {
    await sendTelegramMessage(chatId, "Сайтов для мониторинга нет. Используй /monitor <url>");
  } else {
    let msg = "📋 Сайты в мониторинге:\n";
    list.forEach((u, i) => (msg += `${i + 1}. ${u}\n`));
    await sendTelegramMessage(chatId, msg);
  }
}
else if (text === "⛔ Остановить мониторинг") {
  users[chatId].monitoring = false;
  await sendTelegramMessage(chatId, "⛔ Мониторинг приостановлен.");
}
else if (text === "▶️ Возобновить мониторинг") {
  users[chatId].monitoring = true;
  await sendTelegramMessage(chatId, "▶️ Мониторинг возобновлён.");
}
else if (text === "ℹ️ Помощь") {
  await sendTelegramMessage(
    chatId,
    "📖 Доступные команды:\n\n" +
    "/monitor <url> — начать следить за страницей\n" +
    "/list — список отслеживаемых сайтов\n" +
    "/remove <номер|url> — удалить сайт\n" +
    "/stop — приостановить мониторинг\n" +
    "/resume — возобновить мониторинг\n"
  );
}


  res.sendStatus(200);
});

// 🚀 проверка сайтов каждые 30 секунд
setInterval(async () => {
  for (const chatId in users) {
    const cfg = users[chatId];
    if (!cfg.monitoring) continue;

    for (const url of cfg.sites) {
      try {
        const res = await fetch(url);
        const text = await res.text();
        const hash = crypto.createHash("md5").update(text).digest("hex");

        if (cfg.lastHashes[url] && cfg.lastHashes[url] !== hash) {
          await sendTelegramMessage(chatId, `⚡ Обновление на ${url}`);
        } else if (!cfg.lastHashes[url]) {
          await sendTelegramMessage(chatId, `🔍 Начал мониторинг: ${url}`);
        }

        cfg.lastHashes[url] = hash;
      } catch (err) {
        await sendTelegramMessage(chatId, `❌ Ошибка при проверке ${url}: ${err.message}`);
      }
    }
  }
}, 30_000);

// 📩 универсальная функция отправки сообщений
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

  // Устанавливаем webhook
  const url = `https://${process.env.RENDER_EXTERNAL_HOSTNAME}/webhook/${TELEGRAM_TOKEN}`;
  const res = await fetch(`${TELEGRAM_API}/setWebhook?url=${url}`);
  const data = await res.json();
  console.log("🌍 Webhook ответ:", data);
});
