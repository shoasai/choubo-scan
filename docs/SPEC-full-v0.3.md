# レシート撮影 → JDL連携 PWA 仕様書

**バージョン**: 0.3 (ドラフト)
**作成日**: 2026-05-10
**最終更新**: 2026-05-10
**対象**: 税理士事務所向け レシート OCR・JDL 入力補助 PWA

---

## 0. 実装方針の重要指示 (Claude Code 向け)

以下を優先して実装すること:

1. まずは「**1 枚撮影 → アップロード → AI 抽出 → 手動修正 → 確定 → CSV 出力**」の最短業務フローを完成させる
2. 複数枚一括撮影・OpenCV 自動分割は **β 機能** として後回しにする (Phase 3)
3. iPhone Safari では **Background Sync API を前提にしない**。アプリ起動時・画面復帰時・online イベント・手動再送を主経路にする
4. AI 抽出結果とスタッフ確定値は **別テーブル** で管理する (`receipt_ai_extractions` と `receipt_final_values`)
5. レシート画像は Supabase Storage の **private bucket** に保存し、表示時は **signed URL** を使う
6. 確定後すぐに削除予定を設定しない。**CSV 書き出し完了、または保管確認後** に削除予定を設定する
7. すべての重要操作について **`audit_logs` テーブル** に記録する
8. JDL CSV の列定義は **ハードコードせず、設定 JSON で差し替え可能** にする
9. Supabase service role key や AI API key は **フロントエンドに絶対に出さない**
10. まずは業務利用に耐える堅い PoC を優先し、便利機能は後回しにする

---

## 1. 概要

### 1.1 目的
税理士事務所と顧問先の双方で利用可能な、レシート撮影 → AI 抽出 → JDL CSV 書き出しを行う Web アプリ (PWA) を開発する。手書きレシートを含む日本語レシートを自動処理し、JDL インポート時の空白項目で弾かれる問題を解消する。

### 1.2 本アプリの位置付け
本アプリは **「JDL 入力補助システム」** であり、電子帳簿保存法上の正式な証憑保存システムではない。詳細は section 11「証憑保存責任の明確化」を参照。

### 1.3 スコープ
- iPhone Safari からの利用を前提とする PWA
- 顧問先による撮影 → 税理士事務所スタッフによる確認・確定 → CSV 書き出しの一連フロー
- **1 枚撮影モードを主経路**、複数枚一括撮影 + 自動分割は β 機能
- 国税庁適格請求書発行事業者公表サイト Web-API による T 番号自動照合
- JDL CSV 仕様への自動マッピング (設定 JSON で差し替え可能)
- データ最小化方針: 書き出し完了から 30 日後に自動削除。保管責任は税理士・顧問先側

### 1.4 対象外 (将来検討)
- ネイティブアプリ (iOS / Android)
- freee / マネーフォワードなど他会計ソフトへの連携
- 顧問先側での詳細な会計データ閲覧
- アプリ内での長期保存・集計

---

## 2. ユーザーロールと権限

| ロール | 説明 | 主な権限 |
|---|---|---|
| `client_user` | 顧問先の経理担当者など | 撮影・送信、自分が撮影したレシートの閲覧、確定前のみ修正可能 |
| `staff` | 税理士事務所スタッフ | 担当顧問先の全レシート閲覧・修正・確定、CSV 書き出し |
| `admin` | 税理士事務所管理者 | スタッフ機能 + 顧問先招待・管理、Google Sheets 連携設定、設定 JSON 管理 |

> **将来拡張**: `staff_client_assignments` テーブルを将来追加し、スタッフごとに担当顧問先を制限可能にする。初期版は全スタッフが自 tenant 配下の全顧問先にアクセス可。

---

## 3. レシートの状態遷移

```
pending          ← アップロード直後
   ↓
extracted        ← AI 抽出済み
   ↓
reviewed         ← スタッフが画面で確認 (任意ステータス)
   ↓
confirmed        ← スタッフが確定
   ↓
exported         ← CSV 書き出し完了
   ↓
storage_confirmed ← (任意) 別システムへの正式保管確認済み
   ↓
delete_scheduled ← auto_delete_at 設定済み
   ↓
deleted          ← 物理削除完了
```

**重要**: `auto_delete_at` は `confirmed_at` ではなく **`exported_at` または `storage_confirmed_at` を基準** に設定する。確定したが書き出し忘れたレシートが消失する事故を防ぐため。

---

## 4. 主要フロー

### 4.1 顧問先 (client_user) の撮影フロー (Phase 1: 1 枚撮影)

