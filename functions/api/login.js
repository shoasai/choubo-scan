import { json } from "./_lib.js";

export async function onRequestPost({ request, env }) {
  const { password } = await request.json().catch(() => ({}));
  if (!env.APP_PASSWORD) return json({ error: "サーバーに APP_PASSWORD が未設定です" }, 500);
  if (password === env.APP_PASSWORD) return json({ ok: true });
  return json({ error: "パスワードが違います" }, 401);
}
