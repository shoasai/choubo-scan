import { json, checkAuth } from "./_lib.js";

// Anthropic Messages 形式のブロック配列 → Gemini parts へ変換
function toGeminiParts(content) {
  return content.map((b) => {
    if (b.type === "text") return { text: b.text };
    if (b.type === "image" || b.type === "document") {
      return { inline_data: { mime_type: b.source.media_type, data: b.source.data } };
    }
    throw new Error("unsupported block: " + b.type);
  });
}

export async function onRequestPost({ request, env }) {
  if (!checkAuth(request, env)) return json({ error: "unauthorized" }, 401);
  const { model = "claude", content, max_tokens = 2000 } = await request.json().catch(() => ({}));
  if (!Array.isArray(content)) return json({ error: "content (array) が必要です" }, 400);

  try {
    if (model === "gemini") {
      if (!env.GEMINI_API_KEY) return json({ error: "サーバーに GEMINI_API_KEY が未設定です" }, 501);
      const m = env.GEMINI_MODEL || "gemini-2.5-flash";
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
          body: JSON.stringify({
            contents: [{ role: "user", parts: toGeminiParts(content) }],
            generationConfig: { maxOutputTokens: max_tokens },
          }),
        }
      );
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: data.error?.message || "gemini http " + r.status }, 502);
      const cand = data.candidates?.[0];
      const text = (cand?.content?.parts || []).map((p) => p.text || "").join("\n");
      if (!text) return json({ error: "gemini から空の応答" }, 502);
      const stopReason =
        cand?.finishReason === "MAX_TOKENS" ? "max_tokens" : String(cand?.finishReason || "stop").toLowerCase();
      const u = data.usageMetadata || {};
      return json({
        text,
        stopReason,
        usage: { input: u.promptTokenCount || 0, output: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) },
      });
    }

    if (!env.ANTHROPIC_API_KEY) return json({ error: "サーバーに ANTHROPIC_API_KEY が未設定です" }, 501);
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        ...(env.ANTHROPIC_WORKSPACE_ID ? { "anthropic-workspace-id": env.ANTHROPIC_WORKSPACE_ID } : {}),
      },
      body: JSON.stringify({
        model: env.CLAUDE_MODEL || "claude-sonnet-4-6",
        max_tokens,
        messages: [{ role: "user", content }],
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error) return json({ error: data.error?.message || "claude http " + r.status }, 502);
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    if (!text) return json({ error: "claude から空の応答" }, 502);
    const u = data.usage || {};
    return json({
      text,
      stopReason: data.stop_reason,
      usage: { input: u.input_tokens || 0, output: u.output_tokens || 0 },
    });
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
}
