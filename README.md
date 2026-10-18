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
| ジョブ | 未設定時の並列を配送 2・受信 1・関係 2、レートを 4/秒・2/秒・4/秒、リトライを 4 回にする。**`default.yml` の値はこちらより優先される**（v3 で本番の 16/4 を 2/1 に戻した） |
| HTTP エージェント | 配送ソケットの下限を 256 から 8 にする |
| サーバーメトリクス | 「サーバーメトリクス」ウィジェットのデータをログインユーザー限定にする。`serverStats` チャンネルを `requireCredential` 化し、`server-info` は匿名リクエストにプレースホルダ(`?`/`0`)を返す。ウィジェットのラベル取得(`misskeyApiGet`)だけトークン付きに書き換える。さらに2秒周期の収集（`ServerStatsService`）を `systeminformation` のサブシェル起動（`lsblk`/`ip` 等で毎回約1.2秒消費）から `/proc/meminfo`・`/proc/net/dev`・`/proc/diskstats` の直接読み取り（0.3ms以下・子プロセス0）に置き換える |
| ActivityPub | 応答の `max-age` を 30→300 秒、180→1800 秒にする。HTML の外枠と WebFinger も同じ秒数になる。`300` と `31536000` は変えない。Cloudflare の Cache Rule がこれを尊重するとクローラが NAS に届かない |
| 連合先の表示 | NodeInfo のバージョンを `2026.10.0-A55.4` にする。名前は `misskey` のままなので、相手の画面は `misskey 2026.10.0-A55.4` になる |
| 未知アカウントの Delete（v2.1） | オブジェクトがアクター自身の URI（文字列でも埋め込みでも）で、そのユーザーが DB に無い Delete は取得も登録もしない。ノート削除は従来どおり |
| アカウント削除（v2.1） | ノートは 20 件ずつ、ファイルは 8 件ずつ消し、チャンクの間に 40ms 空ける。リンク行は SQL 一括削除。実ファイルだけ `deleteFileSync` |
| リンクの `/files/`（v2.1） | `isLink` のアクセスキーはリモート URI へ 302 する。種別判定のためのダウンロードをしない。キャッシュ済み実ファイルはそのまま配信 |
| リモート媒体（v2） | `uploadFromUrl` のリンク（`isLink`）経路でダウンロード自体をやめ、URL からファイル名・種別・md5 代用値を合成する。既知の URI は DB 参照だけで返す。ローカル投稿と既存キャッシュは従来どおり |
| jemalloc（v2） | `MALLOC_CONF=dirty_decay_ms:5000,muzzy_decay_ms:5000,narenas:2`。解放済みページの残留を減らし、768MB 制限の cgroup 圧迫を下げる |
| ピン留め解決（v3） | リモートの `featured`（プロフィールピン）は取得しない。ピンは最大 5 ノート＋添付の再帰解決になるため、Person 更新から外す |
| フォロー収集（v3） | `following` / `followers` コレクションの公開判定 HTTP をしない。プロフィール上は非公開扱い。フォロー自体は従来どおり |
| インスタンス見た目（v3） | 連合先メタデータは NodeInfo だけ取る。HTML・manifest・favicon の HEAD はしない。ソフト名と版は残る |
| Webhook 並列（v3） | ユーザー webhook 64→2、システム webhook 16→1。ジョブは同じイベントループ |
| 外向き IPv4（v3） | `outgoingAddressFamily: ipv4` と `--dns-result-order=ipv4first`。QNAP で死にがちな IPv6 待ちを避ける |
| libuv（v3） | `UV_THREADPOOL_SIZE=2`。DNS/fs が 4 コアを postgres と取り合うのを抑える |
| ロール分離＆直接起動 | `web`（`MK_DISABLE_CLUSTERING=1`, `MK_ONLY_SERVER=1`, `cpuset: "0-2"`）と `queue`（`MK_DISABLE_CLUSTERING=1`, `MK_ONLY_QUEUE=1`, `MK_NO_DAEMONS=1`, `cpuset: "3"`）に分離し、`pnpm` ラッパーを介さず `exec node` で1コンテナ1プロセス化する |
| 同一ユーザー通知の折りたたみ | 短時間（30分以内）に同一ユーザーから連続して届いたリアクション・リノート・フォロー系の通知を自動で1枠に束ね、「`▼ <ユーザー名> からの通知をさらに N 件表示`」ボタンで開閉できるようにする（返信・メンション・引用は折りたたまず常時表示。WebSocketリアルタイム受信にも対応） |

