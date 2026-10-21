// App data other than the parsed PDFs, kept in IndexedDB ("kv" store) and cached in memory so modules
// can read it synchronously once kvReady has settled. Writes go to memory at once and to IndexedDB in the background.
//
// Upgrading from the old version: halls, seating, added subjects, custom dates and set exam dates used to live
// in localStorage. On first start they are copied into IndexedDB, set dates are converted to the sittings format,
// and the old localStorage entries are removed (small display preferences stay in localStorage).
import { kvStore, BLOCKED_MSG } from './store.js';

export const DATA_VERSION = 3;
const cache = new Map();
const listeners = new Set();
let failed = '';

// Old localStorage key → kv key
const LEGACY = {
  'ptc.halls': 'halls',
  'ptc.seating': 'plans',
  'ptc.seatExtras': 'extras',
  'ptc.seatDays': 'customDays',
  'ptc.setDates': 'setDates',
  'ptc.timetable': 'timetable',
};
// Old tab names → new ones
const TAB_RENAME = { schedule: 'qp' };

// { code: { date, session } } → { code: { slots: [{ date, slot }] } }
function upgradeSetDates(v) {
  if (!v || typeof v !== 'object') return {};
  const out = {};
  for (const [code, x] of Object.entries(v)) out[code] = x?.slots ? x : x?.date ? { slots: [{ date: x.date, slot: x.session || 'FN' }] } : x;
  return out;
}

function readLegacy() {
  const found = {};
  for (const [old, key] of Object.entries(LEGACY)) {
    try {
      const raw = localStorage.getItem(old);
      if (raw != null) found[key] = JSON.parse(raw);
    } catch {}
  }
  if (found.setDates) found.setDates = upgradeSetDates(found.setDates);
  return found;
}

async function load() {
  try {
    for (const rec of await kvStore.all()) cache.set(rec.key, rec.value);
    const legacy = readLegacy();
    const moved = Object.keys(legacy).filter((k) => !cache.has(k));
    for (const k of moved) {
      cache.set(k, legacy[k]);
      await kvStore.put({ key: k, value: legacy[k] });
    }
    if (cache.has('setDates')) cache.set('setDates', upgradeSetDates(cache.get('setDates')));
    if (cache.get('dataVersion') !== DATA_VERSION) {
      cache.set('dataVersion', DATA_VERSION);
      await kvStore.put({ key: 'dataVersion', value: DATA_VERSION });
    }
    // Everything is in IndexedDB now; free the old localStorage copies.
    for (const old of Object.keys(LEGACY)) try { localStorage.removeItem(old); } catch {}
    try {
      const tab = localStorage.getItem('ptc.tab');
      if (TAB_RENAME[tab]) localStorage.setItem('ptc.tab', TAB_RENAME[tab]);
    } catch {}
    if (moved.length) console.info('PTC Exams: moved old data to IndexedDB:', moved.join(', '));
  } catch (e) {
    // IndexedDB unavailable or blocked by an older tab: work from the old localStorage data, read-only.
    console.error(e);
    failed = e?.message || BLOCKED_MSG;
    for (const [k, v] of Object.entries(readLegacy())) if (!cache.has(k)) cache.set(k, v);
  }
}

export const kvReady = load();
export const kvError = () => failed;

export const kv = {
  get: (key, fallback) => (cache.has(key) ? cache.get(key) : fallback),
  async set(key, value) {
    cache.set(key, value);
    listeners.forEach((fn) => fn(key));
    try {
      await kvStore.put({ key, value });
      return true;
    } catch (e) {
      console.error(e);
      return false;
    }
  },
  async remove(key) {
    cache.delete(key);
    listeners.forEach((fn) => fn(key));
    try { await kvStore.remove(key); } catch (e) { console.error(e); }
  },
  entries: () => Object.fromEntries([...cache].filter(([k]) => k !== 'dataVersion')),
  async replaceAll(obj) {
    for (const [k, v] of Object.entries(obj || {})) await kv.set(k, v);
  },
  onChange: (fn) => listeners.add(fn),
};
