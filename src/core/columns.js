// 列定義 (画面・CSV・サーバーで共通)
export const RECEIPT_COLUMNS = [
  { key: "date", label: "日付", width: "w-28" },
  { key: "vendor", label: "店舗名 / 摘要", width: "w-44" },
  { key: "amount", label: "金額(税込)", width: "w-24", align: "right" },
  { key: "tax_rate", label: "税率", width: "w-16" },
  { key: "qualified", label: "適格", width: "w-14" },
  { key: "invoice_number", label: "インボイス番号", width: "w-40" },
  { key: "account", label: "勘定科目候補", width: "w-28" },
  { key: "note", label: "備考", width: "w-36" },
];

export const LEDGER_COLUMNS = [
  { key: "date", label: "月日", width: "w-20" },
  { key: "summary", label: "摘要", width: "w-56" },
  { key: "income", label: "収入金額", width: "w-24", align: "right" },
  { key: "payment", label: "支払金額", width: "w-24", align: "right" },
  { key: "balance", label: "差引残高", width: "w-28", align: "right" },
];

export const FIELD_LABELS = {
  date: "日付", vendor: "店舗名/摘要", amount: "金額", tax_rate: "税率",
  qualified: "適格", invoice_number: "インボイス番号", account: "勘定科目",
  note: "備考", summary: "摘要", income: "収入金額", payment: "支払金額", balance: "差引残高",
};

