'use strict';
/*
 * overlays.js - carlm-overlays (from iteriodev-overlays, own ids beside it): the QuickSelect strip (iDrive 8.5 style) on iDrive 8, root service, Node 8.
 * Drawn by mgu-render as an overlay over the climate bar (its overlay_apps must list carlm-overlays: always shown,
 * touch first, may claim the climate bar). One layer, the bar's width:
 *   four shortcuts, two left and two right of CLIMATE MENU
 *     tap         opens the slot's screen: HMIControl2.requestGraphicalContext through `hmictl serve`
 *     long-press  (1 s) saves the screen on the CID now into that slot: a BMW screen, or an app's screen
 *   the seat buttons in the HMI's own spots, [vent][- temp +][heat] on each side (seats.js; only what the car has),
 *     the HMI's own icons at their size: off white, on red / blue with the HMI's accent line under the button
 *     tap         the level steps 1 -> 2 -> 3 -> off (or 3 -> 2 -> 1 -> off); what is shown is always the car's live
 *                 status (the climate menu or the seat buttons may change it), the asked level only until it answers
 *   the steering wheel heating at the bar's far left, the same kind of button (one tap: on / off)
 *   a right-hand drive car (the setting side 'right', set in the app; default 'left', user 2026-11-08): the driver's
 *     seat buttons in the right-hand spots, the passenger's in the left-hand ones, the wheel at the far right
 *   alignment (settings.align, set on the Overlays app's Align page): per button, and 'all' for every one, x moves the
 *     whole button (icon, accent line, touch area) left / right, y moves its icon up / down; px, added to LAYOUT
 *   M1 / M2 on the steering wheel (M cars): an M setup switched on also switches the M Mode (cluster, HUD, as the M
 *     Mode panel's button: `hmictl mmode sport`), switched off back; which mode for each: the settings
 * The Overlays app (carlm_overlays) is its control panel: a JSON-lines socket (CTL) with the settings, the slots,
 * what the car has and the screens a slot can open; every change is pushed to it.
 * A slot is a graphical context. An OAP app's screens sit at its installed rhmiData/application.json appletId
 * (+ 3000 with the oap-sdk's offset; MainApp / mgu-deploy give the id at install and keep it on updates), so an app
 * slot keeps the app's id and the offset and reads the appletId again on every tap. The app's picture is its tile
 * icon (application.json entryPoints[0].icon, a PNG in rhmiData) or its package icon.png; BMW's own gid:// tile
 * icons can't be drawn here, so those apps, and BMW screens the strip has no icon for, get a plain one.
 * A slot's own icon (slot.icon, picked in the app; ICON_LIB, icons/lib/<name>.png) replaces its picture in the strip; it
 * stays with the slot when what it opens changes (a hold, the app's picker), until set back to the default (null).
 * Data: /var/opt/carlm-overlays/slots.json { slots: [SLOTS x {state, applet} | {app, state, offset}, + icon?], settings, mcar,
 * learned, vents (legacy cars: ventilation seen on, per seat), layout? }. VM ids (2026-11-01): Media 2 23, Nav 1 32, Phone 24 34, All apps 20 4, Home 20000 4, Climate 3 517.
 *   node overlays.js          the service (OVERLAYS_SEAT_DEMO=1: seats without a car, for the VM)
 *   node overlays.js --test   the self-check (no car needed)
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const png = require('./png');
const seats = require('./seats');
const shift = require('./shiftlights');
const aa = require('./aa');
const finder = require('./finder');

const DATA = process.env.OVERLAYS_DATA || '/var/opt/carlm-overlays/slots.json';
const CTL = process.env.OVERLAYS_CTL || '/run/carlm-overlays/ctl.sock';
const OAP = process.env.OVERLAYS_OAP || '/var/opt/public/oap';
const CLIENT = process.env.MGU_RENDER_CLIENT || '/var/opt/mgu-render/current/mgu_render_client.js';
const CLUSTER = process.env.CLUSTER_RENDER_CLIENT || '/var/opt/cluster-render/current/cluster_render_client.js';
const HMICTL = path.join(__dirname, 'hmictl');
const SELF = 'carlm_overlays';               // the control-panel app: not offered as a slot
const PEEK_MS = 20000;                        // "Show BMW's own": how long ours stay hidden
const HOLD_MS = 1000, PENDING_MS = 3000, REREAD_MS = 60000;
const OFFSETS = [0, 3000];                   // an app's RHMI application against its appletId (oap-sdk)
// screen px. The M4's bar (screenshots 2026-11-02 / -03): temperatures 365-843 | 1987-2465, CLIMATE MENU 1386-1495.
// The HMI's seat buttons are 120 px wide, their accent line at y 99-104 of the bar, and the icon sits ICON_DX right of
// the button's centre on every button (not mirrored): heat 864-983 (21 px right of a temperature), ventilation
// 222-341 / 1844-1963 (24 px left of one), measured with the HMI's own icons on; passenger heat by the driver's
const LAYOUT = { x: 0, y: 840, w: 2880, h: 120, slots: [1055, 1200, 1540, 1685, 1835], slotW: 140, buttonW: 120,
    // the bar's LEFT seat buttons 24 px right of IterioDev's measure: there the HMI's own button and accent line sit on
    // this car (video 2026-11-08: its line ran on past the right end of ours, the press box covered only part of the
    // button, a tap at its right end reached the HMI). The RIGHT ones stay as measured (2nd video: moved 24 px too, the
    // HMI's line showed left of ours instead)
    buttons: { 'driver.wheel': 20, 'driver.cool': 246, 'driver.heat': 888, 'passenger.cool': 1844, 'passenger.heat': 2486 },
    // the far-left empty zone (before the temperature control at x 365): one extra shortcut (the M), drawn at the HMI's
    // own icon height (so it sits the same height as the music / home / grid glyphs), any width, and centred in the zone
    // on cx (if ever more than one is shown, the whole row is centred on cx)
    left: { cx: 115, ih: 40, gap: 28, maxw: 300 },
    // the "passenger heat on the left" option (settings.heatLeft): the passenger heat button is redrawn here instead, left
    // of the temperature control (a gap before it, so its grey line doesn't clash with the temp's blue) and beside the M;
    // nudge on the Align page
    heatLeftX: 190,
    iconY: 55, lineY: 99, lineH: 6 };
const GRID = LAYOUT.slots.length;    // 5 fixed grid shortcuts: four around CLIMATE MENU, a fifth at the free cooled-seat spot
// two placed shortcuts (shown only when given an icon): GRID the M in the far-left zone, GRID+1 over the heat spot freed
// by "passenger heat on the left" (only while heatLeft is on)
const LEFT = 2;
const SLOTS = GRID + LEFT;           // 7 configurable shortcuts in all
const LEFTPIX = [11, 12];            // the placed slots' pixmaps (grid uses 1..GRID, buttons 6..10, the blank mask 13)
// IterioDev measured the HMI's own icons 24 px right of the button's centre; on this car (2026-11-08) they read off-centre
// against the accent line, so the icon sits centred over it
const ICON_DX = 0;
// the BMW screens the app offers (a slot can hold any other one, saved by a hold): strip picture, the app's icon.
// The ids are the VM's (mgu-m4's HMI). Another HMI build can number a screen differently (a client's M2, 2026-11-04:
// Navigation did nothing): a tap that leaves the screen as it was counts as failed, and a hold soon after it learns the
// screen's own ids under that name (learned{}, kept in slots.json).
const SCREENS = [
    { title: 'Media', state: 2, applet: 23, png: 'media', icon: 'Playlist' },
    { title: 'Navigation', state: 1, applet: 32, png: 'nav', icon: 'Navigation' },
    { title: 'Phone', state: 24, applet: 34, png: 'phone', icon: 'Smartphone' },
    { title: 'All apps', state: 20, applet: 4, png: 'apps', icon: 'Menu' },
    { title: 'Home', state: 20000, applet: 4, png: 'home', icon: 'MainMenu' },
    { title: 'Climate', state: 3, applet: 517, png: 'climate', icon: 'Fan' },
    // Android Auto's own ids are not known yet (-1): picked, the slot is taught by a hold on Android Auto (learned{})
    { title: 'Android Auto', state: -1, applet: -1, png: 'lib/android-auto', icon: 'AndroidAuto', learn: true },
];
// the icons a slot can wear instead of its own picture: icons/lib/<name>.png, 84 px, #f0f0f0 like icons/*.png. Material
// Design Icons (Pictogrammers, Apache-2.0) and, for Android Auto (white, and in its colours) and Waze, Simple Icons (CC0); first the iDrive 8.5
// quick-select set (media, nav, home, apps, phone: the strip's own icons/*.png; fan: MDI at their size): icons/lib/LICENSE
const ICON_LIB = [
    ['m-color', 'M'],
    ['android-auto', 'Android Auto'],
    ['android-auto-color', 'Android Auto live'],
    ['media', 'Media'],
    ['nav', 'Navigation'],
    ['fan', 'Climate'],
    ['home', 'Home'],
    ['apps', 'All apps'],
    ['phone', 'Phone'],
    ['android', 'Android'],
    ['spotify', 'Spotify'],
    ['podcast', 'Podcasts'],
    ['radio', 'Radio'],
    ['youtube', 'YouTube'],
    ['map-marker', 'Map pin'],
    ['google-maps', 'Google Maps'],
    ['waze', 'Waze'],
    ['message-text', 'Messages'],
    ['account', 'Profile'],
    ['car', 'Car'],
    ['car-info', 'Car info'],
    ['car-cog', 'Car settings'],
    ['car-wrench', 'Service'],
    ['engine', 'Engine'],
    ['speedometer', 'Speedometer'],
    ['car-battery', 'Battery'],
    ['gas-station', 'Fuel'],
    ['ev-station', 'Charging'],
    ['tire', 'Tyres'],
    ['thermometer', 'Temperature'],
    ['car-seat-heater', 'Seat heating'],
    ['car-seat-cooler', 'Seat cooling'],
    ['steering', 'Steering wheel'],
    ['lightbulb', 'Light'],
    ['palette', 'Colours'],
    ['camera', 'Camera'],
    ['video', 'Video'],
    ['flag-checkered', 'Track'],
    ['timer-outline', 'Timer'],
    ['cog', 'Settings'],
];
// "Android Auto live": in its colours while a phone's Android Auto is connected (aa.js), else the white one
const AA_LIVE = 'android-auto-color', AA_OFF = 'android-auto';
const iconName = (n) => (typeof n === 'string' && ICON_LIB.some((x) => x[0] === n) ? n : null);
let learned = {};                                    // title -> { state, applet } this car's HMI uses instead
const screenList = () => SCREENS.map((s) => (learned[s.title] ? Object.assign({}, s, learned[s.title]) : s));
const DEFAULT_TITLES = ['Media', 'Navigation', 'Phone', 'All apps', 'Home'];
const defaults = () => {
    const by = (t) => { const s = screenList().find((x) => x.title === t); return { state: s.state, applet: s.applet }; };
    // 5 grid slots, then the M (far-left, wears the M icon so it shows), then the heat-spot slot (empty: hidden until given an icon)
    return DEFAULT_TITLES.map(by).concat([Object.assign(by('Home'), { icon: 'm-color' }), by('Home')]);
};
const FAIL_MS = 800, REPAIR_MS = 10 * 60000;          // a tap's screen read again after; a hold that repairs it, within
/* a tap that did nothing: the screen read before and after the open is the same, and is not the one asked for */
function stuck(before, after, t) {
    const p = (r) => { const m = /^ok (-?\d+) (-?\d+)/.exec(r || ''); return m ? [+m[1], +m[2]] : null; };
    const b = p(before), a = p(after);
    return !!(b && a && b[0] === a[0] && b[1] === a[1] && !(a[0] === t.state && a[1] === t.applet));
}
// the seat / wheel buttons in the bar: 'auto' = what the car reports, 'on' / 'off' = the user's choice (cars that report
// a function they don't have: a client's M2 without ventilation showed its icon, 2026-11-04)
const BUTTON_KEYS = ['driver.wheel', 'driver.cool', 'driver.heat', 'passenger.cool', 'passenger.heat'];
const SHOW = ['auto', 'on', 'off'], MCAR = ['auto', 'yes', 'no'];
/* an M car: the user's choice, else what the car reported (an M setup seen) */
const mcarOf = (found, set) => (set.mmode.car === 'yes' ? true : set.mmode.car === 'no' ? false : !!found);
const RED = [255, 48, 49], BLUE = [29, 120, 223], WHITE = [255, 255, 255];   // the HMI's accent colours
const OFF_ALPHA = 0.6;
const MODES = ['road', 'sport', 'track'];
// the M Mode a start switches to once the cluster is up: 'car' leaves the car's own (mmode.start; it replaces
// mmode.boot, true = 'sport')
const STARTS = ['car'].concat(MODES);
const SIDES = ['left', 'right'];                     // where the steering wheel is (LAYOUT is a left-hand drive car's)
// alignment: a car whose bar is not where LAYOUT measured it (another HMI build, a right-hand drive car's mirrored bar):
// px per button key and 'all' (added to each): x the whole button (icon, line, touch), ix its icon alone left / right,
// y its icon up / down; kept within these
// lhx: moves the accent line (connector + segments) left / right as a block, apart from the icon; lx lengthens it
const ALIGN_KEYS = ['all'].concat(BUTTON_KEYS), ALIGN_MAX = { x: 120, ix: 40, y: 20, ly: 24, lx: 240, lhx: 120 }, AXES = ['x', 'ix', 'y', 'ly', 'lx', 'lhx'];
const clampAlign = (v, axis) => Math.max(-ALIGN_MAX[axis], Math.min(ALIGN_MAX[axis], v));
/* a button's total offset: its own plus 'all' */
const alignOf = (set, key) => {
    const a = (set && set.align) || {}, all = a.all || {}, own = a[key] || {};
    const out = {};
    AXES.forEach((k) => { out[k] = clampAlign((all[k] | 0) + (own[k] | 0), k); });
    return out;
};
// the measured per-button defaults (Carl's car, right-hand drive): a fresh install / Values starts aligned
const ALIGN_DEFAULTS = { 'driver.heat': { x: 36, y: -1 }, 'passenger.heat': { x: 12, y: -1, ly: 1 }, 'driver.wheel': { x: -40 } };
const SETTINGS = { shortcuts: true, seats: true, wheel: true, ambient: true, heatLeft: false, ambientHeat: 3, ambientCool: 9, order: 'up', side: 'left',
    show: BUTTON_KEYS.reduce((o, k) => { o[k] = 'auto'; return o; }, {}),
    align: ALIGN_KEYS.reduce((o, k) => { o[k] = Object.assign({ x: 0, ix: 0, y: 0, ly: 0, lx: 0, lhx: 0 }, ALIGN_DEFAULTS[k]); return o; }, {}),
    mmode: { on: true, m1: 'sport', m2: 'sport', off: 'road', start: 'car', car: 'auto' }, shift: shift.DEFAULTS };
