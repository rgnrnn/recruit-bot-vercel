// api/telegram.js — Telegram webhook (Vercel, Node 20, ESM)
import { handleAdminCommand } from "./admin-commands.js";
import { handleAdminAgentMessage, handleAdminAgentCallback } from "./admin-agent.js";

const TOKEN        = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID     = process.env.ADMIN_CHAT_ID || "";
const START_SECRET = process.env.START_SECRET || "";
const REQUIRE_SEC  = /^1|true$/i.test(process.env.REQUIRE_SECRET || "");
const REDIS_BASE   = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const REDIS_TOKEN  = process.env.UPSTASH_REDIS_REST_TOKEN || "";

const SHEETS_URL   = process.env.SHEETS_WEBHOOK_URL || "";
const SHEETS_SECRET= process.env.SHEETS_WEBHOOK_SECRET || "";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL   = process.env.OPENAI_MODEL || "gpt-4o-mini";

const NO_CHAT = "я не веду переписку — используй кнопки ниже";

// ---- DEBUG (только в логи Vercel; админу не слать) ----
const DEBUG_TELEGRAM = /^1|true$/i.test(process.env.DEBUG_TELEGRAM || "");
function dbg(label, payload) {
  try {
    const msg = `[DBG] ${label}: ` + (typeof payload === "string" ? payload : JSON.stringify(payload));
    console.log(msg);
  } catch {}
}

const AGE_OPTIONS = ["18–20","21–23","24–26","27–29","30–33","34–37","более 38"];

const INTEREST_ITEMS = [
  { id: "i_backend",  label: "Backend (f.ex: Python/FastAPI/Postgres)" },
  { id: "i_frontend", label: "Frontend (f.ex: React/TS)" },
  { id: "i_graph",    label: "Graph" },
  { id: "i_vector",   label: "Vector" },
  { id: "i_data_etl", label: "Data/ETL (DWH/BI)" },
  { id: "i_devops",   label: "DevOps/MLOps" },
  { id: "i_product",  label: "Product/Coordination" },
  { id: "i_integr",   label: "Integrations & API (ERP/1C/CRM)" },
  { id: "i_rag",      label: "RAG / Retrieval Systems" },
  { id: "i_agents",   label: "Agents / Orchestration (LangGraph)" },
  { id: "i_kg",       label: "Knowledge Graphs / Онтологии" },
  { id: "i_db_perf",  label: "DB & Perf (Postgres/pgvector)" },
  { id: "i_sec",      label: "Security & Access" },
  { id: "i_observ",   label: "Observability (logs/metrics/tracing)" },
  { id: "i_testing",  label: "Testing/QA Automation" },
  { id: "i_ux_ui",    label: "UX/UI & Design Systems" },
  { id: "i_cloud",    label: "Cloud (AWS/GCP)" },
  { id: "i_dist",     label: "Distributed Systems (CQRS/Event Sourcing)" },
];
const INTEREST_PAIRS = [
  ["i_backend","i_frontend"],["i_graph","i_vector"],["i_data_etl","i_devops"],
  ["i_product","i_integr"],["i_rag","i_agents"],["i_kg","i_db_perf"],
  ["i_sec","i_observ"],["i_testing","i_ux_ui"],["i_cloud","i_dist"],
];
const LABEL_BY_ID = Object.fromEntries(INTEREST_ITEMS.map(x => [x.id, x.label]));

const STACK_ITEMS = [
  { id: "i_backend",  label: "Backend (f.ex: Python/FastAPI/Postgres)" },
  { id: "i_frontend", label: "Frontend (f.ex: React/TS)" },
  { id: "i_graph",    label: "Graph" },
  { id: "i_vector",   label: "Vector" },
  { id: "i_data_etl", label: "Data/ETL (DWH/BI)" },
  { id: "i_devops",   label: "DevOps/MLOps" },
  { id: "i_product",  label: "Product/Coordination" },
  { id: "i_integr",   label: "Integrations & API (ERP/1C/CRM)" },
  { id: "i_rag",      label: "RAG / Retrieval Systems" },
  { id: "i_agents",   label: "Agents / Orchestration (LangGraph)" },
  { id: "i_kg",       label: "Knowledge Graphs / Онтологии" },
  { id: "i_db_perf",  label: "DB & Perf (Postgres/pgvector)" },
  { id: "i_sec",      label: "Security & Access" },
  { id: "i_observ",   label: "Observability (logs/metrics/tracing)" },
  { id: "i_testing",  label: "Testing/QA Automation" },
  { id: "i_ux_ui",    label: "UX/UI & Design Systems" },
  { id: "i_cloud",    label: "Cloud (AWS/GCP)" },
  { id: "i_dist",     label: "Distributed Systems (CQRS/Event Sourcing)" },
];
const STACK_PAIRS = [
  ["i_backend","i_frontend"],["i_graph","i_vector"],["i_data_etl","i_devops"],
  ["i_product","i_integr"],["i_rag","i_agents"],["i_kg","i_db_perf"],
  ["i_sec","i_observ"],["i_testing","i_ux_ui"],["i_cloud","i_dist"],
];
const STACK_LABEL_BY_ID = Object.fromEntries(STACK_ITEMS.map(x => [x.id, x.label]));

