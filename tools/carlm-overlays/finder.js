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
const WORDS = 'privacy|datenschutz|dataprotection|data_protection|vehiclelocation|vehicle_location|locationshar|location_shar|' +
    'sharelocation|share_location|vehiclefinder|vehicle_finder|tracking|ortung|geoposition|positionsdaten|stolen';
const MAX_LINES = 400, KEEP = 200, TIMEOUT_MS = 60000;

/* how telling a line is: a service / interface definition with an id, BMW's names, the privacy and location words over
 * the generic "tracking"; comments last */
function score(l) {
    const text = l.replace(/^[^:]*:\d+:/, '');
    let n = 0;
    if (/0x[0-9a-f]{3,4}\b/i.test(text)) n += 3;
    if (/service|interface|instance|event|method|attribute|broadcast/i.test(text)) n += 3;
    if (/de\.bmw|bmw/i.test(l)) n += 2;
    if (/privacy|datenschutz|data_?protection|location|ortung|position|vehicle_?finder|stolen/i.test(text)) n += 2;
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
    const args = ['-rIinE', WORDS, '-m', '20', '--no-messages'].concat(INCLUDE.map((g) => `--include=${g}`), dirs);
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
    const got = lines('/etc/vsomeip/hmi.json:12:   "service" : "0xb6a1", "name": "PrivacySettings"\n' +
        '/var/opt/carlm-overlays/x.json:1: privacy\n/opt/x/oap_5/rhmi.json:3: Tracking\n');
    assert.deepStrictEqual(got, ['/etc/vsomeip/hmi.json:12: "service" : "0xb6a1", "name": "PrivacySettings"'], 'ours and the apps\' left out');
    assert.deepStrictEqual(lines('/etc/a.conf:1: # key tracking notes\n/etc/b.json:2: "service":"0xb6a1" privacy\n'),
        ['/etc/b.json:2: "service":"0xb6a1" privacy', '/etc/a.conf:1: # key tracking notes'], 'a service with an id first, comments last');
    // a real run on this machine's /etc: grep is there, it answers, the result is bounded
    let done = false;
    scan((e, r) => { assert.ifError(e); assert(Array.isArray(r.lines) && r.lines.length <= MAX_LINES); done = true; }, { dirs: [path.join(__dirname)] });
    setTimeout(() => { assert(done, 'scan answered'); console.log('finder self-check ok'); }, 1500);
}

module.exports = { scan, lines, WORDS, test };
if (require.main === module) test();
