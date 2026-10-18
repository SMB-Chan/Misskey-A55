'use strict';

/*
 * Misskey のマスターは HTTP だけを見て、ジョブはワーカー 1 本のイベントループで動く。
 * ループが同期処理で止まると受信も配送も止まり、ヘルスチェックは成功したままになる。
 * マスターはワーカーが死んでも fork し直さない。
 *
 * このファイルは NODE_OPTIONS=--require で両プロセスに入る。
 * 監視は別スレッドで行う。ループが止まったら実行中ジョブを Redis の delayed へ退避し、
 * そのプロセスだけを SIGKILL する。終了したワーカーは Misskey 本体（entry.ts）が fork し直す。
 * アカウント削除のような重いジョブは受信キューより後ろに回る。
 *
 * v5: 単一コア + swap 下の誤殺対策。
 * - 実行中ジョブが無い stall は IDLE_STALL_MS（10分）まで許す（soft-stall を記録）
 * - サーバー（HTTP）は SERVER_STALL_MS（5分）まで許す（web 再起動嵐を防ぐ）
 * - アクティブジョブありは STALL_MS 180s で従来どおり断裁
 *
 * v5.1: ホスト圧迫時の延命と停滞時のスレッド単位採取。
 * - 1分ロードが HOST_PRESSURE_LOAD 以上なら kill を HOST_STALL_MS まで猶予する
 *   （2026-10-18 の切分けで web+queue が同時停滞したのはホスト側圧迫で、
 *   再起動のコールドページインが圧迫をさらに悪化させるため）
 * - stall/soft-stall のイベントに全スレッドの utime/stime/state/wchan を残す
 *   （次回フリーズの主犯スレッドをイベントログだけで特定できるようにする）
 *
 * v4: 停滞直前のブレッドクラム（心拍時スタック）と /proc 情報を a55:events に残す。
 * STALL_MS を 120s に緩和（単一コア + swap 下での誤殺を減らす）。
 *
 * v3: 設定側で配信/受信並列と IPv4 固定を下げたあとの保険。
 *
 * v2: ストライク（同一ジョブの停滞回数）が 3 を超えたジョブは再試行させず破棄する。
 * 起動時に a55:stall:* を走査して毒ジョブを一掃し、停滞・破棄は Redis の
 * a55:events に記録する（SIGKILL で stderr が失われるため、事後解析はこちらで行う）。
 */

const fs = require('node:fs');
const net = require('node:net');
const cluster = require('node:cluster');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

const CONFIG_PATH = process.env.A55_GUARD_CONFIG || '/misskey/.config/default.yml';
const BREADCRUMB_PATH = process.env.A55_BREADCRUMB_PATH || '/tmp/a55-breadcrumb.txt';
const STALL_MS = 180000;
const IDLE_STALL_MS = 600000;
const SERVER_STALL_MS = 300000;
const HOST_PRESSURE_LOAD = 4.5;
const HOST_STALL_MS = 900000;
const GRACE_MS = 150000;
const POISON_STRIKES = 3;
const QUEUE_NAMES = ['inbox', 'deliver', 'relationship', 'object'];

function stripYaml(value) {
	let text = String(value).replace(/\s+#.*$/, '').trim();
	if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
		text = text.slice(1, -1);
	}
	return text;
}

