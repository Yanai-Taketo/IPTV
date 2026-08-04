# Global IPTV — 世界の放送をブラウザで

[iptv-org/iptv](https://github.com/iptv-org/iptv) が公開している全世界の IPTV チャンネル(約 4 万局)をブラウザからストリーミング再生できる静的 Web ページです。ビルド不要・サーバサイド不要で、GitHub Pages などの静的ホスティングにそのまま配置できます。

![スクリーンショット](docs/screenshot.png)

## デザイン

「国際番組表」をコンセプトに、新聞のテレビ欄と放送局のマスター管制室を参照した
エディトリアルデザインを採用しています。

- **紙面のような配色** — 温かみのある紙色の地に墨色の罫線・文字、アクセントは放送レッドのみ
- **表組みグリッド** — 1px のヘアライン罫で区切られた印刷物のテレビ欄風レイアウト。
  ロゴは乗算ブレンドで紙面に馴染ませる
- **タイポグラフィ** — 見出し・チャンネル名に [Archivo](https://fonts.google.com/specimen/Archivo)(可変フォント・同梱)、
  時刻・国名・画質などの技術メタ情報に [IBM Plex Mono](https://fonts.google.com/specimen/IBM+Plex+Mono)(同梱)、
  日本語はシステムフォント
- **放送のディテール** — マストヘッドの SMPTE カラーバー、UTC 時計、LIVE インジケータ、
  チューニング風ローディング表示。プレイヤーは黒スタージ + 赤いオンエアバーの管制室風

| プレイヤー | モバイル |
|---|---|
| ![プレイヤー](docs/screenshot-player.png) | ![モバイル](docs/screenshot-mobile.png) |

「テレビ欄で見る」に切り替えると、番組表のある局を時間軸に並べたタイムライン表示になります。

![テレビ欄](docs/screenshot-timeline.png)

> スクリーンショットは実データで撮り直せます(ローカルサーバを起動した状態で
> `node scripts/capture-screenshots.mjs`。詳細はスクリプト冒頭のコメント参照)。

## 機能

- **全世界のチャンネル一覧** — [iptv-org API](https://github.com/iptv-org/api) からチャンネル・ストリーム・ロゴ・国・カテゴリ・言語データを取得して結合(約 4 万 3 千エントリ)
- **検索・絞り込み** — チャンネル名(別名・ネットワーク名を含む)のテキスト検索、国・地域(大陸・経済圏)・カテゴリ・言語・HTTPS 配信のみでの絞り込み、名前順 / 国順 / 最近見た順ソート
- **お気に入り・視聴履歴** — カードの ☆ でお気に入り登録(一覧の先頭に固定・「お気に入りのみ」フィルタ)。
  実際に再生できたチャンネルは履歴に残り、「最近見た順」で並べ直せる。いずれも `localStorage` に保存し、
  使えない環境ではメモリ上で動作する(リロードで消えるだけで機能は壊れない)
- **番組表(EPG)** — 公式グラバー [iptv-org/epg](https://github.com/iptv-org/epg) を CI で毎日実行し、再生確認済みチャンネル約 950 局の「現在の番組 + 進捗バー」を一覧に、番組詳細と「この後の番組」をプレイヤーに表示。「番組表ありのみ」フィルタと、時間軸に並べた「テレビ欄」表示付き
- **番組から探す** — 「番組名も検索」を入れると、検索語をチャンネル名だけでなく番組タイトルにも当てる。
  どの番組で一致したかをカードに表示し、テレビ欄では一致ブロックを 🔍 で示す
- **ストリーミング再生** — [hls.js](https://github.com/video-dev/hls.js) による HLS 再生(Safari はネイティブ HLS にフォールバック)。DASH (.mpd) は dash.js を遅延読み込み、.mp4 / .webm はプログレッシブ再生
- **ザッピング・キーボード操作** — プレイヤーの ◀ ▶ と <kbd>←</kbd> <kbd>→</kbd> で一覧の並び順どおりに前後の局へ。
  <kbd>↑</kbd> <kbd>↓</kbd> 音量(保存・復元)、<kbd>M</kbd> ミュート、<kbd>F</kbd> 全画面。
  Media Session 対応で OS のメディアキー・ロック画面からも選局できる
- **自動フォールバック** — 複数ソースを持つチャンネルは、失敗時に次のソースを自動で試行
- **エラー時の代替手段** — 全ソース失敗時はストリーム URL のコピー / .m3u ダウンロード(VLC などで再生)を提示
- **公式サイトへの導線** — `channels.json` に `website` を持つチャンネル(全体の約 7 割)は、
  プレイヤーに「公式サイトを開く」リンクを常設。ABEMA のようにトークン認証・地域制限のため
  公開ストリーム URL が存在せず「配信なし」となるチャンネルでも、公式サイトへ辿り着ける
- **4 万件超への対応** — 60 件ずつの遅延描画(IntersectionObserver)+ ロゴの遅延読み込み
- **ディープリンク** — `#play=<チャンネルID>` で特定チャンネルを直接開ける
- **NSFW 除外** — `is_nsfw` フラグ付きチャンネルは常に除外(データソース自体もブロックリスト適用済み)

## 使い方

### ローカルで起動

`fetch` を使うため `file://` では動きません。任意の静的サーバで配信してください。

```bash
npx http-server -p 8080 .
# → http://127.0.0.1:8080 を開く
```

### GitHub Pages で公開

デプロイ用ワークフロー(`.github/workflows/deploy-pages.yml`)を同梱しています。
初回のみ、リポジトリの **Settings → Pages → Build and deployment → Source** を
**GitHub Actions** に設定してください(Pages の新規有効化は Actions のトークン権限では
行えないため、この 1 クリックだけ手動が必要です)。以後はデフォルトブランチへの
プッシュごとに自動デプロイされます。手動実行は Actions タブの
「Deploy to GitHub Pages」→ Run workflow からも可能です。

> **プライベートリポジトリの場合**: GitHub Pages は Free プランではパブリック
> リポジトリのみ利用できます。プライベートのまま公開するには Pro 以上のプランが
> 必要です(公開されたサイト自体は誰でも閲覧可能になります)。

> **注意**: HTTPS ページとして公開すると、`http://` のストリーム(全体の約 2 割)は
> ブラウザの混在コンテンツ制限により再生できません。アプリはこれを検出して
> 「HTTP のみ」バッジ表示・「HTTPS 配信のみ」フィルタの自動有効化で対処します。

## アーキテクチャ

| ファイル | 役割 |
|---|---|
| `index.html` | ページ本体(hls.js は SRI 付き CDN 読み込み) |
| `assets/js/data.js` | iptv-org API の取得と結合(streams → channels / feeds / logos / countries / categories / languages) |
| `assets/js/epg.js` | 番組表データ(`data/epg/`)の読み込み・現在/次番組の算出・詳細シャードの遅延取得 |
| `assets/js/player.js` | プレイヤーモーダル(hls.js / ネイティブ HLS / dash.js / プログレッシブ、自動フォールバック、番組表パネル) |
| `assets/js/store.js` | お気に入り・視聴履歴の保存(`localStorage`、使えない環境ではメモリ) |
| `assets/js/app.js` | UI 状態管理・検索・絞り込み・遅延描画・テレビ欄(タイムライン) |
| `assets/css/style.css` | エディトリアル UI(番組表グリッド・プレイヤー管制室スタイル) |
| `assets/fonts/` | 同梱 Web フォント(Archivo 可変・IBM Plex Mono、latin サブセット、OFL) |

### データ結合の要点(iptv-org API 仕様)

- `channels.json` にはロゴ・言語フィールドが**無い**ため、`logos.json`(チャンネルごとに最良の 1 枚を選択)と `feeds.json`(言語はフィードに紐づく)を結合
- `feeds` の `id` はチャンネル内でのみ一意 → `(channel, id)` の複合キーで参照
- ストリームの約 1 割は `channel: null`(タイトルのみ)→ タイトル単位でグルーピングして表示
- `streams.json` は DMCA / NSFW ブロックリスト適用済み

## 再生可能性インデックス

全ストリームを定期プローブして再生可能性を記録する仕組みを備えています
(調査の詳細と背景は [docs/playability-research.md](docs/playability-research.md) を参照)。

- `scripts/probe-streams.mjs` — 全ストリームをチェックして `data/playability.json` を生成
- `.github/workflows/probe-playability.yml` — 毎日自動更新(デフォルトブランチ上で有効。
  手動実行: Actions → Probe stream playability → Run workflow)
- アプリは同ファイルがあれば「✓ 確認済」バッジ・「再生確認済みのみ」フィルタ・
  確認済み優先の並び替えを有効化します(無くても従来どおり動作)

また、Safari/iOS ではネイティブ HLS を優先し(CORS 制約を受けないため再生できる配信が増える)、
フッターの「詳細設定」から**自分専用の**ストリームプロキシ URL を任意で設定できます(既定 OFF)。

## 番組表(EPG)

iptv-org は番組データそのものをホストしていないため、公式グラバー
[iptv-org/epg](https://github.com/iptv-org/epg) を CI で毎日実行して静的 JSON を自前生成しています
(設計の詳細は [docs/epg-design.md](docs/epg-design.md) を参照)。

- `scripts/grab-epg.mjs` / `scripts/epg-lib.mjs` — グラブ対象の選定
  (再生確認済み × ガイドあり、既定 40 サイト・1,500 チャンネル上限)と、
  グラブ結果のコンパクト形式への変換
- `.github/workflows/grab-epg.yml` — 毎日自動更新(デフォルトブランチ上で有効。
  手動実行: Actions → Grab EPG data → Run workflow。取得日数・同時接続数を指定可能)
- 生成物は `data/epg/schedule.json`(一覧用・[開始秒, 長さ秒, タイトル])と
  `data/epg/details-<n>.json`(説明文入り。プレイヤーを開いたときのみ遅延取得)の 2 層構成
- データは履歴を持たない **`epg-data` ブランチ**に force-push され(main の履歴を
  肥大させないため)、各デプロイ時にサイトへ同梱されます
- アプリは同データがあれば「現在の番組」表示・番組表パネル・「番組表ありのみ」フィルタを
  有効化します(無くても従来どおり動作)。ローカルで試す場合:
  `git fetch --depth 1 origin epg-data && git checkout FETCH_HEAD -- data/epg`

## ブラウザ再生の制約(既知の制限)

IPTV ストリームの多くはブラウザ再生を想定していないサーバから配信されているため、
**すべてのチャンネルがブラウザで再生できるわけではありません**。主な理由:

1. **CORS 未対応** — hls.js は fetch でセグメントを取得するため、配信サーバが
   `Access-Control-Allow-Origin` を返さないと再生不可(VLC では再生できるのに
   ブラウザでは不可、の主因)
2. **地域制限(ジオブロック)** — 403 などで拒否される
3. **混在コンテンツ** — HTTPS ページから `http://` ストリームは読み込み不可
4. **カスタムヘッダ要求** — `User-Agent` / `Referrer` の指定が必要な配信は
   ブラウザからは送信不可(約 1,200 件)
5. **非対応プロトコル** — rtmp / rtsp などはブラウザ再生不可

このため、失敗時には次ソースへの自動フォールバックと、URL コピー / .m3u
ダウンロードによる外部プレイヤー(VLC など)への導線を用意しています。

## テスト

[Playwright](https://playwright.dev/) による E2E テスト付き。

```bash
npm install
npx playwright install chromium   # ブラウザ未取得の場合のみ
npm test          # ハーメチックテスト(ネットワーク不要・フィクスチャ注入)
npm run test:live # 実 API へのスモークテスト(到達不可なら自動スキップ)
```

- `tests/app.spec.js` — 一覧・検索・絞り込み・ソート・NSFW 除外・ディープリンク
- `tests/player.spec.js` — HLS パイプライン(マニフェスト→セグメント取得)、
  WebM 実再生、自動フォールバック、エラーパネル、URL 分類、DASH フォールバック
- `tests/epg.spec.js` — 番組表(擬似クロックで時刻固定): カードの現在番組・境界越え更新・
  フィルタ・プレイヤーパネル・詳細シャード欠落時のフォールバック・EPG 無し環境の非表示
- `tests/zapping.spec.js` — ザッピング(前/次選局)、Media Session、キーボード
  ショートカット(選局・音量・ミュート・全画面)と音量の保存・復元
- `tests/program-search.spec.js` — 番組タイトル検索(「番組名も検索」)と
  HTML 実体参照の復号(未復号のまま配信されたデータへの耐性を含む)
- `tests/epg-transform.spec.js` — EPG パイプライン純粋ロジック(選定・変換・XML 生成・
  実体参照の復号・サイト別実績)のユニットテスト
- `tests/playability-report.spec.js` — 再生可能性インデックスの前回比判定
  (急落時の中断・しきい値の境界・ワークフローの手順順序)
- `tests/resilience.spec.js` — 任意エンドポイント欠落時の縮退動作、必須エンドポイント
  失敗 → 再試行の復帰
- `tests/realdata.spec.js` — 実データスナップショット(4 万チャンネル)での
  スケール検証(スナップショット未取得時は自動スキップ。取得方法はファイル冒頭参照)
- `tests/live.spec.js` — 実 API スモークテスト

再生検証は Playwright 同梱 Chromium に H.264 デコーダが含まれない制約を考慮し、
HLS はネットワークパイプラインまで、実デコードは VP8/WebM フィクスチャで検証しています。

## クレジット / ライセンス

- チャンネルデータ: [iptv-org](https://github.com/iptv-org)(パブリックドメイン, [Unlicense](https://github.com/iptv-org/iptv/blob/master/LICENSE))
- 再生: [hls.js](https://github.com/video-dev/hls.js) / [dash.js](https://github.com/Dash-Industry-Forum/dash.js)
- フォント: [Archivo](https://github.com/Omnibus-Type/Archivo) / [IBM Plex Mono](https://github.com/IBM/plex)(いずれも SIL Open Font License 1.1)
- 各ストリームの著作権はそれぞれの放送局・配信者に帰属します。本プロジェクトは
  動画ファイルを一切ホストせず、公開されているストリームへのリンクのみを扱います。