const A1 = ["быстро прототипирую","проектирую основательно","исследую гипотезы","синхронизирую людей"];
const A2 = ["MVP важнее идеала","полирую до совершенства"];
const A3 = ["риск/скорость","надёжность/предсказуемость"];

const MAX_INTERESTS = 7;
const MAX_STACK     = 7;

const RL_TOGGLE_PER_MIN  = 120;
const RL_DEFAULT_PER_MIN = 30;

const TIME_DAYS  = ["понедельник","вторник","среда","четверг"];
const TIME_SLOTS = ["11:00–13:00","13:00–15:00","15:00–16:00","17:00–19:00"];

/* ---------------- Redis ---------------- */
function rUrl(path){ if(!REDIS_BASE||!REDIS_TOKEN) throw new Error("Redis env missing"); return new URL(REDIS_BASE+path); }
async function rGET(path){ const r=await fetch(rUrl(path),{headers:{Authorization:`Bearer ${REDIS_TOKEN}`}}); return r.json(); }
async function rCall(path,qs){ const u=rUrl(path); if(qs) for(const[k,v]of Object.entries(qs)) u.searchParams.set(k,String(v)); const r=await fetch(u,{headers:{Authorization:`Bearer ${REDIS_TOKEN}`}}); return r.json(); }
const rSet=(k,v,qs)=> rCall(`/set/${encodeURIComponent(k)}/${encodeURIComponent(v)}`, qs);
const rGet=(k)=> rGET(`/get/${encodeURIComponent(k)}`);
const rDel=(k)=> rGET(`/del/${encodeURIComponent(k)}`);
const rIncr=async(k,ex=60)=>{ const j=await rGET(`/incr/${encodeURIComponent(k)}`); if(j.result===1 && ex>0) await rGET(`/expire/${encodeURIComponent(k)}/${ex}`); return j.result; };
async function rIncrNoTTL(k){ const j = await rGET(`/incr/${encodeURIComponent(k)}`); return j.result; }

// --- Forms versioning (для глобального сброса лимитов)
async function getFormsVersion() {
  try { const j = await rGet("forms:version"); return Number(j?.result || 1) || 1; }
  catch { return 1; }
}
async function formsResetAll() {
  try { await rIncrNoTTL("forms:version"); return true; } catch { return false; }
}

// --- helper: защита от повторной доставки апдейтов Telegram (idempotency)
async function seenUpdate(id) {
  try {
    const j = await rSet(`upd:${id}`, "1", { EX: 180, NX: true });
    return j && ("result" in j) ? j.result === "OK" : true;
  } catch {
    return true;
  }
}

// >>> NEW: rate-limit helper (вернули, чтобы не было "overRL is not defined")
async function overRL(uid, limit = 12) {
  try {
    // считаем количество нажатий за минуту: rl:<uid>
    const used = await rIncr(`rl:${uid}`, 60);
    return used > limit;
  } catch {
    return false;
  }
}

// --- счётчик отправок (legacy учитываем ТОЛЬКО при версии 1)
async function getSubmitCount(uid) {
  const ver = await getFormsVersion();
  const keyVer = `forms:v${ver}:${uid}:count`;
  let cnt = 0;
  try { const j = await rGet(keyVer); cnt = Number(j?.result || 0) || 0; } catch {}
  if (ver === 1) {
    try {
      const j2 = await rGet(`forms:${uid}:count`);
      const legacy = Number(j2?.result || 0) || 0;
      if (legacy > cnt) { cnt = legacy; try { await rSet(keyVer, String(legacy)); } catch {} }
    } catch {}
  }
  return { count: cnt, key: keyVer, version: ver };
}

