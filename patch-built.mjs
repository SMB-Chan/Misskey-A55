/**
 * Rewrite the Misskey 2026.10.0 production bundle for a 2GB Cortex-A55.
 *
 * bcryptjs and blurhash are inlined by rolldown, so replacing node_modules
 * does not change the running server. This script patches the built chunks
 * and the external sharp package. It exits non-zero when a pattern is missing,
 * which means the base image layout changed and the patch must be updated.
 */
import { readdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = process.env.MISSKEY_ROOT ?? '/misskey';
const builtDir = process.env.BUILT_DIR ?? join(root, 'packages/backend/built');
const CACHE_LIMIT = 2048;
const BLURHASH = 'LEHV6nWB2yk8pyo0adR*.7kCMdnj';

const files = readdirSync(builtDir)
	.filter((name) => name.endsWith('.js'))
	.map((name) => join(builtDir, name));

// Every chunk this script rewrites is syntax-checked before the build can
// succeed. A single stray quote in a replacement turns the whole minified
// line into a syntax error that only surfaces when the server boots (v2
// shipped one once; this guard exists so it cannot happen again).
const touched = new Set();
function writeChecked(file, text) {
	writeFileSync(file, text);
	touched.add(file);
}

function replaceExact(from, to, min, max = min) {
	let hits = 0;
	let already = 0;
	for (const file of files) {
		const src = readFileSync(file, 'utf8');
		const count = src.split(from).length - 1;
		if (count === 0) {
			if (src.includes(to)) already++;
			continue;
		}
		writeChecked(file, src.split(from).join(to));
		hits += count;
	}
	if (hits === 0 && already > 0) {
		console.log(`already applied: ${to}`);
		return;
	}
	if (hits < min || hits > max) {
		throw new Error(`expected ${min}..${max} of [${from}], found ${hits}`);
	}
	console.log(`replaced ${hits}: ${from} -> ${to}`);
}

// Job defaults are sized for a VPS. An explicit value in default.yml still wins.
replaceExact('this.config.deliverJobConcurrency??128', 'this.config.deliverJobConcurrency??2', 1);
replaceExact('this.config.deliverJobPerSec??128', 'this.config.deliverJobPerSec??4', 1);
replaceExact('this.config.inboxJobConcurrency??16', 'this.config.inboxJobConcurrency??1', 1);
replaceExact('this.config.inboxJobPerSec??32', 'this.config.inboxJobPerSec??2', 1);
replaceExact('this.config.relationshipJobConcurrency??16', 'this.config.relationshipJobConcurrency??2', 1);
replaceExact('this.config.relationshipJobPerSec??64', 'this.config.relationshipJobPerSec??4', 1);
replaceExact('this.config.deliverJobMaxAttempts??12', 'this.config.deliverJobMaxAttempts??4', 2);
replaceExact('this.config.inboxJobMaxAttempts??8', 'this.config.inboxJobMaxAttempts??4', 1);
replaceExact('Math.max(256,e.deliverJobConcurrency??128)', 'Math.max(8,e.deliverJobConcurrency??2)', 1);

// Public-key and emoji caches keep entries for 12h with no count cap.
// `!==1/0` checks in the same class stay valid for any finite limit.
replaceExact(
	'constructor(e,t=1/0){this.lifetime=e,this.limit=t}',
	`constructor(e,t=${CACHE_LIMIT}){this.lifetime=e,this.limit=t}/*A55_CACHE_LIMIT*/`,
	1,
);

// Server metrics (the "server metric" widget) are public when the control
// panel publishes them: the serverStats stream channel and the server-info
// endpoint both answer anonymous requests. Restrict both to logged-in users:
// the channel flips to requireCredential, and the endpoint keeps the
// credential-less shape but serves the placeholder payload unless the request
// carries a user (the handler receives (params, user, ...) from exec).
// Param names `_p`/`_u` must not collide with the handler's own `e`/`t`/`n`.
replaceExact(
	'chName=`serverStats`;static shouldShare=!0;static requireCredential=!1;',
	'chName=`serverStats`;static shouldShare=!0;static requireCredential=!0;/*A55_LOGIN_ONLY*/',
	1,
);
replaceExact(
	'super(dN,fN,async()=>{if(!this.serverSettings.enableServerMachineStats)return{machine:`?`',
	'super(dN,fN,async(_p,_u)=>{if(!(_u&&this.serverSettings.enableServerMachineStats))return{machine:`?`/*A55_LOGIN_ONLY*/',
	1,
);

// The widget fetches its static labels (host, cpu model, memory total) with
// misskeyApiGet, which never sends a token. With the endpoint gated above,
// logged-in users would see `?` placeholders for those labels (the live
// charts come from the stream and are fine). Give this one call a token:
// import the account store next to apiGet and pass `i` in the query, the
// same parameter the WebSocket uses. The chunk names below are the hashes of
// the 2026.10.0 build and are identical across the per-language bundles.
const FRONT_DIR = join(root, 'built', '_frontend_vite_');
const frontFiles = [];
(function walk(dir) {
	for (const ent of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, ent.name);
		if (ent.isDirectory()) walk(path);
		else if (ent.name.endsWith('.js')) frontFiles.push(path);
	}
})(FRONT_DIR);