function readRedisConfig(path) {
	const text = fs.readFileSync(path, 'utf8');
	let section = '';
	let url = '';
	const redis = {};
	for (const raw of text.split('\n')) {
		const line = raw.replace(/\r$/, '');
		if (!line.trim() || /^\s*#/.test(line)) continue;
		if (!/^\s/.test(line)) {
			const top = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
			if (!top) {
				section = '';
				continue;
			}
			section = top[1];
			if (section === 'url') url = stripYaml(top[2]);
			continue;
		}
		if (section !== 'redis') continue;
		const kv = line.match(/^\s+([A-Za-z0-9_]+):\s*(.*)$/);
		if (!kv) continue;
		redis[kv[1]] = stripYaml(kv[2]);
	}
	let prefix = redis.prefix || '';
	if (!prefix && url) {
		try {
			prefix = new URL(url).host;
		} catch (e) {
			prefix = '';
		}
	}
	if (!prefix) prefix = 'misskey';
	return {
		host: redis.host || 'redis',
		port: Number(redis.port || 6379),
		username: redis.username || redis.user || '',
		pass: redis.pass || redis.password || '',
		db: Number(redis.db || 0),
		prefix,
	};
}

function encode(args) {
	const parts = ['*' + args.length];
	for (const arg of args) {
		const text = String(arg);
		parts.push('$' + Buffer.byteLength(text), text);
	}
	return Buffer.from(parts.join('\r\n') + '\r\n', 'utf8');
}

function parseOne(buf, offset) {
	if (offset >= buf.length) return null;
	const type = String.fromCharCode(buf[offset]);
	const lineEnd = buf.indexOf('\r\n', offset);
	if (lineEnd < 0) return null;
	const line = buf.toString('utf8', offset + 1, lineEnd);
	if (type === '+') return { value: line, i: lineEnd + 2 };
	if (type === ':') return { value: Number(line), i: lineEnd + 2 };
	if (type === '-') return { value: new Error(line), i: lineEnd + 2 };
	if (type === '$') {
		const len = Number(line);
		if (len < 0) return { value: null, i: lineEnd + 2 };
		const start = lineEnd + 2;
		const end = start + len;
		if (buf.length < end + 2) return null;
		return { value: buf.toString('utf8', start, end), i: end + 2 };
	}
	if (type === '*') {
		const count = Number(line);
		if (count < 0) return { value: null, i: lineEnd + 2 };
		let pos = lineEnd + 2;
		const values = [];
		for (let n = 0; n < count; n++) {
			const item = parseOne(buf, pos);
			if (!item) return null;
			values.push(item.value);
			pos = item.i;
		}
		return { value: values, i: pos };
	}
	throw new Error('unknown redis reply');
}

function redisExec(cfg, commands) {
	return new Promise((resolve, reject) => {
		const pending = [];
		if (cfg.pass) {
			pending.push(cfg.username ? ['AUTH', cfg.username, cfg.pass] : ['AUTH', cfg.pass]);
		}
		if (cfg.db) pending.push(['SELECT', String(cfg.db)]);
		pending.push(...commands);
		const socket = net.connect(cfg.port, cfg.host);
		const chunks = [];
		let settled = false;
		const fail = (err) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			reject(err);
		};
		socket.setTimeout(8000, () => fail(new Error('redis timeout')));
		socket.on('error', fail);
		socket.on('connect', () => {
			for (const command of pending) socket.write(encode(command));
		});
		socket.on('data', (chunk) => {
			chunks.push(chunk);
			const buf = Buffer.concat(chunks);
			let pos = 0;
			const values = [];
			for (let n = 0; n < pending.length; n++) {
				let parsed;
				try {
					parsed = parseOne(buf, pos);
				} catch (err) {
					fail(err);
					return;
				}
				if (!parsed) return;
				values.push(parsed.value);
				pos = parsed.i;
			}
			if (settled) return;
			settled = true;
			socket.end();
			const offset = (cfg.pass ? 1 : 0) + (cfg.db ? 1 : 0);
			if (values[0] instanceof Error) {
				reject(values[0]);
				return;
			}
			resolve(values.slice(offset));
		});
	});
}

function recordEvent(cfg, text) {
	const line = new Date().toISOString() + ' ' + text;
	return redisExec(cfg, [
		['LPUSH', cfg.prefix + ':a55:events', line],
		['LTRIM', cfg.prefix + ':a55:events', '0', '99'],
	]).catch(() => {});
}

function writeBreadcrumb() {
	try {
		const mem = process.memoryUsage();
		const stack = (new Error('a55-breadcrumb')).stack || '';
		const lines = stack.split('\n').slice(2, 12).join(' | ');
		const body = [
			'ts=' + Date.now(),
			'rss=' + mem.rss,
			'heap=' + mem.heapUsed,
			'ext=' + mem.external,
			'stack=' + lines.replace(/\s+/g, ' ').slice(0, 900),
		].join('\n');
		fs.writeFileSync(BREADCRUMB_PATH, body);
	} catch (e) {
		/* ignore */
	}
}

