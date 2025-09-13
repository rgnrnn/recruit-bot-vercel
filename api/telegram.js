// api/telegram.js — Telegram webhook (Vercel, Node 20, ESM)
// Полный поток: Q1 consent -> Q2 name -> Q3 interests (multi) -> Q4 stack (multi)
// -> Q5 A1/A2/A3 -> Q6 about (text) -> Q7 time zone + windows + slots -> FINAL (LLM + Sheets)
// Всюду есть «🔁 Начать заново» и панель «▶️ Продолжить / 🔁 Начать заново».

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

const NO_CHAT = "Я не веду переписку — используй кнопки ниже";

const AGE_OPTIONS = ["18–20","21–23","24–26","27–29","30–33","34–37","более 38"];


const A_INTERESTS = ["Backend","Graph/Neo4j","Vector/LLM","Frontend","DevOps/MLOps","Data/ETL","Product/Coordination"];
const A_STACK     = ["Python/FastAPI","PostgreSQL/SQL","Neo4j","pgvector","LangChain/LangGraph","React/TS","Docker/K8s/Linux","CI/GitHub"];
const A1 = ["Быстро прототипирую","Проектирую основательно","Исследую гипотезы","Синхронизирую людей"];
const A2 = ["MVP важнее идеала","Полирую до совершенства"];
const A3 = ["Риск/скорость","Надёжность/предсказуемость"];
const TIME_WINDOWS = ["будни утро","будни день","будни вечер","выходные утро","выходные день","выходные вечер"];

/* ---------------- Redis (Upstash REST) ---------------- */
function rUrl(path){ if(!REDIS_BASE||!REDIS_TOKEN) throw new Error("Redis env missing"); return new URL(REDIS_BASE+path); }
async function rGET(path){ const r=await fetch(rUrl(path),{headers:{Authorization:`Bearer ${REDIS_TOKEN}`}}); return r.json(); }
async function rCall(path,qs){ const u=rUrl(path); if(qs) for(const[k,v]of Object.entries(qs)) u.searchParams.set(k,String(v)); const r=await fetch(u,{headers:{Authorization:`Bearer ${REDIS_TOKEN}`}}); return r.json(); }
const rSet=(k,v,qs)=> rCall(`/set/${encodeURIComponent(k)}/${encodeURIComponent(v)}`, qs);
const rGet=(k)=> rGET(`/get/${encodeURIComponent(k)}`);
const rDel=(k)=> rGET(`/del/${encodeURIComponent(k)}`);
const rIncr=async(k,ex=60)=>{ const j=await rGET(`/incr/${encodeURIComponent(k)}`); if(j.result===1) await rGET(`/expire/${encodeURIComponent(k)}/${ex}`); return j.result; };
async function seenUpdate(id){ try{ const j=await rSet(`upd:${id}`,"1",{EX:180,NX:true}); return j&&("result"in j)? j.result==="OK" : true; }catch{return true;} }
async function overRL(uid,limit=12){ try{return (await rIncr(`rl:${uid}`,60))>limit;}catch{return false;} }


function newRun(){
  return {
    run_id:`${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`,
    started_at:new Date().toISOString(),
    step:"consent", consent:"", name:"",
    age:"",                    // <— добавили возраст
    interests:[], stack:[], a1:"", a2:"", a3:"",
    about:"", time_zone:"", time_windows:[], specific_slots_text:"",
    llm:{}
  };
}


