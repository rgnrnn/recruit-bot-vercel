// api/admin-agent.js
// Mini-agent только для админа: query / broadcast / invite + /agent on|off
// Зависимости: Redis (через HTTP Upstash), OpenAI (опционально), writer(op,...)

const ADMIN_ID     = String(process.env.ADMIN_CHAT_ID || "");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL   = process.env.OPENAI_MODEL || "gpt-4o-mini";
const REDIS_BASE   = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const REDIS_TOKEN  = process.env.UPSTASH_REDIS_REST_TOKEN || "";

// ---------------- Redis helpers ----------------
function rUrl(path){ if(!REDIS_BASE||!REDIS_TOKEN) throw new Error("Redis env missing"); return new URL(REDIS_BASE+path); }
async function rGET(path){ const r=await fetch(rUrl(path),{headers:{Authorization:`Bearer ${REDIS_TOKEN}`}}); return r.json(); }
async function rCall(path,qs){ const u=rUrl(path); if(qs) for(const[k,v]of Object.entries(qs)) u.searchParams.set(k,String(v)); const r=await fetch(u,{headers:{Authorization:`Bearer ${REDIS_TOKEN}`}}); return r.json(); }
const rSet=(k,v,qs)=> rCall(`/set/${encodeURIComponent(k)}/${encodeURIComponent(v)}`, qs);
const rGet=(k)=> rGET(`/get/${encodeURIComponent(k)}`);
const rDel=(k)=> rGET(`/del/${encodeURIComponent(k)}`);

// ---------------- Agent state ----------------
const agentKey = uid => `agent:${uid}:on`;
async function isAdmin(uid){ return String(uid)===ADMIN_ID; }
async function agentOn(uid){ const j=await rSet(agentKey(uid),"1",{EX:86400}); return j?.result==="OK"; }
async function agentOff(uid){ await rDel(agentKey(uid)); }
async function agentEnabled(uid){ try{ const j=await rGet(agentKey(uid)); return j?.result==="1"; }catch{return false;} }

// ---------------- Small utils ----------------
const ok = x => x!==undefined && x!==null && x!=="";
function parseDays(s){ // "7d" -> 7, "14" -> 14
  const m=String(s||"").match(/^(\d+)\s*d?$/i); return m? Number(m[1]) : null;
}
function chunk(arr,n){ const out=[]; for(let i=0;i<arr.length;i+=n) out.push(arr.slice(i,i+n)); return out; }

// ---------------- Strict syntax parser ----------------
// Supported:
// /find score>70 name~"дима" since=7d unique=true limit=50
// /send score>=60 text="..."            (broadcast)
// /invite score>=70 text="..."          (invite with buttons)
function parseStrict(q){
  const t = q.trim();
  if (/^\/agent\s+/i.test(t)) {
    const a = t.split(/\s+/)[1]; return { intent:"agent", action:(a||"").toLowerCase() };
  }
  if (/^\/find\b/i.test(t)) {
    const f = { };
    const parts = t.replace(/^\/find\b/i,"").trim().match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    for (const p of parts) {
      if (/^score[<>]=?\d+$/i.test(p)) {
        const m=p.match(/^score([<>]=?)(\d+)$/i);
        if (m[1].includes(">")) f.min_score=Number(m[2]);
        else f.max_score=Number(m[2]);
      } else if (/^since=\S+$/i.test(p)) {
        const v=p.split("=")[1]; const d=parseDays(v); if (d) f.since_days=d;
      } else if (/^unique=(true|false)$/i.test(p)) {
        f.unique_by = /true/i.test(p) ? "telegram_id" : null;
      } else if (/^name~/.test(p)) {
        const m=p.match(/^name~"?(.*?)"?$/i); f.name_like = m? m[1] : null;
      } else if (/^limit=\d+$/i.test(p)) {
        f.limit=Number(p.split("=")[1]);
      }
    }
    return { intent:"query", filters:f };
  }
  if (/^\/send\b/i.test(t) || /^\/broadcast\b/i.test(t)) {
    const m=t.match(/text="([^]*)"$/i); // всё после text="..."
    const text = m? m[1] : "";
    const head = t.replace(/text="[^"]*"$/,"");
    const q2 = parseStrict(head.replace(/^\/send\b|^\/broadcast\b/i,"/find"));
    return { intent:"broadcast", filters:(q2.filters||{}), message:text };
  }
  if (/^\/invite\b/i.test(t)) {
    const m=t.match(/text="([^]*)"$/i);
    const text = m? m[1] : "";
    const head = t.replace(/text="[^"]*"$/,"");
    const q2 = parseStrict(head.replace(/^\/invite\b/i,"/find"));
    return { intent:"invite", filters:(q2.filters||{}), message:text };
  }
  return null;
}

