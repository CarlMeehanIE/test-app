'use strict';
/*
 * finder.js - carlm-overlays: step 1 of finding the car's "track my car" (vehicle location / privacy) setting.
 * READ-ONLY: searches the head unit's own configuration files (vsomeip / CommonAPI deployments, service lists) for
 * privacy, location and tracking words, so the services behind that menu item and their ids can be told; nothing is
 * subscribed, called or written but the result file. Step 2 (listening to those services while the option is flipped)
 * comes once these show the candidates.
 *   scan(cb)  ->  cb(err, { at, lines: ['file:line: text'], total, file })   (grep -rIinE in DIRS, async, bounded)
 */
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const DIRS = ['/etc', '/opt', '/usr/share'];
const INCLUDE = ['*.json', '*.xml', '*.fdepl', '*.fidl', '*.conf', '*.ini', '*.cfg', '*.properties'];
// the drive-dynamics words: the Driving Experience switch (Fahrerlebnisschalter), its modes (Comfort / Sport / Sport+
// / Sport Individual / Eco Pro) and the four systems it sets (steering, drivetrain / powertrain, transmission,
// damping / adaptive). BMW's config is mostly German, so both languages, and compounds over bare words to keep the
// noise down.
const WORDS = 'fahrerlebnis|fahrdynamik|fahrmodus|fahrwerk|drivingdynamic|driving_dynamic|drivedynamic|drive_dynamic|' +
    'drivingexperience|driving_experience|drivemode|drive_mode|drivetrainswitch|drivetrain_switch|' +
    'ecopro|eco_pro|sportindividual|sport_individual|sport_plus|adaptivemode|adaptive_mode|' +
    'servotronic|lenkungskennlinie|daempfer|dampfer|damper|verstelldaempfer|edck|vdc|' +
    'antriebsstrang|getriebekennlinie|efahrerlebnis|dynamicdrive';
const MAX_LINES = 400, KEEP = 200, TIMEOUT_MS = 60000;

/* how telling a line is: a service / interface definition with an id, BMW's names, the drive-dynamics words over the
 * generic ones ("damper"); comments last */