```
1. PWA 起動 (ホーム画面アイコン)
2. 「レシートを撮影」タップ
3. iPhone カメラ起動 → 1 枚撮影
4. プレビュー → 確認 → 送信
   - オンライン: 即時アップロード
   - オフライン: IndexedDB にキューイング、復帰時に再送
5. 完了画面 (補足情報入力なし)
```

ホーム画面に常時表示:
```
未送信  N 枚
送信中  N 枚
送信済み N 枚
送信失敗 N 枚 (タップで手動再送)
```

### 4.2 顧問先 (client_user) の撮影フロー (Phase 3: 一括撮影 β)

```
1. 「一括撮影 (β)」タップ
2. レシートを机に並べて撮影
3. ブラウザ内 OpenCV.js で自動分割
4. 検出結果プレビュー
5. ❌ 検出失敗時 → 1 枚撮影モードへ誘導
6. ✅ 確認 → 一括送信
```

### 4.3 スタッフの確認・確定フロー

```
1. ダッシュボード → 顧問先別未処理件数確認
2. 顧問先選択 → レシート一覧
3. 各レシートを詳細画面で開く (Phase 1)
   - 左: レシート画像 (signed URL で表示)
   - 右: AI 抽出結果 + バリデーション結果
   - 修正・確定
4. 一覧画面で複数選択 → まとめて確定
5. 任意のタイミングで CSV 書き出し
6. (任意) 別システムへの保管完了後、「保管確認済み」マーク
   → これで auto_delete_at が設定される
```

### 4.4 CSV 書き出しフロー

```
1. 収支ビューで期間・顧問先・状態フィルタ
2. 「書き出し」ボタン
3. 形式選択: JDL 形式 (設定 JSON で定義) / 汎用 CSV / (Phase 3) Google Sheets
4. ダウンロード
5. 書き出し成功時、対象レシートを exported 状態に更新
   → CSV 書き出し完了から 30 日後に auto_delete_at を設定
```

---

## 5. 画面仕様

### 5.1 共通
- iPhone Safari (PWA) を主たるターゲット
- iPad / デスクトップでも崩れない
- ログイン: メールアドレス + ワンタイムコード (パスワードレス)

### 5.2 顧問先向け画面
| 画面 ID | 画面名 | 主要機能 |
|---|---|---|
| `C-01` | ホーム | 未送信・送信中・送信済み・失敗件数、撮影ボタン |
| `C-02` | 1 枚撮影 | カメラ起動、プレビュー、送信 |
| `C-03` | 一括撮影 (β、Phase 3) | 複数枚撮影、OpenCV 分割、検出失敗時は C-02 へ誘導 |
| `C-04` | 送信完了 | ホームへ戻る |
| `C-05` | 履歴 | 自分が送信したレシート一覧、確定前のみ修正可能 |

### 5.3 スタッフ向け画面
| 画面 ID | 画面名 | 主要機能 |
|---|---|---|
| `S-01` | ダッシュボード | 顧問先別の未処理件数、最終更新 |
| `S-02` | 撮影 | C-02 と同じ |
| `S-03` | レシート一覧 | フィルタ、選択、一括確定、書き出し |
| `S-04` | レシート詳細 | 画像 + 抽出結果の詳細編集 (**Phase 1 の主編集 UI**) |
| `S-05` | CSV 書き出し | 期間・形式選択、ダウンロード |
| `S-06` | 顧問先管理 (admin) | 招待、ロール設定、Google Sheets 連携、JDL 設定 JSON 管理 |
| `S-07` | 監査ログ (admin) | `audit_logs` 閲覧 |

### 5.4 レシート一覧 (`S-03`) 詳細

#### 表示列
| 列 | 表示内容 |
|---|---|
| 画像 | サムネイル (signed URL) |
| 日付 | `receipt_final_values.transaction_date` |
| 店舗名 | `receipt_final_values.vendor_name` |
| 金額 | `receipt_final_values.amount_total` |
| 適格 | アイコン表示 |
| 勘定科目 | コード + 名称 |
| 状態 | extracted / confirmed / exported など |
| 警告 | バリデーション失敗があれば赤マーク |

#### フィルタ
- 期間 (デフォルト: 今月)
- 勘定科目
- 適格 / 非適格
- 状態
- 警告あり / なし

#### 一括操作
- まとめて確定
- まとめて再 AI 処理 (別モデルで再試行)
- まとめて削除

#### 簡易集計カード (画面上部)
- 当期間の合計件数、合計金額、未確認件数、確定件数、警告件数
- **長期集計 (月次推移など) は実装しない**。CSV 書き出し先で実施

