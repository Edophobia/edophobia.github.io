// Outlierphobia — personal YouTube outlier finder.
// Data: public YouTube data via the user's own API key (YouTube Data API v3).
// Account data (folders, channels, saves, key) lives in Firebase (Google sign-in) per user.
// Video data is cached per device in IndexedDB and refreshed on every open.

import { FIREBASE_CONFIG } from './config.js';

const API = 'https://www.googleapis.com/youtube/v3/';
const PAGE = 30;
const RECENT_DAYS = 60;          // views on videos younger than this are refreshed on every open
const FULL_REFRESH_MS = 24 * 3600e3; // all other view counts once a day
const NEIGHBORS = 7;             // 7 uploads before + 7 after
const MIN_AGE_DAYS = 1;          // uploads younger than this are not used as comparison
const CONCURRENCY = 4;
const DAY = 86400e3;

const $ = id => document.getElementById(id);
const LOCAL = !FIREBASE_CONFIG || new URLSearchParams(location.search).has('local');

// ---------------------------------------------------------------- small utils
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const uid = () => Math.random().toString(36).slice(2, 10);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function num(n) {
  if (n == null || isNaN(n)) return '–';
  const a = Math.abs(n);
  const f = (x, s) => (x >= 100 ? Math.round(x) : x >= 10 ? +x.toFixed(1) : +x.toFixed(1)).toString().replace(/\.0$/, '') + s;
  if (a >= 1e9) return f(n / 1e9, 'B');
  if (a >= 1e6) return f(n / 1e6, 'M');
  if (a >= 1e3) return f(n / 1e3, 'K');
  return String(Math.round(n));
}
function dur(s) {
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = Math.floor(s % 60);
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
}
const ageDays = p => (Date.now() - p) / DAY;
function ago(p) {
  const d = ageDays(p);
  const u = (n, w) => n + ' ' + w + (n === 1 ? '' : 's') + ' ago';
  if (d < 1) return u(Math.max(1, Math.round(d * 24)), 'hour');
  if (d < 14) return u(Math.floor(d), 'day');
  if (d < 60) return u(Math.floor(d / 7), 'week');
  if (d < 365) return u(Math.floor(d / 30.44), 'month');
  return u(Math.floor(d / 365.25), 'year');
}
function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function isoDur(s) {
  const m = (s || '').match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  return m ? (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0) : 0;
}
let toastT;
function toast(msg, ms = 3500) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, ms);
}

