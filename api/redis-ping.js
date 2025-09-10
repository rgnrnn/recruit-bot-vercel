import { fetch as f } from "undici";

export default async function handler(req, res) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    res.status(500).json({ ok: false, reason: "missing redis env" });
    return;
  }
  const base = url.replace(/\/$/, "");
  const k = "ping:" + Date.now();

  try {
    const set = await f(`${base}/set/${encodeURIComponent(k)}/1?EX=10`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json());

    const get = await f(`${base}/get/${encodeURIComponent(k)}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json());

    res.status(200).json({ ok: true, set, get });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
