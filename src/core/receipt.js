// 領収書・レシートの行データ処理 (DOM非依存)
//
// 1行につき次の値を区別する (仕様書 v0.4 §3):
//   ai_raw  … AIが返した構造化出力そのもの (補正前)
//   auto    … 検証・補正を適用した初期値 (人の編集前。教訓用の差分の基準)
//   current … 人が編集した値 (サーバー保存時)
import { repairJson, parseReadingConclusion } from "./parse.js";

// 教訓用の差分を取る対象の項目 (現行の row.original と同じ)
export const RECEIPT_DIFF_FIELDS = ["date", "vendor", "amount", "tax_rate", "qualified", "invoice_number", "account"];

// AIの1行を画面で扱う形にそろえる (値の補正はしない)
export function normalizeAiReceiptRow(r) {
  return {
    date: r.date || "",
    vendor: r.vendor || "",
    amount: r.amount ?? "",
    amount_reading: r.amount_reading || "",
    tax_amount: r.tax_amount ?? null,
    tax_rate: r.tax_rate || "",
    qualified: r.qualified,
    invoice_number: r.invoice_number || "",
    account: r.account || "",
    note: r.note || "",
    confidence: r.confidence ?? 1,
  };
}

// 検証。入力の行は変更せず、警告と適用すべき補正 (patch) を返す
export function validateReceiptRow(r) {
  const warnings = [];
  const patch = {};
  let amount = r.amount;
  const conclusion = parseReadingConclusion(r.amount_reading);
  if (conclusion !== null && Number(r.amount) !== conclusion) {
    warnings.push(`AI出力不整合: 金額欄${r.amount}円 / 読み上げ結論${conclusion}円 → 結論側を採用。原本確認必須`);
    amount = conclusion;
    patch.amount = conclusion;
    patch.confidence = Math.min(r.confidence ?? 1, 0.5);
  }
  const amt = Number(amount);
  if (amt >= 50000) warnings.push("5万円以上: 収入印紙・桁を確認");
  if (r.tax_amount && amt && r.tax_rate === "10%") {
    const expected = Math.round((amt * 10) / 110);
    if (Math.abs(expected - Number(r.tax_amount)) > 2) {
      warnings.push(`税額不整合: 記載${r.tax_amount}円 / 計算${expected}円`);
    }
  }
  return { warnings, patch };
}

// 補正を適用した新しい行 (auto) を返す。引数の行は変更しない
export function applyReceiptValidation(normalized) {
  const { warnings, patch } = validateReceiptRow(normalized);
  const auto = { ...normalized, ...patch };
  if (warnings.length > 0) {
    auto.note = [auto.note, ...warnings].filter(Boolean).join(" / ");
    auto.confidence = Math.min(auto.confidence, 0.6);
  }
  return { auto, warnings };
}

// 教訓用の差分の基準 (現行の row.original と同じ内容)
export function snapshotReceiptOriginal(row) {
  const o = {};
  for (const k of RECEIPT_DIFF_FIELDS) o[k] = row[k];
  return o;
}

// AI応答テキスト → 行の配列。出力途切れ・JSON修復は呼び出し側で警告として残す
export function receiptRowsFromAiText(text) {
  const { data, repaired } = repairJson(text);
  const rows = (data.rows || []).map((r) => {
    const ai_raw = JSON.parse(JSON.stringify(r));
    const { auto, warnings } = applyReceiptValidation(normalizeAiReceiptRow(r));
    return { ai_raw, auto, warnings };
  });
  return { rows, repaired };
}

// 行として保存する項目 (normalizeAiReceiptRow と同じ並び)。画面専用の項目 (id, original 等) を除くのに使う
export const RECEIPT_ROW_FIELDS = [
  "date", "vendor", "amount", "amount_reading", "tax_amount", "tax_rate",
  "qualified", "invoice_number", "account", "note", "confidence",
];
export function pickReceiptFields(row) {
  const out = {};
  for (const k of RECEIPT_ROW_FIELDS) out[k] = row[k] === undefined ? null : row[k];
  return out;
}
