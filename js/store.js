// Tiny IndexedDB wrapper — all data stays in this browser.
const DB_NAME = 'ptc-exams';
const STORE = 'rolls';

let dbp;
function db() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'fileName' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
  });
}

export const store = {
  all: () => tx('readonly', (s) => s.getAll()),
  put: (roll) => tx('readwrite', (s) => s.put(roll)),
  remove: (fileName) => tx('readwrite', (s) => s.delete(fileName)),
  clear: () => tx('readwrite', (s) => s.clear()),
};