function readBreadcrumb() {
	try {
		return fs.readFileSync(BREADCRUMB_PATH, 'utf8').replace(/\n/g, '; ').slice(0, 1000);
	} catch (e) {
		return '(no-breadcrumb)';
	}
}

function readLoad1() {
	try {
		return Number(fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]) || 0;
	} catch (e) {
		return 0;
	}
}

function readProcDiag() {
	const parts = [];
	try {
		const st = fs.readFileSync('/proc/self/status', 'utf8');
		for (const key of ['VmRSS', 'VmSwap', 'Threads', 'voluntary_ctxt_switches', 'nonvoluntary_ctxt_switches']) {
			const m = st.match(new RegExp('^' + key + ':\\s*(.+)$', 'm'));
			if (m) parts.push(key + '=' + m[1].trim());
		}
	} catch (e) {
		parts.push('status=?');
	}
	try {
		parts.push('load=' + fs.readFileSync('/proc/loadavg', 'utf8').trim().split(' ').slice(0, 3).join(','));
	} catch (e) {
		/* ignore */
	}
	// v5.1: every thread with state/utime/stime/wchan. The stat line's comm field
	// can contain spaces, so fields are taken after the final ')'.
	try {
		const tasks = fs.readdirSync('/proc/self/task');
		const thr = [];
		for (const tid of tasks) {
			try {
				const st = fs.readFileSync('/proc/self/task/' + tid + '/stat', 'utf8');
				const end = st.lastIndexOf(')');
				const f = st.slice(end + 2).split(' ');
				const wch = fs.readFileSync('/proc/self/task/' + tid + '/wchan', 'utf8').trim();
				thr.push(tid + ':' + f[0] + '/u' + f[11] + '/s' + f[12] + '/' + wch);
			} catch (e) {
				/* skip thread */
			}
		}
		if (thr.length) parts.push('thr=' + thr.join(','));
	} catch (e) {
		/* ignore */
	}
	return parts.join(' ');
}

async function queueCardinality(cfg, key) {
	try {
		const z = await redisExec(cfg, [['ZCARD', key]]);
		if (!(z[0] instanceof Error) && typeof z[0] === 'number') return z[0];
	} catch (e) {
		/* try list */
	}
	try {
		const n = await redisExec(cfg, [['LLEN', key]]);
		if (!(n[0] instanceof Error) && typeof n[0] === 'number') return n[0];
	} catch (e) {
		/* ignore */
	}
	return 0;
}

async function countActiveJobs(cfg) {
	let total = 0;
	for (const q of QUEUE_NAMES) {
		total += await queueCardinality(cfg, cfg.prefix + ':queue:' + q + ':' + q + ':active');
	}
	return total;
}

async function dumpActiveJobNames(cfg) {
	const names = [];
	try {
		let cursor = '0';
		const keys = [];
		do {
			const reply = await redisExec(cfg, [['SCAN', cursor, 'MATCH', cfg.prefix + ':queue:*:active', 'COUNT', '200']]);
			const page = reply[0];
			if (page instanceof Error || !Array.isArray(page) || page.length < 2) break;
			cursor = String(page[0]);
			if (Array.isArray(page[1])) keys.push(...page[1].map(String));
		} while (cursor !== '0');
		for (const key of keys) {
			if (!key.endsWith(':active')) continue;
			const base = key.slice(0, -':active'.length);
			let ids = [];
			try {
				const z = await redisExec(cfg, [['ZRANGE', key, '0', '4']]);
				if (Array.isArray(z[0])) ids = z[0].map(String);
			} catch (e) {
				/* ignore */
			}
			if (ids.length === 0) {
				const idsReply = await redisExec(cfg, [['LRANGE', key, '0', '4']]);
				if (Array.isArray(idsReply[0])) ids = idsReply[0].map(String);
			}
			for (const id of ids.slice(0, 5)) {
				const nameReply = await redisExec(cfg, [['HGET', base + ':' + id, 'name']]);
				names.push(id + '=' + (nameReply[0] || '?'));
			}
		}
	} catch (e) {
		return 'active-err';
	}
	return names.length ? names.join(',') : 'active=none';
}

