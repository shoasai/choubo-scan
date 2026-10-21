// 案件 API (仕様書 v0.4 §3〜§5.4)
//   GET    /api/batches                         一覧
//   POST   /api/batches                         画面で読み取った結果を案件として保存 (submission_id で二重登録防止)
//   GET    /api/batches/:id                     案件と行・画像・警告・出力
//   PUT    /api/batches/:id/items               途中保存 (rev で同時編集を検知)
//   POST   /api/batches/:id/confirm             確定 (条件を満たすときだけ。版ごとにスナップショット)
//   POST   /api/batches/:id/reopen              確定の取り消し
//   GET    /api/batches/:id/exports/:eid/csv    出力のスナップショットからCSV
import { buildReceiptCsv } from "../../src/core/csv.js";
import { json } from "../../functions/api/_lib.js";

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const parse = (s, fallback = null) => {
  if (s === null || s === undefined) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
};

// 要確認: 削除されておらず、確認マークがなく、確度が 0.7 未満 (画面の needsReceiptReview と同じ基準)
const needsReview = (it) => !it.deleted && !it.reviewed && (it.confidence ?? 1) < 0.7;

function itemOut(r) {
  return {
    id: r.id,
    seq: r.seq,
    file_id: r.file_id,
    run_id: r.run_id,
    ai_raw: parse(r.ai_raw),
    auto: parse(r.auto, {}),
    current: parse(r.current, {}),
    warnings: parse(r.warnings, []),
    confidence: r.confidence,
    reviewed: !!r.reviewed,
    edited: !!r.edited,
    deleted: !!r.deleted,
    updated_at: r.updated_at,
  };
}

export async function listBatches(env) {
  const { results } = await env.DB.prepare(
    `SELECT b.id, b.title, b.source, b.kind, b.upload_state, b.review_state, b.rev, b.created_at, b.updated_at,
            c.name AS client_name,
            (SELECT COUNT(*) FROM items i WHERE i.batch_id = b.id AND i.deleted = 0) AS item_count,
            (SELECT COUNT(*) FROM items i WHERE i.batch_id = b.id AND i.deleted = 0 AND i.reviewed = 0 AND COALESCE(i.confidence, 1) < 0.7) AS review_count,
            (SELECT COUNT(*) FROM batch_warnings w WHERE w.batch_id = b.id AND w.resolved = 0) AS warning_count
       FROM batches b LEFT JOIN clients c ON c.id = b.client_id
      ORDER BY b.updated_at DESC LIMIT 100`
  ).all();
  return json({ batches: results });
}

// 画面で読み取った結果を案件として保存する。
// body: { submission_id, title, kind, client_id?, items: [{ ai_raw, auto, current?, confidence, reviewed?, deleted? }], warnings?: [{code, message}] }
export async function createBatch(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.items) || !body.submission_id) {
    return json({ error: "submission_id と items が必要です" }, 400);
  }
  if (body.items.length > 500) return json({ error: "行数が多すぎます (500行まで)" }, 413);

  // 同じ submission_id の再送なら、既存の案件を返す (二重登録しない)
  const existing = await env.DB.prepare("SELECT id, rev FROM batches WHERE submission_id = ?").bind(body.submission_id).first();
  if (existing) return json({ id: existing.id, rev: existing.rev, duplicate: true });

  const id = uid();
  const t = now();
  const stmts = [
    env.DB.prepare(
      `INSERT INTO batches (id, client_id, source, submission_id, title, kind, upload_state, review_state, rev, created_at, updated_at)
       VALUES (?, ?, 'staff', ?, ?, ?, 'complete', 'pending', 1, ?, ?)`
    ).bind(id, body.client_id || null, body.submission_id, body.title || null, body.kind || "receipt", t, t),
  ];
  body.items.forEach((it, i) => {
    const auto = it.auto || {};
    const current = it.current || auto;
    const edited = JSON.stringify(current) !== JSON.stringify(auto) ? 1 : 0;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO items (id, batch_id, seq, ai_raw, auto, current, warnings, confidence, reviewed, edited, deleted, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        uid(), id, i + 1,
        it.ai_raw === undefined ? null : JSON.stringify(it.ai_raw),
        JSON.stringify(auto), JSON.stringify(current),
        JSON.stringify(it.warnings || []),
        typeof it.confidence === "number" ? it.confidence : null,
        it.reviewed ? 1 : 0, edited, it.deleted ? 1 : 0, t
      )
    );
  });
  for (const w of body.warnings || []) {
    stmts.push(
      env.DB.prepare(
        "INSERT INTO batch_warnings (id, batch_id, code, message, resolved, created_at) VALUES (?, ?, ?, ?, 0, ?)"
      ).bind(uid(), id, String(w.code || "other"), String(w.message || ""), t)
    );
  }
  try {
    await env.DB.batch(stmts); // 1つのトランザクションで登録
  } catch (e) {
    // 同時に同じ submission_id が届いた場合は一意制約で片方が失敗する → 既存を返す
    const dup = await env.DB.prepare("SELECT id, rev FROM batches WHERE submission_id = ?").bind(body.submission_id).first();
    if (dup) return json({ id: dup.id, rev: dup.rev, duplicate: true });
    throw e;
  }
  return json({ id, rev: 1 }, 201);
}

