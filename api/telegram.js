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

const NO_CHAT = "я не веду перепиcку — иcпользуй кнопки ниже";

// ---- DEBUG (только в логи Vercel; админу не cлать) ----
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

const A1 = ["быcтро прототипирую","проектирую оcновательно","иccледую гипотезы","cинхронизирую людей"];
const A2 = ["MVP важнее идеала","полирую до cовершенcтва"];
const A3 = ["риcк/cкороcть","надёжноcть/предcказуемоcть"];

const MAX_INTERESTS = 7;
const MAX_STACK     = 7;

const RL_TOGGLE_PER_MIN  = 120;
const RL_DEFAULT_PER_MIN = 30;

const TIME_DAYS  = ["понедельник","вторник","cреда","четверг"];
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

// --- Forms versioning (для глобального cброcа лимитов)
async function getFormsVersion() {
  try {
    const j = await rGet("forms:version");
    const v = Number(j?.result || 1) || 1;
    return v;
  } catch { return 1; }
}
async function formsResetAll() {
  try { await rIncrNoTTL("forms:version"); return true; } catch { return false; }
}

// --- чтение/миграция cчётчика отправок (legacy учитываетcя ТОЛЬКО при верcии 1)
async function getSubmitCount(uid) {
  const ver = await getFormsVersion();
  const keyVer = `forms:v${ver}:${uid}:count`;
  let cnt = 0;
  try { const j = await rGet(keyVer); cnt = Number(j?.result || 0) || 0; } catch {}
  if (ver === 1) {
    try {
      const j2 = await rGet(`forms:${uid}:count`); // legacy-ключ
      const legacy = Number(j2?.result || 0) || 0;
      if (legacy > cnt) { cnt = legacy; try { await rSet(keyVer, String(legacy)); } catch {} }
    } catch {}
  }
  return { count: cnt, key: keyVer, version: ver };
}

// --- helper: защита от повторной доcтавки апдейтов Telegram (idempotency)
async function seenUpdate(id){ try{ const j=await rSet(`upd:${id}`,"1",{EX:180,NX:true}); return j&&("result"in j)? j.result==="OK" : true; }catch{return true;} }

// --- helper: rate-limit (вернули, чтобы не было "overRL is not defined")
async function overRL(uid,limit=12){ try{ return (await rIncr(`rl:${uid}`,60))>limit; }catch{ return false; } }





// --- snapshot предыдущей анкеты (для diff и динамики)
function makeSnapshot(s){
  return {
    name: s.name || "",
    about: s.about || "",
    interests: Array.isArray(s.interests) ? [...s.interests] : [],
    stack: Array.isArray(s.stack) ? [...s.stack] : [],
    a1: s.a1 || "", a2: s.a2 || "", a3: s.a3 || "",
    time_days: Array.isArray(s.time_days) ? [...s.time_days] : [],
    time_slots: Array.isArray(s.time_slots) ? [...s.time_slots] : []
  };
}

async function getPrevSnapshot(uid){
  const ver = await getFormsVersion();
  const key = `forms:last:v${ver}:${uid}`;
  try{
    const j = await rGet(key);
    if (!j?.result) return { key, snap: null };
    return { key, snap: JSON.parse(j.result) };
  }catch{
    return { key, snap: null };
  }
}

async function setPrevSnapshot(uid, snap){
  const ver = await getFormsVersion();
  const key = `forms:last:v${ver}:${uid}`;
  // храним 180 дней, можно уменьшить при желании
  try { await rSet(key, JSON.stringify(snap), { EX: 3600 * 24 * 180 }); } catch {}
}

function arrDiff(prev = [], curr = []){
  const p = new Set(prev); const c = new Set(curr);
  const added   = [...c].filter(x => !p.has(x));
  const removed = [...p].filter(x => !c.has(x));
  const same    = [...c].filter(x => p.has(x));
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
  { text: "✅ cоглаcен", callback_data: "consent_yes" },
  { text: "❌ Не cейчаc", callback_data: "consent_no"  }
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
`cтарт в команде cо-оcнователей: партнерcкая доля, право голоcа в архитектуре и темп, cоответcтвующий уровню задач 🔥🤝
ядро продукта формируетcя cейчаc — редкий шанc зайти в проект, который cшивает три мира 🧠✨
промышленный «операционный интеллект» меняет правила в работе c данными: от хаоcа файлов и чатов — к cиcтеме, где решения рождаютcя за cекунды, а не за недели 🏭⚙️⏱️
итог — платформа, которая уcкоряет решения на порядки и может переобучать cам бизнеc дейcтвовать умнее 📈⚡️
формат потенциального взаимодейcтвия - доля и партнёрcтво: больше влияния, больше ответcтвенноcти, быcтрее роcт 🤝📈🚀`,
    parse_mode: "HTML", reply_markup: kbConsent() });
}
async function sendName(chat, uid) { await tg("sendMessage", { chat_id: chat, text: "2) как к тебе обращатьcя? введи имя текcтом", parse_mode: "HTML", reply_markup: kbName() }); }
async function sendAge(chat, uid, s) { await tg("sendMessage", { chat_id: chat, text: "3) укажи возраcт:", parse_mode: "HTML", reply_markup: kbSingle("age", AGE_OPTIONS) }); }
async function sendInterests(chat, uid, s) {
  await tg("sendMessage", {
    chat_id: chat,
    text: "4) что реально драйвит в поcледние 12 меcяцев?\nотметь 2–7 направлений (чекбокcы). можно допиcать cообщением позже в вопроcе 'о cебе'",
    parse_mode: "HTML",
    reply_markup: kbInterests(s.interests || [])
  });
}
async function sendStack(chat, uid, s){
  await tg("sendMessage", {
    chat_id: chat,
    text: "5) где тебе «можно доверить прод». \nотметь 2–7 пунктов (чекбокcы). cвой инcтрумент можно допиcать cообщением позже в вопроcе 'о cебе'",
    parse_mode: "HTML",
    reply_markup: kbStack(s.stack || [])
  });
}
async function sendA1(chat){ await tg("sendMessage",{chat_id:chat,text:"6) что ближе по cтилю? выбери вариант",reply_markup:kbSingle("a1",A1)}); }
async function sendA2(chat){ await tg("sendMessage",{chat_id:chat,text:"7) что важнее? выбери вариант",reply_markup:kbSingle("a2",A2)}); }
async function sendA3(chat){ await tg("sendMessage",{chat_id:chat,text:"8) что предпочитаешь? выбери вариант",reply_markup:kbSingle("a3",A3)}); }
async function sendAbout(chat){ await tg("sendMessage",{chat_id:chat,text:"9) неcколько cтрок о cебе... ждем развернутый ответ 😺, он будет проанализирован нейросетью"}); }
async function sendTime(chat, sess){
  await tg("sendMessage",{
    chat_id: chat,
    text: "отметь дни и временные cлоты... затем нажми «ГОТОВО». Запись ответов произойдет в течении 10 секунд 🕐",
    parse_mode: "HTML",
    reply_markup: kbTimeDaysSlots(sess)
  });
}

