// api/telegram.js — Q1 (consent) + Q2 (name) с анти-дублями на Upstash Redis.
// Минимум зависимостей: используем глобальный fetch (Node 20 на Vercel).

const TOKEN       = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID    = process.env.ADMIN_CHAT_ID || "";
const START_SECRET= process.env.START_SECRET || "INVITE";
const REDIS_BASE  = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/,"");
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";

const NO_CHAT = "Я не веду переписку — используй кнопки ниже 🙌";

/* ---------- Redis helpers (REST) ---------- */
async function r(path, qs) {
  const url = new URL(REDIS_BASE + path);
  if (qs) Object.entries(qs).forEach(([k,v])=> url.searchParams.set(k, String(v)));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` }});
  return res.json();
}
const rGet  = (k)=> r(`/get/${encodeURIComponent(k)}`);
const rDel  = (k)=> r(`/del/${encodeURIComponent(k)}`);
const rSet  = (k,v,opts={})=> r(`/set/${encodeURIComponent(k)}/${encodeURIComponent(v)}`, opts);
const rIncr = async (k, ex=60)=>{ const j=await r(`/incr/${encodeURIComponent(k)}`); if(j.result===1) await r(`/expire/${encodeURIComponent(k)}/${ex}`); return j.result; };

async function seenUpdate(id){ const j = await rSet(`upd:${id}`, "1", { EX:180, NX:true }); return j.result==="OK"; }  // true => первый раз
async function renderOnce(uid, stage, ttl=300){ const j = await rSet(`rend:${uid}:${stage}`, "1", { EX:ttl, NX:true }); return j.result==="OK"; }
async function overRL(uid, limit=12){ return (await rIncr(`rl:${uid}`, 60)) > limit; }
async function getSess(uid){
  const j = await rGet(`sess:${uid}`); if(!j?.result) return { step:"consent", consent:"", name:"" };
  try { return JSON.parse(j.result); } catch { return { step:"consent", consent:"", name:"" }; }
}
async function putSess(uid,s){ await rSet(`sess:${uid}`, JSON.stringify(s), { EX:21600 }); }
async function delSess(uid){ await rDel(`sess:${uid}`); }

/* ---------- Telegram API ---------- */
async function tg(method, payload){
  const url = `https://api.telegram.org/bot${TOKEN}/${method}`;
  const res = await fetch(url, { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify(payload) });
  return res.json();
}
const kb = (obj)=> JSON.stringify(obj);
const consentKb = ()=> kb({ inline_keyboard: [[
  { text:"✅ Согласен на связь", callback_data:"consent_yes" },
  { text:"❌ Не сейчас",        callback_data:"consent_no"  }
]]});

/* ---------- Body parsing ---------- */
async function readBody(req){
  if (req.body) {
    try { return typeof req.body === "string" ? JSON.parse(req.body) : req.body; } catch {}
  }
  let raw=""; for await (const ch of req) raw += Buffer.isBuffer(ch)? ch.toString("utf8"): String(ch);
  try { return JSON.parse(raw||"{}"); } catch { return {}; }
}

/* ---------- One-time screens ---------- */
async function sendWelcome(chat, uid){
  if (!(await renderOnce(uid,"welcome"))) return;
  await tg("sendMessage", {
    chat_id: chat,
    text: "Привет! Это быстрый отбор «стратегических партнёров» (SQL + Graph + Vector).\nСобираем только рабочие ответы: интересы, стек, стиль, время. Ок?",
    parse_mode: "HTML",
    reply_markup: consentKb()
  });
}
async function sendNamePrompt(chat, uid, username){
  if (!(await renderOnce(uid,"name"))) return;
  const btn = username ? { text:`Использовать @${username}`, callback_data:"name_use_username" } : null;
  const rm = btn ? { inline_keyboard: [[btn]] } : undefined;
  await tg("sendMessage", {
    chat_id: chat,
    text: "2) Как к тебе обращаться? Введи имя текстом" + (username?` или нажми «Использовать @${username}».`:""),
    parse_mode: "HTML",
    reply_markup: rm ? JSON.stringify(rm) : undefined
  });
}

/* ---------- HTTP entry ---------- */
export default async function handler(req, res){
  if (req.method !== "POST") { res.status(200).send("OK"); return; }
  const upd = await readBody(req);
  try { console.log("HOOK:", JSON.stringify({ id: upd.update_id, msg: !!upd.message, cb: !!upd.callback_query })); } catch {}
  try {
    if (upd.update_id && !(await seenUpdate(upd.update_id))) { res.status(200).send("OK"); return; }
    if (upd.message)             await onMessage(upd.message);
    else if (upd.callback_query) await onCallback(upd.callback_query);
  } catch(e){ console.error("ERR:", e?.stack || e?.message || String(e)); }
  res.status(200).send("OK");
}

/* ---------- Handlers ---------- */
async function onMessage(m){
  const uid  = m.from.id;
  if (await overRL(uid)) return;

  const chat = m.chat.id;
  const text = (m.text || "").trim();
  try { console.log("onMessage:", { uid, text }); } catch {}

  // Диагностика
  if (text.toLowerCase() === "/ping") {
    await tg("sendMessage", { chat_id: chat, text: "pong ✅" });
    return;
  }

  if (text.startsWith("/start")) {
    // РАНЬШЕ: требовали обязательный payload `INVITE`.
    // СЕЙЧАС: если payload есть и он НЕ содержит секрет — отклоняем.
    // Если payload пустой — ПРОПУСКАЕМ (временно, чтобы не стопориться).
    const payload = text.split(" ").slice(1).join(" ").trim();
    if (payload && START_SECRET && !payload.includes(START_SECRET) && String(uid) !== String(ADMIN_ID)) {
      await tg("sendMessage", { chat_id: chat, text: "Неверный ключ доступа. Попроси свежую ссылку у администратора." });
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
    await sendWelcome(chat, uid);  // Экран «Согласен на связь»
    return;
  }

  // Текст принимаем только на шаге name
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


async function onCallback(q){
  const uid = q.from.id; if (await overRL(uid)) return;
  const chat = q.message.chat.id; const mid = q.message.message_id;
  const data = q.data || ""; await tg("answerCallbackQuery", { callback_query_id: q.id });

  let s = await getSess(uid);

  if (data === "consent_yes"){
    if (s.step !== "consent") return;             // идемпотентность шага
    s.consent = "yes"; s.step = "name"; await putSess(uid, s);
    await tg("editMessageText", { chat_id: chat, message_id: mid, text: "✅ Спасибо за согласие на связь.", parse_mode:"HTML" });
    await sendNamePrompt(chat, uid, q.from.username);
    return;
  }
  if (data === "consent_no"){
    if (s.step !== "consent") return;
    await tg("editMessageText", { chat_id: chat, message_id: mid, text: "Ок. Если передумаешь — /start" });
    await delSess(uid); return;
  }

  if (data === "name_use_username"){
    if (s.step !== "name") return;
    s.name = q.from.username ? `@${q.from.username}` : String(uid);
    s.step = "hold"; await putSess(uid, s);
    await tg("sendMessage", { chat_id: chat, text: `✅ Ок, ${s.name}. Следующий шаг добавим далее.` });
    return;
  }
}
