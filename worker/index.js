// Workers (静的アセット + API) エントリポイント。
// functions/ 配下の Pages Functions ハンドラをそのまま流用するアダプタ。
import * as loginMod from "../functions/api/login.js";
import * as extractMod from "../functions/api/extract.js";
import * as slackMod from "../functions/api/slack.js";

const routes = {
  "/api/login": loginMod,
  "/api/extract": extractMod,
  "/api/slack": slackMod,
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const mod = routes[url.pathname];
    if (mod) {
      if (request.method === "POST" && mod.onRequestPost) {
        return mod.onRequestPost({ request, env, ctx });
      }
      return new Response(JSON.stringify({ error: "method not allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json; charset=utf-8", Allow: "POST" },
      });
    }
    return env.ASSETS.fetch(request);
  },
};