プレースホルダは中性色の固定 blurhash です。投稿画像のぼかしプレビューの色は元画像を反映しません。

## リモート媒体のリンクスルー（v2）

2026-10-12 の夜間、連合ピークでワーカーが 195 秒周期（ガードの猶予 150 秒 + 停滞判定 45 秒）
で停止・再 fork を繰り返した事件の原因は、`cacheRemoteFiles` / `cacheRemoteSensitiveFiles` /
`proxyRemoteFiles` が全部オンで、misskey.io 等から流れる画像を**毎回 NAS がダウンロードして
sharp でサムネイル生成**していたことでした（このときの DB 状態: リモート由来 2,776 件・3.2GB）。

v2 は運用を「リンクスルー」に切り替えます。DB の `meta` で次の 3 フラグを false にすると、
新しいリモートファイルは `isLink` で登録され、sharp もサムネイルも走りません。

```sql
update meta set "cacheRemoteFiles" = false, "proxyRemoteFiles" = false,
                 "cacheRemoteSensitiveFiles" = false;
```

`patch-built.mjs` はそのリンク経路からさらにネットワーク取得を消します:

- **既知 URI の高速返却**: `uploadFromUrl` の先頭で `drive_file` を `uri` / `url` で検索し、
  登録済みならダウンロードなしで返す。プロフィール更新（`Update(Person)`）の連打はここで
  全部 DB ヒットになる
- **リンクの完全スキップ**: `isLink` のとき `downloadUrl` を呼ばず、URL の拡張子から
  `type` を、URL 文字列のハッシュから md5 代用値（`a55` + 16進 16 桁 + 0 埋め = 32 桁）を
  合成する。`addFile` 側も `getFileInfo`（実ファイル読み取り）をリンク時にスキップする。
  2つのパッチは組でバージョンされている —— 片方だけだと空の一時ファイルの md5
  （`d41d8cd9...`）が全リンクファイルで同一になり、ハッシュ重複排除が誤ヒットする

既存のキャッシュ済みファイル（webpublic/thumbnail 付き）はそのまま配信を続けます。
ローカルユーザーのアップロードは従来どおりフルパイプラインで処理されます。

トレードオフ: 新しいリモート画像は閲覧時に相手サーバー（misskey.io なら R2 の CDN）から
直接読む。相手が消した画像は過去ノートで表示できなくなる。拡張子の無い URL は
`application/octet-stream` になり、画像としてインライン表示されないことがある。

ロールバックは 3 フラグを true に戻すだけ（即時・可逆。イメージの戻しも compose の
タグ変更のみ）。

## 薄い連合（v2.1）

TS-233 は 4 コアの Cortex-A55 と 2GB で、そのうちコンテナに使えるのは約 1.25GB です。
ワーカーは 1 本のままです。v2 で画像の sharp を止めたあとに残っていたのは、
受信と同じループを止める仕事と、表示のたびに NAS が取りに行く経路です。

- **知らないアカウントの Delete を捨てる**。Mastodon は `object` にアクター URI の
  文字列を入れます。2026.10.0 の早期リターンは `object` がオブジェクトのときだけ
  動くので、知らないユーザーを取得して登録し、直後に `deleteAccount` を積んでいました。
  アクターとオブジェクトの URI が同じで DB にユーザーが無いときは、署名検証の前に戻します。
  ローカルにいるユーザーの削除と、ノートの Delete はそのまま処理します。
- **削除は少しずつ**。ノート 100 件の一括 `DELETE` と、ファイルごとのチャート更新が
  CPU を埋め、ガードが 45 秒でプロセスを殺していました。殺されたジョブは先頭から
  やり直すので、同じ削除が繰り返されます。20 件・8 件にして間でイベントループへ戻すと、
  心拍と受信が続き、ジョブは最後まで走ります。`isLink` でディスクに無い行は
  `DELETE` 一回です。ディスク上のファイル（v2 以前の 3.2GB を含む）は従来の削除です。
  リンク行のチャートは更新しません。サイズ 0 なので使用量の判定には効きません。
