// api/telegram.js — Telegram webhook (Vercel, Node 20, ESM)
// FSM: Q1 consent -> Q2 name -> Q3 interests (multi) -> Q4 stack (multi)

const TOKEN        = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID     = process.env.ADMIN_CHAT_ID || "";
const START_SECRET = process.env.START_SECRET || "";
const REQUIRE_SEC  = /^1|true$/i.test(process.env.REQUIRE_SECRET || "");
const REDIS_BASE   = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const REDIS_TOKEN  = process.env.UPSTASH_REDIS_REST_TOKEN || "";

const NO_CHAT = "Я не веду переписку — используй кнопки ниже 🙌";

const A_INTERESTS = [
  "Backend","Graph/Neo4j","Vector/LLM","Frontend",
  "DevOps/MLOps","Data/ETL","Product/Coordination"
];
const A_STACK = [
  "Python/FastAPI","PostgreSQL/SQL","Neo4j","pgvector",
  "LangChain/LangGraph","React/TS","Docker/K8s/Linux","CI/GitHub"
];

/* ---------------- Redis (Upstash REST) ---------------- */

function rUrl(path) {
  if (!REDIS_BASE || !REDIS_TOKEN) throw new Error("Redis env missing");
  return new URL(REDIS_BASE + path);
}
async function rGET(path) {
  const res = await fetch(rUrl(path), { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
  return res.json();
}
async function rCall(path, qs) {
  const url = rUrl(path);
  if (qs) for (const [k, v] of Object.entries(qs)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
  return res.json();
}
const rSet  = (k, v, qs)=> rCall(`/set/${encodeURIComponent(k)}/${encodeURIComponent(v)}`, qs);
const rGet  = (k)=> rGET(`/get/${encodeURIComponent(k)}`);
const rDel  = (k)=> rGET(`/del/${encodeURIComponent(k)}`);
const rIncr = async (k, ex)=> {
  const j = await rGET(`/incr/${encodeURIComponent(k)}`);
  if (j.result === 1) await rGET(`/expire/${encodeURIComponent(k)}/${ex || 60}`);
  return j.result;
};

// true = первый раз; false = явный дубль; при ошибке — true (не теряем апдейты)
async function seenUpdate(update_id) {
  try {
    const j = await rSet(`upd:${update_id}`, "1", { EX: 180, NX: true });
    return j && Object.prototype.hasOwnProperty.call(j, "result") ? j.result === "OK" : true;
  } catch {
    return true;
  }
}
async function overRL(uid, limit) {
  try { return (await rIncr(`rl:${uid}`, 60)) > (limit || 12); }
  catch { return false; }
}
async function getSess(uid) {
  try {
    const j = await rGet(`sess:${uid}`);
    const base = { step:"consent", consent:"", name:"", interests:[], stack:[] };
    if (!j?.result) return base;
    let s; try { s = JSON.parse(j.result); } catch { return base; }
    if (!Array.isArray(s.interests)) s.interests = [];
    if (!Array.isArray(s.stack)) s.stack = [];
    return Object.assign(base, s);
  } catch { return { step:"consent", consent:"", name:"", interests:[], stack:[] }; }
}
async function putSess(uid, s) { try { await rSet(`sess:${uid}`, JSON.stringify(s), { EX:21600 }); } catch {} }
async function delSess(uid)     { try { await rDel(`sess:${uid}`); } catch {} }

/* ---------------- Telegram API ---------------- */

async function tg(method, payload) {
  const url = `https://api.telegram.org/bot${TOKEN}/${method}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const json = await res.json();
    if (!json?.ok) console.error("tg api error:", method, JSON.stringify(json).slice(0, 500));
    return json;
  } catch (e) {
    console.error("tg network error:", method, e?.message || String(e));
    return { ok:false, error:"network" };
  }
}

/* ---------------- Body parsing ---------------- */

async function readBody(req) {
  if (req.body) {
    try { return typeof req.body === "string" ? JSON.parse(req.body) : req.body; }
    catch {}
  }
  let raw = "";
  for await (const chunk of req) raw += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}

/* ---------------- UI helpers ---------------- */

function consentKeyboard() {
  return JSON.stringify({
    inline_keyboard: [[
      { text:"✅ Согласен на связь", callback_data:"consent_yes" },
      { text:"❌ Не сейчас",        callback_data:"consent_no"  }
    ]]
  });
}
function multiKb(prefix, options, selected) {
  const rows = options.map(o => ([{ text:`${selected.includes(o) ? "☑️" : "⬜️"} ${o}`, callback_data:`${prefix}:${o}` }]));
  rows.push([{ text:"Дальше ➜", callback_data:`${prefix}:next` }]);
  return JSON.stringify({ inline_keyboard: rows });
}
async function sendWelcome(chat, uid) {
  console.log("sendWelcome", { uid, chat });
  await tg("sendMessage", {
    chat_id: chat,
    text: "Привет! Это быстрый отбор «стратегических партнёров» (SQL + Graph + Vector).\nСобираем только рабочие ответы: интересы, стек, стиль, время. Ок?",
    parse_mode: "HTML",
    reply_markup: consentKeyboard()
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
    reply_markup: rm
  });
}
async function sendInterestsPrompt(chat, uid, s) {
  console.log("sendInterests", { uid });
  await tg("sendMessage", {
    chat_id: chat,
    text: "3) Что интереснее 3–6 мес.? (мультивыбор, повторное нажатие снимает)",
    parse_mode: "HTML",
    reply_markup: multiKb("q3", A_INTERESTS, s.interests || [])
  });
}
async function sendStackPrompt(chat, uid, s) {
  console.log("sendStack", { uid });
  await tg("sendMessage", {
    chat_id: chat,
    text: "4) Уверенный стек (мультивыбор):",
    parse_mode: "HTML",
    reply_markup: multiKb("q4", A_STACK, s.stack || [])
  });
}

/* ---------------- HTTP entry (Vercel) ---------------- */

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(200).send("OK"); return; }
  const upd = await readBody(req);

  try { console.log("HOOK:", JSON.stringify({ id: upd.update_id, msg: !!upd.message, cb: !!upd.callback_query })); } catch {}

  try {
    if (upd.update_id && !(await seenUpdate(upd.update_id))) { res.status(200).send("OK"); return; }
    if (upd.message)             await onMessage(upd.message);
    else if (upd.callback_query) await onCallback(upd.callback_query);
  } catch (e) {
    console.error("handler error:", e?.stack || e?.message || String(e));
  }
  res.status(200).send("OK");
}

/* ---------------- Handlers ---------------- */

async function onMessage(m) {
  const uid = m.from.id;
  if (await overRL(uid, 12)) return;

  const chat = m.chat.id;
  const text = (m.text || "").trim();
  try { console.log("onMessage:", { uid, text }); } catch {}

  if (text.toLowerCase() === "/ping") { await tg("sendMessage", { chat_id: chat, text: "pong ✅" }); return; }

  if (text.startsWith("/start")) {
    const payload = text.split(" ").slice(1).join(" ").trim();
    const hasSecret = payload && START_SECRET && payload.includes(START_SECRET);
    if (REQUIRE_SEC && !hasSecret && String(uid) !== String(ADMIN_ID)) {
      await tg("sendMessage", { chat_id: chat, text: `Нужен ключ доступа. Открой ссылку:\nhttps://t.me/rgnr_assistant_bot?start=${encodeURIComponent(START_SECRET || "INVITE")}` });
      return;
    }
    const s = await getSess(uid);
    if (s.step && s.step !== "consent") {
      await tg("sendMessage", { chat_id: chat, text: "Анкета уже начата — продолжаем ⬇️" });
      if (s.step === "name")        await sendNamePrompt(chat, uid, m.from.username);
      else if (s.step === "interests") await sendInterestsPrompt(chat, uid, s);
      else if (s.step === "stack")     await sendStackPrompt(chat, uid, s);
      return;
    }
    await delSess(uid);
    await putSess(uid, { step:"consent", consent:"", name:"", interests:[], stack:[] });
    await sendWelcome(chat, uid);
    return;
  }

  const s = await getSess(uid);
  if (s.step === "name") {
    s.name = text.slice(0,80);
    s.step = "interests";
    await putSess(uid, s);
    await sendInterestsPrompt(chat, uid, s);
    return;
  }

  await tg("sendMessage", { chat_id: chat, text: NO_CHAT });
}

async function onCallback(q) {
  const uid = q.from.id;
  if (await overRL(uid, 12)) return;

  const chat = q.message.chat.id;
  const mid  = q.message.message_id;
  const data = q.data || "";

  try { await tg("answerCallbackQuery", { callback_query_id: q.id }); } catch {}

  let s = await getSess(uid);

  if (data === "consent_yes") {
    if (s.step !== "consent") return;
    s.consent = "yes"; s.step = "name";
    await putSess(uid, s);
    await tg("editMessageText", { chat_id: chat, message_id: mid, text: "✅ Спасибо за согласие на связь.", parse_mode:"HTML" });
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
    s.step = "interests";
    await putSess(uid, s);
    await sendInterestsPrompt(chat, uid, s);
    return;
  }

  if (data.startsWith("q3:")) {
    if (s.step !== "interests") return;
    const opt = data.split(":")[1];
    if (!Array.isArray(s.interests)) s.interests = [];
    if (opt === "next") {
      s.step = "stack";
      await putSess(uid, s);
      await sendStackPrompt(chat, uid, s);
      return;
    }
    toggleInPlace(s.interests, opt);
    await putSess(uid, s);
    await tg("editMessageReplyMarkup", {
      chat_id: chat, message_id: mid, reply_markup: multiKb("q3", A_INTERESTS, s.interests)
    });
    return;
  }

  if (data.startsWith("q4:")) {
    if (s.step !== "stack") return;
    const opt = data.split(":")[1];
    if (!Array.isArray(s.stack)) s.stack = [];
    if (opt === "next") {
      s.step = "paused";
      await putSess(uid, s);
      await tg("sendMessage", { chat_id: chat, text: "✅ Зафиксировал интересы и стек. Продолжим в следующем шаге." });
      return;
    }
    toggleInPlace(s.stack, opt);
    await putSess(uid, s);
    await tg("editMessageReplyMarkup", {
      chat_id: chat, message_id: mid, reply_markup: multiKb("q4", A_STACK, s.stack)
    });
    return;
  }
}

/* ---------------- Utils ---------------- */
function toggleInPlace(arr, val) {
  const i = arr.indexOf(val);
  if (i >= 0) arr.splice(i, 1);
  else arr.push(val);
}
