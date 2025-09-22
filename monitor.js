// monitor.js (CommonJS, node-fetch@2)
const fetch = require("node-fetch");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN; // <-- поставь токен
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

const USERS_FILE = path.join(__dirname, "users.json");
const CHECK_INTERVAL_MS = 30_000; // интервал проверки (30s)
const UPDATES_POLL_MS = 2000; // как часто опрашивать getUpdates

// загрузка/сохранение users
function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
    }
  } catch (e) {
    console.error("Не удалось прочитать users.json:", e.message);
  }
  return {}; // структура: users[chatId] = { sites: [url,...], lastHashes: {url:hash}, monitoring: true }
}

function saveUsers(users) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), "utf8");
  } catch (e) {
    console.error("Не удалось сохранить users.json:", e.message);
  }
}

let users = loadUsers();

// отправка сообщения с обработкой ошибок Telegram
async function sendTelegramMessage(chatId, message) {
  const apiUrl = `${TELEGRAM_API}/sendMessage`;
  try {
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "HTML",
        disable_web_page_preview: true
      })
    });
    const data = await res.json();
    if (!data.ok) {
      console.error("Ошибка Telegram для", chatId, data);
      // если чат удалён/заблокирован — удаляем его из users
      const code = data.error_code;
      const desc = (data.description || "").toLowerCase();
      if (code === 403 || desc.includes("chat was deleted") || desc.includes("bot was blocked") || desc.includes("chat not found")) {
        console.log(`Удаляю чат ${chatId} из списка — Telegram вернул: ${data.description}`);
        if (users[chatId]) {
          delete users[chatId];
          saveUsers(users);
        }
      }
    } else {
      // можно логировать data.result.message_id если нужно
      // console.log("Отправлено:", data);
    }
  } catch (err) {
    console.error("Ошибка отправки в Telegram:", err.message);
  }
}

// проверка всех сайтов для всех пользователей
async function checkUpdates() {
  const chatIds = Object.keys(users);
  if (chatIds.length === 0) {
    // console.log("Нет пользователей для мониторинга.");
    return;
  }

  for (const chatId of chatIds) {
    const cfg = users[chatId];
    if (!cfg || !cfg.monitoring) continue;
    if (!Array.isArray(cfg.sites) || cfg.sites.length === 0) continue;

    for (const url of cfg.sites.slice()) { // slice чтобы безопасно итерировать при модификации
      try {
        const res = await fetch(url, { timeout: 15000 });
        const text = await res.text();
        const hash = crypto.createHash("md5").update(text).digest("hex");

        const prev = cfg.lastHashes && cfg.lastHashes[url] ? cfg.lastHashes[url] : null;
        if (prev && prev !== hash) {
          console.log(`Обновление для ${url} (chat ${chatId})`);
          await sendTelegramMessage(chatId, `⚡ Обновление на <b>${url}</b>`);
        } else if (!prev) {
          await sendTelegramMessage(chatId, `🔍 Начал мониторинг: <b>${url}</b>`);
        }
        // сохраняем новый хэш
        cfg.lastHashes = cfg.lastHashes || {};
        cfg.lastHashes[url] = hash;
        saveUsers(users);
      } catch (err) {
        console.error(`Ошибка при проверке ${url} для ${chatId}:`, err.message);
        // сообщим пользователю, но если чат удалён — sendTelegramMessage сам удалит запись
        await sendTelegramMessage(chatId, `❌ Ошибка при проверке <b>${url}</b>: ${err.message}`);
      }
    }
  }
}

// слушаем команды через getUpdates (простой polling)
async function listenCommands() {
  let offset = 0;
  setInterval(async () => {
    try {
      const res = await fetch(`${TELEGRAM_API}/getUpdates?offset=${offset + 1}&timeout=0`);
      const data = await res.json();
      if (!data.ok) {
        console.error("getUpdates error:", data);
        return;
      }
      if (!Array.isArray(data.result) || data.result.length === 0) return;

      for (const update of data.result) {
        offset = Math.max(offset, update.update_id);
        // обрабатываем обычные сообщения
        if (update.message && update.message.text) {
          const chatId = String(update.message.chat.id);
          const fromUser = update.message.from && update.message.from.username ? update.message.from.username : (update.message.from && update.message.from.first_name ? update.message.from.first_name : "user");
          const text = update.message.text.trim();

          console.log(`Команда от ${fromUser} (chat ${chatId}): ${text}`);

          // инициализация записи чата, если нужно
          if (!users[chatId]) {
            users[chatId] = { sites: [], lastHashes: {}, monitoring: true };
          }

          if (text.startsWith("/monitor ")) {
            const parts = text.split(" ");
            const url = parts[1];
            if (!url) {
              await sendTelegramMessage(chatId, "Использование: /monitor <url>");
              continue;
            }
            // добавляем сайт если его нет
            if (!users[chatId].sites.includes(url)) {
              users[chatId].sites.push(url);
              users[chatId].lastHashes[url] = "";
              saveUsers(users);
              await sendTelegramMessage(chatId, `✅ Буду следить за: <b>${url}</b>`);
            } else {
              await sendTelegramMessage(chatId, `ℹ️ Уже слежу за: <b>${url}</b>`);
            }
          } else if (text === "/list") {
            const list = users[chatId].sites;
            if (!list || list.length === 0) {
              await sendTelegramMessage(chatId, "Сайтов для мониторинга нет. Используй /monitor <url>");
            } else {
              let msg = "Сайты в мониторинге:\n";
              list.forEach((u, i) => (msg += `${i + 1}. ${u}\n`));
              await sendTelegramMessage(chatId, msg);
            }
          } else if (text.startsWith("/remove ")) {
            const param = text.split(" ")[1];
            if (!param) {
              await sendTelegramMessage(chatId, "Использование: /remove <номер_из_list> или /remove <url>");
              continue;
            }
            const list = users[chatId].sites;
            let removed = false;
            // если число — удаляем по индексу
            if (/^\d+$/.test(param)) {
              const idx = parseInt(param, 10) - 1;
              if (list[idx]) {
                const url = list.splice(idx, 1)[0];
                if (users[chatId].lastHashes) delete users[chatId].lastHashes[url];
                removed = true;
              }
            } else {
              const idx = list.indexOf(param);
              if (idx !== -1) {
                list.splice(idx, 1);
                if (users[chatId].lastHashes) delete users[chatId].lastHashes[param];
                removed = true;
              }
            }
            saveUsers(users);
            await sendTelegramMessage(chatId, removed ? "✅ Удалено" : "❌ Не найдено");
          } else if (text === "/stop") {
            users[chatId].monitoring = false;
            saveUsers(users);
            await sendTelegramMessage(chatId, "⛔ Мониторинг приостановлен для этого чата.");
          } else if (text === "/resume") {
            users[chatId].monitoring = true;
            saveUsers(users);
            await sendTelegramMessage(chatId, "▶️ Мониторинг возобновлён для этого чата.");
          } else if (text === "/start") {
            await sendTelegramMessage(chatId,
              "👋 Привет! Команды:\n" +
              "/monitor <url> — начать следить за страницей\n" +
              "/list — показать список отслеживаемых сайтов\n" +
              "/remove <номер|url> — удалить сайт из списка\n" +
              "/stop — приостановить мониторинг\n" +
              "/resume — возобновить мониторинг"
            );
          }
        }
      }
    } catch (err) {
      console.error("Ошибка в listenCommands:", err.message);
    }
  }, UPDATES_POLL_MS);
}

// запуск
console.log("🔍 Мониторинг скрипт запущен...");
listenCommands();
setInterval(checkUpdates, CHECK_INTERVAL_MS);