// MDrive 0xB51F, the active M setup: statusMConfigurationMDrive 0x8018 byte 0 (Hmi8's ...SP21: 0 none, 1 M1, 2 M2,
// 3 unset) or, older, statusMDriveTwo 0x8001 byte 0 (...SP18: statusMDrive2 0 off, 1 on); SP21 wins once seen
const MDRIVE = 0xb51f, MDRIVE_SUB = `sub 0xb51f 1 1 1 0x8018 0x8001 0x${shift.DME.ev.toString(16)}`;
// Vehicle2 0xB519 statusDisplayKombi 0x807C (getter 124): the cluster's view, 1 standard, 2 M view, 3 M view plus,
// 15 not filled in (mgu-m4 2026-11-03: 02 in SPORT, the getter answers)
const VEHICLE2 = 0xb519, KOMBI_EV = 0x807c, KOMBI_SUB = 'sub 0xb519 1 1 1 0x807c';
// the car switched off ends an M setup, and SP18's toggle with it (a client's M2, 2026-11-05: switched off in M1, the
// next M press read as leaving): VehicleCondition 0x1531 vehicleConditionNoCrc 0x8002 (event group 2), byte 5
// statusConditionVehicle 1 / 2 PARKEN, 3 STANDFUNKTIONEN, 5 WOHNEN (10 FAHREN, 8 / 12 drive-ready coming / going);
// and the head unit asleep (STR: the process stood still WAKE_MS or longer)
const VCOND = 0x1531, VCOND_EV = 0x8002, VCOND_SUB = 'sub 0x1531 1 1 2 0x8002', WAKE_MS = 60000;
const carOff = (hex) => [1, 2, 3, 5].indexOf(parseInt((hex || '').slice(10, 12), 16)) >= 0;
const mReset = (m) => { m.sp18 = 0; m.setup = 0; };
// the ambient light flash when a seat or the wheel heating goes on: ComfortFunctionIuK 0xB512, the 12-colour ambient
// light (G8x): status getter 3 / setter 26, 10 bytes {hue u16, colour 1-12, layer 1-3, brightness, mode (1 on),
// dynamic x2}; 0fff / ff / 03 = no change. The colour byte is the 0-based place in the HMI's list (sqltext.db: Ivory,
// Citrine, Coral, ... Azure 9th); mgu-m4 2026-11-03 (user): 3rd red, 9th azure. Back to the colour read before after FLASH_MS.
// The settings hold the colours' numbers as the menu counts them (1-12): ambientHeat, ambientCool.
const AMBIENT = { get: 'call 0xb512 1 3 1', set: (c) => `call 0xb512 1 26 1 0fff${c}ffffffff030303`,
    byte: (n) => (n - 1).toString(16).padStart(2, '0') };
const FLASH_MS = 5000, FLASH_AFTER_MS = 10000;      // ponytail: no flash for the start's first statuses (grace window)
// boot: the strip shows with the HMI, not over the black screen of a start nor the M start animation (a client
// 2026-11-07: "overlaps with the M boot animation"; mgu-m4: the animation is a video cameraplayer plays on surface 0x198,
// 1280x480 surface ~50 s from boot, the animation itself a few seconds). Shown AFTER_MS after the start (the head unit's
// boot, or a wake from sleep; a tester 2026-11-07: 1 min too long, 10-15 s enough) and only once the HMI answers its
// graphical context (HMIContext2); it stays over the cameras after that. No HMI answer by MAX_MS: shown all the same.
// A restart of the tool later (an update) shows it at once.
// a cold boot waits out the M start animation (AFTER_MS); a wake from sleep has no animation, so it shows as soon as the
// HMI answers its context, with only a short floor (WAKE_AFTER_MS) to let the home screen compose
const BOOT = { AFTER_MS: 15000, MAX_MS: 60000, WAKE_AFTER_MS: 1500, WAKE_MAX_MS: 12000 };
function bootGate(now, b) {                          // b: { since (the start), hmiAt (0: not yet), wake } -> why up, or null
    const after = b.wake ? BOOT.WAKE_AFTER_MS : BOOT.AFTER_MS, max = b.wake ? BOOT.WAKE_MAX_MS : BOOT.MAX_MS;
    if (b.hmiAt && now - b.since >= after) return 'HMI up';
    return now - b.since >= max ? 'timeout' : null;
}
/** when the head unit started: now less its uptime (/proc/uptime counts sleep too: a wake is told by the tick gap) */
function bootedAt() {
    try { return Date.now() - parseFloat(fs.readFileSync('/proc/uptime', 'utf8')) * 1000; } catch (e) { return Date.now(); }
}

const log = (m) => console.log(m);

/* ---- what is installed, slots <-> graphical contexts (pure; --test) ---- */
function installedApps(root) {
    let dirs = [];
    try { dirs = fs.readdirSync(root).filter((d) => /^oap_\d+$/.test(d)); } catch (e) { return []; }
    const apps = [];
    for (const d of dirs) {
        try {
            const a = JSON.parse(fs.readFileSync(path.join(root, d, 'rhmiData', 'application.json'), 'utf8')
                .replace(/^﻿/, '')).application;
            if (a && a.name && typeof a.appletId === 'number') {
                const ep = (a.entryPoints || [])[0];
                apps.push({ id: a.name, appletId: a.appletId, dir: path.join(root, d), icon: ep && ep.icon, tile: !!ep });
            }
        } catch (e) { /* no RHMI app there */ }
    }
    return apps;
}
/* the screen on the CID (StateID, AppletID) -> what a slot keeps */
function classify(state, applet, apps) {
    for (const a of apps) {
        const off = applet - a.appletId;
        if (OFFSETS.indexOf(off) >= 0) return { app: a.id, state, offset: off };
    }
    return { state, applet };
}
/* a slot -> the context to open now (null: its app is not installed) */
function target(slot, apps) {
    if (!slot.app) return { state: slot.state, applet: slot.applet };
    const a = apps.find((x) => x.id === slot.app);
    return a ? { state: slot.state, applet: a.appletId + slot.offset } : null;
}
/* an Android Auto slot holds two screens: the app's own screen (state/applet, used when a phone is connected) and the
 * connect / setup screen (connect, used when none is). A tap opens whichever matches the live connection, like the OEM
 * tile. state -1 (or no connect) means that screen is not taught yet -> ask for the hold that teaches it. */
function aaTarget(slot, connected) {
    return connected ? { state: slot.state, applet: slot.applet } : (slot.connect || { state: -1, applet: -1 });
}
/* a slot -> its picture: { builtin: name } or { file } (+ missing for an app that is gone) */
function iconOf(slot, apps, live) {
    let own = iconName(slot.icon);
    if (own === AA_LIVE && live && !live.aa) own = AA_OFF;
    if (own) return Object.assign({ builtin: 'lib/' + own }, slot.app && !apps.some((x) => x.id === slot.app) ? { missing: true } : {});
    if (!slot.app) { const s = screenList().find((x) => x.state === slot.state && x.applet === slot.applet); return { builtin: s ? s.png : 'screen' }; }
    const a = apps.find((x) => x.id === slot.app);
    if (!a) return { builtin: 'app', missing: true };
    const want = typeof a.icon === 'string' && !/^gid:/.test(a.icon) ? path.basename(a.icon) : null;
    const f = (want && findFile(path.join(a.dir, 'rhmiData'), want, 4)) ||
        [path.join(a.dir, 'source', 'icon.png')].find((p) => fs.existsSync(p));
    return f ? { file: f } : { builtin: 'app' };
}
function findFile(dir, name, depth) {
    let ents = [];
    try { ents = fs.readdirSync(dir); } catch (e) { return null; }
    if (ents.indexOf(name) >= 0 && fs.statSync(path.join(dir, name)).isFile()) return path.join(dir, name);
    for (const e of ents) {
        const p = path.join(dir, e);
        if (depth > 0 && fs.statSync(p).isDirectory()) { const f = findFile(p, name, depth - 1); if (f) return f; }
    }
    return null;
}
/* an app's name (its package's productName) and the screen its tile opens (the lowest RHMI state). The AppletID is the
 * appletId itself on the car (mgu-m4 2026-11-03: Car Data, Fault Codes held at state 3000 with offset 0); some SDK
 * builds add 3000 (the VM's older apps): tap() tries the other offset when this one fails, and keeps the one that works */
function appInfo(a) {
    let title = a.id, state = null;
    try { title = JSON.parse(fs.readFileSync(path.join(a.dir, 'source', 'package.json'), 'utf8')).productName || title; } catch (e) { /* none */ }
    const ui = findFile(path.join(a.dir, 'rhmiData', 'uiDescriptions', 'ID8'), 'uiDescription.json', 1) ||
        findFile(path.join(a.dir, 'rhmiData'), 'uiDescription.json', 3);
    try {
        const c = JSON.parse(fs.readFileSync(ui, 'utf8')).containers || {};
        Object.keys(c).filter((k) => c[k].type === 'state').forEach((k) => { if (state === null || +k < state) state = +k; });
    } catch (e) { /* no description */ }
    return state === null ? null : { id: a.id, title, state, offset: 0 };
}
/* a slot as the app shows it */
function describe(slot, apps) {
    if (slot.app) {
        const a = apps.find((x) => x.id === slot.app), i = a && appInfo(a);
        return Object.assign({ kind: 'app', app: slot.app, title: i ? i.title : slot.app, missing: !a }, iconName(slot.icon) ? { own: slot.icon } : {});
    }
    const s = screenList().find((x) => x.state === slot.state && x.applet === slot.applet);
    const d = { kind: 'bmw', title: s ? s.title : 'BMW screen', icon: s ? s.icon : 'Display' };
    if (slot.aa) { d.title = 'Android Auto'; d.icon = 'AndroidAuto'; d.aa = true; d.connect = !!slot.connect; }   // two-screen AA slot
    return Object.assign(d, iconName(slot.icon) ? { own: slot.icon } : {});
}
/* settings from the app (or the file): only known keys of the right kind; the rest stays */
function mergeSettings(cur, p) {
    const out = JSON.parse(JSON.stringify(cur));
    if (!p || typeof p !== 'object') return out;
    ['shortcuts', 'seats', 'wheel', 'ambient', 'heatLeft'].forEach((k) => { if (typeof p[k] === 'boolean') out[k] = p[k]; });
    ['ambientHeat', 'ambientCool'].forEach((k) => { if (Number.isInteger(p[k]) && p[k] >= 1 && p[k] <= 12) out[k] = p[k]; });
    if (p.order === 'up' || p.order === 'down') out.order = p.order;
    if (SIDES.indexOf(p.side) >= 0) out.side = p.side;
    if (p.show && typeof p.show === 'object') BUTTON_KEYS.forEach((k) => { if (SHOW.indexOf(p.show[k]) >= 0) out.show[k] = p.show[k]; });
    if (!out.align) out.align = JSON.parse(JSON.stringify(SETTINGS.align));
    if (p.align && typeof p.align === 'object') {
        ALIGN_KEYS.forEach((k) => {
            const v = p.align[k];
            if (!v || typeof v !== 'object') return;
            AXES.forEach((axis) => { if (Number.isInteger(v[axis])) out.align[k][axis] = clampAlign(v[axis], axis); });
        });
    }
    if (p.mmode && typeof p.mmode === 'object') {
        if (typeof p.mmode.on === 'boolean') out.mmode.on = p.mmode.on;
        if (typeof p.mmode.boot === 'boolean') out.mmode.start = p.mmode.boot ? 'sport' : 'car';   // 0.6 and older, old apps
        if (STARTS.indexOf(p.mmode.start) >= 0) out.mmode.start = p.mmode.start;
        delete out.mmode.boot;
        ['m1', 'm2', 'off'].forEach((k) => { if (MODES.indexOf(p.mmode[k]) >= 0) out.mmode[k] = p.mmode[k]; });
        if (MCAR.indexOf(p.mmode.car) >= 0) out.mmode.car = p.mmode.car;
    }
    out.shift = shift.mergeSettings(out.shift, p.shift);
    return out;
}
const slotOk = (s) => s && Number.isInteger(s.state) &&
    (typeof s.app === 'string' ? OFFSETS.indexOf(s.offset) >= 0 : Number.isInteger(s.applet));