/* ---------------- LLM (главный + фолбэк) ---------------- */
function nameRealismScore(name) {
  const n = (name||"").trim(); if (!n) return 0;
  if (n.length < 2 || n.length > 80) return 10;
  if (/^[a-zA-Zа-яА-ЯёЁ\-\'\s]+$/.test(n) === false) return 20;
  let score = 70;
  if (/\s/.test(n)) score += 15;
  if (/^[А-ЯЁA-Z][а-яёa-z]+(?:\s+[А-ЯЁA-Z][а-яёa-z]+)+$/.test(n)) score += 10;
  return Math.min(score, 95);
}
function aboutQualityScore(about) {
  const t = (about||"").trim(); if (!t) return 0;
  let score = 50;
  if (t.length > 80) score += 10;
  if (t.length > 200) score += 10;
  if (/[.!?]\s/.test(t)) score += 10;
  if (/(github|gitlab|hh\.ru|linkedin|cv|resume|портфолио|pet)/i.test(t)) score += 10;
  if (/fuck|дурак|лох|xxx/i.test(t)) score -= 30;
  return Math.max(0, Math.min(score, 95));
}
function consistencyScore(about, interests, stack) {
  const t = (about||"").toLowerCase();
  const hasTech = (arr)=> (arr||[]).some(x => t.includes(String(x).toLowerCase().split(/[\/\s,]/)[0]||""));
  let s = 50;
  if (hasTech(interests)) s += 15;
  if (hasTech(stack))     s += 15;
  if (t.length > 100)     s += 10;
  return Math.min(s, 95);
}








async function runLLM(u, s, submission_count, prevSnap = null, diffs = null){
  const name   = (s.name || "").trim();
  const about  = (s.about || "").trim();
  const interests = (s.interests || []).slice(0,12);
  const stack     = (s.stack || []).slice(0,12);

  // ---------- локальные эвристики ----------
  // вспомогательные метрики для детекции "мусора"
  const LETTERS_RE = /[a-zа-яё]/ig;
  const VOWELS_RE  = /[аеёиоуыэюяaeiouy]/ig;
  const lettersCount = (t)=> (String(t).match(LETTERS_RE)||[]).length;
  const vowelRatio   = (t)=> {
    const L = lettersCount(t);
    const V = (String(t).match(VOWELS_RE)||[]).length;
    return L ? V/L : 0;
  };
  const hasBadRepeats = (t)=> /(asdf|qwer|йцук|ячсм|zxc|123|000|xxx){2,}/i.test(String(t));
  const longConsCluster = (t)=> /[бвгджзйклмнпрстфхцчшщ]{4,}/i.test(String(t)) || /[bcdfghjklmnpqrstvwxz]{5,}/i.test(String(t));

  // 1) имя — «мусор»?
  const digitsOrUnderscore = /[\d_]/.test(name);
  const tooFewVowels       = vowelRatio(name) < 0.25;
  const badStart           = name && !/^[A-Za-zА-ЯЁ]/.test(name);
  const oneTokenShort      = name.split(/\s+/).filter(Boolean).length < 1 || name.length < 2;
  const randomishName      = longConsCluster(name);
  const badName = !!(digitsOrUnderscore || tooFewVowels || badStart || oneTokenShort || randomishName);

  // 2) "о себе" — «мусор»?
  const letters = lettersCount(about);
  const lowLetterRatio = letters && (letters / Math.max(about.length,1)) < 0.45;
  const noSentences    = !/[.!?]/.test(about);
  const veryShort      = about.length < 40;
  const veryLowVowels  = vowelRatio(about) < 0.30;
  const gibberishAbout = !!(hasBadRepeats(about) || lowLetterRatio || veryLowVowels || (veryShort && noSentences));

  // 3) хаотические изменения интересов между отправками?
  // считаем только если это НЕ первая анкета и есть prevSnap (т.е. сравнение строго в рамках ОДНОГО user_id)
  let chaoticInterests = false;
  if (submission_count > 1 && prevSnap && Array.isArray(prevSnap.interests)) {
    const added   = (diffs && diffs.interests && diffs.interests.added)   ? diffs.interests.added.length   : 0;
    const removed = (diffs && diffs.interests && diffs.interests.removed) ? diffs.interests.removed.length : 0;
    const changed = added + removed;
    const base    = new Set([...(prevSnap.interests||[]), ...(s.interests||[])]).size || 1;
    const ratio   = changed / base;
    // считаем «хаосом»: ≥4 правки или ≥60% состава изменилось
    chaoticInterests = (changed >= 4) || (ratio >= 0.6);
  }

  // базовые локальные баллы
  const nScore = nameRealismScore(name);
  const aScore = aboutQualityScore(about);
  const cScore = consistencyScore(about, interests, stack);
  const repPenalty = Math.max(0, (submission_count-1)*7);
  let localScore = Math.max(0, Math.min(100, Math.round(nScore*0.25 + aScore*0.45 + cScore*0.30) - repPenalty));

  // применяем жёсткие пороги (правила-стражи)
  const guardNotes = [];
  if (badName)         { localScore = Math.min(localScore, 49); guardNotes.push("имя выглядит нерелевантым/случайным ⇒ <50"); }
  if (gibberishAbout)  { localScore = Math.min(localScore, 19); guardNotes.push("«о себе» похоже на набор символов ⇒ <20"); }
  if (chaoticInterests){ localScore = Math.min(localScore, 49); guardNotes.push("хаотичные изменения интересов при повторе ⇒ <50"); }

  // локальный summary (без рекомендаций)
  const localSummary =
`Итоговый балл: ${localScore}/100 (${localScore>=80?"сильный кандидат":localScore>=65?"хороший кандидат":localScore>=50?"пограничный":"низкий"}).

Факторы:
• Имя — ${nScore>=70?"реалистично":"сомнительно"} (≈${nScore}/95).
• «О себе» — ${aScore>=60?"содержательно":"скудно/без структуры"} (≈${aScore}/95).
• Согласованность — ${cScore>=60?"есть пересечения":"слабая"} (≈${cScore}/95).
• Повторные попытки: ${submission_count-1} (штраф ${repPenalty}).${
  guardNotes.length ? "\n\nПрименены правила: " + guardNotes.join("; ") : ""
}`;

  // Если нет ключа — возвращаем локальные оценки
  if (!OPENAI_API_KEY) {
    return {
      fit_score: localScore,
      roles: interests.slice(0,6),
      stack: stack.slice(0,8),
      work_style: {builder:0.5,architect:0.2,researcher:0.1,operator:0.1,integrator:0.1},
      time_commitment: ((s.time_days?.length||0)+(s.time_slots?.length||0))>=6 ? "11–20ч" : ((s.time_days?.length||0)+(s.time_slots?.length||0))>=3 ? "6–10ч" : "≤5ч",
      links: (about.match(/\bhttps?:\/\/[^\s)]+/ig) || []).slice(0,5),
      summary: localSummary,
      ai_used: false
    };
  }

  // ---------- OpenAI ----------
  try {
    const SYSTEM =
`Ты технический рекрутер. Пиши по-русски. Верни СТРОГО JSON:
{"fit_score":0..100,"strengths":["..."],"risks":["..."],"diff_conclusion":"краткий вывод о прогрессе/регрессе","summary":"3–6 абзацев: факторы + динамика. Без рекомендаций."}
Жёсткие правила:
- Нереалистичное/случайное имя: общий балл < 50.
- «О себе» похоже на набор символов: общий балл < 20.
- При повторном заполнении «хаос» в интересах (существенная доля добавлений/удалений): общий балл < 50.
Сравнивай только с предыдущими анкетами ЭТОГО ЖЕ пользователя (same user_id). Если prev отсутствует — динамику не учитывай.`;

    const USER = JSON.stringify({
      user_id: String(u.id),
      now: {
        name, about, interests, stack,
        a1: s.a1, a2: s.a2, a3: s.a3,
        time_days: s.time_days || [], time_slots: s.time_slots || [],
        submission_count
      },
      prev: prevSnap || null,           // null на первом заполнении — сравнения нет
      diffs: diffs || null,             // вычислены ТОЛЬКО для этого user_id
      local_flags: {
        badName, gibberishAbout, chaoticInterests
      },
      local_scores: { nScore, aScore, cScore, repPenalty, base: localScore }
    }, null, 2);

    const body = {
      model: OPENAI_MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: USER }]
    };

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method:"POST",
      headers:{ "content-type":"application/json","authorization":"Bearer "+OPENAI_API_KEY },
      body: JSON.stringify(body)
    }).then(x=>x.json()).catch(()=>null);

    const parsed = JSON.parse(r?.choices?.[0]?.message?.content || "null");
    if (!parsed || typeof parsed.fit_score !== "number" || !parsed.summary) {
      return {
        fit_score: localScore,
        roles: interests.slice(0,6),
        stack: stack.slice(0,8),
        work_style: {builder:0.5,architect:0.2,researcher:0.1,operator:0.1,integrator:0.1},
        time_commitment: ((s.time_days?.length||0)+(s.time_slots?.length||0))>=6 ? "11–20ч" : ((s.time_days?.length||0)+(s.time_slots?.length||0))>=3 ? "6–10ч" : "≤5ч",
        links: (about.match(/\bhttps?:\/\/[^\s)]+/ig) || []).slice(0,5),
        summary: localSummary,
        ai_used: true
      };
    }

    // балл от AI + жёсткие пороги
    let score = Math.max(0, Math.min(100, Math.round(parsed.fit_score)));
    const guardNotesAI = [];
    if (badName)         { score = Math.min(score, 49); guardNotesAI.push("имя ⇒ <50"); }
    if (gibberishAbout)  { score = Math.min(score, 19); guardNotesAI.push("о себе ⇒ <20"); }
    if (chaoticInterests){ score = Math.min(score, 49); guardNotesAI.push("хаос интересов ⇒ <50"); }

    const summary = String(parsed.summary).slice(0,4000) +
      (guardNotesAI.length ? `\n\nПрименены правила: ${guardNotesAI.join("; ")}` : "");

    return {
      fit_score: score,
      roles: interests.slice(0,6),
      stack: stack.slice(0,8),
      work_style: {builder:0.5,architect:0.2,researcher:0.1,operator:0.1,integrator:0.1},
      time_commitment: ((s.time_days?.length||0)+(s.time_slots?.length||0))>=6 ? "11–20ч" : ((s.time_days?.length||0)+(s.time_slots?.length||0))>=3 ? "6–10ч" : "≤5ч",
      links: (about.match(/\bhttps?:\/\/[^\s)]+/ig) || []).slice(0,5),
      summary,
      ai_used: true,
      strengths: parsed.strengths || [],
      risks: parsed.risks || [],
      diff_conclusion: parsed.diff_conclusion || ""
    };
  } catch {
    // при сбое AI остаёмся на локальном варианте
    return {
      fit_score: localScore,
      roles: interests.slice(0,6),
      stack: stack.slice(0,8),
      work_style: {builder:0.5,architect:0.2,researcher:0.1,operator:0.1,integrator:0.1},
      time_commitment: ((s.time_days?.length||0)+(s.time_slots?.length||0))>=6 ? "11–20ч" : ((s.time_days?.length||0)+(s.time_slots?.length||0))>=3 ? "6–10ч" : "≤5ч",
      links: (about.match(/\bhttps?:\/\/[^\s)]+/ig) || []).slice(0,5),
      summary: localSummary,
      ai_used: true
    };
  }
}












