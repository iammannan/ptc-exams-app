// Settings tab: light / dark mode, storage used, and export / import of all app data.
import { store, htStore, kvStore } from './store.js';
import { kv } from './kv.js';
import { $, esc, toast, pref, download, drawCaptcha } from './util.js';
import { setDatesReload } from './halltickets.js';
import { seatingReload } from './seating.js';
import { equivReload } from './equiv.js';

/* ---------- theme ---------- */
// The choice is applied by a tiny script in <head> too, so the page never flashes the wrong theme.
function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  $('themePick').querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', b.dataset.theme === (t || 'system')));
}
$('themePick').addEventListener('click', (e) => {
  const t = e.target.closest('[data-theme]')?.dataset.theme;
  if (!t) return;
  pref.set('theme', t === 'system' ? '' : t);
  applyTheme(t);
});
applyTheme(pref.get('theme'));

/* ---------- storage used ---------- */
const size = (v) => new Blob([JSON.stringify(v ?? null)]).size;
const fmt = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : b < 1073741824 ? `${(b / 1048576).toFixed(2)} MB` : `${(b / 1073741824).toFixed(2)} GB`);
const KV_LABEL = {
  halls: 'Halls', plans: 'Seat allocations', extras: 'Subjects added to seating', customDays: 'Custom exam dates',
  setDates: 'Exam dates set by you', equiv: 'Equivalent subject mappings', studentEdits: 'Candidate edits', timetable: 'Revised time table', crossCourse: 'Other-course subjects added / held', qpRemoved: 'Subjects removed from a session', equivTable: 'Uploaded equivalents table', qpMerges: 'Merged course codes', prImports: 'Imported practical exam files', examSet: 'End Exam (theory / practical) set by you',
};
async function renderUsage() {
  const [rolls, hts] = await Promise.all([store.all(), htStore.all()]);
  const rows = [
    ['Nominal rolls', `${rolls.length} file(s) · ${rolls.reduce((n, r) => n + r.students.length, 0).toLocaleString('en-IN')} students`, size(rolls)],
    ['Hall tickets', `${hts.length} file(s) · ${hts.reduce((n, r) => n + r.tickets.length, 0).toLocaleString('en-IN')} tickets`, size(hts)],
    ...Object.entries(kv.entries()).map(([k, v]) => [KV_LABEL[k] || k, '', size(v)]),
  ];
  const total = rows.reduce((n, r) => n + r[2], 0);
  let est = null;
  try { est = await navigator.storage?.estimate?.(); } catch {}
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  // Overall meter: what this site uses out of what the browser allows it (app data when the browser counts less).
  const used = Math.max(est?.usage || 0, total);
  const pct = est?.quota ? (used / est.quota) * 100 : 0;
  const pctText = pct >= 1 ? pct.toFixed(0) : pct >= 0.01 ? pct.toFixed(2) : pct > 0 ? '< 0.01' : '0';
  $('usage').innerHTML = `
    <div class="usage-total"><b>${fmt(total)}</b> of app data${est?.quota ? ` · the browser counts <b>${fmt(est.usage)}</b> used by this site, out of about <b>${fmt(est.quota)}</b> it allows` : ''}</div>
    ${est?.quota ? `<div class="usage-meter${pct >= 80 ? ' warn' : ''}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct.toFixed(2)}" aria-label="Storage used">
      <div class="track"><span style="width:${Math.min(100, Math.max(pct, 0.6))}%"></span></div>
      <div class="usage-meter-text"><b>${pctText}%</b> used · <b>${fmt(used)}</b> of ${fmt(est.quota)} · ${fmt(Math.max(0, est.quota - used))} free</div>
    </div>` : ''}
    <table class="data"><tbody>${rows
      .map(([l, d, b]) => `<tr><td>${esc(l)}</td><td class="muted">${esc(d)}</td><td class="num">${fmt(b)}</td><td class="bar-cell"><span class="ubar" style="width:${total ? Math.max(1, (b / total) * 100) : 0}%"></span></td></tr>`)
      .join('')}</tbody></table>
    <p class="muted">${persisted ? 'Storage is marked persistent: the browser will not clear it on its own.' : 'The browser may clear this data if the disk gets full or site data is cleared. Export a backup regularly.'}</p>`;
}
$('usageRefresh').addEventListener('click', renderUsage);
document.querySelector('[data-tab="settings"]').addEventListener('click', renderUsage);
// Ask the browser not to evict the data on its own (granted silently for sites in regular use).
navigator.storage?.persist?.().catch(() => {});

