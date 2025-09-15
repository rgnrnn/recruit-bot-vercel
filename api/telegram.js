// api/telegram.js — Telegram webhook (Vercel, Node 20, ESM)
// Полный поток: Q1 consent -> Q2 name -> Age -> Q4 interests (multi) -> Q5 stack (multi)
// -> A1/A2/A3 -> about (text) -> time (days + slots) -> FINAL (LLM + Sheets)

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

// --- Q3 Age ---
const AGE_OPTIONS = ["18–20","21–23","24–26","27–29","30–33","34–37","более 38"];

// --- Q4 Interests (ID + labels) ---
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
  ["i_backend", "i_frontend"],
  ["i_graph", "i_vector"],
  ["i_data_etl", "i_devops"],
  ["i_product", "i_integr"],
  ["i_rag", "i_agents"],
  ["i_kg", "i_db_perf"],
  ["i_sec", "i_observ"],
  ["i_testing", "i_ux_ui"],
  ["i_cloud", "i_dist"],
];
const LABEL_BY_ID = Object.fromEntries(INTEREST_ITEMS.map(x => [x.id, x.label]));

// --- Q5 Stack (ID + labels) ---
const STACK_ITEMS = [
  { id: "s_py_fastapi",    label: "Python/FastAPI" },
  { id: "s_postgres",      label: "PostgreSQL/SQL" },
  { id: "s_neo4j",         label: "Neo4j" },
  { id: "s_pgvector",      label: "pgvector" },
  { id: "s_langchain",     label: "LangChain/LangGraph" },
  { id: "s_llm_apis",      label: "LLM APIs (OpenAI/Claude/etc.)" },
  { id: "s_react_ts",      label: "React/TypeScript" },
  { id: "s_node_nest",     label: "Node.js/NestJS" },
  { id: "s_docker_k8s_lin",label: "Docker/Kubernetes/Linux" },
  { id: "s_ci_cd",         label: "CI/CD (GitHub Actions/GitLab)" },
  { id: "s_kafka",         label: "Kafka/Redpanda" },
  { id: "s_redis_rabbit",  label: "Redis/RabbitMQ" },
  { id: "s_airflow_dbt",   label: "Airflow/dbt" },
  { id: "s_terraform",     label: "Terraform/Ansible" },
  { id: "s_nginx_traefik", label: "Nginx/Traefik" },
  { id: "s_observability", label: "Observability (Prometheus/Grafana/OTel)" },
  { id: "s_testing",       label: "Testing (pytest/Playwright)" },
  { id: "s_security",      label: "Security (SSO/RBAC/Secrets)" },
  { id: "s_cloud",         label: "Cloud (AWS/GCP)" },
  { id: "s_distributed",   label: "Distributed Systems (CQRS/Event Sourcing)" },
];
const STACK_PAIRS = [
  ["s_py_fastapi","s_postgres"],
  ["s_neo4j","s_pgvector"],
  ["s_langchain","s_llm_apis"],
  ["s_react_ts","s_node_nest"],
  ["s_docker_k8s_lin","s_ci_cd"],
  ["s_kafka","s_redis_rabbit"],
  ["s_airflow_dbt","s_terraform"],
  ["s_nginx_traефik","s_observability"],
  ["s_testing","s_security"],
  ["s_cloud","s_distributed"],
];
const STACK_LABEL_BY_ID = Object.fromEntries(STACK_ITEMS.map(x => [x.id, x.label]));

// резерв старых констант (не используются)
const A_INTERESTS = ["Backend","Graph/Neo4j","Vector/LLM","Frontend","DevOps/MLOps","Data/ETL","Product/Coordination"];
const A_STACK     = ["Python/FastAPI","PostgreSQL/SQL","Neo4j","pgvector","LangChain/LangGraph","React/TS","Docker/K8s/Linux","CI/GitHub"];
const A1 = ["быстро прототипирую","проектирую основательно","исследую гипотезы","синхронизирую людей"];
const A2 = ["MVP важнее идеала","полирую до совершенства"];
const A3 = ["риск/скорость","надёжность/предсказуемость"];
const TIME_WINDOWS = ["будни утро","будни день","будни вечер","выходные утро","выходные день","выходные вечер"]; // legacy only

// Лимиты мультивыбора
const MAX_INTERESTS = 7;
const MAX_STACK     = 7;

