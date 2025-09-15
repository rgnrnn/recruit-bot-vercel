// api/admin-commands.js
// Админ-команды: /help /export /today /stats /who /find /slots /digest
// Требует env: ADMIN_CHAT_ID, SHEETS_WEBHOOK_URL, SHEETS_WEBHOOK_SECRET, TELEGRAM_BOT_TOKEN

const ADMIN_ID = String(process.env.ADMIN_CHAT_ID || "");
const URL  = process.env.SHEETS_WEBHOOK_URL;
const KEY  = process.env.SHEETS_WEBHOOK_SECRET;

function isAdmin(uid) { return String(uid) === ADMIN_ID; }

async function callWriter(op, payload = {}, asText = false) {
  if (!URL || !KEY) return { ok: false, reason: "env_missing" };
  const body = { secret: KEY, op, ...payload };
  const res = await fetch(URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return asText ? res.text() : res.json();
}

function lineOf(r) {
  const name  = r.q2_name || r.telegram || "?";
  let roles = [];
  try { roles = JSON.parse(r.roles || "[]"); } catch {}
  const rolesShort = roles.slice(0,2).join(", ") || "-";
  const fit = (r.fit_score ?? "").toString();
  return `${fit.padStart(2," ")} ★  ${name}  ·  ${rolesShort}`;
}

export async function handleAdminCommand({ text, uid, chat }, tg) {
  if (!isAdmin(uid)) return false;
  const raw = text.trim();
  const lc  = raw.toLowerCase();

  // /help
  if (lc === "/help") {
    const msg =
`Команды админа:
/help — список команд
/export — выгрузка CSV (24 колонки)
/today — за 24ч: сколько, ср. fit, топ интересов/ролей
/stats — всего, за 7/30 дней, топ-3 интересов/стека
/who [N] — последние N анкет (по умолчанию 10)
/find <mask> — поиск по имени/тг/ролям
/slots — агрегированные окна времени
/digest — top-10 и топ-слоты (как текст)`;
    await tg("sendMessage", { chat_id: chat, text: msg });
    return true;
  }

  // /export
  if (lc.startsWith("/export")) {
    const csv = await callWriter("export_csv", {}, true);
    const fd = new FormData();
    fd.append("chat_id", String(chat));
    fd.append("document", new Blob([csv], { type: "text/csv" }), "recruits.csv");
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendDocument`, { method: "POST", body: fd });
    return true;
  }

  // /today
  if (lc.startsWith("/today")) {
    const j = await callWriter("today");
    if (!j?.ok) { await tg("sendMessage",{chat_id:chat,text:"/today: ошибка"}); return true; }
    const msg =
`За 24ч: ${j.total}
Средний fit: ${j.avg_fit}
Топ интересов: ${j.top_interests.join(", ") || "-"}
Топ ролей: ${j.top_roles.join(", ") || "-"}`;
    await tg("sendMessage", { chat_id: chat, text: msg });
    return true;
  }

  // /stats
  if (lc.startsWith("/stats")) {
    const j = await callWriter("stats");
    if (!j?.ok) { await tg("sendMessage",{chat_id:chat,text:"/stats: ошибка"}); return true; }
    const msg =
`Всего: ${j.total}
За 7/30 дней: ${j.last7} / ${j.last30}
Топ-3 интересов: ${j.top_interests.join(", ") || "-"}
Топ-3 стека: ${j.top_stack.join(", ") || "-"}`;
    await tg("sendMessage", { chat_id: chat, text: msg });
    return true;
  }

  // /who [N]
  if (lc.startsWith("/who")) {
    const parts = raw.split(/\s+/);
    const n = Math.max(1, Math.min(50, Number(parts[1]) || 10));
    const j = await callWriter("who", { limit: n });
    if (!j?.ok) { await tg("sendMessage",{chat_id:chat,text:"/who: ошибка"}); return true; }
    const lines = j.rows.map(lineOf).join("\n") || "–";
    await tg("sendMessage", { chat_id: chat, text: lines });
    return true;
  }

  // /find <mask>
  if (lc.startsWith("/find")) {
    const mask = raw.replace(/^\/find\s*/i, "");
    if (!mask) { await tg("sendMessage",{chat_id:chat,text:"/find <mask>"}); return true; }
    const j = await callWriter("find", { q: mask, limit: 20 });
    if (!j?.ok) { await tg("sendMessage",{chat_id:chat,text:"/find: ошибка"}); return true; }
    const lines = j.rows.map(lineOf).join("\n") || "–";
    await tg("sendMessage", { chat_id: chat, text: lines });
    return true;
  }

  // /slots
  if (lc.startsWith("/slots")) {
    const j = await callWriter("slots");
    if (!j?.ok) { await tg("sendMessage",{chat_id:chat,text:"/slots: ошибка"}); return true; }
    const days  = Object.entries(j.days || {}).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k} (${v})`).join(", ") || "-";
    const slots = Object.entries(j.slots|| {}).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k} (${v})`).join(", ") || "-";
    const msg = `Дни: ${days}\nСлоты: ${slots}`;
    await tg("sendMessage", { chat_id: chat, text: msg });
    return true;
  }

  // /digest — текст без Markdown (чтобы не падать на подчёркиваниях)
  if (lc.startsWith("/digest")) {
    const j = await callWriter("digest");
    if (!j?.ok) { await tg("sendMessage",{chat_id:chat,text:"/digest: ошибка"}); return true; }
    const msg = (j.digest || "").replace(/\*/g, ""); // убираем * из writer'а
    await tg("sendMessage", { chat_id: chat, text: msg });
    return true;
  }

  return false; // не админ-команда
}