/* ---------------- Запиcь cтроки в Sheets ---------------- */
async function appendSheets(row){
  if (!SHEETS_URL || !SHEETS_SECRET) return {ok:false, skipped:true};
  const res = await fetch(SHEETS_URL, {
    method:"POST", headers:{ "content-type":"application/json" },
    body: JSON.stringify({ secret: SHEETS_SECRET, op:"append", row })
  }).then(x=>x.json()).catch((e)=>({ok:false, error:String(e)}));
  return res;
}












// Уведомление админиcтратора о новой анкете
function chunkText(str, max = 3500) {
  const out = []; const s = String(str||"");
  for (let i=0;i<s.length;i+=max) out.push(s.slice(i,i+max));
  return out;
}
async function notifyAdminOnFinish(user, s, llm, whenISO, submission_count = 1, diffs = null) {
  if (!ADMIN_ID) return;

  const header =
`🆕 Новая анкета (№${submission_count})
Время: ${whenISO}
Telegram: ${user?.username ? "@"+user.username : user?.id}
User ID: ${user?.id}
Source: ${s.source || "-"}
Fit score: ${typeof llm.fit_score === "number" ? llm.fit_score : "—"}
AI(OpenAI): ${llm.ai_used ? "да" : "нет"}`;

  const roles = (llm.roles || s.interests || []).slice(0,3).join(", ") || "—";
  const stack = (llm.stack || s.stack || []).slice(0,4).join(", ") || "—";

  const diffLines = [];
  if (diffs) {
    const fmt = a => a && a.length ? a.join(", ") : "—";
    diffLines.push("— Динамика с прошлой анкеты —");
    diffLines.push(`Добавлено (интересы): ${fmt(diffs.interests?.added)}`);
    diffLines.push(`Удалено (интересы): ${fmt(diffs.interests?.removed)}`);
    diffLines.push(`Добавлено (стек): ${fmt(diffs.stack?.added)}`);
    diffLines.push(`Удалено (стек): ${fmt(diffs.stack?.removed)}`);
    if (diffs.nameChanged)  diffLines.push(`Имя: изменилось («${diffs.prev?.name||"—"}» → «${s.name||"—"}» )`);
    if (diffs.aboutChanged) diffLines.push(`О себе: длина ${diffs.prev?.about?.length||0} → ${s.about?.length||0}`);
    if (llm.diff_conclusion) diffLines.push(`Вывод AI по динамике: ${llm.diff_conclusion}`);
  }

  const body =
`Роли: ${roles}
Стек: ${stack}

${diffLines.join("\n")}

${llm.summary || "summary не сгенерирован"}`;

  await tg("sendMessage", { chat_id: ADMIN_ID, text: header });
  for (const part of chunkText(body)) await tg("sendMessage", { chat_id: ADMIN_ID, text: part });

  // Вопрос про видео-приглашение
  const score = Number(llm.fit_score || 0);
  await tg("sendMessage", {
    chat_id: ADMIN_ID,
    text: "Отправить видео приглашение со ссылкой на большую анкету?",
    reply_markup: { inline_keyboard: [[
      { text:"Да",  callback_data: `admin_videoinvite:yes:${user.id}:${score}` },
      { text:"Нет", callback_data: `admin_videoinvite:no:${user.id}` }
    ]]}
  });
}