/* ---------- export / import ---------- */
let reloadAll = async () => {};
export function initSettings({ reload }) {
  reloadAll = reload;
}

async function exportAll() {
  const [rolls, halltickets] = await Promise.all([store.all(), htStore.all()]);
  const data = { app: 'ptc-exams', version: 3, exportedAt: new Date().toISOString(), rolls, halltickets, kv: kv.entries() };
  download(`ptc-exams-backup-${new Date().toISOString().slice(0, 10)}.json`, new Blob([JSON.stringify(data)], { type: 'application/json' }));
  toast('Backup downloaded');
}

// Version 2 backups (old app) carried seating and set dates separately; map them onto kv keys.
function kvFromBackup(data) {
  if (data.kv && typeof data.kv === 'object') return data.kv;
  const out = {};
  if (data.seating && Array.isArray(data.seating.halls)) {
    out.halls = data.seating.halls;
    out.plans = data.seating.plans || {};
    if (data.seating.extras) out.extras = data.seating.extras;
    if (data.seating.customDays) out.customDays = data.seating.customDays;
  }
  if (data.setDates) {
    out.setDates = {};
    for (const [code, x] of Object.entries(data.setDates)) out.setDates[code] = x?.slots ? x : x?.date ? { slots: [{ date: x.date, slot: x.session || 'FN' }] } : x;
  }
  return out;
}

async function importAll(e) {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.app && data.app !== 'ptc-exams') throw new Error();
    if (!Array.isArray(data.rolls)) throw new Error();
    const hts = Array.isArray(data.halltickets) ? data.halltickets : [];
    for (const r of data.rolls) await store.put(r);
    for (const r of hts) await htStore.put(r);
    await kv.replaceAll(kvFromBackup(data));
    setDatesReload();
    equivReload();
    seatingReload();
    await reloadAll();
    renderUsage();
    toast(`Imported ${data.rolls.length} nominal roll(s) and ${hts.length} hall ticket file(s)${data.version < 3 ? ' (older backup converted)' : ''}`);
  } catch (err) {
    console.error(err);
    toast('That is not a valid PTC Exams backup');
  }
}
$('backupBtn').addEventListener('click', exportAll);
$('restoreInput').addEventListener('change', importAll);

/* ---------- reset all data (confirmed with a typed code) ---------- */
let captcha = '';
function newCaptcha() {
  captcha = drawCaptcha($('captchaImg'));
  $('captchaInput').value = '';
  $('resetBtn').disabled = true;
}
$('captchaNew').addEventListener('click', newCaptcha);
$('captchaInput').addEventListener('input', () => {
  $('resetBtn').disabled = $('captchaInput').value.trim().toUpperCase() !== captcha;
});
$('resetBackup').addEventListener('click', exportAll);
$('resetBtn').addEventListener('click', async () => {
  if ($('captchaInput').value.trim().toUpperCase() !== captcha) return newCaptcha();
  $('resetBtn').disabled = true;
  try {
    await Promise.all([store.clear(), htStore.clear(), kvStore.clear()]);
    // keep only the theme; drop other saved preferences (last tab, filters, …)
    for (const k of Object.keys(localStorage)) if (k.startsWith('ptc.') && k !== 'ptc.theme') localStorage.removeItem(k);
    toast('All data reset');
    setTimeout(() => location.reload(), 600);
  } catch (e) {
    console.error(e);
    toast('Could not reset: ' + (e.message || e));
    newCaptcha();
  }
});
newCaptcha();
