// 案件APIの通し確認 (ローカル専用)。
//   1) npx wrangler d1 migrations apply DB --local
//   2) .dev.vars に APP_PASSWORD=devpass を書いて npx wrangler dev
//   3) npm run test:e2e
// 本番やリモートD1には向けないこと (テスト案件が作られます)
const B = process.env.E2E_BASE || "http://127.0.0.1:8787";
const H = { "Content-Type": "application/json", "x-app-password": process.env.E2E_PASSWORD || "devpass" };
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(B)) { console.error("ローカル以外には実行しません: " + B); process.exit(1); }
const call = async (method, path, body, headers = H) => {
  const r = await fetch(B + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch { d = t; }
  return { s: r.status, d };
};
const check = (name, cond, extra = "") => { console.log(`${cond ? "OK " : "NG "} ${name}${extra ? "  " + extra : ""}`); if (!cond) process.exitCode = 1; };

// 0. 認証なし
check("認証なしは401", (await call("GET", "/api/batches", null, {})).s === 401);
check("未知のAPIは404", (await call("GET", "/api/nope")).s === 404);

// 1. 作成 (要確認1件を含む)
const sub = crypto.randomUUID();
const items = [
  { ai_raw: { amount: 712600 }, auto: { date: "2026-07-02", vendor: "協会", amount: 12600, confidence: 0.5 }, confidence: 0.5 },
  { ai_raw: { amount: 10200 }, auto: { date: "2026-07-02", vendor: "書店", amount: 10200, confidence: 0.95 }, confidence: 0.95 },
];
const c1 = await call("POST", "/api/batches", { submission_id: sub, title: "テスト案件", items, warnings: [{ code: "json_repaired", message: "JSON修復あり" }] });
check("作成は201", c1.s === 201, JSON.stringify(c1.d));
const id = c1.d.id;
// 2. 同じ submission_id の再送
const c2 = await call("POST", "/api/batches", { submission_id: sub, title: "テスト案件", items });
check("再送は同じ案件 (二重登録なし)", c2.d.id === id && c2.d.duplicate === true);

// 3. 取得 (別端末で開く)
let g = await call("GET", `/api/batches/${id}`);
check("取得: 2行", g.d.items.length === 2);
check("AI原値は補正前のまま", g.d.items[0].ai_raw.amount === 712600 && g.d.items[0].current.amount === 12600);
check("警告が永続化されている", g.d.warnings.length === 1 && g.d.warnings[0].code === "json_repaired");

// 4. 途中保存 (端末A: rev1 → 2)
const it1 = g.d.items[0];
const s1 = await call("PUT", `/api/batches/${id}/items`, { rev: 1, changes: [{ id: it1.id, current: { ...it1.current, vendor: "大蔵財務協会" }, reviewed: true }] });
check("途中保存は成功し rev=2", s1.s === 200 && s1.d.rev === 2);

// 5. 同時編集 (端末Bは古い rev=1 で保存しようとする)
const s2 = await call("PUT", `/api/batches/${id}/items`, { rev: 1, changes: [{ id: it1.id, current: { ...it1.current, vendor: "上書きされてはいけない" } }] });
check("古い版での保存は409で止まる", s2.s === 409 && s2.d.code === "conflict");
g = await call("GET", `/api/batches/${id}`);
check("端末Aの修正が残っている (再表示)", g.d.items[0].current.vendor === "大蔵財務協会" && g.d.items[0].reviewed && g.d.items[0].edited);
check("確認状態は確認中", g.d.batch.review_state === "in_review");

// 6. 確定: 未解決の警告があるので止まる
const f1 = await call("POST", `/api/batches/${id}/confirm`, { rev: 2 });
check("未解決の警告があると確定できない (422)", f1.s === 422 && f1.d.reasons.some((r) => r.includes("警告")), JSON.stringify(f1.d.reasons));

// 7. 警告を解決 → 確定
const wid = g.d.warnings[0].id;
check("警告の解決", (await call("POST", `/api/batches/${id}/warnings/${wid}/resolve`)).s === 200);
const f2 = await call("POST", `/api/batches/${id}/confirm`, { rev: 2 });
check("条件を満たすと確定できる (版1)", f2.s === 200 && f2.d.version === 1 && f2.d.rows === 2, JSON.stringify(f2.d));
// 8. 確定後は編集・二重確定ができない
check("確定後の編集は409(locked)", (await call("PUT", `/api/batches/${id}/items`, { rev: 2, changes: [{ id: it1.id, reviewed: false }] })).d.code === "locked");
check("二重確定は409", (await call("POST", `/api/batches/${id}/confirm`, { rev: 2 })).s === 409);
// 9. 確定CSVは画面の値 (保存した版) と一致
const csv1 = await fetch(`${B}/api/batches/${id}/exports/${f2.d.export_id}/csv`, { headers: H }).then((r) => r.text());
check("確定CSVに修正値が入っている", csv1.includes("大蔵財務協会") && csv1.includes("12600") && !csv1.includes("上書きされてはいけない"));
// 10. 確定の取り消し → 修正 → 再確定で版2 (版1は残る)
const r1 = await call("POST", `/api/batches/${id}/reopen`, { rev: 2 });
check("確定の取り消し (rev=3)", r1.s === 200 && r1.d.rev === 3);
g = await call("GET", `/api/batches/${id}`);
const it2 = g.d.items[1];
await call("PUT", `/api/batches/${id}/items`, { rev: 3, changes: [{ id: it2.id, current: { ...it2.current, amount: 10300 } }] });
const f3 = await call("POST", `/api/batches/${id}/confirm`, { rev: 4 });
check("再確定は版2として別に保存", f3.s === 200 && f3.d.version === 2);
g = await call("GET", `/api/batches/${id}`);
check("出力は版1と版2の2件が残る", g.d.exports.filter((e) => e.kind === "confirmed").length === 2);
const csv1again = await fetch(`${B}/api/batches/${id}/exports/${f2.d.export_id}/csv`, { headers: H }).then((r) => r.text());
check("版1のCSVは再確定後も変わらない", csv1again === csv1);
// 11. 一覧
const l = await call("GET", "/api/batches");
check("一覧に出る", l.d.batches.some((b) => b.id === id && b.review_state === "confirmed"));