// Rate-limit для callback'ов
const RL_TOGGLE_PER_MIN  = 120; // q3id:/q4id:/q7d:/q7s:
const RL_DEFAULT_PER_MIN = 30;

// --- Q7: дни и слоты ---
const TIME_DAYS  = ["понедельник","вторник","среда","четверг"];
const TIME_SLOTS = ["11:00–13:00","13:00–15:00","15:00–16:00","17:00–19:00"];

/* ---------------- Redis ---------------- */
function rUrl(path){ if(!REDIS_BASE||!REDIS_TOKEN) throw new Error("Redis env missing"); return new URL(REDIS_BASE+path); }
async function rGET(path){ const r=await fetch(rUrl(path),{headers:{Authorization:`Bearer ${REDIS_TOKEN}`}}); return r.json(); }
async function rCall(path,qs){ const u=rUrl(path); if(qs) for(const[k,v]of Object.entries(qs)) u.searchParams.set(k,String(v)); const r=await fetch(u,{headers:{Authorization:`Bearer ${REDIS_TOKEN}`}}); return r.json(); }
const rSet=(k,v,qs)=> rCall(`/set/${encodeURIComponent(k)}/${encodeURIComponent(v)}`, qs);
const rGet=(k)=> rGET(`/get/${encodeURIComponent(k)}`);
const rDel=(k)=> rGET(`/del/${encodeURIComponent(k)}`);
const rIncr=async(k,ex=60)=>{ const j=await rGET(`/incr/${encodeURIComponent(k)}`); if(j.result===1) await rGET(`/expire/${encodeURIComponent(k)}/${ex}`); return j.result; };
async function seenUpdate(id){ try{ const j=await rSet(`upd:${id}`,"1",{EX:180,NX:true}); return j&&("result"in j)? j.result==="OK" : true; }catch{return true;} }
async function overRL(uid,limit=12){ try{return (await rIncr(`rl:${uid}`,60))>limit;}catch{return false;} }

/* ---------------- Session ---------------- */
function newRun(){
  return {
    run_id:`${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`,
    started_at:new Date().toISOString(),
    step:"consent", consent:"", name:"",
    age:"",
    interests:[],
    other_interests:[],
    stack:[],
    other_stack:[],
    a1:"", a2:"", a3:"",
    about:"",
    time_days:[],
    time_slots:[],
    time_zone:"",
    time_windows:[],
    specific_slots_text:"",
    llm:{}
  };
}
async function getSess(uid){
  try{
    const j=await rGet(`sess:${uid}`); if(!j?.result) return newRun();
    let s; try{s=JSON.parse(j.result);}catch{return newRun();}
    if(!Array.isArray(s.interests)) s.interests=[];
    if(!Array.isArray(s.stack)) s.stack=[];
    if(!Array.isArray(s.time_days)) s.time_days=[];
    if(!Array.isArray(s.time_slots)) s.time_slots=[];
    if(!Array.isArray(s.time_windows)) s.time_windows=[];
    if(!s.run_id) s.run_id = newRun().run_id;
    if(!s.started_at) s.started_at = new Date().toISOString();
    return s;
  }catch{ return newRun(); }
}
async function putSess(uid,s){ try{ await rSet(`sess:${uid}`,JSON.stringify(s),{EX:21600}); }catch{} }
async function delSess(uid){ try{ await rDel(`sess:${uid}`); }catch{} }

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

/* ---------------- Copy / Keyboards ---------------- */
const CONSENT_TEXT = `старт в команде со-основателей: партнерская доля, право голоса в архитектуре и темп, соответствующий уровню задач 🔥🤝
ядро продукта формируется сейчас — редкий шанс зайти в проект, который сшивает три мира 🧠✨
промышленный «операционный интеллект» меняет правила в работе с данными: от хаоса файлов и чатов — к системе, где решения рождаются за секунды, а не за недели 🏭⚙️⏱️
итог — платформа, которая ускоряет решения на порядки и может переобучать сам бизнес действовать умнее 📈⚡️
формат потенциального взаимодействия - доля и партнёрство: больше влияния, больше ответственности, быстрее рост 🤝📈🚀
`;

