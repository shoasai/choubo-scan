// Workers (静的アセット + API) エントリポイント。
// 既存の login / extract / slack は functions/ 配下の Pages Functions 形式のハンドラを流用する。
import * as loginMod from "../functions/api/login.js";
import * as extractMod from "../functions/api/extract.js";
import * as slackMod from "../functions/api/slack.js";
import { json, checkAuth } from "../functions/api/_lib.js";
import {
  listBatches, createBatch, getBatch, saveItems, confirmBatch, reopenBatch, exportCsv, resolveWarning,
} from "./routes/batches.js";

const legacyRoutes = {
  "/api/login": loginMod,
  "/api/extract": extractMod,
  "/api/slack": slackMod,
};

// 事務所側 (共有パスワード) の API
const staffRoutes = [
  ["GET", /^\/api\/batches$/, (req, env) => listBatches(env)],
  ["POST", /^\/api\/batches$/, (req, env) => createBatch(req, env)],
  ["GET", /^\/api\/batches\/([\w-]+)$/, (req, env, m) => getBatch(env, m[1])],
  ["PUT", /^\/api\/batches\/([\w-]+)\/items$/, (req, env, m) => saveItems(req, env, m[1])],
  ["POST", /^\/api\/batches\/([\w-]+)\/confirm$/, (req, env, m) => confirmBatch(req, env, m[1])],
  ["POST", /^\/api\/batches\/([\w-]+)\/reopen$/, (req, env, m) => reopenBatch(req, env, m[1])],
  ["GET", /^\/api\/batches\/([\w-]+)\/exports\/([\w-]+)\/csv$/, (req, env, m) => exportCsv(env, m[1], m[2])],
  ["POST", /^\/api\/batches\/([\w-]+)\/warnings\/([\w-]+)\/resolve$/, (req, env, m) => resolveWarning(env, m[1], m[2])],
];

const methodNotAllowed = () =>
  new Response(JSON.stringify({ error: "method not allowed" }), {
    status: 405,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    const legacy = legacyRoutes[path];
    if (legacy) {
      if (request.method === "POST" && legacy.onRequestPost) {
        return legacy.onRequestPost({ request, env, ctx });
      }
      return methodNotAllowed();
    }

    if (path.startsWith("/api/")) {
      const matched = staffRoutes.filter(([, re]) => re.test(path));
      if (matched.length === 0) return json({ error: "not found" }, 404);
      const route = matched.find(([method]) => method === request.method);
      if (!route) return methodNotAllowed();
      if (!checkAuth(request, env)) return json({ error: "unauthorized" }, 401);
      if (!env.DB) return json({ error: "サーバーにデータベース (D1) が設定されていません" }, 501);
      try {
        return await route[2](request, env, path.match(route[1]));
      } catch (e) {
        console.error("api error", path, e);
        return json({ error: "サーバーエラー: " + (e?.message || e) }, 500);
      }
    }

    return env.ASSETS.fetch(request);
  },
};