- **`/files/:key` のリンクは 302**。実体の無い行へのリクエストは、種別判定のために
  相手から一度ダウンロードしていました（sharp は走りません）。ブラウザと連合先は
  `Cache-Control: public, max-age=86400` 付きの 302 で相手の URL へ行きます。
  ローカル投稿と、すでに保存してあるリモートファイルは今までどおり NAS から出ます。

PostgreSQL は `jit=off` とパラレルクエリ無効です。重い `DELETE` の初回に JIT が
4 コアを使うと、Node の心拍まで遅れます。データディレクトリはそのままです。

```sh
cd Misskey-A55
sudo docker build -t misskey/misskey:2026.10.0-a55v2.1 .
# compose の image を 2026.10.0-a55v2.1 にしてから
cd ../misskey && sudo docker compose up -d db web
```

`db` の再作成はコマンド引数だけです。ボリュームは消しません。
ロールバックは image を `2026.10.0-a55v2` に戻して `up -d web` です。
Postgres の 2 フラグは v2 イメージでも有効なままにして構いません。

## イベントループを空ける（v3）

v2.1 のあとに残っていたのは、Person 更新の付き物と、本番 `default.yml` が
パッチのジョブ上限を上書きしていたことです。`default.yml` の値はイメージの
フォールバックより優先されます。TS-233 では配送 2 / 受信 1 のままにしてください。

- **ピンとコレクションを取らない**。`Update(Person)` はアバター（リンク）とプロフィール文を
  更新する。ピン留めノート 5 件の再帰解決と、following/followers の公開判定 GET はしない。
  リモートユーザーのピンは空のままになることがある。フォロー・アンフォロー・ノートはそのまま。
- **連合先の HTML を取らない**。NodeInfo だけ取ればソフト名と版は出る。トップページと
  favicon は管理画面のインスタンス一覧の見た目だけに使う。
- **IPv4 固定**。QNAP の IPv6 は応答しないことが多く、外向き GET がタイムアウトまで
  イベントループを占有する。`outgoingAddressFamily: ipv4` は本流の設定項目。
- **リモートチャートと URL プレビューを止める**（`example/v3-meta.sql`）。
  ノート1件ごとの per-user / instance チャート書き込みと、リンクカード用の HTML 取得は
  プロトコルに不要。管理画面からいつでも戻せる。
- **Postgres**: `autovacuum_max_workers=1`, `wal_compression=on`,
  `idle_in_transaction_session_timeout=30s`。WAL を小さくし、止まったトランザクションを切る。

```sh
cd Misskey-A55
sudo docker build -t misskey/misskey:2026.10.0-a55v3 .
# compose の image を 2026.10.0-a55v3 にしてから
cd ../misskey && sudo docker compose up -d db web
sudo docker exec -i misskey-db psql -U misskey -d misskey < example/v3-meta.sql
```

ロールバックは image を `2026.10.0-a55v2.1` に戻して `up -d web`。meta の 4 フラグは
true に戻せばチャートとプレビューが復活する。

## サーバーメトリクス（ログイン限定）

ウィジェット「サーバーメトリクス」は、管理画面（コントロールパネル → パフォーマンス →
「サーバーのマシン情報を公開する」）で公開を有効にすると、本来は**ログインしていない
閲覧者にも**マシン名・CPU・メモリ・ディスク情報とライブ統計（2秒毎のストリーム）を
返します。このパッチは両方をログインユーザー限定にします。

- ストリーム（`serverStats` チャンネル）: `requireCredential` を true にする。匿名接続は
  チャンネル接続ごと黙って拒否され、グラフは動かない
- `server-info` エンドポイント: 形状は変えず、リクエストがユーザーを伴わないときは
  公開オフ時と同じプレースホルダ（`machine:"?"`, `cores:0` …）を返す
