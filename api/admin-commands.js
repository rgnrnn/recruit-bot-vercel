// api/admin-commands.js
// Админ-команды: /help /export /export_xlsx /today /stats /who /find /slots /digest
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

// --- force-UTF16LE encoder (BOM + little-endian pairs) ---
function toUtf16leBuffer(str) {
  if (str && str.charCodeAt(0) === 0xFEFF) str = str.slice(1); // убрать текстовый BOM
  const buf = Buffer.allocUnsafe(2 + str.length * 2);
  buf[0] = 0xFF; buf[1] = 0xFE;
  for (let i = 0, o = 2; i < str.length; i++, o += 2) {
    const c = str.charCodeAt(i);
    buf[o]   =  c        & 0xFF;
    buf[o+1] = (c >>> 8) & 0xFF;
  }
  return buf;
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
/export_xlsx — выгрузка Excel (XLSX)
/today — за 24ч: сколько, ср. fit, топ интересов/ролей
/stats — всего, за 7/30 дней, топ-3 интересов/стека
/who [N] — последние N анкет (по умолчанию 10)
/find <mask> — поиск по имени/тг/ролям
/slots — агрегированные окна времени
/digest — top-10 и топ-слоты (как текст)`;
    await tg("sendMessage", { chat_id: chat, text: msg });
    return true;
  }

  // /export — сначала CP1251 (ANSI для RU Excel), затем UTF-16LE, затем сборка в Node
  if (lc.startsWith("/export")) {
    let reason = "";

    // 0) Пробуем CP1251 CSV (Excel RU открывает идеально «по двойному клику»)
    try {
      const j1251 = await callWriter("export_csv_cp1251_b64");
      if (j1251?.ok && j1251.base64) {
        const buf = Buffer.from(j1251.base64, "base64");
        const fd = new FormData();
        fd.append("chat_id", String(chat));
        fd.append("document",
          new Blob([buf], { type: "application/vnd.ms-excel" }),
          j1251.filename || "recruits.csv"
        );
        await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendDocument`, {
          method: "POST",
          body: fd,
        });
        return true;
      }
    } catch (e) { reason = e?.message || "cp1251_error"; }

    // 1) Пытаемся UTF-16LE base64 со стороны Apps Script
    try {
      const j = await callWriter("export_csv_b64");
      if (j?.ok && j.base64) {
        let buf = Buffer.from(j.base64, "base64");
        // Если вдруг нет FF FE — страхуемся
        if (!(buf[0] === 0xFF && buf[1] === 0xFE)) {
          const csvText = await callWriter("export_csv", {}, true);
          buf = toUtf16leBuffer(String(csvText || ""));
        }
        const fd = new FormData();
        fd.append("chat_id", String(chat));
        fd.append("document",
          new Blob([buf], { type: "application/vnd.ms-excel" }),
          j.filename || "recruits.csv"
        );
        await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendDocument`, {
          method: "POST",
          body: fd,
        });
        return true;
      } else {
        reason = j?.reason || "writer_not_ok";
      }
    } catch (e) {
      reason = e?.message || "export_b64_error";
    }

    // 2) Фолбэк: берём текст и собираем UTF-16LE в Node
    try {
      const csv = await callWriter("export_csv", {}, true);
      if (typeof csv === "string" && csv.length) {
        const buf = toUtf16leBuffer(csv);
        const fd = new FormData();
        fd.append("chat_id", String(chat));
        fd.append(
          "document",
          new Blob([buf], { type: "application/vnd.ms-excel" }),
          "recruits.csv"
        );
        await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendDocument`, {
          method: "POST",
          body: fd,
        });
        return true;
      }
    } catch (e) {
      if (!reason) reason = e?.message || "export_csv_error";
    }

    await tg("sendMessage", { chat_id: chat, text: `/export: ошибка (${reason || "unknown"})` });
    return true;
  }

  // /export_xlsx — выгружает реальный XLSX
  if (lc.startsWith("/export_xlsx")) {
    try {
      const j = await callWriter("export_xlsx_b64");
      if (j?.ok && j.base64) {
        const buf = Buffer.from(j.base64, "base64");
        const fd = new FormData();
        fd.append("chat_id", String(chat));
        fd.append("document",
          new Blob([buf], {
            type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          }),
          j.filename || "recruits.xlsx"
        );
        await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendDocument`, {
          method: "POST",
          body: fd,
        });
        return true;
      }
    } catch (e) { /* ignore */ }
    await tg("sendMessage", { chat_id: chat, text: "/export_xlsx: ошибка" });
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

  // /digest — текст без Markdown
  if (lc.startsWith("/digest")) {
    const j = await callWriter("digest");
    if (!j?.ok) { await tg("sendMessage",{chat_id:chat,text:"/digest: ошибка"}); return true; }
    const msg = (j.digest || "").replace(/\*/g, "");
    await tg("sendMessage", { chat_id: chat, text: msg });
    return true;
  }

  return false; // не админ-команда
}