function dropJobCommands(base, id, activeKey, countKey) {
	return [
		['DEL', base + ':' + id],
		['ZREM', base + ':delayed', id],
		['LREM', activeKey, '0', id],
		['DEL', base + ':' + id + ':lock'],
		['DEL', countKey],
	];
}

async function quarantine(cfg) {
	let cursor = '0';
	const keys = [];
	do {
		const reply = await redisExec(cfg, [['SCAN', cursor, 'MATCH', cfg.prefix + ':queue:*:active', 'COUNT', '200']]);
		const page = reply[0];
		if (page instanceof Error) throw page;
		if (!Array.isArray(page) || page.length < 2) break;
		cursor = String(page[0]);
		if (Array.isArray(page[1])) keys.push(...page[1].map(String));
	} while (cursor !== '0');

	let moved = 0;
	let dropped = 0;
	for (const key of keys) {
		if (!key.endsWith(':active')) continue;
		const base = key.slice(0, -':active'.length);
		let ids = [];
		try {
			const z = await redisExec(cfg, [['ZRANGE', key, '0', '-1']]);
			if (Array.isArray(z[0])) ids = z[0].map(String);
		} catch (e) {
			/* ignore */
		}
		if (ids.length === 0) {
			const idsReply = await redisExec(cfg, [['LRANGE', key, '0', '-1']]);
			if (Array.isArray(idsReply[0])) ids = idsReply[0].map(String);
		}
		if (ids.length === 0) continue;
		for (const id of ids) {
			const countKey = cfg.prefix + ':a55:stall:' + base + ':' + id;
			const countReply = await redisExec(cfg, [['INCR', countKey]]);
			const count = Number(countReply[0]) || 1;
			if (count >= POISON_STRIKES) {
				await redisExec(cfg, dropJobCommands(base, id, key, countKey));
				dropped++;
				console.error('A55 guard: dropped poison job ' + id + ' (' + base + ') strikes=' + count);
				continue;
			}
			const delay = Math.min(60 * 60 * 1000, 60 * 1000 * (2 ** (Math.min(count, 8) - 1)));
			const score = String(Date.now() + delay);
			await redisExec(cfg, [
				['EXPIRE', countKey, '86400'],
				['ZADD', base + ':delayed', score, id],
				['LREM', key, '0', id],
				['DEL', base + ':' + id + ':lock'],
			]);
			moved++;
			console.error('A55 guard: delayed ' + id + ' (' + base + ') ' + delay + 'ms');
		}
	}
	return { moved, dropped };
}

async function purgePoisonAtBoot(cfg) {
	const head = cfg.prefix + ':a55:stall:';
	let cursor = '0';
	let dropped = 0;
	do {
		const reply = await redisExec(cfg, [['SCAN', cursor, 'MATCH', head + '*', 'COUNT', '200']]);
		const page = reply[0];
		if (page instanceof Error) throw page;
		if (!Array.isArray(page) || page.length < 2) break;
		cursor = String(page[0]);
		for (const rawKey of page[1].map(String)) {
			const rest = rawKey.slice(head.length);
			const split = rest.lastIndexOf(':');
			if (split < 0) continue;
			const base = rest.slice(0, split);
			const id = rest.slice(split + 1);
			const countReply = await redisExec(cfg, [['GET', rawKey]]);
			const count = Number(countReply[0]) || 0;
			if (count < POISON_STRIKES) continue;
			await redisExec(cfg, dropJobCommands(base, id, base + ':active', rawKey));
			dropped++;
			console.error('A55 guard: boot purge dropped ' + id + ' (' + base + ') strikes=' + count);
		}
	} while (cursor !== '0');
	if (dropped > 0) await recordEvent(cfg, 'boot purge dropped ' + dropped + ' poison job(s)');
	return dropped;
}

