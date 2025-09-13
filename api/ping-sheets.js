export default async function handler(req, res) {
  const url = process.env.SHEETS_WEBHOOK_URL;
  const secret = process.env.SHEETS_WEBHOOK_SECRET;
  if (!url || !secret) {
    res.status(500).json({ ok: false, reason: "env_missing" });
    return;
  }

  // Порядок колонок должен совпадать с шапкой листа
  const row = [
    new Date().toISOString(),                // timestamp
    "testrun_" + Date.now().toString(36),    // run_id
    new Date().toISOString(),                // started_at
    "@ping",                                  // telegram
    "0",                                      // telegram_id
    "yes", "Ping Test",                       // q1_consent, q2_name
    JSON.stringify(["Backend"]),              // q3_interests
    JSON.stringify(["Python/FastAPI"]),       // q4_stack
    "Проектирую основательно",                // q5_a1
    "MVP важнее идеала",                      // q5_a2
    "Риск/скорость",                          // q5_a3
    "Автотест записи в таблицу.",             // q6_about
    "Europe/Moscow",                          // q7_time_zone
    JSON.stringify(["будни день"]),           // q7_time_windows
    "-",                                      // q7_specific_slots
    "{}",                                     // llm_json
    "0",                                      // fit_score
    JSON.stringify(["backend"]),              // roles
    JSON.stringify(["Python/FastAPI"]),       // stack
    "{}",                                     // work_style_json
    "≤5ч",                                    // time_commitment
    "[]",                                     // links
    "ping ok"                                 // summary
  ];

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret, op: "append", row })
    });
    const j = await r.json();
    res.status(200).json({ ok: true, writer: j });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
}
