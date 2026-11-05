// Service worker: lets PTC Exams App be installed and keep working without internet.
// - The page itself (index.html) comes from the network first, so a new release shows up on the next load;
//   offline, the copy saved last time is used.
// - The app's CSS and JS carry the release version (?v=…), so a saved copy is always the right one: cache first.
// - The libraries (pdf.js, jsPDF, ExcelJS, JSZip, jsQR) are pinned versions on the CDN: saved once, kept across releases.
// - The manifest and icons come from the network, else the saved copy.
// - Anything else (the view counter) goes straight to the network and simply fails offline.
// The lists below are written by tools/stamp.mjs; do not edit them by hand.
// stamp:start
const VERSION = 'fd00ec55ee';
const APP_FILES = [
  "./",
  "./css/styles.css?v=fd00ec55ee",
  "./js/app.js?v=fd00ec55ee",
  "./js/attmark.js?v=fd00ec55ee",
  "./js/attphotos.js?v=fd00ec55ee",
  "./js/data/equivalents.js?v=fd00ec55ee",
  "./js/data/timetable.js?v=fd00ec55ee",
  "./js/eqeditor.js?v=fd00ec55ee",
  "./js/equiv.js?v=fd00ec55ee",
  "./js/halltickets.js?v=fd00ec55ee",
  "./js/htparser.js?v=fd00ec55ee",
  "./js/kv.js?v=fd00ec55ee",
  "./js/nrhighlight.js?v=fd00ec55ee",
  "./js/parser.js?v=fd00ec55ee",
  "./js/practicals.js?v=fd00ec55ee",
  "./js/prscan.js?v=fd00ec55ee",
  "./js/pwa.js?v=fd00ec55ee",
  "./js/qp.js?v=fd00ec55ee",
  "./js/qpcalc.js?v=fd00ec55ee",
  "./js/seating.js?v=fd00ec55ee",
  "./js/settings.js?v=fd00ec55ee",
  "./js/stickers.js?v=fd00ec55ee",
  "./js/store.js?v=fd00ec55ee",
  "./js/tools.js?v=fd00ec55ee",
  "./js/ttparser.js?v=fd00ec55ee",
  "./js/util.js?v=fd00ec55ee",
  "./js/views.js?v=fd00ec55ee",
  "./js/warnings.js?v=fd00ec55ee",
  "./manifest.webmanifest",
  "./icons/apple-touch-icon.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png"
];
const CDN_FILES = [
  "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js",
  "https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.4/dist/jspdf.plugin.autotable.min.js",
  "https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js",
  "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js",
  "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js",
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs",
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs"
];
// stamp:end

const APP = `ptc-app-${VERSION}`;
const CDN = 'ptc-cdn';
const PAGE = new URL('./', self.location).href;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(APP).then((c) => c.addAll(APP_FILES)));
  self.skipWaiting(); // the page checks for a new release itself and offers a reload
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('ptc-app-') && key !== APP) await caches.delete(key);
    // the libraries: drop versions no longer used, save the ones not saved yet (a failure only means "next time")
    const cdn = await caches.open(CDN);
    for (const req of await cdn.keys()) if (!CDN_FILES.includes(req.url)) await cdn.delete(req);
    await Promise.all(CDN_FILES.map(async (url) => {
      if (await cdn.match(url)) return;
      try { const res = await fetch(url, { mode: 'cors' }); if (res.ok) await cdn.put(url, res); } catch {}
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (req.mode === 'navigate' && url.origin === self.location.origin) event.respondWith(page(req));
  else if (url.origin === self.location.origin) event.respondWith(url.searchParams.has('v') ? saved(req, APP) : fresh(req));
  else if (url.hostname === 'cdn.jsdelivr.net') event.respondWith(saved(req, CDN));
});

// Unversioned files of the app (manifest, icons, the page fetched to look for a new release): network, else saved copy.
async function fresh(req) {
  try { return await fetch(req); } catch { return (await caches.match(req, { ignoreSearch: true })) || Response.error(); }
}

async function page(req) {
  const cache = await caches.open(APP);
  try {
    const res = await fetch(req, { cache: 'no-cache' }); // skip the 10-minute browser cache: always the live release
    if (res.ok) await cache.put(PAGE, res.clone());
    return res;
  } catch {
    return (await cache.match(PAGE)) || (await caches.match(PAGE)) || Response.error();
  }
}

async function saved(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') await cache.put(req, res.clone());
  return res;
}