function loadData(file) {
    let j = {};
    try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') log('slots.json: ' + e.message + ', the defaults instead'); }
    const good = Array.isArray(j.slots) && j.slots.length >= 4 && j.slots.length <= SLOTS && j.slots.every(slotOk);
    if (j.slots && !good) log(`slots.json: not 4..${SLOTS} good slots, the defaults instead`);
    const lr = {};
    if (j.learned && typeof j.learned === 'object') {
        SCREENS.forEach((s) => { const v = j.learned[s.title]; if (v && Number.isInteger(v.state) && Number.isInteger(v.applet)) lr[s.title] = { state: v.state, applet: v.applet }; });
    }
    learned = lr;
    const vents = {};                                  // legacy cars: seats whose ventilation was seen on (seats.js)
    seats.SEATS.forEach((s) => { if (j.vents && j.vents[s] === true) vents[s] = true; });
    if (good) j.slots.forEach((sl) => { if (sl.icon !== undefined && !iconName(sl.icon)) delete sl.icon; });   // an icon this version lacks
    let slots = good ? j.slots.slice() : defaults();
    while (slots.length < SLOTS) slots.push(defaults()[slots.length]);   // a 4-slot file from an older version: pad to SLOTS
    return { slots, layout: j.layout, learned: lr, settings: migrate(mergeSettings(SETTINGS, j.settings), j.settings),
        mcar: j.mcar === true, vents };
}
/* 0.3.5 and older had one switch for all seat buttons and one for the wheel; the per-button choice replaces them (the
 * app shows only that): a switch that was off turns its buttons 'off' */
function migrate(set, old) {
    if (!old || typeof old !== 'object' || old.show) return set;
    if (old.seats === false) BUTTON_KEYS.filter((k) => k !== 'driver.wheel').forEach((k) => { set.show[k] = 'off'; });
    if (old.wheel === false) set.show['driver.wheel'] = 'off';
    set.seats = set.wheel = true;
    return set;
}
function saveData(file, data) {
    try { fs.mkdirSync(path.dirname(file)); } catch (e) { if (e.code !== 'EEXIST') throw e; }   // node 8: no recursive
    fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2) + '\n');
    fs.renameSync(file + '.tmp', file);
}
/* an MDrive notification -> the active M setup (0 none, 1 M1 - SP18: an M setup on -, 2 M2), or null: not about
 * that, unset, or SP18 after SP21 was seen. SP21's 0x8018 is a state. SP18's statusMDriveTwo 0x8001 is NOT
 * (mgu-m4 2026-11-03): each M button action sends ONE "EIN" frame with the configuration it applies (entering M1, also
 * by the double press DSC off needs: M1's; leaving: the car's normal one) and at once "AUS" again. So an EIN frame
 * toggles (at a start no M setup is active); AUS frames and repeats within PULSE_MS are ignored. Only frames with
 * byte 1 controlDisplayMDrive2 = 1 (M1_M2_TASTE_AKTIV) come from the M buttons: the car also sends EIN frames with 0
 * there and the normal settings by itself (5 in 13 min on mgu-m4, 2026-11-03), which must not toggle. A direct
 * M1 -> M2 switch would read as leaving (not seen on the car yet). */
const PULSE_MS = 1000;
function mSetupOf(m, ev, hex, now) {
    const v = parseInt((hex || '').slice(0, 2), 16);
    if (ev === 0x8018 && v <= 2) { m.sp21 = true; return v; }
    if (ev !== 0x8001 || m.sp21 || v !== 1 || parseInt(hex.slice(2, 4), 16) !== 1) return null;
    if (now - (m.pulseAt || -Infinity) < PULSE_MS) return null;
    m.pulseAt = now;
    m.sp18 = m.sp18 ? 0 : 1;
    return m.sp18;
}
/* which flash for levels (one per key, 0 off) going from off to on: 'heat' (seat, wheel; also when both) or 'cool'
 * (ventilation); null when nothing went on */
function flashKind(keys, before, after) {
    const on = keys.filter((k, i) => !before[i] && after[i]);
    return !on.length ? null : on.some((k) => !k.endsWith('.cool')) ? 'heat' : 'cool';
}
/* the ambient light's colour number from its status (hex), or null when it is off or unreadable */
function ambientColour(hex) {
    return hex && hex.length === 20 && hex.slice(14, 16) === '01' ? hex.slice(4, 6) : null;
}
/* the cluster's view (statusDisplayKombi byte 0) -> it, when the cluster just came up: the first filled-in value
 * since the tool started or since it read 15. "Start in M SPORT" waits for that, not for the head unit's own start:
 * the head unit wakes before the cluster does */
function clusterUp(k, hex) {
    const v = parseInt((hex || '').slice(0, 2), 16);
    if (!(v >= 1 && v <= 3)) { k.up = false; return null; }
    if (k.up) return null;
    k.up = true;
    return v;
}
/* the next level of a tap: 1 -> 2 -> 3 -> off ('up'), or 3 -> 2 -> 1 -> off ('down') */
const nextLevel = (level, max, order) => (order === 'down' ? (level > 0 ? level - 1 : max) : seats.next(level, max));
/* the seat whose spots a seat's buttons take: its own on a left-hand drive car, the other one's on a right-hand drive
 * one (the driver sits on the right: a client's report 2026-11-08, the left icons switched the right seat) */
const spotSeat = (seat, side) => (side !== 'right' ? seat : seat === 'driver' ? 'passenger' : 'driver');
/* where a seat / wheel button sits (L.buttons: a left-hand drive car's); the wheel at the other end on a right-hand one */
function spot(L, key, side) {
    const [seat, kind] = key.split('.');
    if (kind === 'wheel') return side === 'right' ? L.w - L.buttons[key] - L.buttonW : L.buttons[key];
    return L.buttons[`${spotSeat(seat, side)}.${kind}`];
}
// "passenger heat on the left" (set.heatLeft) relocates the PASSENGER's seat-heat button (whichever side spot the drive
// side puts it in); the driver's stays put. The side swap means this is the left button on a right-hand-drive car.
const HEAT_MOVE_KEY = 'passenger.heat';
/* when heatLeft is on and the passenger heat button is shown, the spot it left behind (to blank with a bar-colour mask) */
function blankSpot(L, st, set) {
    if (!set.heatLeft) return null;
    return buttons(L, st, set).some((b) => b.key === HEAT_MOVE_KEY) ? { x: spot(L, HEAT_MOVE_KEY, set.side) } : null;
}
/* the seat / wheel buttons to show, [{ key, x }]: per button the user's choice ('on' / 'off'), on 'auto' what the car has;
 * the old master switches (seats, wheel) still hide theirs */
function buttons(L, st, set) {
    const want = (key, have) => (set.show[key] === 'on' || (set.show[key] !== 'off' && have));
    const movedHeat = set.heatLeft ? HEAT_MOVE_KEY : null;
    // the passenger heat button is redrawn at heatLeftX (beside the M) when heatLeft is on; everything else in its own spot
    const at = (key) => Math.max(0, Math.min(L.w - L.buttonW, (key === movedHeat ? L.heatLeftX : spot(L, key, set.side)) + alignOf(set, key).x));
    const out = [];
    if (set.wheel && want('driver.wheel', st.wheel.have)) out.push({ key: 'driver.wheel', x: at('driver.wheel') });
    if (set.seats) {
        for (const seat of seats.SEATS) {
            for (const kind of ['cool', 'heat']) {
                const key = `${seat}.${kind}`;
                if (want(key, st.seats[seat][kind].have)) out.push({ key, x: at(key) });
            }
        }
    }
    return out;
}

/* ---- touch: tap or hold, per gesture (pure; --test). Targets: slot numbers (tap + hold), button keys (tap) ---- */
class Gestures {
    constructor(targetAt, onTap, onHold, timers) {
        this.targetAt = targetAt; this.onTap = onTap; this.onHold = onHold; this.t = timers || { set: setTimeout, clear: clearTimeout };
        this.cur = -1; this.held = false; this.timer = null;
    }
    touch(phase, x) {
        const k = this.targetAt(x);
        if (phase === 'down') {
            this.cancel(); this.cur = k; this.held = false;
            if (typeof k === 'number' && k >= 0) this.timer = this.t.set(() => { this.timer = null; this.held = true; this.onHold(k); }, HOLD_MS);
        } else if (phase === 'move' && k !== this.cur) this.cancel();
        else if (phase === 'up') {
            if (this.cur !== -1 && !this.held && k === this.cur) this.onTap(k);
            this.cancel();
        }
    }
    cancel() { if (this.timer) this.t.clear(this.timer); this.timer = null; this.cur = -1; }
    pressed() { return this.held ? -1 : this.cur; }
}

/* ---- drawing: premultiplied RGBA ---- */
// an app's picture in a slot: its drawn part at most this big, as the car's own icons (their glyphs 40-50 px at 76)
const APP_GLYPH = 44;
/* img (straight RGBA) cut to what is drawn (alpha > 8): an app's tile picture without its empty border */
function trim(img) {
    let x0 = img.w, y0 = img.h, x1 = -1, y1 = -1;
    for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
        if (img.data[(y * img.w + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0) return img;
    const w = x1 - x0 + 1, h = y1 - y0 + 1, data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) data.set(img.data.subarray(((y0 + y) * img.w + x0) * 4, ((y0 + y) * img.w + x1 + 1) * 4), y * w * 4);
    return { w, h, data };
}
function blend(dst, w, x0, y0, img, alpha) {         // img straight RGBA, alpha 0..1
    for (let y = 0; y < img.h; y++) {
        for (let x = 0; x < img.w; x++) {
            const s = (y * img.w + x) * 4, a = img.data[s + 3] * alpha / 255;
            const dx = x0 + x, dy = y0 + y;
            if (!a || dx < 0 || dy < 0 || dx >= w || dy * w * 4 >= dst.length) continue;
            const d = (dy * w + dx) * 4;
            for (let c = 0; c < 3; c++) dst[d + c] = Math.round(img.data[s + c] * a + dst[d + c] * (1 - a));
            dst[d + 3] = Math.round(255 * a + dst[d + 3] * (1 - a));
        }
    }
}
function pill(w, h, inset, r, alpha, rgb) {          // a rounded rect, edges anti-aliased, as a straight image
    const data = Buffer.alloc(w * h * 4), c = rgb || [255, 255, 255];
    const hw = w / 2 - inset, hh = h / 2 - inset;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const qx = Math.abs(x + 0.5 - w / 2) - (hw - r), qy = Math.abs(y + 0.5 - h / 2) - (hh - r);
            const dist = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
            const cov = Math.max(0, Math.min(1, 0.5 - dist)), i = (y * w + x) * 4;
            data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = Math.round(255 * alpha * cov);
        }
    }
    return { w, h, data };
}
function tint(img, rgb) {                            // the HMI's icons are grey + alpha: coloured like the HMI does
    if (!img) return img;
    const data = Buffer.from(img.data);
    for (let i = 0; i < data.length; i += 4) { data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; }
    return { w: img.w, h: img.h, data };
}
/* one seat / wheel button (buttonW x h): the icon off its centre, the accent line when on */
/* on, the accent line shows the level: `max` segments, `level` of them lit, the rest dim; over the bar's own colour,
 * so the HMI's full line under it doesn't show through (one segment: the whole line, the wheel's on / off) */
const BAR_BG = [1, 4, 8], DIM_SEG = [150, 160, 172], SEG_GAP = 6;   // DIM_SEG: the grey for off / unlit, to match the car's own line
// the HMI's bars end in a slant, "/" (the top edge longer): each segment a parallelogram leaning right by SLANT px over
// the line's height (photo 2026-11-08: the cut ~0.4 of the bar's height)
const SLANT = 3;
/* a w x h parallelogram, top edge [s, w], bottom [0, w - s], edges anti-aliased, as a straight image */
function slantBar(w, h, s, rgb) {
    const data = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
        const t = h > 1 ? y / (h - 1) : 0, xl = s * (1 - t), xr = w - s * t;      // row y's span
        for (let x = 0; x < w; x++) {
            const cov = Math.max(0, Math.min(x + 1, xr) - Math.max(x, xl));
            if (cov <= 0) continue;
            const i = (y * w + x) * 4;
            data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; data[i + 3] = Math.round(255 * Math.min(1, cov));
        }
    }
    return { w, h, data };
}
// MASK_PAD: the near-black cover is this many px taller than our line, above and below, so the car's own accent line
// (a touch thicker, or a touch off) is hidden under ours rather than peeking out as a second line
const MASK_PAD = 4;
// EXT_MAX: the button is drawn on a wider surface with this much spare each side, so the accent line can be lengthened
// (lx) past the button into the car's own continuous line. DRAW_W is that surface; the button sits in its middle.
const EXT_MAX = 240;
// CONN: the accent line always runs this far left of the first segment (with a SEG_GAP gap), as a connector up to the
// car's own line; the Line tool's lx lengthens it further. Drawn in every state (grey when off), so the line never
// disappears.
const CONN = 40;
const drawW = (L) => L.buttonW + 2 * EXT_MAX;
/* draws into a drawW(L)-wide surface; the button occupies [EXT_MAX, EXT_MAX + buttonW). dlx: the line's extension,
 * negative left / positive right, past the button, to sit into the car's own line. */