function score(l) {
    const text = l.replace(/^[^:]*:\d+:/, '');
    let n = 0;
    if (/0x[0-9a-f]{3,4}\b/i.test(text)) n += 3;
    if (/service|interface|instance|event|method|attribute|broadcast/i.test(text)) n += 3;
    if (/de\.bmw|bmw/i.test(l)) n += 2;
    if (/fahrerlebnis|fahrdynamik|fahrmodus|fahrwerk|driv(ing|e)[_]?(dynamic|experience|mode)|drivetrain|servotronic|d[ae]mpfer|sport[_]?individual|eco[_]?pro/i.test(text)) n += 2;
    if (/^\s*(#|\/\/|;|<!--)/.test(text)) n -= 4;
    return n;
}
/* grep's output -> the lines worth showing: one per match, trimmed, without our own files and the apps' texts, the
 * most telling first (stable: file order within a score) */
function lines(out) {
    return String(out || '').split('\n').filter(Boolean)
        .filter((l) => !/\/(carlm-overlays|iteriodev[-_]|oap_\d+|fonts?)\//i.test(l))
        .map((l, i) => ({ l: l.replace(/\s+/g, ' ').slice(0, KEEP), s: score(l), i }))
        .sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.l);
}

function scan(cb, o) {
    const dirs = (o && o.dirs) || DIRS, file = o && o.file;
    const words = (o && o.words) || WORDS;
    const args = ['-rIinE', words, '-m', '20', '--no-messages'].concat(INCLUDE.map((g) => `--include=${g}`), dirs);
    execFile('grep', args, { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (e, out) => {
        // grep: 0 found, 1 nothing, 2 some dirs unreadable (results still good); a missing grep or a timeout: an error
        if (e && (e.code === 'ENOENT' || e.killed)) return cb(new Error(e.code === 'ENOENT' ? 'no grep on this unit' : 'scan took too long'));
        const all = lines(out);
        const res = { at: new Date().toISOString(), total: all.length, lines: all.slice(0, MAX_LINES), file: file || null };
        if (file) { try { fs.writeFileSync(file, `${res.at}\n${all.join('\n')}\n`); } catch (we) { res.file = null; } }
        cb(null, res);
    });
}

function test() {
    const assert = require('assert');
    const got = lines('/etc/vsomeip/hmi.json:12:   "service" : "0xb521", "name": "DrivingDynamics"\n' +
        '/var/opt/carlm-overlays/x.json:1: fahrmodus\n/opt/x/oap_5/rhmi.json:3: Fahrdynamik\n');
    assert.deepStrictEqual(got, ['/etc/vsomeip/hmi.json:12: "service" : "0xb521", "name": "DrivingDynamics"'], 'ours and the apps\' left out');
    assert.deepStrictEqual(lines('/etc/a.conf:1: # key fahrdynamik notes\n/etc/b.json:2: "service":"0xb521" fahrmodus\n'),
        ['/etc/b.json:2: "service":"0xb521" fahrmodus', '/etc/a.conf:1: # key fahrdynamik notes'], 'a service with an id first, comments last');
    // a real run on this machine's /etc: grep is there, it answers, the result is bounded
    let done = false;
    scan((e, r) => { assert.ifError(e); assert(Array.isArray(r.lines) && r.lines.length <= MAX_LINES); done = true; }, { dirs: [path.join(__dirname)] });
    setTimeout(() => { assert(done, 'scan answered'); console.log('finder self-check ok'); }, 1500);
}

/* ---- record: which files change while the user flips the menu item (read-only: find -newer, a marker file of ours) ----
 * start(): a marker now; QUIET_MS later a second one, and the files changed in between (what the unit writes by itself:
 * logs, counters) are kept as noise. stop(): the files changed since the second marker, less the noise, the most
 * telling first (drive-dynamics words, then settings-like places). */
const QUIET_MS = 10000;
const PRUNE = ['/proc', '/sys', '/dev'];
const changedSince = (mark, cb, root) => {
    const args = [root || '/', '('].concat(...PRUNE.map((d, i) => (i ? ['-o', '-path', d] : ['-path', d])), [')', '-prune', '-o', '-type', 'f', '-newer', mark, '-print']);
    execFile('find', args, { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (e, out) => {
        if (e && (e.code === 'ENOENT' || e.killed)) return cb(new Error(e.code === 'ENOENT' ? 'no find on this unit' : 'listing took too long'));
        cb(null, String(out || '').split('\n').filter(Boolean).filter((f) => !/\/carlm-overlays\//.test(f) && f !== mark));
    });
};
function rankFiles(files) {
    const sc = (f) => (new RegExp(WORDS, 'i').test(f) ? 4 : 0) + (/persist|setting|config|pers|user|profile|\.db|\.json|\.xml|\.dat/i.test(f) ? 2 : 0) -
        (/log|journal|dlt|trace|\.tmp|cache/i.test(f) ? 3 : 0);
    return files.map((f, i) => ({ f, s: sc(f), i })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.f);
}
function recorder(o) {
    const dir = (o && o.dir) || '/run/carlm-overlays', root = o && o.root, quiet = (o && o.quietMs) || QUIET_MS;
    const markA = path.join(dir, 'finder-mark-a'), markB = path.join(dir, 'finder-mark-b');
    let noise = null, ready = false;
    const touch = (f) => { fs.writeFileSync(f, `${Date.now()}\n`); };
    return {
        start(onReady) {                       // onReady(err): the quiet window is over, the user may flip the item
            noise = null; ready = false;
            try { touch(markA); } catch (e) { return onReady(e); }
            setTimeout(() => changedSince(markA, (e, files) => {
                if (e) return onReady(e);
                noise = new Set(files);
                try { touch(markB); } catch (we) { return onReady(we); }
                ready = true;
                onReady(null, noise.size);
            }, root), quiet);
        },
        stop(cb, file) {                        // cb(err, { at, total, lines, noise, file })
            if (!ready) return cb(new Error('not recording yet'));
            changedSince(markB, (e, files) => {
                if (e) return cb(e);
                const hit = rankFiles(files.filter((f) => !noise.has(f)));
                const res = { at: new Date().toISOString(), total: hit.length, lines: hit.slice(0, MAX_LINES), noise: noise.size, file: file || null, kind: 'record' };
                if (file) { try { fs.writeFileSync(file, `${res.at} (changed while recording, ${res.noise} noisy files left out)\n${hit.join('\n')}\n`); } catch (we) { res.file = null; } }
                ready = false;
                cb(null, res);
            }, root);
        },
    };
}

function testRecord(done) {
    const assert = require('assert'), os = require('os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'finder-')), d = path.join(tmp, 'car'), run = path.join(tmp, 'run');
    fs.mkdirSync(d); fs.mkdirSync(run); fs.mkdirSync(path.join(d, 'var'));
    fs.writeFileSync(path.join(d, 'var', 'noisy.log'), '1'); fs.writeFileSync(path.join(d, 'var', 'privacy_settings.json'), '{"loc":1}');
    const r = recorder({ dir: run, root: d, quietMs: 2200 });
    setTimeout(() => fs.writeFileSync(path.join(d, 'var', 'noisy.log'), '2'), 1100);      // the unit writing by itself
    r.start((e) => {
        assert.ifError(e);
        setTimeout(() => {
            fs.writeFileSync(path.join(d, 'var', 'noisy.log'), '3');                         // again, while recording
            fs.writeFileSync(path.join(d, 'var', 'privacy_settings.json'), '{"loc":0}');     // the user's flip
            r.stop((e2, res) => {
                assert.ifError(e2);
                assert.deepStrictEqual(res.lines, [path.join(d, 'var', 'privacy_settings.json')], 'only what the flip changed');
                done();
            });
        }, 1100);
    });
    // the markers are set 1 s apart at least: find -newer compares whole seconds on some filesystems
}

/* ---- watch: log the VALUE of each cached SOME/IP signal as it changes while the user cycles drive settings ----
 * Scoped to /var/opt/public/con (the signal cache, where Record #1 found the drive-mode file). The earlier try
 * watched too wide and judged "noise" by file timestamp, so the drive-mode cache - which the unit rewrites on a
 * heartbeat - got thrown out with all the other con files. This judges noise by VALUE: during the quiet window a
 * file is noise only if its CONTENT changes on its own; a heartbeat that rewrites the same bytes is kept. Then it
 * logs a file only when its value actually changes (so heartbeats stay silent), reading only files whose mtime
 * moved. `always` basenames are never treated as noise (the known drive-mode file). Read-only. */
const WATCH_CON = '/var/opt/public/con';
const WATCH_QUIET_MS = 8000, WATCH_EVERY_MS = 1500, WATCH_CAP = 96, WATCH_MAX_LOG = 180;
function watcher(o) {
    o = o || {};
    const wdir = o.watchDir || WATCH_CON;
    const quiet = o.quietMs || WATCH_QUIET_MS, every = o.intervalMs || WATCH_EVERY_MS;
    const cap = o.maxBytes || WATCH_CAP, maxLog = o.maxLog || WATCH_MAX_LOG;
    const always = new Set(o.always || []);
    let noise = new Set(), last = new Map(), log = [], onCh = null, timer = null, busy = false;

    const listF = () => { try { return fs.readdirSync(wdir).map((n) => path.join(wdir, n)); } catch (e) { return []; } };
    const base = (p) => p.replace(/.*\//, '');
    const mtimeOf = (p) => { try { const s = fs.statSync(p); return s.isFile() ? s.mtimeMs : null; } catch (e) { return null; } };
    const valueOf = (p) => {
        try {
            const b = fs.readFileSync(p);
            if (!b.length) return '(empty)';
            const head = b.slice(0, cap).toString('latin1');
            if (/^[\x09\x0a\x0d\x20-\x7e]*$/.test(head)) return `"${b.slice(-cap).toString('utf8').replace(/\s+/g, ' ').trim().slice(-72)}"`;
            return b.slice(0, cap).toString('hex');
        } catch (e) { return `(can't read: ${e.code || 'err'})`; }
    };
    const note = (tag, p, v) => {
        const line = `${new Date().toTimeString().slice(0, 8)}  ${tag}con/${base(p)} = ${v}`;
        log.push(line); if (log.length > maxLog) log.shift();
        if (onCh) onCh(line, log.length, log.slice());
    };

    function tick() {
        if (busy) return;
        busy = true;
        try {
            for (const p of listF()) {
                const mt = mtimeOf(p);
                if (mt === null) continue;
                const prev = last.get(p);
                if (prev && prev.mt === mt) continue;                 // mtime unmoved -> value unmoved, skip the read
                const v = valueOf(p);
                if (noise.has(p)) { last.set(p, { mt, v }); continue; }
                if (prev && prev.v === v) { last.set(p, { mt, v }); continue; }   // rewritten with the same value
                const fresh = !prev;
                last.set(p, { mt, v });
                note(fresh ? '(new) ' : '', p, v);
            }
        } finally { busy = false; }
    }
    return {
        start(onReady, onChange) {
            onCh = onChange; noise = new Set(); last = new Map(); log = []; busy = false;
            const a = new Map(); for (const p of listF()) a.set(p, valueOf(p));
            setTimeout(() => {
                for (const p of listF()) { const v = valueOf(p), mt = mtimeOf(p); if (a.has(p) && a.get(p) !== v && !always.has(base(p))) noise.add(p); last.set(p, { mt, v }); }
                onReady(null, noise.size);
                timer = setInterval(tick, every);
            }, quiet);
        },
        stop(cb) { if (timer) clearInterval(timer); timer = null; cb(log.slice()); }
    };
}

module.exports = { scan, lines, WORDS, recorder, watcher, rankFiles, test, testRecord };
if (require.main === module) { test(); testRecord(() => console.log('finder record self-check ok')); }