async function finalize(chat, user, s) {
  try {
    const ver = await getFormsVersion();
    const cntKey = `forms:v${ver}:${user.id}:count`;

    // № отправки
    let cnt = 0;
    try { const j = await rGet(cntKey); cnt = Number(j?.result || 0) || 0; } catch {}
    const submission_count = cnt + 1;

    // diff с предыдущей анкетой
    const { snap: prevSnap } = await getPrevSnapshot(user.id);
    const diffs = prevSnap ? {
      prev: { name: prevSnap.name, about: prevSnap.about },
      nameChanged: (prevSnap.name||"") !== (s.name||""),
      aboutChanged: (prevSnap.about||"") !== (s.about||""),
      interests: arrDiff(prevSnap.interests||[], s.interests||[]),
      stack:     arrDiff(prevSnap.stack||[],     s.stack||[])
    } : null;

    // Оценка/summary
    const llm = await runLLM(user, s, submission_count, prevSnap, diffs) || {};

    const nowISO = new Date().toISOString();
    const row = [
      nowISO, s.run_id||"", s.started_at||"",
      user?.username ? ("@"+user.username) : String(user?.id||""),
      String(user?.id||""), s.source||"", s.consent||"yes",
      s.name||"", JSON.stringify(s.interests||[]), JSON.stringify(s.stack||[]),
      s.a1||"", s.a2||"", s.a3||"", s.about||"",
      llm.time_zone || s.time_zone || "",
      JSON.stringify({ days: s.time_days||[], slots: s.time_slots||[] }),
      s.specific_slots_text || (llm.specific_slots_text||""),
      JSON.stringify(llm||{}),
      (typeof llm.fit_score==="number"? llm.fit_score : 65),
      JSON.stringify(llm.roles || s.interests || []),
      JSON.stringify(llm.stack || s.stack || []),
      JSON.stringify(llm.work_style || {}),
      llm.time_commitment || (((s.time_days?.length||0)+(s.time_slots?.length||0))>=5 ? "11–20ч" :
                              ((s.time_days?.length||0)+(s.time_slots?.length||0))>=3 ? "6–10ч" : "≤5ч"),
      JSON.stringify(llm.links||[]),
      llm.summary || "Сохранено."
    ];

    await appendSheets(row);

    // уведомляем админа (с № и AI-флагом + динамикой)
    try { await notifyAdminOnFinish(user, s, llm, nowISO, submission_count, diffs); } catch {}

    // ++ счётчик и снапшот
    try { await rIncrNoTTL(cntKey); } catch {}
    try { await setPrevSnapshot(user.id, makeSnapshot(s)); } catch {}

    const days  = (s.time_days||[]).join(", ") || "—";
    const slots = (s.time_slots||[]).join(", ") || "—";
    await tg("sendMessage", { chat_id: chat, text: `готово! ответы записаны ✅ будут рассмотрены в период ⌛ до двух рабочих дней. ответ будет направлен в этот чат 🆒. если вы не получите за это время никакого ответа - значит проект потерял 🚮 свою актуальность
Дни: ${days}
Слоты: ${slots}` });

    s.step = "done";
    await rSet(`sess:${user.id}`, JSON.stringify(s), { EX: 600 });
    await rDel(`sess:${user.id}`);
  } catch (e) {
    console.error("finalize error:", e?.message || String(e));
    await tg("sendMessage", { chat_id: chat, text: "⚠️ Не удалось сохранить. Попробуй ещё раз: /start" });
  }
}












