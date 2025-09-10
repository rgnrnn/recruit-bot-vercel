/**
 * api/telegram.js — Vercel webhook для Telegram (Node 20, ESM)
 * Q1 (согласие) → Q2 (имя). Анти-дубли через Upstash Redis.
 *
 * ENV (Vercel → Project → Settings → Environment Variables):
 * TELEGRAM_BOT_TOKEN        — токен бота
 * ADMIN_CHAT_ID             — id админа (опц.)
 * START_SECRET              — deep-link секрет (напр. INVITE)
 * REQUIRE_SECRET            — "1" или "true" чтобы требовать секрет строго (по умолчанию НЕ требуем)
 * UPSTASH_REDIS_REST_URL    — https://*.upstash.io
 * UPSTASH_REDIS_REST_TOKEN  — <token>
 */

const TOKEN        = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID     = process.env.ADMIN_CHAT_ID || "";
const START_SECRET = process.env.START_SECRET || "";
const REQUIRE_SEC  = /^1|true$/i.test(process.env.REQUIRE_SECRET || "");
const REDIS_BASE   = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const REDIS_TOKEN  = process.env.UPSTASH_REDIS_REST_TOKEN || "";

const NO_CHAT = "Я не веду переписку — используй кнопки ниже 🙌";

/* -------------------- Redis (Upstash REST) -------------------- */

function rUrl(path) {
  if (!REDIS_BASE || !REDIS_TOKEN) throw new Error("Redis env missing");
  return new URL(REDIS_BASE + path);
}
async function rGET(path) {
  const res = await fetch(rUrl(path), { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
  return res.json();
}
async function rCall(path, qs = {}) {
  const url = rUrl(path);
  Object.entries(qs).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
  return res.json();
}
const rSet  = (k, v, qs)=> rCall(`/set/${encodeURIComponent(k)}/${encodeURIComponent(v)}`, qs);
const rGet  = (k)=> rGET(`/get/${encodeURIComponent(k)}`);
const rDel  = (k)=> rGET(`/del/${encodeURIComponent(k)}`);
const rIncr = async (k, ex = 60) => {
  const j = await rGET(`/incr/${encodeURIComponent(k)}`);
  if (j.result === 1) await rGET(`/expire/${encodeURIComponent(k)}/${ex}`);
  return j.result;
};

/** Дедуп: true = первый раз; false = явный дубль этого update_id.
 * ВАЖНО: при любых ошибках/неожиданных ответах — возвращаем true (НЕ отбрасываем апдейт). */
async function seenUpdate(update_id) {
  try {
    const j = await rSet(`upd:${update_id}`, "1", { EX: 180, NX: true });
    // Upstash: {result:"OK"} — ключ установлен; {result:null} — уже был (дубль).
    if (j && Object.prototype.hasOwnProperty.call(j, "result")) {
      return j.result === "OK";           // true — первый раз, false — дубль
    }
    return true;                           // странный ответ — лучше обработать, чем отбросить
  } catch (e) {
    console.warn("seenUpdate fallback (redis err):", e?.message || String(e));
    return true;                           // при ошибке Redis — обрабатываем, чтобы не терять апдейты
  }
}
async function overRL(uid, limit = 12) {
  try { return (await rIncr(`rl:${uid}`, 60)) > limit; }
  catch { return false; }
}
async function getSess(uid) {
  try {
    const j = await rGet(`sess:${uid}`);
    if (!j?.result) return { step:"consent", consent:"", name:"" };
    try { return JSON.parse(j.result); } catch { return { step:"consent", consent:"", name:"" }; }
  } catch { return { step:"consent", consent:"", name:"" }; }
}
async function putSess(uid, s) { try { await rSet(`sess:${uid}`, JSON.stringify(s), { EX: 21600 }); } catch {} }
async function delSess(uid)     { try { await rDel(`sess:${uid}`); } catch {} }

/* -------------------- Telegram API -------------------- */

async function tg(method, payload) {
  const url = `https://api.telegram.org/bot${TOKEN}/${method}`;
  let json;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    json = await res.json();
  } catch (e) {
    console.error("tg network error:", method, e?.message || String(e));
    return { ok: false, error: "network" };
  }
  if (!json?.ok) {
    console.error("tg api error:", method, JSON.stringify(json).slice(0, 500));
  }
  return json;
}

/* -------------------- Body parsing -------------------- */

async function readBody(req) {
  // Vercel может отдавать body объектом, строкой или потоком
  if (req.body) {
    try { return typeof req.body === "string" ? JSON.parse(req.body) : req.body; }
    catch { /* fallthrough */ }
  }
  let raw = "";
  for await (const chunk of req) raw += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}

/* -------------------- UI helpers -------------------- */

function consentKeyboard() {
  return JSON.stringify({
    inline_keyboard: [[
      { text:"✅ Согласен на связь", callback_data:"consent_yes" },
      { text:"❌ Не сейчас",        callback_data:"consent_no"  }
    ]]
  });
}
async function sendWelcome(chat, uid) {
  console.log("sendWelcome", { uid, chat });
  await tg("sendMessage", {
    chat_id: chat,
    text: "Привет! Это быстрый отбор «стратегических партнёров» (SQL + Graph + Vector).\nСобираем только рабочие ответы: интересы, стек, стиль, время. Ок?",
    parse_mode: "HTML",
    reply_markup: consentKeyboard(),
  });
}
async function sendNamePrompt(chat, uid, username) {
  console.log("sendNamePrompt", { uid, chat, username });
  const btn = username ? { text:`Использовать @${username}`, callback_data:"name_use_username" } : null;
  const rm  = btn ? JSON.stringify({ inline_keyboard: [[btn]] }) : undefined;
  await tg("sendMessage", {
    chat_id: chat,
    text: "2) Как к тебе обращаться? Введи имя текстом" + (username?` или нажми «Использовать @${username}».`:""),
    parse_mode: "HTML",
    reply_markup: rm,
  });
}

/* -------------------- HTTP entry (Vercel) -------------------- */

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(200).send("OK"); return; }
  const upd = await readBody(req);

  try { console.log("HOOK:", JSON.stringify({ id: upd.update_id, msg: !!upd.message, cb: !!upd.callback_query })); } catch {}

  try {
    // Анти-дубли по update_id (но НЕ отбрасываем при ошибках Redis)
    if (upd.update_id && !(await seenUpdate(upd.update_id))) {
      res.status(200).send("OK"); return;
    }
    if (upd.message)             await onMessage(upd.message);
    else if (upd.callback_query) await onCallback(upd.callback_query);
  } catch (e) {
    console.error("handler error:", e?.stack || e?.message || String(e));
  }
  res.status(200).send("OK");
}

