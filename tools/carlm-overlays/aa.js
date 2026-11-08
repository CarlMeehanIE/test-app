'use strict';
/*
 * aa.js - carlm-overlays: is Android Auto connected? For the shortcut icon "Android Auto colour" (in its colours while
 * a phone is connected, white while not). Read from /proc as root, every POLL_MS, no car services asked:
 *   - aapd (BMW's Android Auto service, /usr/bin/aapd, its own user) found by /proc/<pid>/comm;
 *   - wireless: aapd holds an ESTABLISHED TCP connection (/proc/net/tcp, tcp6: state 01, its socket inodes from
 *     /proc/<pid>/fd) to a peer that is not the head unit itself - the way waze-on-cluster tells CarPlay's session
 *     (robertnisipeanu/idrive-apps, native/waze-on-cluster/patch/wifi_band.js);
 *   - wired: aapd holds a USB device open (/proc/<pid>/fd -> /dev/bus/usb/...). NOT checked on a car yet: if aapd gets
 *     the phone another way, a wired phone reads as not connected (the app shows what is read: Shortcuts page).
 * Pure parsers + a reader with injectable fs for the self-check.
 */
const fs = require('fs');
const path = require('path');

const POLL_MS = 3000;
const NAMES = ['aapd'];

/* a /proc/net/tcp(6) local / remote address (hex) is the head unit itself (loopback) or unset */
function local(addr) {
    const a = String(addr).split(':')[0].toUpperCase();
    if (/^0+$/.test(a)) return true;
    if (a.length === 8) return a.slice(6) === '7F';
    if (a === '00000000000000000000000001000000') return true;
    return a.length === 32 && a.slice(0, 24) === '0000000000000000FFFF0000' && a.slice(30) === '7F';
}
/* whether a tcp table holds an ESTABLISHED connection on one of the inodes to another device */
function establishedTo(table, inodes) {
    return String(table || '').split('\n').slice(1).some((line) => {
        const f = line.trim().split(/\s+/);
        return f.length >= 10 && f[3] === '01' && inodes.has(f[9]) && !local(f[2]);
    });
}

/* the reader: { connected, via: 'wifi' | 'usb' | null, pid } */
function reader(o) {
    const F = (o && o.fs) || fs, proc = (o && o.proc) || '/proc';
    let pid = null;
    function find() {
        if (pid && F.existsSync(path.join(proc, String(pid)))) {
            try { if (NAMES.indexOf(F.readFileSync(path.join(proc, String(pid), 'comm'), 'utf8').trim()) >= 0) return pid; } catch (e) { /* gone */ }
        }
        pid = null;
        for (const d of F.readdirSync(proc)) {
            if (!/^\d+$/.test(d)) continue;
            try { if (NAMES.indexOf(F.readFileSync(path.join(proc, d, 'comm'), 'utf8').trim()) >= 0) { pid = +d; break; } } catch (e) { /* gone */ }
        }
        return pid;
    }
    return function read() {
        const p = find();
        if (!p) return { connected: false, via: null, pid: null };
        const inodes = new Set();
        let usb = false;
        let fds = [];
        try { fds = F.readdirSync(path.join(proc, String(p), 'fd')); } catch (e) { return { connected: false, via: null, pid: p }; }
        for (const fd of fds) {
            let l = '';
            try { l = F.readlinkSync(path.join(proc, String(p), 'fd', fd)); } catch (e) { continue; }
            const m = /^socket:\[(\d+)\]$/.exec(l);
            if (m) inodes.add(m[1]);
            else if (/^\/dev\/bus\/usb\//.test(l)) usb = true;
        }
        let wifi = false;
        for (const t of ['net/tcp', 'net/tcp6']) {
            try { if (establishedTo(F.readFileSync(path.join(proc, t), 'utf8'), inodes)) wifi = true; } catch (e) { /* none */ }
        }
        return { connected: wifi || usb, via: wifi ? 'wifi' : usb ? 'usb' : null, pid: p };
    };
}

function test() {
    const assert = require('assert');
    const hdr = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
    const row = (loc, rem, st, inode) => `   0: ${loc} ${rem} ${st} 00000000:00000000 00:00000000 00000000  1050        0 ${inode} 1\n`;
    // the phone at 192.168.x (0201A8C0 in /proc's byte order), loopback 0100007F
    const tcp = hdr + row('0101A8C0:14A8', '0201A8C0:C350', '01', '777') + row('0100007F:1F90', '0100007F:D431', '01', '888') + row('00000000:14A8', '00000000:0000', '0A', '999');
    assert.strictEqual(establishedTo(tcp, new Set(['777'])), true, 'wireless: established to the phone');
    assert.strictEqual(establishedTo(tcp, new Set(['888'])), false, 'loopback is not a phone');
    assert.strictEqual(establishedTo(tcp, new Set(['999'])), false, 'listening is not connected');
    assert.strictEqual(establishedTo(tcp, new Set(['1'])), false, 'not aapd\'s socket');
    // the reader on a fake /proc
    const files = { '/p/12/comm': 'bash\n', '/p/40/comm': 'aapd\n', '/p/net/tcp': tcp, '/p/net/tcp6': hdr };
    let links = { '/p/40/fd/3': 'socket:[777]', '/p/40/fd/4': '/dev/null' };
    const F = { existsSync: (p) => p === '/p/40', readdirSync: (p) => (p === '/p' ? ['12', '40', 'net', 'self'] : Object.keys(links).filter((k) => k.startsWith(p + '/')).map((k) => k.slice(p.length + 1))),
        readFileSync: (p) => { if (files[p] === undefined) throw new Error('ENOENT'); return files[p]; }, readlinkSync: (p) => links[p] };
    const r = reader({ fs: F, proc: '/p' });
    assert.deepStrictEqual(r(), { connected: true, via: 'wifi', pid: 40 });
    links = { '/p/40/fd/5': '/dev/bus/usb/001/004' };
    assert.deepStrictEqual(r(), { connected: true, via: 'usb', pid: 40 });
    links = {};
    assert.deepStrictEqual(r(), { connected: false, via: null, pid: 40 });
    files['/p/40/comm'] = 'other\n'; F.existsSync = () => false;
    assert.deepStrictEqual(r(), { connected: false, via: null, pid: null }, 'no aapd running');
    console.log('aa self-check ok');
}

module.exports = { POLL_MS, local, establishedTo, reader, test };
if (require.main === module) test();
