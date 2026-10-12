# Misskey-A55

Misskey 2026.10.0 を ARM Cortex-A55 搭載 NAS（QNAP TS-233, 2GB RAM）で動かすための
**ランタイム最適化レイヤー**です。公式イメージ `misskey/misskey:2026.10.0` の上に
薄いパッチを重ねた派生イメージを作ります。Misskey 本体の再ビルドは不要で、
NAS 上の `docker build` で適用できます。

2026.10.0 の本番バンドルは rolldown が `bcryptjs` と `blurhash` をチャンク内に
埋め込んでいます。`node_modules` を差し替えても、動いているサーバーの処理は
変わりません。`patch-built.mjs` はビルド済み JS と sharp の実体を直接書き換えます。
パターンが一つでも見つからない場合、ビルドは失敗します。

## 最適化

| 対象 | 内容 |
|---|---|
| パスワード | バンドルされた bcryptjs の `hash` / `compare` を `@node-rs/bcrypt`（arm64 ネイティブ）に付け替える。既存の `$2b$` ハッシュはそのまま検証できる |
| blurhash | `getBlurhash` が sharp で元画像を展開する前に固定プレースホルダを返す。アップロードとリモートファイル取り込みで libvips のデコードが走らない |
| sharp | `cache(false)` と `concurrency(1)`。公式イメージは jemalloc を使うため、sharp は既定だと 4 スレッドと 50MB の操作キャッシュを持つ |
| メモリキャッシュ | `MemoryKVCache` の件数上限を 2048 にする。公開鍵と絵文字は TTL が 12 時間で、件数の天井が無いとヒープが膨らむ。あふれた分は DB から読み直す |
| ジョブ | 未設定時の並列を配送 2・受信 1・関係 2、レートを 4/秒・2/秒・4/秒、リトライを 4 回にする。`default.yml` に書いた値はこちらより優先される |
| HTTP エージェント | 配送ソケットの下限を 256 から 8 にする |
| ActivityPub | 応答の `max-age` を 30→300 秒、180→1800 秒にする。HTML の外枠と WebFinger も同じ秒数になる。`300` と `31536000` は変えない。Cloudflare の Cache Rule がこれを尊重するとクローラが NAS に届かない |
| 連合先の表示 | NodeInfo のバージョンを `2026.10.0-A55` にする。名前は `misskey` のままなので、相手の画面は `misskey 2026.10.0-A55` になる |

プレースホルダは中性色の固定 blurhash です。投稿画像のぼかしプレビューの色は元画像を反映しません。

## 連合先への表示

連合先は NodeInfo の `software.name` と `software.version` を並べて出します。名前は `misskey` 固定です。ここを変えると、相手がこのサーバーを Misskey として扱わなくなります。バージョンだけ `2026.10.0-A55` にします。

サーバーは起動時に `/misskey/built/meta.json` を読み、NodeInfo と `/api/meta` と送信時の User-Agent（`Misskey/2026.10.0-A55 (サイトのURL)`）に使います。フロントエンドに焼き込まれた版は `2026.10.0` のままです。概要ページと、言語ファイルの URL は変わりません。

`2026.10.0-A55` は semver のプレリリースで、比較すると `2026.10.0` より前になります。Misskey は相手のバージョン文字列では機能を切り替えません。配送を止めるのは、管理画面で指定したソフトとバージョン範囲に一致したときだけです。

相手は NodeInfo をキャッシュします。表示が切り替わるのは、相手が次に取りに来たあとです。

## イメージの外で足すもの

`example/compose.yml` に PostgreSQL と Redis のメモリ上限を入れています。

- PostgreSQL: `shared_buffers=64MB`, `max_connections=20`, コンテナ上限 384MB
- Redis: `maxmemory 64mb`, `noeviction`（ジョブを LRU で捨てない）, コンテナ上限 96MB
- Misskey: ヒープ 400MB、コンテナ上限 768MB

`example/a55.config.yml` は `default.yml` に貼るジョブ設定です。省略してもイメージ側のフォールバックが同じ値です。明示すると、あとから大きいマシンへ移したときに値の所在が分かります。

Meilisearch とセンシティブ画像判定（動画の ffmpeg 解析を含む）は無効のままにしてください。

## 使い方

TS-233 上でビルドしてください。`@node-rs/bcrypt` のネイティブバイナリは、ビルドした CPU 向けのものが入ります。

```sh
cd Misskey-A55
sudo docker build -t misskey/misskey:2026.10.0-a55 .

# docker-compose で image: misskey/misskey:2026.10.0-a55 を指定して up
```

`example/` に Misskey + PostgreSQL 18 + Redis 7 + cloudflared のテンプレートがあります。`.config` 内のパスワードは自分のものに書き換えてください。

## 送受信を止めない

Misskey はマスタープロセスが HTTP を出し、ワーカー 1 本が受信・配送・アカウント削除を同じイベントループで処理します。`clusterLimit` は 1 のままです。ワーカーを増やすメモリはありません。

ループが同期処理で止まると、ノートの受信も配送もそこで止まります。PostgreSQL から見ると接続は `idle` / `ClientRead` のまま残り、Docker のヘルスチェックはマスターの HTTP が応答するので成功します。`entry.ts` は終了したワーカーを fork し直します。止まっているだけで終了していないワーカーは、その対象になりません。

`a55-guard.cjs` を `.config/` に置き、`NODE_OPTIONS` に `--require /misskey/.config/a55-guard.cjs` を足します。起動から 150 秒は起動処理を見送り、その後は別スレッドがイベントループの心拍を見ます。45 秒止まったら、実行中のジョブを Redis の delayed へ退避してから、そのプロセスだけを止めます。Misskey がワーカーを fork し直すので HTTP は続き、受信キューが先に流れます。同じジョブが再び止めた場合は待ち時間を倍にして、最大 1 時間まで後ろへ回します。マスター自身が止まったときはそのプロセスを止め、Docker の再起動に任せます。

あわせてデータベースに `idle_session_timeout=120s` を置きます。結果を読み捨てた接続は、ループが生きていれば 2 分で切れ、ジョブがエラーになって次へ進みます。

```sh
cp a55-guard.cjs /path/to/misskey/.config/a55-guard.cjs
# 既存のデータベースに一度だけ
psql -d misskey -c "ALTER DATABASE misskey SET idle_session_timeout = '120s'"
```

## 注意事項

- ベースイメージのバージョン（`FROM misskey/misskey:2026.10.0`）を上げたら、`Dockerfile` を更新して再ビルドする。バンドルの形が変わると `patch-built.mjs` がパターン不一致で止まります
- QNAP Container Station では `sudo docker build` を使うと `container-station/homes/` の権限が変わることがあります
- `clusterLimit` は 1 のままにしてください。ワーカーを増やすと常駐メモリが倍になります

## ライセンス

パッチ部分は自由に利用・改変してください。Misskey 本体のライセンスは
[misskey-dev/misskey](https://github.com/misskey-dev/misskey) に従います。
