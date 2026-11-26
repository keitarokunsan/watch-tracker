# Prime Video 見放題終了トラッカー

Amazon Prime Video（日本版）で **まもなく見放題（プライム会員特典）対象外になる作品と期限** を毎日自動チェックし、**ポスターサムネイル付きの専用Webページ（GitHub Pages）** と **Discord / メール通知** で確認できる仕組みです。

- **サーバー代・月額費用ゼロ**（GitHub Actions + GitHub Pages + 無料API枠で運用可能）
- **Python標準ライブラリのみ**（追加パッケージのインストール不要）
- **サムネイル＆期限カウントダウン表示**（クリックで対象作品の Prime Video ページへ移動、上部に「Amazon公式: 30日以内に終了一覧」リンク常設）
- **ウォッチリスト照合**（`config/watchlist.txt` による通知連携 ＋ ブラウザ側の即時フィルタ ＋ Prime Videoウォッチリスト画面から1クリックでタイトルをコピーできるブックマークレット付き）
- **洋画・海外ドラマの邦題・日本語ポスター補完**（無料の TMDB API キーを設定すると自動有効化）

---

## クイックスタート（セットアップ手順）

### 1. 無料の API キーを取得する

#### 必須：Streaming Availability API（どちらか1つ）
1. **Movie of the Night 公式 Developers Portal（おすすめ・クレカ不要）**
   - [Movie of the Night API](https://www.movieofthenight.com/about/api) の無料プラン（月 1,000 リクエスト / $0）にサインアップし、APIキーを発行します。
   - GitHub Secrets の名前: `STREAMING_AVAILABILITY_API_KEY`
2. **または RapidAPI 経由**
   - RapidAPI の「Streaming Availability」無料プランを購読し、APIキーを取得します。
   - GitHub Secrets の名前: `RAPIDAPI_KEY`

> 1日1回の実行で消費するのは通常 1〜5 リクエスト程度なので、月 1,000 リクエストの無料枠内に十分収まります。

#### 任意（強くおすすめ）：TMDB API（洋画・海外ドラマの邦題＆日本語ポスター用）
- [TMDB](https://www.themoviedb.org/settings/api) で無料アカウントを作成して API Key（または Read Access Token）を取得します。
- 設定すると洋画・海外ドラマも**日本語タイトル・日本語あらすじ・日本語ポスター**で表示され、さらに Streaming Availability API 側の画像CDN帯域も節約できます。
- GitHub Secrets の名前: `TMDB_API_KEY`

---

### 2. GitHub リポジトリにアップロードする

1. GitHub で新しいリポジトリ（Public 推奨：無料アカウントで GitHub Pages を使うため）を作成します。
   ※ リポジトリを Private にした場合、GitHub Free プランでは GitHub Pages を公開できません（Discord / メール通知のみなら Private でも動作します）。
2. このフォルダの内容を `main` ブランチへプッシュします。

```powershell
git init -b main
git add .
git commit -m "Initial commit: Prime Video expiring tracker"
git remote add origin https://github.com/<あなたのユーザー名>/<リポジトリ名>.git
git push -u origin main
```

---

### 3. GitHub Pages と Secrets を設定する

#### GitHub Pages の有効化
1. リポジトリの **Settings** → **Pages** を開く
2. **Build and deployment** の **Source** を **GitHub Actions** に変更する

#### Secrets の登録
リポジトリの **Settings** → **Secrets and variables** → **Actions** → **New repository secret** から以下を登録します。

| Secret 名 | 必須 / 任意 | 内容 |
| :--- | :---: | :--- |
| `STREAMING_AVAILABILITY_API_KEY` | いずれか必須 | Movie of the Night 公式ポータルの API キー |
| `RAPIDAPI_KEY` | いずれか必須 | RapidAPI 経由を使う場合の API キー |
| `TMDB_API_KEY` | 任意（推奨） | TMDB の API Key または Read Access Token（邦題・日本語ポスター用） |
| `DISCORD_WEBHOOK_URL` | 任意 | Discord チャンネルの Webhook URL（通知したい場合） |
| `SMTP_HOST` | 任意 | メール通知を使う場合の SMTP ホスト（Gmail なら `smtp.gmail.com`） |
| `SMTP_PORT` | 任意 | SMTP ポート（Gmail STARTTLS なら `587`、SSL なら `465`） |
| `SMTP_USER` | 任意 | SMTP ユーザー名（Gmail アドレスなど） |
| `SMTP_PASS` | 任意 | SMTP パスワード（Gmail の場合はアプリパスワード） |
| `MAIL_TO` | 任意 | 通知先メールアドレス |
| `MAIL_FROM` | 任意 | 送信元メールアドレス（省略時は `SMTP_USER`） |

---

### 4. 初回実行して動作確認する

1. リポジトリの **Actions** タブを開く
2. **Update Prime Video Expiring List & Deploy Pages** を選択
3. **Run workflow** をクリック（通知テストもしたい場合は `force_notify` にチェックを入れる）
4. 完了後、Actions 画面に表示される GitHub Pages の URL（`https://<ユーザー名>.github.io/<リポジトリ名>/`）を開くと、ポスター付きの一覧ページが表示されます。

以降は **毎日 日本時間 07:00** に自動更新・差分通知されます。

---

## 自分のウォッチリストを組み込む方法

2通りの方法があり、両方同時に使えます。

1. **Web画面だけで手軽に使う（即時反映）**
   - 公開ページの右上にある **「★ ウォッチリスト・設定」** を開きます。
   - 中にある **「★ Primeウォッチリスト取得」** ボタンをブラウザのブックマークバーへドラッグして保存します。
   - [Amazon Prime Video のウォッチリスト画面](https://www.amazon.co.jp/gp/video/mystuff/watchlist) を開いて下までスクロールし、そのブックマークをクリックすると作品名一覧がクリップボードにコピーされます。
   - トラッカー画面の入力欄に貼り付けて **「保存して反映」** を押すと、該当作品に `★ ウォッチリスト` バッジが付きます。
2. **自動通知（Discord / メール）にも反映させる**
   - 上記モーダルの **「watchlist.txt 用にコピー」** を押し、リポジトリ内の [`config/watchlist.txt`](config/watchlist.txt) に貼り付けてコミットします。
   - 一致する作品が配信終了予定に入った時や、残り 7日・3日・1日・当日になったタイミングで最優先ハイライト通知が届きます。

---

## 案2：Chrome拡張機能（Amazon公式の約198件を全件取得・取りこぼしゼロ）

外部APIでは「14日以内のみ」「一部作品の欠落」といった制限があるため、**Amazon公式の「30日以内にプライム会員特典ではなくなる作品」全件**をログイン済みブラウザから直接取得できる Chrome 拡張機能を `extension/` に同梱しています。

### 拡張機能でできること
- **Amazon公式 30日以内の全件スキャン**: 検索一覧（`rh=n%3A4217521051`）の全ページと各作品の残り日数（`あと5日` / `あと14日` / `あと○時間` 等）を自動取得し、ポスターサムネイル付きで期限順に一覧表示
- **開いているAmazonタブからの直接取込**: Prime Video の「もうすぐ配信終了」ページを開いた状態で1クリック取り込みにも対応
- **自分のウォッチリスト自動同期**: ログイン中の Amazon ウォッチリストを1クリックで取り込んで `★ ウォッチリスト` としてハイライト
- **定期バックグラウンドチェック＆通知**: 任意で12/24時間ごとの自動チェック、デスクトップ通知、Discord Webhook 通知に対応
- **JSON書き出し**: 取得結果を `expiring.json` 形式でダウンロード可能

### Chrome へのインストール手順（約1分）
1. Chrome のアドレスバーに `chrome://extensions` と入力して開く
2. 右上の **「デベロッパー モード」** をオンにする
3. 左上の **「パッケージ化されていない拡張機能を読み込む」** をクリック
4. このリポジトリ内の **`extension`** フォルダを選択する
5. ツールバーにアイコンが表示されるのでクリック → ダッシュボードが開いたら **「Amazon公式から全件スキャン」** を押す

> ※ 初回の詳細チェック（約198件の残り日数確認）にはサーバー負荷配慮のため数十秒〜1分ほどかかりますが、取得済みの作品は12時間キャッシュされるため2回目以降は高速です。

---

## ローカルPCでのプレビュー・テスト方法

API キーを設定する前でも、付属のサンプルデータで Web 画面をすぐ確認できます。

```powershell
# ローカルサーバーでWeb画面を確認（ http://localhost:8000 ）
python -m http.server 8000 --directory docs

# 自動テストを実行（Python + Chrome拡張パーサー）
python -m unittest discover -s tests -v
node --test tests/test_amazon_parser.mjs
```

API キーをローカルの環境変数にセットして実データ取得を試す場合：

```powershell
$env:STREAMING_AVAILABILITY_API_KEY="ここにキーを入力"
$env:TMDB_API_KEY="任意でTMDBキーを入力"
python scripts/fetch_expiring.py
```

---

## よくある注意点

- **配信終了日の変更・延長**: 権利契約の都合で Amazon 側が予告なく延長・終了することがあります。最終確認はリンク先の Prime Video 公式ページをご確認ください。
- **日本独自作品の網羅性**: 外部集計 API を使用しているため、Amazon 本体の表示より数時間〜1日程度反映が遅れたり、一部マイナー作品が漏れる場合があります。ページ上部の **「Amazon公式: 30日以内に終了一覧」** ボタンも併用すると確実です。