> **編集 UI 方針**: Phase 1 では詳細画面 (`S-04`) での編集のみ。インライン編集は Phase 3 以降に検討。

### 5.5 レシート詳細 (`S-04`) 詳細

#### 画面構成
```
+---------------------+----------------------+
|                     | AI 抽出結果 + 修正欄  |
|  レシート画像         |   日付 [____]        |
|  (signed URL)       |   店舗名 [____]       |
|                     |   金額 [____]         |
|                     |   税率 [▼]            |
|                     |   T 番号 [____] ✅照合済 |
|                     |   勘定科目 [▼]        |
|                     |   摘要 [____]         |
|                     |                      |
|                     | バリデーション警告:    |
|                     |  ⚠ 金額が読み取れていません │
|                     |                      |
|                     | [再 AI 処理] [確定]    |
+---------------------+----------------------+
```

各フィールドの修正は `receipt_final_values` テーブルに反映し、`receipt_edit_logs` に履歴を残す。

---

## 6. 技術スタック

| 領域 | 採用技術 | 備考 |
|---|---|---|
| フロントエンド | Astro + React 島構成 | 業務画面 (S-03, S-04 等) は実質 React SPA として実装 |
| ホスティング | Cloudflare Pages | Sho 既存スタックと整合 |
| PWA | Service Worker + Web App Manifest | iOS の制約を考慮 |
| 画像処理 (β) | OpenCV.js | Phase 3 で導入 |
| カメラ | `<input type="file" capture="environment">` 主、`getUserMedia` 補 | iPhone Safari 動作確認必須 |
| バックエンド | Cloudflare Workers (Hono) | 軽量 API |
| DB / ストレージ | Supabase (Postgres + Storage) | private bucket + signed URL |
| 認証 | Supabase Auth (Email OTP) | パスワードレス |
| 状態管理 | TanStack Query + Zustand | サーバ状態 + ローカル状態 |
| AI 抽出 (主) | Gemini 2.5 Flash | コスト最優先 |
| AI 抽出 (副) | Claude Sonnet 4.6 | バリデーション失敗時のフォールバック |
| 適格事業者照合 | 国税庁 Web-API | アプリケーション ID 取得必要 |
| 削除バッチ | Cloudflare Workers Cron Triggers | 冪等性確保 |
| オフラインキュー | IndexedDB | Background Sync は補助のみ |

> **Astro の使い方**: ルーティング・静的シェルに利用し、業務画面の大部分は React island として実装。S-03 / S-04 など複雑な画面は実質 React SPA として扱う。

---

## 7. データモデル (Supabase)

### 7.1 テーブル一覧

#### `tenants` (税理士事務所)
| カラム | 型 | 備考 |
|---|---|---|
| `id` | uuid PK | |
| `name` | text | 事務所名 |
| `created_at` | timestamptz | |

#### `clients` (顧問先)
| カラム | 型 | 備考 |
|---|---|---|
| `id` | uuid PK | |
| `tenant_id` | uuid FK → tenants | |
| `name` | text | 顧問先名 |
| `jdl_client_code` | text | JDL 内のクライアントコード |
| `jdl_csv_format_id` | uuid FK → jdl_csv_formats nullable | 適用する CSV 形式 |
| `gsheets_id` | text nullable | 連携先スプレッドシート ID |
| `default_storage_confirmation_required` | boolean default false | 削除前に保管確認を必須化するか |
| `created_at` | timestamptz | |

#### `users`
| カラム | 型 | 備考 |
|---|---|---|
| `id` | uuid PK | `auth.users.id` と一致 |
| `email` | text | |
| `tenant_id` | uuid FK nullable | スタッフのみ |
| `client_id` | uuid FK nullable | client_user のみ |
| `role` | text | client_user / staff / admin |

#### `receipts` (レシート本体メタ)
| カラム | 型 | 備考 |
|---|---|---|
| `id` | uuid PK | |
| `client_id` | uuid FK → clients | |
| `uploaded_by` | uuid FK → users | |
| `image_path` | text | Supabase Storage private bucket 内のパス |
| `image_thumbnail_path` | text | サムネイル |
| `image_hash` | text | 重複検出用 (sha256) |
| `status` | text | pending / extracted / reviewed / confirmed / exported / storage_confirmed / delete_scheduled / deleted |
| `extracted_at` | timestamptz nullable | |
| `confirmed_at` | timestamptz nullable | |
| `confirmed_by` | uuid FK nullable | |
| `exported_at` | timestamptz nullable | CSV 書き出し完了時刻 |
| `storage_confirmed_at` | timestamptz nullable | 別システム保管確認時刻 |
| `auto_delete_at` | timestamptz nullable | exported_at or storage_confirmed_at + 30 日 |
| `deletion_status` | text | none / scheduled / deleting / deleted / failed |
| `deletion_error` | text nullable | 削除失敗時のエラー |
| `deleted_at` | timestamptz nullable | |
| `created_at` | timestamptz | |