const kbConsent = () => ({
  inline_keyboard: [[
    { text: "✅ Согласен", callback_data: "consent_yes" },
    { text: "❌ Не сейчас", callback_data: "consent_no"  }
  ]]
});
const kbContinueReset = () => ({ inline_keyboard:[[ {text:"▶️ Продолжить",callback_data:"continue"}, {text:"🔁 Начать заново",callback_data:"reset_start"} ]]});
const kbName = () => ({ inline_keyboard: [[{ text: "🔁 Начать заново", callback_data: "reset_start" }]] });
const kbSingle = (prefix, opts)=>({ inline_keyboard: opts.map(o=>[{text:o,callback_data:`${prefix}:${o}`}]).concat([[{text:"🔁 Начать заново",callback_data:"reset_start"}]]) });

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
  rows.push([{ text: "🔁 Начать заново", callback_data: "reset_start" }]);
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
  rows.push([{ text: "🔁 Начать заново", callback_data: "reset_start" }]);
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
  rows.push([{ text: "🔁 Начать заново", callback_data: "reset_start" }]);
  return { inline_keyboard: rows };
}

/* ---------------- Screens ---------------- */
async function sendWelcome(chat, uid) {
  await tg("sendMessage", { chat_id: chat, text: CONSENT_TEXT, parse_mode: "HTML", reply_markup: kbConsent() });
}
async function sendName(chat, uid) {
  await tg("sendMessage", { chat_id: chat, text: "2) как к тебе обращаться? введи имя текстом", parse_mode: "HTML", reply_markup: kbName() });
}
async function sendAge(chat, uid, s) {
  await tg("sendMessage", { chat_id: chat, text: "3) укажи возраст:", parse_mode: "HTML", reply_markup: kbSingle("age", AGE_OPTIONS) });
}
async function sendInterests(chat, uid, s) {
  await tg("sendMessage", {
    chat_id: chat,
    text: "4) что реально драйвит в последние 12 месяцев?\nотметь 2–7 направлений (чекбоксы). можно дополнить своим вариантом обычным сообщением",
    parse_mode: "HTML",
    reply_markup: kbInterests(s.interests || [])
  });
}
async function sendStack(chat, uid, s){
  await tg("sendMessage", {
    chat_id: chat,
    text: "5) где тебе «можно доверить прод». \nотметь 2–7 пунктов (чекбоксы). свой инструмент можно дописать сообщением",
    parse_mode: "HTML",
    reply_markup: kbStack(s.stack || [])
  });
}
async function sendA1(chat){ await tg("sendMessage",{chat_id:chat,text:"6) что ближе по стилю? выбери вариант",reply_markup:kbSingle("a1",A1)}); }
async function sendA2(chat){ await tg("sendMessage",{chat_id:chat,text:"7) что важнее? выбери вариант",reply_markup:kbSingle("a2",A2)}); }
async function sendA3(chat){ await tg("sendMessage",{chat_id:chat,text:"8) что предпочитаешь? выбери вариант",reply_markup:kbSingle("a3",A3)}); }
async function sendAbout(chat){ await tg("sendMessage",{chat_id:chat,text:"9) несколько строк о себе. что ценного сделал(а) за год? 1–2 кейса, роли/стек, ссылка на гит/резюме/пет-проекты"}); }
async function sendTime(chat, sess){
  await tg("sendMessage",{
    chat_id: chat,
    text: "отметь дни и временные слоты, когда тебе удобно переговорить/встретиться (мультивыбор). затем нажми «ГОТОВО»",
    parse_mode: "HTML",
    reply_markup: kbTimeDaysSlots(sess)
  });
}

