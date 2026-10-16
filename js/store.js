// Tiny IndexedDB wrapper — all data stays in this browser.
const DB_NAME = 'ptc-exams';
const STORES = ['rolls', 'halltickets'];

let dbp;
function db() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      for (const name of STORES)
        if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name, { keyPath: 'fileName' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
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
    remove: (fileName) => tx('readwrite', (s) => s.delete(fileName)),
    clear: () => tx('readwrite', (s) => s.clear()),
  };
}

export const store = makeStore('rolls');
export const htStore = makeStore('halltickets');