#### `receipt_ai_extractions` (AI 抽出の生記録、複数試行可)
| カラム | 型 | 備考 |
|---|---|---|
| `id` | uuid PK | |
| `receipt_id` | uuid FK → receipts | |
| `model` | text | gemini-2.5-flash / claude-sonnet-4-6 など |
| `prompt_version` | text | プロンプトのバージョン |
| `raw_response` | jsonb | モデルの生レスポンス |
| `parsed_result` | jsonb | パース後の構造化データ |
| `field_confidences` | jsonb | フィールドごとの AI 自己申告信頼度 |
| `validation_errors` | jsonb | ルールベース検証の失敗結果 |
| `created_at` | timestamptz | |

#### `receipt_final_values` (確定値、1 レシート 1 行)
| カラム | 型 | 備考 |
|---|---|---|
| `receipt_id` | uuid PK FK → receipts | |
| `transaction_date` | date | |
| `vendor_name` | text | |
| `amount_total` | integer | 円単位 |
| `tax_rate` | numeric | 0.08 / 0.10 / 0 |
| `is_qualified_invoice` | boolean | 適格判定 |
| `invoice_number` | text nullable | T+13 桁 |
| `invoice_number_verified` | boolean | 国税庁 API 照合済みフラグ |
| `account_code` | text | 勘定科目コード |
| `account_name` | text | 勘定科目名 |
| `description` | text | 摘要 |
| `confirmed_by` | uuid FK → users nullable | |
| `confirmed_at` | timestamptz nullable | |
| `updated_at` | timestamptz | |

#### `receipt_edit_logs` (修正履歴)
| カラム | 型 | 備考 |
|---|---|---|
| `id` | uuid PK | |
| `receipt_id` | uuid FK → receipts | |
| `field_name` | text | 修正されたフィールド名 |
| `old_value` | text | |
| `new_value` | text | |
| `edited_by` | uuid FK → users | |
| `edited_at` | timestamptz | |

#### `client_account_masters` (顧問先別の勘定科目マスタ)
| カラム | 型 | 備考 |
|---|---|---|
| `id` | uuid PK | |
| `client_id` | uuid FK → clients | |
| `account_code` | text | |
| `account_name` | text | |
| `tax_category` | text | 課税区分 |
| `keywords` | text[] | AI に渡す Few-shot 用キーワード |
| `is_active` | boolean | |
| `created_at` | timestamptz | |

#### `jdl_csv_formats` (JDL CSV 出力フォーマット定義)
| カラム | 型 | 備考 |
|---|---|---|
| `id` | uuid PK | |
| `name` | text | 例: jdl_ibex_suitochou_major |
| `tenant_id` | uuid FK nullable | NULL なら共通 |
| `column_definitions` | jsonb | 列定義 (下記参照) |
| `version` | text | フォーマット改版用 |
| `created_at` | timestamptz | |

`column_definitions` の例:
```json
{
  "format": "jdl_ibex_suitochou_major",
  "columns": [
    { "name": "date", "source": "transaction_date", "required": true, "format": "YYYYMMDD" },
    { "name": "debit_account_code", "source": "account_code", "required": true },
    { "name": "amount", "source": "amount_total", "required": true },
    { "name": "invoice_type", "source": "qualified_invoice_status", "required": true,
      "value_map": { "true": "1", "false": "0" } }
  ]
}
```

#### `csv_exports` (書き出し履歴)
| カラム | 型 | 備考 |
|---|---|---|
| `id` | uuid PK | |
| `client_id` | uuid FK | |
| `jdl_csv_format_id` | uuid FK | 使用したフォーマット |
| `format_version` | text | フォーマットのバージョン (履歴用) |
| `period_from` | date | |
| `period_to` | date | |
| `receipt_ids` | uuid[] | 含めたレシートの ID |
| `file_path` | text nullable | 書き出したファイルの一時保存パス |
| `exported_by` | uuid FK | |
| `exported_at` | timestamptz | |

#### `audit_logs` (監査ログ)
| カラム | 型 | 備考 |
|---|---|---|
| `id` | uuid PK | |
| `tenant_id` | uuid FK | |
| `user_id` | uuid FK | |
| `action` | text | login / view_receipt / edit_field / confirm / export / mark_storage_confirmed / delete など |
| `target_type` | text | receipt / client / user など |
| `target_id` | uuid nullable | |
| `metadata` | jsonb | 追加情報 |
| `created_at` | timestamptz | |