/* ---------------- Finalize ---------------- */
async function runLLM(u, s){
  const base = {
    name: s.name || String(u.id),
    telegram: s.name || String(u.id),
    roles_hint: s.interests,
    stack_hint: s.stack,
    work_style_raw: {a1:s.a1,a2:s.a2,a3:s.a3},
    about: s.about,
    time_zone: "",
    time_windows: { days: s.time_days, slots: s.time_slots },
    specific_slots_text: s.specific_slots_text
  };
  if (!OPENAI_API_KEY) {
    return {
      name: base.name, telegram: base.telegram,
      roles: (s.interests||[]).slice(0,2).map(x=>x.toLowerCase().includes("graph")?"graph":x.toLowerCase().includes("vector")?"vector":x.toLowerCase().includes("devops")?"devops":"backend"),
      stack: (s.stack||[]).slice(0,3),
      work_style: {builder:0.6,architect:0.2,researcher:0.1,operator:0.1,integrator:0.2},
      fit_score: 65,
      time_commitment: ((s.time_days?.length || 0) + (s.time_slots?.length || 0)) >= 5 ? "11–20ч" :
                       ((s.time_days?.length || 0) + (s.time_slots?.length || 0)) >= 3 ? "6–10ч" : "≤5ч",
      time_zone: "",
      time_windows: base.time_windows,
      specific_slots_text: s.specific_slots_text || "",
      links: [],
      summary: "Стабильный кандидат. Подходит на бэкенд/интеграции."
    };
  }
  const SYSTEM = [
    "Ты ассистент-рекрутер. Верни СТРОГО JSON по схеме:",
    '{ "name": str, "telegram": str, "roles": [...], "stack": [...],',
    '"work_style":{"builder":0-1,"architect":0-1,"researcher":0-1,"operator":0-1,"integrator":0-1},',
    '"fit_score":0-100,"time_commitment":"≤5ч"|"6–10ч"|"11–20ч"|">20ч","time_zone":str,',
    '"time_windows":["будни утро","будни день","будни вечер","выходные утро","выходные день","выходные вечер"],',
    '"specific_slots_text":str,"links":[str],"summary":"2–3 предложения" }',
    "Рубрика: роль/стек 35; вовлечённость 20; инициативность/ссылки 15; стиль-соответствие 10; широта 10; ясность 10.",
    "Психотипы: builder, architect, researcher, operator, integrator.",
    "Ответ только JSON."
  ].join("\n");
  const body = {
    model: OPENAI_MODEL, temperature: 0,
    response_format: { type:"json_object" },
    messages: [{role:"system",content:SYSTEM},{role:"user",content:JSON.stringify(base)}]
  };
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method:"POST", headers:{ "content-type":"application/json","authorization":"Bearer "+OPENAI_API_KEY }, body: JSON.stringify(body)
  }).then(x=>x.json()).catch(()=>null);
  try { return JSON.parse(r.choices[0].message.content); } catch { return null; }
}

async function appendSheets(row){
  if (!SHEETS_URL || !SHEETS_SECRET) return {ok:false, skipped:true};
  const res = await fetch(SHEETS_URL, {
    method:"POST", headers:{ "content-type":"application/json" },
    body: JSON.stringify({ secret: SHEETS_SECRET, op:"append", row })
  }).then(x=>x.json()).catch(()=>({ok:false}));
  return res;
}

async function cmdDigest(chat){
  if (!SHEETS_URL || !SHEETS_SECRET) { await tg("sendMessage",{chat_id:chat,text:"/digest недоступен: не настроен Sheets writer."}); return; }
  const j = await fetch(SHEETS_URL, {
    method:"POST", headers:{ "content-type":"application/json" },
    body: JSON.stringify({ secret: SHEETS_SECRET, op:"digest" })
  }).then(x=>x.json()).catch(()=>null);
  if (j?.ok && j.digest) await tg("sendMessage",{chat_id:chat,text:j.digest,parse_mode:"Markdown"});
  else await tg("sendMessage",{chat_id:chat,text:"/digest: нет данных или ошибка."});
}

