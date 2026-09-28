# 帳票読み取りツール (choubo-scan)

税理士事務所向けの帳票読み取りウェブアプリ。手書き領収書・手書き帳簿（金銭出納帳）・Excel帳簿を
AI (Claude / Gemini) で読み取り、機械検算・訂正学習を経て CSV / Slack に出力する。

PoC（claude.ai アーティファクト版 v0.1〜v0.8）で検証済みのパイプラインを
Cloudflare Pages + Pages Functions に移植したもの。

## 実測精度 (PoC v0.8 時点・手書き金銭出納帳 見開き2枚 71行)

| 指標 | 値 |
|---|---|
| 残高チェーン検算OK率 | 81% (35/43) |
| 行数の正確性 | 71行 = 原本と一致 |
| 摘要の創作（ハルシネーション） | 0行 |

残る不一致は手書き数字の混同で、全件が「確認が必要な項目」に計算値の提案付きで表示される。

## 機能

- **3モード**: 領収書 / 帳簿(手書き) / 帳簿チェック(Excel)
- **前処理**: 向きの自動判定・グレースケール+コントラスト強調・見開きの最大4分割 (すべてブラウザ内)
- **機械検算**: 前行残高+収入−支払=当行残高 をコードが全行検証 (AIに計算させない)
- **重複除去・列入替の自動補正**: 数値署名ベース
- **質問キュー**: 残高不一致・低信頼行を計算値の提案付きで確認
- **訂正学習**: 修正を教訓化し次回のプロンプトに自動注入 (localStorage)
- **モデル切替**: Claude Sonnet (既定) / Gemini Flash をヘッダーで切替
- **ベンチマーク**: 同梱の正解データ (public/bench) と一致度を比較し、モデルA/Bを記録
- **出力**: CSV ダウンロード / クリップボード / Slack (Incoming Webhook)
- **認証**: 共有パスワード1つ (v1)。APIキーはサーバー側にのみ保持

## デプロイ (Cloudflare Pages)

1. このリポジトリを Cloudflare Pages に接続
   - Build command: `npm run build`
   - Build output directory: `dist`
   - `functions/` ディレクトリは自動で Pages Functions としてデプロイされる
2. 環境変数 (Settings → Environment variables → Production):

| 変数 | 必須 | 説明 |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | Claude API キー |
| `APP_PASSWORD` | ✅ | 共有ログインパスワード |
| `GEMINI_API_KEY` | - | Gemini 比較を使う場合 |
| `SLACK_WEBHOOK_URL` | - | Slack送信を使う場合 (Incoming Webhook) |
| `CLAUDE_MODEL` | - | 既定 `claude-sonnet-4-6` の上書き |
| `GEMINI_MODEL` | - | 既定 `gemini-2.5-flash` の上書き |

3. デプロイ後、発行URLを開き `APP_PASSWORD` でログイン

## ローカル開発

```bash
npm install
npm run build
cp .dev.vars.example .dev.vars   # キーを記入
npx wrangler pages dev dist      # Functions込みでローカル起動
```

UIのみの高速開発は `npm run dev` (この場合 /api/* は動かない)。

## コストについて (要確認)

- 帳簿見開き1枚 ≒ 4分割 × (画像+プロンプト+出力)。Sonnet で概算 15〜25円/枚、Gemini Flash で 1〜3円/枚の見込みだが、**単価・実測トークン数ともに要確認**
- 画面下部 (STEP 3) に今セッションの実測トークン数と概算額が表示される
- モデル単価は https://claude.com/pricing / https://ai.google.dev/gemini-api/docs/pricing で最新を確認すること

## リポジトリ構成

```
src/App.jsx            # アプリ本体 (PoC v0.8 から移植)
src/lib/api.js         # /api/* クライアント (認証・モデル切替・使用量イベント)
src/lib/store.js       # localStorage ラッパー
functions/api/         # Cloudflare Pages Functions
  login.js             #   共有パスワード認証
  extract.js           #   Claude / Gemini プロキシ (キーはサーバー側)
  slack.js             #   Slack Incoming Webhook 送信
public/bench/          # ベンチマーク正解データ (手書き帳簿71行・検算済み)
docs/SPEC-full-v0.3.md # 本格版 (Supabase・JDL連携・マルチテナント) の仕様書
```

## ロードマップ

本リポジトリは「実運用PoC」段階。本格版 (顧問先ロール・Supabase・30日自動削除・JDL CSV 設定JSON・
国税庁API照合) の仕様は `docs/SPEC-full-v0.3.md` を参照。
