// 帳簿の検算・分割マージ・正規化 (DOM非依存)
import { toNum } from "./parse.js";

// 残高チェーン検算 (決定的・コード側で実施)
// 残高が空欄の行は収入/支払を累積し、次に残高が記載された行でまとめて検算する
export function computeChain(rows) {
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
export function rowNumEq(x, y) {
  const xb = toNum(x.balance), yb = toNum(y.balance);
  if (xb !== null && yb !== null) return xb === yb;
  if (xb !== null || yb !== null) return false;
  const xi = toNum(x.income), xp = toNum(x.payment);
  const yi = toNum(y.income), yp = toNum(y.payment);
  if (xi === null && xp === null && yi === null && yp === null) return false;
  return (xi === yi && xp === yp) || (xi === yp && xp === yi);
}

// 分割パーツのマージ (オーバーラップ重複を数値署名で除去)
export function mergeLedgerParts(a, b) {
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
export function normalizeLedgerRows(rows) {
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