### 7.2 RLS (Row Level Security) ポリシー方針

```
- users.id は auth.users.id と一致させる
- client_user は自分の client_id に紐づく receipts のみ参照可能
- client_user は confirmed 以降のステータスのレシートを編集不可
- staff は自 tenant 配下の clients のレシートにアクセス可能
- admin は自 tenant 配下の users / clients / jdl_csv_formats を管理可能
- tenant_id / client_id の直接書き換えは禁止
- audit_logs への INSERT は全ユーザー可、UPDATE / DELETE はサーバー側のみ
```

将来追加予定: `staff_client_assignments` テーブルでスタッフ別の担当顧問先制限。

---

## 8. AI 抽出仕様

### 8.1 抽出項目

```json
{
  "transaction_date": "2026-04-15",
  "vendor_name": "スターバックス渋谷店",
  "amount_total": 1200,
  "tax_rate": 0.10,
  "is_qualified_invoice": true,
  "invoice_number": "T1234567890123",
  "account_code_suggestion": "5210",
  "account_name_suggestion": "会議費",
  "description": "",
  "field_confidences": {
    "transaction_date": 0.95,
    "vendor_name": 0.92,
    "amount_total": 0.99,
    "tax_rate": 0.85,
    "is_qualified_invoice": 0.90,
    "invoice_number": 0.88
  }
}
```

### 8.2 プロンプト設計指針
- システムプロンプトに「日本のレシート専門」「JSON のみで返答」「不明な項目は null」を明示
- `client_account_masters` を Few-shot として注入し、勘定科目候補の精度を上げる
- 「合計」「お預り」「お釣り」の区別ルールを明記
- 出力スキーマは Zod で検証

### 8.3 バリデーション (AI 信頼度とは別)

AI の自己申告信頼度は過信しない。**ルールベース検証** を必ず併用する:

```
- 合計金額が 0 または異常に大きい (例: 1,000 万円超)
- 日付が未来日
- 日付が 3 年以上前
- T 番号形式が T + 13 桁ではない
- 税率が 8% / 10% / 非課税以外
- 合計額と税額の整合性が明らかにおかしい
- 店舗名が空
- 金額だけ読めていて日付がない
```

検証失敗は `receipt_ai_extractions.validation_errors` に保存し、画面で警告表示。

### 8.4 モデル選定とフォールバック
1. **デフォルト**: Gemini 2.5 Flash
2. **バリデーション失敗あり** または **JSON パース失敗**: Claude Sonnet 4.6 で再実行
3. **両方失敗**: status = `pending`、スタッフ画面で「再 AI 処理」ボタン表示

> モデル選定は実物 30 枚での A/B テスト後に最終決定。プロンプト・パース処理は共通化し、モデル呼び出し部分だけ差し替え可能な設計とする。

### 8.5 国税庁 API 照合
- T 番号が抽出された場合、国税庁適格請求書発行事業者公表サイト Web-API を呼び出し
- 結果を `receipt_final_values.invoice_number_verified` に保存
- 検証結果はキャッシュ (T 番号 → 結果) して API 呼び出しを最小化
- 表示文言は「適格事業者として登録確認済み」とし、「適格請求書として正しい」と断定しない
- 失敗時のリトライ方針: 3 回まで指数バックオフ、最終失敗は警告フラグ

---

## 9. JDL CSV 書き出し仕様

### 9.1 整形ルール
- インボイス有無が空白だと弾かれる問題の対策:
  - T 番号があれば「適格」
  - T 番号がなければ「非適格」を強制設定 (空白を作らない)
- 勘定科目コードは `client_account_masters` で変換
- 税率: 8% / 10% / 非課税 を JDL のコード体系に変換
- 日付フォーマットは `jdl_csv_formats.column_definitions` で定義

### 9.2 設定 JSON 駆動
ハードコードせず、`jdl_csv_formats` テーブルで列定義を管理する。新フォーマットは admin が `S-06` から JSON で追加可能。

### 9.3 書き出し時の状態遷移
1. ユーザーが書き出し実行
2. 対象レシートを取得 → CSV 生成 → ダウンロード
3. 成功時、対象レシートを `exported` 状態に更新、`exported_at = now()` 設定
4. `auto_delete_at` の設定タイミングは section 11 参照
5. `audit_logs` に `action = export` を記録

---

## 10. オフライン対応仕様

### 10.1 要件
- 電波が悪い場所での撮影 → ローカル保存 → オンライン復帰時に送信

