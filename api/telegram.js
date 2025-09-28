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

// ---- DEBUG ----
const DEBUG_TELEGRAM = /^1|true$/i.test(process.env.DEBUG_TELEGRAM || "");
function dbg(label, payload) {
  try {
    const msg = `[DBG] ${label}: ` + (typeof payload === "string" ? payload : JSON.stringify(payload));
    console.log(msg);
    if (DEBUG_TELEGRAM && ADMIN_ID) {
      tg("sendMessage", { chat_id: ADMIN_ID, text: msg.slice(0, 3800) }).catch(()=>{});
    }
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
async function seenUpdate(id){ try{ const j=await rSet(`upd:${id}`,"1",{EX:180,NX:true}); return j&&("result"in j)? j.result==="OK" : true; }catch{return true;} }
async function overRL(uid,limit=12){ try{return (await rIncr(`rl:${uid}`,60))>limit;}catch{return false;} }

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

/* ---------------- LLM (локальная оценка + опционально OpenAI) ---------------- */
function nameRealismScore(name) {
  const n = (name||"").trim();
  if (!n) return 0;
  if (n.length < 2 || n.length > 80) return 10;
  if (/^[a-zA-Zа-яА-ЯёЁ\-\'\s]+$/.test(n) === false) return 20;
  let score = 70;
  if (/\s/.test(n)) score += 15;
  if (/^[А-ЯЁA-Z][а-яёa-z]+(?:\s+[А-ЯЁA-Z][а-яёa-z]+)+$/.test(n)) score += 10;
  return Math.min(score, 95);
}
function aboutQualityScore(about) {
  const t = (about||"").trim();
  if (!t) return 0;
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





async function runLLM(u, s, submission_count){
  // ---------- подготовим сигналы (для модели это "подсказки", не финальный балл)
  const name = (s.name || "").trim();
  const about = (s.about || "").trim();
  const interests = (s.interests || []).slice(0, 12);
  const stack = (s.stack || []).slice(0, 12);

  function scoreName(n){
    const issues = [];
    let sc = 85;
    if (!n) { issues.push("не указано имя"); sc = 0; }
    if (n && !/^[a-zA-Zа-яА-ЯёЁ][a-zA-Zа-яА-ЯёЁ .'\-]{1,79}$/.test(n)) { sc -= 25; issues.push("подозрительные символы/формат"); }
    if (n && !/\s/.test(n)) { sc -= 10; issues.push("одно слово — нет фамилии"); }
    if (n && /[0-9_]/.test(n)) { sc -= 15; issues.push("цифры/символы в имени"); }
    if (n && /^(test|anon|user|qwe|asdf|тест)/i.test(n)) { sc -= 35; issues.push("похоже на псевдоним/тест"); }
    return { score: Math.max(0, Math.min(95, sc)), issues };
  }
  function scoreAbout(t){
    const issues=[], positives=[];
    let sc = 50;
    const len = t.length;
    if (len >= 400) sc += 15; else if (len >= 200) sc += 10; else if (len >= 100) sc += 5; else { sc -= 10; issues.push("слишком короткое описание"); }
    if (/[.!?]\s/.test(t)) sc += 5; else issues.push("мало предложений/пунктуации");
    const letters = (t.match(/[a-zа-яё]/ig) || []).length;
    const nonLetters = (t.match(/[^a-zа-яё0-9\s.,:;!?\-()]/ig) || []).length;
    const letterRatio = letters / Math.max(1, t.length);
    if (letterRatio < 0.65) { sc -= 10; issues.push("много посторонних символов/смайлов"); }
    if (/(?:asdf|qwer|йцук|ячсм|лол|кек){2,}/i.test(t)) { sc -= 15; issues.push("похоже на случайный набор"); }
    const links = (t.match(/\bhttps?:\/\/[^\s)]+/ig) || []).slice(0, 5);
    if (links.length) { sc += 5; positives.push("есть ссылки на работы/профили"); }
    return { score: Math.max(0, Math.min(95, sc)), issues, positives, links };
  }
  function scoreConsistency(t, ints, stk){
    const text = t.toLowerCase();
    const tokens = new Set(text.split(/[^a-zа-яё0-9+]+/i).filter(Boolean));
    const norm = (s)=> String(s||"").toLowerCase().replace(/[^\w+]+/g," ").split(/\s+/).filter(Boolean);
    const intsWords = ints.flatMap(norm);
    const stkWords  = stk.flatMap(norm);
    const hitInt = intsWords.filter(w => tokens.has(w)).length;
    const hitStk = stkWords.filter(w => tokens.has(w)).length;
    let sc = 50;
    const issues=[], positives=[];
    if (ints.length && hitInt===0) { sc -= 10; issues.push("в «о себе» нет подтверждения интересов"); }
    if (stk.length  && hitStk===0) { sc -= 10; issues.push("в «о себе» нет подтверждения стека"); }
    if (hitInt>0)  positives.push("есть пересечение с интересами");
    if (hitStk>0)  positives.push("есть пересечение со стеком");
    sc += Math.min(20, hitInt*2 + hitStk*2);
    return { score: Math.max(0, Math.min(95, sc)), issues, positives };
  }
  const rName  = scoreName(name);
  const rAbout = scoreAbout(about);
  const rCons  = scoreConsistency(about, interests, stack);
  const repeatsPenalty = Math.min(35, Math.max(0, (submission_count-1) * 7)); // −7 за каждую повторную попытку

  // производные поля для подсказки модели
  const workStyle = { builder:0.5, architect:0.2, researcher:0.1, operator:0.1, integrator:0.1 };
  switch (s.a1) {
    case "быстро прототипирую": workStyle.builder+=0.2; break;
    case "проектирую основательно": workStyle.architect+=0.2; break;
    case "исследую гипотезы": workStyle.researcher+=0.2; break;
    case "синхронизирую людей": workStyle.integrator+=0.2; break;
  }
  if (s.a2 === "MVP важнее идеала") workStyle.builder+=0.1;
  if (s.a2 === "полирую до совершенства") workStyle.architect+=0.1;
  if (s.a3 === "риск/скорость") workStyle.builder+=0.1;
  if (s.a3 === "надёжность/предсказуемость") workStyle.operator+=0.1;
  Object.keys(workStyle).forEach(k=> workStyle[k]= Number(Math.max(0, Math.min(1, workStyle[k])).toFixed(2)));

  const slotsCount = (s.time_days?.length || 0) + (s.time_slots?.length || 0);
  const timeCommitmentHeur = slotsCount>=6 ? "11–20ч" : slotsCount>=3 ? "6–10ч" : "≤5ч";

  // --------- если нет ключа — локальная сводка (страховка)
  function localFallback(){
    const positives = [...(rAbout.positives||[]), ...(rCons.positives||[])];
    const issues = [...rName.issues, ...rAbout.issues, ...rCons.issues];
    if (repeatsPenalty>0) issues.push(`повторные заполнения: ${submission_count-1} (штраф ${repeatsPenalty})`);
    const base = Math.round(rName.score*0.25 + rAbout.score*0.45 + rCons.score*0.30);
    const finalScore = Math.max(0, Math.min(100, base - repeatsPenalty));
    const bucket = finalScore>=80 ? "сильный кандидат" : finalScore>=65 ? "хороший кандидат" : finalScore>=50 ? "пограничный" : "слабый";
    const summary =
`Итоговый балл: ${finalScore}/100 (${bucket}).

Плюсы:
${positives.length? positives.map(p=>"• "+p).join("\n"):"• явных плюсов нет"}

Минусы/риски:
${issues.length? issues.map(p=>"• "+p).join("\n"):"• критичных нет"}

Рекомендации:
• Развернуть «о себе» до 150–300+ символов, привести конкретные результаты и ссылки.
• Согласовать «о себе» с отмеченными интересами и стеком (минимум 2–3 совпадения).
• Проверить орфографию и пунктуацию.
• Не отправлять множество повторных анкет без правок.`;
    return {
      fit_score: finalScore,
      roles: interests.slice(0,6),
      stack: stack.slice(0,8),
      work_style: workStyle,
      time_commitment: timeCommitmentHeur,
      links: rAbout.links || [],
      summary
    };
  }
  if (!OPENAI_API_KEY) return localFallback();

  // ---------- AI — главный оценщик
  try {
    const SYSTEM =
`Ты опытный технический рекрутер. Пиши по-русски.
Задача: взвесить качество анкеты и выдать детальную сводку и рекомендации.
Жёсткие правила:
- Верни СТРОГО JSON.
- "fit_score" — целое 0..100. 0 — мусор/противоречия/спам; 100 — безупречно.
- Учитывай: реалистичность имени, орфография/пунктуация "о себе", структура текста, согласованность "о себе" с интересами/стеком, противоречия/хаотичность, повторные попытки (штраф).
- В "summary" дай 3–6 абзацев: факторы, плюсы, риски, рекомендации и итоговую строку "Итоговый балл: X/100 (<категория>)".
Схема JSON:
{
  "fit_score": 0..100,
  "breakdown": { "name":0..95, "about":0..95, "spelling":0..95, "consistency":0..95, "repeats_penalty":0..35 },
  "strengths": ["..."],
  "risks": ["..."],
  "recommendations": ["..."],
  "roles": ["..."],           // предполагаемые роли/направления
  "stack": ["..."],           // предполагаемый стек
  "work_style": {"builder":0..1,"architect":0..1,"researcher":0..1,"operator":0..1,"integrator":0..1},
  "time_commitment": "≤5ч|6–10ч|11–20ч|>20ч",
  "links": ["..."],
  "summary": "..."
}`;

    const USER = JSON.stringify({
      raw: {
        name,
        about,
        interests,
        stack,
        a1: s.a1, a2: s.a2, a3: s.a3,
        time_days: s.time_days || [],
        time_slots: s.time_slots || [],
        submission_count
      },
      signals: {
        name: rName, about: { ...rAbout, links: undefined }, consistency: rCons,
        repeats_penalty: repeatsPenalty,
        heuristics: { workStyle, timeCommitmentHeur, links: rAbout.links || [] }
      }
    }, null, 2);

    const body = {
      model: OPENAI_MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user",   content: USER   }
      ]
    };

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type":"application/json", "authorization":"Bearer "+OPENAI_API_KEY },
      body: JSON.stringify(body)
    }).then(x=>x.json()).catch(()=>null);

    const parsed = JSON.parse(r?.choices?.[0]?.message?.content || "null");
    if (!parsed || typeof parsed.fit_score !== "number" || !parsed.summary) return localFallback();

    // санитизация + разумный дефолт, если каких-то полей нет
    return {
      fit_score: Math.max(0, Math.min(100, Math.round(parsed.fit_score))),
      roles: Array.isArray(parsed.roles) && parsed.roles.length ? parsed.roles.slice(0,6) : interests.slice(0,6),
      stack: Array.isArray(parsed.stack) && parsed.stack.length ? parsed.stack.slice(0,8) : stack.slice(0,8),
      work_style: typeof parsed.work_style==="object" ? parsed.work_style : workStyle,
      time_commitment: parsed.time_commitment || timeCommitmentHeur,
      links: Array.isArray(parsed.links) ? parsed.links.slice(0,5) : (rAbout.links || []),
      summary: String(parsed.summary).slice(0, 4000)
    };
  } catch {
    return localFallback();
  }
}




/* ---------------- Запись строки в Sheets ---------------- */
async function appendSheets(row){
  if (!SHEETS_URL || !SHEETS_SECRET) return {ok:false, skipped:true};
  const res = await fetch(SHEETS_URL, {
    method:"POST", headers:{ "content-type":"application/json" },
    body: JSON.stringify({ secret: SHEETS_SECRET, op:"append", row })
  }).then(x=>x.json()).catch((e)=>({ok:false, error:String(e)}));
  return res;
}

/* ---------------- Финализация анкеты ---------------- */
async function finalize(chat, user, s) {
  try {
    const cntKey = `forms:${user.id}:count`;
    let cnt = 0;
    try { const j = await rGet(cntKey); cnt = Number(j?.result || 0) || 0; } catch {}
    const submission_count = cnt + 1;

    const llm = await runLLM(user, s, submission_count) || {};

    // 25 полей; source — 6-я колонка
    const nowISO = new Date().toISOString();
    const row = [
      nowISO,
      s.run_id || "",
      s.started_at || "",
      user?.username ? ("@"+user.username) : String(user?.id || ""),
      String(user?.id || ""),
      s.source || "",
      s.consent || "yes",
      s.name || "",
      JSON.stringify(s.interests || []),
      JSON.stringify(s.stack || []),
      s.a1 || "",
      s.a2 || "",
      s.a3 || "",
      s.about || "",
      llm.time_zone || s.time_zone || "",
      JSON.stringify({ days: s.time_days || [], slots: s.time_slots || [] }),
      s.specific_slots_text || (llm.specific_slots_text || ""),
      JSON.stringify(llm || {}),
      typeof llm.fit_score === "number" ? llm.fit_score : 65,
      JSON.stringify(llm.roles || s.interests || []),
      JSON.stringify(llm.stack || s.stack || []),
      JSON.stringify(llm.work_style || {}),
      llm.time_commitment || (((s.time_days?.length||0)+(s.time_slots?.length||0))>=5 ? "11–20ч" : ((s.time_days?.length||0)+(s.time_slots?.length||0))>=3 ? "6–10ч" : "≤5ч"),
      JSON.stringify(llm.links || []),
      llm.summary || "Сохранено."
    ];

    dbg("APPEND row meta", { len: row.length, source: row[5] });
    const ans = await appendSheets(row);
    dbg("APPEND resp", ans);

    try { await rIncrNoTTL(cntKey); } catch {}

    const days  = (s.time_days||[]).join(", ") || "—";
    const slots = (s.time_slots||[]).join(", ") || "—";
    await tg("sendMessage", {
      chat_id: chat,
      text: `готово! анкета записана ✅
Дни: ${days}
Слоты: ${slots}`
    });

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
  const prev = await getSess(uid);         // сохраняем предыдущий source
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
      try {
        const j = JSON.parse(t);
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
    [{ text:"⏹️ Стоп", callback_data:`look:stop` }]
  ]};
}
async function sendLookCard(chat, index){
  const j = await writer("look_fetch", { index });
  if (!j?.ok || !j.row) {
    await tg("sendMessage", { chat_id: chat, text: "Просмотр завершён ✅" });
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

  // ---- bridge: подхват источника, записанного WebApp-эндпоинтом
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

  // Админ-команды / быстрые диагностики
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
        await tg("sendMessage", { chat_id: chat, text: raw ? `sess:${uid}\n\`\`\`\n${raw}\n\`\`\`` : "пусто", parse_mode: "Markdown" });
      } catch(e) { await tg("sendMessage", { chat_id: chat, text: `err: ${e?.message || e}` }); }
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

    // поддержка старых форматов: src:, src=, src_  — после "__"
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
      await tg("sendMessage",{chat_id:chat,text:`Нужен ключ доступа. Открой ссылку:\nhttps://t.me/rgnr_assistant_bot?start=${encodeURIComponent(START_SECRET||"INVITE")}`});
      return;
    }

    if (s.step && s.step!=="consent"){
      if (parsedSrc && !s.source) { s.source = parsedSrc; await putSess(uid, s); }
      await tg("sendMessage",{chat_id:chat,text:"Анкета уже начата — продолжать или начать заново?",reply_markup:kbContinueReset()});
      return;
    }

    // при новом старте НЕ теряем source — наследуем из текущей сессии
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
    await tg("sendMessage", { chat_id: chat, text: "Добавил в список. Можешь отметить чекбоксы и/или нажать «ДАЛЬШЕ ➜»." });
    return;
  }

  if (s.step === "stack" && text && !text.startsWith("/")) {
    s.other_stack = s.other_stack || [];
    if (s.other_stack.length < 5) s.other_stack.push(text.slice(0, 120));
    await putSess(uid, s);
    await tg("sendMessage", { chat_id: chat, text: "Добавил в стек. Отметь чекбоксы и/или жми «ДАЛЬШЕ ➜»." });
    return;
  }

  await tg("sendMessage",{chat_id:chat,text:NO_CHAT,reply_markup:kbContinueReset()});
}

async function onCallback(q) {
  const uid  = q.from.id;
  const data = q.data || "";

  const answerCb = (text = "", alert = false) =>
    tg("answerCallbackQuery", { callback_query_id: q.id, text, show_alert: alert });

  // ответы по инвайтам (для всех)
  if (/^invite:(yes|no):/.test(data)) {
    const m = data.match(/^invite:(yes|no):(.+)$/);
    const status = m[1] === "yes" ? "accepted" : "declined";
    const inviteId = m[2];
    try {
      await writer("invite_answer_log", { invite_id: inviteId, status });
      await answerCb(status === "accepted" ? "Принято ✅" : "Отклонено ❌");
      if (status === "accepted") {
        const followup =
`спасибо за интерес к проекту и «синюю кнопку».
дальше — этап взаимного выбора: большая анкета.
перейти: https://docs.google.com/forms/d/e/1FAIpQLSffh081Qv_UXdrFAT0112ehjPHzgY2OhgbXv-htShFJyOgJcA/viewform?usp=sharing`;
        await tg("sendMessage", { chat_id: q.message.chat.id, text: followup });
      }
    } catch {
      await answerCb("Ошибка, попробуйте ещё раз", true);
    }
    return;
  }

  if (await handleAdminAgentCallback(q, tg, writer)) return;

  if (data.startsWith("look:")) {
    if (!isAdmin(uid)) { await answerCb(); return; }
    const parts = data.split(":"); // look:yes:idx | look:no:idx | look:stop
    const action = parts[1];
    const idx = Number(parts[2] || "0");
    if (action === "stop") { await answerCb("Остановлено"); return; }

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
        await tg("sendMessage", { chat_id: q.message.chat.id, text: "❌ Не удалось получить анкету" });
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
  if (tooFast) { await answerCb("Слишком часто. Секунду…"); return; }

  const chat = q.message.chat.id;
  let s = await getSess(uid);

  if (data === "continue")     { await continueFlow(uid, chat, s); await answerCb(); return; }
  if (data === "reset_start")  { await resetFlow(uid, chat);       await answerCb(); return; }

  if (data === "consent_yes") {
    if (s.step !== "consent") { await answerCb(); return; }
    s.consent = "yes"; s.step = "name";
    await putSess(uid, s);
    // 1) снимаем только клавиатуру у приветственного сообщения
    try {
      await tg("editMessageReplyMarkup", {
        chat_id: chat,
        message_id: q.message.message_id,
        reply_markup: { inline_keyboard: [] }
      });
    } catch {}
    // 2) отправляем отдельное подтверждение
    await tg("sendMessage", { chat_id: chat, text: "✅ Спасибо! Перейдём к анкете." });
    await sendName(chat, uid);
    await answerCb();
    return;
  }

if (data === "consent_no") {
  if (s.step !== "consent") { await answerCb(); return; }
  // 1) снимаем клавиатуру у приветственного сообщения
  try {
    await tg("editMessageReplyMarkup", {
      chat_id: chat,
      message_id: q.message.message_id,
      reply_markup: { inline_keyboard: [] }
    });
  } catch {}
  // 2) отдельным сообщением — отказ
  await tg("sendMessage", { chat_id: chat, text: "Ок. Если передумаешь — набери /start." });
  await delSess(uid);
  await answerCb();
  return;
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

  // Q7: дни/слоты и ГОТОВО
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
      await tg("sendMessage", { chat_id: chat, text: "отметь хотя бы один день и один временной слот" });
      await answerCb(); return;
    }
    await answerCb("Секунду, записываю…");
    await finalize(chat, { id: uid, username: q.from.username }, s);
    return;
  }
}
