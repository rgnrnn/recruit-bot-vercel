// api/telegram.js — webhook: согласие + имя, анти-дубли (Upstash Redis) + надёжный разбор тела + логи
import { fetch as f } from "undici";

/* === ENV === */
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID      = process.env.ADMIN_CHAT_ID || "";
const START_SECRET       = process.env.START_SECRET || ""; // deep-link, напр. INVITE
const REDIS_URL          = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN        = process.env.UPSTASH_REDIS_REST_TOKEN;

const NO_CHAT = "Я не веду переписку — используй кнопки ниже 🙌";

/* === Redis helpers (Upstash REST) === */
function rUrl(p){ return new URL(REDIS_URL.replace(/\/$/,"") + p); }
async function rGET(path){ const r = await f(rUrl(path), { headers:{Authorization:`Bearer ${REDIS_TOKEN}`}}); return r.json(); }
async function rRaw(path, qs={}){ const u = rUrl(path); Object.entries(qs).forEach(([k,v])=>u.searchParams.set(k,String(v))); const r = await f(u,{ headers:{Authorization:`Bearer ${REDIS_TOKEN}`}}); return r.json(); }
const rSet  = (k,v,qs)=> rRaw(`/set/${encodeURIComponent(k)}/${encodeURIComponent(v)}`, qs);
const rGet  = (k)=> rGET(`/get/${encodeURIComponent(k)}`);
const rDel  = (k)=> rGET(`/del/${encodeURIComponent(k)}`);
const rIncr = async (k, ex=60)=>{ const j = await rGET(`/incr/${encodeURIComponent(k)}`); if(j.result===1) await rGET(`/expire/${encodeURIComponent(k)}/${ex}`); return j.result; };

/* === Idempotency + rate limit + sessions === */
async function seenUpdate(update_id){ const j = await rSet(`upd:${update_id}`,"1",{EX:180,NX:true}); return j.result==="OK"; } // true => первый раз
async function renderOnce(uid, stage, ttl=300){ const j = await rSet(`rend:${uid}:${stage}`,"1",{EX:ttl,NX:true}); return j.result==="OK"; }
async function overRL(uid, limit=12){ return (await rIncr(`rl:${uid}`,60)) > limit; }
async function getSess(uid){ const j = await rGet(`sess:${uid}`); if(!j?.result) return { step:"consent", consent:"", name:"" }; try { return JSON.parse(j.result); } catch { return { step:"consent", consent:"", name:"" }; } }
async function putSess(uid,s){ await rSet(`sess:${uid}`, JSON.stringify(s), {EX:21600}); }
async function delSess(uid){ await rDel(`sess:${uid}`); }

/* === Telegram helpers === */
async function tg(method, payload){
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
  const res = await f(url, { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify(payload) });
  return res.json();
}
const kb = (obj)=> JSON.stringify(obj);
const consentKb = ()=> kb({ inline_keyboard: [[
  { text:"✅ Согласен на связь", callback_data:"consent_yes" },
  { text:"❌ Не сейчас",        callback_data:"consent_no"  }
]]});

/* === Надёжное чтение тела запроса === */
async function readBody(req){
  // Vercel может дать объект, строку или поток
  if (req.body) {
    try { return typeof req.body === "string" ? JSON.parse(req.body) : req.body; }
    catch { /* fallthrough */ }
  }
  let raw = "";
  for await (const chunk of req) raw += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}

/* === Render helpers (одноразовые экраны) === */
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
  const unameBtn = username ? { text:`Использовать @${username}`, callback_data:"name_use_username" } : null;
  const rm = unameBtn ? { inline_keyboard: [[unameBtn]] } : undefined;
  await tg("sendMessage", {
    chat_id: chat,
    text: "2) Как к тебе обращаться? Введи имя текстом" + (username?` или нажми «Использовать @${username}».`:""),
    parse_mode: "HTML",
    reply_markup: rm ? JSON.stringify(rm) : undefined
  });
}

/* === HTTP entry === */
export default async function handler(req, res){
  if (req.method !== "POST") { res.status(200).send("OK"); return; }
  const upd = await readBody(req);
  // лог для отладки
  try { console.log("TG update:", JSON.stringify({hasMessage:!!upd.message, hasCb:!!upd.callback_query, update_id: upd.update_id})); } catch {}
  try {
    // анти-дубли по update_id
    if (upd.update_id && !(await seenUpdate(upd.update_id))) { res.status(200).send("OK"); return; }
    if (upd.message)             await onMessage(upd.message);
    else if (upd.callback_query) await onCallback(upd.callback_query);
  } catch(e){
    console.error("handler error:", e?.stack || e?.message || String(e));
  }
  res.status(200).send("OK");
}

/* === Handlers === */
async function onMessage(m){
  const uid = m.from.id; if (await overRL(uid)) return;
  const chat = m.chat.id;
  const text = (m.text||"").trim();

  if (text.startsWith("/start")){
    if (START_SECRET){
      const payload = text.split(" ").slice(1).join(" ").trim();
      if (!payload || !payload.includes(START_SECRET)){
        await tg("sendMessage", { chat_id: chat, text: "Доступ по персональной ссылке. Обратись к администратору." });
        return;
      }
    }
    const s = await getSess(uid);
    if (s.step && s.step !== "consent"){
      await tg("sendMessage", { chat_id: chat, text: "Анкета уже начата — продолжаем ⬇️" });
      if (s.step==="name") await sendNamePrompt(chat, uid, m.from.username);
      return;
    }
    await delSess(uid);
    await putSess(uid, { step:"consent", consent:"", name:"" });
    await sendWelcome(chat, uid);
    return;
  }

  const s = await getSess(uid);
  if (s.step === "name"){
    s.name = text.slice(0,80); s.step = "hold"; await putSess(uid, s);
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
    if (s.step !== "consent") return;
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