### 10.2 主経路 (iPhone Safari 前提)
1. アプリ起動時
2. 画面復帰時 (`visibilitychange` イベント)
3. `online` イベント発火時
4. ユーザーによる「未送信を送信」ボタン押下

### 10.3 補助経路 (対応ブラウザのみ)
- Background Sync API (Chrome / Edge on Android)

### 10.4 実装方針
1. Service Worker で PWA 化
2. 撮影画像を IndexedDB にキューイング
3. 上記主経路で順次 POST
4. UI に「未送信 N 枚 / 送信中 N 枚 / 送信済み N 枚 / 失敗 N 枚」を常時表示
5. 失敗時は手動再送ボタンで明示的に再送可能

### 10.5 注意点
- iPhone Safari の Background Sync は **使えない前提** で設計
- IndexedDB の容量制限 (一般に数百 MB) に注意
- 画像は分割後の小さい単位で保存

---

## 11. 証憑保存責任の明確化

### 11.1 本アプリの位置付け
本アプリは、原則として **会計入力補助・OCR 処理用の一時作業領域** であり、電子帳簿保存法上の正式な証憑保存システムとは位置付けない。

### 11.2 正式な証憑保存先
正式な証憑保存は以下のいずれかで行う:
1. 顧問先または税理士事務所が紙原本を保存する
2. 税理士事務所が別途、電子帳簿保存法対応ストレージに画像を保存する
3. JDL または他の証憑保存システムに画像を登録する

### 11.3 利用規約・画面表示への反映
- 利用規約に上記を明記
- アプリ画面 (S-04 詳細画面) に「本アプリは証憑保存システムではありません。原本または別途保管をお願いします」のバナーを常時表示
- 顧問先招待時のオンボーディングでも同様に通知

### 11.4 削除前の保管確認運用
- スタッフ画面で「保管確認済み」チェックが可能
- 顧問先別設定 `default_storage_confirmation_required` で「保管確認なしでも削除する」運用と「保管確認必須」運用を切り替え可能
- 保管確認なし運用でも、CSV 書き出し完了から 30 日後に削除されることを画面で明示

---

## 12. データライフサイクル管理

### 12.1 基本方針
本アプリは「業務処理の作業領域」と位置付け、長期データ保管はしない。**CSV 書き出し完了から 30 日 (または保管確認から 30 日) 後** に自動削除。

### 12.2 `auto_delete_at` の設定タイミング

| 顧問先設定 | 設定タイミング |
|---|---|
| `default_storage_confirmation_required = false` | CSV 書き出し成功時 `exported_at + 30 日` |
| `default_storage_confirmation_required = true` | スタッフが「保管確認済み」ボタン押下時 `storage_confirmed_at + 30 日` |

**重要**: `confirmed_at` を起点にしない。確定だけして書き出し忘れたレシートが消失する事故を防ぐため。

### 12.3 削除バッチ (Cloudflare Workers Cron)

#### 仕組み
1. 1 日 1 回実行
2. `auto_delete_at < now() AND deletion_status = 'none'` の receipts を取得
3. `deletion_status = 'scheduled'` に更新
4. 100 件ずつバッチ処理:
   - `deletion_status = 'deleting'` に更新
   - Supabase Storage から画像削除 (失敗時はリトライ 3 回)
   - 関連レコード削除: `receipt_ai_extractions` → `receipt_edit_logs` → `receipt_final_values` → `receipts`
   - `deletion_status = 'deleted'`, `deleted_at = now()` に更新
5. 失敗時は `deletion_status = 'failed'`, `deletion_error` にエラー保存 → 翌日リトライ
6. `csv_exports` レコードは削除しない (履歴・監査用)

#### 冪等性確保
- 各ステップで状態を更新し、途中失敗しても次回再開可能
- Storage 削除と DB 削除の整合性: まず Storage 削除 → 成功時のみ DB 削除
- 同じ Cron が重複起動しても `deletion_status = 'deleting'` のものはスキップ

#### 初期は論理削除も検討
- 本番運用開始から数ヶ月は、物理削除前に論理削除フェーズ (deleted フラグ立てて表示しない) を挟むことも検討

### 12.4 ユーザーへの通知
- スタッフ画面で「○日後に自動削除されます」を各レシートに表示
- 削除前日にダッシュボードへバナー通知

### 12.5 削除停止・延長
- スタッフが「削除保留」をチェックすると `auto_delete_at = NULL` に設定可能
- ただしデフォルトは 30 日で削除する運用方針を遵守

