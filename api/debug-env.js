export default async function handler(req, res) {
  res.status(200).json({
    hasToken: !!process.env.TELEGRAM_BOT_TOKEN,
    hasRedisUrl: !!process.env.UPSTASH_REDIS_REST_URL,
    hasRedisToken: !!process.env.UPSTASH_REDIS_REST_TOKEN,
    startSecret: process.env.START_SECRET || "(empty)"
  });
}
