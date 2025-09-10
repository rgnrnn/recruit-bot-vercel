/**
 * api/telegram.js — Vercel webhook для Telegram (Node 20, ESM)
 * Q1 (согласие) → Q2 (имя) → Q3 (интересы, мультивыбор) → Q4 (стек, мультивыбор).
 * Анти-дубли по update_id через Upstash Redis. Надёжный парсинг тела, логи, rate-limit.
 *
 * ENV (Vercel → Project → Settings → Environment Variables):
 * TELEGRAM_BOT_TOKEN        — токен бота
 * ADMIN_CHAT_ID             — id админа (опц.)
 * START_SECRET              — deep-link секрет (напр. INVITE)
 * REQUIRE_SECRET            — "1"/"true" чтобы требовать секрет строго (по умолчанию НЕ требуем)
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

/* ---------- Справочники для Q3/Q4 ---------- */
const A_INTERESTS = [
  "Backend","Graph/Neo4j","Vector/LLM","Frontend",
  "DevOps/MLOps","Data/ETL","Product/Coordination"
];
const A_STACK = [
  "Python/FastAPI","PostgreSQL/SQL","Neo4j","pgvector",
  "LangChain/LangGraph","React/TS","Docker/K8s/Linux","CI/GitHub"
];

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

/** Дедуп: true = первый раз; false = явный дубль (NX не сработал).
 * При любой ошибке Redis — возвращаем true (не теряем апдейты). */
async function seenUpdate(update_id) {
  try {
    const j = await rSet(`upd:${update_id}`, "1", { EX: 180, NX: true });
    if (j && Object.prototype.hasOwnProperty.call(j, "result")) {
      return j.result === "OK";
    }
    return true;
  } catch (e) {
    console.warn("seenUpdate fallback (redis err):", e?.message || String(e));
    return true;
  }
}
async function overRL(uid, limit = 12) {
  try { return (await rIncr(`rl:${uid}`, 60)) > limit; }
  catch { return false; }
}
async function getSess(uid) {
  try {
    const j = await rGet(`sess:${uid}`);
    const base = { step:"consent", consent:"", name:"", interests:[], stack:[] };
    if (!j?.result) return base;
    try {
      const s = JSON.parse(j.result);
      if (!Array.isArray(s.interests)) s.interests = [];
      if (!Array.isArray(s.stack)) s.stack = [];
      return Object.assign(base, s);
    } catch { return base; }
  } catch { return { step:"consent", consent:"", name:"", interests:[], stack:[] }; }
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
  if (!json?.ok) console.error("tg api error:", method, JSON.stringify(json).slice(0, 500));
  return json;
}

/* -------------------- Body parsing -------------------- */

async function readBody(req) {
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
function multiKb(prefix, options, selected) {
  const rows = options.map(o => ([
    { text: `${selected.includes(o) ? "☑️" : "⬜️"} ${o}`, callback_data: `${prefix}:${o}` }
  ]));
  rows.push([{ text: "Дальше ➜", callback_data: `${prefix}:next` }]);
  return JSON.stringify({ inline_keyboard: rows });
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
async function sendInterestsPrompt(chat, uid, s) {
  console.log("sendInterests", { uid });
  await tg("sendMessage", {
    chat_id: chat,
    text: "3) Что интереснее 3–6 мес.? (мультивыбор, повторное нажатие снимает)",
    parse_mode: "HTML",
    reply_markup: multiKb("q3", A_INTERESTS, s.interests || []),
  });
}
async fun
