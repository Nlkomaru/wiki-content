# wiki-content

MoripaWiki ([wiki-frontend](https://github.com/Nlkomaru/wiki-frontend)) のコンテンツリポジトリ。
[hagaki のコンテンツフォーマット](https://github.com/Nlkomaru/hagaki/blob/main/sample/README.md)に従い、
`content/` を Cloudflare Workers Assets で配信します。コードは持たず、
生成 (`hagaki generate`) と配信 worker (`hagaki/content-worker`) は
[hagaki](https://github.com/Nlkomaru/hagaki) をライブラリとして使います。

main への push で GitHub Actions が index 群を生成してデプロイします
(→ <https://wiki-content.moripa.nikomaru.dev>)。

## ディレクトリ

```
content/
├── article/
│   └── <uuid>/                 # 記事ディレクトリ (uuid = frontmatter の uuid)
│       ├── index.mdx           #   記事本体 (frontmatter + MDX)
│       ├── info.json           #   ← 生成物 (履歴マージ済みメタデータ)
│       └── assets/
│           └── <imageId>.avif  #   その記事に属する画像 (AVIF 固定)
├── categories/<slug>.json      # カテゴリ定義
├── article.json                # ← 生成物: 全記事 manifest
├── slug-index.json             # ← 生成物: slug → uuid マップ
└── categories.json             # ← 生成物: カテゴリ一覧
```

生成物 (`*.json` のうち `article.json` / `slug-index.json` / `categories.json` /
`article/*/info.json`) は git 管理外です。デプロイ前に必ず `pnpm generate` で
作り直します (`.github/workflows/deploy.yml` が push 時に自動実行)。
生成は hagaki の CLI (`pnpm generate` = `hagaki generate`) が行い、
`draft: true` の記事は `article.json` / `slug-index.json` に載りません。

## 配信 URL

配信元は Cloudflare Workers の `wiki-v2-content`。独自ドメイン
`wiki-content.moripa.nikomaru.dev` を正とし、`wiki-v2-content.nikomaru.workers.dev`
も移行期間として残している。

`/article/*` は `run_worker_first` で `hagaki/content-worker` の Hono app
(`src/index.ts`) を通り、`draft: true` の記事 (`index.mdx` / `info.json` /
`assets/*`) は 404 になる。manifest 類はそのまま静的配信。

| パス | 内容 |
|---|---|
| `/article.json` | 記事一覧 (`hagaki.posts.list()`) |
| `/slug-index.json` | slug → uuid マップ (`getPostBySlug` の O(1) 解決用) |
| `/article/<uuid>/index.mdx` | 個別記事 |
| `/article/<uuid>/info.json` | 記事メタデータ (履歴マージ済み) |
| `/article/<uuid>/assets/<imageId>.avif` | その記事の画像 |
| `/categories.json` | カテゴリ一覧 |

## 記事フォーマット

frontmatter は hagaki 仕様に準拠します。

```yaml
---
title: チャットについて！日本語入力の仕方など
slug: chat
uuid: 0e95538c-f931-4616-8b39-88cb608c90b4
category: zarchive
description: 森パのゲーム内チャットについての説明です！
thumbnail:
  imageId: 98e879e4-d625-4ca7-8e20-4df80ab0c285
  blurhash64: VUhLMGc4JCV4XlZzfld4dFJpdFIlZ05iTXtWQHNTb2ZWQHNv
modified:
  - date: 2022-02-19T02:25:05.827Z
    player: f8b761ec-4a54-48eb-a040-c5604042bcc9
---
```

本文は MDX。画像は必ず `<Image />` で書きます (生の Markdown 画像記法や
`<img>` は使いません)。

```mdx
<Image imageId="98e879e4-…" blurHash64="VUhLMGc4…" width="1920" height="1080" alt="説明" />
```

### `modified` (移行元の編集履歴)

編集履歴の一次ソースは git のコミット履歴です。`modified` は
**git 以前 (旧 wiki) の履歴**だけを持ちます。旧 wiki からの移行記事では

- `modified[0]` = 旧 wiki の `date` (記事の作成/最終更新日時)
- 本文末尾にあった「編集者: …／最終更新日: …」の記述を拾えた場合はその分も追加

を入れています。旧 wiki は編集者を Minecraft の**表示名**でしか記録していないため、
Mojang API で UUID を解決できたものだけ `player` を持ちます (解決できないものは
`player` を省略)。`hagaki generate` は `player` が無いエントリを `player: null`
として扱います。

### `editors` (manifest の生成物)

`article.json` の各エントリは、`info.json` の `history` をプレイヤーごとに畳んだ
`editors` を持ちます。

```json
"editors": [
  { "player": "85c6a9e3-…", "edits": 3, "lastEditedAt": "2026-08-09T15:13:17.000Z" }
]
```

`player` が解決できない履歴 (移行前の表示名のみの記録、`"<name> (<uuid>)"` 規約で
ないコミット) は含みません。wiki-frontend のダッシュボードが「自分が編集に
関わった記事」を出すのに使うため、記事数ぶんの `info.json` を引かなくて済むよう
manifest 側にも載せています。

## ローカル開発

```sh
pnpm install
pnpm generate       # article.json などを再生成
pnpm dev            # http://localhost:8787
```

## 手動デプロイ

```sh
pnpm install
pnpm deploy         # generate → wrangler deploy
```

## CI 自動デプロイのセットアップ

GitHub Actions (`.github/workflows/deploy.yml`) が main への push で
`pnpm generate` → `wrangler deploy` を実行します。以下の secret が必要です。

1. **Cloudflare API token** を発行
   - <https://dash.cloudflare.com/profile/api-tokens> →
     **Create Token** → **Edit Cloudflare Workers** テンプレート
2. リポジトリの Settings → **Secrets and variables → Actions** に追加
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`

`info.json` の履歴マージには git の全履歴が必要なため、workflow の checkout は
`fetch-depth: 0` になっています (浅い clone では git 由来の履歴が欠けます)。

## wiki-frontend との連携

wiki-frontend はこのリポジトリを

- 読み取り: `https://wiki-content.moripa.nikomaru.dev` (Workers Assets)
- 書き込み: GitHub API 経由のコミット (`Nlkomaru/wiki-content`)

として参照します。エディタからの保存はこのリポジトリへのコミットとして届き、
main に入ると Actions が走って worker に反映されます。

## 移行元

記事は [morinoparty/wiki](https://github.com/morinoparty/wiki) (Nuxt.js +
NetlifyCMS 時代の wiki) の `assets/content/wiki/*.json` と `static/img/` から
移行しました。画像は AVIF (最大 1920px, quality 50) に変換し、blurhash を
base64 で保持しています。
