// Page view counter (Firebase Realtime Database): "N Today" and "N+ Total Views" in the top bar.
// The Firebase settings live in js/firebase-config.js, which is git-ignored (copy
// js/firebase-config.example.js). Without it the counter simply stays hidden.
// Data: views/total and views/days/<YYYY-MM-DD, India time>; database.rules.json only lets
// visitors read the counts and add exactly 1 to them.
import { $ } from './util.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // 2026-10-20
const fmt = (n) => Number(n || 0).toLocaleString('en-IN'); // 100995 → 1,00,995
// Views from a local copy of the app (development) are shown but not counted.
const counts = !['localhost', '127.0.0.1', '[::1]', ''].includes(location.hostname);

export function showViews(day, total) {
  $('viewsToday').textContent = fmt(day);
  $('viewsTotal').textContent = `${fmt(total)}+`;
  $('views').hidden = false;
}

async function start() {
  let config;
  try {
    config = (await import('./firebase-config.js')).default;
  } catch {
    return; // no config on this copy of the app
  }
  if (!config?.databaseURL) return;
  const [{ initializeApp }, db] = await Promise.all([import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-database.js`)]);
  const { getDatabase, ref, onValue, update, increment } = db;
  const database = getDatabase(initializeApp(config, 'views'));
  const day = today();
  if (counts) await update(ref(database, 'views'), { total: increment(1), [`days/${day}`]: increment(1) }).catch((e) => console.warn('View not counted', e));

  // Keep both numbers live while the page is open.
  const n = { day: 0, total: 0 };
  onValue(ref(database, `views/days/${day}`), (s) => { n.day = s.val() || 0; showViews(n.day, n.total); });
  onValue(ref(database, 'views/total'), (s) => { n.total = s.val() || 0; showViews(n.day, n.total); });
}

start().catch((e) => console.warn('View counter unavailable', e));
