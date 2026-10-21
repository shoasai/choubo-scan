// CSV 生成 (画面の出力・Drive 出力で共通)
import { RECEIPT_COLUMNS, LEDGER_COLUMNS } from "./columns.js";

export function csvEscape(v) {
  if (v === null || v === undefined) v = "";
  v = String(v).replace(/"/g, '""');
  return /[",\n]/.test(v) ? `"${v}"` : v;
}

export function buildReceiptCsv(rows) {
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

export function buildLedgerCsv(rows, chain) {
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

export function buildExcelReportCsv(report) {
  const header = "行番号,月日,摘要,収入,支払,記載残高,計算残高,差額,判定";
  const lines = report.rows.map((r) =>
    [r.rowNo, r.date, r.summary, r.income, r.payment, r.balance, r.expected ?? "", r.diff ?? "", r.status === "mismatch" ? "不一致" : r.status === "start" ? "繰越" : r.status === "ok" ? "OK" : "-"]
      .map(csvEscape).join(",")
  );
  return "﻿" + [header, ...lines].join("\n");
}

