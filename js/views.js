// Page view counter (counterapi.dev): "N Today" and "N+ Total Views" in the top bar.
// Uses one public CounterAPI counter, so no API key is needed in the browser.
// Set WORKSPACE / COUNTER to the workspace and public counter created at counterapi.dev;
// while WORKSPACE is empty the counter stays hidden.
import { $ } from './util.js';

const WORKSPACE = 'ptc-page-views';
const COUNTER = 'ptc-page-views';
const API = 'https://api.counterapi.dev/v2';

const fmt = (n) => Number(n || 0).toLocaleString('en-IN'); // 100995 → 1,00,995
// Views from a local copy of the app (development) are shown but not counted.
const counts = !['localhost', '127.0.0.1', '[::1]', ''].includes(location.hostname);

export function showViews(day, total) {
  $('viewsToday').textContent = fmt(day);
  $('viewsTotal').textContent = `${fmt(total)}+`;
  $('views').hidden = false;
}

async function start() {
  if (!WORKSPACE) return;
  const url = `${API}/${encodeURIComponent(WORKSPACE)}/${encodeURIComponent(COUNTER)}`;
  if (counts) await fetch(`${url}/up`).catch((e) => console.warn('View not counted', e));
  // Stats carry the running total and today's count (CounterAPI's day starts at 00:00 UTC).
  const res = await fetch(`${url}/stats`);
  if (!res.ok) return;
  const { data } = await res.json();
  showViews(data?.stats?.today?.up, (data?.up_count || 0) - (data?.down_count || 0));
}

start().catch((e) => console.warn('View counter unavailable', e));
