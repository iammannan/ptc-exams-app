// Tiny IndexedDB wrapper — all data stays in this browser.
// v3 adds "kv": one record per app setting / dataset (halls, seating, set dates, mappings, candidate edits).
const DB_NAME = 'ptc-exams';
const DB_VERSION = 3;
const STORES = ['rolls', 'halltickets'];

export const BLOCKED_MSG = 'The app was updated. Close every other tab of PTC Exams App, then reload this page.';

let dbp;
let blocked = false;
let waiters = []; // reject callbacks of calls waiting on a blocked open

function open() {
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      for (const name of STORES)
        if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name, { keyPath: 'fileName' });
      if (!req.result.objectStoreNames.contains('kv')) req.result.createObjectStore('kv', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const d = req.result;
      // Step aside when a newer version of the app (in another tab) needs to upgrade the database.
      d.onversionchange = () => {
        d.close();
        dbp = null;
      };
      blocked = false;
      waiters = [];
      resolve(d);
    };
    req.onerror = () => {
      dbp = null;
      reject(req.error);
    };
    // An older version of the app open in another tab holds the database, so the upgrade can't run.
    // The request stays pending (and succeeds once that tab closes); meanwhile fail callers fast.
    req.onblocked = () => {
      blocked = true;
      waiters.forEach((fail) => fail());
      waiters = [];
    };
  });
}

function db() {
  if (!dbp) open();
  if (blocked) return Promise.reject(new Error(BLOCKED_MSG));
  return new Promise((resolve, reject) => {
    dbp.then(resolve, reject);
    waiters.push(() => reject(new Error(BLOCKED_MSG)));
  });
}

function makeStore(name) {
  async function tx(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(name, mode);
      const out = fn(t.objectStore(name));
      t.oncomplete = () => resolve(out?.result ?? out);
      t.onerror = () => reject(t.error);
    });
  }
  return {
    all: () => tx('readonly', (s) => s.getAll()),
    put: (rec) => tx('readwrite', (s) => s.put(rec)),
    remove: (id) => tx('readwrite', (s) => s.delete(id)),
    clear: () => tx('readwrite', (s) => s.clear()),
  };
}

export const store = makeStore('rolls');
export const htStore = makeStore('halltickets');
export const kvStore = makeStore('kv');
