import { useState, useRef, useEffect, useMemo } from "react";
import * as XLSX from "xlsx";
import { callClaudeFull, callClaude, setCurrentModel, getPassword, setPassword, login, sendSlack } from "./lib/api.js";
import { appStorage } from "./lib/store.js";

// ==================== 定数 ====================
const MODE_KEY = "receipt-poc-mode";
const LESSONS_KEY = "receipt-poc-lessons";

const MODES = [
  { id: "receipt", label: "領収書", icon: "🧾", desc: "手書き領収書・レシート → 明細CSV" },
  { id: "ledger", label: "帳簿(手書き)", icon: "📓", desc: "金銭出納帳など → 明細+残高CSV+検算" },
  { id: "excel", label: "帳簿チェック(Excel)", icon: "📊", desc: "Excel/CSV帳簿の残高検算レポート" },
];

const RECEIPT_COLUMNS = [
  { key: "date", label: "日付", width: "w-28" },
  { key: "vendor", label: "店舗名 / 摘要", width: "w-44" },
  { key: "amount", label: "金額(税込)", width: "w-24", align: "right" },
  { key: "tax_rate", label: "税率", width: "w-16" },
  { key: "qualified", label: "適格", width: "w-14" },
  { key: "invoice_number", label: "インボイス番号", width: "w-40" },
  { key: "account", label: "勘定科目候補", width: "w-28" },
  { key: "note", label: "備考", width: "w-36" },
];

const LEDGER_COLUMNS = [
  { key: "date", label: "月日", width: "w-20" },
  { key: "summary", label: "摘要", width: "w-56" },
  { key: "income", label: "収入金額", width: "w-24", align: "right" },
  { key: "payment", label: "支払金額", width: "w-24", align: "right" },
  { key: "balance", label: "差引残高", width: "w-28", align: "right" },
];

const FIELD_LABELS = {
  date: "日付", vendor: "店舗名/摘要", amount: "金額", tax_rate: "税率",
  qualified: "適格", invoice_number: "インボイス番号", account: "勘定科目",
  note: "備考", summary: "摘要", income: "収入金額", payment: "支払金額", balance: "差引残高",
};

// ==================== プロンプト ====================
const RECEIPT_PROMPT = `あなたは日本のレシート・領収書の読み取り専門AIです。
この画像/PDFを読み取り、以下のJSON形式のみで返答してください。前置きやMarkdownの\`\`\`は一切不要です。

{
  "rows": [
    {
      "date": "YYYY-MM-DD (不明ならnull)",
      "vendor": "店舗名または摘要",
      "amount_reading": "金額欄の文字を左から1文字ずつ読み上げ、検討過程を書き、最後に必ず『結論: N円』で締める (例: '先頭マス:￥(7と酷似だが記号と判断) / 1,2,6,0,0 → 結論: 12600円')",
      "amount": 数値(amount_reading の『結論: N円』の N をそのまま転記する。読み上げと異なる値を書いてはならない。不明ならnull),
      "tax_amount": 数値(内消費税額の記載があれば・なければnull),
      "tax_rate": "10%" | "8%" | "非課税" | null,
      "qualified": true | false | null,
      "invoice_number": "T+13桁 (なければnull)",
      "account": "勘定科目の推測(会議費/旅費交通費/消耗品費/新聞図書費/接待交際費/通信費/雑費など)",
      "note": "特記事項・読み取りに自信がない箇所",
      "confidence": 0.0〜1.0
    }
  ]
}

【フィールドの生成順序 (絶対厳守)】
- 必ず amount_reading を先に書き、そこで桁の検討を完結させてから、その結論の数値だけを amount に転記する。

ルール:
- 1枚の画像・1ページに複数の領収書がある場合は、それぞれ1行ずつ抽出。PDFは全ページ処理。
- 「合計」「お預り」「お釣り」を混同しない。amount は支払合計。
- 手書きの￥は数字の7と酷似する。先頭の文字は通貨記号の可能性を必ず最初に検討。金額欄のマス目形式では先頭マスに￥が書かれる慣習がある。
- 訂正線がある場合は訂正後の値を採用し note に記載。
- 5万円以上の領収書には通常「収入印紙」が貼られる。印紙が見当たらないのに5万円以上と読めた場合、桁の誤読を疑い再読する。
- 内消費税の記載があれば tax_amount に。税込10%なら 税額≈金額×10/110。合わなければ誤読を疑う。
- 和暦は西暦に変換(令和8年=2026年)。
- 読み取れない箇所は null にして note に「要確認: 〜」と記載し confidence を下げる。
- JSON以外の文字を出力しない。`;

const LEDGER_PROMPT = `あなたは日本の手書き帳簿(金銭出納帳・現金出納帳)の読み取り専門AIです。
この画像は帳簿ページの一部分(分割画像)です。写っている行を上から順にすべて読み取り、以下のJSON形式のみで返答してください。前置きやMarkdownの\`\`\`は一切不要です。

{"rows":[{"d":"4/1","s":"前年度繰越金","i":null,"p":null,"b":188814,"c":1,"n":"","f":0.9}]}

各キーの意味:
- d: 月日 (記載どおり。〃や空欄は直前の行と同じ日付として補完)
- s: 摘要 (書いてある文字の転記のみ)
- i: 収入金額 / p: 支払金額 / b: 差引残高 (数値・なければnull)
- c: 繰越行(「繰越」「前年度繰越金」「前ページより」等)なら1、通常行は0
- n: 読み取りに自信がない箇所の短いメモ (自信がある行は "")
- f: 確度 0.0〜1.0

【創作の禁止 (最重要)】
- 摘要は書いてある文字の転記のみ。判読できない文字は1文字ごとに「?」に置き換える (例: "ビ?ター ?田")。
- 画像から読み取れない語を推測で補うことは厳禁。それらしい一般語を創作してはならない。
- 摘要が全く判読できない行は s を "?" とし f を 0.3 以下、? を含む行は f を 0.6 以下にする。

ルール:
- 各行で数値がどの列(収入/支払/残高)にあるかを罫線の位置で慎重に判定する。列ズレは厳禁。
- 桁は1文字ずつ慎重に読む。4と9、1と7、0と6は誤読しやすい。読めない数値は null にして n に記載。
- 訂正線・訂正印がある場合は訂正後の値を採用し n に記載。
- 画像の上端・下端で途中で切れている行は出力しない (隣接する分割画像で処理される)。
- 監査文言・署名・押印・ページ下部の合計/集計行はデータ行ではないので出力しない。
- 残高の検算はしなくてよい (システム側で行う)。読み取った数字をそのまま出力する。
- JSON以外の文字を出力しない。`;

const COLUMN_MAP_PROMPT = `以下はExcel帳簿の先頭数行です。各列が何を表すかを判定し、以下のJSON形式のみで返答してください。

{
  "header_row": ヘッダー行のインデックス(0始まり・なければnull),
  "date": 列インデックス(0始まり・なければnull),
  "summary": 列インデックス,
  "income": 列インデックス(収入・入金),
  "payment": 列インデックス(支払・支出・出金),
  "balance": 列インデックス(残高・差引残高)
}

JSON以外の文字を出力しない。

データ:
`;

// ==================== ユーティリティ ====================
function readAsDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(new Error("ファイルの読み込みに失敗"));
    r.readAsDataURL(file);
  });
}

function loadImage(dataUrl) {
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error("画像のデコードに失敗"));
    i.src = dataUrl;
  });
}

// 画像 → 正立回転済みキャンバス (cwDeg は時計回り角度)
function imgToCanvas(img, cwDeg = 0, maxEdge = Infinity) {
  const rot = ((cwDeg % 360) + 360) % 360;
  const sw = img.width, sh = img.height;
  const w0 = rot % 180 === 0 ? sw : sh;
  const h0 = rot % 180 === 0 ? sh : sw;
  const scale = Math.min(1, maxEdge / Math.max(w0, h0));
  const cv = document.createElement("canvas");
  cv.width = Math.round(w0 * scale);
  cv.height = Math.round(h0 * scale);
  const ctx = cv.getContext("2d");
  ctx.translate(cv.width / 2, cv.height / 2);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.drawImage(img, (-sw * scale) / 2, (-sh * scale) / 2, sw * scale, sh * scale);
  return cv;
}