function drawButton(px, L, kind, img, level, pressed, max, dy, dx, dly, dlx, dlhx) {
    const DW = drawW(L), BW = L.buttonW, bx = EXT_MAX, on = level > 0, rgb = kind === 'cool' ? BLUE : RED, ly = L.lineY + (dly | 0);
    // pressed: a soft box over the button, above its accent line, like the HMI's own
    if (pressed) blend(px, DW, bx + 4, 8, pill(BW - 8, ly - 14, 0, 14, 0.14), 1);
    if (img) {
        const cx = bx + BW / 2 + ICON_DX + (dx | 0);
        blend(px, DW, Math.round(cx - img.w / 2), Math.round(L.iconY + (dy | 0) - img.h / 2), tint(img, on ? rgb : DIM_SEG), 1);
    }
    // The segment track is always drawn, in every state (grey off, coloured on, black-masked gaps) - the wheel's own
    // on / off indicator line too. To the LEFT of the first segment there is NO coloured connector: that zone is painted
    // solid black (the mask, opaque - it covers the car's own line rather than going transparent and letting it show
    // through), up to a gap before the first segment. The Reach tool (lx) lengthens that black zone further left into the
    // car's line, or paints a coloured extension to the right. lhx (gbx) moves the whole block, apart from the icon.
    const lineCol = on ? rgb : DIM_SEG, lx = dlx | 0, gbx = bx + (dlhx | 0),
        leftExt = lx < 0 ? Math.min(EXT_MAX, -lx) : 0,
        connL = Math.max(0, gbx - SEG_GAP - Math.min(CONN + leftExt, DW)),
        rext = lx > 0 ? Math.min(EXT_MAX, lx, DW - (gbx + BW + SEG_GAP)) : 0,
        maskR = Math.min(DW, gbx + BW + (rext > 0 ? SEG_GAP + rext : 0));
    // the black mask has slanted "/" ends (same angle as the segments), so it keeps the car's own angled trail-off rather
    // than squaring it off
    const maskH = L.lineH + 2 * MASK_PAD, maskSl = Math.round(SLANT * (maskH - 1) / (L.lineH - 1));
    if (maskR > connL) blend(px, DW, connL, ly - MASK_PAD, slantBar(maskR - connL, maskH, maskSl, BAR_BG), 1);  // opaque black, angled ends, hides the car's line
    if (rext > 0) blend(px, DW, gbx + BW + SEG_GAP, ly, slantBar(rext, L.lineH, SLANT, lineCol), 1);  // coloured extension past the last segment
    const n = Math.max(1, max || 1), sw = (BW - (n - 1) * SEG_GAP) / n;
    for (let i = 0; i < n; i++) {
        const x0 = gbx + Math.round(i * (sw + SEG_GAP)), x1 = gbx + Math.round(i * (sw + SEG_GAP) + sw);
        blend(px, DW, x0, ly, slantBar(x1 - x0, L.lineH, SLANT, i < level ? rgb : DIM_SEG), 1);
    }
}
/* the "passenger heat on the left" blank: paints the bar's own colour over the car's heat icon and accent line at the
 * spot the relocated button left behind, so the OEM red is cancelled. Drawn into the same drawW surface as a button. */
function drawBlank(px, L) {
    const DW = drawW(L), BW = L.buttonW, bx = EXT_MAX, ly = L.lineY, ICON = 96;
    const maskH = L.lineH + 2 * MASK_PAD, maskSl = Math.round(SLANT * (maskH - 1) / (L.lineH - 1));
    const connL = Math.max(0, bx - SEG_GAP - CONN), maskR = Math.min(DW, bx + BW + SEG_GAP);
    blend(px, DW, connL, ly - MASK_PAD, slantBar(maskR - connL, maskH, maskSl, BAR_BG), 1);              // over the accent line (angled ends)
    blend(px, DW, Math.round(bx + BW / 2 - ICON / 2), Math.round(L.iconY - ICON / 2), slantBar(ICON, ICON, 0, BAR_BG), 1);   // over the icon
}

