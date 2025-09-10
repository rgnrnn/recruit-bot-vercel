// api/telegram.js — минимальный проверочный обработчик.
// Без Redis и логики анкеты: просто доказываем, что апдейты приходят и мы можем отвечать.

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// Надёжно читаем тело (Vercel иногда отдаёт строку или поток)
async function readBody(req) {
  if (req.body) {
    try { return typeof req.body === "string" ? JSON.parse(req.body) : req.body; } catch {}
  }
  let raw = "";
  for await (const chunk of req) raw += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}

async function tg(method, payload) {
  const url = `https://api.telegram.org/bot${TOKEN}/${method}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return r.json();
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(200).send("OK"); return; }

  const upd = await readBody(req);
  try { console.log("MIN-HOOK:", JSON.stringify({ id: upd.update_id, hasMsg: !!upd.message, hasCb: !!upd.callback_query })); } catch {}

  if (upd.callback_query) {
    // просто подтверждаем коллбек, чтобы TG не ретраил
    try { await tg("answerCallbackQuery", { callback_query_id: upd.callback_query.id }); } catch {}
  }

  if (upd.message) {
    const chat = upd.message.chat.id;
    const text = (upd.message.text || "").trim().toLowerCase();

    if (text === "/ping") {
      await tg("sendMessage", { chat_id: chat, text: "pong ✅" });
    } else {
      await tg("sendMessage", { chat_id: chat, text: "hello from vercel ✅" });
    }
  }

  res.status(200).send("OK");
}