// グレースケール + パーセンタイル・コントラスト強調 (薄い鉛筆対策)
function grayContrastInPlace(cv, clip = 0.02) {
  const ctx = cv.getContext("2d");
  const d = ctx.getImageData(0, 0, cv.width, cv.height);
  const a = d.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < a.length; i += 4) {
    const y = ((a[i] * 299 + a[i + 1] * 587 + a[i + 2] * 114) / 1000) | 0;
    a[i] = y;
    hist[y]++;
  }
  const total = a.length / 4;
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * clip) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= total * clip) { hi = v; break; } }
  const range = Math.max(1, hi - lo);
  for (let i = 0; i < a.length; i += 4) {
    let v = ((a[i] - lo) * 255) / range;
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    a[i] = a[i + 1] = a[i + 2] = v;
  }
  ctx.putImageData(d, 0, 0);
}

function cropToB64(cv, sx, sy, sw, sh, maxEdge = 2000, q = 0.9) {
  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  const out = document.createElement("canvas");
  out.width = Math.round(sw * scale);
  out.height = Math.round(sh * scale);
  out.getContext("2d").drawImage(cv, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return out.toDataURL("image/jpeg", q).split(",")[1];
}

// AIで正立に必要な回転角(時計回り)を判定。失敗時は 0
async function detectRotationDeg(img) {
  try {
    const small = imgToCanvas(img, 0, 640).toDataURL("image/jpeg", 0.8).split(",")[1];
    const { text } = await callClaudeFull([
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: small } },
      { type: "text", text: '画像内の日本語の文字を正立させるには、画像を時計回りに何度回転させる必要がありますか。{"rotate":0} 形式のJSONのみで回答。rotate は 0, 90, 180, 270 のいずれか。' },
    ], 50);
    const r = Number(repairJson(text).data.rotate);
    return [0, 90, 180, 270].includes(r) ? r : 0;
  } catch {
    return 0;
  }
}

// 領収書用: 正立回転のみ (カラー保持)
async function fileToReceiptImage(file, maxEdge = 1800) {
  const img = await loadImage(await readAsDataURL(file));
  const rot = await detectRotationDeg(img);
  const jpeg = imgToCanvas(img, rot, maxEdge).toDataURL("image/jpeg", 0.87);
  return { base64: jpeg.split(",")[1], preview: jpeg, rot };
}

// 帳簿用: 正立回転 → グレースケール+コントラスト強調 → 見開きを最大4分割 (オーバーラップ付き)
async function fileToLedgerParts(file) {
  const img = await loadImage(await readAsDataURL(file));
  const rot = await detectRotationDeg(img);
  const up = imgToCanvas(img, rot, 4000);
  grayContrastInPlace(up);
  const w = up.width, h = up.height;
  const blocks = [];
  if (w / h >= 1.25) {
    const half = Math.round(w * 0.54);
    blocks.push([0, 0, half, h], [w - half, 0, half, h]);
  } else if (h / w >= 1.25) {
    const half = Math.round(h * 0.54);
    blocks.push([0, 0, w, half], [0, h - half, w, half]);
  } else {
    blocks.push([0, 0, w, h]);
  }
  const parts = [];
  for (const [bx, by, bw, bh] of blocks) {
    if (bh / bw >= 1.1) {
      const hh = Math.round(bh * 0.55);
      parts.push(cropToB64(up, bx, by, bw, hh));
      parts.push(cropToB64(up, bx, by + bh - hh, bw, hh));
    } else {
      parts.push(cropToB64(up, bx, by, bw, bh));
    }
  }
  const pvScale = Math.min(1, 400 / Math.max(w, h));
  const pv = document.createElement("canvas");
  pv.width = Math.round(w * pvScale);
  pv.height = Math.round(h * pvScale);
  pv.getContext("2d").drawImage(up, 0, 0, pv.width, pv.height);
  return { parts, preview: pv.toDataURL("image/jpeg", 0.7), split: parts.length > 1, rot };
}

async function fileToRawBase64(file) {
  const dataUrl = await readAsDataURL(file);
  return dataUrl.split(",")[1];
}

// ==================== AI呼び出し: src/lib/api.js (サーバープロキシ経由) ====================