// --- snapshot предыдущей анкеты (для diff и динамики)
function makeSnapshot(s){
  return {
    name: s.name || "",
    about: s.about || "",
    interests: Array.isArray(s.interests)? [...s.interests] : [],
    stack: Array.isArray(s.stack)? [...s.stack] : [],
    a1: s.a1 || "", a2: s.a2 || "", a3: s.a3 || "",
    time_days: Array.isArray(s.time_days)? [...s.time_days] : [],
    time_slots: Array.isArray(s.time_slots)? [...s.time_slots] : []
  };
}
async function getPrevSnapshot(uid){
  const ver = await getFormsVersion();
  const key = `forms:last:v${ver}:${uid}`;
  try{
    const j = await rGet(key);
    if (!j?.result) return { key, snap: null };
    return { key, snap: JSON.parse(j.result) };
  }catch{ return { key, snap: null }; }
}
async function setPrevSnapshot(uid, snap){
  const ver = await getFormsVersion();
  const key = `forms:last:v${ver}:${uid}`;
  try{ await rSet(key, JSON.stringify(snap), { EX: 3600*24*180 }); }catch{}
}
function arrDiff(prev=[], curr=[]){
  const p = new Set(prev); const c = new Set(curr);
  const added   = [...c].filter(x=>!p.has(x));
  const removed = [...p].filter(x=>!c.has(x));
  const same    = [...c].filter(x=>p.has(x));
  return { added, removed, same };
}

/* ---------------- Writer (Apps Script) ---------------- */
async function writer(op, payload = {}, asText = false) {
  if (!SHEETS_URL || !SHEETS_SECRET) return asText ? "" : { ok:false, reason:"env_missing" };
  const res = await fetch(SHEETS_URL, {
    method: "POST",
    headers: { "content-type":"application/json" },
    body: JSON.stringify({ secret: SHEETS_SECRET, op, ...payload })
  });
  return asText ? res.text() : res.json();
}

/* ---------------- Telegram API ---------------- */
async function tg(method,payload){
  const url=`https://api.telegram.org/bot${TOKEN}/${method}`;
  try{
    const res=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
    const json=await res.json(); if(!json?.ok) console.error("tg api error:",method,JSON.stringify(json).slice(0,400));
    return json;
  }catch(e){ console.error("tg network error:",method,e?.message||String(e)); return {ok:false}; }
}

/* ---------------- Body parsing ---------------- */
async function readBody(req){
  if(req.body){ try{ return typeof req.body==="string"? JSON.parse(req.body): req.body; }catch{} }
  let raw=""; for await(const ch of req){ raw+=Buffer.isBuffer(ch)? ch.toString("utf8"): String(ch); }
  try{ return JSON.parse(raw||"{}"); }catch{ return {}; }
}

/* ---------------- Keyboards ---------------- */
const kbConsent = () => ({ inline_keyboard: [[
  { text: "✅ согласен", callback_data: "consent_yes" },
  { text: "❌ Не сейчас", callback_data: "consent_no"  }
]]});
const kbContinueReset = () => ({ inline_keyboard:[[ {text:"▶️ продолжить",callback_data:"continue"}, {text:"🔁 начать заново",callback_data:"reset_start"} ]]});
const kbName = () => ({ inline_keyboard: [[{ text: "🔁 начать заново", callback_data: "reset_start" }]] });
const kbSingle = (prefix, opts)=>({ inline_keyboard: opts.map(o=>[{text:o,callback_data:`${prefix}:${o}`}]).concat([[{text:"🔁 начать заново",callback_data:"reset_start"}]]) });

function kbInterests(selectedLabels) {
  const rows = [];
  for (const [leftId, rightId] of INTEREST_PAIRS) {
    const leftLabel  = LABEL_BY_ID[leftId];
    const rightLabel = LABEL_BY_ID[rightId];
    rows.push([
      { text: `${selectedLabels.includes(leftLabel)  ? "☑️" : "⬜️"} ${leftLabel}`,  callback_data: `q3id:${leftId}`  },
      { text: `${selectedLabels.includes(rightLabel) ? "☑️" : "⬜️"} ${rightLabel}`, callback_data: `q3id:${rightId}` },
    ]);
  }
  rows.push([{ text: "🟢 ДАЛЬШЕ ➜", callback_data: "q3:next" }]);
  rows.push([{ text: "🔁 начать заново", callback_data: "reset_start" }]);
  return { inline_keyboard: rows };
}
function kbStack(selectedLabels) {
  const rows = [];
  for (const [leftId, rightId] of STACK_PAIRS) {
    const leftLabel  = STACK_LABEL_BY_ID[leftId];
    const rightLabel = STACK_LABEL_BY_ID[rightId];
    rows.push([
      { text: `${selectedLabels.includes(leftLabel)  ? "☑️" : "⬜️"} ${leftLabel}`,  callback_data: `q4id:${leftId}`  },
      { text: `${selectedLabels.includes(rightLabel) ? "☑️" : "⬜️"} ${rightLabel}`, callback_data: `q4id:${rightId}` },
    ]);
  }
  rows.push([{ text: "🟢 ДАЛЬШЕ ➜", callback_data: "q4:next" }]);
  rows.push([{ text: "🔁 начать заново", callback_data: "reset_start" }]);
  return { inline_keyboard: rows };
}
function kbTimeDaysSlots(sess){
  const rows = [];
  const selDays  = sess.time_days  || [];
  const selSlots = sess.time_slots || [];
  const maxRows = Math.max(TIME_DAYS.length, TIME_SLOTS.length);
  for (let i=0;i<maxRows;i++){
    const r = [];
    if (i < TIME_DAYS.length) {
      const d = TIME_DAYS[i];
      r.push({ text: `${selDays.includes(d) ? "☑️" : "⬜️"} ${d}`, callback_data: `q7d:${d}` });
    }
    if (i < TIME_SLOTS.length) {
      const s = TIME_SLOTS[i];
      r.push({ text: `${selSlots.includes(s) ? "☑️" : "⬜️"} ${s}`, callback_data: `q7s:${s}` });
    }
    rows.push(r);
  }
  rows.push([{ text: "🟢 ГОТОВО ➜", callback_data: "q7:done" }]);
  rows.push([{ text: "🔁 начать заново", callback_data: "reset_start" }]);
  return { inline_keyboard: rows };
}

