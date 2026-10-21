// 共通ロジックのテスト: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { receiptRowsFromAiText, validateReceiptRow, snapshotReceiptOriginal } from "../src/core/receipt.js";
import { repairJson } from "../src/core/parse.js";
import { computeChain } from "../src/core/ledger.js";
import { buildReceiptCsv } from "../src/core/csv.js";

test("読み上げ結論と金額が食い違うと補正するが、AI原値は補正前のまま残す", () => {
  const text = JSON.stringify({ rows: [{ amount: 712600, amount_reading: "先頭:￥ 1,2,6,0,0 → 結論: 12600円", confidence: 0.9 }] });
  const { rows } = receiptRowsFromAiText(text);
  assert.equal(rows[0].ai_raw.amount, 712600);
  assert.equal(rows[0].auto.amount, 12600);
  assert.ok(rows[0].auto.confidence <= 0.5);
  assert.match(rows[0].auto.note, /AI出力不整合/);
});

test("validateReceiptRow は入力の行を変更しない", () => {
  const row = { amount: 712600, amount_reading: "結論: 12600円", confidence: 0.9 };
  const before = JSON.stringify(row);
  const { patch } = validateReceiptRow(row);
  assert.equal(JSON.stringify(row), before);
  assert.equal(patch.amount, 12600);
});

test("教訓用の差分の基準は補正後の値", () => {
  const { rows } = receiptRowsFromAiText(JSON.stringify({ rows: [{ amount: 712600, amount_reading: "結論: 12600円" }] }));
  assert.equal(snapshotReceiptOriginal(rows[0].auto).amount, 12600);
});

test("途中で切れたJSONを修復し、修復したことを返す", () => {
  const r = repairJson('{"rows":[{"d":"4/1","b":1},{"d":"4/2","b":2},{"d":"4/3"');
  assert.equal(r.data.rows.length, 2);
  assert.equal(r.repaired, true);
});

test("残高が空欄の行は収支を累積して次の記載行で検算する", () => {
  const c = computeChain([
    { id: 1, is_carryover: true, balance: 100000 },
    { id: 2, income: 300, balance: null },
    { id: 3, payment: 5000, balance: 95300 },
  ]);
  assert.equal(c[3].status, "ok");
});

test("領収書CSVに確認列が入る", () => {
  const csv = buildReceiptCsv([{ date: "2026-10-01", amount: 300, confidence: 0.5 }, { amount: 100, confidence: 0.9, reviewed: true }]);
  const lines = csv.replace(/^﻿/, "").split("\n");
  assert.match(lines[0], /確認$/);
  assert.match(lines[1], /要確認$/);
  assert.match(lines[2], /確認済$/);
});
