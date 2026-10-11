# Misskey-A55

Misskey 2026.10.0 を ARM Cortex-A55 搭載NAS（QNAP TS-233, 2GB RAM）で快適に動かすための
**ランタイム最適化レイヤー**です。公式イメージ `misskey/misskey:2026.10.0` の上に
薄いパッチレイヤーを重ねた派生イメージを生成します。ソースコードの再ビルド不要で、
NAS上で数十秒の `docker build` で適用できます。

## 最適化内容と実測効果（TS-233 / Cortex-A55 @2.0GHz x4 実測）

| 最適化 | 内容 | Before | After |
|---|---|---|---|
| bcryptネイティブ化 | 純JS `bcryptjs` を `@node-rs/bcrypt`（arm64ネイティブ）互換shimへ差し替え | パスワード検証 66.4ms | **24.8ms (2.7x)** |
| blurhash固定値化 | 純JSのblurhashエンコーダを固定プレースホルダ返却に置換 | 数百ms/画像 | **0ms** |
| AP応答キャッシュ延長 | ActivityPub / webfinger / nodeinfo 応答の `max-age` を30→300秒, 180→1800秒へ | 180s | **1800s** |
| センシティブ検出 | すでに `none` で稼働していたため変更なし（meta設定で制御） | - | - |

組み合わせる設定（イメージ外）:

- `cacheRemoteFiles: true`（大容量ローカルディスクを活かした全キャッシュ戦略）
- `clusterLimit: 1` + ジョブ同時実行の抑制（2GB RAM向け）
- Cloudflare Tunnel 前段での Cache Rule（上記 max-age をエッジが尊重）

## 仕組み

`bcryptjs` / `blurhash` はビルド済みJSから `require()` される外部モジュールのため、
`node_modules` 配下をAPI互換のshimに差し替えるだけで動作が変えられます。
ハッシュ形式（`$2b$`）は同一のため、**既存アカウントのパスワードはそのままログイン可能**です
（旧形式ハッシュの検証テスト済み）。

blurhashはクライアント側でプレースホルダ展開される固定文字列を返します。
投稿画像のぼかしプレビューの精度は落ちます（中性色のプレースホルダになります）が、
CPU消費はゼロになります。

## 使い方

```sh
# NAS上で（Container Station / Docker が稼働していること）
cd Misskey-A55
sudo docker build -t misskey/misskey:2026.10.0-a55 .

# docker-compose で image: misskey/misskey:2026.10.0-a55 を指定して up
```

`example/` に完全なデプロイ構成（Misskey + PostgreSQL 18 + Redis 7 + cloudflared）の
テンプレートがあります。`.config` 内のパスワードは必ず自分のものに書き換えてください。

## 注意事項

- ベースイメージのバージョン（`FROM misskey/misskey:2026.10.0`）は
  Misskey本体のアップデート時に `Dockerfile` を更新して再ビルードしてください
- アップストリームがビルド成果物の構造を変えた場合（モジュールのbundling化など）、
  shimが効かなくなる可能性があります。効果は
  `docker compose exec web node -e "console.log(require('/misskey/packages/backend/node_modules/bcryptjs').compareSync('x','$2b$08$...'))"`
  などで検証できます
- QNAP Container Station では `sudo docker build` を使うと `container-station/homes/`
  の権限が変わることがあります（詳細はWiki/README参照）

## ライセンス

パッチ部分は自由に利用・改変してください。Misskey本体のライセンスは
[misskey-dev/misskey](https://github.com/misskey-dev/misskey) に従います。