/* ---- the service ---- */
function main() {
    const { RenderClient, imageOp } = require(CLIENT);
    const conf = loadData(DATA);
    const L = Object.assign({}, LAYOUT, conf.layout || {});
    let slots = conf.slots, settings = conf.settings, mcar = conf.mcar, apps = installedApps(OAP);   // mcar: an M setup was seen
    const mEff = () => mcarOf(mcar, settings);       // an M car: the user's choice wins
    const SW = L.slotW, H = L.h, BW = L.buttonW, ICON_MAX = 76, HMI_PX = 84;
    const pics = {}, flash = Array(SLOTS).fill(0), looks = [], failAt = Array(SLOTS).fill(0), leftW = {};   // leftW[i]: a left slot's drawn icon width (0 = hidden)
    let notice = null;                                // the last tap that did nothing: { slot, title, at }
    const boot = { since: 0, hmiAt: 0, up: false, wake: false };    // BOOT: shown once up; wake = a sleep, not a cold boot
    const st = seats.state(!!process.env.OVERLAYS_SEAT_DEMO);
    const readAA = aa.reader();
    let aaNow = { connected: false, via: null, pid: null };
    const live = () => ({ aa: aaNow.connected });
    Object.assign(st.legacy.seen, conf.vents);
    let ventsSaved = JSON.stringify(st.legacy.seen);
    const pending = {};                               // pending['driver.heat'] = { level, until }
    const gpu = new RenderClient('carlm-overlays', { info: log, warn: log, error: log });
    const PIX = { 'driver.wheel': 6, 'driver.cool': 7, 'driver.heat': 8, 'passenger.cool': 9, 'passenger.heat': 10 };
    const BLANKPIX = 13;                              // the "passenger heat on the left" blank over the vacated spot
    const blankNow = () => (peeking() ? null : blankSpot(L, st, settings));

    function picture(ic, cb, max) {                   // a decoded, fitted picture; cached by file + mtime
        const file = ic.file || path.join(__dirname, 'icons', ic.builtin + '.png');
        let key = file;
        try { key += ':' + fs.statSync(file).mtime.getTime(); } catch (e) { return cb(null); }
        if (pics[key] !== undefined) return cb(pics[key]);
        let buf;
        try { buf = fs.readFileSync(file); } catch (e) { return cb(null); }
        png.decodeAsync(buf, (e, img) => {
            if (e) log(`icon ${file}: ${e.message}`);
            // an app's own picture (a full-bleed tile, 140-256 px): trimmed and shrunk to the strip's icon size; ours are drawn
            // at their final size already (icons/*.png, icons/lib/*.png)
            pics[key] = e ? null : ic.file ? png.fit(trim(img), APP_GLYPH) : png.fit(img, max || ICON_MAX);
            cb(pics[key]);
        });
    }
    const save = () => {
        try { saveData(DATA, Object.assign(conf.layout ? { layout: conf.layout } : {}, { slots, settings, mcar, learned, vents: st.legacy.seen })); } catch (e) { log('save: ' + e.message); }
    };
    function drawSlot(i) {
        if (i >= GRID) return drawLeftSlot(i);
        const ic = iconOf(slots[i], apps, live());
        looks[i] = JSON.stringify(ic);
        picture(ic, (img) => {
            const px = Buffer.alloc(SW * H * 4);
            const failed = failAt[i] + 1500 > Date.now();  // the tap did nothing: red for a moment
            const bg = failed ? 0.45 : flash[i] > Date.now() ? 0.4 : gestures.pressed() === i ? 0.18 : 0;
            if (bg) blend(px, SW, 0, 0, pill(SW, H, 10, 20, bg, failed ? RED : null), 1);
            if (img) blend(px, SW, (SW - img.w) >> 1, (H - img.h) >> 1, img, ic.missing ? 0.4 : 1);
            gpu.pixels(i + 1, [{ x: 0, y: 0, w: SW, h: H }], px);
            frame();
        });
    }
    // a left-zone icon: fitted to the icon height, any width (a wide logo stays wide); cached by file + mtime, apart from picture()'s box fit
    function leftPic(file, cb) {
        let key = file + ':h';
        try { key += fs.statSync(file).mtime.getTime(); } catch (e) { return cb(null); }
        if (pics[key] !== undefined) return cb(pics[key]);
        let buf; try { buf = fs.readFileSync(file); } catch (e) { return cb(null); }
        png.decodeAsync(buf, (e, img) => { if (e) log(`icon ${file}: ${e.message}`); pics[key] = e ? null : png.fitH(img, L.left.ih); cb(pics[key]); });
    }
    function drawLeftSlot(i) {
        const slot = slots[i], name = slot && iconName(slot.icon), pid = LEFTPIX[i - GRID], MW = L.left.maxw;
        if (!name) { leftW[i] = 0; return frame(); }                     // a left slot is shown only once it is given an icon
        looks[i] = JSON.stringify({ builtin: 'lib/' + name });
        leftPic(path.join(__dirname, 'icons', 'lib', name + '.png'), (img) => {
            const px = Buffer.alloc(MW * H * 4);
            if (img) {
                const w = Math.min(img.w, MW), y = (H - img.h) >> 1;
                const bg = flash[i] > Date.now() ? 0.4 : gestures.pressed() === i ? 0.18 : 0;
                if (bg) blend(px, MW, 0, (H - L.left.ih - 16) >> 1, pill(w + 16, L.left.ih + 16, 10, 20, bg), 1);
                blend(px, MW, (w - img.w) >> 1, y, img, 1);
                leftW[i] = w;
            } else leftW[i] = 0;
            gpu.pixels(pid, [{ x: 0, y: 0, w: MW, h: H }], px);
            frame();
        });
    }
    // the shown left slots, laid out left to right from the zone's x with a gap between (however many have an icon)
    function leftLayout() {
        if (!settings.shortcuts || peeking()) return [];
        const out = [];
        if (leftW[GRID]) out.push({ i: GRID, x: Math.round(L.left.cx - leftW[GRID] / 2), w: leftW[GRID] });   // the M, centred in the far-left zone
        const bm = blankSpot(L, st, settings);             // the heat spot freed by heatLeft: a shortcut, centred in that button cell, over the mask
        if (bm && leftW[GRID + 1]) out.push({ i: GRID + 1, x: Math.round(bm.x + (L.buttonW - leftW[GRID + 1]) / 2), w: leftW[GRID + 1] });
        return out;
    }
    const state = (key) => {                          // 'driver.heat' -> its { have, level, max }; 'driver.wheel' too
        const [seat, kind] = key.split('.');
        return kind === 'wheel' ? st.wheel : st.seats[seat][kind];
    };
    const shown = (key) => {                          // the level to show: the asked one until the car answers
        const p = pending[key], k = state(key);
        return p && p.until > Date.now() && p.level !== k.level ? p.level : k.level;
    };
    function drawButtonKey(key) {
        const [seat, kind] = key.split('.');
        // the HMI's icon for the spot it is drawn in (a right-hand drive car: the driver's buttons in the right-hand spots)
        picture({ builtin: kind === 'wheel' ? 'hmi-wheel' : `hmi-${kind}-${spotSeat(seat, settings.side)}` }, (img) => {
            const DW = drawW(L), px = Buffer.alloc(DW * H * 4);
            const a = alignOf(settings, key); drawButton(px, L, kind, img, shown(key), gestures.pressed() === key, state(key).max, a.y, a.ix, a.ly, a.lx, a.lhx);
            gpu.pixels(PIX[key], [{ x: 0, y: 0, w: DW, h: H }], px);
            frame();
        }, HMI_PX);
    }
    function drawBlankKey() {                          // the bar-colour cover over the vacated heat spot (heatLeft)
        const DW = drawW(L), px = Buffer.alloc(DW * H * 4);
        drawBlank(px, L);
        gpu.pixels(BLANKPIX, [{ x: 0, y: 0, w: DW, h: H }], px);
    }
    // "Show BMW's own" (the app's Align page): ours hidden PEEK_MS, the HMI's own buttons show and take the touches
    let peekUntil = 0, peekTimer = null;
    const peeking = () => Date.now() < peekUntil;
    const shownButtons = () => (peeking() ? [] : buttons(L, st, settings));
    const shownSlots = () => (settings.shortcuts ? L.slots : []);
    const draw = (k) => (typeof k === 'number' ? (k >= 0 ? drawSlot(k) : null) : drawButtonKey(k));
    function frame() {
        const ops = shownSlots().map((x, i) => imageOp(i + 1, x, 0, SW, H, 0));
        for (const b of shownButtons()) ops.push(imageOp(PIX[b.key], b.x - EXT_MAX, 0, drawW(L), H, 0));
        const bm = blankNow();
        if (bm) ops.push(imageOp(BLANKPIX, bm.x - EXT_MAX, 0, drawW(L), H, 0));   // the blank mask, under any heat-spot shortcut
        // the pixmap is maxw wide: draw it at that width (1:1, no scaling) so a narrow icon isn't squished; the claim
        // (claims()) stays the icon's own width l.w, so only that part takes touches and the rest shows the HMI through
        for (const l of leftLayout()) ops.push(imageOp(LEFTPIX[l.i - GRID], l.x, 0, L.left.maxw, H, 0));
        const all = new Uint32Array(ops.reduce((n, o) => n + o.length, 0));
        ops.reduce((at, o) => { all.set(o, at); return at + o.length; }, 0);
        gpu.frameWords(all);
    }
    function claims() {                               // the shortcuts and the buttons shown (none while booting)
        if (!boot.up) return gpu.claim([]);
        const cl = shownSlots().map((x) => ({ x, y: 0, w: SW, h: H }));
        for (const l of leftLayout()) cl.push({ x: l.x, y: 0, w: l.w, h: H });
        for (const b of shownButtons()) cl.push({ x: b.x - EXT_MAX, y: 0, w: drawW(L), h: H });
        const bm = blankNow();
        if (bm) cl.push({ x: bm.x - EXT_MAX, y: 0, w: drawW(L), h: H });   // claim the vacated spot so the mask draws and the dead OEM button takes no taps
        gpu.claim(cl);
    }
    function targetAt(x) {
        const i = shownSlots().findIndex((l) => x >= l && x < l + SW);
        if (i >= 0) return i;
        const l = leftLayout().find((o) => x >= o.x && x < o.x + o.w);
        if (l) return l.i;
        const b = shownButtons().find((c) => x >= c.x && x < c.x + BW);
        return b ? b.key : -1;
    }
    const redrawAll = () => {
        shownSlots().forEach((x, i) => drawSlot(i));
        for (let i = GRID; i < SLOTS; i++) drawLeftSlot(i);
        shownButtons().forEach((b) => drawButtonKey(b.key));
        if (blankNow()) drawBlankKey();
        claims(); frame();
    };

    /* hmictl serve: one line out, one line back, in order; "ev" lines are notifications */
    let child = null, out = '', busy = null, busyTimer = null;
    const queue = [];
    function hmi(line) { return new Promise((res) => { queue.push({ line, res }); pump(); }); }
    function pump() {
        if (busy || !queue.length) return;
        if (!child) {
            child = spawn(HMICTL, ['serve'], { stdio: ['pipe', 'pipe', 'inherit'] });
            child.on('error', (e) => log('hmictl: ' + e.message));
            child.stdin.on('error', (e) => log('hmictl: ' + e.message));   // it died with a line on its way (EPIPE)
            child.stdout.on('data', (d) => {
                out += d;
                for (let n; (n = out.indexOf('\n')) >= 0; out = out.slice(n + 1)) {
                    const line = out.slice(0, n);   // vsomeip may log to stdout too (under systemd): not ours
                    if (line.startsWith('ev ')) onEvent(line); else if (/^(ok|error)\b/.test(line)) done(line);
                }
            });
            child.on('exit', (c) => {
                log('hmictl exited ' + c); child = null; out = '';
                if (busy) done('error hmictl exited');
                setTimeout(subscribe, 2000);          // a new hmictl has no subscriptions
            });
        }
        busy = queue.shift();
        busyTimer = setTimeout(() => { if (child) child.kill(); }, 10000);
        child.stdin.write(busy.line + '\n');
    }
    function done(line) {
        clearTimeout(busyTimer);
        const b = busy; busy = null;
        if (b) b.res(line);
        pump();
    }
    function seatChanged(changed) {
        if (!changed) return;
        for (const k of Object.keys(pending)) {      // the car took (or refused) the asked level
            if (pending[k].level === state(k).level || pending[k].until <= Date.now()) delete pending[k];
        }
        if (JSON.stringify(st.legacy.seen) !== ventsSaved) { ventsSaved = JSON.stringify(st.legacy.seen); save(); }
        redrawAll();
        push();
    }
    function onEvent(line) {
        const w = line.split(' '), svc = parseInt(w[1], 16), ev = parseInt(w[2], 16);
        if (svc === MDRIVE && ev === shift.DME.ev) sl.dme(w[3]);
        else if (svc === MDRIVE) mSetup(ev, w[3]);
        else if (svc === VEHICLE2 && ev === KOMBI_EV) kombi(w[3]);
        else if (svc === VCOND && ev === VCOND_EV) { if (carOff(w[3]) && (m.sp18 || m.setup)) { log(`car off (${w[3]}): no M setup`); mReset(m); } }
        else if (svc === shift.RPM.svc && ev === shift.RPM.ev) sl.rpm(w[3]);
        else if (svc === shift.LIMIT.svc && ev === shift.LIMIT.ev) sl.limit(w[3]);
        else {
            const before = levels(), changed = seats.apply(st, svc, ev, w[3]), k = flashKind(KEYS, before, levels());
            if (k && settings.ambient && Date.now() > flashFrom) {
                ambientFlash(AMBIENT.byte(k === 'heat' ? settings.ambientHeat : settings.ambientCool));
            }
            seatChanged(changed);
        }
    }
    const KEYS = Object.keys(PIX), flashFrom = Date.now() + FLASH_AFTER_MS;
    const levels = () => KEYS.map((k) => (state(k).have ? state(k).level : 0));
    const amb = { orig: null, timer: null };
    async function ambientFlash(c) {                  // the colour for FLASH_MS, then the one read before
        if (!amb.orig) {
            const r = await hmi(AMBIENT.get), o = ambientColour(r.slice(3));
            if (!o) return;                               // off, or no answer: no flash
            if (!amb.orig) amb.orig = o;
        }
        clearTimeout(amb.timer);
        hmi(AMBIENT.set(c));
        amb.timer = setTimeout(() => {
            const o = amb.orig;
            amb.orig = null;
            hmi(AMBIENT.set(o)).then((r) => log(`ambient flash ${c} -> back to ${o}: ${r.split(' ')[0]}`));
        }, FLASH_MS);
    }

    /* shift lights in cluster-render's `guide` target and in `hud` (shiftlights.js), only on cars without their own: an
     * M car (an M setup seen, the DME's shift-light signal seen, or the user's choice) has its own in the cluster and the
     * HUD (a client's M2, 2026-11-05: ours over the map). Off or an M car: no rpm polling, no layer shown */
    const sl = (() => {
        const v = { rpm: 0, limit: null, dme: null, dmeAt: 0, seg: -1, flash: null, shown: {}, vis: { shown: false, lowSince: 0 },
            renderer: 'missing', layer: '', own: null };
        const own = () => mcarOf(mcar || v.dmeAt > 0, settings);
        const poll = () => hmi(settings.shift.on && !v.own ? shift.RPM.poll : shift.RPM.poll.replace(/ 50 /, ' 0 '));
        let cr = null;
        const layers = {};                            // target -> layer ref
        if (fs.existsSync(CLUSTER)) {
            try {
                const { ClusterRender } = require(CLUSTER);
                cr = new ClusterRender('carlm-overlays');
                Object.keys(shift.TARGETS).forEach((t) => {
                    const g = shift.TARGETS[t];
                    layers[t] = cr.effect({ target: t, klass: 'overlay', x: 0, y: 0, w: g.w, h: g.h, fs: shift.fs(g), time: true, visible: 0 });
                    cr.uniform(layers[t], 'u_seg', [0]); cr.uniform(layers[t], 'u_flash', [0]);
                });
                cr.on('layer', (ref, state, reason) => {
                    if (ref === layers.guide) { v.layer = state; push(); }
                    log(`shift lights: ${ref === layers.hud ? 'hud' : 'guide'} layer ${state}${reason ? ` (${reason})` : ''}`);
                });
                cr.on('target', (name, state, holder, reason) => log(`shift lights: target ${name} ${state}${reason ? ` (${reason})` : ''}`));
                cr.on('ready', () => { v.renderer = 'connected'; push(); });
                cr.on('disconnected', () => { v.renderer = 'not running'; push(); });
                cr.on('refused', (op, ref, reason) => { v.layer = `refused: ${reason}`; log(`shift lights: ${op} refused: ${reason}`); push(); });
                cr.connect();
                v.renderer = 'connecting';
            } catch (e) { log('shift lights: cluster-render client: ' + e.message); }
        } else log('shift lights: cluster-render is not installed');
        function update() {
            const s = settings.shift, now = Date.now(), th = shift.thresholds(s, v.limit);
            if (own() !== v.own) { v.own = own(); poll(); push(); }
            const l = v.dme && now - v.dmeAt < shift.DME_FRESH_MS ? v.dme : shift.lights(v.rpm, th);
            const near = s.on && !v.own && shift.visible(v.vis, v.rpm, th, l.seg, now);
            const shown = { guide: near, hud: near && s.hud };
            if (!cr) return;
            const all = (name, val) => Object.keys(layers).forEach((t) => cr.uniform(layers[t], name, [val]));
            if (l.seg !== v.seg) { v.seg = l.seg; all('u_seg', l.seg); }
            if (l.flash !== v.flash) { v.flash = l.flash; all('u_flash', l.flash ? 1 : 0); }
            Object.keys(layers).forEach((t) => {
                if (shown[t] !== v.shown[t]) { v.shown[t] = shown[t]; cr.set(layers[t], { visible: shown[t] ? 1 : 0 }); }
            });
        }
        return {
            rpm(hex) { const r = shift.rpmOf(hex); if (r !== null) { v.rpm = r; update(); } },
            limit(hex) { const l = shift.limitOf(hex); if (l !== v.limit) { v.limit = l; update(); push(); } },
            dme(hex) { const d = shift.dmeOf(hex); if (d) { v.dme = d; v.dmeAt = Date.now(); update(); } },
            settings() { v.own = own(); poll(); update(); },
            status: () => ({ renderer: v.renderer, layer: v.layer, limit: v.limit, dme: v.dmeAt > 0, own: own(), th: shift.thresholds(settings.shift, v.limit) }),
            tick: update,                             // the hysteresis' timeout
            close() { if (cr) cr.close(); },
        };
    })();
    const m = { sp21: false, setup: 0 };
    function mSetup(ev, hex) {                        // a setup on (also already on at start) -> its mode, off -> 'off'
        const s = mSetupOf(m, ev, hex, Date.now());
        if (s === null) return;
        if (!mcar || (m.sp21 && !m.told)) { mcar = true; m.told = m.sp21; save(); push(); }   // an M car (found)
        if (s === m.setup) return;
        m.setup = s;
        if (!settings.mmode.on || !mEff()) return;     // the user said: not an M car
        const mode = s === 0 ? settings.mmode.off : s === 1 ? settings.mmode.m1 : settings.mmode.m2;
        hmi(`mmode ${mode}`).then((r) => log(`M setup ${s} (0x${ev.toString(16)} ${hex}): mmode ${mode}: ${r}`));
    }
    const k = { up: false, view: null };
    function kombi(hex) {                             // Start in M SPORT (M cars): once the cluster is up, in its standard view
        const v = parseInt(hex.slice(0, 2), 16), up = clusterUp(k, hex);
        if (v !== k.view) { log(`cluster view ${k.view} -> ${v}`); k.view = v; }
        const start = settings.mmode.start;
        if (up === 1 && mEff() && MODES.indexOf(start) >= 0) hmi(`mmode ${start}`).then((r) => log(`cluster up: mmode ${start}: ${r}`));
    }
    function subscribe() {
        if (st.backend !== 'demo') seats.SUBS.forEach((l) => hmi(l));
        hmi(MDRIVE_SUB);
        hmi(KOMBI_SUB);
        hmi(VCOND_SUB);
        hmi(shift.LIMIT.sub);
        sl.settings();                                // the rpm poll (hmictl's own thread), when the shift lights are on
    }
    async function reread() {                         // the notifications keep it current; this is the safety net
        for (const g of seats.rereads(st)) {
            const r = await hmi(g.line);
            if (r.startsWith('ok ')) seatChanged(seats.apply(st, g.svc, g.ev, r.slice(3)));
        }
    }

    async function tap(i) {
        apps = installedApps(OAP);
        const s = slots[i], t = s.aa && !s.app ? aaTarget(s, aaNow.connected) : target(s, apps);
        if (!t) { log(`slot ${i}: ${s.app} is not installed`); return; }
        if (!s.app && t.state < 0) {                  // a screen not taught yet (Android Auto app or connect): ask for the hold
            failAt[i] = Date.now();
            const title = s.aa ? (aaNow.connected ? 'Android Auto' : 'Android Auto connection') : describe(s, apps).title;
            notice = { slot: i, title, at: failAt[i], learn: true };
            drawSlot(i); setTimeout(() => drawSlot(i), 1550);
            push();
            return;
        }
        const before = s.app ? null : await hmi('ctx');   // a BMW screen: did the tap change anything?
        let r = await hmi(`open ${t.state} ${t.applet}`);
        if (!s.app) {
            await new Promise((res) => setTimeout(res, FAIL_MS));
            const after = await hmi('ctx');
            if (stuck(before, after, t)) {
                const title = describe(s, apps).title;
                failAt[i] = Date.now();
                notice = { slot: i, title, at: failAt[i] };
                log(`slot ${i}: ${title} (${t.state} ${t.applet}) did not open: still ${after.slice(3)}`);
                drawSlot(i); setTimeout(() => drawSlot(i), 1550);
                push();
                return;
            }
        }
        if (r !== 'ok' && s.app) {                    // the other offset (appInfo): kept when it opens
            const other = OFFSETS.find((o) => o !== s.offset), alt = target(Object.assign({}, s, { offset: other }), apps);
            if (await hmi(`open ${alt.state} ${alt.applet}`) === 'ok') {
                log(`slot ${i}: ${s.app} opens at offset ${other}`);
                setSlot(i, Object.assign({}, s, { offset: other }));
                return;
            }
        }
        if (r !== 'ok' && s.app) {                    // not registered with the HMI yet: launch it, then again
            log(`slot ${i}: open ${t.state} ${t.applet}: ${r}, starting ${s.app}`);
            await hmi(`start ${s.app}`);
            await new Promise((res) => setTimeout(res, 2000));
            r = await hmi(`open ${t.state} ${t.applet}`);
        }
        log(`slot ${i}: open ${s.app || 'screen'} ${t.state} ${t.applet}: ${r}`);
    }
    function setSlot(i, s) {
        if (slots[i] && iconName(slots[i].icon) && s.icon === undefined) s = Object.assign({}, s, { icon: slots[i].icon });   // its icon stays
        slots[i] = s;
        save();
        log(`slot ${i}: saved ${JSON.stringify(s)}`);
        flash[i] = Date.now() + 1000;
        drawSlot(i);
        setTimeout(() => drawSlot(i), 1050);
        push();
    }
    async function hold(i) {
        const r = await hmi('ctx'), mm = /^ok (-?\d+) (-?\d+)/.exec(r);
        if (!mm) { log(`slot ${i}: no screen to save (${r})`); drawSlot(i); return; }
        apps = installedApps(OAP);
        const c = classify(+mm[1], +mm[2], apps), was = describe(slots[i], apps);
        // an Android Auto slot: a hold within the learn window teaches whichever of its two screens matches the phone now
        // - connected -> the app's own screen (opened when a phone is on); not connected -> the connect / setup screen
        if (slots[i].aa && !c.app && Date.now() - failAt[i] < REPAIR_MS) {
            const upd = Object.assign({}, slots[i]);
            if (aaNow.connected) { upd.state = c.state; upd.applet = c.applet; learned['Android Auto'] = { state: c.state, applet: c.applet }; }
            else upd.connect = { state: c.state, applet: c.applet };
            log(`slot ${i}: Android Auto ${aaNow.connected ? 'app screen' : 'connect screen'} is ${c.state} ${c.applet} on this car`);
            failAt[i] = 0;
            if (notice && notice.slot === i) notice = null;
            setSlot(i, upd);
            return;
        }
        // a hold soon after this slot's BMW screen did not open, on a screen we don't know: that screen's own ids here
        if (Date.now() - failAt[i] < REPAIR_MS && !slots[i].app && !c.app && was.title !== 'BMW screen' &&
            !screenList().some((x) => x.state === c.state && x.applet === c.applet) &&
            (was.title !== 'Android Auto' || aaNow.connected)) {      // Android Auto's screen only with a phone on it
            learned[was.title] = { state: c.state, applet: c.applet };
            log(`slot ${i}: ${was.title} is ${c.state} ${c.applet} on this car`);
            failAt[i] = 0;
            if (notice && notice.slot === i) notice = null;
        }
        setSlot(i, c);
    }
    async function buttonTap(key) {
        const [seat, kind] = key.split('.'), k = state(key);
        const level = kind === 'wheel' ? seats.next(shown(key), k.max) : nextLevel(shown(key), k.max, settings.order);
        pending[key] = { level, until: Date.now() + PENDING_MS };
        setTimeout(() => seatChanged(true), PENDING_MS + 50);     // nothing back: show the car's level again
        drawButtonKey(key);
        if (st.backend === 'demo') { k.level = level; push(); return; }
        const line = kind === 'wheel' ? seats.request(st, 'wheel', null, level) : seats.request(st, seat, kind, level);
        const r = line ? await hmi(line) : 'error no climate service';
        log(`${key} -> ${level}: ${r}`);
    }
    const gestures = new Gestures(targetAt, (k) => { draw(k); return typeof k === 'number' ? tap(k) : buttonTap(k); }, hold);

    /* the control panel (the Overlays app): JSON lines; every change is pushed to every client */
    const clients = new Set();
    let scanning = false;
    const rec = finder.recorder({ dir: path.dirname(CTL) });
    const has = (s) => ({ heat: s.heat.have, cool: s.cool.have });
    const status = () => ({ state: { settings, slots: slots.map((s) => describe(s, apps)),
        car: { backend: st.backend, seats: { driver: has(st.seats.driver), passenger: has(st.seats.passenger) }, wheel: st.wheel.have,
            mcar: mEff(), mfound: mcar, setups: m.sp21 ? 2 : 1 }, shift: sl.status(),
        notice: notice && Date.now() - notice.at < REPAIR_MS ? notice : null, peek: peeking(), aa: aaNow } });
    function push() { const l = JSON.stringify(status()) + '\n'; clients.forEach((c) => c.write(l)); }
    function targets() {
        apps = installedApps(OAP);
        const list = apps.filter((a) => a.tile && a.id !== SELF).map((a) => {
            const i = appInfo(a), ic = iconOf({ app: a.id }, apps);
            let pic = null;
            try { if (ic.file) pic = fs.readFileSync(ic.file).toString('base64'); } catch (e) { /* none */ }
            return i && Object.assign(i, { pic });
        }).filter(Boolean).sort((a, b) => a.title.localeCompare(b.title));
        return { targets: { bmw: screenList().map((s) => ({ title: s.title, state: s.state, applet: s.applet, icon: s.icon })), apps: list } };
    }
    function request(c, q) {
        if (q.op === 'set') {
            const was = settings.shift.on;
            settings = mergeSettings(settings, q.settings);
            save(); redrawAll(); push();
            if (settings.shift.on !== was) sl.settings(); else sl.tick();
        } else if (q.op === 'slot' && Number.isInteger(q.i) && q.i >= 0 && q.i < SLOTS && slotOk(q.target)) {
            const t = q.target, sl = t.app ? { app: t.app, state: t.state, offset: t.offset } : { state: t.state, applet: t.applet };
            const scr = !t.app && screenList().find((x) => x.state === t.state && x.applet === t.applet);
            if (scr && scr.title === 'Android Auto') { sl.aa = true; if (!iconName(slots[q.i].icon)) sl.icon = AA_LIVE; }   // two-screen AA slot + its live icon
            setSlot(q.i, sl);
            // a screen whose ids this car has not shown yet: ask for the hold that teaches them (the repair path)
            if (scr && scr.state < 0) {
                failAt[q.i] = Date.now();
                notice = { slot: q.i, title: scr.title, at: failAt[q.i], learn: true };
                log(`slot ${q.i}: ${scr.title} picked, its ids not known: waiting for a hold on it`);
                push();
            }
        } else if (q.op === 'icon' && Number.isInteger(q.i) && q.i >= 0 && q.i < SLOTS && (q.icon === null || iconName(q.icon))) {
            const sl = Object.assign({}, slots[q.i]);
            if (q.icon) sl.icon = q.icon; else delete sl.icon;
            slots[q.i] = sl;
            log(`slot ${q.i}: icon ${q.icon || 'default'}`);
            save(); drawSlot(q.i); push();
        } else if (q.op === 'peek') {
            peekUntil = q.on ? Date.now() + PEEK_MS : 0;
            if (peekTimer) clearTimeout(peekTimer);
            peekTimer = q.on ? setTimeout(() => { peekTimer = null; redrawAll(); push(); }, PEEK_MS + 50) : null;
            log(`peek ${q.on ? 'on' : 'off'}`);
            redrawAll(); push();
        } else if (q.op === 'record' && (q.phase === 'start' || q.phase === 'stop')) {
            // the Finder's Record: the files that change while the user flips "track my car" (read-only)
            const send = (m) => { const l = JSON.stringify({ finder: m }) + '\n'; clients.forEach((x) => x.write(l)); };
            if (q.phase === 'start') {
                send({ recording: 'quiet' });
                log('finder: recording, quiet window');
                rec.start((e, n) => { log(`finder: ${e ? e.message : `ready (${n} noisy files)`}`); send(e ? { error: e.message } : { recording: 'flip', noise: n }); });
            } else {
                send({ recording: 'listing' });
                rec.stop((e, r) => { log(`finder: ${e ? e.message : `${r.total} files changed`}`); send(e ? { error: e.message } : r); },
                    path.join(path.dirname(DATA), 'finder-record.txt'));
            }
        } else if (q.op === 'scan') {                  // the Finder page: read-only search of the unit's config files
            if (scanning) return;
            scanning = true;
            const send = (m) => { const l = JSON.stringify({ finder: m }) + '\n'; clients.forEach((x) => x.write(l)); };
            send({ scanning: true });
            log('finder: scanning');
            finder.scan((e, r) => {
                scanning = false;
                log(`finder: ${e ? e.message : `${r.total} lines`}`);
                send(e ? { error: e.message } : r);
            }, { file: path.join(path.dirname(DATA), 'finder.txt') });
        } else if (q.op === 'icons') {
            c.write(JSON.stringify({ icons: ICON_LIB.map(([name, title]) => {
                let pic = null;
                try { pic = fs.readFileSync(path.join(__dirname, 'icons', 'lib', name + '.png')).toString('base64'); } catch (e) { /* not installed */ }
                return { name, title, pic };
            }) }) + '\n');
        } else if (q.op === 'reset') {
            slots = defaults();
            save(); redrawAll(); push();
        } else if (q.op === 'targets') {
            c.write(JSON.stringify(targets()) + '\n');
        } else c.write(JSON.stringify(status()) + '\n');    // 'get' and anything else
    }
    function serve() {
        try { fs.unlinkSync(CTL); } catch (e) { /* none yet */ }
        const srv = net.createServer((c) => {
            clients.add(c);
            let buf = '';
            c.setEncoding('utf8');
            c.on('data', (d) => {
                buf += d;
                if (buf.length > 65536) { c.destroy(); return; }
                for (let n; (n = buf.indexOf('\n')) >= 0; buf = buf.slice(n + 1)) {
                    let q;
                    try { q = JSON.parse(buf.slice(0, n)); } catch (e) { continue; }
                    if (q && typeof q === 'object') request(c, q);
                }
            });
            c.on('error', () => {});
            c.on('close', () => clients.delete(c));
            c.write(JSON.stringify(status()) + '\n');
        });
        srv.on('error', (e) => log('control socket: ' + e.message));
        srv.listen(CTL, () => { try { fs.chmodSync(CTL, 0o666); } catch (e) { log('control socket: ' + e.message); } });   // the app's own uid
    }

    gpu.mode('layer');
    gpu.place({ x: L.x, y: L.y, w: L.w, h: L.h, scale: 1, ox: 0, oy: 0 });
    L.slots.forEach((x, i) => gpu.pixmap(i + 1, SW, H, 'rgba', 'linear'));
    LEFTPIX.forEach((p) => gpu.pixmap(p, L.left.maxw, H, 'rgba', 'linear'));
    Object.keys(PIX).forEach((k) => gpu.pixmap(PIX[k], drawW(L), H, 'rgba', 'linear'));
    gpu.pixmap(BLANKPIX, drawW(L), H, 'rgba', 'linear');   // the heatLeft blank mask (same surface as a button)
    /* boot (BOOT): hidden, claiming nothing, until AFTER_MS after the start with the HMI up; armed again after a sleep */
    function arm(why, since, wake) {
        Object.assign(boot, { since, hmiAt: 0, up: false, wake: !!wake });
        gpu.show(false);
        claims();
        log(`boot: strip hidden (${why}) until ${Math.round((wake ? BOOT.WAKE_AFTER_MS : BOOT.AFTER_MS) / 1000)} s after the start with the HMI up`);
    }
    function bootTick() {
        if (boot.up) return;
        if (!boot.hmiAt) hmi('ctx').then((r) => { if (!boot.hmiAt && /^ok -?\d+ -?\d+/.test(r)) { boot.hmiAt = Date.now(); log(`boot: HMI up (${r})`); } });
        const why = bootGate(Date.now(), boot);
        if (!why) return;
        boot.up = true;
        log(`boot: strip shown ${Math.round((Date.now() - boot.since) / 1000)} s after the start (${why})`);
        gpu.show(true);
        redrawAll();
    }
    gpu.on('ready', () => { log('renderer ready'); frame(); });
    gpu.on('touch', (phase, x) => {
        const before = gestures.pressed();
        gestures.touch(phase, x);
        if (gestures.pressed() !== before) [before, gestures.pressed()].forEach(draw);
    });
    gpu.on('closed', () => { if (boot.up) gpu.show(true); });   // a renderer without overlay_apps for us closes it on HMI touches
    redrawAll();
    subscribe();
    serve();
    setInterval(frame, 1000);                        // an app silent for 3 s is hidden
    setInterval(() => {                              // apps installed, updated or removed: new pictures
        apps = installedApps(OAP);
        slots.forEach((s, i) => { if (JSON.stringify(iconOf(s, apps, live())) !== looks[i] && settings.shortcuts) drawSlot(i); });
    }, 30000);
    setInterval(() => {                              // Android Auto connected or not: the "live" icon follows
        let r;
        try { r = readAA(); } catch (e) { return; }
        const was = aaNow.connected;
        aaNow = r;
        if (r.connected === was) return;
        log(`android auto: ${r.connected ? `connected (${r.via})` : 'not connected'}`);
        slots.forEach((s, i) => { if (s.icon === AA_LIVE && settings.shortcuts) drawSlot(i); });
        push();
    }, aa.POLL_MS);
    setInterval(reread, REREAD_MS);
    setInterval(sl.tick, 500);
    // the head unit slept (the car off) and woke: re-gate the strip and drop the M setup. Checked often (not every few
    // seconds) so the strip is hidden again within a fraction of a second of the wake, before it can sit on the black
    // screen while the HMI's home screen is still coming up.
    let tickAt = Date.now();
    setInterval(() => {
        const now = Date.now();
        if (now - tickAt >= WAKE_MS) {
            log(`woke up after ${Math.round((now - tickAt) / 1000)} s`);
            arm('woke up', now, true);                  // hide at once; shown again as soon as the HMI is up (no M animation on a wake)
            if (m.sp18 || m.setup) mReset(m);
        }
        tickAt = now;
    }, 250);
    process.on('SIGTERM', () => { gpu.close(); sl.close(); if (child) child.kill(); process.exit(0); });
    arm('start', bootedAt());
    setInterval(bootTick, 1000);
    gpu.connect();
    log(`overlays: ${JSON.stringify(slots)} ${JSON.stringify(settings)}${st.backend === 'demo' ? ', seats: demo' : ''}`);
}