// ---------------------------------------------------------------- growth curve
// Share of a long-form video's 2-month views it has at a given age (days).
// Day 1 / 7 / 30 / 60 points are from the Outlier Filter extension; the rest is interpolated.
const CURVE = [[0, 0], [1, 0.25], [7, 0.64], [30, 0.86], [60, 1.0], [180, 1.12], [365, 1.2], [730, 1.27], [1825, 1.35], [3650, 1.4]];
function growth(d) {
  d = Math.max(d, MIN_AGE_DAYS);
  const x = Math.log1p(d);
  for (let i = 1; i < CURVE.length; i++) {
    const [d1, y1] = CURVE[i];
    if (d <= d1) {
      const [d0, y0] = CURVE[i - 1], x0 = Math.log1p(d0), x1 = Math.log1p(d1);
      return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
  }
  return CURVE[CURVE.length - 1][1];
}

// Outlier score: views ÷ median of the 14 nearest uploads (7 before, 7 after, topped up
// from the other side), each scaled to this video's age with the growth curve.
function scoreList(list) {
  const sorted = [...list].sort((a, b) => a.p - b.p);
  const elig = sorted.filter(v => ageDays(v.p) >= MIN_AGE_DAYS);
  const pos = new Map(elig.map((v, i) => [v.id, i]));
  for (const v of sorted) {
    let i = pos.has(v.id) ? pos.get(v.id) : elig.findIndex(e => e.p > v.p);
    if (i < 0) i = elig.length;
    const self = pos.has(v.id);
    const before = elig.slice(Math.max(0, i - NEIGHBORS * 2), i);
    const after = elig.slice(self ? i + 1 : i, (self ? i + 1 : i) + NEIGHBORS * 2);
    let nb = before.length, na = after.length, tb = Math.min(NEIGHBORS, nb), ta = Math.min(NEIGHBORS, na);
    if (tb < NEIGHBORS) ta = Math.min(na, NEIGHBORS * 2 - tb);
    if (ta < NEIGHBORS) tb = Math.min(nb, NEIGHBORS * 2 - ta);
    const group = [...before.slice(nb - tb), ...after.slice(0, ta)];
    const gv = growth(ageDays(v.p));
    const base = median(group.map(n => n.v * gv / growth(ageDays(n.p))));
    v.s = base > 0 ? v.v / base : null;
  }
}
const scoreCls = s => s == null ? 's0' : s >= 10 ? 's10' : s >= 5 ? 's5' : s >= 2 ? 's2' : s >= 1 ? 's1' : 's0';
const scoreTxt = s => s == null ? '–' : (s >= 10 ? Math.round(s) : s.toFixed(1)) + 'x';

// ---------------------------------------------------------------- IndexedDB video cache
const idb = (() => {
  let dbp;
  const open = () => dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('outlierphobia', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('ch', { keyPath: 'id' });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const tx = async (mode, fn) => {
    try {
      const db = await open();
      return await new Promise((res, rej) => {
        const t = db.transaction('ch', mode), s = t.objectStore('ch');
        const r = fn(s); t.oncomplete = () => res(r?.result); t.onerror = () => rej(t.error);
      });
    } catch (e) { console.warn('cache unavailable', e); return undefined; }
  };
  return {
    all: () => tx('readonly', s => s.getAll()),
    put: v => tx('readwrite', s => s.put(v)),
    del: id => tx('readwrite', s => s.delete(id)),
  };
})();

// ---------------------------------------------------------------- account storage (Firebase or local)
function localBackend() {
  const K = 'op.local.user', S = 'op.local.saves';
  return {
    local: true,
    async start(onUser) { onUser({ uid: 'local', displayName: 'Local test', photoURL: '' }); },
    async signIn() {}, async signOut() { location.reload(); },
    async load() { return { data: ls.get(K, null), saves: ls.get(S, {}) }; },
    async saveUser(d) { ls.set(K, d); },
    async putSave(id, s) { const all = ls.get(S, {}); all[id] = s; ls.set(S, all); },
    async delSave(id) { const all = ls.get(S, {}); delete all[id]; ls.set(S, all); },
  };
}
async function firebaseBackend() {
  const V = '10.12.2', G = `https://www.gstatic.com/firebasejs/${V}/`;
  const [{ initializeApp }, A, F] = await Promise.all([
    import(G + 'firebase-app.js'), import(G + 'firebase-auth.js'), import(G + 'firebase-firestore.js')]);
  const app = initializeApp(FIREBASE_CONFIG);
  const auth = A.getAuth(app);
  const db = F.getFirestore(app);
  let user;
  const uref = () => F.doc(db, 'users', user.uid);
  return {
    async start(onUser) { A.onAuthStateChanged(auth, u => { user = u; onUser(u); }); },
    async signIn() {
      const p = new A.GoogleAuthProvider(); p.setCustomParameters({ prompt: 'select_account' });
      try { await A.signInWithPopup(auth, p); }
      catch (e) {
        if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment'].includes(e.code)) await A.signInWithRedirect(auth, p);
        else throw e;
      }
    },
    async signOut() { await A.signOut(auth); location.reload(); },
    async load() {
      const [u, s] = await Promise.all([F.getDoc(uref()), F.getDocs(F.collection(db, 'users', user.uid, 'saves'))]);
      const saves = {}; s.forEach(d => saves[d.id] = d.data());
      return { data: u.exists() ? u.data() : null, saves };
    },
    async saveUser(d) { await F.setDoc(uref(), d); },
    async putSave(id, s) { await F.setDoc(F.doc(db, 'users', user.uid, 'saves', id), s); },
    async delSave(id) { await F.deleteDoc(F.doc(db, 'users', user.uid, 'saves', id)); },
  };
}

// ---------------------------------------------------------------- state
let backend;
let me = null;
let user = null;        // { apiKey, chFolders:[{id,name,ch:[]}], svFolders:[{id,name}], channels:{id:{t,th,subs}} }
let saves = {};         // videoId -> { f:[folderIds], n, at, s:{snapshot} }
const cache = {};       // channelId -> { id, long:[v]|null, shorts:[v]|null, lastFull:{long,shorts}, err }
const busy = new Map(); // channelId -> label
let view = ls.get('op.view', null);
let shown = PAGE;
let lastSync = 0;
// ---- filters (same for every folder, remembered on this device)
const RANGES = [
  { key: 'score', label: 'Outlier score', steps: [0, 0.5, 1, 1.5, 2, 3, 4, 5, 7, 10, 15, 20, 30, 50, 100, Infinity], fmt: x => x + 'x' },
  { key: 'views', label: 'Views', steps: [0, 1e3, 5e3, 1e4, 25e3, 5e4, 1e5, 25e4, 5e5, 1e6, 25e5, 5e6, 1e7, 25e6, 5e7, 1e8, Infinity] },
  { key: 'vpd', label: 'Views per day', steps: [0, 10, 50, 100, 250, 500, 1e3, 25e2, 5e3, 1e4, 25e3, 5e4, 1e5, 5e5, 1e6, Infinity] },
  { key: 'subs', label: 'Channel subscribers', steps: [0, 1e3, 1e4, 5e4, 1e5, 25e4, 5e5, 1e6, 25e5, 5e6, 1e7, 25e6, 5e7, 1e8, Infinity] },
  { key: 'len', label: 'Length', steps: [0, 60, 120, 180, 300, 480, 600, 900, 1200, 1800, 2700, 3600, 5400, 7200, Infinity], fmt: s => s < 3600 ? s / 60 + ' min' : s / 3600 + ' h' },
];
const defaultFilters = () => ({ sort: 'score', shorts: false, from: '', to: '', r: Object.fromEntries(RANGES.map(R => [R.key, [0, R.steps.length - 1]])) });
const filt = (() => {
  const d = defaultFilters(), s = ls.get('op.filters2', {});
  const f = { ...d, ...s, r: { ...d.r } };
  for (const R of RANGES) { const v = s.r?.[R.key]; if (Array.isArray(v) && v.length === 2 && v[1] < R.steps.length) f.r[R.key] = v; }
  return f;
})();
let cols = ls.get('op.cols', 4);

function blankUser() {
  return { v: 1, apiKey: '', chFolders: [], svFolders: [{ id: uid(), name: 'Idea' }, { id: uid(), name: 'Format' }], channels: {} };
}
let saveTimer;
function persistUser() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => backend.saveUser(user).catch(e => toast('Couldn\'t save: ' + e.message)), 300);
}

// ---------------------------------------------------------------- YouTube API
class YTError extends Error {}
async function yt(path, params) {
  if (!user.apiKey) { const e = new YTError('NOKEY'); e.reason = 'nokey'; throw e; }
  const u = new URL(API + path);
  for (const [k, v] of Object.entries({ ...params, key: user.apiKey })) u.searchParams.set(k, v);
  let r;
  try { r = await fetch(u); } catch { const e = new YTError('Network error'); e.reason = 'network'; throw e; }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new YTError(j.error?.message?.replace(/<[^>]+>/g, '') || 'HTTP ' + r.status);
    e.status = r.status; e.reason = j.error?.errors?.[0]?.reason || '';
    throw e;
  }
  return j;
}
function apiFail(e) {
  if (e.reason === 'nokey') { openKey(); return 'needs API key'; }
  if (e.reason === 'quotaExceeded' || e.reason === 'dailyLimitExceeded') {
    toast('Daily YouTube limit reached. It resets at midnight US Pacific time.', 6000); return 'daily limit reached';
  }
  if (e.reason === 'keyInvalid' || /API key not valid/i.test(e.message)) { openKey('That API key doesn\'t work. Check it and paste it again.'); return 'API key not valid'; }
  return e.message;
}

