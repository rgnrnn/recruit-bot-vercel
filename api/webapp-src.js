// api/webapp-src.js — приём src из WebApp, верификация initData (WebApp scheme) и установка source в сессии

import crypto from "crypto";

const TOKEN       = process.env.TELEGRAM_BOT_TOKEN || "";
const REDIS_BASE  = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";

// ---- Upstash helpers
function rUrl(path){ if(!REDIS_BASE||!REDIS_TOKEN) throw new Error("Redis env missing"); return new URL(REDIS_BASE+path); }
async function rGET(path){ const r=await fetch(rUrl(path),{headers:{Authorization:`Bearer ${REDIS_TOKEN}`}}); return r.json(); }
async function rCall(path,qs){ const u=rUrl(path); if(qs) for(const[k,v] of Object.entries(qs)) u.searchParams.set(k,String(v)); const r=await fetch(u,{headers:{Authorization:`Bearer ${REDIS_TOKEN}`}}); return r.json(); }
const rSet = (k,v,qs)=> rCall(`/set/${encodeURIComponent(k)}/${encodeURIComponent(v)}`, qs);

// ---- Telegram API
async function tg(method,payload){
  const url = `https://api.telegram.org/bot${TOKEN}/${method}`;
  const res = await fetch(url, { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify(payload) });
  return res.json();
}

// ---- verify initData for WebApp (NOT Login Widget)
function verifyInitDataWebApp(initData) {
  if (!TOKEN) return { ok:false, reason:"no_token" };
  const params = new URLSearchParams(initData);
  const hash = params.get("hash") || "";
  if (!hash) return { ok:false, reason:"no_hash" };

  // data_check_string: key=value (кроме hash), отсортировано по ключу, соединено \n
  const entries = [];
  for (const [k,v] of params.entries()) if (k !== "hash") entries.push(`${k}=${v}`);
  entries.sort();
  const dataCheckString = entries.join("\n");

  // WebApp secret: HMAC_SHA256(key="WebAppData", message=bot_token)
  const secret = crypto.createHmac("sha256", "WebAppData").update(TOKEN).digest();
  const calc   = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");

  return (calc === hash) ? { ok:true, params } : { ok:false, reason:"bad_hash" };
}

export default async function handler(req, res){
  try{
    if (req.method !== "POST") { res.status(405).json({ok:false, reason:"method"}); return; }

    // читаем JSON
    let body = {};
    try{
      if (req.body) body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      else {
        let raw=""; for await (const ch of req) raw += Buffer.isBuffer(ch) ? ch.toString("utf8") : String(ch);
        body = JSON.parse(raw || "{}");
      }
    }catch{ res.status(400).json({ok:false, reason:"bad_json"}); return; }

    const initData = String(body.initData || "");
    const srcRaw   = String(body.src || "").toLowerCase().replace(/[^a-z0-9_-]/g,"");

    if (!initData) { res.status(400).json({ok:false, reason:"no_initdata"}); return; }

    const ver = verifyInitDataWebApp(initData);
    if (!ver.ok) { console.log("webapp-src verify FAIL:", ver.reason); res.status(403).json({ok:false, reason:ver.reason}); return; }

    // user.id из initData
    let userId = 0;
    try { const userJson = ver.params.get("user"); userId = JSON.parse(userJson || "{}")?.id || 0; } catch {}
    if (!userId) { res.status(400).json({ok:false, reason:"no_user"}); return; }

    // пишем в сессию source (если пусто) и дублируем в «мост»
    const sessKey = `sess:${userId}`;
    const srcKey  = `user_src:${userId}`;

    let sess = {};
    try { const j = await rGET(`/get/${encodeURIComponent(sessKey)}`); if (j?.result) sess = JSON.parse(j.result); } catch {}
    if (typeof sess !== "object" || !sess) sess = {};
    if (typeof sess.source !== "string") sess.source = "";
    if (!sess.source && srcRaw) sess.source = srcRaw;
    if (!sess.run_id)     sess.run_id = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;
    if (!sess.started_at) sess.started_at = new Date().toISOString();

    await rSet(sessKey, JSON.stringify(sess), { EX: 21600 });
    await rSet(srcKey, srcRaw, { EX: 21600 });      // <-- мост: бот подхватит, если сессия уже создана

    // уведомим пользователя (чтобы было видно, что всё ок)
    await tg("sendMessage", { chat_id: userId, text: `Источник привязан: ${sess.source || srcRaw || "-" } ✅` });

    console.log("webapp-src OK:", { userId, source: sess.source || srcRaw });
    res.status(200).json({ ok:true, user_id:userId, source:sess.source || srcRaw });
  }catch(e){
    console.log("webapp-src ERR:", String(e));
    res.status(500).json({ ok:false, reason:String(e) });
  }
}