export async function getBatch(env, id) {
  const batch = await env.DB.prepare(
    `SELECT b.*, c.name AS client_name FROM batches b LEFT JOIN clients c ON c.id = b.client_id WHERE b.id = ?`
  ).bind(id).first();
  if (!batch) return json({ error: "案件が見つかりません" }, 404);
  const [items, files, warnings, exports] = await Promise.all([
    env.DB.prepare("SELECT * FROM items WHERE batch_id = ? ORDER BY seq").bind(id).all(),
    env.DB.prepare(
      "SELECT id, seq, mime, bytes, state, attempts, error, detected_count, actual_count, count_checked FROM files WHERE batch_id = ? ORDER BY seq"
    ).bind(id).all(),
    env.DB.prepare("SELECT * FROM batch_warnings WHERE batch_id = ? ORDER BY created_at").bind(id).all(),
    env.DB.prepare("SELECT id, kind, version, batch_rev, state, created_at FROM exports WHERE batch_id = ? ORDER BY created_at").bind(id).all(),
  ]);
  return json({
    batch,
    items: items.results.map(itemOut),
    files: files.results,
    warnings: warnings.results,
    exports: exports.results,
  });
}

// 途中保存。body: { rev, changes: [{ id, current?, reviewed?, deleted? }] }
// 全ての更新は「案件の rev が送られた rev と一致し、確定済みでない」ときだけ適用される (1トランザクション)
export async function saveItems(request, env, id) {
  const body = await request.json().catch(() => null);
  if (!body || !Number.isInteger(body.rev) || !Array.isArray(body.changes)) {
    return json({ error: "rev と changes が必要です" }, 400);
  }
  const batch = await env.DB.prepare("SELECT rev, review_state FROM batches WHERE id = ?").bind(id).first();
  if (!batch) return json({ error: "案件が見つかりません" }, 404);
  if (batch.review_state === "confirmed") return json({ error: "確定済みの案件は編集できません", code: "locked" }, 409);
  if (batch.rev !== body.rev) {
    return json({ error: "他の人がこの案件を更新しました。最新の内容を読み込み直してください", code: "conflict", rev: batch.rev }, 409);
  }

  const t = now();
  const guard = "(SELECT rev FROM batches WHERE id = ?) = ? AND (SELECT review_state FROM batches WHERE id = ?) != 'confirmed'";
  const stmts = [];
  for (const c of body.changes) {
    if (!c || typeof c.id !== "string") continue;
    const sets = [];
    const binds = [];
    if (c.current !== undefined) {
      sets.push("current = ?", "edited = CASE WHEN ? != auto THEN 1 ELSE edited END");
      const cur = JSON.stringify(c.current);
      binds.push(cur, cur);
    }
    if (c.reviewed !== undefined) { sets.push("reviewed = ?"); binds.push(c.reviewed ? 1 : 0); }
    if (c.deleted !== undefined) { sets.push("deleted = ?"); binds.push(c.deleted ? 1 : 0); }
    if (sets.length === 0) continue;
    sets.push("updated_at = ?");
    binds.push(t);
    stmts.push(
      env.DB.prepare(`UPDATE items SET ${sets.join(", ")} WHERE id = ? AND batch_id = ? AND ${guard}`)
        .bind(...binds, c.id, id, id, body.rev, id)
    );
  }
  stmts.push(
    env.DB.prepare(
      "UPDATE batches SET rev = rev + 1, review_state = 'in_review', updated_at = ? WHERE id = ? AND rev = ? AND review_state != 'confirmed'"
    ).bind(t, id, body.rev)
  );
  const results = await env.DB.batch(stmts);
  if (results[results.length - 1].meta.changes === 0) {
    // 読み取りから保存までの間に別の保存が入った (この場合、行の更新も rev 条件で適用されていない)
    const latest = await env.DB.prepare("SELECT rev FROM batches WHERE id = ?").bind(id).first();
    return json({ error: "他の人がこの案件を更新しました。最新の内容を読み込み直してください", code: "conflict", rev: latest?.rev }, 409);
  }
  return json({ rev: body.rev + 1 });
}

// 確定の条件 (仕様書 v0.4 §5.4)
async function confirmBlockers(env, id, batch) {
  const reasons = [];
  if (batch.upload_state !== "complete") reasons.push("提出がまだ完了していません");
  const files = (await env.DB.prepare("SELECT state, count_checked FROM files WHERE batch_id = ?").bind(id).all()).results;
  const notDone = files.filter((f) => f.state !== "done").length;
  if (notDone) reasons.push(`読み取りが完了していない画像が ${notDone} 枚あります`);
  const unchecked = files.filter((f) => !f.count_checked).length;
  if (unchecked) reasons.push(`枚数の照合が済んでいない画像が ${unchecked} 枚あります`);
  const w = await env.DB.prepare("SELECT COUNT(*) AS n FROM batch_warnings WHERE batch_id = ? AND resolved = 0").bind(id).first();
  if (w.n) reasons.push(`未解決の警告が ${w.n} 件あります`);
  const items = (await env.DB.prepare("SELECT confidence, reviewed, deleted FROM items WHERE batch_id = ?").bind(id).all()).results;
  const pending = items.filter(needsReview).length;
  if (pending) reasons.push(`要確認の行が ${pending} 件あります`);
  return reasons;
}