/* ---------------- Screens ---------------- */
async function sendWelcome(chat, uid) {
  await tg("sendMessage", { chat_id: chat, text:
`старт в команде со-основателей: партнерская доля, право голоса в архитектуре и темп, соответствующий уровню задач 🔥🤝
ядро продукта формируется сейчас — редкий шанс зайти в проект, который сшивает три мира 🧠✨
промышленный «операционный интеллект» меняет правила в работе с данными: от хаоса файлов и чатов — к системе, где решения рождаются за секунды, а не за недели 🏭⚙️⏱️
итог — платформа, которая ускоряет решения на порядки и может переобучать сам бизнес действовать умнее 📈⚡️
формат потенциального взаимодействия - доля и партнёрство: больше влияния, больше ответственности, быстрее рост 🤝📈🚀`,
    parse_mode: "HTML", reply_markup: kbConsent() });
}
async function sendName(chat, uid) { await tg("sendMessage", { chat_id: chat, text: "2) как к тебе обращаться? введи имя текстом", parse_mode: "HTML", reply_markup: kbName() }); }
async function sendAge(chat, uid, s) { await tg("sendMessage", { chat_id: chat, text: "3) укажи возраст:", parse_mode: "HTML", reply_markup: kbSingle("age", AGE_OPTIONS) }); }
async function sendInterests(chat, uid, s) {
  await tg("sendMessage", {
    chat_id: chat,
    text: "4) что реально драйвит в последние 12 месяцев?\nотметь 2–7 направлений (чекбоксы). можно дописать сообщением позже в вопросе 'о себе'",
    parse_mode: "HTML",
    reply_markup: kbInterests(s.interests || [])
  });
}
async function sendStack(chat, uid, s){
  await tg("sendMessage", {
    chat_id: chat,
    text: "5) где тебе «можно доверить прод». \nотметь 2–7 пунктов (чекбоксы). свой инструмент можно дописать сообщением позже в вопросе 'о себе'",
    parse_mode: "HTML",
    reply_markup: kbStack(s.stack || [])
  });
}
async function sendA1(chat){ await tg("sendMessage",{chat_id:chat,text:"6) что ближе по стилю? выбери вариант",reply_markup:kbSingle("a1",A1)}); }
async function sendA2(chat){ await tg("sendMessage",{chat_id:chat,text:"7) что важнее? выбери вариант",reply_markup:kbSingle("a2",A2)}); }
async function sendA3(chat){ await tg("sendMessage",{chat_id:chat,text:"8) что предпочитаешь? выбери вариант",reply_markup:kbSingle("a3",A3)}); }
async function sendAbout(chat){ await tg("sendMessage",{chat_id:chat,text:"9) несколько строк о себе..."}); }
async function sendTime(chat, sess){
  await tg("sendMessage",{
    chat_id: chat,
    text: "отметь дни и временные слоты... затем нажми «ГОТОВО»",
    parse_mode: "HTML",
    reply_markup: kbTimeDaysSlots(sess)
  });
}

/* ---------------- LLM (главный + фолбэк, без «рекомендаций») ---------------- */
// ... (оставьте ваш текущий блок runLLM без изменений — он у вас уже присутствует выше)

//
// ---------------------- ДАЛЬШЕ ИДЁТ ВАШ КОД БЕЗ ИЗМЕНЕНИЙ ----------------------
// (appendSheets, notifyAdminOnFinish, finalize, handler, helpers, onMessage, onCallback)
// Я не дублирую их здесь, так как вы прислали полный файл; единственное добавление — helper overRL.
//