- ウィジェットのラベル取得だけトークン付きにする: `misskeyApiGet("server-info")` は
  トークンを送らないため、そのままではログインユーザーにもラベルが `?` になる。
  この1呼び出しだけ `?i=<token>` を付ける（WebSocket と同じ仕組み）

有効化の手順:

1. コントロールパネル → パフォーマンス →「サーバーのマシン情報を公開する」をオン
2. `sudo docker compose restart web`（収集デーモンは起動時にフラグを見る。管理画面での
   切り替えだけでは開始しない）
3. ウィジェット編集で「サーバーメトリクス」を追加

注意:

- ジョブキューのウィジェット（`queueStats` チャンネル）は対象外
- `admin/server-info`（管理画面のサーバー情報ページ）は元から管理者限定で、変更していない
- **ブラウザキャッシュ**: `/vite/**.js` は `Cache-Control: max-age=2592000, immutable` で配信される。
  本パッチは内容を同じファイル名のまま書き換えるため、パッチ前にチャンクを読み込んだブラウザは
  旧コードを最長30日使い続ける（メモリ/ディスクの表示だけ `?`/`0` のまま）。**スーパーリロード
  （Ctrl+Shift+R）** またはサイトデータの削除で即座に解消する。ベースイメージを更新すると
  ファイル名のハッシュが変わり、この問題は起きない

## 連合先への表示

連合先は NodeInfo の `software.name` と `software.version` を並べて出します。名前は `misskey` 固定です。ここを変えると、相手がこのサーバーを Misskey として扱わなくなります。バージョンだけ `2026.10.0-A55.4` にします。

サーバーは起動時に `/misskey/built/meta.json` を読み、NodeInfo と `/api/meta` と送信時の User-Agent（`Misskey/2026.10.0-A55.4 (サイトのURL)`）に使います。フロントエンドに焼き込まれた版は `2026.10.0` のままです。概要ページと、言語ファイルの URL は変わりません。

`2026.10.0-A55.4` は semver のプレリリースで、比較すると `2026.10.0` より前になります。Misskey は相手のバージョン文字列では機能を切り替えません。配送を止めるのは、管理画面で指定したソフトとバージョン範囲に一致したときだけです。

相手は NodeInfo をキャッシュします。表示が切り替わるのは、相手が次に取りに来たあとです。

## イメージの外で足すもの

`example/compose.yml` に PostgreSQL と Redis のメモリ上限を入れています。

- PostgreSQL: `shared_buffers=64MB`, `max_connections=20`, `wal_compression=on`, コンテナ上限 384MB
- Redis: `maxmemory 64mb`, `noeviction`（ジョブを LRU で捨てない）, コンテナ上限 96MB
- Misskey: ヒープ 400MB、IPv4 DNS、`UV_THREADPOOL_SIZE=2`、コンテナ上限 768MB

`example/a55.config.yml` は `default.yml` に貼るジョブ設定です。省略してもイメージ側のフォールバックが同じ値です。明示すると、あとから大きいマシンへ移したときに値の所在が分かります。

Meilisearch とセンシティブ画像判定（動画の ffmpeg 解析を含む）は無効のままにしてください。

## 使い方

TS-233 上でビルドしてください。`@node-rs/bcrypt` のネイティブバイナリは、ビルドした CPU 向けのものが入ります。

```sh
cd Misskey-A55
sudo docker build -t misskey/misskey:2026.10.0-a55v4 .

# docker-compose で image: misskey/misskey:2026.10.0-a55v4 を指定して up
```

`example/` に Misskey + PostgreSQL 18 + Redis 7 + cloudflared のテンプレートがあります。`.config` 内のパスワードは自分のものに書き換えてください。

## 送受信を止めない

Misskey はマスタープロセスが HTTP を出し、ワーカー 1 本が受信・配送・アカウント削除を同じイベントループで処理します。`clusterLimit` は 1 のままです。ワーカーを増やすメモリはありません。

ループが同期処理で止まると、ノートの受信も配送もそこで止まります。PostgreSQL から見ると接続は `idle` / `ClientRead` のまま残り、Docker のヘルスチェックはマスターの HTTP が応答するので成功します。`entry.ts` は終了したワーカーを fork し直します。止まっているだけで終了していないワーカーは、その対象になりません。