### 12.6 法令・規約上の確認事項
- 30 日保管期間が個人情報保護法・税理士会ガイドラインで問題ないか、税理士さんに確認
- 電子帳簿保存法上の保管責任は本アプリ外であることを利用規約に明記

---

## 13. 非機能要件

### 13.1 セキュリティ
- 全 API で認証必須
- tenant 境界を RLS で強制
- Storage 画像は **private bucket** に保存し、表示時は **signed URL** (短時間有効) で参照
- Supabase service role key および AI API key はフロントエンドに絶対に出さない (Cloudflare Workers 環境変数で管理)
- 国税庁 API のアプリケーション ID も Workers 環境変数で管理

### 13.2 監査ログ
以下を `audit_logs` に記録:
- ログイン / ログアウト
- レシート閲覧
- AI 再処理実行
- 手動修正 (フィールドごと、`receipt_edit_logs` と二重記録)
- 確定
- CSV 出力
- 保管確認済みマーク
- 削除保留設定
- 自動削除

### 13.3 エラー監視
以下のエラーを Sentry 等で監視:
- AI API 失敗
- CSV 出力失敗
- 国税庁 API 失敗
- Storage 削除失敗
- IndexedDB 同期失敗

### 13.4 パフォーマンス
- iPhone Safari で 1 枚撮影からアップロード完了まで **10 秒以内** を目標
- 一覧画面はページネーションまたは仮想スクロール
- 画像はサムネイル (長辺 300px) と原本を分けて保存

### 13.5 画像処理
- アップロード前にブラウザ側で長辺 1600〜2000px にリサイズし、JPEG (品質 85) で圧縮
- 圧縮率は実物テストで OCR 精度との兼ね合いで最終決定
- サムネイルは別途生成 (Cloudflare Images 等の利用も検討)

### 13.6 バックアップ
- Supabase Pro プランの自動バックアップに依存
- 削除前データの復元は原則不可 (運用ポリシーとして明示)
- 誤削除時の対応: バックアップから復元可否を Supabase ドキュメントで確認すること (確認が必要)

---

## 14. Google Sheets 連携 (オプション機能、Phase 3)

### 14.1 実装方針
- Phase 3 ではまず Google Apps Script (GAS) Webhook 方式で実装
- 本格運用時は Google Sheets API + Service Account 方式と比較検討

### 14.2 仕様
- 顧問先ごとに連携先スプレッドシート ID を `clients.gsheets_id` に保存
- レシート確定または CSV 書き出し時に行を追加
- シートのフォーマットは税理士側でカスタマイズ可能
- 長期集計はこちら側で実施することを前提とする

---

## 15. 段階的実装計画

### Phase 0: 業務・CSV 仕様確認 (実装着手前)
- [ ] 利用中の JDL 製品名を確定
- [ ] インポート対象メニューを確認
- [ ] 実際に JDL からサンプル CSV を書き出してもらう
- [ ] 必須列、任意列、空白不可列を確認
- [ ] 勘定科目コード、補助科目コード、税区分コードを確認
- [ ] 1 件だけ手作業で作った CSV を JDL に取り込んで検証
- [ ] 国税庁 Web-API のアプリケーション ID 取得
- [ ] AI モデル A/B テスト (実物 30 枚)
- [ ] 個人情報を Google / Anthropic に送信して良いか税理士さんに確認

### Phase 1: 最短業務フロー PoC (2〜3 週間)

Claude Code 向けに細分化:

- [ ] **Step 1**: Supabase schema (全テーブル) + RLS ポリシー
- [ ] **Step 2**: Auth (Email OTP) + ロールベースルーティング
- [ ] **Step 3**: 1 枚撮影 → アップロード (private bucket)
- [ ] **Step 4**: レシート一覧画面 (S-03 簡易版)
- [ ] **Step 5**: Gemini OCR 単体実行 + バリデーション
- [ ] **Step 6**: 抽出結果表示 (S-04 詳細画面)
- [ ] **Step 7**: 手動編集 + 確定 (`receipt_edit_logs` 記録)
- [ ] **Step 8**: 汎用 CSV 出力
- [ ] **Step 9**: JDL CSV 出力 (設定 JSON 駆動)
- [ ] **Step 10**: iPhone 実機で PWA 動作検証

**Phase 1 完了基準**: 1 枚撮影 → CSV 出力までの最短業務フローが税理士さんの手元で動く状態

