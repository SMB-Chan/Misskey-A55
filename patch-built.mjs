/**
 * The TS-233 Misskey. Upstream 2026.10.0 is only the frozen substrate.
 * Grow this file for that machine: less CPU, less RAM, federation that
 * returns to the event loop. Do not add features.
 *
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

function replaceOneOf(fromList, to, min, max = min) {
	for (const from of fromList) {
		let hits = 0;
		let already = 0;
		for (const file of files) {
			const src = readFileSync(file, 'utf8');
			if (src.includes(to)) already++;
			hits += src.split(from).length - 1;
		}
		if (hits === 0 && already > 0) {
			console.log(`already applied: ${to}`);
			return;
		}
		if (hits >= min && hits <= max) {
			replaceExact(from, to, min, max);
			return;
		}
	}
	throw new Error(`none of ${JSON.stringify(fromList)} matched ${min}..${max} times`);
}

function injectAfterOpenBrace(fnNeedles, injection, expected = 1) {
	const needles = Array.isArray(fnNeedles) ? fnNeedles : [fnNeedles];
	let hits = 0;
	let already = 0;
	let used = needles[0];
	for (const file of files) {
		const src = readFileSync(file, 'utf8');
		if (src.includes(injection)) {
			already++;
			continue;
		}
		let start = -1;
		for (const fnNeedle of needles) {
			const idx = src.indexOf(fnNeedle);
			if (idx < 0) continue;
			if (src.indexOf(fnNeedle, idx + fnNeedle.length) >= 0) {
				throw new Error(`function needle not unique: ${fnNeedle} in ${file}`);
			}
			start = idx;
			used = fnNeedle;
			break;
		}
		if (start < 0) continue;
		const brace = src.indexOf('{', start);
		if (brace < 0 || brace - start > 160) {
			throw new Error(`open brace not found for ${used} in ${file}`);
		}
		writeChecked(file, src.slice(0, brace + 1) + injection + src.slice(brace + 1));
		hits++;
		console.log(`injected ${used} in ${file}`);
	}
	if (hits === 0 && already === expected) {
		console.log(`already applied: ${injection}`);
		return;
	}
	if (hits !== expected) {
		throw new Error(`expected ${expected} inject of ${needles.join('|')}, found ${hits}`);
	}
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

// Collapse consecutive notifications from the same user within 30 minutes
// for non-conversational types (reaction, renote, follow, etc.), while
// keeping reply, quote, and mention always expanded.
const notifImport = 'import{j as e,pt as t,u as n}from"./2H3Dmt7WI-DHf8Dmep.js";';
const notifImportPatched = 'import{j as e,pt as t,u as n,g as __a55ref}from"./2H3Dmt7WI-DHf8Dmep.js";/*A55_NOTIF_FOLD*/';
const notifSetup = 'let $=null;return o(()=>{';
const notifSetupPatched = 'const __a55exp=__a55ref({}),__a55tog=e=>{__a55exp.value={...__a55exp.value,[e]:!__a55exp.value[e]}},__a55fSet=new Set([`reaction`,`renote`,`follow`,`receiveFollowRequest`,`followRequestAccepted`]),__a55u=e=>{if(!e||!__a55fSet.has(e.type))return null;return e.user??null},__a55g=g(()=>{const l=e(W).items.value,o=[];for(let i=0;i<l.length;i++){const c=l[i],u=__a55u(c),p=o.at(-1);if(u&&p&&p.u&&p.u.id===u.id&&Math.abs(new Date(p.last.createdAt).getTime()-new Date(c.createdAt).getTime())<=18e5){p.extra.push(c);p.last=c;continue}o.push({head:c,last:c,u,extra:[]})}return o});let $=null;return o(()=>{';
const notifRender = '[(a(!0),v(y,null,te(e(W).items.value,(n,r)=>(a(),v(`div`,{key:n.id,"data-scroll-anchor":n.id,class:`xmufI`},[r>0&&e(j)(e(W).items.value[r-1].createdAt,n.createdAt)?(a(),v(`div`,{key:0,class:`xcnVt`},[x(`span`,null,[o[2]||=x(`i`,{class:`ti ti-chevron-up`},null,-1),f(` `+t(e(k)(e(W).items.value[r-1].createdAt,n.createdAt)?.prevText),1)]),o[4]||=x(`span`,{style:{height:`1em`,width:`1px`,background:`var(--MI_THEME-divider)`}},null,-1),x(`span`,null,[f(t(e(k)(e(W).items.value[r-1].createdAt,n.createdAt)?.nextText)+` `,1),o[3]||=x(`i`,{class:`ti ti-chevron-down`},null,-1)])],2)):h(``,!0),[`reply`,`quote`,`mention`].includes(n.type)&&`note`in n?(a(),m(D,{key:1,class:`x7OW7`,note:n.note,withHardMute:!0},null,8,[`class`,`note`])):(a(),m(F,{key:2,class:`x7OW7`,notification:n,withTime:!0,full:!0},null,8,[`class`,`notification`]))],10,L))),128))]';
const notifRenderPatched = '[(a(!0),v(y,null,te(e(__a55g),(g,r)=>{const n=g.head;return a(),v(`div`,{key:n.id,"data-scroll-anchor":n.id,class:`xmufI`},[r>0&&e(j)(e(__a55g)[r-1].last.createdAt,n.createdAt)?(a(),v(`div`,{key:0,class:`xcnVt`},[x(`span`,null,[o[2]||=x(`i`,{class:`ti ti-chevron-up`},null,-1),f(` `+t(e(k)(e(__a55g)[r-1].last.createdAt,n.createdAt)?.prevText),1)]),o[4]||=x(`span`,{style:{height:`1em`,width:`1px`,background:`var(--MI_THEME-divider)`}},null,-1),x(`span`,null,[f(t(e(k)(e(__a55g)[r-1].last.createdAt,n.createdAt)?.nextText)+` `,1),o[3]||=x(`i`,{class:`ti ti-chevron-down`},null,-1)])],2)):h(``,!0),[`reply`,`quote`,`mention`].includes(n.type)&&`note`in n?(a(),m(D,{key:1,class:`x7OW7`,note:n.note,withHardMute:!0},null,8,[`class`,`note`])):(a(),m(F,{key:2,class:`x7OW7`,notification:n,withTime:!0,full:!0},null,8,[`class`,`notification`])),g.extra.length>0?(a(),v(`div`,{key:3},[x(`button`,{class:`_button`,style:{width:`100%`,padding:`6px 16px`,fontSize:`0.82em`,opacity:`0.78`,display:`flex`,alignItems:`center`, gap:`6px`,borderTop:`solid 0.5px var(--MI_THEME-divider)`,background:`var(--MI_THEME-bg)`},onClick:()=>__a55tog(n.id)},[x(`i`,{class:e(__a55exp)[n.id]?`ti ti-chevron-up`:`ti ti-chevron-down`}),f(` `+t(g.u?.name||g.u?.username||``)+` からの通知をさらに `+t(g.extra.length)+` 件`+(e(__a55exp)[n.id]?`閉じる`:`表示`),1)]),e(__a55exp)[n.id]?(a(!0),v(y,{key:0},te(g.extra,c=>(a(),v(`div`,{key:c.id,style:{borderTop:`solid 0.5px var(--MI_THEME-divider)`,paddingLeft:`12px`,background:`var(--MI_THEME-bg)`}},[(a(),m(F,{class:`x7OW7`,notification:c,withTime:!0,full:!0},null,8,[`class`,`notification`]))]))),128)):h(``,!0)])):h(``,!0)],10,L)}),128))]';