async function getSess(uid){
  try{ const j=await rGet(`sess:${uid}`); if(!j?.result) return newRun();
    let s; try{s=JSON.parse(j.result);}catch{return newRun();}
    if(!Array.isArray(s.interests)) s.interests=[];
    if(!Array.isArray(s.stack)) s.stack=[];
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





// -------- Welcome copy (FIXED) --------
const CONSENT_TEXT = `Старт в команде со-основателей: партнерская доля, право голоса в архитектуре и темп, соответствующий уровню задач. 🔥🤝
Ядро продукта формируется сейчас — редкий шанс зайти в проект, который сшивает три мира. 🧠✨
Промышленный «операционный интеллект» меняет правила в работе с данными: от хаоса файлов и чатов — к системе, где решения рождаются за секунды, а не за недели. 🏭⚙️⏱️
Итог — платформа, которая ускоряет решения на порядки и может переобучать сам бизнес действовать умнее. 📈⚡️
Формат потенциального взаимодействия - доля и партнёрство: больше влияния, больше ответственности, быстрее рост. 🤝📈🚀
`;






/* ---------------- Keyboards ---------------- */
const kbConsent = () => ({
  inline_keyboard: [
    [
      { text: "✅ Согласен", callback_data: "consent_yes" },
      { text: "❌ Не сейчас",        callback_data: "consent_no"  }
    ]
  ]
});





const kbContinueReset = () => ({ inline_keyboard:[[ {text:"▶️ Продолжить",callback_data:"continue"}, {text:"🔁 Начать заново",callback_data:"reset_start"} ]]});
const kbName = () => ({
  inline_keyboard: [
    [{ text: "🔁 Начать заново", callback_data: "reset_start" }]
  ]
});

const kbSingle = (prefix, opts)=>({ inline_keyboard: opts.map(o=>[{text:o,callback_data:`${prefix}:${o}`}]).concat([[{text:"🔁 Начать заново",callback_data:"reset_start"}]]) });
function kbMulti(prefix,options,selected){
  const rows = options.map(o=>[{text:`${selected.includes(o)?"☑️":"⬜️"} ${o}`,callback_data:`${prefix}:${o}`}]);
  rows.push([{text:"Дальше ➜",callback_data:`${prefix}:next`}]);
  rows.push([{text:"🔁 Начать заново",callback_data:"reset_start"}]);
  return { inline_keyboard: rows };
}
function kbTime(sess){
  const rows = [
    [{text:"TZ: Europe/Moscow",callback_data:"q7tz:Europe/Moscow"},{text:"TZ: Europe/Amsterdam",callback_data:"q7tz:Europe/Amsterdam"}],
    ...TIME_WINDOWS.map(w=>[{text:`${sess.time_windows.includes(w)?"☑️":"⬜️"} ${w}`,callback_data:`q7w:${w}`}]),
    [{text:"Готово ➜",callback_data:"q7w:done"}],
    [{text:"🔁 Начать заново",callback_data:"reset_start"}],
  ];
  return { inline_keyboard: rows };
}

/* ---------------- Screens ---------------- */
async function sendWelcome(chat, uid) {
  await tg("sendMessage", {
    chat_id: chat,
    text: CONSENT_TEXT,
    parse_mode: "HTML",
    reply_markup: kbConsent()
  });
}
async function sendName(chat, uid) {
  await tg("sendMessage", {
    chat_id: chat,
    text: "2) Как к тебе обращаться? Введи имя текстом.",
    parse_mode: "HTML",
    reply_markup: kbName()
  });
}


async function sendAge(chat, uid, s) {
  await tg("sendMessage", {
    chat_id: chat,
    text: "3) Укажи возраст:",
    parse_mode: "HTML",
    reply_markup: kbSingle("age", AGE_OPTIONS) // одиночный выбор
  });
}

async function sendInterests(chat,uid,s){ await tg("sendMessage",{chat_id:chat,text:"3) Что интереснее 3–6 мес.? (мультивыбор, повторное нажатие снимает)",parse_mode:"HTML",reply_markup:kbMulti("q3",A_INTERESTS,s.interests||[])}); }
async function sendStack(chat,uid,s){ await tg("sendMessage",{chat_id:chat,text:"4) Уверенный стек (мультивыбор):",parse_mode:"HTML",reply_markup:kbMulti("q4",A_STACK,s.stack||[])}); }
async function sendA1(chat){ await tg("sendMessage",{chat_id:chat,text:"5/A1) Что ближе по стилю?",reply_markup:kbSingle("a1",A1)}); }
async function sendA2(chat){ await tg("sendMessage",{chat_id:chat,text:"5/A2) Что важнее?",reply_markup:kbSingle("a2",A2)}); }
async function sendA3(chat){ await tg("sendMessage",{chat_id:chat,text:"5/A3) Что предпочитаешь?",reply_markup:kbSingle("a3",A3)}); }
async function sendAbout(chat){ await tg("sendMessage",{chat_id:chat,text:"6) 2–5 строк о себе + ссылки (в одном сообщении)."}); }
async function sendTime(chat, sess){ await tg("sendMessage",{chat_id:chat,text:"7) Укажи часовой пояс (кнопкой) и удобные окна (мультивыбор). Затем «Готово».",reply_markup:kbTime(sess)}); }

/* ---------------- Finalize ---------------- */
async function runLLM(u, s){
  const base = {
    name: s.name || String(u.id),
    telegram: s.name || String(u.id),
    roles_hint: s.interests,
    stack_hint: s.stack,
    work_style_raw: {a1:s.a1,a2:s.a2,a3:s.a3},
    about: s.about,
    time_zone: s.time_zone,
    time_windows: s.time_windows,
    specific_slots_text: s.specific_slots_text
  };
  if (!OPENAI_API_KEY) {
    return {
      name: base.name, telegram: base.telegram,
      roles: (s.interests||[]).slice(0,2).map(x=>x.toLowerCase().includes("graph")?"graph":x.toLowerCase().includes("vector")?"vector":x.toLowerCase().includes("devops")?"devops":"backend"),
      stack: (s.stack||[]).slice(0,3),
      work_style: {builder:0.6,architect:0.2,researcher:0.1,operator:0.1,integrator:0.2},
      fit_score: 65, time_commitment: s.time_windows.length>=3?"11–20ч":s.time_windows.length>=2?"6–10ч":"≤5ч",
      time_zone: s.time_zone||"UTC", time_windows: s.time_windows,
      specific_slots_text: s.specific_slots_text || "", links: [],
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
    s.time_zone, JSON.stringify(s.time_windows), s.specific_slots_text || "",
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
  const s = makeNew(); await putSess(uid,s);
  await tg("sendMessage",{chat_id:chat,text:"🔁 Начинаем заново — это новая попытка. Предыдущие ответы сохранятся отдельно при записи в базу."});
  await sendWelcome(chat,uid);
}
async function continueFlow(uid,chat,s,username){
  if (s.step==="name")        { await sendName(chat,uid,username); return; }
  if (s.step === "age")       { await sendAge(chat, uid, s); return; }
  if (s.step==="interests")   { await sendInterests(chat,uid,s);   return; }
  if (s.step==="stack")       { await sendStack(chat,uid,s);       return; }
  if (s.step==="a1")          { await sendA1(chat);                return; }
  if (s.step==="a2")          { await sendA2(chat);                return; }
  if (s.step==="a3")          { await sendA3(chat);                return; }
  if (s.step==="about")       { await sendAbout(chat);             return; }
  if (s.step==="time")        { await sendTime(chat, s);           return; }
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
  if (s.step==="time" && s.time_zone && s.time_windows.length){ s.specific_slots_text=text.slice(0,300); await putSess(uid,s); await finalize(chat,m.from,s); return; }

  await tg("sendMessage",{chat_id:chat,text:NO_CHAT,reply_markup:kbContinueReset()});
}

async function onCallback(q){
  const uid=q.from.id; if(await overRL(uid)) return;
  const chat=q.message.chat.id; const mid=q.message.message_id; const data=q.data||"";
  try{ await tg("answerCallbackQuery",{callback_query_id:q.id}); }catch{}
  let s=await getSess(uid);

  if (data==="continue"){ await continueFlow(uid,chat,s,q.from.username); return; }
  if (data==="reset_start"){ await resetFlow(uid,chat); return; }

  if (data==="consent_yes"){ if(s.step!=="consent") return; s.consent="yes"; s.step="name"; await putSess(uid,s);
    try{ await tg("editMessageText",{chat_id:chat,message_id:mid,text:"✅ Спасибо за согласие на связь.",parse_mode:"HTML"}); }catch{}
    await sendName(chat,uid,q.from.username); return; }
  if (data==="consent_no"){ if(s.step!=="consent") return; try{ await tg("editMessageText",{chat_id:chat,message_id:mid,text:"Ок. Если передумаешь — /start"}); }catch{} await delSess(uid); return; }

  if (data==="name_use_username"){ if(s.step!=="name") return; s.name=q.from.username?`@${q.from.username}`:String(uid); s.step="interests"; await putSess(uid,s); await sendInterests(chat,uid,s); return; }

  if (data.startsWith("age:")) {
    if (s.step !== "age") return;
    s.age = data.split(":")[1];
    s.step = "interests";              // дальше идём по прежнему сценарию
    await putSess(uid, s);
    await sendInterests(chat, uid, s);
    return;
  }

  if (data.startsWith("q3:")){
    if (s.step!=="interests") return;
    const opt=data.split(":")[1];
    if (opt==="next"){ s.step="stack"; await putSess(uid,s); await sendStack(chat,uid,s); return; }
    toggle(s.interests,opt); await putSess(uid,s);
    await tg("editMessageReplyMarkup",{chat_id:chat,message_id:mid,reply_markup:kbMulti("q3",A_INTERESTS,s.interests)}); return;
  }

  if (data.startsWith("q4:")){
    if (s.step!=="stack") return;
    const opt=data.split(":")[1];
    if (opt==="next"){ s.step="a1"; await putSess(uid,s); await sendA1(chat); return; }
    toggle(s.stack,opt); await putSess(uid,s);
    await tg("editMessageReplyMarkup",{chat_id:chat,message_id:mid,reply_markup:kbMulti("q4",A_STACK,s.stack)}); return;
  }

  if (data.startsWith("a1:")){ if (s.step!=="a1") return; s.a1=data.split(":")[1]; s.step="a2"; await putSess(uid,s); await sendA2(chat); return; }
  if (data.startsWith("a2:")){ if (s.step!=="a2") return; s.a2=data.split(":")[1]; s.step="a3"; await putSess(uid,s); await sendA3(chat); return; }
  if (data.startsWith("a3:")){ if (s.step!=="a3") return; s.a3=data.split(":")[1]; s.step="about"; await putSess(uid,s); await sendAbout(chat); return; }

  if (data.startsWith("q7w:")){
    if (s.step!=="time") return;
    const opt=data.split(":")[1];
    if (opt==="done"){
      if (!s.time_zone || !s.time_windows.length){ await tg("sendMessage",{chat_id:chat,text:"Укажи часовой пояс и хотя бы одно окно времени."}); return; }
      await tg("sendMessage",{chat_id:chat,text:"Опционально: напиши 2–3 конкретных слота (или «-» для пропуска)."}); return;
    }
    toggle(s.time_windows,opt); await putSess(uid,s);
    await tg("editMessageReplyMarkup",{chat_id:chat,message_id:mid,reply_markup:kbTime(s)}); return;
  }
  if (data.startsWith("q7tz:")){ if (s.step!=="time") return; s.time_zone=data.split(":")[1]; await putSess(uid,s); await tg("editMessageReplyMarkup",{chat_id:chat,message_id:mid,reply_markup:kbTime(s)}); return; }
}

/* ---------------- Utils ---------------- */
function toggle(arr,val){ const i=arr.indexOf(val); if(i>=0) arr.splice(i,1); else arr.push(val); }