/* ---- self-check: node overlays.js --test ---- */
function test() {
    const assert = require('assert');
    // boot: black screen (no HMI), the animation (HMI up), 15 s after the start with the HMI up; no HMI: the timeout
    const b0 = { since: 0, hmiAt: 0 }, hmiUp = { since: 0, hmiAt: 4000 };
    assert.deepStrictEqual([bootGate(5000, b0), bootGate(10000, hmiUp), bootGate(14999, hmiUp), bootGate(15000, hmiUp), bootGate(30000, b0),
        bootGate(60000, b0)], [null, null, null, 'HMI up', null, 'timeout']);
    // a wake from sleep: shown as soon as the HMI is up past a short floor, not after the full cold-boot delay
    const wUp = { since: 0, hmiAt: 500, wake: true }, wNo = { since: 0, hmiAt: 0, wake: true };
    assert.deepStrictEqual([bootGate(1499, wUp), bootGate(1500, wUp), bootGate(11999, wNo), bootGate(12000, wNo)], [null, 'HMI up', null, 'timeout']);
    const apps = [{ id: 'iteriodev_cardash', appletId: 20097 }, { id: 'robertn_store', appletId: 20650 }];
    assert.deepStrictEqual(classify(3000, 23097, apps), { app: 'iteriodev_cardash', state: 3000, offset: 3000 });
    assert.deepStrictEqual(classify(5, 20650, apps), { app: 'robertn_store', state: 5, offset: 0 });
    assert.deepStrictEqual(classify(24, 34, apps), { state: 24, applet: 34 });
    assert.deepStrictEqual(classify(1, 21097, apps), { state: 1, applet: 21097 });        // the tile's id, not a screen
    assert.deepStrictEqual(target({ app: 'iteriodev_cardash', state: 3000, offset: 3000 }, [{ id: 'iteriodev_cardash', appletId: 20111 }]),
        { state: 3000, applet: 23111 });                                                 // reinstalled under a new id
    assert.strictEqual(target({ app: 'gone', state: 1, offset: 0 }, apps), null);
    assert.deepStrictEqual(iconOf({ state: 20000, applet: 4 }, []), { builtin: 'home' });
    assert.deepStrictEqual(iconOf({ state: 20, applet: 4 }, []), { builtin: 'apps' });
    assert.deepStrictEqual(iconOf({ state: 9, applet: 77 }, []), { builtin: 'screen' });
    assert.deepStrictEqual(iconOf({ app: 'gone', state: 1, offset: 0 }, []), { builtin: 'app', missing: true });
    assert.deepStrictEqual(describe({ state: 1, applet: 32 }, []), { kind: 'bmw', title: 'Navigation', icon: 'Navigation' });
    assert.deepStrictEqual(describe({ state: 9, applet: 77 }, []), { kind: 'bmw', title: 'BMW screen', icon: 'Display' });
    assert.deepStrictEqual(describe({ app: 'gone', state: 1, offset: 0 }, []), { kind: 'app', app: 'gone', title: 'gone', missing: true });
    // a slot's own icon: wins over its picture (dimmed when its app is gone), unknown names ignored, kept in describe()
    assert.deepStrictEqual(iconOf({ state: 2, applet: 23, icon: 'android-auto' }, []), { builtin: 'lib/android-auto' });
    assert.deepStrictEqual(iconOf({ app: 'gone', state: 1, offset: 0, icon: 'media' }, []), { builtin: 'lib/media', missing: true });
    assert.deepStrictEqual(iconOf({ state: 2, applet: 23, icon: 'nope' }, []), { builtin: 'media' });
    assert.strictEqual(describe({ state: 2, applet: 23, icon: 'waze' }, []).own, 'waze');
    // Android Auto in the picker: its ids not known (-1) until a hold teaches them; its picture the white AA icon
    const aaScreen = SCREENS.find((x) => x.title === 'Android Auto');
    assert.deepStrictEqual([aaScreen.state, aaScreen.applet, describe({ state: -1, applet: -1 }, []).title, iconOf({ state: -1, applet: -1 }, []).builtin],
        [-1, -1, 'Android Auto', 'lib/android-auto']);
    assert(slotOk({ state: -1, applet: -1 }), 'a slot waiting to be taught is a good slot');
    // "Android Auto live": the colour one while connected, the white one while not
    const aaSlot = { state: 2, applet: 23, icon: AA_LIVE };
    assert.deepStrictEqual([iconOf(aaSlot, [], { aa: true }).builtin, iconOf(aaSlot, [], { aa: false }).builtin, iconOf({ state: 2, applet: 23, icon: AA_OFF }, [], { aa: true }).builtin],
        ['lib/android-auto-color', 'lib/android-auto', 'lib/android-auto']);
    assert.strictEqual(describe({ state: 2, applet: 23, icon: 'nope' }, []).own, undefined);
    // two-screen Android Auto: a tap picks the app screen when a phone is on, else the connect screen (−1 = not taught yet)
    const aaTwo = { aa: true, state: 500, applet: 7, connect: { state: 20, applet: 4 } };
    assert.deepStrictEqual(aaTarget(aaTwo, true), { state: 500, applet: 7 }, 'connected: the app screen');
    assert.deepStrictEqual(aaTarget(aaTwo, false), { state: 20, applet: 4 }, 'not connected: the connect screen');
    assert.deepStrictEqual(aaTarget({ aa: true, state: 500, applet: 7 }, false), { state: -1, applet: -1 }, 'connect not taught: prompt the hold');
    // describe keeps an AA slot an AA slot and reports whether its connect screen is set
    assert.deepStrictEqual([describe(aaTwo, []).aa, describe(aaTwo, []).connect, describe(aaTwo, []).title], [true, true, 'Android Auto']);
    assert.strictEqual(describe({ aa: true, state: 500, applet: 7 }, []).connect, false, 'no connect screen yet');
    ICON_LIB.forEach(([n]) => assert(fs.existsSync(path.join(__dirname, 'icons', 'lib', n + '.png')), `icons/lib/${n}.png`));
    // buttons: only what the car has and the settings allow, in the HMI's spots
    const keys = (st, set) => buttons(LAYOUT, st, set).map((b) => b.key + '@' + b.x).join(' ');
    const all = seats.state(true);
    // a zeroed-align baseline, so the position tests don't move with the baked-in per-button defaults
    const Z = ALIGN_KEYS.reduce((o, k) => { o[k] = { x: 0, ix: 0, y: 0, ly: 0, lx: 0, lhx: 0 }; return o; }, {}), S0 = mergeSettings(SETTINGS, { align: Z });
    // the baked-in defaults (Carl's measured offsets) are there on a fresh install
    assert.deepStrictEqual([mergeSettings(SETTINGS, {}).align['driver.heat'], mergeSettings(SETTINGS, {}).align['passenger.heat'], mergeSettings(SETTINGS, {}).align['driver.wheel']],
        [{ x: 36, ix: 0, y: -1, ly: 0, lx: 0, lhx: 0 }, { x: 12, ix: 0, y: -1, ly: 1, lx: 0, lhx: 0 }, { x: -40, ix: 0, y: 0, ly: 0, lx: 0, lhx: 0 }], 'baked-in defaults');
    assert.strictEqual(keys(all, S0), 'driver.wheel@20 driver.cool@246 driver.heat@888 passenger.cool@1844 passenger.heat@2486');
    const heatOnly = seats.state(false);
    heatOnly.seats.driver.heat.have = heatOnly.seats.passenger.heat.have = true;
    assert.strictEqual(keys(heatOnly, S0), 'driver.heat@888 passenger.heat@2486');
    // "passenger heat on the left": the far-right heat button (here passenger.heat@2486) is redrawn at heatLeftX; its
    // old spot is reported for the blank mask. By position, so right-hand drive (driver.heat@2486) relocates the same way.
    const hl = mergeSettings(S0, { heatLeft: true });
    assert.strictEqual(keys(heatOnly, hl), 'driver.heat@888 passenger.heat@190', 'the passenger heat moves left, the driver stays');
    assert.deepStrictEqual(blankSpot(LAYOUT, heatOnly, hl), { x: 2486 }, 'LHD: its old spot (2486) is blanked');
    const hlR = mergeSettings(S0, { heatLeft: true, side: 'right' });
    assert.strictEqual(keys(heatOnly, hlR), 'driver.heat@2486 passenger.heat@190', 'RHD: the passenger (left) heat moves, the driver (right) stays put');
    assert.deepStrictEqual(blankSpot(LAYOUT, heatOnly, hlR), { x: 888 }, 'RHD: the passenger spot (888) is blanked, not the driver');
    assert.strictEqual(blankSpot(LAYOUT, heatOnly, S0), null, 'off by default');
    assert.strictEqual(keys(all, mergeSettings(S0, { seats: false })), 'driver.wheel@20');
    assert.strictEqual(keys(all, mergeSettings(S0, { wheel: false, seats: 'no' })), 'driver.cool@246 driver.heat@888 passenger.cool@1844 passenger.heat@2486');
    // a right-hand drive car: the driver's buttons in the right-hand spots, the passenger's left, the wheel at the far right
    const rhd = mergeSettings(S0, { side: 'right' });
    assert.strictEqual(keys(all, rhd), 'driver.wheel@2740 driver.cool@1844 driver.heat@2486 passenger.cool@246 passenger.heat@888');
    assert.deepStrictEqual([spotSeat('driver', 'right'), spotSeat('passenger', 'right'), spotSeat('driver', 'left')], ['passenger', 'driver', 'driver']);
    assert.strictEqual(mergeSettings(rhd, { side: 'middle' }).side, 'right', 'a bad side: kept');
    // alignment: per button plus 'all', x moves the button (kept on the bar), clamped; partial updates keep the other axis
    const al = mergeSettings(S0, { align: { 'driver.heat': { x: 7, y: -3 }, all: { x: -2 }, 'passenger.cool': { x: 999, y: 'no' }, bogus: { x: 1 } } });
    assert.deepStrictEqual([al.align['driver.heat'], al.align.all, al.align['passenger.cool'], al.align.bogus], [{ x: 7, ix: 0, y: -3, ly: 0, lx: 0, lhx: 0 }, { x: -2, ix: 0, y: 0, ly: 0, lx: 0, lhx: 0 }, { x: 120, ix: 0, y: 0, ly: 0, lx: 0, lhx: 0 }, undefined]);
    assert.deepStrictEqual(alignOf(al, 'driver.heat'), { x: 5, ix: 0, y: -3, ly: 0, lx: 0, lhx: 0 });
    assert.strictEqual(keys(heatOnly, al), 'driver.heat@893 passenger.heat@2484');
    assert.deepStrictEqual(mergeSettings(al, { align: { 'driver.heat': { y: 4 } } }).align['driver.heat'], { x: 7, ix: 0, y: 4, ly: 0, lx: 0, lhx: 0 });
    assert.strictEqual(keys(all, mergeSettings(S0, { align: { 'driver.wheel': { x: -100 } } })).split(' ')[0], 'driver.wheel@0', 'kept on the bar');
    assert.deepStrictEqual(mergeSettings(SETTINGS, {}).align.all, { x: 0, ix: 0, y: 0, ly: 0, lx: 0, lhx: 0 }, 'defaults: centred');
    // ly: the accent line's own vertical offset (onto the car's line), clamped
    assert.deepStrictEqual([mergeSettings(SETTINGS, { align: { 'driver.heat': { ly: 9 } } }).align['driver.heat'].ly, mergeSettings(SETTINGS, { align: { all: { ly: 999 } } }).align.all.ly], [9, 24]);
    const ia = mergeSettings(S0, { align: { all: { ix: 2 }, 'driver.heat': { ix: -7 }, 'driver.cool': { ix: 99 } } });
    assert.deepStrictEqual([alignOf(ia, 'driver.heat').ix, alignOf(ia, 'driver.cool').ix, keys(heatOnly, ia)], [-5, 40, 'driver.heat@888 passenger.heat@2486'],
        'ix: the icon alone, the button stays');
    // start-up M Mode: the car's own by default; road / sport / track; the old switch (boot) carried over; nonsense kept out
    assert.deepStrictEqual([SETTINGS.mmode.start, mergeSettings(SETTINGS, { mmode: { start: 'track' } }).mmode.start,
        mergeSettings(SETTINGS, { mmode: { boot: true } }).mmode.start, mergeSettings(SETTINGS, { mmode: { start: 'warp' } }).mmode.start,
        'boot' in mergeSettings(SETTINGS, { mmode: { boot: true } }).mmode], ['car', 'track', 'sport', 'car', false]);
    // settings: known keys of the right kind only
    const s2 = mergeSettings(SETTINGS, { order: 'down', mmode: { m2: 'track', off: 'warp', on: false, boot: 1 }, extra: 1, shortcuts: 0,
        ambientHeat: 4, ambientCool: 13 });
    assert.deepStrictEqual(s2, { shortcuts: true, seats: true, wheel: true, ambient: true, heatLeft: false, ambientHeat: 4, ambientCool: 9, order: 'down', side: 'left',
        show: SETTINGS.show, align: SETTINGS.align, mmode: { on: false, m1: 'sport', m2: 'track', off: 'road', start: 'car', car: 'auto' },
        shift: shift.DEFAULTS });
    // per-button choice: 'on' shows what the car doesn't report, 'off' hides what it does (an M2 without ventilation that
    // reports it: the client's car, 2026-11-04); bad values are ignored
    const s3 = mergeSettings(S0, { show: { 'driver.cool': 'off', 'passenger.cool': 'off', 'driver.wheel': 'maybe', x: 'on' } });
    assert.strictEqual(keys(all, s3), 'driver.wheel@20 driver.heat@888 passenger.heat@2486');
    assert.strictEqual(keys(heatOnly, mergeSettings(S0, { show: { 'driver.wheel': 'on', 'passenger.heat': 'off' } })), 'driver.wheel@20 driver.heat@888');
    // the old master switches: off -> that group 'off', switches back on (the app no longer shows them); new files keep theirs
    const mg = migrate(mergeSettings(SETTINGS, { seats: false, wheel: true }), { seats: false, wheel: true });
    assert.deepStrictEqual([mg.seats, mg.wheel, mg.show['driver.heat'], mg.show['passenger.cool'], mg.show['driver.wheel']], [true, true, 'off', 'off', 'auto']);
    assert.strictEqual(migrate(mergeSettings(SETTINGS, { seats: false, show: {} }), { seats: false, show: {} }).seats, false);
    // M car: the user's choice wins over what was found
    const car = (c) => mergeSettings(SETTINGS, { mmode: { car: c } });
    assert.deepStrictEqual([mcarOf(false, car('auto')), mcarOf(true, car('auto')), mcarOf(false, car('yes')), mcarOf(true, car('no')), mcarOf(false, car('nope'))],
        [false, true, true, false, false]);
    // a tap that did nothing: the screen before and after the same and not the asked one
    const nav = { state: 1, applet: 32 };
    assert.deepStrictEqual([stuck('ok 20000 4', 'ok 20000 4', nav), stuck('ok 20000 4', 'ok 1 32', nav), stuck('ok 1 32', 'ok 1 32', nav),
        stuck('ok 20000 4', 'ok 2 23', nav), stuck('error timeout', 'ok 20000 4', nav)], [true, false, false, false, false]);
    // a screen learned under its name: the app offers it there, a slot with those ids is that screen, Restore uses it
    learned = { Navigation: { state: 7, applet: 91 } };
    assert.deepStrictEqual(describe({ state: 7, applet: 91 }, []), { kind: 'bmw', title: 'Navigation', icon: 'Navigation' });
    assert.deepStrictEqual(iconOf({ state: 7, applet: 91 }, []), { builtin: 'nav' });
    assert.deepStrictEqual(defaults()[1], { state: 7, applet: 91 });
    learned = {};
    // 5 grid slots, then the M (shown), then the heat-spot slot (empty: hidden until given an icon)
    assert.deepStrictEqual(defaults(), [{ state: 2, applet: 23 }, { state: 1, applet: 32 }, { state: 24, applet: 34 }, { state: 20, applet: 4 }, { state: 20000, applet: 4 },
        { state: 20000, applet: 4, icon: 'm-color' }, { state: 20000, applet: 4 }]);
    assert.strictEqual(defaults().length, SLOTS, 'seven default slots');
    assert.deepStrictEqual(mergeSettings(SETTINGS, { shift: { on: false, flash: 7000 } }).shift, { on: false, auto: true, start: 4500, flash: 7000, hud: true });
    assert.strictEqual(SETTINGS.order, 'up', 'defaults untouched');
    // taps: up 1 -> 2 -> 3 -> off, down 3 -> 2 -> 1 -> off
    assert.deepStrictEqual([0, 1, 2, 3].map((l) => nextLevel(l, 3, 'up')), [1, 2, 3, 0]);
    assert.deepStrictEqual([0, 3, 2, 1].map((l) => nextLevel(l, 3, 'down')), [3, 2, 1, 0]);
    // M setups, SP18 as the G82 sends them (2026-11-03 capture): entering M1 (double press, DSC off) = an EIN frame with
    // M1's settings and at once AUS; leaving (one press) = EIN with the normal settings and AUS: EIN toggles, AUS and
    // repeats within a second don't count
    const ms = { sp21: false };
    const ENTER = '01010302020202020000010001', LEAVE = '01010202010101010000010000', IDLE = '00000002000000000000000003';
    const CAR = '01000202010101010000010000', CAR2 = '01000002000000000000000003';   // EIN frames not from the M buttons
    assert.deepStrictEqual([mSetupOf(ms, 0x8001, IDLE, 0), mSetupOf(ms, 0x8001, CAR, 5000), mSetupOf(ms, 0x8001, ENTER, 15000),
        mSetupOf(ms, 0x8001, IDLE, 15010), mSetupOf(ms, 0x8001, ENTER, 15500), mSetupOf(ms, 0x8001, CAR2, 20000), mSetupOf(ms, 0x8001, CAR, 22000),
        mSetupOf(ms, 0x8001, LEAVE, 27000), mSetupOf(ms, 0x8001, IDLE, 27010), mSetupOf(ms, 0x8001, '02', 30000), mSetupOf(ms, 0x8001, '01', 31000)],
        [null, null, 1, null, null, null, null, 0, null, null, null]);
    // the car switched off in M1: the next press enters again (not leaving); VehicleCondition byte 5
    const mo = { sp21: false };
    assert.deepStrictEqual([mSetupOf(mo, 0x8001, ENTER, 1000), (mReset(mo), mSetupOf(mo, 0x8001, ENTER, 9000)), mSetupOf(mo, 0x8001, LEAVE, 12000)], [1, 1, 0]);
    assert.deepStrictEqual(['00000000000502', '00000000000a02', '00000000000202', '00000000000c02', ''].map(carOff), [true, false, true, false, false]);
    // ambient flash: off -> on only; heat / wheel 'heat', ventilation 'cool', heat wins; the colour only while it is on;
    // the menu's 3rd colour = byte 02
    const K = ['driver.wheel', 'driver.cool', 'driver.heat', 'passenger.cool', 'passenger.heat'];
    assert.deepStrictEqual([flashKind(K, [0, 0, 0, 0, 0], [0, 2, 0, 0, 0]), flashKind(K, [0, 0, 0, 0, 0], [0, 0, 0, 0, 3]),
        flashKind(K, [0, 0, 0, 0, 0], [1, 0, 0, 0, 0]), flashKind(K, [0, 0, 0, 0, 0], [0, 1, 0, 1, 2]),
        flashKind(K, [0, 1, 0, 0, 0], [0, 2, 0, 0, 0]), flashKind(K, [0, 0, 2, 0, 0], [0, 0, 0, 0, 0])], ['cool', 'heat', 'heat', 'heat', null, null]);
    assert.deepStrictEqual([ambientColour('00000602fffffa010001'), ambientColour('00000602fffffa000001'), ambientColour(''),
        ambientColour('rror service 0xb512.1 not there')], ['06', null, null, null]);
    assert.deepStrictEqual([AMBIENT.byte(SETTINGS.ambientHeat), AMBIENT.byte(SETTINGS.ambientCool), AMBIENT.byte(12)], ['02', '08', '0b']);
    assert.strictEqual(AMBIENT.set(AMBIENT.byte(3)), 'call 0xb512 1 26 1 0fff02ffffffff030303');
    // the cluster comes up: its first filled-in view counts once, again after 15 (not filled in)
    const kb = { up: false };
    assert.deepStrictEqual(['0f', '01', '01', '02', '0f', '0f', '02', '01', '00', '01'].map((h) => clusterUp(kb, h)),
        [null, 1, null, null, null, null, 2, null, null, 1]);
    // SP21 (0 none, 1 M1, 2 M2) is a state and wins once seen; other fields -> null
    assert.deepStrictEqual([mSetupOf(ms, 0x8018, '0201', 40000), mSetupOf(ms, 0x8001, ENTER, 50000), mSetupOf(ms, 0x8018, '00', 50000),
        mSetupOf(ms, 0x8018, '03', 50000), mSetupOf(ms, 0x8005, '01', 50000)], [2, null, 0, null, null]);
    // gestures: tap, hold, slide off, nothing; a button key taps but never holds
    let timers = [], ev = [];
    const T = { set: (f) => { timers.push(f); return f; }, clear: (f) => { timers = timers.filter((x) => x !== f); } };
    const at = (x) => (x < 150 ? 0 : x >= 650 && x < 800 ? 2 : x >= 2750 ? 'passenger.heat' : -1);
    const g = new Gestures(at, (i) => ev.push('tap' + i), (i) => ev.push('hold' + i), T);
    g.touch('down', 10); assert.strictEqual(g.pressed(), 0); g.touch('up', 12);
    g.touch('down', 700); timers.shift()(); g.touch('up', 700);
    g.touch('down', 10); g.touch('move', 400); g.touch('up', 10);
    g.touch('down', 400); g.touch('up', 400);
    g.touch('down', 2800); assert.strictEqual(timers.length, 0); g.touch('up', 2801);
    assert.deepStrictEqual(ev, ['tap0', 'hold2', 'tappassenger.heat']);
    // a button: off = grey icon + grey line; on = coloured icon + red / blue on the connector and lit segments; the line
    // (connector + segment track) is always drawn, in every state
    const icon = { w: 10, h: 10, data: Buffer.alloc(400, 255) };
    const DWt = LAYOUT.buttonW + 2 * EXT_MAX;
    const btn = (kind, level, max, lx, lhx) => { const px = Buffer.alloc(DWt * LAYOUT.h * 4); drawButton(px, LAYOUT, kind, icon, level, false, max, 0, 0, 0, lx || 0, lhx || 0); return px; };
    const at4 = (px, x, y) => Array.from(px.slice((y * DWt + EXT_MAX + x) * 4, (y * DWt + EXT_MAX + x) * 4 + 4));   // x is button-relative
    const heatOn = btn('heat', 2, 3), coolOn = btn('cool', 1, 3), heatOff = btn('heat', 0, 3), wheelOn = btn('wheel', 1, 1);
    const lineBottom = LAYOUT.lineY + LAYOUT.lineH - 1;
    assert.deepStrictEqual(at4(heatOn, 0, lineBottom), RED.concat(255), 'heat on: red line from the button\'s left (bottom row)');
    // the slant "/": top row starts SLANT px in and runs to the segment's end, the bottom row the other way round
    assert.deepStrictEqual([at4(heatOn, 0, LAYOUT.lineY), at4(heatOn, 35, LAYOUT.lineY), at4(heatOn, 35, lineBottom)],
        [BAR_BG.concat(255), RED.concat(255), BAR_BG.concat(255)], 'segments lean right like the HMI\'s bars');
    // left of the first segment: no coloured connector - that zone is solid black (opaque, hides the car's line), not red
    assert.deepStrictEqual(at4(btn('heat', 2, 3, 0), -40, LAYOUT.lineY), BAR_BG.concat(255), 'left zone: opaque black, not a coloured line');
    assert.notDeepStrictEqual(at4(btn('heat', 2, 3, 0), -40, LAYOUT.lineY), [0, 0, 0, 0], 'left zone: opaque (not transparent - would show the car\'s line)');
    assert.deepStrictEqual(at4(btn('heat', 2, 3, -80), -40, LAYOUT.lineY), BAR_BG.concat(255), 'reach left: black zone extends, still opaque');
    assert.deepStrictEqual(at4(btn('cool', 1, 3, 60), LAYOUT.buttonW + 30, lineBottom), BLUE.concat(255), 'reach right: blue extension past the button');
    // lhx: moves the whole line block right, apart from the icon - a segment now sits where there was nothing before
    assert.deepStrictEqual([at4(heatOn, 150, lineBottom), at4(btn('heat', 2, 3, 0, 60), 150, lineBottom)], [[0, 0, 0, 0], DIM_SEG.concat(255)], 'lhx: the line block moves right');
    // the level: 3 segments of 36 px, 6 px apart (0-35, 42-77, 84-119); the gaps the bar's colour (the HMI's line hidden)
    assert.deepStrictEqual([at4(heatOn, 50, LAYOUT.lineY), at4(heatOn, 100, LAYOUT.lineY), at4(heatOn, 38, LAYOUT.lineY)],
        [RED.concat(255), DIM_SEG.concat(255), BAR_BG.concat(255)], 'heat 2 of 3: two red segments, one dim');
    assert.deepStrictEqual([at4(coolOn, 0, LAYOUT.lineY + 5), at4(coolOn, 60, LAYOUT.lineY)], [BLUE.concat(255), DIM_SEG.concat(255)], 'vent 1 of 3');
    assert.deepStrictEqual([at4(wheelOn, 60, LAYOUT.lineY), at4(wheelOn, 60, LAYOUT.iconY)], [RED.concat(255), RED.concat(255)], 'the wheel: its own indicator line + icon');
    // off: the segment track stays, drawn grey, and the icon goes grey - nothing disappears; the left zone is black
    assert.deepStrictEqual(at4(heatOff, -40, LAYOUT.lineY), BAR_BG.concat(255), 'off: left zone still opaque black');
    assert.deepStrictEqual([at4(heatOff, 50, LAYOUT.lineY), at4(heatOff, 38, LAYOUT.lineY)], [DIM_SEG.concat(255), BAR_BG.concat(255)], 'off: grey segments, black gaps');
    assert.deepStrictEqual(at4(heatOn, 60, LAYOUT.iconY), RED.concat(255), 'heat icon centred over its line (60)');
    assert.deepStrictEqual(at4(heatOff, 60, LAYOUT.iconY), DIM_SEG.concat(255), 'off: grey icon');
    assert.deepStrictEqual(at4(coolOn, 60, LAYOUT.iconY), BLUE.concat(255), 'vent icon centred too');
    assert.deepStrictEqual(at4(coolOn, 84, LAYOUT.iconY), [0, 0, 0, 0], '... not off to the right');
    // an app's picture: its empty border trimmed, then no bigger than APP_GLYPH
    const tile = { w: 140, h: 140, data: new Uint8Array(140 * 140 * 4) };
    for (let y = 10; y < 130; y++) for (let x = 20; x < 120; x++) tile.data[(y * 140 + x) * 4 + 3] = 255;
    const tt = trim(tile), tf = png.fit(tt, APP_GLYPH);
    assert.deepStrictEqual([tt.w, tt.h, tf.w, tf.h], [100, 120, 37, APP_GLYPH]);
    // the shortcut icons are drawn at their final size: 76 px (no scaling, no blur), the glyph about the car's own. A
    // wide left-zone logo (m-color) is the exception: any width, fitted to the icon height at draw time
    ICON_LIB.forEach(([n]) => { const im = png.decode(fs.readFileSync(path.join(__dirname, 'icons', 'lib', n + '.png'))); assert(im.h <= 84 && (n === 'm-color' || im.w <= 84), n); });
    assert.deepStrictEqual([png.fitH({ w: 238, h: 84, data: new Uint8Array(238 * 84 * 4) }, 76).w, png.fitH({ w: 40, h: 40, data: new Uint8Array(40 * 40 * 4) }, 76).w], [215, 40], 'fitH: wide to its height, small left alone');
    const p = pill(150, 120, 10, 20, 1);
    assert.strictEqual(p.data[(60 * 150 + 75) * 4 + 3], 255); assert.strictEqual(p.data[3], 0);
    seats.test();
    aa.test();
    assert.deepStrictEqual(finder.lines('/etc/a.json:3:  "privacy": 1\n/var/opt/carlm-overlays/b:1: privacy\n'), ['/etc/a.json:3: "privacy": 1']);
    shift.test();
    console.log('overlays self-check ok');
}

if (process.argv[2] === '--test') test(); else main();
