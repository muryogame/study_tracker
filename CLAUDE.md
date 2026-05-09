# 学録 — CLAUDE.md

## プロジェクト概要
学習時間トラッカー Web アプリ。FastAPI + SQLite/PostgreSQL のバックエンドと、
バニラ JavaScript のフロントエンドで構成。Render の無料プランでホスティング。

**本番 URL**: `https://study-tracker-2znl.onrender.com`

## ローカル起動
```bash
cd study_tracker
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8765 --reload
# → http://localhost:8765
```

データベースは `DATABASE_URL` 環境変数がなければ自動で SQLite（`study.db`）を使用。

## 技術スタック
| 層 | 技術 |
|---|---|
| バックエンド | FastAPI + SQLAlchemy（SQLite / PostgreSQL 切り替え） |
| フロントエンド | バニラ JS（`static/app.js`）+ CSS（`static/style.css`） |
| ホスティング | Render（無料プラン、PostgreSQL 必須） |

## ファイル構成
```
main.py            # FastAPI アプリ本体・全 API エンドポイント
static/
  app.js           # フロントエンド全ロジック（バージョン管理: ?v=N）
  index.html       # SPA のエントリポイント（SEO タグ含む）
  style.css        # スタイル
  favicon.svg      # アイコン
requirements.txt
Procfile           # Render デプロイ設定
runtime.txt        # Python 3.11
.github/workflows/
  keepalive.yml    # 10分ごとに Render をピングして スリープを防止
```

## 重要な実装ルール

### 時刻の扱い
- **全ての時刻は UTC+"Z" 形式で保存する**: `datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')`
- SQL 集計はすべて JST に変換してから行う（PostgreSQL: `::timestamptz AT TIME ZONE 'Asia/Tokyo'`、SQLite: `, 'localtime'`）
- JS 側は `new Date("...Z")` で自動的に JST 表示になる

### フロントエンド バージョン管理
- `app.js` を変更したら `index.html` の `?v=N` を必ずインクリメント
- ブラウザキャッシュを確実に破棄するため

### 認証方式（ログイン不要）
- ブラウザが `localStorage` に UUID を自動生成・保存（`sf_device_id`）
- UUID を SHA-256 ハッシュ → `user_id`（整数）として全 API で使用
- デバイスごとに完全に独立したデータを保持

### サーバー起動待機（Render スリープ対策）
- ページ読み込み時に `preWarmServer()` がバックグラウンドで ping を送り続ける
- `_serverReady` フラグが `true` になったら `loadAll()` でデータを再取得
- START・ToDo追加などのミューテーション操作は `waitServerReady()` で起動を待機

### エラーハンドリング
- 全てのデータ取得関数に `try-catch` を付ける（サーバー未起動時の例外防止）
- ミューテーション失敗時はユーザーに見えるエラーメッセージを表示する

### DB 方言の切り替え
```python
IS_PG = bool(os.environ.get("DATABASE_URL", ""))
# IS_PG が True なら PostgreSQL ヘルパーを使用
# IS_PG が False なら SQLite ヘルパーを使用
```
SQL を書くときは必ず `_date(col)`・`_ym(col)` などのヘルパー関数を使うこと。
生の `strftime` や `to_char` を直接書かない。

## 環境変数（Render ダッシュボードで設定）
| 変数 | 用途 |
|---|---|
| `DATABASE_URL` | PostgreSQL 接続文字列（なければ SQLite） |
| `RENDER_EXTERNAL_URL` | サービスの公開 URL（Render が自動設定） |
| `BMC_USERNAME` | Buy Me a Coffee ユーザー名 |
| `KOFI_USERNAME` | Ko-fi ユーザー名 |
| `STRIPE_LINK` | Stripe 支払いリンク |
| `ADSENSE_ID` | Google AdSense パブリッシャー ID |
| `AMAZON_TAG` | Amazon アソシエイトタグ |

## GitHub Actions（keepalive）
`.github/workflows/keepalive.yml` が 10 分ごとに `/api/ping` を叩く。
動作させるには GitHub リポジトリの **Settings → Secrets → Actions** に
`RENDER_URL`（例: `https://study-tracker-2znl.onrender.com`）を登録すること。

## デプロイフロー
```bash
git add <files>
git commit -m "説明"
git push origin master
# → GitHub push → Render が自動デプロイ（約1〜2分）
```

## よくある問題と対処
| 症状 | 原因 | 対処 |
|---|---|---|
| タイマーが数時間ずれる | UTC 時刻を JST として解釈 | 時刻保存に必ず `Z` サフィックスを付ける |
| ToDo が保存されない | PostgreSQL で `false` を INTEGER 列に INSERT | `0` を使う |
| ボタンが無反応 | `authFetch` の blocking 待機 | ミューテーション専用の `waitServerReady()` を使う |
| 古い JS が動く | ブラウザキャッシュ | `app.js?v=N` の N をインクリメント |
