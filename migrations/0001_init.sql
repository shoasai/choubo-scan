-- 帳票読み取りツール 実証用スキーマ (仕様書 v0.4 §3)
-- JSON は TEXT で保存する。日時は ISO 8601 文字列 (UTC)

-- 顧問先
CREATE TABLE clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,                      -- 表示名 (アップロード画面の「〇〇様 専用」)
  upload_token_hash TEXT UNIQUE,           -- 受付トークンの SHA-256。トークン本体は保存しない
  drive_folder_id TEXT,                    -- Drive の保存先フォルダ
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- 案件 (1回の提出、または事務所が画面から保存した読み取り結果)
CREATE TABLE batches (
  id TEXT PRIMARY KEY,
  client_id TEXT REFERENCES clients(id),
  source TEXT NOT NULL,                    -- 'upload' | 'staff'
  submission_id TEXT UNIQUE,               -- 受付ID。同じ提出の再送では同じ値 → 二重登録しない
  title TEXT,
  kind TEXT NOT NULL DEFAULT 'receipt',    -- 'receipt' (実証の対象)
  upload_state TEXT NOT NULL,              -- 'receiving' | 'complete'
  expected_files INTEGER,                  -- 提出予定の画像数
  review_state TEXT NOT NULL,              -- 'pending' | 'in_review' | 'confirmed'
  rev INTEGER NOT NULL DEFAULT 1,          -- 版番号。保存のたびに +1 (同時編集の検知)
  confirmed_rev INTEGER,                   -- 確定した時点の版
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_batches_client ON batches(client_id, created_at);
CREATE INDEX idx_batches_review ON batches(review_state, updated_at);

-- 画像 (1提出に複数)
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batches(id),
  seq INTEGER NOT NULL,                    -- 提出内の順番。受付ID+順番で一意 → 再送で二重登録しない
  original_key TEXT,                       -- R2: 加工前の元画像
  ocr_key TEXT,                            -- R2: OCR用に縮小した画像
  mime TEXT,
  bytes INTEGER,
  sha256 TEXT,
  state TEXT NOT NULL,                     -- 'uploaded' | 'queued' | 'processing' | 'done' | 'failed'
  current_run_id TEXT,                     -- 現在有効な処理実行ID。これと一致する処理だけが結果を保存できる
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  detected_count INTEGER,                  -- AIが検出したレシート枚数
  actual_count INTEGER,                    -- 人が数えた実際の枚数
  count_checked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (batch_id, seq)
);
CREATE INDEX idx_files_sha ON files(sha256);

-- 読み取りの実行 (画像ごと・試行ごと)
CREATE TABLE ocr_runs (
  id TEXT PRIMARY KEY,                     -- 処理実行ID
  file_id TEXT REFERENCES files(id),
  batch_id TEXT NOT NULL REFERENCES batches(id),
  model TEXT,
  prompt_version TEXT,
  lessons_json TEXT,                       -- 適用した教訓の [{id, text}] (本文ごと保存)
  stop_reason TEXT,
  repaired INTEGER NOT NULL DEFAULT 0,     -- JSON修復の有無
  raw_text TEXT,                           -- AIの応答テキスト
  state TEXT NOT NULL,                     -- 'running' | 'done' | 'failed' | 'stale'
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

-- 行
CREATE TABLE items (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batches(id),
  file_id TEXT REFERENCES files(id),
  run_id TEXT REFERENCES ocr_runs(id),
  seq INTEGER NOT NULL,
  ai_raw TEXT,                             -- AIの原値 (補正前)
  auto TEXT NOT NULL,                      -- 検証・補正後の初期値 (人の編集前)
  current TEXT NOT NULL,                   -- 人が編集した現在値
  warnings TEXT,                           -- 補正・検証の警告 [文字列]
  confidence REAL,
  reviewed INTEGER NOT NULL DEFAULT 0,     -- 確認マーク
  edited INTEGER NOT NULL DEFAULT 0,       -- 人が一度でも値を変えたか (再処理の可否判定に使う)
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_items_batch ON items(batch_id, seq);
CREATE INDEX idx_items_file ON items(file_id);

-- 案件の警告 (出力途切れ・JSON修復・読み取り失敗・枚数不一致など)
CREATE TABLE batch_warnings (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batches(id),
  file_id TEXT REFERENCES files(id),
  code TEXT NOT NULL,                      -- 'truncated' | 'json_repaired' | 'ocr_failed' | 'count_mismatch' など
  message TEXT,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_warnings_batch ON batch_warnings(batch_id, resolved);

-- 教訓
CREATE TABLE lessons (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,                     -- 'client' | 'global'
  client_id TEXT REFERENCES clients(id),
  text TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  source_item_id TEXT,
  origin TEXT,                             -- 'review' | 'imported_local'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 出力 (未確認/確定) と、Driveへのファイル単位の転送
CREATE TABLE exports (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batches(id),
  kind TEXT NOT NULL,                      -- 'draft' | 'confirmed'
  version INTEGER NOT NULL,                -- 確定ごとに 1, 2, ... (上書きしない)
  batch_rev INTEGER NOT NULL,              -- どの版から作ったか
  snapshot TEXT NOT NULL,                  -- 出力時点の行データ
  state TEXT NOT NULL,                     -- 'pending' | 'sending' | 'sent' | 'failed'
  created_at TEXT NOT NULL,
  UNIQUE (batch_id, kind, version)
);

CREATE TABLE export_files (
  id TEXT PRIMARY KEY,
  export_id TEXT NOT NULL REFERENCES exports(id),
  name TEXT NOT NULL,
  source_key TEXT,                         -- R2 のキー (画像) / NULL ならCSV (snapshot から生成)
  drive_file_id TEXT,                      -- Drive の事前生成ID。再送でも同じIDで作る
  state TEXT NOT NULL,                     -- 'pending' | 'sent' | 'failed'
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  updated_at TEXT NOT NULL
);
