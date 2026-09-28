// サーバー (Cloudflare Pages Functions) 経由の AI 呼び出しクライアント。
// API キーはサーバー側環境変数にのみ存在し、フロントには出さない。

const PW_KEY = "choubo:app-password";

export function getPassword() {
  try {
    return localStorage.getItem(PW_KEY) || "";
  } catch {
    return "";
  }
}

export function setPassword(v) {
  try {
    if (v) localStorage.setItem(PW_KEY, v);
    else localStorage.removeItem(PW_KEY);
  } catch {}
}

let currentModel = "claude";
export function setCurrentModel(m) {
  currentModel = m;
}

export async function login(password) {
  let r;
  try {
    r = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
  } catch {
    return { ok: false, error: "サーバーに接続できません (ネットワークを確認してください)" };
  }
  const d = await r.json().catch(() => null);
  // d が JSON でない = /api/* が Functions として動いていない (SPAのHTMLや404が返っている)
  if (!d) {
    return {
      ok: false,
      error: `API が応答していません (HTTP ${r.status})。Cloudflare で「Pages」プロジェクトとして接続されているか、最新のデプロイが環境変数設定後に実行されたかを確認してください`,
    };
  }
  if (r.ok && d.ok) return { ok: true };
  return { ok: false, error: d.error || `HTTP ${r.status}` };
}

function authFailed() {
  setPassword("");
  window.dispatchEvent(new Event("auth-failed"));
}

const MODEL_LABELS = { claude: "Claude Sonnet", "claude-opus": "Claude Opus", gemini: "Gemini" };
// 選択モデルが失敗したときの自動エスカレーション先
const FALLBACK = { claude: "gemini", gemini: "claude", "claude-opus": "claude" };

async function callOnce(model, content, maxTokens) {
  let r;
  try {
    r = await fetch("/api/extract", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-app-password": getPassword(),
      },
      body: JSON.stringify({ model, content, max_tokens: maxTokens }),
    });
  } catch {
    throw new Error("通信エラー (ネットワークを確認してください)");
  }
  if (r.status === 401) {
    authFailed();
    const e = new Error("認証エラー: パスワードを再入力してください");
    e.noFallback = true;
    throw e;
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) throw new Error(`API: ${data.error || "HTTP " + r.status}`);
  if (!data.text) throw new Error("AIから空の応答が返りました");
  if (data.usage) {
    window.dispatchEvent(
      new CustomEvent("api-usage", {
        detail: { model, in: data.usage.input || 0, out: data.usage.output || 0 },
      })
    );
  }
  return { text: data.text, stopReason: data.stopReason };
}

// PoC 版と同一シグネチャ: content は Anthropic Messages 形式のブロック配列。
// 選択モデルがAPIエラーの場合、別プロバイダへ1回だけ自動フォールバックする。
export async function callClaudeFull(content, maxTokens = 2000) {
  const primary = currentModel;
  try {
    return await callOnce(primary, content, maxTokens);
  } catch (e) {
    const fb = FALLBACK[primary];
    if (e.noFallback || !fb) throw e;
    let result;
    try {
      result = await callOnce(fb, content, maxTokens);
    } catch (e2) {
      if (e2.noFallback) throw e2;
      throw new Error(`${MODEL_LABELS[primary]}: ${e.message} / 代替の${MODEL_LABELS[fb]}も失敗: ${e2.message}`);
    }
    window.dispatchEvent(
      new CustomEvent("api-note", {
        detail: { message: `${MODEL_LABELS[primary]}が失敗したため${MODEL_LABELS[fb]}で実行しました (${e.message})` },
      })
    );
    return result;
  }
}

export async function callClaude(content, maxTokens = 2000) {
  return (await callClaudeFull(content, maxTokens)).text;
}

export async function sendSlack(text) {
  const r = await fetch("/api/slack", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-app-password": getPassword(),
    },
    body: JSON.stringify({ text }),
  });
  if (r.status === 401) {
    authFailed();
    throw new Error("認証エラー: パスワードを再入力してください");
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
  return true;
}