// 壊れたJSON (途中切れ・前置き混入) の修復パース
function repairJson(text) {
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

function toNum(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[,，¥￥\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// ==================== 検証 ====================
function parseReadingConclusion(reading) {
  if (!reading) return null;
  const matches = String(reading).match(/結論[:：]?\s*[¥￥]?\s*([\d,，]+)\s*円/g);
  if (!matches || matches.length === 0) return null;
  const num = matches[matches.length - 1].match(/([\d,，]+)\s*円/);
  return num ? Number(num[1].replace(/[,，]/g, "")) : null;
}

function validateReceiptRow(r) {
  const warnings = [];
  const conclusion = parseReadingConclusion(r.amount_reading);
  if (conclusion !== null && Number(r.amount) !== conclusion) {
    warnings.push(`AI出力不整合: 金額欄${r.amount}円 / 読み上げ結論${conclusion}円 → 結論側を採用。原本確認必須`);
    r.amount = conclusion;
    r.confidence = Math.min(r.confidence ?? 1, 0.5);
  }
  const amt = Number(r.amount);
  if (amt >= 50000) warnings.push("5万円以上: 収入印紙・桁を確認");
  if (r.tax_amount && amt && r.tax_rate === "10%") {
    const expected = Math.round((amt * 10) / 110);
    if (Math.abs(expected - Number(r.tax_amount)) > 2) {
      warnings.push(`税額不整合: 記載${r.tax_amount}円 / 計算${expected}円`);
    }
  }
  return warnings;
}

// 残高チェーン検算 (決定的・コード側で実施)
// 残高が空欄の行は収入/支払を累積し、次に残高が記載された行でまとめて検算する
function computeChain(rows) {
  const result = {};
  let prev = null; // 直近の確定残高
  let acc = 0;     // 確定残高以降の収支の累積
  for (const r of rows) {
    const income = toNum(r.income);
    const payment = toNum(r.payment);
    const balance = toNum(r.balance);
    if (r.is_carryover) {
      result[r.id] = { status: "start", expected: null };
      if (balance !== null) { prev = balance; acc = 0; }
      continue;
    }
    acc += (income || 0) - (payment || 0);
    if (balance === null) {
      result[r.id] = { status: "unknown", expected: prev !== null ? prev + acc : null };
      continue;
    }
    if (prev === null) {
      result[r.id] = { status: "unknown", expected: null };
      prev = balance;
      acc = 0;
      continue;
    }
    const expected = prev + acc;
    result[r.id] = { status: expected === balance ? "ok" : "mismatch", expected };
    prev = balance;
    acc = 0;
  }
  return result;
}

// 数値ベースの行一致 (摘要の読み違いに影響されない・列入替も同一視)
function rowNumEq(x, y) {
  const xb = toNum(x.balance), yb = toNum(y.balance);
  if (xb !== null && yb !== null) return xb === yb;
  if (xb !== null || yb !== null) return false;
  const xi = toNum(x.income), xp = toNum(x.payment);
  const yi = toNum(y.income), yp = toNum(y.payment);
  if (xi === null && xp === null && yi === null && yp === null) return false;
  return (xi === yi && xp === yp) || (xi === yp && xp === yi);
}

// 分割パーツのマージ (オーバーラップ重複を数値署名で除去)
function mergeLedgerParts(a, b) {
  if (a.length === 0) return b;
  for (let m = Math.min(10, a.length, b.length); m >= 1; m--) {
    let all = true, strong = false;
    for (let j = 0; j < m; j++) {
      const x = a[a.length - m + j], y = b[j];
      if (!rowNumEq(x, y)) { all = false; break; }
      if (toNum(x.balance) !== null) strong = true;
    }
    if (all && (strong || m >= 2)) return [...a, ...b.slice(m)];
  }
  return [...a, ...b];
}

// マージ後の正規化: ジャンク行除去 + 収入/支払の列入替を検算で自動補正
function normalizeLedgerRows(rows) {
  const cleaned = rows.filter((r) => {
    const noNums = toNum(r.income) === null && toNum(r.payment) === null && toNum(r.balance) === null;
    const s = String(r.summary || "").replace(/[?？\s.。・〃~〜0-9-]/g, "");
    return !(noNums && s.length <= 1);
  });
  const delta = (r) => (toNum(r.income) || 0) - (toNum(r.payment) || 0);
  const swap = (r) => {
    const t = r.income;
    r.income = r.payment;
    r.payment = t;
    r.note = [r.note, "収入/支払を自動入替補正(検算一致)"].filter(Boolean).join(" / ");
    r.confidence = Math.min(r.confidence ?? 1, 0.7);
  };
  let prev = null;
  let seg = [];
  for (const r of cleaned) {
    const b = toNum(r.balance);
    if (r.is_carryover) {
      if (b !== null) prev = b;
      seg = [];
      continue;
    }
    seg.push(r);
    if (b === null) continue;
    if (prev !== null) {
      const exp = prev + seg.reduce((s, x) => s + delta(x), 0);
      if (exp !== b) {
        if (exp - 2 * delta(r) === b) swap(r);
        else if (prev - seg.reduce((s, x) => s + delta(x), 0) === b) seg.forEach(swap);
      }
    }
    prev = b;
    seg = [];
  }
  return cleaned;
}

// ==================== CSV ====================
function csvEscape(v) {
  if (v === null || v === undefined) v = "";
  v = String(v).replace(/"/g, '""');
  return /[",\n]/.test(v) ? `"${v}"` : v;
}

function buildReceiptCsv(rows) {
  const header = [...RECEIPT_COLUMNS.map((c) => c.label), "確認"].join(",");
  const lines = rows.map((r) => {
    const cells = RECEIPT_COLUMNS.map((c) => {
      let v = r[c.key];
      if (c.key === "qualified") v = v === true ? "適格" : v === false ? "非適格" : "";
      return csvEscape(v);
    });
    const state = r.reviewed ? "確認済" : r.confidence < 0.7 ? "要確認" : "";
    return [...cells, csvEscape(state)].join(",");
  });
  return "﻿" + [header, ...lines].join("\n");
}

function buildLedgerCsv(rows, chain) {
  const header = [...LEDGER_COLUMNS.map((c) => c.label), "検算", "確認", "備考"].join(",");
  const lines = rows.map((r) => {
    const c = chain[r.id] || {};
    const check =
      c.status === "ok" ? "OK" :
      c.status === "mismatch" ? `不一致(計算:${c.expected})` :
      c.status === "start" ? "繰越" : "-";
    const state = r.reviewed ? "確認済" : c.status === "mismatch" || r.confidence < 0.7 ? "要確認" : "";
    return [...LEDGER_COLUMNS.map((col) => csvEscape(r[col.key])), csvEscape(check), csvEscape(state), csvEscape(r.note)].join(",");
  });
  return "﻿" + [header, ...lines].join("\n");
}

function buildExcelReportCsv(report) {
  const header = "行番号,月日,摘要,収入,支払,記載残高,計算残高,差額,判定";
  const lines = report.rows.map((r) =>
    [r.rowNo, r.date, r.summary, r.income, r.payment, r.balance, r.expected ?? "", r.diff ?? "", r.status === "mismatch" ? "不一致" : r.status === "start" ? "繰越" : r.status === "ok" ? "OK" : "-"]
      .map(csvEscape).join(",")
  );
  return "﻿" + [header, ...lines].join("\n");
}

// ==================== メイン ====================
export default function ReceiptScanPoc() {
  const [mode, setMode] = useState("receipt");
  const [modeLoaded, setModeLoaded] = useState(false);
  const [items, setItems] = useState([]);
  const [receiptRows, setReceiptRows] = useState([]);
  const [ledgerRows, setLedgerRows] = useState([]);
  const [excelReport, setExcelReport] = useState(null);
  const [lessons, setLessons] = useState([]);
  const [showLessons, setShowLessons] = useState(false);
  const [dismissed, setDismissed] = useState(new Set());
  const [correctionTarget, setCorrectionTarget] = useState(null);
  const [correctionReason, setCorrectionReason] = useState("");
  const [savingLesson, setSavingLesson] = useState(false);
  const [copyMsg, setCopyMsg] = useState("");
  const [toast, setToast] = useState("");
  const fileRef = useRef(null);
  const idRef = useRef(0);
  const lessonsRef = useRef([]);
  lessonsRef.current = lessons;

  const busyCount = items.filter((i) => i.status === "processing").length;
  const chain = useMemo(() => computeChain(ledgerRows), [ledgerRows]);

  // ---- ウェブ版追加: AIモデル選択 / 認証 / API使用量 / Slack ----
  const [aiModel, setAiModel] = useState(() => {
    try { return localStorage.getItem("choubo:ai-model") || "claude"; } catch { return "claude"; }
  });
  useEffect(() => {
    setCurrentModel(aiModel);
    try { localStorage.setItem("choubo:ai-model", aiModel); } catch {}
  }, [aiModel]);
  const [authed, setAuthed] = useState(() => !!getPassword());
  useEffect(() => {
    const h = () => setAuthed(false);
    window.addEventListener("auth-failed", h);
    return () => window.removeEventListener("auth-failed", h);
  }, []);
  const [usage, setUsage] = useState({ inTok: 0, outTok: 0 });
  useEffect(() => {
    const h = (e) => setUsage((u) => ({ inTok: u.inTok + (e.detail?.in || 0), outTok: u.outTok + (e.detail?.out || 0) }));
    window.addEventListener("api-usage", h);
    return () => window.removeEventListener("api-usage", h);
  }, []);
  const [slackSending, setSlackSending] = useState(false);
  const [showOnlyReview, setShowOnlyReview] = useState(false);
  useEffect(() => {
    const h = (e) => e.detail?.message && showToast(`ℹ ${e.detail.message}`);
    window.addEventListener("api-note", h);
    return () => window.removeEventListener("api-note", h);
  }, []);

  // ---------- 永続データ ----------
  useEffect(() => {
    (async () => {
      try {
        const m = await appStorage.get(MODE_KEY);
        if (m?.value && MODES.some((x) => x.id === m.value)) setMode(m.value);
      } catch {}
      try {
        const l = await appStorage.get(LESSONS_KEY);
        if (l?.value) setLessons(JSON.parse(l.value));
      } catch {}
      setModeLoaded(true);
    })();
  }, []);

  async function switchMode(m) {
    setMode(m);
    try { await appStorage.set(MODE_KEY, m); } catch {}
  }

  async function persistLessons(next) {
    setLessons(next);
    try { await appStorage.set(LESSONS_KEY, JSON.stringify(next)); }
    catch { showToast("教訓の保存に失敗しました"); }
  }

  function showToast(msg) {
    setToast(msg);
    setTimeout(() => setToast(""), 5000);
  }

  function lessonsBlock() {
    const ls = lessonsRef.current;
    if (ls.length === 0) return "";
    return `\n\n【過去の訂正から得た教訓 (必ず考慮すること)】\n${ls.map((l, i) => `${i + 1}. ${l.text}`).join("\n")}`;
  }

  function patchItem(id, patch) {
    setItems((p) => p.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }

  // ---------- ファイル受付 ----------
  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    for (const file of files) {
      if (mode === "excel") { await processExcel(file); continue; }
      const id = ++idRef.current;
      const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
      let payload = null, preview = null, splitInfo = false;
      try {
        if (isPdf) {
          payload = { kind: mode, pdfBase64: await fileToRawBase64(file) };
        } else if (mode === "ledger") {
          const p = await fileToLedgerParts(file);
          payload = { kind: "ledger", parts: p.parts };
          preview = p.preview;
          splitInfo = p.parts.length;
        } else {
          const p = await fileToReceiptImage(file);
          payload = { kind: "receipt", base64: p.base64 };
          preview = p.preview;
        }
      } catch (e) {
        setItems((p) => [...p, { id, preview: null, isPdf, status: "error", error: e.message }]);
        continue;
      }
      setItems((p) => [...p, { id, preview, isPdf, split: splitInfo, payload, status: "processing" }]);
      await processItem(id, payload);
    }
  }

  function retryItem(it) {
    if (!it.payload) { showToast("このファイルは再選択が必要です"); return; }
    patchItem(it.id, { status: "processing", error: null });
    processItem(it.id, it.payload);
  }

  async function processItem(id, payload) {
    try {
      if (payload.kind === "receipt") await doReceipt(id, payload);
      else await doLedger(id, payload);
    } catch (e) {
      const msg = e?.message || "不明なエラー";
      patchItem(id, { status: "error", error: msg });
      showToast(`解析失敗: ${msg}`);
    }
  }

  // ---------- 領収書 ----------
  async function doReceipt(id, payload) {
    const fileBlock = payload.pdfBase64
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: payload.pdfBase64 } }
      : { type: "image", source: { type: "base64", media_type: "image/jpeg", data: payload.base64 } };
    const { text, stopReason } = await callClaudeFull([fileBlock, { type: "text", text: RECEIPT_PROMPT + lessonsBlock() }], 4000);
    const { data, repaired } = repairJson(text);
    const newRows = (data.rows || []).map((r) => {
      const row = {
        id: ++idRef.current, sourceId: id,
        date: r.date || "", vendor: r.vendor || "",
        amount: r.amount ?? "", amount_reading: r.amount_reading || "",
        tax_amount: r.tax_amount ?? null, tax_rate: r.tax_rate || "",
        qualified: r.qualified, invoice_number: r.invoice_number || "",
        account: r.account || "", note: r.note || "",
        confidence: r.confidence ?? 1,
      };
      const warnings = validateReceiptRow(row);
      if (warnings.length > 0) {
        row.note = [row.note, ...warnings].filter(Boolean).join(" / ");
        row.confidence = Math.min(row.confidence, 0.6);
      }
      row.original = {
        date: row.date, vendor: row.vendor, amount: row.amount,
        tax_rate: row.tax_rate, qualified: row.qualified,
        invoice_number: row.invoice_number, account: row.account,
      };
      return row;
    });
    setReceiptRows((p) => [...p, ...newRows]);
    patchItem(id, { status: "done", count: newRows.length });
    if (stopReason === "max_tokens" || repaired) {
      showToast("応答が長すぎて一部途切れた可能性があります。抽出漏れがないか件数を確認してください");
    }
  }

  // ---------- 帳簿 ----------
  const mapLedgerRow = (r) => ({
    date: (r.d ?? r.date ?? "") || "",
    summary: (r.s ?? r.summary ?? "") || "",
    income: r.i ?? r.income ?? "",
    payment: r.p ?? r.payment ?? "",
    balance: r.b ?? r.balance ?? "",
    is_carryover: !!(r.c ?? r.is_carryover),
    note: (r.n ?? r.note ?? "") || "",
    confidence: r.f ?? r.confidence ?? 1,
  });

  async function doLedger(id, payload) {
    let collected = [];
    let truncated = false;
    const prompt = LEDGER_PROMPT + lessonsBlock();

    if (payload.pdfBase64) {
      const { text, stopReason } = await callClaudeFull(
        [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: payload.pdfBase64 } }, { type: "text", text: prompt }],
        16000
      );
      const { data, repaired } = repairJson(text);
      collected = (data.rows || []).map(mapLedgerRow);
      truncated = stopReason === "max_tokens" || repaired;
    } else {
      for (const part of payload.parts) {
        const { text, stopReason } = await callClaudeFull(
          [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: part } }, { type: "text", text: prompt }],
          16000
        );
        const { data, repaired } = repairJson(text);
        const rows = (data.rows || []).map(mapLedgerRow);
        collected = mergeLedgerParts(collected, rows);
        if (stopReason === "max_tokens" || repaired) truncated = true;
      }
    }

    collected = normalizeLedgerRows(collected);
    const newRows = collected.map((r) => {
      const row = { id: ++idRef.current, sourceId: id, ...r };
      row.original = { date: row.date, summary: row.summary, income: row.income, payment: row.payment, balance: row.balance };
      return row;
    });
    setLedgerRows((p) => [...p, ...newRows]);
    patchItem(id, { status: "done", count: newRows.length });
    if (truncated) {
      showToast("応答が上限に達したため一部の行が欠けている可能性があります。行数を原本と照合してください");
    }
  }

  // ---------- Excelチェック ----------
  async function processExcel(file) {
    const id = ++idRef.current;
    setItems((p) => [...p, { id, preview: null, isExcel: true, name: file.name, status: "processing" }]);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" });

      let map = detectColumns(aoa);
      if (map.balance === null) {
        const sample = aoa.slice(0, 10).map((row) => row.slice(0, 12));
        const text = await callClaude([{ type: "text", text: COLUMN_MAP_PROMPT + JSON.stringify(sample) }], 300);
        try { map = { ...map, ...repairJson(text).data }; } catch {}
      }
      if (map.balance === null || map.balance === undefined) throw new Error("残高列を特定できませんでした");

      const startRow = (map.header_row ?? 0) + 1;
      const rows = [];
      for (let i = startRow; i < aoa.length; i++) {
        const raw = aoa[i];
        if (!raw || raw.every((c) => c === "" || c === null)) continue;
        const summary = map.summary !== null && map.summary !== undefined ? String(raw[map.summary] ?? "") : "";
        const balance = toNum(raw[map.balance]);
        const income = map.income !== null && map.income !== undefined ? toNum(raw[map.income]) : null;
        const payment = map.payment !== null && map.payment !== undefined ? toNum(raw[map.payment]) : null;
        if (balance === null && income === null && payment === null) continue;
        rows.push({
          id: ++idRef.current, rowNo: i + 1,
          date: map.date !== null && map.date !== undefined ? String(raw[map.date] ?? "") : "",
          summary, income, payment, balance,
          is_carryover: /繰越|前年度|前ページ|前月/.test(summary),
        });
      }
      const chainRes = computeChain(rows);
      const reportRows = rows.map((r) => {
        const c = chainRes[r.id] || {};
        return { ...r, status: c.status, expected: c.expected, diff: c.status === "mismatch" ? toNum(r.balance) - c.expected : null };
      });
      const mismatches = reportRows.filter((r) => r.status === "mismatch").length;
      setExcelReport({ fileName: file.name, columnMap: map, rows: reportRows, mismatches, total: rows.length });
      patchItem(id, { status: "done", count: rows.length });
      showToast(mismatches === 0 ? "検算完了: 全行一致しました" : `検算完了: ${mismatches} 件の不一致`);
    } catch (e) {
      patchItem(id, { status: "error", error: e.message || "Excelの解析に失敗" });
      showToast(`Excelの解析に失敗: ${e.message || ""}`);
    }
  }

  function detectColumns(aoa) {
    const map = { header_row: null, date: null, summary: null, income: null, payment: null, balance: null };
    for (let i = 0; i < Math.min(10, aoa.length); i++) {
      const row = aoa[i].map((c) => String(c ?? ""));
      row.forEach((cell, j) => {
        if (/残高|差引/.test(cell) && map.balance === null) { map.balance = j; map.header_row = i; }
        if (/収入|入金/.test(cell) && map.income === null) map.income = j;
        if (/支払|支出|出金/.test(cell) && map.payment === null) map.payment = j;
        if (/日付|月日|年月日/.test(cell) && map.date === null) map.date = j;
        if (/摘要|内容|項目/.test(cell) && map.summary === null) map.summary = j;
      });
      if (map.balance !== null) break;
    }
    return map;
  }

  // ---------- 質問キュー ----------
  const questions = useMemo(() => {
    if (mode !== "ledger") return [];
    const qs = [];
    ledgerRows.forEach((r, i) => {
      const c = chain[r.id];
      if (c?.status === "mismatch" && !dismissed.has("chain-" + r.id)) {
        qs.push({
          qid: "chain-" + r.id, rowId: r.id, type: "chain",
          text: `行${i + 1} (${r.date} ${r.summary}) の残高が計算と合いません。記載: ${toNum(r.balance)?.toLocaleString()}円 / 計算: ${c.expected?.toLocaleString()}円`,
          expected: c.expected,
        });
      }
      if (r.confidence < 0.7 && !dismissed.has("conf-" + r.id)) {
        qs.push({
          qid: "conf-" + r.id, rowId: r.id, type: "conf",
          text: `行${i + 1} (${r.date} ${r.summary}) の読み取り自信度が低いです${r.note ? `: ${r.note}` : ""}。表の値を原本と照合してください`,
        });
      }
    });
    return qs;
  }, [mode, ledgerRows, chain, dismissed]);

  function resolveQuestion(q, action) {
    if (action === "adopt" && q.type === "chain") {
      setLedgerRows((p) => p.map((r) => (r.id === q.rowId ? { ...r, balance: q.expected, reviewed: true, note: [r.note, "残高を計算値に修正"].filter(Boolean).join(" / ") } : r)));
    } else if (action === "keep" && q.type === "chain") {
      setLedgerRows((p) => p.map((r) => (r.id === q.rowId ? { ...r, reviewed: true, note: [r.note, "記載どおり(記帳ミスの可能性)"].filter(Boolean).join(" / ") } : r)));
    } else {
      setLedgerRows((p) => p.map((r) => (r.id === q.rowId ? { ...r, reviewed: true } : r)));
    }
    setDismissed((p) => new Set([...p, q.qid]));
  }

  // ---------- 行編集 ----------
  function updateRow(kind, id, key, value) {
    const setter = kind === "receipt" ? setReceiptRows : setLedgerRows;
    setter((p) => p.map((r) => (r.id === id ? { ...r, [key]: value } : r)));
  }
  function toggleReviewed(kind, id) {
    const setter = kind === "receipt" ? setReceiptRows : setLedgerRows;
    setter((p) => p.map((r) => (r.id === id ? { ...r, reviewed: !r.reviewed } : r)));
  }
  function removeRow(kind, id) {
    const setter = kind === "receipt" ? setReceiptRows : setLedgerRows;
    setter((p) => p.filter((r) => r.id !== id));
  }

  // ---------- 教訓 ----------
  function getDiffs(row) {
    if (!row?.original) return [];
    const fmtQ = (v) => (v === true ? "適格" : v === false ? "非適格" : "(空)");
    return Object.keys(row.original)
      .filter((k) => String(row.original[k] ?? "") !== String(row[k] ?? ""))
      .map((k) => ({
        label: FIELD_LABELS[k] || k,
        oldValue: k === "qualified" ? fmtQ(row.original[k]) : String(row.original[k] ?? "(空)"),
        newValue: k === "qualified" ? fmtQ(row[k]) : String(row[k] ?? "(空)"),
      }));
  }

  async function saveLesson() {
    const rows = correctionTarget?.kind === "receipt" ? receiptRows : ledgerRows;
    const row = rows.find((r) => r.id === correctionTarget?.id);
    if (!row) return;
    const diffs = getDiffs(row);
    if (diffs.length === 0 && !correctionReason.trim()) {
      showToast("表の値を修正するか、コメントを入力してください");
      return;
    }
    setSavingLesson(true);
    try {
      const prompt = `帳票読み取りAIが誤読し、人間が訂正しました。この事例から、今後の読み取りで同じ誤りを防ぐための「一般化された教訓」を1〜2文の日本語で作成してください。

【AIの読み取り → 人間の訂正】
${diffs.map((d) => `- ${d.label}: 「${d.oldValue}」→「${d.newValue}」`).join("\n") || "(表の修正なし)"}

【訂正した人のコメント】
${correctionReason.trim() || "(コメントなし)"}

要件: 特定の帳票固有の情報ではなく、他の帳票にも適用できる一般ルールとして簡潔に書く。教訓の本文のみを出力。`;
      const text = await callClaude([{ type: "text", text: prompt }], 300);
      await persistLessons([...lessons, { id: Date.now(), text: text.trim(), createdAt: new Date().toISOString() }]);
      showToast("教訓を保存しました。次回の読み取りから反映されます");
      setCorrectionTarget(null);
      setCorrectionReason("");
    } catch (e) {
      showToast(`教訓の生成に失敗: ${e.message || "再試行してください"}`);
    }
    setSavingLesson(false);
  }

  // ---------- 出力 ----------
  function currentCsv() {
    if (mode === "receipt") return buildReceiptCsv(receiptRows);
    if (mode === "ledger") return buildLedgerCsv(ledgerRows, chain);
    if (mode === "excel" && excelReport) return buildExcelReportCsv(excelReport);
    return "";
  }
  function hasData() {
    if (mode === "receipt") return receiptRows.length > 0;
    if (mode === "ledger") return ledgerRows.length > 0;
    return !!excelReport;
  }
  function downloadCsv() {
    const blob = new Blob([currentCsv()], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const d = new Date();
    const prefix = mode === "receipt" ? "receipts" : mode === "ledger" ? "ledger" : "check_report";
    a.href = url;
    a.download = `${prefix}_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
  async function copyCsv() {
    const csv = currentCsv().replace(/^﻿/, "");
    try {
      await navigator.clipboard.writeText(csv);
      setCopyMsg("コピーしました。Slackやメールにそのままペーストできます");
    } catch {
      const ta = document.createElement("textarea");
      ta.value = csv;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); setCopyMsg("コピーしました"); }
      catch { setCopyMsg("コピーに失敗しました。ダウンロードをご利用ください"); }
      document.body.removeChild(ta);
    }
    setTimeout(() => setCopyMsg(""), 4000);
  }

  async function sendSlackCsv() {
    setSlackSending(true);
    try {
      const csv = currentCsv().replace(/^\uFEFF/, "");
      const label = mode === "receipt" ? "レシート読み取り結果" : mode === "ledger" ? "帳簿読み取り結果" : "帳簿検算レポート";
      await sendSlack(`📋 ${label}\n\u0060\u0060\u0060\n${csv}\n\u0060\u0060\u0060`);
      showToast("Slackへ送信しました");
    } catch (e) {
      showToast(`Slack送信失敗: ${e.message || ""}`);
    }
    setSlackSending(false);
  }

  // ---------- レンダリング ----------
  const correctionRow = correctionTarget
    ? (correctionTarget.kind === "receipt" ? receiptRows : ledgerRows).find((r) => r.id === correctionTarget.id)
    : null;
  const needsReceiptReview = (r) => !r.reviewed && r.confidence < 0.7;
  const needsLedgerReview = (r) => !r.reviewed && (chain[r.id]?.status === "mismatch" || r.confidence < 0.7);
  const lowConfReceipts = receiptRows.filter(needsReceiptReview).length;
  const mismatchCount = ledgerRows.filter((r) => chain[r.id]?.status === "mismatch").length;
  const ledgerReviewCount = ledgerRows.filter(needsLedgerReview).length;
  const visibleReceiptRows = showOnlyReview ? receiptRows.filter(needsReceiptReview) : receiptRows;
  const visibleLedgerRows = showOnlyReview ? ledgerRows.filter(needsLedgerReview) : ledgerRows;
  const errorItems = items.filter((i) => i.status === "error");

  const acceptTypes = mode === "excel" ? ".xlsx,.xls,.csv" : "image/*,application/pdf";

  // 概算コスト (単価は要確認: Sonnet $3/$15 per M, Gemini 2.5世代 $0.30/$2.50 per M, 1USD=150円想定。
  // Opus と gemini-3.8 の単価は未確認のため概算を出さない)
  const estYen =
    aiModel === "claude"
      ? ((usage.inTok * 3 + usage.outTok * 15) / 1e6) * 150
      : aiModel === "gemini"
      ? ((usage.inTok * 0.3 + usage.outTok * 2.5) / 1e6) * 150
      : null;

  if (!authed) return <LoginGate onSuccess={() => setAuthed(true)} />;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900" style={{ fontFamily: "'Hiragino Sans', 'Yu Gothic', sans-serif" }}>
      <header className="border-b-2 border-slate-900 bg-white px-5 py-4">
        <div className="mx-auto flex max-w-6xl items-baseline justify-between">
          <div>
            <h1 className="text-lg font-bold tracking-wide">帳票読み取りツール</h1>
            <p className="mt-0.5 text-xs text-slate-500">読み込み → AI抽出・検算 → 質問・修正・学習 → CSV出力</p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={aiModel}
              onChange={(e) => setAiModel(e.target.value)}
              title="読み取りに使うAIモデル"
              className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] text-slate-600 focus:border-slate-500 focus:outline-none"
            >
              <option value="claude">Claude Sonnet (標準)</option>
              <option value="claude-opus">Claude Opus (高精度)</option>
              <option value="gemini">Gemini Flash (低コスト)</option>
            </select>
            <button onClick={() => setShowLessons(!showLessons)} className="rounded border border-slate-300 px-2 py-1 text-[11px] text-slate-600 transition hover:border-slate-500">
              🧠 教訓 ({lessons.length})
            </button>
            <span className="rounded border border-slate-300 px-2 py-0.5 text-[10px] tracking-widest text-slate-500">web v1.2</span>
          </div>
        </div>
      </header>

      {toast && <div className="fixed left-1/2 top-4 z-50 w-max max-w-[90vw] -translate-x-1/2 rounded bg-slate-900 px-4 py-2 text-xs text-white shadow-lg">{toast}</div>}

      <main className="mx-auto max-w-6xl px-5 py-6">
        {/* モード選択 */}
        <section className="mb-6">
          <div className="mb-2 flex items-baseline gap-2">
            <span className="font-mono text-xs text-slate-400">MODE</span>
            <h2 className="text-sm font-bold">処理モード <span className="ml-1 font-normal text-[11px] text-slate-400">(選択は保存され、次回起動時も維持されます)</span></h2>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {MODES.map((m) => (
              <button key={m.id} onClick={() => switchMode(m.id)} disabled={!modeLoaded}
                className={`rounded-lg border-2 p-3 text-left transition ${mode === m.id ? "border-slate-900 bg-white shadow-sm" : "border-slate-200 bg-white/50 hover:border-slate-400"}`}>
                <span className="text-base">{m.icon} <span className="text-sm font-bold">{m.label}</span></span>
                <span className="mt-0.5 block text-[11px] text-slate-500">{m.desc}</span>
              </button>
            ))}
          </div>
        </section>

        {/* 教訓一覧 */}
        {showLessons && (
          <section className="mb-6 rounded-lg border border-indigo-200 bg-indigo-50 p-4">
            <h2 className="mb-2 text-sm font-bold text-indigo-900">学習済みの教訓</h2>
            {lessons.length === 0 ? (
              <p className="text-xs text-indigo-700">まだ教訓はありません。抽出結果の修正や質問への回答から教訓を保存すると、次回以降の読み取りに反映されます。</p>
            ) : (
              <ul className="space-y-2">
                {lessons.map((l, i) => (
                  <li key={l.id} className="flex items-start gap-2 rounded bg-white p-2 text-xs">
                    <span className="font-mono text-indigo-400">{i + 1}.</span>
                    <span className="flex-1">{l.text}</span>
                    <button onClick={() => persistLessons(lessons.filter((x) => x.id !== l.id))} className="text-slate-300 hover:text-red-500">✕</button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {/* STEP 1 */}
        <section className="mb-6">
          <div className="mb-2 flex items-baseline gap-2">
            <span className="font-mono text-xs text-slate-400">STEP 1</span>
            <h2 className="text-sm font-bold">{mode === "excel" ? "Excel / CSV 帳簿をアップロード" : "帳票を読み込む"}</h2>
          </div>
          <input ref={fileRef} type="file" accept={acceptTypes} multiple className="hidden"
            onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }} />
          <button onClick={() => fileRef.current?.click()}
            className="w-full rounded-lg border-2 border-dashed border-slate-300 bg-white py-8 text-sm text-slate-600 transition hover:border-slate-500 hover:text-slate-900">
            <span className="block text-2xl">{mode === "excel" ? "📊" : "📷"}</span>
            <span className="mt-1 block font-medium">
              {mode === "excel" ? "タップしてファイルを選択 (.xlsx / .csv)" : "タップして撮影 / 画像・PDFを選択"}
            </span>
            <span className="mt-0.5 block text-xs text-slate-400">
              {mode === "receipt" && "手書き領収書・スキャンPDF対応 / 向きは自動補正 / 1枚に複数の領収書があってもOK"}
              {mode === "ledger" && "金銭出納帳など / 向きの自動補正・コントラスト強調・最大4分割で解析 / 残高はシステムが自動検算"}
              {mode === "excel" && "残高列を自動検出し、収入・支払との整合を全行検算します"}
            </span>
          </button>

          {items.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {items.map((it) => (
                <div key={it.id} className="relative w-20" title={it.error || ""}>
                  {it.preview ? (
                    <img src={it.preview} alt="" className="h-24 w-20 rounded border border-slate-200 object-cover" />
                  ) : (
                    <div className="flex h-24 w-20 items-center justify-center rounded border border-slate-200 bg-white text-2xl">
                      {it.isExcel ? "📊" : it.isPdf ? "📄" : "🖼"}
                    </div>
                  )}
                  <div className={`absolute inset-x-0 bottom-0 rounded-b px-1 py-0.5 text-center text-[10px] text-white ${
                    it.status === "processing" ? "bg-amber-500" : it.status === "done" ? "bg-emerald-600" : "bg-red-500"
                  }`}>
                    {it.status === "processing" ? "解析中…" : it.status === "done" ? `${it.count}件` : "失敗"}
                  </div>
                  {it.split > 1 && (
                    <div className="absolute right-0 top-0 rounded-bl bg-slate-900/70 px-1 text-[9px] text-white">{it.split}分割</div>
                  )}
                </div>
              ))}
            </div>
          )}

          {errorItems.length > 0 && (
            <ul className="mt-2 space-y-1">
              {errorItems.map((it) => (
                <li key={it.id} className="text-[11px] text-red-600">
                  ⚠ {it.error || "解析失敗"}
                  {it.payload && (
                    <button onClick={() => retryItem(it)} className="ml-2 rounded border border-red-300 px-2 py-0.5 text-[10px] hover:bg-red-50">再試行</button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {busyCount > 0 && <p className="mt-2 text-xs text-amber-600">解析中: {busyCount} 件（帳簿は向き判定+最大4分割のため2〜3分かかることがあります）</p>}
        </section>

        {/* 質問キュー */}
        {mode === "ledger" && questions.length > 0 && (
          <section className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-4">
            <h2 className="mb-2 text-sm font-bold text-amber-900">❓ 確認が必要な項目 ({questions.length})</h2>
            <ul className="space-y-2">
              {questions.map((q) => (
                <li key={q.qid} className="rounded bg-white p-3 text-xs">
                  <p className="mb-2">{q.text}</p>
                  <div className="flex flex-wrap gap-2">
                    {q.type === "chain" && (
                      <>
                        <button onClick={() => resolveQuestion(q, "adopt")}
                          className="rounded bg-emerald-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-emerald-500">
                          計算値 {q.expected?.toLocaleString()} 円を採用
                        </button>
                        <button onClick={() => resolveQuestion(q, "keep")}
                          className="rounded border border-slate-400 px-3 py-1 text-[11px] hover:bg-slate-100">
                          原本どおり (記帳ミスとして記録)
                        </button>
                      </>
                    )}
                    {q.type === "conf" && (
                      <button onClick={() => resolveQuestion(q, "ok")}
                        className="rounded border border-slate-400 px-3 py-1 text-[11px] hover:bg-slate-100">確認済み</button>
                    )}
                    <button onClick={() => { setCorrectionTarget({ kind: "ledger", id: q.rowId }); setCorrectionReason(""); }}
                      className="rounded border border-indigo-300 px-3 py-1 text-[11px] text-indigo-600 hover:bg-indigo-50">
                      表で修正して学習
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[10px] text-amber-700">
              残高不一致が2行連続する場合は残高自体の誤読、1行だけの場合は収入・支払の誤読または記帳ミスの可能性が高いです。
            </p>
          </section>
        )}

        {/* STEP 2 */}
        <section className="mb-6">
          <div className="mb-2 flex items-baseline justify-between">
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-xs text-slate-400">STEP 2</span>
              <h2 className="text-sm font-bold">{mode === "excel" ? "検算レポート" : "抽出結果を確認・修正"}</h2>
            </div>
            {mode === "receipt" && receiptRows.length > 0 && (
              <span className="flex items-center gap-2 text-xs text-slate-500">
                {receiptRows.length} 件
                {lowConfReceipts > 0 ? <span className="text-amber-600">⚠ 要確認 {lowConfReceipts}</span> : <span className="text-emerald-600">✓ 全件確認済み</span>}
                <label className="flex cursor-pointer items-center gap-1 rounded border border-slate-300 px-2 py-0.5 text-[11px]">
                  <input type="checkbox" checked={showOnlyReview} onChange={(e) => setShowOnlyReview(e.target.checked)} />
                  要確認のみ表示
                </label>
              </span>
            )}
            {mode === "ledger" && ledgerRows.length > 0 && (
              <span className="flex items-center gap-2 text-xs text-slate-500">
                {ledgerRows.length} 行
                {mismatchCount > 0 && <span className="text-red-600">✗ 残高不一致 {mismatchCount}</span>}
                {ledgerReviewCount > 0 ? <span className="text-amber-600">⚠ 要確認 {ledgerReviewCount}</span> : <span className="text-emerald-600">✓ 全件確認済み</span>}
                <label className="flex cursor-pointer items-center gap-1 rounded border border-slate-300 px-2 py-0.5 text-[11px]">
                  <input type="checkbox" checked={showOnlyReview} onChange={(e) => setShowOnlyReview(e.target.checked)} />
                  要確認のみ表示
                </label>
              </span>
            )}
          </div>

          {mode === "receipt" && (receiptRows.length === 0 ? (
            <EmptyBox text="画像やPDFを読み込むと、ここに抽出結果が表示されます" />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
              <table className="w-full min-w-[920px] text-xs">
                <thead>
                  <tr className="border-b-2 border-slate-900 bg-slate-100 text-left">
                    <th className="w-10 px-2 py-2 font-semibold">確認</th>
                    {RECEIPT_COLUMNS.map((c) => <th key={c.key} className={`px-2 py-2 font-semibold ${c.width}`}>{c.label}</th>)}
                    <th className="w-20 px-2 py-2 font-semibold">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleReceiptRows.map((r) => (
                    <tr key={r.id} className={`border-b border-slate-100 ${needsReceiptReview(r) ? "bg-amber-50" : ""}`}>
                      <td className="px-1 py-1 text-center">
                        <ReviewMark
                          needsReview={r.confidence < 0.7}
                          reviewed={!!r.reviewed}
                          onToggle={() => toggleReviewed("receipt", r.id)}
                        />
                      </td>
                      {RECEIPT_COLUMNS.map((c) => (
                        <td key={c.key} className="px-1 py-1" title={c.key === "amount" && r.amount_reading ? `AIの読み上げ過程: ${r.amount_reading}` : undefined}>
                          {c.key === "qualified" ? (
                            <select value={r.qualified === true ? "y" : r.qualified === false ? "n" : ""}
                              onChange={(e) => updateRow("receipt", r.id, "qualified", e.target.value === "y" ? true : e.target.value === "n" ? false : null)}
                              className="w-full rounded border border-transparent bg-transparent px-1 py-1 hover:border-slate-300 focus:border-slate-500 focus:outline-none">
                              <option value="">-</option><option value="y">適格</option><option value="n">非適格</option>
                            </select>
                          ) : (
                            <input value={r[c.key] ?? ""} onChange={(e) => updateRow("receipt", r.id, c.key, e.target.value)}
                              className={`w-full rounded border border-transparent bg-transparent px-1 py-1 font-mono hover:border-slate-300 focus:border-slate-500 focus:bg-white focus:outline-none ${c.align === "right" ? "text-right" : ""}`} />
                          )}
                        </td>
                      ))}
                      <td className="whitespace-nowrap px-1 py-1 text-center">
                        <button onClick={() => { setCorrectionTarget({ kind: "receipt", id: r.id }); setCorrectionReason(""); }}
                          className="mr-1 rounded border border-indigo-300 px-1.5 py-0.5 text-[10px] text-indigo-600 hover:bg-indigo-50">学習</button>
                        <button onClick={() => removeRow("receipt", r.id)} className="text-slate-300 hover:text-red-500">✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

          {mode === "ledger" && (ledgerRows.length === 0 ? (
            <EmptyBox text="帳簿の写真やPDFを読み込むと、ここに明細と検算結果が表示されます" />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
              <table className="w-full min-w-[860px] text-xs">
                <thead>
                  <tr className="border-b-2 border-slate-900 bg-slate-100 text-left">
                    <th className="w-8 px-2 py-2 font-semibold">#</th>
                    <th className="w-10 px-2 py-2 font-semibold">確認</th>
                    {LEDGER_COLUMNS.map((c) => <th key={c.key} className={`px-2 py-2 font-semibold ${c.width}`}>{c.label}</th>)}
                    <th className="w-32 px-2 py-2 font-semibold">検算</th>
                    <th className="w-14 px-2 py-2 font-semibold">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleLedgerRows.map((r) => {
                    const i = ledgerRows.indexOf(r);
                    const c = chain[r.id] || {};
                    return (
                      <tr key={r.id} className={`border-b border-slate-100 ${!needsLedgerReview(r) ? "" : c.status === "mismatch" ? "bg-red-50" : "bg-amber-50"}`}>
                        <td className="px-2 py-1 font-mono text-slate-400">{i + 1}</td>
                        <td className="px-1 py-1 text-center">
                          <ReviewMark
                            needsReview={c.status === "mismatch" || r.confidence < 0.7}
                            reviewed={!!r.reviewed}
                            onToggle={() => toggleReviewed("ledger", r.id)}
                          />
                        </td>
                        {LEDGER_COLUMNS.map((col) => (
                          <td key={col.key} className="px-1 py-1">
                            <input value={r[col.key] ?? ""} onChange={(e) => updateRow("ledger", r.id, col.key, e.target.value)}
                              className={`w-full rounded border border-transparent bg-transparent px-1 py-1 font-mono hover:border-slate-300 focus:border-slate-500 focus:bg-white focus:outline-none ${col.align === "right" ? "text-right" : ""}`} />
                          </td>
                        ))}
                        <td className="px-2 py-1 font-mono text-[10px]">
                          {r.is_carryover || c.status === "start" ? <span className="text-slate-400">繰越</span>
                            : c.status === "ok" ? <span className="text-emerald-600">✓ OK</span>
                            : c.status === "mismatch" ? <span className="text-red-600">✗ 計算:{c.expected?.toLocaleString()}</span>
                            : <span className="text-slate-300">-</span>}
                        </td>
                        <td className="px-1 py-1 text-center">
                          <button onClick={() => { setCorrectionTarget({ kind: "ledger", id: r.id }); setCorrectionReason(""); }}
                            className="mr-1 rounded border border-indigo-300 px-1 py-0.5 text-[10px] text-indigo-600 hover:bg-indigo-50">学</button>
                          <button onClick={() => removeRow("ledger", r.id)} className="text-slate-300 hover:text-red-500">✕</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
          {mode === "ledger" && ledgerRows.length > 0 && (
            <p className="mt-1.5 text-[11px] text-slate-400">
              検算はシステムが機械的に実施 (残高空欄行は次の残高記載行まで収支を累積)。列入替が疑われ検算が一致する場合は自動補正し備考に記録。セル修正で即再検算。
            </p>
          )}
          {mode === "ledger" && ledgerRows.length > 0 && (
            <BenchPanel ledgerRows={ledgerRows} chain={chain} model={aiModel} />
          )}

          {mode === "excel" && (!excelReport ? (
            <EmptyBox text="Excel/CSVをアップロードすると、ここに検算レポートが表示されます" />
          ) : (
            <div>
              <div className="mb-3 grid grid-cols-3 gap-2">
                <StatCard label="対象行数" value={excelReport.total} />
                <StatCard label="残高不一致" value={excelReport.mismatches} accent={excelReport.mismatches > 0 ? "red" : "green"} />
                <StatCard label="ファイル" value={excelReport.fileName} small />
              </div>
              {excelReport.mismatches === 0 ? (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-center text-sm text-emerald-700">
                  ✓ 全行の残高が収入・支払と一致しています
                </div>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
                  <table className="w-full min-w-[760px] text-xs">
                    <thead>
                      <tr className="border-b-2 border-slate-900 bg-slate-100 text-left">
                        {["行", "月日", "摘要", "収入", "支払", "記載残高", "計算残高", "差額"].map((h) => <th key={h} className="px-2 py-2 font-semibold">{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {excelReport.rows.filter((r) => r.status === "mismatch").map((r) => (
                        <tr key={r.id} className="border-b border-slate-100 bg-red-50">
                          <td className="px-2 py-1 font-mono">{r.rowNo}</td>
                          <td className="px-2 py-1">{r.date}</td>
                          <td className="px-2 py-1">{r.summary}</td>
                          <td className="px-2 py-1 text-right font-mono">{r.income?.toLocaleString() ?? ""}</td>
                          <td className="px-2 py-1 text-right font-mono">{r.payment?.toLocaleString() ?? ""}</td>
                          <td className="px-2 py-1 text-right font-mono">{r.balance?.toLocaleString() ?? ""}</td>
                          <td className="px-2 py-1 text-right font-mono text-red-600">{r.expected?.toLocaleString() ?? ""}</td>
                          <td className="px-2 py-1 text-right font-mono font-bold text-red-600">{r.diff > 0 ? "+" : ""}{r.diff?.toLocaleString() ?? ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="mt-1.5 text-[11px] text-slate-400">
                列の検出結果: 残高=列{excelReport.columnMap.balance + 1}
                {excelReport.columnMap.income !== null && excelReport.columnMap.income !== undefined && ` / 収入=列${excelReport.columnMap.income + 1}`}
                {excelReport.columnMap.payment !== null && excelReport.columnMap.payment !== undefined && ` / 支払=列${excelReport.columnMap.payment + 1}`}
                。検出が誤っている場合はお知らせください。
              </p>
            </div>
          ))}
        </section>

        {/* 訂正学習モーダル */}
        {correctionRow && (
          <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4" onClick={() => setCorrectionTarget(null)}>
            <div className="w-full max-w-lg rounded-lg bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
              <h3 className="mb-3 text-sm font-bold">訂正をAIに学習させる</h3>
              {getDiffs(correctionRow).length > 0 ? (
                <div className="mb-3 rounded border border-slate-200 bg-slate-50 p-3">
                  <p className="mb-1.5 text-[11px] font-semibold text-slate-500">検出された修正:</p>
                  <ul className="space-y-1 text-xs">
                    {getDiffs(correctionRow).map((d, i) => (
                      <li key={i}><span className="font-semibold">{d.label}</span>: <span className="mx-1 text-red-500 line-through">{d.oldValue}</span>→<span className="ml-1 font-semibold text-emerald-700">{d.newValue}</span></li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="mb-3 rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700">
                  表の値がまだ修正されていません。先にセルを正しい値に直すか、下のコメント欄に誤読内容を記入してください。
                </p>
              )}
              <label className="mb-1 block text-[11px] font-semibold text-slate-500">誤読の原因・気づいたこと (AIが教訓化します)</label>
              <textarea value={correctionReason} onChange={(e) => setCorrectionReason(e.target.value)}
                placeholder="例: 収入金額の列の数字を支払金額として読んでいた (列ズレ)" rows={3}
                className="mb-3 w-full rounded border border-slate-300 p-2 text-xs focus:border-slate-500 focus:outline-none" />
              <div className="flex justify-end gap-2">
                <button onClick={() => setCorrectionTarget(null)} className="rounded px-4 py-2 text-xs text-slate-500 hover:bg-slate-100">キャンセル</button>
                <button onClick={saveLesson} disabled={savingLesson}
                  className="rounded bg-indigo-600 px-4 py-2 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-40">
                  {savingLesson ? "教訓を生成中…" : "教訓として保存"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* STEP 3 */}
        <section>
          <div className="mb-2 flex items-baseline gap-2">
            <span className="font-mono text-xs text-slate-400">STEP 3</span>
            <h2 className="text-sm font-bold">{mode === "excel" ? "レポートを出力する" : "CSVを出力する"}</h2>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="flex flex-col gap-3 sm:flex-row">
              <button onClick={downloadCsv} disabled={!hasData()}
                className="rounded bg-slate-900 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-slate-700 disabled:opacity-30">
                CSVをダウンロード
              </button>
              <button onClick={copyCsv} disabled={!hasData()}
                className="rounded border border-slate-900 px-5 py-2.5 text-sm font-medium transition hover:bg-slate-900 hover:text-white disabled:opacity-30">
                CSVをコピー
              </button>
              <button onClick={sendSlackCsv} disabled={!hasData() || slackSending}
                className="rounded border border-emerald-700 px-5 py-2.5 text-sm font-medium text-emerald-700 transition hover:bg-emerald-700 hover:text-white disabled:opacity-30">
                {slackSending ? "送信中…" : "Slackへ送信"}
              </button>
            </div>
            {copyMsg && <p className="mt-2 text-xs text-emerald-700">{copyMsg}</p>}
            <p className="mt-3 text-[11px] leading-relaxed text-slate-400">
              CSVはExcel対応 (UTF-8 BOM付き)。帳簿モードのCSVには検算結果列が含まれます。
              「Slackへ送信」はサーバーに SLACK_WEBHOOK_URL が設定されている場合に使えます。
            </p>
            <p className="mt-1 text-[11px] text-slate-400">
              今セッションのAPI使用: 入力 {usage.inTok.toLocaleString()} / 出力 {usage.outTok.toLocaleString()} tokens
              {usage.inTok > 0 && estYen !== null && <> ・概算 約{estYen < 1 ? estYen.toFixed(2) : Math.round(estYen).toLocaleString()}円 (単価は要確認)</>}
              {usage.inTok > 0 && estYen === null && <> ・(このモデルの単価は未確認のため概算なし)</>}
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}

function LoginGate({ onSuccess }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    if (!pw) return;
    setBusy(true);
    setErr("");
    const res = await login(pw);
    if (res.ok) {
      setPassword(pw);
      onSuccess();
    } else {
      setErr(res.error || "ログインに失敗しました");
    }
    setBusy(false);
  }
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4" style={{ fontFamily: "'Hiragino Sans', 'Yu Gothic', sans-serif" }}>
      <form onSubmit={submit} className="w-full max-w-xs rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="mb-1 text-base font-bold text-slate-900">帳票読み取りツール</h1>
        <p className="mb-4 text-xs text-slate-500">共有パスワードを入力してください</p>
        <input
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          autoFocus
          className="mb-3 w-full rounded border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
        />
        {err && <p className="mb-3 text-xs text-red-600">{err}</p>}
        <button type="submit" disabled={busy || !pw}
          className="w-full rounded bg-slate-900 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40">
          {busy ? "確認中…" : "ログイン"}
        </button>
      </form>
    </div>
  );
}

function BenchPanel({ ledgerRows, chain, model }) {
  const [runs, setRuns] = useState([]);
  const [busy, setBusy] = useState(false);
  const gtRef = useRef(null);

  async function compare() {
    setBusy(true);
    try {
      if (!gtRef.current) {
        const r = await fetch("/bench/ledger-groundtruth.csv");
        if (!r.ok) throw new Error("正解データを取得できません");
        const lines = (await r.text()).replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean).slice(1);
        const balances = new Set(
          lines.map((l) => toNum(l.split(",")[4])).filter((v) => v !== null)
        );
        gtRef.current = { rowCount: lines.length, balances };
      }
      const gt = gtRef.current;
      const balances = ledgerRows.map((r) => toNum(r.balance)).filter((v) => v !== null);
      const hit = balances.filter((v) => gt.balances.has(v)).length;
      const okCnt = ledgerRows.filter((r) => chain[r.id]?.status === "ok").length;
      const misCnt = ledgerRows.filter((r) => chain[r.id]?.status === "mismatch").length;
      setRuns((p) => [
        ...p,
        {
          id: Date.now(),
          model,
          rows: ledgerRows.length,
          gtRows: gt.rowCount,
          okRate: okCnt + misCnt ? Math.round((100 * okCnt) / (okCnt + misCnt)) : 0,
          recall: gt.balances.size ? Math.round((100 * hit) / gt.balances.size) : 0,
          at: new Date().toLocaleTimeString(),
        },
      ]);
    } catch (e) {
      setRuns((p) => [...p, { id: Date.now(), error: e.message || "比較に失敗" }]);
    }
    setBusy(false);
  }

  return (
    <details className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
      <summary className="cursor-pointer text-xs font-semibold text-slate-600">
        📐 ベンチマーク: テスト帳簿の正解データと比較 (モデルA/B用)
      </summary>
      <p className="mt-2 text-[11px] text-slate-400">
        同梱のテスト帳簿 (2枚・71行) を読み込ませた状態で実行すると、正解データとの一致度を記録します。
        ヘッダーのモデルを切り替えて再読み込み→再実行すれば Claude と Gemini を並べて比較できます。
      </p>
      <button onClick={compare} disabled={busy}
        className="mt-2 rounded border border-slate-400 px-3 py-1.5 text-xs hover:bg-slate-100 disabled:opacity-40">
        {busy ? "比較中…" : "現在の表を正解データと比較"}
      </button>
      {runs.length > 0 && (
        <table className="mt-2 w-full text-[11px]">
          <thead>
            <tr className="border-b border-slate-300 text-left text-slate-500">
              <th className="py-1 pr-2">時刻</th><th className="pr-2">モデル</th><th className="pr-2">行数</th>
              <th className="pr-2">検算OK率</th><th className="pr-2">残高一致率</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className="border-b border-slate-100 font-mono">
                {r.error ? (
                  <td colSpan={5} className="py-1 text-red-600">{r.error}</td>
                ) : (
                  <>
                    <td className="py-1 pr-2">{r.at}</td>
                    <td className="pr-2">{r.model}</td>
                    <td className="pr-2">{r.rows}/{r.gtRows}</td>
                    <td className="pr-2">{r.okRate}%</td>
                    <td className="pr-2">{r.recall}%</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </details>
  );
}

function ReviewMark({ needsReview, reviewed, onToggle }) {
  if (reviewed) {
    return (
      <button onClick={onToggle} title="確認済み (クリックで戻す)"
        className="rounded-full border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 text-[11px] font-bold text-emerald-600 hover:bg-emerald-100">
        ✓
      </button>
    );
  }
  if (needsReview) {
    return (
      <button onClick={onToggle} title="要確認 (原本と照合したらクリックで確認済みに)"
        className="rounded-full border border-amber-400 bg-amber-100 px-1.5 py-0.5 text-[11px] font-bold text-amber-700 hover:bg-amber-200">
        ⚠
      </button>
    );
  }
  return (
    <button onClick={onToggle} title="クリックで確認済みマークを付ける"
      className="rounded-full border border-transparent px-1.5 py-0.5 text-[11px] text-slate-300 hover:border-slate-300 hover:text-slate-500">
      ○
    </button>
  );
}

function EmptyBox({ text }) {
  return <div className="rounded-lg border border-slate-200 bg-white py-10 text-center text-sm text-slate-400">{text}</div>;
}

function StatCard({ label, value, accent, small }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <p className="text-[10px] text-slate-400">{label}</p>
      <p className={`font-mono ${small ? "truncate text-xs" : "text-xl font-bold"} ${accent === "red" ? "text-red-600" : accent === "green" ? "text-emerald-600" : ""}`}>{value}</p>
    </div>
  );
}