### Phase 2: 業務利用版 (3〜4 週間)
- [ ] **Step 11**: IndexedDB 未送信キュー (iOS Safari 主経路)
- [ ] **Step 12**: 国税庁 API 照合 + キャッシュ
- [ ] **Step 13**: AI フォールバック (Gemini → Claude)
- [ ] **Step 14**: 監査ログ完全実装
- [ ] **Step 15**: signed URL での画像表示
- [ ] **Step 16**: 削除バッチ (Cloudflare Workers Cron)
- [ ] **Step 17**: 保管確認運用 UI
- [ ] **Step 18**: 顧問先招待・管理 (S-06)
- [ ] **Step 19**: 顧問先向け履歴画面 (C-05)
- [ ] **Step 20**: 重複検出
- [ ] **Step 21**: エラー監視導入 (Sentry など)

**Phase 2 完了基準**: 税理士事務所内で実業務に投入可能

### Phase 3: 拡張機能 (4〜8 週間)
- [ ] **Step 22**: 一括撮影 + OpenCV.js 自動分割 (β)
- [ ] **Step 23**: Google Sheets 連携 (GAS Webhook)
- [ ] **Step 24**: AI 抽出の修正学習 (修正履歴を Few-shot に活用)
- [ ] **Step 25**: 監査ログ閲覧画面 (S-07)
- [ ] **Step 26**: 表内インライン編集 (S-03)
- [ ] **Step 27**: 異常値検知の自動ハイライト精度向上

---

## 16. 確認・未決事項

実装着手前に確定が必要な項目:

| # | 項目 | 確認先 | 備考 |
|---|---|---|---|
| 1 | JDL 製品の特定と CSV 仕様 | 税理士さん | Phase 0 で確定必須 |
| 2 | 月の処理枚数 (顧問先 1 社あたり) | 税理士さん | コスト試算の基礎 |
| 3 | 個人情報の外部 AI 送信可否 | 税理士さん | Google / Anthropic への送信 OK か |
| 4 | 顧問先のデバイス想定 (iPhone モデル年代) | 税理士さん | 古い端末で PWA 動作確認 |
| 5 | AI モデル A/B テスト | Sho | 実物 30 枚で精度比較 |
| 6 | 最新の Gemini / Claude 画像入力料金 | Sho | 実装前に再確認 (確認が必要) |
| 7 | 国税庁 API の利用条件・レート制限 | Sho | アプリケーション ID 取得 + 仕様確認 |
| 8 | 30 日の保管期間が法令・実務で問題ないか | 税理士さん | 個人情報保護法、税理士会ガイドライン |
| 9 | Supabase Pro プラン化のタイミング | Sho | PoC 無料枠、Phase 2 で Pro へ |
| 10 | 電子帳簿保存法上の正式保管先運用 | 税理士さん | 顧問先別に紙原本/別ストレージ/JDL のどれを採用するか |
| 11 | Supabase 削除データの復元可否 | Sho | バックアップポリシー確認 |
| 12 | 顧問先別に「保管確認運用」を採用するか | 税理士さん | デフォルト ON / OFF の判断 |

---

## 17. 用語集

| 用語 | 説明 |
|---|---|
| 適格請求書 | インボイス制度における要件を満たした請求書・領収書 |
| T 番号 | 適格請求書発行事業者の登録番号 (T + 13 桁) |
| JDL | 税理士事務所向け会計ソフトウェア |
| client_user | 顧問先ユーザー (本仕様書独自) |
| RLS | Row Level Security (Supabase の行単位アクセス制御) |
| 自動削除 | CSV 書き出し or 保管確認から 30 日経過したレシートを Cron バッチで削除する仕組み |
| signed URL | 短時間のみ有効な署名付き URL。private bucket の画像表示に使用 |
| audit_logs | 重要操作の監査ログテーブル |

---

**変更履歴**

| 日付 | バージョン | 変更内容 |
|---|---|---|
| 2026-05-10 | 0.1 | 初版ドラフト |
| 2026-05-10 | 0.2 | データライフサイクル管理 (30 日自動削除) を追加。月次推移などの長期集計をスコープ外に変更 |
| 2026-05-10 | 0.3 | ChatGPT レビュー反映: ①証憑保存責任の明確化を新章追加、②`auto_delete_at` を exported_at 起点に変更、③1 枚撮影を主経路 / 一括分割を Phase 3 のβ機能に降格、④`receipt_ai_extractions` / `receipt_final_values` / `receipt_edit_logs` / `audit_logs` テーブル分離、⑤Background Sync を補助経路化、⑥JDL CSV を設定 JSON 駆動化、⑦ルールベースバリデーション追加、⑧非機能要件・signed URL・画像圧縮方針を追加、⑨Phase 0 (業務・CSV 仕様確認) を新設、⑩Phase 1 を 10 ステップに細分化 |