function kickBootPurge() {
	let cfg;
	try {
		cfg = readRedisConfig(CONFIG_PATH);
	} catch (err) {
		console.error('A55 guard: boot purge config failed: ' + (err && err.message ? err.message : err));
		return;
	}
	purgePoisonAtBoot(cfg).catch((err) => {
		console.error('A55 guard: boot purge failed: ' + (err && err.message ? err.message : err));
	});
}

let killing = false;
function quarantineThenKill(label, canQuarantine, stalledForMs) {
	if (killing) return;
	killing = true;
	let cfg;
	try {
		cfg = readRedisConfig(CONFIG_PATH);
	} catch (err) {
		console.error('A55 guard: config read failed: ' + (err && err.message ? err.message : err));
		process.kill(process.pid, 'SIGKILL');
		return;
	}
	const diag = 'stallMs=' + stalledForMs + ' ' + readProcDiag() + ' crumb={' + readBreadcrumb() + '}';
	if (!canQuarantine) {
		console.error('A55 guard: ' + label + ' stalled (server-only, skipping queue quarantine)');
		recordEvent(cfg, label + ' stalled: server-only restart | ' + diag).then(() => {
			process.kill(process.pid, 'SIGKILL');
		});
		return;
	}
	Promise.all([quarantine(cfg), dumpActiveJobNames(cfg)]).then(([res, active]) => {
		console.error('A55 guard: ' + label + ' stalled, delayed ' + res.moved + ', dropped ' + res.dropped + ' active job(s)');
		return recordEvent(
			cfg,
			label + ' stalled: delayed ' + res.moved + ', dropped ' + res.dropped + ' | ' + active + ' | ' + diag,
		).then(() => {
			process.kill(process.pid, 'SIGKILL');
		});
	}, (err) => {
		console.error('A55 guard: quarantine failed: ' + (err && err.message ? err.message : err));
		recordEvent(cfg, label + ' stalled: quarantine-failed | ' + diag).finally(() => {
			process.kill(process.pid, 'SIGKILL');
		});
	});
}

function startWatch() {
	let last = Date.now();
	const started = last;
	const label = (workerData && workerData.label) || 'worker';
	const canQuarantine = Boolean(workerData && workerData.canQuarantine);
	let checking = false;
	let lastSoftLog = 0;
	if (canQuarantine) {
		kickBootPurge();
	}
	parentPort.on('message', (stamp) => {
		last = Number(stamp) || Date.now();
	});
	const timer = setInterval(() => {
		const now = Date.now();
		if (now - started < GRACE_MS) {
			last = now;
			return;
		}
		const stalledFor = now - last;
		const floor = canQuarantine ? STALL_MS : SERVER_STALL_MS;
		if (stalledFor <= floor || checking) return;
		checking = true;
		let cfg;
		try {
			cfg = readRedisConfig(CONFIG_PATH);
		} catch (err) {
			checking = false;
			clearInterval(timer);
			console.error('A55 guard: ' + label + ' event loop stalled ' + stalledFor + 'ms (config-failed)');
			quarantineThenKill(label, canQuarantine, stalledFor);
			return;
		}
		const decide = canQuarantine
			? countActiveJobs(cfg).then((active) => {
				if (active > 0) return { action: 'kill', active };
				const load1 = readLoad1();
				const cap = load1 >= HOST_PRESSURE_LOAD ? HOST_STALL_MS : IDLE_STALL_MS;
				if (stalledFor >= cap) return { action: 'kill', active: 0 };
				return { action: 'soft', active: 0, load1, cap };
			})
			: Promise.resolve().then(() => {
				const load1 = readLoad1();
				if (load1 >= HOST_PRESSURE_LOAD && stalledFor < HOST_STALL_MS) {
					return { action: 'soft', active: -1, load1, cap: HOST_STALL_MS };
				}
				return { action: 'kill', active: -1, load1 };
			});
		decide.then(({ action, active, load1, cap }) => {
			if (action === 'soft') {
				if (now - lastSoftLog > 60000) {
					lastSoftLog = now;
					const diag = 'stallMs=' + stalledFor + ' active=' + active + ' load1=' + load1 + ' cap=' + cap + ' ' + readProcDiag();
					console.error('A55 guard: ' + label + ' soft-stall forgiven ' + stalledFor + 'ms');
					recordEvent(cfg, label + ' soft-stall forgiven: active=' + active + ' cap=' + cap + ' | ' + diag);
				}
				return;
			}
			clearInterval(timer);
			console.error('A55 guard: ' + label + ' event loop stalled ' + stalledFor + 'ms active=' + active);
			quarantineThenKill(label, canQuarantine, stalledFor);
		}, (err) => {
			clearInterval(timer);
			console.error('A55 guard: stall check failed: ' + (err && err.message ? err.message : err));
			quarantineThenKill(label, canQuarantine, stalledFor);
		}).finally(() => {
			checking = false;
		});
	}, 2000);
}