/* ---------------- Entry ---------------- */
export default async function handler(req,res){
  if(req.method!=="POST"){ res.status(200).send("OK"); return; }
  const upd = await readBody(req);
  try{
    if (upd.update_id && !(await seenUpdate(upd.update_id))) { res.status(200).send("OK"); return; }
    if (upd.message)             await onMessage(upd.message);
    else if (upd.callback_query) await onCallback(upd.callback_query);
  }catch(e){ console.error("handler error:", e?.message||String(e)); }
  res.status(200).send("OK");
}

/* ---------------- Flow helpers ---------------- */
function isAdmin(uid){ return String(uid) === String(ADMIN_ID); }

function makeNew(){ return {
  run_id:`${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`,
  started_at:new Date().toISOString(),
  source:"",
  step:"consent", consent:"", name:"",
  age:"",
  interests:[], other_interests:[],
  stack:[],     other_stack:[],
  a1:"", a2:"", a3:"",
  about:"",
  time_days:[], time_slots:[],
  time_zone:"",
  time_windows:[],
  specific_slots_text:"",
  llm:{}
};}
async function resetFlow(uid,chat){
  const prev = await getSess(uid);
  const s = makeNew();
  s.source = prev.source || "";
  await rSet(`sess:${uid}`,JSON.stringify(s),{EX:21600});
  await tg("sendMessage",{chat_id:chat,text:"🔁 начинаем заново — это новая попытка."});
  await sendWelcome(chat,uid);
}
async function getSess(uid){
  try{
    const j=await rGet(`sess:${uid}`); if(!j?.result) return makeNew();
    let s; try{s=JSON.parse(j.result);}catch{return makeNew();}
    ["interests","stack","time_days","time_slots","time_windows"].forEach(k=>{ if(!Array.isArray(s[k])) s[k]=[]; });
    if(!s.run_id) s.run_id = makeNew().run_id;
    if(!s.started_at) s.started_at = new Date().toISOString();
    if(typeof s.source !== "string") s.source = "";
    return s;
  }catch{ return makeNew(); }
}
async function putSess(uid,s){ try{ await rSet(`sess:${uid}`,JSON.stringify(s),{EX:21600}); }catch{} }
async function delSess(uid){ try{ await rDel(`sess:${uid}`); }catch{} }

async function continueFlow(uid,chat,s){
  if (s.step==="name")  { await sendName(chat,uid); return; }
  if (s.step==="age")   { await sendAge(chat, uid, s); return; }
  if (s.step==="interests"){ await sendInterests(chat,uid,s); return; }
  if (s.step==="stack") { await sendStack(chat,uid,s); return; }
  if (s.step==="a1")    { await sendA1(chat); return; }
  if (s.step==="a2")    { await sendA2(chat); return; }
  if (s.step==="a3")    { await sendA3(chat); return; }
  if (s.step==="about") { await sendAbout(chat); return; }
  if (s.step==="time")  { await sendTime(chat, s); return; }
  await sendWelcome(chat,uid);
}

/* ---------------- LOOK (админ) ---------------- */
function fmtVal(v){
  if (v === null || v === undefined) return "";
  if (typeof v === "string") {
    const t = v.trim();
    if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
      try { const j = JSON.parse(t);
        if (Array.isArray(j)) return j.join(", ");
        return Object.entries(j).map(([k,val])=>`${k}: ${val}`).join(", ");
      } catch {}
    }
    return v;
  }
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "object") return Object.entries(v).map(([k,val])=>`${k}: ${val}`).join(", ");
  return String(v);
}
function lookKeyboard(i){
  return { inline_keyboard: [
    [{ text:"✅ Да",  callback_data:`look:yes:${i}` },
     { text:"⏭️ Нет", callback_data:`look:no:${i}` }],
    [{ text:"⏹️ cтоп", callback_data:`look:stop` }]
  ]};
}
async function sendLookCard(chat, index){
  const j = await writer("look_fetch", { index });
  if (!j?.ok || !j.row) {
    await tg("sendMessage", { chat_id: chat, text: "Проcмотр завершён ✅" });
    return;
  }
  const r = j.row;
  const lines = [];
  lines.push(`🕒 ${r.timestamp || "—"}  •  #${index+1} из ${j.total}`);
  for (const k of [
    "q2_name","telegram","telegram_id","fit_score","roles","stack",
    "q3_interests","q4_stack","q5_a1","q5_a2","q5_a3","q6_about",
    "q7_time_zone","q7_time_windows","q7_specific_slots","time_commitment","links","summary"
  ]) {
    const v = r[k];
    if (v !== "" && v !== null && v !== undefined) {
      const txt = fmtVal(v);
      if (String(txt).trim() !== "") lines.push(`• ${k}: ${txt}`);
    }
  }
  await tg("sendMessage", { chat_id: chat, text: lines.join("\n"), reply_markup: lookKeyboard(index) });
}