const widgetImport = 'import{n as S}from"./2H3Dmt7WI-B6Yu8dpk.js";';
const widgetImportPatched = 'import{n as S}from"./2H3Dmt7WI-B6Yu8dpk.js";import{t as __a55i}from"./2H3Dmt7WI-Bk39GnUG.js";/*A55_LOGIN_ONLY*/';
const widgetCall = 'S(`server-info`,{})';
const widgetCallPatched = 'S(`server-info`,__a55i?{i:__a55i.token}:{})';

let widgetFiles = 0;
for (const file of frontFiles) {
	const src = readFileSync(file, 'utf8');
	if (!src.includes(widgetCall)) {
		if (src.includes('/*A55_LOGIN_ONLY*/')) widgetFiles++;
		continue;
	}
	if (!src.includes(widgetImport)) throw new Error(`widget import line missing in ${file}`);
	if (src.split(widgetCall).length !== 2) throw new Error(`widget call not unique in ${file}`);
	let next = src.split(widgetCall).join(widgetCallPatched);
	next = next.replace(widgetImport, widgetImportPatched);
	if (!next.includes('/*A55_LOGIN_ONLY*/') || next.includes(widgetImport + widgetImportPatched)) {
		throw new Error(`widget patch failed in ${file}`);
	}
	writeChecked(file, next);
	widgetFiles++;
	console.log(`patched widget: ${file.slice(FRONT_DIR.length)}`);
}
if (widgetFiles < 20 || widgetFiles > 60) {
	throw new Error(`expected 20..60 widget chunks, found ${widgetFiles}`);
}

// getBlurhash decodes the original file before the bundled encoder runs.
const blurPipeline = '.raw().ensureAlpha().resize(64,64,{fit:`inside`}).toBuffer({resolveWithObject:!0})';
let blurFiles = 0;
for (const file of files) {
	const src = readFileSync(file, 'utf8');
	if (src.includes('A55_BLURHASH')) {
		console.log(`already applied: BLURHASH in ${file}`);
		blurFiles++;
		continue;
	}
	const idx = src.indexOf(blurPipeline);
	if (idx < 0) continue;
	if (src.indexOf(blurPipeline, idx + blurPipeline.length) >= 0) {
		throw new Error(`blurhash pipeline is not unique in ${file}`);
	}
	const start = src.lastIndexOf('async getBlurhash(', idx);
	if (start < 0 || idx - start > 180) throw new Error(`getBlurhash head not found in ${file}`);
	const brace = src.indexOf('{', start);
	const tail = '5,5)}';
	const end = src.indexOf(tail, idx);
	if (brace < 0 || end < 0 || end - idx > 160) throw new Error(`getBlurhash tail not found in ${file}`);
	const close = end + tail.length;
	const next = `${src.slice(0, brace + 1)}return ${JSON.stringify(BLURHASH)}/*A55_BLURHASH*/}${src.slice(close)}`;
	writeChecked(file, next);
	blurFiles++;
	console.log(`patched blurhash: ${file}`);
}
if (blurFiles !== 1) throw new Error(`expected 1 blurhash chunk, found ${blurFiles}`);

