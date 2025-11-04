// api/_diag_upstash.js
export default async function handler(req, res) {
  try {
    const base  = process.env.UPSTASH_REDIS_REST_URL || "";
    const token = process.env.UPSTASH_REDIS_REST_TOKEN || "";
    const url   = (base || "").replace(/\/$/, "") + "/get/_diag_ping";
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const body = await r.text().catch(() => "");
    res.status(200).json({
      ok: true,
      env: { url: base, url_len: base.length, token_len: token.length },
      fetch: { status: r.status, body: body.slice(0, 200) }
    });
  } catch (e) {
    res.status(200).json({ ok: false, name: e.name, message: e.message });
  }
}