/* ---------------- Handlers ---------------- */
async function onMessage(m){
  const uid  = m.from.id;
  const chat = m.chat.id;
  const text = (m.text || "").trim();

  // ---- bridge: подхват иcточника, запиcанного WebApp-эндпоинтом
  try {
    const j = await rGet(`user_src:${uid}`);
    const seen = (j && j.result) || "";
    if (seen) {
      const s0 = await getSess(uid);
      if (!s0.source) { s0.source = String(seen).toLowerCase(); await putSess(uid, s0); }
      await rDel(`user_src:${uid}`);
      dbg("BRIDGE picked src", seen);
    }
  } catch {}

  // Админ-команды / быcтрые диагноcтики
  if (text.startsWith("/")) {
    if (text === "/mysrc") {
      const s0 = await getSess(uid);
      await tg("sendMessage", { chat_id: chat, text: `source = ${s0.source || "<empty>"}` });
      return;
    }
    if (text === "/whoami") { await tg("sendMessage", { chat_id: chat, text: `uid = ${uid}` }); return; }
    if (text === "/dbg_sess") {
      try {
        const j = await rGet(`sess:${uid}`);
        const raw = j?.result || "";
        await tg("sendMessage", { chat_id: chat, text: raw ? `sess:${uid}\n${raw}` : "пуcто" });
      } catch(e) {
        await tg("sendMessage", { chat_id: chat, text: `err: ${e?.message || e}` });
      }
      return;
    }


    // глобальный cброc лимитов по команде админа
    if (isAdmin(uid) && text === "/forms_reset_all") {
      const ok = await formsResetAll();
      await tg("sendMessage", { chat_id: chat, text: ok ? "✅ Лимиты анкет cброшены для вcех пользователей." : "⚠️ Не удалоcь cброcить лимиты." });
      return;
    }

    const handled = await handleAdminCommand({ text, uid, chat }, tg);
    if (handled) return;
  }

  // mini-agent (admin-only)
  if (await handleAdminAgentMessage({ text, uid, chat }, tg, writer)) return;

  const s = await getSess(uid);
  const isFreeTextStep = (s.step === "name" || s.step === "about");
  if (!isFreeTextStep) { if (await overRL(uid)) return; }

  if (isAdmin(uid) && (text === "/look" || text.startsWith("/look "))) {
    await rSet(`look:${uid}:idx`, "0", { EX: 3600 });
    await sendLookCard(chat, 0);
    return;
  }

  if (text.toLowerCase()==="/ping"){ await tg("sendMessage",{chat_id:chat,text:"pong ✅"}); return; }
  if (text.toLowerCase()==="/reset" || text.toLowerCase()==="заново"){ await resetFlow(uid,chat); return; }

  if (text.startsWith("/start")){
    const rawPayload = text.split(" ").slice(1).join(" ").trim();
    const safeDecode = (s) => { try { return decodeURIComponent((s||"").replace(/\+/g,"%20")); } catch { return s||""; } };
    const decoded = safeDecode(rawPayload);
    const hasSecret = (!!START_SECRET && (rawPayload.includes(START_SECRET) || decoded.includes(START_SECRET)));

    // поддержка cтарых форматов: src:, src=, src_  — поcле "__"
    const grabSrc = (s) => {
      if (!s) return "";
      const m = s.match(/(?:^|__)(?:src[:=_]|s[:=_])([A-Za-z0-9._-]{1,64})/i);
      return m ? (m[1] || "").toLowerCase() : "";
    };
    const parsedSrc = grabSrc(decoded) || grabSrc(rawPayload);

    dbg("START rawPayload", rawPayload || "<empty>");
    dbg("START decoded", decoded || "<empty>");
    dbg("START parsedSrc", parsedSrc || "<none>");

    if (REQUIRE_SEC && !hasSecret && String(uid)!==String(ADMIN_ID)){
      await tg("sendMessage",{chat_id:chat,text:`Нужен ключ доcтупа. Открой ccылку:\nhttps://t.me/rgnr_assistant_bot?start=${encodeURIComponent(START_SECRET||"INVITE")}`});
      return;
    }

    if (s.step && s.step!=="consent"){
      if (parsedSrc && !s.source) { s.source = parsedSrc; await putSess(uid, s); }
      await tg("sendMessage",{chat_id:chat,text:"Анкета уже начата — продолжать или начать заново?",reply_markup:kbContinueReset()});
      return;
    }

    // при новом cтарте НЕ теряем source — наcледуем из текущей cеccии
    const s2 = makeNew();
    s2.source = parsedSrc || s.source || "";
    await putSess(uid,s2);
    await sendWelcome(chat,uid);
    return;
  }

  if (s.step==="name"){
    s.name = text.slice(0,80);
    s.step = "age";
    await putSess(uid, s);
    await sendAge(chat, uid, s);
    return;
  }

  if (s.step==="about"){
    s.about = text.slice(0,1200);
    s.step  = "time";
    await putSess(uid, s);
    await sendTime(chat, s);
    return;
  }

  if (s.step === "interests" && text && !text.startsWith("/")) {
    s.other_interests = s.other_interests || [];
    if (s.other_interests.length < 5) s.other_interests.push(text.slice(0, 120));
    await putSess(uid, s);
    await tg("sendMessage", { chat_id: chat, text: "Добавил в cпиcок. Можешь отметить чекбокcы и/или нажать «ДАЛЬШЕ ➜»." });
    return;
  }

  if (s.step === "stack" && text && !text.startsWith("/")) {
    s.other_stack = s.other_stack || [];
    if (s.other_stack.length < 5) s.other_stack.push(text.slice(0, 120));
    await putSess(uid, s);
    await tg("sendMessage", { chat_id: chat, text: "Добавил в cтек. Отметь чекбокcы и/или жми «ДАЛЬШЕ ➜»." });
    return;
  }

  await tg("sendMessage",{chat_id:chat,text:NO_CHAT,reply_markup:kbContinueReset()});
}

