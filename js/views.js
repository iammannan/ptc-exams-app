// Page view counter (Abacus, https://abacus.jasoncameron.dev): "N Today" and "N+ Total Views" in the top bar.
// No account or key: counters are created on first hit. Two counters in our namespace:
// "total" and "day-<YYYY-MM-DD>" (India time, so Today resets at midnight IST).
import { $ } from './util.js';

const API = 'https://abacus.jasoncameron.dev';
const NAMESPACE = 'iammannan-ptc-exams-app';

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // 2026-10-20
const fmt = (n) => Number(n || 0).toLocaleString('en-IN'); // 100995 → 1,00,995
// Views from a local copy of the app (development) are shown but not counted.
const counts = !['localhost', '127.0.0.1', '[::1]', ''].includes(location.hostname);

export function showViews(day, total) {
  $('viewsToday').textContent = fmt(day);
  $('viewsTotal').textContent = `${fmt(total)}+`;
  $('views').hidden = false;
}

// /hit adds 1 (creating the counter if needed); /get only reads, and a counter not hit yet is 0.
async function value(key) {
  const res = await fetch(`${API}/${counts ? 'hit' : 'get'}/${NAMESPACE}/${key}`);
  if (res.status === 404) return 0;
  if (!res.ok) throw new Error(`Abacus ${res.status}`);
  return (await res.json()).value;
}

async function start() {
  const [day, total] = await Promise.all([value(`day-${today()}`), value('total')]);
  showViews(day, total);
}

start().catch((e) => console.warn('View counter unavailable', e));