// Every password call goes through the object exported from this chunk.
const bcryptMarker = '/*A55_BCRYPT*/';
const bcryptObject = 'var lu={setRandomFallback,genSaltSync,genSalt,hashSync,hash,compareSync,compare,getRounds,getSalt,truncates,encodeBase64,decodeBase64};';
const bcryptPatch = `${bcryptObject}${bcryptMarker}const __a55b=__a55CreateRequire(import.meta.url)("@node-rs/bcrypt");function __a55rounds(s){if(typeof s=="number"&&isFinite(s))return s;if(typeof s=="string"&&s.startsWith("$2")){const n=parseInt(s.split("$")[2],10);return n||10}return 10}function __a55cb(p,cb){if(typeof cb!="function")return p;p.then(r=>cb(null,r),e=>cb(e))}lu.genSaltSync=function(r){return __a55b.genSaltSync(r==null?10:r)};lu.genSalt=function(r,s,cb){if(typeof r=="function"){cb=r;r=10}return __a55cb(Promise.resolve(lu.genSaltSync(r)),cb)};lu.hashSync=function(p,s){const c=__a55rounds(s);return typeof s=="string"&&s.startsWith("$2")?__a55b.hashSync(String(p),c,s):__a55b.hashSync(String(p),c)};lu.hash=function(p,s,cb){if(typeof s=="function"){cb=s;s=10}return __a55cb(Promise.resolve(lu.hashSync(p,s)),cb)};lu.compareSync=function(p,h){return __a55b.compareSync(String(p),h)};lu.compare=function(p,h,cb){return __a55cb(Promise.resolve(__a55b.compareSync(String(p),h)),cb)};`;

let bcryptFiles = 0;
let bcryptWrote = 0;
for (const file of files) {
	const src = readFileSync(file, 'utf8');
	if (src.includes(bcryptMarker)) {
		console.log(`already applied: BCRYPT in ${file}`);
		bcryptFiles++;
		continue;
	}
	if (!src.includes(bcryptObject)) continue;
	if (!src.startsWith('import')) throw new Error(`bcrypt chunk is not an ESM module: ${file}`);
	const next = `import{createRequire as __a55CreateRequire}from"node:module";${src.replace(bcryptObject, bcryptPatch)}`;
	if (next === src || !next.includes(bcryptMarker)) throw new Error(`failed to patch bcrypt in ${file}`);
	writeChecked(file, next);
	bcryptFiles++;
	bcryptWrote++;
}
if (bcryptFiles !== 1) throw new Error(`expected 1 bcrypt chunk, found ${bcryptFiles}`);
if (bcryptWrote === 1) console.log('patched 1: BCRYPT -> @node-rs/bcrypt');

function findSharpPackages(dir, acc, depth) {
	if (depth > 8) return;
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const ent of entries) {
		if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
		const path = join(dir, ent.name);
		if (ent.name === 'sharp') {
			try {
				const pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
				if (pkg.name === 'sharp') acc.add(realpathSync(path));
			} catch {
				// A directory named sharp that is not the package.
			}
		}
		// pnpm: node_modules/.pnpm/sharp@x/node_modules/sharp
		if (ent.name === '.pnpm' || ent.name === 'node_modules' || ent.name.startsWith('sharp@')) {
			findSharpPackages(path, acc, depth + 1);
		}
	}
}

const sharpPackages = new Set();
for (const start of [join(root, 'node_modules'), join(root, 'packages/backend/node_modules')]) {
	findSharpPackages(start, sharpPackages, 0);
}
if (sharpPackages.size === 0) throw new Error('sharp package not found under ' + root);

