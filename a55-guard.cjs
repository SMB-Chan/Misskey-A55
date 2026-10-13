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
 * v3: 設定側で配信/受信並列と IPv4 固定を下げたあとの保険。ガード閾値は変えない。
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
const STALL_MS = 45000;
const GRACE_MS = 150000;
const POISON_STRIKES = 3;

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
		const idsReply = await redisExec(cfg, [['LRANGE', key, '0', '-1']]);
		const ids = idsReply[0];
		if (!Array.isArray(ids) || ids.length === 0) continue;
		for (const id of ids.map(String)) {
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
function quarantineThenKill(label) {
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
	quarantine(cfg).then((res) => {
		console.error('A55 guard: ' + label + ' stalled, delayed ' + res.moved + ', dropped ' + res.dropped + ' active job(s)');
		return recordEvent(cfg, label + ' stalled: delayed ' + res.moved + ', dropped ' + res.dropped).then(() => {
			process.kill(process.pid, 'SIGKILL');
		});
	}, (err) => {
		console.error('A55 guard: quarantine failed: ' + (err && err.message ? err.message : err));
		process.kill(process.pid, 'SIGKILL');
	});
}

function startWatch() {
	let last = Date.now();
	const started = last;
	parentPort.on('message', (stamp) => {
		last = Number(stamp) || Date.now();
	});
	const timer = setInterval(() => {
		const now = Date.now();
		if (now - started < GRACE_MS) {
			last = now;
			return;
		}
		if (now - last > STALL_MS) {
			clearInterval(timer);
			console.error('A55 guard: ' + workerData.label + ' event loop stalled ' + (now - last) + 'ms');
			quarantineThenKill(workerData.label);
		}
	}, 2000);
}

function armWatch(label) {
	const watcher = new Worker(__filename, { workerData: { role: 'watch', label } });
	watcher.unref();
	watcher.on('error', (err) => {
		console.error('A55 guard thread error: ' + (err && err.message ? err.message : err));
	});
	const timer = setInterval(() => {
		try {
			watcher.postMessage(Date.now());
		} catch (e) {
			/* watcher already gone */
		}
	}, 1000);
	timer.unref();
	watcher.postMessage(Date.now());
}

function armWorker() {
	armWatch('worker');
	console.error('A55 guard: worker armed');
	kickBootPurge();
}

if (!isMainThread) {
	if (workerData && workerData.role === 'watch') startWatch();
} else if (require.main === module) {
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
} else if (!global.__a55GuardArmed) {
	global.__a55GuardArmed = true;
	if (cluster.isWorker) armWorker();
	else if (cluster.isPrimary) {
		armWatch('primary');
		console.error('A55 guard: primary armed');
		kickBootPurge();
	}
}
