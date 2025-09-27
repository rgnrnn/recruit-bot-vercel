// api/admin-commands.js
// Админ-команды: /help /export /file /file_link /export_xlsx /today /stats /who /find /slots /digest

const ADMIN_ID = String(process.env.ADMIN_CHAT_ID || "");
const URL  = process.env.SHEETS_WEBHOOK_URL;
const KEY  = process.env.SHEETS_WEBHOOK_SECRET;

const START_SECRET = process.env.START_SECRET || "";
const REQUIRE_SEC  = /^1|true$/i.test(process.env.REQUIRE_SECRET || "");
const BOT_USERNAME = (process.env.BOT_USERNAME || "").replace(/^@/,"");
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

// UTF-16LE encoder (BOM + little-endian)
function toUtf16leBuffer(str) {
  if (str && str.charCodeAt(0) === 0xFEFF) str = str.slice(1);
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
/file [csv|xlsx] — прислать файл (по умолчанию csv)
/file_link [csv|xlsx] — дать ссылку на файл (Google Drive)
/export — алиас на /file
/export_xlsx — явная выгрузка Excel (XLSX)
/mklink <slug> — WebApp (бесшовно) + deeplink + QR + ручной старт
/mkqr <slug>   — QR WebApp + ссылки
/today /stats /who /find /slots /digest — отчёты`;
    await tg("sendMessage", { chat_id: chat, text: msg });
    return true;
  }

  // --- /mklink и /mkqr
  if (lc.startsWith("/mklink") || lc.startsWith("/mkqr")) {
    if (!isAdmin(uid)) return false;

    const parts = raw.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const rawSlug = (parts[1] || "").trim();

    if (!rawSlug) {
      await tg("sendMessage", { chat_id: chat, text: `Укажи слаг источника: ${cmd} <slug>\nпример: ${cmd} stage_nnug` });
      return true;
    }

    // нормализация slug
    const slug = rawSlug
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9_-]+/g, "")
      .replace(/^-+|-+$/g, "");

    // username бота
    let username = BOT_USERNAME;
    if (!username) {
      try {
        const me = await tg("getMe", {});
        username = (me?.result?.username || "").replace(/^@/,"");
      } catch {}
    }
    if (!username) {
      await tg("sendMessage", { chat_id: chat, text: "Не удалось определить username бота. Задайте BOT_USERNAME в env." });
      return true;
    }

    // Классический deeplink (?start=...), работает только на самом первом старте
    const payloadParts = [];
    if (START_SECRET) payloadParts.push(START_SECRET);
    payloadParts.push(`src:${slug}`);
    const payload = payloadParts.join("__");
    const deepLink = `https://t.me/${username}?start=${encodeURIComponent(payload)}`;
    const deepQr   = `https://api.qrserver.com/v1/create-qr-code/?size=512x512&data=${encodeURIComponent(deepLink)}`;

    // WebApp deep-link — КАНОНИЧЕСКАЯ форма ?startapp=...
    const appParam = `src:${slug}`;
    const appLink  = `https://t.me/${username}?startapp=${encodeURIComponent(appParam)}`;
    const appQr    = `https://api.qrserver.com/v1/create-qr-code/?size=512x512&data=${encodeURIComponent(appLink)}`;

    // Ручной fallback (на всякий случай)
    const manual = `/start ${START_SECRET ? `${START_SECRET}__` : ""}src:${slug}`;

    if (cmd === "/mkqr") {
      await tg("sendPhoto", {
        chat_id: chat,
        photo: appQr,
        caption:
`QR WebApp (бесшовно) для “${slug}”
${appLink}

Классическая (первый старт):
${deepLink}

Если вдруг клиент не подтянет payload (редко):
${manual}`
      });
    } else {
      await tg("sendMessage", {
        chat_id: chat,
        text:
`Источник: ${slug}

⚡ WebApp (бесшовно, для всех):
${appLink}

↗️ Классическая deep-link (payload только на самом первом старте):
${deepLink}

🛟 Ручной старт:
${manual}`
      });
      await tg("sendPhoto", { chat_id: chat, photo: appQr, caption: `QR WebApp для источника “${slug}”` });
      // при желании можно выслать и deepQr
      // await tg("sendPhoto", { chat_id: chat, photo: deepQr, caption: `QR deeplink (первый старт) для “${slug}”` });
    }
    return true;
  }

  // --- /file_link
  if (lc === "/file_link" || lc.startsWith("/file_link ")) {
    const arg = (raw.split(/\s+/)[1] || "").toLowerCase();

    if (arg === "xlsx") {
      try {
        const j = await callWriter("export_xlsx_link");
        if (j?.ok && j.url) { await tg("sendMessage", { chat_id: chat, text: j.url }); return true; }
        await tg("sendMessage", { chat_id: chat, text: `/file_link xlsx: ошибка — ${j?.reason || "нет данных"}` });
      } catch (e) {
        await tg("sendMessage", { chat_id: chat, text: `/file_link xlsx: ошибка — ${e?.message || "unknown"}` });
      }
      return true;
    }

    try {
      const j1251 = await callWriter("export_csv_cp1251_link");
      if (j1251?.ok && j1251.url) { await tg("sendMessage", { chat_id: chat, text: j1251.url }); return true; }
      const j = await callWriter("export_csv_utf16le_link");
      if (j?.ok && j.url) { await tg("sendMessage", { chat_id: chat, text: j.url }); return true; }
    } catch (e) {
      await tg("sendMessage", { chat_id: chat, text: `/file_link: ошибка fallback — ${e?.message || "unknown"}` });
      return true;
    }
    await tg("sendMessage", { chat_id: chat, text: "/file_link: ошибка (пустой ответ)" });
    return true;
  }

  // --- /file
  if (lc === "/file" || lc.startsWith("/file ")) {
    const arg = (raw.split(/\s+/)[1] || "").toLowerCase();

    if (arg === "xlsx") {
      try {
        const j = await callWriter("export_xlsx_b64");
        if (j?.ok && j.base64) {
          const buf = Buffer.from(j.base64, "base64");
          const fd = new FormData();
          fd.append("chat_id", String(chat));
          fd.append("document", new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), j.filename || "recruits.xlsx");
          await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendDocument`, { method: "POST", body: fd });
          return true;
        }
        await tg("sendMessage", { chat_id: chat, text: `/file xlsx: ошибка — ${j?.reason || "нет данных"}` });
      } catch (e) {
        await tg("sendMessage", { chat_id: chat, text: `/file xlsx: ошибка — ${e?.message || "unknown"}` });
      }
      return true;
    }

    try {
      const j1251 = await callWriter("export_csv_cp1251_b64");
      if (j1251?.ok && j1251.base64) {
        const buf = Buffer.from(j1251.base64, "base64");
        const fd = new FormData();
        fd.append("chat_id", String(chat));
        fd.append("document", new Blob([buf], { type: "text/csv" }), j1251.filename || "recruits.csv");
        await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendDocument`, { method: "POST", body: fd });
        return true;
      }
      const j = await callWriter("export_csv_utf16le_text", {}, true);
      if (typeof j === "string" && j.length) {
        const buf = toUtf16leBuffer(j);
        const fd = new FormData();
        fd.append("chat_id", String(chat));
        fd.append("document", new Blob([buf], { type: "text/csv" }), "recruits.csv");
        await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendDocument`, { method: "POST", body: fd });
        return true;
      }
    } catch (e) {
      await tg("sendMessage", { chat_id: chat, text: `/file: ошибка fallback — ${e?.message || "unknown"}` });
      return true;
    }

    await tg("sendMessage", { chat_id: chat, text: "/file: ошибка (пустой ответ)" });
    return true;
  }

  // /export — алиас
  if (lc === "/export" || lc.startsWith("/export ")) {
    return await handleAdminCommand({ text: "/file", uid, chat }, tg);
  }

  // /export_xlsx — явный xlsx
  if (lc === "/export_xlsx" || lc.startsWith("/export_xlsx ")) {
    try {
      const j = await callWriter("export_xlsx_b64");
      if (j?.ok && j.base64) {
        const buf = Buffer.from(j.base64, "base64");
        const fd = new FormData();
        fd.append("chat_id", String(chat));
        fd.append("document", new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), j.filename || "recruits.xlsx");
        await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendDocument`, { method: "POST", body: fd });
        return true;
      }
      await tg("sendMessage", { chat_id: chat, text: `/export_xlsx: ошибка — ${j?.reason || "нет данных"}` });
    } catch (e) {
      await tg("sendMessage", { chat_id: chat, text: `/export_xlsx: ошибка — ${e?.message || "unknown"}` });
    }
    return true;
  }

  // /today
  if (lc === "/today" || lc.startsWith("/today ")) {
    const j = await callWriter("today");
    if (!j?.ok) { await tg("sendMessage",{chat_id:chat,text:`/today: ошибка — ${j?.reason || "нет данных"}`}); return true; }
    const msg =
`За 24ч: ${j.total}
Средний fit: ${j.avg_fit}
Топ интересов: ${j.top_interests.join(", ") || "-"}
Топ ролей: ${j.top_roles.join(", ") || "-"}`;
    await tg("sendMessage", { chat_id: chat, text: msg });
    return true;
  }

  // /stats
  if (lc === "/stats" || lc.startsWith("/stats ")) {
    const j = await callWriter("stats");
    if (!j?.ok) { await tg("sendMessage",{chat_id:chat,text:`/stats: ошибка — ${j?.reason || "нет данных"}`}); return true; }
    const lines = (j.rows || []).map(lineOf).join("\n") || "–";
    await tg("sendMessage", { chat_id: chat, text: lines });
    return true;
  }

  // /who
  if (lc === "/who" || lc.startsWith("/who ")) {
    const j = await callWriter("who");
    if (!j?.ok) { await tg("sendMessage",{chat_id:chat,text:`/who: ошибка — ${j?.reason || "нет данных"}`}); return true; }
    const lines = (j.rows || []).map(lineOf).join("\n") || "–";
    await tg("sendMessage", { chat_id: chat, text: lines });
    return true;
  }

  // /find
  if (lc === "/find" || lc.startsWith("/find ")) {
    const mask = raw.replace(/^\/find\s*/i, "");
    if (!mask) { await tg("sendMessage",{chat_id:chat,text:"/find <mask>"}); return true; }
    const j = await callWriter("find", { q: mask, limit: 20 });
    if (!j?.ok) { await tg("sendMessage",{chat_id:chat,text:`/find: ошибка — ${j?.reason || "нет данных"}`}); return true; }
    const lines = j.rows.map(lineOf).join("\n") || "–";
    await tg("sendMessage", { chat_id: chat, text: lines });
    return true;
  }

  // /slots
  if (lc === "/slots" || lc.startsWith("/slots ")) {
    const j = await callWriter("slots");
    if (!j?.ok) { await tg("sendMessage",{chat_id:chat,text:`/slots: ошибка — ${j?.reason || "нет данных"}`}); return true; }
    const days  = Object.entries(j.days || {}).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k} (${v})`).join(", ") || "-";
    const slots = Object.entries(j.slots|| {}).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k} (${v})`).join(", ") || "-";
    const msg = `Дни: ${days}\nСлоты: ${slots}`;
    await tg("sendMessage", { chat_id: chat, text: msg });
    return true;
  }

  // /digest — текст без Markdown
  if (lc === "/digest" || lc.startsWith("/digest ")) {
    const j = await callWriter("digest");
    if (!j?.ok) { await tg("sendMessage",{chat_id:chat,text:`/digest: ошибка — ${j?.reason || "нет данных"}`}); return true; }
    const msg = (j.digest || "").replace(/\*/g, "");
    await tg("sendMessage", { chat_id: chat, text: msg });
    return true;
  }

  return false;
}