// ---------------- LLM parser (fallback to OpenAI) ----------------
async function parseWithLLM(text){
  if (!OPENAI_API_KEY) return null;
  const SYSTEM = [
    "Ты парсер пользовательских запросов к базе анкет. Верни СТРОГО JSON без текста вне JSON.",
    "Схема: { intent:'query'|'broadcast'|'invite'|'agent', filters:{min_score?,max_score?,name_like?,since_days?,unique_by?('telegram_id'),limit?}, message? , action?('on'|'off'|'status') }",
    "Примеры запросов: 'покажи уникальные >70 за неделю', 'отправь всем >60 текст: ...', 'пригласи всех >75 ...', '/agent on'."
  ].join("\n");
  const USER = text;
  const body = {
    model: OPENAI_MODEL, temperature: 0, response_format:{type:"json_object"},
    messages: [{role:"system",content:SYSTEM},{role:"user",content:USER}]
  };
  const r = await fetch("https://api.openai.com/v1/chat/completions",{
    method:"POST",
    headers:{ "content-type":"application/json","authorization":"Bearer "+OPENAI_API_KEY },
    body: JSON.stringify(body)
  }).then(r=>r.json()).catch(()=>null);
  try { return JSON.parse(r?.choices?.[0]?.message?.content || "null"); } catch { return null; }
}

// ---------------- Present helpers ----------------
function fmtRow(r){
  const n = (r.q2_name||r.telegram||"?");
  const sc = (r.fit_score ?? r.score ?? "?");
  const when = r.timestamp ? String(r.timestamp).slice(0,16).replace("T"," ") : "";
  return `• ${n} — ${sc} (${when})`;
}
async function sendBatchedList(tg, chat, list){
  if (!list?.length) { await tg("sendMessage",{chat_id:chat,text:"Ничего не найдено."}); return; }
  const pages = chunk(list, 20);
  for (let i=0;i<pages.length;i++){
    const lines = pages[i].map(fmtRow).join("\n");
    await tg("sendMessage",{chat_id:chat,text: (i?`Стр. ${i+1}/${pages.length}\n`:"")+lines });
  }
}

// ---------------- Core actions ----------------
async function doQuery(filters, tg, writer, chat){
  const payload = { filters: { ...filters } };
  const j = await writer("list_by_filter", payload);
  if (!j?.ok) { await tg("sendMessage",{chat_id:chat,text:`Ошибка list_by_filter: ${j?.reason||"unknown"}`}); return true; }
  await sendBatchedList(tg, chat, j.rows||[]);
  return true;
}

async function doBroadcast(filters, message, tg, writer, chat){
  const j = await writer("list_by_filter", { filters: { ...filters, unique_by: filters?.unique_by || "telegram_id" }});
  if (!j?.ok) { await tg("sendMessage",{chat_id:chat,text:`Ошибка list_by_filter: ${j?.reason||"unknown"}`}); return true; }
  const rows = j.rows||[];
  const ids = rows.map(r=>String(r.telegram_id)).filter(Boolean);
  await tg("sendMessage",{chat_id:chat,text:`Найдено: ${ids.length}. Отправить?`,reply_markup:{inline_keyboard:[[{text:"✅ Подтвердить",callback_data:"agent:do:bcast"},{text:"❌ Отмена",callback_data:"agent:cancel"}]]}});
  await rSet(`agent:last:bcast:${chat}`, JSON.stringify({ids, message, filters}), {EX:600});
  return true;
}

async function doInvite(filters, message, tg, writer, chat){
  const j = await writer("list_by_filter", { filters: { ...filters, unique_by: filters?.unique_by || "telegram_id" }});
  if (!j?.ok) { await tg("sendMessage",{chat_id:chat,text:`Ошибка list_by_filter: ${j?.reason||"unknown"}`}); return true; }
  const rows = j.rows||[];
  const ids = rows.map(r=>String(r.telegram_id)).filter(Boolean);
  await tg("sendMessage",{chat_id:chat,text:`Найдено: ${ids.length}. Разослать приглашение?`,reply_markup:{inline_keyboard:[[{text:"✅ Подтвердить",callback_data:"agent:do:invite"},{text:"❌ Отмена",callback_data:"agent:cancel"}]]}});
  await rSet(`agent:last:invite:${chat}`, JSON.stringify({ids, message, filters}), {EX:600});
  return true;
}