// 確定。body: { rev }  ※ rev は画面が保存済みの版。未保存の変更があれば画面側で先に保存する
export async function confirmBatch(request, env, id) {
  const body = await request.json().catch(() => null);
  if (!body || !Number.isInteger(body.rev)) return json({ error: "rev が必要です" }, 400);
  const batch = await env.DB.prepare("SELECT * FROM batches WHERE id = ?").bind(id).first();
  if (!batch) return json({ error: "案件が見つかりません" }, 404);
  if (batch.review_state === "confirmed") return json({ error: "すでに確定済みです", code: "locked" }, 409);
  if (batch.rev !== body.rev) {
    return json({ error: "保存されていない変更があるか、他の人が更新しました。保存・再読み込みしてから確定してください", code: "conflict", rev: batch.rev }, 409);
  }
  const reasons = await confirmBlockers(env, id, batch);
  if (reasons.length) return json({ error: "確定できません", code: "blocked", reasons }, 422);

  const items = (await env.DB.prepare("SELECT * FROM items WHERE batch_id = ? AND deleted = 0 ORDER BY seq").bind(id).all()).results;
  const snapshot = items.map((r) => ({
    item_id: r.id,
    ...parse(r.current, {}),
    confidence: r.confidence,
    reviewed: !!r.reviewed,
  }));
  const prev = await env.DB.prepare("SELECT MAX(version) AS v FROM exports WHERE batch_id = ? AND kind = 'confirmed'").bind(id).first();
  const version = (prev?.v || 0) + 1;
  const exportId = uid();
  const t = now();
  const results = await env.DB.batch([
    env.DB.prepare(
      "UPDATE batches SET review_state = 'confirmed', confirmed_rev = rev, updated_at = ? WHERE id = ? AND rev = ? AND review_state != 'confirmed'"
    ).bind(t, id, body.rev),
    env.DB.prepare(
      `INSERT INTO exports (id, batch_id, kind, version, batch_rev, snapshot, state, created_at)
       SELECT ?, ?, 'confirmed', ?, ?, ?, 'pending', ? WHERE (SELECT confirmed_rev FROM batches WHERE id = ?) = ?`
    ).bind(exportId, id, version, body.rev, JSON.stringify(snapshot), t, id, body.rev),
  ]);
  if (results[0].meta.changes === 0 || results[1].meta.changes === 0) {
    return json({ error: "他の操作と重なったため確定できませんでした。再読み込みしてください", code: "conflict" }, 409);
  }
  return json({ export_id: exportId, version, rows: snapshot.length });
}

// 確定の取り消し (確認中に戻す)。確定時の出力は残す
export async function reopenBatch(request, env, id) {
  const body = await request.json().catch(() => null);
  if (!body || !Number.isInteger(body.rev)) return json({ error: "rev が必要です" }, 400);
  const r = await env.DB.prepare(
    "UPDATE batches SET review_state = 'in_review', rev = rev + 1, updated_at = ? WHERE id = ? AND rev = ? AND review_state = 'confirmed'"
  ).bind(now(), id, body.rev).run();
  if (r.meta.changes === 0) return json({ error: "取り消せませんでした。再読み込みしてください", code: "conflict" }, 409);
  return json({ rev: body.rev + 1 });
}

export async function exportCsv(env, id, exportId) {
  const ex = await env.DB.prepare("SELECT kind, version, snapshot FROM exports WHERE id = ? AND batch_id = ?").bind(exportId, id).first();
  if (!ex) return json({ error: "出力が見つかりません" }, 404);
  const csv = buildReceiptCsv(parse(ex.snapshot, []));
  // ブラウザのダウンロード名は英数字にする (一部環境で日本語名が "download" になるため)。Drive 保存時の名前は別途 (仕様書 §5.6)
  const prefix = ex.kind === "confirmed" ? `confirmed_v${ex.version}` : "draft";
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${prefix}_${id.slice(0, 8)}.csv`)}`,
    },
  });
}

// 警告を「確認済み」にする (内容を確認したうえで人が解決する)
export async function resolveWarning(env, id, warningId) {
  const r = await env.DB.prepare(
    `UPDATE batch_warnings SET resolved = 1 WHERE id = ? AND batch_id = ?
       AND (SELECT review_state FROM batches WHERE id = ?) != 'confirmed'`
  ).bind(warningId, id, id).run();
  if (r.meta.changes === 0) return json({ error: "警告が見つからないか、案件が確定済みです" }, 409);
  return json({ ok: true });
}