function parseInput(s) {
  s = s.trim().replace(/^https?:\/\//, '').replace(/^(www\.|m\.)/, '');
  if (!s) return null;
  let m;
  if ((m = s.match(/channel\/(UC[\w-]{22})/)) || (m = s.match(/^(UC[\w-]{22})$/))) return { id: m[1], raw: s };
  if ((m = s.match(/youtube\.com\/(@[^/?#\s]+)/)) || (m = s.match(/^(@[^/?#\s]+)$/))) return { handle: decodeURIComponent(m[1]), raw: s };
  if ((m = s.match(/youtube\.com\/user\/([^/?#\s]+)/))) return { user: m[1], raw: s };
  if ((m = s.match(/(?:youtu\.be\/|[?&]v=|shorts\/|live\/)([\w-]{11})/))) return { video: m[1], raw: s };
  if ((m = s.match(/youtube\.com\/c\/([^/?#\s]+)/))) return { search: decodeURIComponent(m[1]), raw: s };
  if (!/\s/.test(s) && !s.includes('/')) return { handle: '@' + s, raw: s };
  return { search: s, raw: s };
}
async function resolveChannel(p) {
  const part = 'snippet,statistics';
  let res;
  if (p.id) res = await yt('channels', { part, id: p.id });
  else if (p.handle) res = await yt('channels', { part, forHandle: p.handle });
  else if (p.user) res = await yt('channels', { part, forUsername: p.user });
  else if (p.video) {
    const v = await yt('videos', { part: 'snippet', id: p.video });
    if (!v.items?.length) return null;
    res = await yt('channels', { part, id: v.items[0].snippet.channelId });
  } else {
    const s = await yt('search', { part: 'snippet', type: 'channel', q: p.search, maxResults: 1 });
    if (!s.items?.length) return null;
    res = await yt('channels', { part, id: s.items[0].snippet.channelId });
  }
  const c = res.items?.[0];
  return c ? { id: c.id, ...chInfo(c) } : null;
}
const chInfo = c => ({ t: c.snippet.title, th: c.snippet.thumbnails?.default?.url || '', subs: c.statistics?.hiddenSubscriberCount ? null : +c.statistics?.subscriberCount || 0 });

async function refreshChannelInfo(ids) {
  for (let i = 0; i < ids.length; i += 50) {
    const j = await yt('channels', { part: 'snippet,statistics', id: ids.slice(i, i + 50).join(','), maxResults: 50 });
    for (const c of j.items || []) user.channels[c.id] = { ...user.channels[c.id], ...chInfo(c) };
  }
  persistUser();
}

// playlist ids, newest first; stops early once it reaches a known id
async function playlistIds(pid, known) {
  const ids = [];
  let token = '';
  do {
    const j = await yt('playlistItems', { part: 'contentDetails', playlistId: pid, maxResults: 50, ...(token ? { pageToken: token } : {}) });
    for (const it of j.items || []) {
      const id = it.contentDetails.videoId;
      if (known && known.has(id)) return ids;
      ids.push(id);
    }
    token = j.nextPageToken || '';
  } while (token);
  return ids;
}
async function videoDetails(ids, chId) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const j = await yt('videos', { part: 'snippet,statistics,contentDetails', id: ids.slice(i, i + 50).join(',') });
    for (const v of j.items || []) {
      if (v.snippet.liveBroadcastContent !== 'none') continue; // upcoming / live right now
      out.push({ id: v.id, c: chId, t: v.snippet.title, p: Date.parse(v.snippet.publishedAt), d: isoDur(v.contentDetails.duration), v: +v.statistics.viewCount || 0 });
    }
  }
  return out;
}

// kind: 'long' | 'shorts'
async function syncChannel(chId, kind) {
  const c = cache[chId] ||= { id: chId, long: null, shorts: null, lastFull: {} };
  const tail = chId.slice(2);
  const pid = (kind === 'long' ? 'UULF' : 'UUSH') + tail;
  const list = c[kind];
  // fallback channels share one upload list, so both kinds count as already known
  const known = list ? new Set([...list, ...(c.fallback ? (c[kind === 'long' ? 'shorts' : 'long'] || []) : [])].map(v => v.id)) : null;
  let newIds;
  try {
    if (c.fallback) { const e = new YTError('fallback'); e.status = 404; throw e; }
    newIds = await playlistIds(pid, known);
  } catch (e) {
    if (e.status !== 404) throw e;
    // channel has no separate long/shorts list: fall back to all uploads, split by length
    const all = await playlistIds('UU' + tail, known);
    newIds = all; c.fallback = true;
  }
  const full = !list || Date.now() - (c.lastFull[kind] || 0) > FULL_REFRESH_MS;
  const refreshIds = full ? (list || []).map(v => v.id) : (list || []).filter(v => ageDays(v.p) < RECENT_DAYS).map(v => v.id);
  const fresh = await videoDetails([...newIds, ...refreshIds], chId);
  const keep = c.fallback ? fresh.filter(v => kind === 'long' ? v.d > 180 : v.d <= 180) : fresh;
  const byId = new Map((list || []).map(v => [v.id, v]));
  if (full && list) byId.clear(); // drop deleted/private videos on full refresh
  for (const v of keep) byId.set(v.id, v);
  c[kind] = [...byId.values()];
  if (full) c.lastFull[kind] = Date.now();
  scoreList(c[kind]);
  c.err = '';
  await idb.put(c);
}

// simple work queue so many channels don't all hit the API at once
const queue = [];
let running = 0;
function enqueue(chId, kind) {
  const key = chId + ':' + kind;
  if (busy.has(key) || queue.some(q => q.key === key)) return;
  queue.push({ key, chId, kind });
  busy.set(key, true);
  pump(); render();
}
function pump() {
  while (running < CONCURRENCY && queue.length) {
    const job = queue.shift();
    running++;
    syncChannel(job.chId, job.kind)
      .catch(e => { (cache[job.chId] ||= { id: job.chId, long: null, shorts: null, lastFull: {} }).err = apiFail(e); })
      .finally(() => { running--; busy.delete(job.key); lastSync = Date.now(); pump(); renderSoon(); });
  }
}

function allChannelIds() { return [...new Set(user.chFolders.flatMap(f => f.ch))]; }
async function syncAll() {
  if (!user.apiKey) return;
  const ids = allChannelIds();
  if (!ids.length) return;
  try { await refreshChannelInfo(ids); } catch (e) { apiFail(e); return; }
  for (const id of ids) {
    enqueue(id, 'long');
    if (cache[id]?.shorts) enqueue(id, 'shorts');
  }
}


// ---------------------------------------------------------------- view data
function currentFolder() {
  if (!view) return null;
  const arr = view.type === 'ch' ? user.chFolders : user.svFolders;
  return arr.find(f => f.id === view.id) || null;
}
function findVideo(id) {
  for (const c of Object.values(cache)) {
    const v = c.long?.find(x => x.id === id) || c.shorts?.find(x => x.id === id);
    if (v) return v;
  }
  return null;
}
function viewVideos() {
  const f = currentFolder();
  if (!f) return [];
  if (view.type === 'ch') {
    const out = [];
    for (const id of f.ch) {
      const c = cache[id];
      if (!c) continue;
      if (c.long) out.push(...c.long);
      if (filt.shorts && c.shorts) out.push(...c.shorts.map(v => ({ ...v, short: true })));
    }
    return out;
  }
  return Object.entries(saves).filter(([, s]) => s.f.includes(f.id)).map(([id, s]) => {
    const live = findVideo(id);
    return { ...(s.s || {}), ...(live || {}), id, note: s.n, short: s.s?.short };
  });
}
const vpdOf = v => v.v / Math.max(ageDays(v.p), 1);
const subsOf = v => user.channels[v.c]?.subs ?? null;
const GET = { score: v => v.s, views: v => v.v, vpd: vpdOf, subs: subsOf, len: v => v.d };
const dayStart = s => s ? new Date(s + 'T00:00:00').getTime() : null;

function rangeActive(R) { const [a, b] = filt.r[R.key]; return a > 0 || b < R.steps.length - 1; }
function activeCount() { return RANGES.filter(rangeActive).length + (filt.from || filt.to ? 1 : 0); }

function filtered() {
  const q = $('q').value.trim().toLowerCase();
  const from = dayStart(filt.from), to = filt.to ? dayStart(filt.to) + DAY : null;
  const checks = RANGES.filter(rangeActive).map(R => {
    const [a, b] = filt.r[R.key], lo = R.steps[a], hi = R.steps[b], get = GET[R.key];
    return v => { const x = get(v); return x != null && x >= lo && (hi === Infinity || x <= hi); };
  });
  const list = viewVideos().filter(v =>
    (view.type === 'sv' || filt.shorts || !v.short) &&
    (!from || v.p >= from) && (!to || v.p < to) &&
    (!q || (v.t || '').toLowerCase().includes(q)) &&
    checks.every(c => c(v)));
  const n = x => x ?? -1;
  const cmp = {
    score: (a, b) => n(b.s) - n(a.s), views: (a, b) => b.v - a.v, vpd: (a, b) => vpdOf(b) - vpdOf(a),
    date: (a, b) => b.p - a.p, oldest: (a, b) => a.p - b.p, dur: (a, b) => b.d - a.d, short: (a, b) => a.d - b.d,
    subs: (a, b) => n(subsOf(b)) - n(subsOf(a)) || n(b.s) - n(a.s),
  }[filt.sort] || ((a, b) => n(b.s) - n(a.s));
  return list.sort(cmp);
}

// ---------------------------------------------------------------- render
const IC = {
  folder: '<svg class="ic" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  bookmark: '<svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4.5L6 21z"/></svg>',
  star: '<svg class="ic" viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4.5L6 21z"/></svg>',
};

let renderQ = false;
function renderSoon() { if (!renderQ) { renderQ = true; requestAnimationFrame(() => { renderQ = false; render(); }); } }

function renderNav() {
  const item = (f, type, count, ic) => `<button class="nav-item ${view?.type === type && view.id === f.id ? 'active' : ''}" data-view="${type}:${f.id}">
      ${ic}<span class="nm">${esc(f.name)}</span><span class="count">${count}</span></button>`;
  $('chFolders').innerHTML = user.chFolders.map(f => item(f, 'ch', f.ch.length, IC.folder)).join('') ||
    '<div class="nav-empty">No folders yet. Press + New to make one, like "AI creators".</div>';
  $('svFolders').innerHTML = user.svFolders.map(f => item(f, 'sv', Object.values(saves).filter(s => s.f.includes(f.id)).length, IC.star)).join('') ||
    '<div class="nav-empty">No save folders yet.</div>';
  $('avatar').innerHTML = me.photoURL ? `<img src="${esc(me.photoURL)}" alt="" referrerpolicy="no-referrer">` : '';
}

function rangeLabel(R) {
  const [a, b] = filt.r[R.key], f = R.fmt || num, last = R.steps.length - 1;
  if (a === 0 && b === last) return 'Any';
  if (b === last) return f(R.steps[a]) + '+';
  if (a === 0) return 'Up to ' + f(R.steps[b]);
  return f(R.steps[a]) + ' – ' + f(R.steps[b]);
}
function dateLabel() {
  const f = s => new Date(s + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  if (filt.from && filt.to) return f(filt.from) + ' – ' + f(filt.to);
  if (filt.from) return 'Since ' + f(filt.from);
  if (filt.to) return 'Before ' + f(filt.to);
  return 'Any time';
}
function buildSliders() {
  $('sliders').innerHTML = RANGES.map(R => {
    const last = R.steps.length - 1, f = R.fmt || num;
    return `<div class="f-sec" data-sec="${R.key}">
      <div class="f-top"><span class="f-label">${R.label}</span><span class="f-val" data-val="${R.key}"></span><button class="f-reset" data-reset="${R.key}" title="Reset">↺</button></div>
      <div class="range" data-range="${R.key}">
        <div class="track"></div><div class="fill"></div>
        <input type="range" min="0" max="${last}" step="1" data-end="0" aria-label="${R.label} minimum">
        <input type="range" min="0" max="${last}" step="1" data-end="1" aria-label="${R.label} maximum">
      </div>
      <div class="range-ends"><span>${f(R.steps[0])}</span><span>${f(R.steps[last - 1])}+</span></div>
    </div>`;
  }).join('');
}
function syncFilterUI() {
  for (const R of RANGES) {
    const box = document.querySelector(`[data-range="${R.key}"]`); if (!box) continue;
    const [a, b] = filt.r[R.key], last = R.steps.length - 1;
    const [i0, i1] = box.querySelectorAll('input');
    i0.value = a; i1.value = b;
    const pa = a / last, pb = b / last;
    const fill = box.querySelector('.fill');
    fill.style.left = `calc(9px + (100% - 18px) * ${pa})`; fill.style.width = `calc((100% - 18px) * ${pb - pa})`;
    // keep the handle you can still move on top when both sit at the far end
    i0.style.zIndex = a === last ? 3 : 1; i1.style.zIndex = 2;
    document.querySelector(`[data-val="${R.key}"]`).textContent = rangeLabel(R);
    document.querySelector(`[data-sec="${R.key}"]`).classList.toggle('on', rangeActive(R));
  }
  $('sort').value = filt.sort; $('shorts').checked = filt.shorts;
  $('dateFrom').value = filt.from; $('dateTo').value = filt.to;
  $('dateVal').textContent = dateLabel();
  $('dateSec').classList.toggle('on', !!(filt.from || filt.to));
  const today = new Date(); const iso = d => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
  for (const b of $('dateQuick').querySelectorAll('button')) {
    const d = new Date(today); d.setDate(d.getDate() - +b.dataset.days);
    b.classList.toggle('on', !filt.to && filt.from === iso(d));
  }
  const n = activeCount();
  $('filtersCount').hidden = !n; $('filtersCount').textContent = n;
  $('resetAll').hidden = !n;
  // active filter pills above the grid
  const pills = RANGES.filter(rangeActive).map(R => `<span class="af">${R.label}: ${rangeLabel(R)}<button data-reset="${R.key}" title="Remove">×</button></span>`);
  if (filt.from || filt.to) pills.push(`<span class="af">${dateLabel()}<button data-reset="date" title="Remove">×</button></span>`);
  $('activeFilters').innerHTML = pills.join('');
}

function effectiveCols() {
  const w = $('grid').clientWidth || $('main').clientWidth - 48;
  return Math.max(1, Math.min(cols, Math.floor((w + 16) / (240 + 16))));
}
function applyCols() { $('grid').style.setProperty('--cols', effectiveCols()); }

function render() {
  if (!user) return;
  renderNav();
  syncFilterUI();
  applyCols();
  const f = currentFolder();
  $('folderMenu').hidden = !f;
  $('addRow').hidden = !f || view.type !== 'ch';
  $('viewTitle').textContent = f ? f.name : 'Welcome';

  if (!f) {
    $('chips').innerHTML = ''; $('status').innerHTML = ''; $('more').innerHTML = '';
    $('grid').innerHTML = `<div class="empty"><h2>Make your first channel folder</h2>Group the channels you want to study, like "AI creators".<br><button class="btn primary" data-act="newCh">New channel folder</button></div>`;
    return;
  }

  let loadingN = 0;
  if (view.type === 'ch') {
    $('chips').innerHTML = f.ch.map(id => {
      const ch = user.channels[id] || { t: id }, c = cache[id];
      const loading = busy.has(id + ':long') || busy.has(id + ':shorts');
      if (loading) loadingN++;
      const st = loading ? (c?.long ? 'updating…' : 'loading…') : c?.err ? `<span class="err">${esc(c.err)}</span>` : c?.long ? c.long.length.toLocaleString() + ' videos' : '';
      return `<div class="chip" title="${esc(ch.t)}${ch.subs != null ? ' · ' + num(ch.subs) + ' subscribers' : ''}">
        ${ch.th ? `<img src="${esc(ch.th)}" alt="" referrerpolicy="no-referrer">` : '<span class="ph"></span>'}<span class="nm">${esc(ch.t)}</span><span class="st">${st}</span>
        <button class="x" data-rmch="${id}" title="Remove from this folder">×</button></div>`;
    }).join('');
  }

  const list = filtered();
  const total = viewVideos().filter(v => view.type === 'sv' || filt.shorts || !v.short).length;
  $('status').innerHTML = (loadingN ? '<span class="spin"></span>' : '') +
    `<span><b>${list.length.toLocaleString()}</b>${list.length !== total ? ' of ' + total.toLocaleString() : ''} videos${loadingN ? ` · updating ${loadingN}…` : ''}</span>`;

  if (!list.length) {
    let html;
    if (view.type === 'sv') html = `<div class="empty"><h2>Nothing saved here yet</h2>Hover a video and press the bookmark to save it to this folder.</div>`;
    else if (!f.ch.length) html = `<div class="empty"><h2>Add a channel</h2>Paste a channel link like youtube.com/@mkbhd in the box above.${user.apiKey ? '' : '<br>First, add your YouTube API key in Settings.'}</div>`;
    else if (loadingN) html = Array.from({ length: effectiveCols() * 2 }, () => '<div class="card sk"><div class="thumb"></div><div class="line"></div><div class="line s"></div></div>').join('');
    else html = `<div class="empty"><h2>No videos match</h2>Try loosening the filters.${activeCount() ? '<br><button class="btn" data-act="resetAll">Reset all filters</button>' : ''}</div>`;
    $('grid').innerHTML = html; $('more').innerHTML = '';
    return;
  }

  const c = effectiveCols();
  const count = Math.ceil(shown / c) * c;
  $('grid').innerHTML = list.slice(0, count).map(cardHtml).join('');
  $('more').innerHTML = list.length > count ? `<button class="btn" data-act="more">Show more · ${(list.length - count).toLocaleString()} left</button>` : '';
}

function cardHtml(v) {
  const ch = user.channels[v.c] || { t: v.ct || '' };
  const url = v.short ? `https://www.youtube.com/shorts/${v.id}` : `https://www.youtube.com/watch?v=${v.id}`;
  const isNew = ageDays(v.p) < MIN_AGE_DAYS;
  const sv = saves[v.id];
  return `<div class="card">
    <a class="thumb" href="${url}" target="_blank" rel="noopener">
      <img src="https://i.ytimg.com/vi/${v.id}/hqdefault.jpg" alt="" loading="lazy">
      <span class="badge ${scoreCls(v.s)}" title="Outlier score">${scoreTxt(v.s)}</span>
      ${isNew ? '<span class="tag-new">Too new</span>' : ''}
      <span class="dur">${v.short ? 'SHORT · ' : ''}${dur(v.d)}</span>
    </a>
    <button class="save-btn ${sv ? 'on' : ''}" data-save="${v.id}" title="${sv ? 'Saved · edit' : 'Save'}" aria-label="${sv ? 'Saved, edit' : 'Save video'}">${IC.bookmark}</button>
    <div class="meta">
      ${ch.th ? `<img class="ch-av" src="${esc(ch.th)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="ch-av"></span>'}
      <div class="info">
        <a class="title" href="${url}" target="_blank" rel="noopener" title="${esc(v.t)}">${esc(v.t)}</a>
        <div class="ch-line">${esc(ch.t)}${ch.subs != null ? ' · ' + num(ch.subs) + ' subs' : ''}</div>
        <div class="stats"><b>${num(v.v)} views</b> · ${num(vpdOf(v))}/day · ${ago(v.p)}</div>
        ${v.note ? `<div class="note">${esc(v.note)}</div>` : ''}
      </div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- dialogs
function ask({ title, text = '', value = null, ok = 'OK', extra = null }) {
  return new Promise(res => {
    const d = $('askDlg');
    $('askTitle').textContent = title; $('askText').textContent = text; $('askText').hidden = !text;
    $('askInput').hidden = value == null; $('askInput').value = value ?? '';
    $('askOk').textContent = ok;
    $('askExtra').hidden = !extra; if (extra) $('askExtra').textContent = extra;
    let settled = false;
    const done = r => { if (settled) return; settled = true; cleanup(); if (d.open) d.close(); res(r); };
    const onOk = () => done({ ok: true, value: $('askInput').value.trim() });
    const onCancel = () => done({ ok: false });
    const onExtra = () => done({ extra: true });
    const onKey = e => { if (e.key === 'Enter' && value != null) { e.preventDefault(); onOk(); } };
    const onClose = () => done({ ok: false });
    function cleanup() {
      $('askOk').removeEventListener('click', onOk); $('askCancel').removeEventListener('click', onCancel);
      $('askExtra').removeEventListener('click', onExtra); $('askInput').removeEventListener('keydown', onKey);
      d.removeEventListener('close', onClose);
    }
    $('askOk').addEventListener('click', onOk); $('askCancel').addEventListener('click', onCancel);
    $('askExtra').addEventListener('click', onExtra); $('askInput').addEventListener('keydown', onKey);
    d.addEventListener('close', onClose);
    d.showModal();
    if (value != null) { $('askInput').focus(); $('askInput').select(); }
  });
}

function openKey(err = '') {
  $('keyInput').value = user.apiKey || '';
  $('keyErr').textContent = err;
  if ($('setDlg').open) $('setDlg').close();
  if (!$('keyDlg').open) $('keyDlg').showModal();
}
$('keyCancel').onclick = () => $('keyDlg').close();
$('keySave').onclick = async () => {
  const k = $('keyInput').value.trim();
  if (!k) { $('keyErr').textContent = 'Paste a key first.'; return; }
  const old = user.apiKey; user.apiKey = k;
  $('keySave').disabled = true; $('keyErr').textContent = 'Checking…';
  try {
    await yt('channels', { part: 'id', id: 'UC_x5XG1OV2P6uZZ5FSM9Ttw' });
    persistUser(); $('keyDlg').close(); toast('API key saved');
    syncAll();
  } catch (e) {
    user.apiKey = old;
    $('keyErr').textContent = e.reason === 'quotaExceeded' ? 'Key works, but today\'s limit is used up.' : 'That key didn\'t work: ' + e.message;
  } finally { $('keySave').disabled = false; }
};

function openSettings() {
  for (const b of $('sizeSeg').querySelectorAll('button')) b.classList.toggle('on', +b.dataset.cols === cols);
  $('keyState').textContent = user.apiKey ? 'Saved ✓' : 'Not set';
  $('meName').textContent = me.email || me.displayName || '';
  $('setDlg').showModal();
}
$('settingsBtn').onclick = openSettings;
$('setClose').onclick = () => $('setDlg').close();
$('sizeSeg').onclick = e => {
  const b = e.target.closest('button[data-cols]'); if (!b) return;
  cols = +b.dataset.cols; ls.set('op.cols', cols);
  for (const x of $('sizeSeg').querySelectorAll('button')) x.classList.toggle('on', x === b);
  render();
};
$('keyBtn').onclick = () => openKey();
$('signOut').onclick = () => backend.signOut();
$('exportBtn').onclick = () => exportBackup();
$('importBtn').onclick = () => $('importFile').click();

let saveFor = null;
function openSave(id) {
  const v = viewVideos().find(x => x.id === id) || findVideo(id) || saves[id]?.s;
  if (!v) return;
  saveFor = { ...v, id };
  const s = saves[id];
  $('saveVideo').innerHTML = `<img src="https://i.ytimg.com/vi/${id}/mqdefault.jpg" alt=""><div>${esc(v.t)}</div>`;
  drawSaveFolders(s ? s.f : (view?.type === 'sv' ? [view.id] : []));
  $('saveNote').value = s?.n || '';
  $('saveNewFolder').value = '';
  $('saveDlg').showModal();
}
function drawSaveFolders(checked) {
  $('saveFolders').innerHTML = user.svFolders.map(f => `<label><input type="checkbox" value="${f.id}" ${checked.includes(f.id) ? 'checked' : ''}>${esc(f.name)}</label>`).join('')
    || '<div class="nav-empty">Make a folder below.</div>';
}
function checkedSaveFolders() { return [...$('saveFolders').querySelectorAll('input:checked')].map(i => i.value); }
$('saveNewFolderBtn').onclick = () => {
  const name = $('saveNewFolder').value.trim();
  if (!name) return;
  const f = { id: uid(), name }; user.svFolders.push(f); persistUser();
  drawSaveFolders([...checkedSaveFolders(), f.id]); $('saveNewFolder').value = ''; renderNav();
};
$('saveNewFolder').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('saveNewFolderBtn').click(); } });
$('saveCancel').onclick = () => $('saveDlg').close();
$('saveOk').onclick = async () => {
  const v = saveFor, f = checkedSaveFolders(), n = $('saveNote').value.trim();
  $('saveDlg').close();
  try {
    if (!f.length) {
      if (saves[v.id]) { delete saves[v.id]; await backend.delSave(v.id); toast('Removed from saved'); }
    } else {
      const snap = { t: v.t, c: v.c, ct: user.channels[v.c]?.t || v.ct || '', p: v.p, d: v.d, v: v.v, s: v.s ?? null, short: !!v.short };
      saves[v.id] = { f, n, at: saves[v.id]?.at || Date.now(), s: snap };
      await backend.putSave(v.id, saves[v.id]);
      toast('Saved to ' + f.map(id => user.svFolders.find(x => x.id === id)?.name).join(', '));
    }
  } catch (e) { toast('Couldn\'t save: ' + e.message); }
  render();
};

// ---------------------------------------------------------------- actions
function closeDrawers() { $('app').classList.remove('nav-open', 'filters-open'); }
function setView(type, id) {
  view = { type, id }; ls.set('op.view', view); shown = PAGE; $('q').value = '';
  closeDrawers(); render(); window.scrollTo(0, 0);
}
async function newFolder(type) {
  const r = await ask({ title: type === 'ch' ? 'New channel folder' : 'New save folder', value: '', ok: 'Create' });
  if (!r.ok || !r.value) return;
  const f = type === 'ch' ? { id: uid(), name: r.value, ch: [] } : { id: uid(), name: r.value };
  (type === 'ch' ? user.chFolders : user.svFolders).push(f);
  persistUser(); setView(type, f.id);
  if (type === 'ch') $('addInput').focus();
}
function cleanupChannels() {
  const used = new Set(allChannelIds());
  for (const id of Object.keys(user.channels)) if (!used.has(id)) { delete user.channels[id]; delete cache[id]; idb.del(id); }
}

$('newChFolder').onclick = () => newFolder('ch');
$('newSvFolder').onclick = () => newFolder('sv');
$('menuBtn').onclick = () => $('app').classList.toggle('nav-open');
$('filtersBtn').onclick = () => $('app').classList.toggle('filters-open');
$('filtersClose').onclick = $('scrim').onclick = closeDrawers;
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawers(); });

$('folderMenu').onclick = async () => {
  const f = currentFolder(); if (!f) return;
  const r = await ask({ title: 'Rename folder', value: f.name, ok: 'Rename', extra: 'Delete folder' });
  if (r.ok && r.value) { f.name = r.value; persistUser(); render(); }
  if (r.extra) {
    const what = view.type === 'ch' ? 'The channels stay in your other folders.' : 'Videos saved only in this folder will be removed.';
    const c = await ask({ title: `Delete "${f.name}"?`, text: what, ok: 'Delete' });
    if (!c.ok) return;
    if (view.type === 'ch') { user.chFolders = user.chFolders.filter(x => x !== f); cleanupChannels(); }
    else {
      user.svFolders = user.svFolders.filter(x => x !== f);
      for (const [id, s] of Object.entries(saves)) {
        if (!s.f.includes(f.id)) continue;
        s.f = s.f.filter(x => x !== f.id);
        if (s.f.length) backend.putSave(id, s); else { delete saves[id]; backend.delSave(id); }
      }
    }
    persistUser();
    const next = user.chFolders[0] ? ['ch', user.chFolders[0].id] : user.svFolders[0] ? ['sv', user.svFolders[0].id] : null;
    if (next) setView(...next); else { view = null; render(); }
  }
};

$('addForm').onsubmit = async e => {
  e.preventDefault();
  const f = currentFolder(); if (!f || view.type !== 'ch') return;
  if (!user.apiKey) { openKey(); return; }
  const inputs = $('addInput').value.split(/[,\n]+/).map(parseInput).filter(Boolean);
  if (!inputs.length) return;
  $('addBtn').disabled = true;
  const failed = [];
  let added = 0;
  for (const p of inputs) {
    try {
      const c = await resolveChannel(p);
      if (!c) { failed.push([p.raw, 'not found']); continue; }
      user.channels[c.id] = { t: c.t, th: c.th, subs: c.subs };
      if (!f.ch.includes(c.id)) { f.ch.push(c.id); added++; }
      if (!cache[c.id]?.long) enqueue(c.id, 'long');
      if (filt.shorts && !cache[c.id]?.shorts) enqueue(c.id, 'shorts');
    } catch (err) { failed.push([p.raw, apiFail(err)]); }
  }
  persistUser();
  $('addBtn').disabled = false;
  $('addInput').value = failed.map(x => x[0]).join(', ');
  if (failed.length) toast('Couldn\'t add: ' + failed.map(x => `${x[0]} (${x[1]})`).join(', '), 6000);
  else if (added) toast(added === 1 ? 'Channel added. Loading its videos…' : added + ' channels added. Loading videos…');
  render();
};

function saveFilters() { ls.set('op.filters2', filt); }
function filtersChanged() { saveFilters(); shown = PAGE; render(); }
function resetFilter(key) {
  if (key === 'date') { filt.from = ''; filt.to = ''; }
  else { const R = RANGES.find(x => x.key === key); filt.r[key] = [0, R.steps.length - 1]; }
  filtersChanged();
}

document.addEventListener('click', e => {
  const t = e.target.closest('[data-view],[data-rmch],[data-save],[data-act],[data-reset],[data-days]');
  if (!t) return;
  if (t.dataset.view) { const [type, id] = t.dataset.view.split(':'); setView(type, id); }
  else if (t.dataset.rmch) {
    const f = currentFolder(); f.ch = f.ch.filter(x => x !== t.dataset.rmch); cleanupChannels(); persistUser(); render();
  }
  else if (t.dataset.save) { e.preventDefault(); openSave(t.dataset.save); }
  else if (t.dataset.reset) resetFilter(t.dataset.reset);
  else if (t.dataset.days) {
    const d = new Date(); d.setDate(d.getDate() - +t.dataset.days);
    const iso = new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
    const same = filt.from === iso && !filt.to;
    filt.from = same ? '' : iso; filt.to = '';
    filtersChanged();
  }
  else if (t.dataset.act === 'more') { shown += PAGE; render(); }
  else if (t.dataset.act === 'newCh') newFolder('ch');
  else if (t.dataset.act === 'resetAll') $('resetAll').click();
});

buildSliders();
$('sliders').addEventListener('input', e => {
  const inp = e.target; if (inp.type !== 'range') return;
  const key = inp.closest('[data-range]').dataset.range;
  const r = filt.r[key], end = +inp.dataset.end;
  let v = +inp.value;
  v = end === 0 ? Math.min(v, r[1] - 1) : Math.max(v, r[0] + 1);
  r[end] = v; inp.value = v;
  saveFilters(); shown = PAGE; renderSoon();
});
$('resetAll').onclick = () => {
  const d = defaultFilters();
  filt.r = d.r; filt.from = ''; filt.to = '';
  filtersChanged();
};
$('sort').onchange = () => { filt.sort = $('sort').value; filtersChanged(); };
$('dateFrom').onchange = () => { filt.from = $('dateFrom').value; filtersChanged(); };
$('dateTo').onchange = () => { filt.to = $('dateTo').value; filtersChanged(); };
let qT;
$('q').oninput = () => { clearTimeout(qT); qT = setTimeout(() => { shown = PAGE; render(); }, 120); };
$('shorts').onchange = () => {
  filt.shorts = $('shorts').checked; filtersChanged();
  if (filt.shorts && view?.type === 'ch') for (const id of currentFolder()?.ch || []) if (!cache[id]?.shorts) enqueue(id, 'shorts');
};
new ResizeObserver(() => { if (user) { const before = $('grid').style.getPropertyValue('--cols'); applyCols(); if (before !== $('grid').style.getPropertyValue('--cols')) render(); } }).observe($('main'));

function exportBackup() {
  const { apiKey, ...rest } = user;
  const blob = new Blob([JSON.stringify({ app: 'outlierphobia', at: new Date().toISOString(), user: rest, saves }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `outlierphobia-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
$('importFile').onchange = async () => {
  const file = $('importFile').files[0]; $('importFile').value = '';
  if (!file) return;
  try {
    const j = JSON.parse(await file.text());
    if (j.app !== 'outlierphobia' || !j.user) throw new Error('not an Outlierphobia backup');
    if ($('setDlg').open) $('setDlg').close();
    const c = await ask({ title: 'Import backup?', text: 'Folders and saved videos from the file are added to what you have now. Nothing is deleted.', ok: 'Import' });
    if (!c.ok) return;
    const byName = (arr, f) => arr.find(x => x.name === f.name);
    const idMap = {};
    for (const f of j.user.chFolders || []) {
      const ex = byName(user.chFolders, f);
      if (ex) ex.ch = [...new Set([...ex.ch, ...f.ch])]; else user.chFolders.push({ ...f });
    }
    for (const f of j.user.svFolders || []) {
      const ex = byName(user.svFolders, f);
      if (ex) idMap[f.id] = ex.id; else { user.svFolders.push({ ...f }); idMap[f.id] = f.id; }
    }
    Object.assign(user.channels, j.user.channels || {});
    for (const [id, s] of Object.entries(j.saves || {})) {
      const f = [...new Set([...(saves[id]?.f || []), ...s.f.map(x => idMap[x] || x)])];
      saves[id] = { ...s, f, n: saves[id]?.n || s.n };
      await backend.putSave(id, saves[id]);
    }
    persistUser(); toast('Backup imported'); syncAll(); render();
  } catch (e) { toast('Import failed: ' + e.message, 6000); }
};

// ---------------------------------------------------------------- boot
async function boot() {
  try { backend = LOCAL ? localBackend() : await firebaseBackend(); }
  catch (e) { $('loading').innerHTML = `<div class="signin-box"><div class="logo big"><span class="mark"></span>Outlier<b>phobia</b></div><p class="err">Couldn't load. Check your connection and reload.</p></div>`; return; }
  $('signinBtn').onclick = async () => {
    $('signinErr').textContent = '';
    try { await backend.signIn(); } catch (e) { $('signinErr').textContent = e.code === 'auth/popup-closed-by-user' ? '' : 'Sign-in failed: ' + e.message; }
  };
  backend.start(async u => {
    if (!u) { me = null; $('loading').hidden = true; $('app').hidden = true; $('signin').hidden = false; return; }
    me = u;
    $('signin').hidden = true; $('loading').hidden = false;
    try {
      const [{ data, saves: sv }, cached] = await Promise.all([backend.load(), idb.all()]);
      user = data || blankUser();
      user.chFolders ||= []; user.svFolders ||= []; user.channels ||= {};
      saves = sv || {};
      if (!data) await backend.saveUser(user);
      for (const c of cached || []) { cache[c.id] = c; if (c.long) scoreList(c.long); if (c.shorts) scoreList(c.shorts); }
    } catch (e) {
      $('loading').innerHTML = `<div class="signin-box"><div class="logo big"><span class="mark"></span>Outlier<b>phobia</b></div><p class="err">Couldn't load your account: ${esc(e.message)}</p></div>`;
      return;
    }
    if (!currentFolder()) view = user.chFolders[0] ? { type: 'ch', id: user.chFolders[0].id } : null;
    $('loading').hidden = true; $('app').hidden = false;
    render();
    if (!user.apiKey) openKey();
    else syncAll();
  });
}
boot();