// ---------------- Public API ----------------
export async function handleAdminAgentMessage(ctx, tg, writer){
  const { text, uid, chat } = ctx;
  if (!await isAdmin(uid)) return false;

  // переключатель
  if (/^\/agent\b/i.test(text)) {
    const t = text.trim().split(/\s+/)[1] || "status";
    if (t==="on"){ await agentOn(uid); await tg("sendMessage",{chat_id:chat,text:"Agent mode: ON"}); return true; }
    if (t==="off"){ await agentOff(uid); await tg("sendMessage",{chat_id:chat,text:"Agent mode: OFF"}); return true; }
    const on = await agentEnabled(uid); await tg("sendMessage",{chat_id:chat,text:`Agent mode: ${on?"ON":"OFF"}`}); return true;
  }

  // работаем только в режиме on
  if (!await agentEnabled(uid)) return false;

  // 1) строгий синтаксис
  let parsed = parseStrict(text);

  // 2) если не распознали — пробуем LLM
  if (!parsed) parsed = await parseWithLLM(text);
  if (!parsed?.intent) { await tg("sendMessage",{chat_id:chat,text:"Не понял запрос. Примеры: /find score>70 since=7d unique=true\n/send score>60 text=\"...\"\n/invite score>70 text=\"...\""}); return true; }

  // роутинг
  if (parsed.intent==="agent") {
    if (parsed.action==="on"){ await agentOn(uid); await tg("sendMessage",{chat_id:chat,text:"Agent mode: ON"}); }
    else if (parsed.action==="off"){ await agentOff(uid); await tg("sendMessage",{chat_id:chat,text:"Agent mode: OFF"}); }
    else { const on = await agentEnabled(uid); await tg("sendMessage",{chat_id:chat,text:`Agent mode: ${on?"ON":"OFF"}`}); }
    return true;
  }

  if (parsed.intent==="query")   return await doQuery(parsed.filters||{}, tg, writer, chat);
  if (parsed.intent==="broadcast")return await doBroadcast(parsed.filters||{}, parsed.message||"", tg, writer, chat);
  if (parsed.intent==="invite")  return await doInvite(parsed.filters||{}, parsed.message||"", tg, writer, chat);

  await tg("sendMessage",{chat_id:chat,text:"Неизвестный интент."});
  return true;
}

export async function handleAdminAgentCallback(q, tg, writer){
  const uid = q.from.id;
  const chat = q.message.chat.id;
  const data = q.data || "";
  if (!await isAdmin(uid)) return false;
  if (!/^agent:/.test(data)) return false;

  if (data==="agent:cancel") {
    await tg("answerCallbackQuery",{callback_query_id:q.id,text:"Отменено"}); 
    await tg("sendMessage",{chat_id:chat,text:"Отменено."}); 
    return true;
  }

  if (data==="agent:do:bcast") {
    await tg("answerCallbackQuery",{callback_query_id:q.id,text:"Отправляю..."});
    const saved = await rGet(`agent:last:bcast:${chat}`);
    const pl = saved?.result ? JSON.parse(saved.result) : null;
    if (!pl?.ids?.length) { await tg("sendMessage",{chat_id:chat,text:"Нет получателей."}); return true; }
    let ok=0, fail=0;
    for (const id of pl.ids) {
      try {
        await tg("sendMessage",{chat_id:id,text:pl.message});
        ok++; await new Promise(r=>setTimeout(r,80)); // ~12.5 msg/s
      } catch { fail++; }
    }
    await writer("bulk_log",{ kind:"broadcast", filters:pl.filters, text:pl.message, total:pl.ids.length, success:ok, fail });
    await tg("sendMessage",{chat_id:chat,text:`Готово. success=${ok}, fail=${fail}`});
    return true;
  }

  if (data==="agent:do:invite") {
    await tg("answerCallbackQuery",{callback_query_id:q.id,text:"Рассылаю..."});
    const saved = await rGet(`agent:last:invite:${chat}`);
    const pl = saved?.result ? JSON.parse(saved.result) : null;
    if (!pl?.ids?.length) { await tg("sendMessage",{chat_id:chat,text:"Нет получателей."}); return true; }
    let ok=0, fail=0;
    for (const id of pl.ids) {
      try {
        const inviteId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2,7)}`;
        await writer("invites_log_add",{ invite_id:inviteId, telegram_id:id, text:pl.message });
        await tg("sendMessage",{ chat_id:id, text:pl.message, reply_markup:{inline_keyboard:[
          [{text:"🔵 Да", callback_data:`invite:yes:${inviteId}`},{text:"🔴 Нет", callback_data:`invite:no:${inviteId}`}]
        ]}});
        ok++; await new Promise(r=>setTimeout(r,80));
      } catch { fail++; }
    }
    await writer("bulk_log",{ kind:"invite", filters:pl.filters, text:pl.message, total:pl.ids.length, success:ok, fail });
    await tg("sendMessage",{chat_id:chat,text:`Готово. success=${ok}, fail=${fail}`});
    return true;
  }

  // ответы кандидатов на приглашение
  if (/^invite:(yes|no):/.test(data)) {
    const m = data.match(/^invite:(yes|no):(.+)$/); const ans = m[1]; const inviteId = m[2];
    await writer("invite_answer_log",{ invite_id:inviteId, status: ans==="yes"?"accepted":"declined" });
    await tg("answerCallbackQuery",{callback_query_id:q.id,text: ans==="yes"?"Принято ✅":"Отклонено ❌" });
    // по желанию: уведомить админа
    return true;
  }

  return false;
}