const sharpTune = '\n/* A55_SHARP_TUNE */\nSharp.cache(false);\nSharp.concurrency(1);\n';
let sharpEntries = 0;
for (const pkgDir of sharpPackages) {
	for (const rel of ['dist/index.mjs', 'dist/index.cjs']) {
		const file = join(pkgDir, rel);
		let src;
		try {
			src = readFileSync(file, 'utf8');
		} catch {
			continue;
		}
		if (src.includes('A55_SHARP_TUNE')) {
			sharpEntries++;
			continue;
		}
		if (!src.includes('Sharp')) throw new Error(`unexpected sharp entry: ${file}`);
		writeChecked(file, src.replace(/\s*$/, '') + sharpTune);
		sharpEntries++;
		console.log(`patched sharp: ${file}`);
	}
}
if (sharpEntries < 1) throw new Error('no sharp entry file was patched');

// Remote media link-through. The stock build downloads every remote file in
// uploadFromUrl even when the record will be isLink (no thumbnail, no
// webpublic, size 0), and runs getFileInfo on the temp file for md5/type.
// Two coordinated edits remove the network fetch and the file read for the
// link path only; local uploads and already-cached remote files keep the
// full pipeline. Without the second edit the first would feed addFile an
// empty temp file whose md5 (d41d8cd9...) would collide across every link
// file and break hash dedupe, so they are versioned as a pair.
const linkMarker = '/*A55_LINK*/';
replaceExact(
	'try{let{filename:y}=await this.downloadService.downloadUrl(e,v);f!==null&&y===f&&(f=null);',
	'try{let y' + linkMarker + ';if(l){try{const __d=await this.driveFilesRepository.findOneBy({uri:e})??await this.driveFilesRepository.findOneBy({url:e});if(__d)return this.downloaderLogger.succ(`a55 dup: ${__d.id}`),__d}catch(__de){}y=(e.split(`/`).pop()||``).split(/[?#]/)[0].slice(0,180);try{y=decodeURIComponent(y)}catch(__de2){}y=y||`file`}else{let __r=await this.downloadService.downloadUrl(e,v);y=__r.filename}f!==null&&y===f&&(f=null);',
	1,
);
replaceExact(
	'let w=await this.fileInfoService.getFileInfo(t,{fileName:r,',
	'let w' + linkMarker + ';if(l){const __u=String(f||h||``);const __m=__u.match(/[.](png|jpe?g|webp|gif|avif|svg|bmp|mp4|webm|mov|m4a|mp3|wav|ogg|opus|flac)([?#]|$)/i);let __ext=null,__mime=`application/octet-stream`;if(__m){__ext=__m[1].toLowerCase();__mime={jpg:`image/jpeg`,jpeg:`image/jpeg`,svg:`image/svg+xml`,mp4:`video/mp4`,webm:`video/webm`,mov:`video/quicktime`,m4a:`audio/mp4`,mp3:`audio/mpeg`,wav:`audio/wav`,ogg:`audio/ogg`,opus:`audio/opus`,flac:`audio/flac`}[__ext]||`image/`+__ext}let __a=5381,__b=52711;for(const __c of __u){const __k=__c.codePointAt(0);__a=(Math.imul(__a,33)^__k)>>>0;__b=(Math.imul(__b,31)+__k)>>>0}w={size:0,md5:`a55${__a.toString(16).padStart(8,`0`)}${__b.toString(16).padStart(8,`0`)}`+`0`.repeat(13),type:{ext:__ext,mime:__mime},width:null,height:null,orientation:null,blurhash:' + JSON.stringify(BLURHASH) + ',sensitive:!1,porn:!1,warnings:[]}}else w=await this.fileInfoService.getFileInfo(t,{fileName:r,',
	1,
);

let checked = 0;
for (const file of touched) {
	const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
	if (res.status !== 0) {
		throw new Error(`patched file failed syntax check: ${file}\n${(res.stderr || '').slice(0, 1500)}`);
	}
	checked++;
}
console.log(`syntax checked ${checked} patched file(s)`);

console.log('A55 patch complete');
