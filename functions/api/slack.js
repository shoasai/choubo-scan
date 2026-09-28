import { json, checkAuth } from "./_lib.js";

export async function onRequestPost({ request, env }) {
  if (!checkAuth(request, env)) return json({ error: "unauthorized" }, 401);
  if (!env.SLACK_WEBHOOK_URL) return json({ error: "サーバーに SLACK_WEBHOOK_URL が未設定です" }, 501);
  let { text = "" } = await request.json().catch(() => ({}));
  if (!text) return json({ error: "text が必要です" }, 400);
  if (text.length > 30000) {
    text = text.slice(0, 30000) + "\n…(長すぎるため省略。CSVダウンロードを利用してください)";
  }
  const r = await fetch(env.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) return json({ error: "Slack送信失敗 http " + r.status }, 502);
  return json({ ok: true });
}
