// Minimal handler для Telegram webhook (пока только отвечает 200 OK)
export default async function handler(req, res) {
  if (req.method !== "POST") {
    // Telegram иногда проверяет GET — отвечаем OK, чтобы не было ошибок
    res.status(200).send("OK");
    return;
  }
  try {
    // Логирование входа (в логи Vercel), полезно для отладки
    console.log("TG update:", JSON.stringify(req.body || {}).slice(0, 2000));
  } catch (e) {
    console.error("parse error", e?.message);
  }
  // Всегда быстро отвечаем 200, чтобы Telegram не ретраил
  res.status(200).send("OK");
}