`a55-guard.cjs` を `.config/` に置き、`NODE_OPTIONS` に `--require /misskey/.config/a55-guard.cjs` を足します。起動から 150 秒は起動処理を見送り、その後は別スレッドがイベントループの心拍を見ます。実行中ジョブがある状態で 180 秒止まったら、ジョブを Redis の delayed へ退避してからそのプロセスだけを止めます。ジョブが無い stall は 10 分まで許します（soft-stall を `a55:events` に残す）。HTTP 専用プロセスは 5 分です。Misskey がワーカーを fork し直すので HTTP は続き、受信キューが先に流れます。同じジョブが再び止めた場合は待ち時間を倍にして、最大 1 時間まで後ろへ回します。マスター自身が止まったときはそのプロセスを止め、Docker の再起動に任せます。

v5 の追加:

- **idle 耐性**: `active=none` の stall を即殺しない（`IDLE_STALL_MS=600s`）。TS-233 で観測された 4.5 分周期の再起動嵐（猶予 150s + 旧 STALL 120s）の主因は、swap / 単一コア競合による心拍遅延だった
- **サーバー閾値**: `SERVER_STALL_MS=300s`。web を巻き込んだ再起動がメモリ圧を悪化させるのを防ぐ
- **cpuset**: web `0-1` / queue `2-3`。queue に 2 コアを渡し、心拍用の余裕を確保する

v5.1 の追加（2026-10-18 の TL 停止事故対応）:

- **ホスト圧迫時の延命**: 1 分ロードが `HOST_PRESSURE_LOAD`(4.5) 以上なら、idle/server とも
  kill を `HOST_STALL_MS`(900s) まで猶予する。当日 12:33 JST に web と queue が **2 秒差で
  同時停滞**（load 6.33）したことから、実行中フリーズの相当部分はホスト側の CPU/IO 圧迫で、
  kill→再起動のコールドページインが圧迫をさらに悪化させるため
- **スレッド単位採取**: stall/soft-stall イベントに全スレッドの
  `state/utime/stime/wchan`（`thr=…`）を残す。次回フリーズで「メインスレッドがユーザ空間で
  回っているのかカーネル空間で回っているのか」をイベントログだけで判定できる

2026-10-18 の切分け結果（再発時の参考）:

- **公式イメージ `misskey/misskey:2026.10.0` でもキューは正常稼働した**
  （BullMQ ワーカーのポーリング・inbox 処理・ユーザ fetch すべて確認）。
  a55 パッチ層・bcrypt ネイティブ化・`MALLOC_CONF`・guard はいずれも実行中フリーズの
  原因ではない
- 起動直後の「`utime≈0` のまま `stime` が燃える」現象は **コールドページインの正常動作**
  （全イメージ共通、ワーカー起動まで 2〜3 分）。フリーズと誤診しないこと
- Misskey 2026.10.0 のキューは **BullMQ**。キーは `<prefix>:queue:<name>:<name>:*` で
  ワーカーは `bzpopmin` で待機する。旧 Bull の `<prefix>:<q>:client` キーは存在しないので
  死活判定に使えない。死活は `redis-cli monitor` で `bzpopmin` を見るのが確実

v2 の追加:

- **毒ジョブの断裁**: 同じジョブの停滞が 3 回（`POISON_STRIKES`）に達したら退避せず
  破棄する（ジョブ本体・delayed・lock を削除）。再試行のたびにワーカーを殺す
  再犯ジョブ（実測では inbox 1 件が 41 回）を恒久的に排除する
- **起動時スイープ**: プロセス起動時に `a55:stall:*` を走査し、ストライク 3 以上の
  ジョブを一掃する。滞留バックログが次回起動で自動解消される
- **イベント履歴**: 停滞・断裁・スイープの結果を `<prefix>:a55:events`（最新 100 件）に
  記録する。SIGKILL で stderr が失われるため、事後解析はこちらで行う

```sh
docker exec misskey-redis redis-cli lrange smb-chan.dev:a55:events 0 -1   # 履歴を見る
```

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