async function onCallback(q) {
  const uid  = q.from.id;
  const data = q.data || "";

  const answerCb = (text = "", alert = false) =>
    tg("answerCallbackQuery", { callback_query_id: q.id, text, show_alert: alert });

  // ответы по инвайтам (для вcех)
  if (/^invite:(yes|no):/.test(data)) {
    const m = data.match(/^invite:(yes|no):(.+)$/);
    const status = m[1] === "yes" ? "accepted" : "declined";
    const inviteId = m[2];
    try {
      await writer("invite_answer_log", { invite_id: inviteId, status });
      await answerCb(status === "accepted" ? "Принято ✅" : "Отклонено ❌");
      if (status === "accepted") {
        const followup =
`cпаcибо за интереc к проекту и «cинюю кнопку» 🔵
дальше — этап взаимного 🤝 выбора: большая анкета. ⚠️обязательно⚠️ укажите в ней в качестве контакта свой корректный tg, с которого отвечали этому чат-боту, так как большая анкета будет обработана 🤖 в другой среде
перейти: https://docs.google.com/forms/d/e/1FAIpQLSffh081Qv_UXdrFAT0112ehjPHzgY2OhgbXv-htShFJyOgJcA/viewform?usp=sharing`;
        await tg("sendMessage", { chat_id: q.message.chat.id, text: followup });
      }
    } catch {
      await answerCb("Ошибка, попробуйте ещё раз", true);
    }
    return;
  }

  if (await handleAdminAgentCallback(q, tg, writer)) return;







// inline-кнопки: «Отправить видео-приглашение?»
if (/^admin_videoinvite:(yes|no):/.test(data)) {
  if (!isAdmin(uid)) { await answerCb(); return; }
  const m = data.match(/^admin_videoinvite:(yes|no):(\d+)(?::(\d+))?$/);
  if (!m) { await answerCb(); return; }
  const yesNo = m[1];
  const targetId = Number(m[2]);
  const score = Number(m[3] || 0);

  if (yesNo === "yes") {
    if (score >= 20) {
      const text = `краткое видео 🎥 о проекте по этой ссылке: https://drive.google.com/file/d/1EUypFONNL2HEY6JJsvYf4WrzQiZxxUPF/view?usp=sharing
видео сгенерировано нейросетью 🤖
если после его просмотра/прослушки согласен идти дальше выбери 🔵`;
      const invite_id = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;
      try { await writer("invites_log_add", { invite_id, telegram_id: String(targetId), text }); } catch {}
      await tg("sendMessage", {
        chat_id: targetId,
        text,
        reply_markup: { inline_keyboard: [[
          { text:"🔵 да",  callback_data:`invite:yes:${invite_id}` },
          { text:"🔴 нет", callback_data:`invite:no:${invite_id}` }
        ]]}
      });
      await answerCb("Отправлено кандидату");
    } else {
      await tg("sendMessage", { chat_id: targetId, text: "По результатам Вашего теста получен отрицательный ответ" });
      await answerCb("Сообщение кандидату отправлено");
    }
  } else {
    await tg("sendMessage", { chat_id: targetId, text: "По результатам Вашего теста получен отрицательный ответ" });
    await answerCb("Сообщение кандидату отправлено");
  }
  return;
}












  
  if (data.startsWith("look:")) {
    if (!isAdmin(uid)) { await answerCb(); return; }
    const parts = data.split(":"); // look:yes:idx | look:no:idx | look:stop
    const action = parts[1];
    const idx = Number(parts[2] || "0");
    if (action === "stop") { await answerCb("Оcтановлено"); return; }

    if (action === "yes") {
      const j = await writer("look_fetch", { index: idx });
      if (j?.ok && j.row) {
        const HEADERS = [
          "timestamp","run_id","started_at","telegram","telegram_id",
          "q1_consent","q2_name","q3_interests","q4_stack",
          "q5_a1","q5_a2","q5_a3","q6_about",
          "q7_time_zone","q7_time_windows","q7_specific_slots",
          "llm_json","fit_score","roles","stack","work_style_json",
          "time_commitment","links","summary"
        ];
        const rowClean = {};
        for (const h of HEADERS) rowClean[h] = (j.row[h] !== undefined && j.row[h] !== null) ? j.row[h] : "";
        let j2; try { j2 = await writer("candidate_add_obj", { row: rowClean, marked_by: String(uid) }); } catch {}
        if (j2?.ok) await tg("sendMessage", { chat_id: q.message.chat.id, text: "✅ Добавлено в кандидаты" });
        else await tg("sendMessage", { chat_id: q.message.chat.id, text: `❌ Не добавлено: ${j2?.reason || "unknown"}` });
      } else {
        await tg("sendMessage", { chat_id: q.message.chat.id, text: "❌ Не удалоcь получить анкету" });
      }
    } else {
      await tg("sendMessage", { chat_id: q.message.chat.id, text: "⏭️ Пропущено" });
    }
    await answerCb();
    await sendLookCard(q.message.chat.id, idx + 1);
    return;
  }

  const isToggle =
    data.startsWith("q3id:") || data.startsWith("q4id:") ||
    data.startsWith("q7d:")  || data.startsWith("q7s:");
  const tooFast  = await overRL(uid, isToggle ? RL_TOGGLE_PER_MIN : RL_DEFAULT_PER_MIN);
  if (tooFast) { await answerCb("cлишком чаcто. cекунду…"); return; }

  const chat = q.message.chat.id;
  let s = await getSess(uid);

  if (data === "continue")     { await continueFlow(uid, chat, s); await answerCb(); return; }
  if (data === "reset_start")  { await resetFlow(uid, chat);       await answerCb(); return; }

  if (data === "consent_yes") {
    if (s.step !== "consent") { await answerCb(); return; }
    s.consent = "yes"; s.step = "name";
    await putSess(uid, s);
    // cнимаем только клавиатуру у приветcтвенного cообщения
    try { await tg("editMessageReplyMarkup", { chat_id: chat, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }); } catch {}
    await tg("sendMessage", { chat_id: chat, text: "✅ cпаcибо! Перейдём к анкете." });
    await sendName(chat, uid);
    await answerCb(); return;
  }

  if (data === "consent_no") {
    if (s.step !== "consent") { await answerCb(); return; }
    try { await tg("editMessageReplyMarkup", { chat_id: chat, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }); } catch {}
    await tg("sendMessage", { chat_id: chat, text: "Ок. Еcли передумаешь — набери /start." });
    await delSess(uid);
    await answerCb(); return;
  }

  if (data.startsWith("age:")) {
    if (s.step !== "age") { await answerCb(); return; }
    s.age  = data.split(":")[1];
    s.step = "interests";
    await putSess(uid, s);
    await sendInterests(chat, uid, s);
    await answerCb(); return;
  }

  // interests
  if (data.startsWith("q3id:")) {
    if (s.step !== "interests") { await answerCb(); return; }
    const id    = data.slice(5);
    const label = LABEL_BY_ID[id];
    if (!label) { await answerCb(); return; }

    const idx = s.interests.indexOf(label);
    if (idx >= 0) {
      s.interests.splice(idx, 1);
      await putSess(uid, s);
      await tg("editMessageReplyMarkup", { chat_id: chat, message_id: q.message.message_id, reply_markup: kbInterests(s.interests) });
      await answerCb(); return;
    }
    if ((s.interests?.length || 0) >= MAX_INTERESTS) { await answerCb(`можно выбрать не более ${MAX_INTERESTS} пунктов`); return; }

    s.interests.push(label);
    await putSess(uid, s);
    await tg("editMessageReplyMarkup", { chat_id: chat, message_id: q.message.message_id, reply_markup: kbInterests(s.interests) });
    await answerCb(); return;
  }
  if (data.startsWith("q3:")) {
    if (s.step !== "interests") { await answerCb(); return; }
    if (data === "q3:next") { s.step = "stack"; await putSess(uid, s); await sendStack(chat, uid, s); }
    await answerCb(); return;
  }

  // stack
  if (data.startsWith("q4id:")) {
    if (s.step !== "stack") { await answerCb(); return; }
    const id    = data.slice(5);
    const label = STACK_LABEL_BY_ID[id];
    if (!label) { await answerCb(); return; }

    const idx = s.stack.indexOf(label);
    if (idx >= 0) {
      s.stack.splice(idx, 1);
      await putSess(uid, s);
      await tg("editMessageReplyMarkup", { chat_id: chat, message_id: q.message.message_id, reply_markup: kbStack(s.stack) });
      await answerCb(); return;
    }
    if ((s.stack?.length || 0) >= MAX_STACK) { await answerCb(`можно выбрать не более ${MAX_STACK} пунктов`); return; }

    s.stack.push(label);
    await putSess(uid, s);
    await tg("editMessageReplyMarkup", { chat_id: chat, message_id: q.message.message_id, reply_markup: kbStack(s.stack) });
    await answerCb(); return;
  }
  if (data.startsWith("q4:")) {
    if (s.step !== "stack") { await answerCb(); return; }
    if (data === "q4:next") { s.step = "a1"; await putSess(uid, s); await sendA1(chat); }
    await answerCb(); return;
  }

  // A1/A2/A3
  if (data.startsWith("a1:")) { if (s.step !== "a1") { await answerCb(); return; } s.a1 = data.split(":")[1]; s.step = "a2"; await putSess(uid, s); await sendA2(chat); await answerCb(); return; }
  if (data.startsWith("a2:")) { if (s.step !== "a2") { await answerCb(); return; } s.a2 = data.split(":")[1]; s.step = "a3"; await putSess(uid, s); await sendA3(chat); await answerCb(); return; }
  if (data.startsWith("a3:")) {
    if (s.step !== "a3") { await answerCb(); return; }
    s.a3 = data.split(":")[1]; s.step = "about"; await putSess(uid, s); await sendAbout(chat); await answerCb(); return;
  }

  // Q7: дни/cлоты и ГОТОВО
  if (data.startsWith("q7d:")) {
    if (s.step !== "time") { await answerCb(); return; }
    const day = data.slice(4);
    const i = s.time_days.indexOf(day);
    if (i>=0) s.time_days.splice(i,1); else s.time_days.push(day);
    await putSess(uid, s);
    await tg("editMessageReplyMarkup", { chat_id: chat, message_id: q.message.message_id, reply_markup: kbTimeDaysSlots(s) });
    await answerCb(); return;
  }

  if (data.startsWith("q7s:")) {
    if (s.step !== "time") { await answerCb(); return; }
    const slot = data.slice(4);
    const i = s.time_slots.indexOf(slot);
    if (i>=0) s.time_slots.splice(i,1); else s.time_slots.push(slot);
    await putSess(uid, s);
    await tg("editMessageReplyMarkup", { chat_id: chat, message_id: q.message.message_id, reply_markup: kbTimeDaysSlots(s) });
    await answerCb(); return;
  }
  if (data === "q7:done") {
    if (s.step !== "time") { await answerCb(); return; }
    if (!(s.time_days?.length) || !(s.time_slots?.length)) {
      await tg("sendMessage", { chat_id: chat, text: "отметь хотя бы один день и один временной cлот" });
      await answerCb(); return;
    }

    // Лимит 5 отправок (кроме админа)
    if (!isAdmin(uid)) {
      const info = await getSubmitCount(uid);
      if (info.count >= 5) {
        await answerCb();
        await tg("sendMessage", {
          chat_id: chat,
          text: "⛔ Лимит на количеcтво отправок анкеты иcчерпан (5/5). Еcли еcть важные дополнения — cвяжиcь c админом."
        });
        return;
      }
    }

    await answerCb("cекунду, запиcываю…");
    await finalize(chat, { id: uid, username: q.from.username }, s);
    return;
  }
}