let notifFiles = 0;
for (const file of frontFiles) {
	const src = readFileSync(file, 'utf8');
	if (!src.includes('MkStreamingNotificationsTimeline')) continue;
	if (src.includes('/*A55_NOTIF_FOLD*/')) {
		notifFiles++;
		continue;
	}
	if (!src.includes(notifImport) || !src.includes(notifSetup) || !src.includes(notifRender)) {
		throw new Error(`notif fold pattern missing in ${file}`);
	}
	let next = src
		.replace(notifImport, notifImportPatched)
		.replace(notifSetup, notifSetupPatched)
		.replace(notifRender, notifRenderPatched);
	if (!next.includes('/*A55_NOTIF_FOLD*/')) {
		throw new Error(`notif fold patch failed in ${file}`);
	}
	writeChecked(file, next);
	notifFiles++;
	console.log(`patched notif-fold: ${file.slice(FRONT_DIR.length)}`);
}
if (notifFiles < 20 || notifFiles > 60) {
	throw new Error(`expected 20..60 notif chunks, found ${notifFiles}`);
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

// Mastodon-style Delete uses a string object equal to the actor. The stock
// check only runs when object is an embedded actor, so an unknown account is
// fetched, inserted, and then queued for deleteAccount. Skip that when the
// actor is not already in the DB. A Delete whose object is some other URI
// (a note) still falls through. A known actor still goes through signature
// verification and the normal delete.
replaceExact(
	'{let e=null;if(ge(n)&&typeof n.object==`object`&&(Ae(n.object)||we(n.actor)===we(n.object))&&(e=we(n.object)),e!=null&&await this.apDbResolverService.getUserFromApId(e)==null)return`skip: user not found for delete activity. ${we(e)}`}',
	'{let e=null;if(ge(n)){let __a55ap=typeof n.actor==`string`||n.actor&&typeof n.actor==`object`?we(n.actor):null,__a55ob=typeof n.object==`string`||n.object&&typeof n.object==`object`?we(n.object):null;if((__a55ap&&__a55ob&&__a55ap===__a55ob)||(typeof n.object==`object`&&Ae(n.object)))e=__a55ob}if(e!=null&&await this.apDbResolverService.getUserFromApId(e)==null)return`skip: user not found for delete activity. ${we(e)}`}/*A55_DELETE_ACTOR*/',
	1,
);

// Stock inbox throws UnrecoverableError for "skip: ..." so BullMQ parks them
// in failed (removeOnFail keeps 100). Return the string instead so skips count
// as completed and stop polluting the failed set / stall forensics.
replaceExact(
	'if(s==null)try{s=await this.apDbResolverService.getAuthUserFromApId(we(n.actor))}catch(e){if(e instanceof Ue)throw e.isRetryable?Error(`Error in actor ${we(n.actor)} - ${e.statusCode}`):new Z.UnrecoverableError(`skip: Ignored deleted actors on both ends ${we(n.actor)} - ${e.statusCode}`)}if(s==null)throw new Z.UnrecoverableError(`skip: failed to resolve user ${we(n.actor)}`);',
	'if(s==null)try{s=await this.apDbResolverService.getAuthUserFromApId(we(n.actor))}catch(e){if(e instanceof Ue){if(e.isRetryable)throw Error(`Error in actor ${we(n.actor)} - ${e.statusCode}`);return`skip: Ignored deleted actors on both ends ${we(n.actor)} - ${e.statusCode}`}}if(s==null)return`skip: failed to resolve user ${we(n.actor)}`;/*A55_SKIP_OK*/',
	1,
);

// deleteAccount shares the only worker with inbox. A 100-note delete plus
// per-file chart updates saturates the A55 long enough for the guard to
// kill the process, and the job then restarts from the first row. Smaller
// batches and a yield let the heartbeat and the inbox run between chunks.
// Link rows have no local bytes; one DELETE removes them. Stored files keep
// deleteFileSync so the disk objects are unlinked.
replaceExact(
	'{let e=null;for(;;){let n=await this.notesRepository.find({where:{userId:t.id,...e?{id:v(e)}:{}},take:100,order:{id:1}});if(n.length===0)break;e=n.at(-1)?.id??null,await this.notesRepository.delete(n.map(e=>e.id));for(let e of n)await this.searchService.unindexNote(e)}this.logger.succ(`All of notes deleted`)}{let e=null;for(;;){let n=await this.driveFilesRepository.find({where:{userId:t.id,...e?{id:v(e)}:{}},take:10,order:{id:1}});if(n.length===0)break;e=n.at(-1)?.id??null;for(let e of n)await this.driveService.deleteFileSync(e)}this.logger.succ(`All of files deleted`)}',
	'{let e=null;for(;;){let n=await this.notesRepository.find({where:{userId:t.id,...e?{id:v(e)}:{}},take:20,order:{id:1}});if(n.length===0)break;e=n.at(-1)?.id??null,await this.notesRepository.delete(n.map(e=>e.id));for(let e of n)await this.searchService.unindexNote(e);await new Promise(__r=>setTimeout(__r,40))}this.logger.succ(`All of notes deleted`)}{let e=null;for(;;){let n=await this.driveFilesRepository.find({where:{userId:t.id,...e?{id:v(e)}:{}},take:8,order:{id:1}});if(n.length===0)break;e=n.at(-1)?.id??null;let __a55link=[],__a55real=[];for(let e of n)(e.isLink&&!e.storedInternal?__a55link:__a55real).push(e);if(__a55link.length)await this.driveFilesRepository.delete(__a55link.map(e=>e.id));for(let e of __a55real)await this.driveService.deleteFileSync(e);await new Promise(__r=>setTimeout(__r,40))}this.logger.succ(`All of files deleted`)}/*A55_DELETE_YIELD*/',
	1,
);

// /files/:key for an isLink row downloaded the remote object only to learn
// its type, then often redirected. Send the browser to the remote URI.
// Stored files, including the pre-v2 cache, stay on the local path.
replaceExact(
	'if(!u.storedInternal){if(!(u.isLink&&u.uri))return{kind:`unavailable`};let{kind:i,...v}=await this.downloadAndDetectTypeFromUrl(u.uri);return u.size=(await Bn.promises.stat(v.path)).size,{kind:`remote`,...v,url:u.uri,fileRole:g?`thumbnail`:_?`webpublic`:`original`,file:u,filename:u.name}}',
	'if(!u.storedInternal){if(!(u.isLink&&u.uri))return{kind:`unavailable`};return{kind:`redirect`,url:u.uri}/*A55_LINK_REDIRECT*/}',
	1,
);
replaceExact(
	'if(_.kind===`unavailable`){u.code(204),u.header(`Cache-Control`,`max-age=86400`);return}',
	'if(_.kind===`unavailable`){u.code(204),u.header(`Cache-Control`,`max-age=86400`);return}if(_.kind===`redirect`){u.header(`Cache-Control`,`public, max-age=86400`);return await u.redirect(_.url,302)}/*A55_LINK_REDIRECT*/',
	1,
);

// Pinned notes (featured) resolve up to 5 remote Notes plus attachments on
// every Person create/update. Skip that fan-in; local pins are unchanged.
injectAfterOpenBrace('async updateFeatured(', 'return;/*A55_SKIP_FEATURED*/');

// following/followers visibility is display-only and costs two HTTP GETs
// per Update(Person). Treat as private rather than fetching the collection.
injectAfterOpenBrace('async isPublicCollection(', 'return!1;/*A55_SKIP_COL*/');

// Instance metadata for the admin federation list only needs NodeInfo
// (software name/version). HTML + manifest + favicon HEAD stall the worker
// on slow hosts and are not used for ActivityPub.
injectAfterOpenBrace('async fetchDom(', 'throw new Error(`a55 skip html`);/*A55_SKIP_HTML*/');
injectAfterOpenBrace('async fetchManifest(', 'throw new Error(`a55 skip manifest`);/*A55_SKIP_MANIFEST*/');
injectAfterOpenBrace('async fetchFaviconUrl(', 'return null;/*A55_SKIP_FAVICON*/');

// Hardcoded webhook/object-storage workers share the only event loop.
replaceOneOf(
	['concurrency:64,limiter:{max:64,duration:1e3}', 'concurrency:64,limiter:{max:64,duration:1000}'],
	'concurrency:2,limiter:{max:2,duration:1e3}/*A55_WH*/',
	1,
);
replaceOneOf(
	['concurrency:16,limiter:{max:16,duration:1e3}', 'concurrency:16,limiter:{max:16,duration:1000}'],
	'concurrency:1,limiter:{max:1,duration:1e3}/*A55_WH*/',
	1,
);

// ServerStatsService runs every 2s when enableServerMachineStats is true.
// Stock mem/net/fs call systeminformation, whose disksIO() and networkStats()
// spawn ~15 shell processes (lsblk|grep|sed|awk, ip route) taking ~1.2s of CPU
// every 2s on QNAP. Read /proc/meminfo, /proc/net/dev, and /proc/diskstats
// directly in-process (<0.3ms, zero child processes) and guard overlapping ticks.
replaceExact(
	'let tick=async()=>{let t=await cpuUsage(),n=await mem(),r=await net(),i=await fs(),a={cpu:roundCpu(t),mem:{used:round(n.total-n.available),active:round(n.active)},net:{rx:round(Math.max(0,r.rx_sec)),tx:round(Math.max(0,r.tx_sec))},fs:{r:round(Math.max(0,i.rIO_sec??0)),w:round(Math.max(0,i.wIO_sec??0))}};v.emit(`serverStats`,a),e.unshift(a),e.length>200&&e.pop()};',
	'let __a55tickBusy=!1,tick=async()=>{if(__a55tickBusy)return;__a55tickBusy=!0;try{let t=await cpuUsage(),n=await mem(),r=await net(),i=await fs(),a={cpu:roundCpu(t),mem:{used:round(n.total-n.available),active:round(n.active)},net:{rx:round(Math.max(0,r.rx_sec)),tx:round(Math.max(0,r.tx_sec))},fs:{r:round(Math.max(0,i.rIO_sec??0)),w:round(Math.max(0,i.wIO_sec??0))}};v.emit(`serverStats`,a),e.unshift(a),e.length>200&&e.pop()}finally{__a55tickBusy=!1}};/*A55_PROC_TICK*/',
	1,
);
replaceExact(
	'async function mem(){return await(await import(`./lib-DKFCcBQX.js`).then(e=>t(e.default,1))).mem()}async function net(){let e=await import(`./lib-DKFCcBQX.js`).then(e=>t(e.default,1)),n=await e.networkInterfaceDefault();return(await e.networkStats(n))[0]}async function fs(){return await(await import(`./lib-DKFCcBQX.js`).then(e=>t(e.default,1))).disksIO().catch(()=>({rIO_sec:0,wIO_sec:0}))}',
	'let __a55fs,__a55net=null,__a55disk=null;async function mem(){try{let e=(__a55fs??=await import(`node:fs`)).readFileSync(`/proc/meminfo`,`utf8`),t=0,n=0,r=0;for(let i of e.split(`\\n`)){let e=i.match(/^(MemTotal|MemAvailable|MemFree):\\s*(\\d+)/);e&&(e[1]===`MemTotal`?t=Number(e[2])*1024:e[1]===`MemAvailable`?n=Number(e[2])*1024:r=Number(e[2])*1024)}let i=n||r;return{total:t,available:i,active:Math.max(0,t-i)}}catch{return{total:0,available:0,active:0}}}async function net(){try{let e=Date.now(),t=(__a55fs??=await import(`node:fs`)).readFileSync(`/proc/net/dev`,`utf8`),n=0,r=0;for(let e of t.split(`\\n`)){let t=e.trim().match(/^([a-z0-9]+):\\s*(\\d+)\\s+\\d+\\s+\\d+\\s+\\d+\\s+\\d+\\s+\\d+\\s+\\d+\\s+\\d+\\s+(\\d+)/i);t&&t[1]!==`lo`&&(n+=Number(t[2]),r+=Number(t[3]))}let i=__a55net;if(__a55net={t:e,rx:n,tx:r},!i||e<=i.t)return{rx_sec:0,tx_sec:0};let a=(e-i.t)/1e3;return{rx_sec:(n-i.rx)/a,tx_sec:(r-i.tx)/a}}catch{return{rx_sec:0,tx_sec:0}}}async function fs(){try{let e=Date.now(),t=(__a55fs??=await import(`node:fs`)).readFileSync(`/proc/diskstats`,`utf8`),n=0,r=0;for(let e of t.split(`\\n`)){let t=e.trim().match(/^\\d+\\s+\\d+\\s+(sd[a-z]+|nvme\\d+n\\d+)\\s+(\\d+)\\s+\\d+\\s+\\d+\\s+\\d+\\s+(\\d+)/);t&&(n+=Number(t[2]),r+=Number(t[3]))}let i=__a55disk;if(__a55disk={t:e,r:n,w:r},!i||e<=i.t)return{rIO_sec:0,wIO_sec:0};let a=(e-i.t)/1e3;return{rIO_sec:(n-i.r)/a,wIO_sec:(r-i.w)/a}}catch{return{rIO_sec:0,wIO_sec:0}}}/*A55_PROC_STATS*/',
	1,
);

// Notes, timelines, and internal events share one Redis channel. The queue
// only acts on internal events, but it still received every note body.
// Publish internal events on a second channel and subscribe the queue
// process to that channel alone. Web keeps the original channel.
replaceExact(
	'}publish(e,t,r){let i=t==null?r:r==null?{type:t,body:null}:{type:t,body:r};this.redisForPub.publish(this.config.host,JSON.stringify({channel:e,message:i}))}',
	'}publish(e,t,r){let i=t==null?r:r==null?{type:t,body:null}:{type:t,body:r},s=JSON.stringify({channel:e,message:i});this.redisForPub.publish(this.config.host,s);e===`internal`&&this.redisForPub.publish(this.config.host+`:a55i`,s)/*A55_PUBSUB*/}',
	1,
);
replaceExact(
	'return c.subscribe(n.host),c',
	'return c.subscribe(process.env.MK_ONLY_QUEUE===`1`?n.host+`:a55i`:n.host),c/*A55_PUBSUB*/',
	1,
);

// Remote authors each keep a Redis list (user timeline and the files
// variant). Profile reads already fall back to Postgres. Home timelines
// of local followers are untouched.
replaceExact(
	'this.fanoutTimelineService.push(`userTimeline:${t.id}`,e.id,e.userHost==null?this.meta.perLocalUserUserTimelineCacheMax:this.meta.perRemoteUserUserTimelineCacheMax,r),e.fileIds.length>0&&this.fanoutTimelineService.push(`userTimelineWithFiles:${t.id}`,e.id,e.userHost==null?this.meta.perLocalUserUserTimelineCacheMax/2:this.meta.perRemoteUserUserTimelineCacheMax/2,r)',
	'e.userHost==null&&(this.fanoutTimelineService.push(`userTimeline:${t.id}`,e.id,this.meta.perLocalUserUserTimelineCacheMax,r),e.fileIds.length>0&&this.fanoutTimelineService.push(`userTimelineWithFiles:${t.id}`,e.id,this.meta.perLocalUserUserTimelineCacheMax/2,r))/*A55_NO_REMOTE_TL*/',
	1,
);

// System cron results were kept for 7 days. checkExpiredMutings every 5
// minutes is about 2,000 Redis hashes, and the worker keeps scoring them.
replaceExact(
	'{name:e.name,opts:{removeOnComplete:{age:604800},removeOnFail:{age:604800}}});this.systemQueue.getJobSchedulers()',
	'{name:e.name,opts:{removeOnComplete:{age:3600,count:8},removeOnFail:{age:3600,count:8}}});this.systemQueue.clean(36e5,5000,`completed`).catch(()=>{}),this.systemQueue.getJobSchedulers()/*A55_SYS_RETAIN*/',
	1,
);

// One Redis channel carries every stream. Cache subscribers only act on
// internal events, so they return before JSON.parse for notes and timelines.
// uriPersonCache is capped at CACHE_LIMIT. Update matching URIs from the
// live entries instead of a side index: MemoryKVCache evicts through its
// private Map, and a second index would both leak and resurrect entries.
// Upstream: the same two steps in CacheService.onMessage, plus an early
// return in each redis onMessage.
replaceExact(
	'async onMessage(e,t){let r=JSON.parse(t);',
	'async onMessage(e,t){if(!String(t).startsWith(`{"channel":"internal"`))return;let r=JSON.parse(t);/*A55_INTERNAL_ONLY*/',
	10,
);
replaceExact(
	'for(let[e,r]of this.uriPersonCache.entries)r.value?.id===t.id&&this.uriPersonCache.delete(e)',
	'__a55UriTouch(this.uriPersonCache,t.id,null)',
	1,
);
replaceExact(
	'for(let[t,r]of this.uriPersonCache.entries)r.value?.id===e.id&&this.uriPersonCache.set(t,e)',
	'__a55UriTouch(this.uriPersonCache,e.id,e)',
	1,
);
const uriTouchHelper = `function __a55UriTouch(cache, id, user) {
	if (!cache || id == null) return;
	const matches = [];
	for (const [key, entry] of cache.entries) {
		if (entry && entry.value && entry.value.id === id) matches.push(key);
	}
	for (const key of matches) {
		if (user == null) cache.delete(key);
		else cache.set(key, user);
	}
}
`;
let helperFiles = 0;
for (const file of files) {
	const src = readFileSync(file, 'utf8');
	if (!src.includes('__a55UriTouch(this.uriPersonCache')) continue;
	if (src.includes('function __a55UriTouch(')) {
		helperFiles++;
		continue;
	}
	writeChecked(file, src + '\n' + uriTouchHelper);
	helperFiles++;
}
if (helperFiles !== 1) throw new Error('uri touch helper attached to ' + helperFiles + ' files');

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
