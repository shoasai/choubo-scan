// AI応答の解析と数値の正規化 (DOM非依存)

// 壊れたJSON (途中切れ・前置き混入) の修復パース
export function repairJson(text) {
  let t = String(text).replace(/```json|```/g, "").trim();
  const first = t.indexOf("{");
  if (first > 0) t = t.slice(first);
  if (first < 0) throw new Error("JSONが見つかりません (AIが形式外の応答)");
  try {
    return { data: JSON.parse(t), repaired: false };
  } catch {}
  // 末尾から '}' 境界ごとに切り詰めて括弧を閉じ直す
  let idx = t.lastIndexOf("}");
  for (let attempts = 0; idx > 0 && attempts < 120; attempts++) {
    const cand = t.slice(0, idx + 1);
    let open = 0, openSq = 0, inStr = false, esc = false, valid = true;
    for (const ch of cand) {
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "{") open++;
      else if (ch === "}") { open--; if (open < 0) { valid = false; break; } }
      else if (ch === "[") openSq++;
      else if (ch === "]") { openSq--; if (openSq < 0) { valid = false; break; } }
    }
    if (valid && !inStr) {
      try {
        return { data: JSON.parse(cand + "]".repeat(openSq) + "}".repeat(open)), repaired: true };
      } catch {}
    }
    idx = t.lastIndexOf("}", idx - 1);
  }
  throw new Error("JSONの解析に失敗 (出力形式が崩れています)");
}

export function toNum(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[,，¥￥\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}


export function parseReadingConclusion(reading) {
  if (!reading) return null;
  const matches = String(reading).match(/結論[:：]?\s*[¥￥]?\s*([\d,，]+)\s*円/g);
  if (!matches || matches.length === 0) return null;
  const num = matches[matches.length - 1].match(/([\d,，]+)\s*円/);
  return num ? Number(num[1].replace(/[,，]/g, "")) : null;
}