function armWatch(label, canQuarantine) {
	const watcher = new Worker(__filename, { workerData: { role: 'watch', label, canQuarantine } });
	watcher.unref();
	watcher.on('error', (err) => {
		console.error('A55 guard thread error: ' + (err && err.message ? err.message : err));
	});
	writeBreadcrumb();
	const timer = setInterval(() => {
		try {
			writeBreadcrumb();
			watcher.postMessage(Date.now());
		} catch (e) {
			/* watcher already gone */
		}
	}, 1000);
	watcher.postMessage(Date.now());
}

const arg1 = (process.argv && process.argv[1]) ? String(process.argv[1]) : '';
const isSelftest = require.main === module || /(?:^|[/\\])a55-guard\.cjs$/.test(arg1);
const isMisskeyEntry = /(?:^|[/\\])entry\.js$/.test(arg1);

if (!isMainThread) {
	if (workerData && workerData.role === 'watch') startWatch();
} else if (isSelftest && !global.__a55SelftestRan) {
	global.__a55SelftestRan = true;
	const cfg = readRedisConfig(CONFIG_PATH);
	console.log('prefix=' + cfg.prefix + ' host=' + cfg.host + ' port=' + cfg.port + ' db=' + cfg.db + ' auth=' + (cfg.pass ? 'yes' : 'no'));
	redisExec(cfg, [['PING']]).then(async (pong) => {
		if (pong[0] instanceof Error) throw pong[0];
		console.log('ping=' + pong[0]);
		let cursor = '0';
		const keys = [];
		do {
			const reply = await redisExec(cfg, [['SCAN', cursor, 'MATCH', cfg.prefix + ':queue:*:wait', 'COUNT', '200']]);
			const page = reply[0];
			if (page instanceof Error) throw page;
			cursor = String(page[0]);
			for (const key of page[1]) keys.push(String(key));
		} while (cursor !== '0');
		for (const key of keys) {
			const n = await redisExec(cfg, [['LLEN', key]]);
			if (Number(n[0]) > 0) console.log(key + ' ' + n[0]);
		}
		console.log('SELFTEST_OK');
	}).catch((err) => {
		console.error('SELFTEST_FAIL ' + (err && err.message ? err.message : err));
		process.exit(1);
	});
} else if (isMisskeyEntry && !global.__a55GuardArmed) {
	global.__a55GuardArmed = true;
	const onlyServer = Boolean(process.env.MK_ONLY_SERVER);
	const onlyQueue = Boolean(process.env.MK_ONLY_QUEUE);
	const disableClustering = Boolean(process.env.MK_DISABLE_CLUSTERING);
	if (cluster.isWorker) {
		const label = onlyServer ? 'server-worker' : 'worker';
		armWatch(label, !onlyServer);
		console.error('A55 guard: ' + label + ' armed');
	} else if (cluster.isPrimary) {
		const label = onlyServer ? 'server' : onlyQueue ? 'queue' : 'primary';
		const canQuarantine = !onlyServer && (onlyQueue || disableClustering);
		armWatch(label, canQuarantine);
		console.error('A55 guard: ' + label + ' armed (quarantine=' + (canQuarantine ? 'on' : 'off') + ')');
	}
}
