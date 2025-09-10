async function onMessage(m){
  const uid = m.from.id; if (await overRL(uid)) return;
  const chat = m.chat.id;
  const text = (m.text || "").trim();

  // 0) Диагностика: /ping -> pong (должен ответить всегда)
  if (text.toLowerCase() === "/ping"){
    await tg("sendMessage", { chat_id: chat, text: "pong ✅" });
    return;
  }

  // 1) /start с deep-link
  if (text.startsWith("/start")){
    // логируем вход для отладки
    try { console.log("onMessage /start payload:", text); } catch {}
    if (START_SECRET){
      const payload = text.split(" ").slice(1).join(" ").trim();
      if (!payload || !payload.includes(START_SECRET)){
        // ВРЕМЕННО: явно сообщаем, что секрет не передан
        await tg("sendMessage", { chat_id: chat, text: `Нужен секрет. Открой ссылку:\nhttps://t.me/rgnr_assistant_bot?start=${encodeURIComponent(START_SECRET)}` });
        return;
      }
    }
    const s = await getSess(uid);
    if (s.step && s.step !== "consent"){
      await tg("sendMessage", { chat_id: chat, text: "Анкета уже начата — продолжаем ⬇️" });
      if (s.step==="name") await sendNamePrompt(chat, uid, m.from.username);
      return;
    }
    await delSess(uid);
    await putSess(uid, { step:"consent", consent:"", name:"" });
    await sendWelcome(chat, uid);
    return;
  }

  // 2) Текст принимаем только на шаге name
  const s = await getSess(uid);
  if (s.step === "name"){
    s.name = text.slice(0,80); s.step = "hold"; await putSess(uid, s);
    await tg("sendMessage", { chat_id: chat, text: `✅ Ок, ${s.name}. Следующий шаг добавим далее.` });
    return;
  }

  // 3) Всё остальное — не чатимся
  await tg("sendMessage", { chat_id: chat, text: NO_CHAT });
}