async function finalize(chat, user, s){
  await tg("sendMessage",{chat_id:chat,text:"⏳ Секунда, готовлю сводку…"});
  const llm = await runLLM(user, s) || {};
  s.llm = llm;
  const username = user.username ? "@"+user.username : String(user.id);
  const row = [
    new Date().toISOString(),
    s.run_id, s.started_at,
    username, String(user.id),
    s.consent, s.name,
    JSON.stringify(s.interests), JSON.stringify(s.stack),
    s.a1, s.a2, s.a3, s.about,
    JSON.stringify(""), // legacy time_zone
    JSON.stringify({ days: s.time_days || [], slots: s.time_slots || [] }), // time_windows
    s.specific_slots_text || "",
    JSON.stringify(llm),
    llm.fit_score || "",
    JSON.stringify(llm.roles || []),
    JSON.stringify(llm.stack || []),
    JSON.stringify(llm.work_style || {}),
    llm.time_commitment || "",
    JSON.stringify(llm.links || []),
    llm.summary || ""
  ];

  const wr = await appendSheets(row);
  console.log("sheets_append_result:", wr);

  if (ADMIN_ID) {
    const digest = `${llm.fit_score ?? "?"} — ${(llm.name || s.name || username)} — ${(llm.roles||[]).slice(0,2).join(",")}`;
    await tg("sendMessage",{chat_id:ADMIN_ID,text:`Новая анкета: ${digest}`});
  }
  await tg("sendMessage",{chat_id:chat,text:"✅ Готово! Спасибо. Мы вернёмся с предложением слота."});
  await delSess(user.id);
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
function makeNew(){ return newRun(); }
async function resetFlow(uid,chat){
  const s = newRun();
  await putSess(uid,s);
  await tg("sendMessage",{chat_id:chat,text:"🔁 Начинаем заново — это новая попытка. Предыдущие ответы сохранятся отдельно при записи в базу."});
  await sendWelcome(chat,uid);
}
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

/* ---------------- Handlers ---------------- */
async function onMessage(m){
  const uid=m.from.id; if(await overRL(uid)) return;
  const chat=m.chat.id; const text=(m.text||"").trim();

  if (text.toLowerCase()==="/ping"){ await tg("sendMessage",{chat_id:chat,text:"pong ✅"}); return; }
  if (text.toLowerCase()==="/reset" || text.toLowerCase()==="заново"){ await resetFlow(uid,chat); return; }
  if (text.toLowerCase()==="/digest" && String(uid)===String(ADMIN_ID)){ await cmdDigest(chat); return; }

  if (text.startsWith("/start")){
    const payload = text.split(" ").slice(1).join(" ").trim();
    const hasSecret = payload && START_SECRET && payload.includes(START_SECRET);
    if (REQUIRE_SEC && !hasSecret && String(uid)!==String(ADMIN_ID)){
      await tg("sendMessage",{chat_id:chat,text:`Нужен ключ доступа. Открой ссылку:\nhttps://t.me/rgnr_assistant_bot?start=${encodeURIComponent(START_SECRET||"INVITE")}`});
      return;
    }
    const s=await getSess(uid);
    if (s.step && s.step!=="consent"){
      await tg("sendMessage",{chat_id:chat,text:"Анкета уже начата — продолжать или начать заново?",reply_markup:kbContinueReset()});
      return;
    }
    const s2=makeNew(); await putSess(uid,s2); await sendWelcome(chat,uid); return;
  }

  const s=await getSess(uid);
  if (s.step==="name"){
    s.name = text.slice(0,80);
    s.step = "age";
    await putSess(uid, s);
    await sendAge(chat, uid, s);
    return;
  }

  if (s.step==="about"){ s.about=text.slice(0,1200); s.step="time"; await putSess(uid,s); await sendTime(chat,s); return; }

  // после ГОТОВО финализация идёт в onCallback(q7:done)

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

/* ---------------- onCallback ---------------- */
async function onCallback(q) {
  const uid  = q.from.id;
  const data = q.data || "";

  const answerCb = (text = "", alert = false) =>
    tg("answerCallbackQuery", { callback_query_id: q.id, text, show_alert: alert });

  const isToggle =
    data.startsWith("q3id:") || data.startsWith("q4id:") ||
    data.startsWith("q7d:")  || data.startsWith("q7s:");
  const tooFast  = await overRL(uid, isToggle ? 120 : 30);
  if (tooFast) { await answerCb("Слишком часто. Секунду…"); return; }

  const chat = q.message.chat.id;
  const mid  = q.message.message_id;

  let s = await getSess(uid);

  if (data === "continue")     { await continueFlow(uid, chat, s); await answerCb(); return; }
  if (data === "reset_start")  { await resetFlow(uid, chat);       await answerCb(); return; }

  if (data === "consent_yes") {
    if (s.step !== "consent") { await answerCb(); return; }
    s.consent = "yes"; s.step = "name";
    await putSess(uid, s);
    try { await tg("editMessageText", { chat_id: chat, message_id: mid, text: "✅ Спасибо за согласие на связь.", parse_mode: "HTML" }); } catch {}
    await sendName(chat, uid);
    await answerCb();
    return;
  }
  if (data === "consent_no") {
    if (s.step !== "consent") { await answerCb(); return; }
    try { await tg("editMessageText", { chat_id: chat, message_id: mid, text: "Ок. Если передумаешь — /start" }); } catch {}
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
    await answerCb();
    return;
  }

  // Q4
  if (data.startsWith("q3id:")) {
    if (s.step !== "interests") { await answerCb(); return; }
    const id    = data.slice(5);
    const label = LABEL_BY_ID[id];
    if (!label) { await answerCb(); return; }

    const idx = s.interests.indexOf(label);
    if (idx >= 0) {
      s.interests.splice(idx, 1);
      await putSess(uid, s);
      await tg("editMessageReplyMarkup", { chat_id: chat, message_id: mid, reply_markup: kbInterests(s.interests) });
      await answerCb();
      return;
    }
    if ((s.interests?.length || 0) >= MAX_INTERESTS) { await answerCb(`Можно выбрать не более ${MAX_INTERESTS} пунктов`); return; }

    s.interests.push(label);
    await putSess(uid, s);
    await tg("editMessageReplyMarkup", { chat_id: chat, message_id: mid, reply_markup: kbInterests(s.interests) });
    await answerCb();
    return;
  }
  if (data.startsWith("q3:")) {
    if (s.step !== "interests") { await answerCb(); return; }
    if (data === "q3:next") { s.step = "stack"; await putSess(uid, s); await sendStack(chat, uid, s); }
    await answerCb();
    return;
  }

  // Q5
  if (data.startsWith("q4id:")) {
    if (s.step !== "stack") { await answerCb(); return; }
    const id    = data.slice(5);
    const label = STACK_LABEL_BY_ID[id];
    if (!label) { await answerCb(); return; }

    const idx = s.stack.indexOf(label);
    if (idx >= 0) {
      s.stack.splice(idx, 1);
      await putSess(uid, s);
      await tg("editMessageReplyMarkup", { chat_id: chat, message_id: mid, reply_markup: kbStack(s.stack) });
      await answerCb();
      return;
    }
    if ((s.stack?.length || 0) >= MAX_STACK) { await answerCb(`Можно выбрать не более ${MAX_STACK} пунктов`); return; }

    s.stack.push(label);
    await putSess(uid, s);
    await tg("editMessageReplyMarkup", { chat_id: chat, message_id: mid, reply_markup: kbStack(s.stack) });
    await answerCb();
    return;
  }
  if (data.startsWith("q4:")) {
    if (s.step !== "stack") { await answerCb(); return; }
    if (data === "q4:next") { s.step = "a1"; await putSess(uid, s); await sendA1(chat); }
    await answerCb();
    return;
  }

  // A1/A2/A3
  if (data.startsWith("a1:")) { if (s.step !== "a1") { await answerCb(); return; } s.a1 = data.split(":")[1]; s.step = "a2"; await putSess(uid, s); await sendA2(chat); await answerCb(); return; }
  if (data.startsWith("a2:")) { if (s.step !== "a2") { await answerCb(); return; } s.a2 = data.split(":")[1]; s.step = "a3"; await putSess(uid, s); await sendA3(chat); await answerCb(); return; }
  if (data.startsWith("a3:")) { if (s.step !== "a3") { await answerCb(); return; } s.a3 = data.split(":")[1]; s.step = "about"; await putSess(uid, s); await sendAbout(chat); await answerCb(); return; }

  // Q7: дни/слоты и ГОТОВО
  if (data.startsWith("q7d:")) {
    if (s.step !== "time") { await answerCb(); return; }
    const day = data.slice(4);
    toggle(s.time_days, day);
    await putSess(uid, s);
    await tg("editMessageReplyMarkup", { chat_id: chat, message_id: mid, reply_markup: kbTimeDaysSlots(s) });
    await answerCb();
    return;
  }
  if (data.startsWith("q7s:")) {
    if (s.step !== "time") { await answerCb(); return; }
    const slot = data.slice(4);
    toggle(s.time_slots, slot);
    await putSess(uid, s);
    await tg("editMessageReplyMarkup", { chat_id: chat, message_id: mid, reply_markup: kbTimeDaysSlots(s) });
    await answerCb();
    return;
  }
  if (data === "q7:done") {
    if (s.step !== "time") { await answerCb(); return; }
    if (!(s.time_days?.length) || !(s.time_slots?.length)) {
      await tg("sendMessage", { chat_id: chat, text: "Отметь хотя бы один день и один временной слот." });
      await answerCb();
      return;
    }
    // финал напрямую
    await finalize(chat, { id: uid, username: q.from.username }, s);
    await answerCb();
    return;
  }
}

/* ---------------- Utils ---------------- */
function toggle(arr,val){ const i=arr.indexOf(val); if(i>=0) arr.splice(i,1); else arr.push(val); }