/* -------------------- Handlers -------------------- */

async function onMessage(m) {
  const uid  = m.from.id;
  if (await overRL(uid)) return;

  const chat = m.chat.id;
  const text = (m.text || "").trim();
  try { console.log("onMessage:", { uid, text }); } catch {}

  // Диагностика
  if (text.toLowerCase() === "/ping") { await tg("sendMessage", { chat_id: chat, text: "pong ✅" }); return; }

  if (text.startsWith("/start")) {
    // deep-link: по умолчанию НЕ требуем секрет, чтобы не стопориться
    const payload = text.split(" ").slice(1).join(" ").trim();
    const hasSecret = payload && START_SECRET && payload.includes(START_SECRET);
    if (REQUIRE_SEC && !hasSecret && String(uid) !== String(ADMIN_ID)) {
      await tg("sendMessage", { chat_id: chat, text: `Нужен ключ доступа. Открой ссылку:\nhttps://t.me/rgnr_assistant_bot?start=${encodeURIComponent(START_SECRET || "INVITE")}` });
      return;
    }

    const s = await getSess(uid);
    if (s.step && s.step !== "consent") {
      await tg("sendMessage", { chat_id: chat, text: "Анкета уже начата — продолжаем ⬇️" });
      if (s.step === "name") await sendNamePrompt(chat, uid, m.from.username);
      return;
    }

    await delSess(uid);
    await putSess(uid, { step: "consent", consent: "", name: "" });
    await sendWelcome(chat, uid); // экран с «✅/❌»
    return;
  }

  // Текст принимаем только на шаге "name"
  const s = await getSess(uid);
  if (s.step === "name") {
    s.name = text.slice(0, 80);
    s.step = "hold";
    await putSess(uid, s);
    await tg("sendMessage", { chat_id: chat, text: `✅ Ок, ${s.name}. Следующий шаг добавим далее.` });
    return;
  }

  await tg("sendMessage", { chat_id: chat, text: NO_CHAT });
}

async function onCallback(q) {
  const uid  = q.from.id;
  if (await overRL(uid)) return;

  const chat = q.message.chat.id;
  const mid  = q.message.message_id;
  const data = q.data || "";

  try { await tg("answerCallbackQuery", { callback_query_id: q.id }); } catch {}

  let s = await getSess(uid);

  if (data === "consent_yes") {
    if (s.step !== "consent") return; // идемпотентность шага
    s.consent = "yes";
    s.step    = "name";
    await putSess(uid, s);
    await tg("editMessageText", { chat_id: chat, message_id: mid, text: "✅ Спасибо за согласие на связь.", parse_mode: "HTML" });
    await sendNamePrompt(chat, uid, q.from.username);
    return;
  }

  if (data === "consent_no") {
    if (s.step !== "consent") return;
    await tg("editMessageText", { chat_id: chat, message_id: mid, text: "Ок. Если передумаешь — /start" });
    await delSess(uid);
    return;
  }

  if (data === "name_use_username") {
    if (s.step !== "name") return;
    s.name = q.from.username ? `@${q.from.username}` : String(uid);
    s.step = "hold";
    await putSess(uid, s);
    await tg("sendMessage", { chat_id: chat, text: `✅ Ок, ${s.name}. Следующий шаг добавим далее.` });
    return;
  }

  // всё остальное игнор
}
