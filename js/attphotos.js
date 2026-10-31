// Attendance sheets → candidate photos from a folder on this computer, named by register number (26101900.jpg, .png, …).
// Nothing is copied or uploaded: the folder is read when a sheet is made. kv "photoDir" keeps the folder's handle (this
// browser only, left out of backups), so the folder is remembered; browsers show its name, never its full path.
// Browsers without a folder picker (Firefox, Safari) use a folder upload instead, remembered until the page closes.
import { $, esc, pref } from './util.js';
import { kv } from './kv.js';

const PHOTO_PX = 220; // the photo box is 14 mm: enough to print sharply, small enough to keep the PDF light
const canPick = 'showDirectoryPicker' in window;
let files = null; // register number → () => Promise<File>; null until the folder has been read
let folderName = '';
let nested = 0; // folders inside the photo folder (not read)
let regs = []; // this session's candidates, for the count
let unreadable = new Set();
const decoded = new Map(); // register number → { data, w, h } | null

const stem = (name) => name.replace(/\.[^.]+$/, '').trim().toUpperCase();
const wanted = () => $('attPhotoAsk').querySelector('[aria-checked="true"]').dataset.p === 'yes';
const say = (html, kind = '') => { $('attPhotoStatus').innerHTML = html; $('attPhotoStatus').className = 'att-photo-status' + (kind ? ' ' + kind : ''); };

async function readFolder(handle) {
  const found = new Map();
  let inner = 0;
  for await (const entry of handle.values()) {
    if (entry.kind === 'directory') inner++;
    else if (!found.has(stem(entry.name))) found.set(stem(entry.name), () => entry.getFile());
  }
  files = found;
  nested = inner;
  folderName = handle.name;
  decoded.clear();
  unreadable = new Set();
}
function report() {
  $('attPhotoAllow').hidden = true;
  const missing = regs.filter((r) => !files.has(String(r).toUpperCase()));
  const parts = [`<b>${esc(folderName)}</b>${canPick && kv.get('photoDir', null) ? ' (remembered in this browser)' : ''}: photos for <b>${regs.length - missing.length - unreadable.size} of ${regs.length}</b> candidates in this session.`];
  if (missing.length) parts.push(`No photo for: ${esc(missing.slice(0, 12).join(', '))}${missing.length > 12 ? ` and ${missing.length - 12} more` : ''}. Their photo box stays empty.`);
  if (nested) parts.push(`${nested} folder(s) inside it are not read: keep all the photos directly in this folder.`);
  if (unreadable.size) parts.push(`Could not read the photo of: ${esc([...unreadable].join(', '))}. Save it as .jpg or .png.`);
  say(parts.join(' '), missing.length || nested || unreadable.size ? 'warn' : 'ok');
}
// With a remembered folder: read it now if the browser still allows that, else offer the Allow button (it needs a click).
async function refresh() {
  $('attPhotoPanel').hidden = !wanted();
  if (!wanted()) return;
  if (files) return report();
  const handle = kv.get('photoDir', null);
  if (!handle) return say('No folder chosen yet.');
  try {
    if ((await handle.queryPermission({ mode: 'read' })) === 'granted') { await readFolder(handle); return report(); }
    $('attPhotoAllow').hidden = false;
    say(`<b>${esc(handle.name)}</b> is remembered. Click <b>Allow access</b> so the browser lets this page read it again.`);
  } catch (e) {
    console.error(e);
    say(`Could not open <b>${esc(handle.name)}</b>. It may have been moved or renamed: choose the folder again.`, 'err');
  }
}
export function openAttendancePhotos(candidateRegs) {
  regs = candidateRegs;
  decoded.clear(); // photos may have been replaced since the last time
  files = canPick ? null : files;
  const on = pref.get('attPhotos') ? pref.get('attPhotos') === 'yes' : !!kv.get('photoDir', null);
  $('attPhotoAsk').querySelectorAll('[data-p]').forEach((b) => b.setAttribute('aria-checked', (b.dataset.p === 'yes') === on));
  return refresh();
}
// Call first thing in a download click (the browser's permission prompt needs the click). false: nothing to make yet.
export async function attendancePhotosReady() {
  if (!wanted()) return true;
  if (files) return true;
  const handle = kv.get('photoDir', null);
  if (!handle) { say('Choose the photo folder first, or answer No to leave the photo boxes empty.', 'err'); return false; }
  try {
    if ((await handle.requestPermission({ mode: 'read' })) !== 'granted') { say('The browser was not allowed to read the folder. Click Allow access, or answer No.', 'err'); return false; }
    await readFolder(handle);
    report();
    return true;
  } catch (e) {
    console.error(e);
    say(`Could not open <b>${esc(handle.name)}</b>. It may have been moved or renamed: choose the folder again.`, 'err');
    return false;
  }
}
async function decode(file) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, PHOTO_PX / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; // a transparent background prints white
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return { data: c.toDataURL('image/jpeg', 0.82), w: c.width, h: c.height };
}
/** The photos of these register numbers → Map(reg → { data (JPEG data URL), w, h }); empty when the answer is No. */
export async function attendancePhotos(list) {
  const out = new Map();
  if (!wanted() || !files) return out;
  for (const reg of list) {
    const key = String(reg).toUpperCase();
    if (!decoded.has(key)) {
      let photo = null;
      if (files.has(key)) try { photo = await decode(await files.get(key)()); } catch (e) { console.error(key, e); unreadable.add(reg); }
      decoded.set(key, photo);
    }
    if (decoded.get(key)) out.set(reg, decoded.get(key));
  }
  report();
  return out;
}
export async function setPhotoFolder(handle) {
  await kv.set('photoDir', handle);
  await readFolder(handle);
  report();
}

$('attPhotoAsk').addEventListener('click', (e) => {
  const b = e.target.closest('[data-p]');
  if (!b) return;
  $('attPhotoAsk').querySelectorAll('[data-p]').forEach((x) => x.setAttribute('aria-checked', x === b));
  pref.set('attPhotos', b.dataset.p);
  refresh();
});
$('attPhotoAllow').addEventListener('click', attendancePhotosReady);
$('attPhotoPick').addEventListener('click', async () => {
  if (!canPick) return $('attPhotoInput').click();
  try {
    await setPhotoFolder(await window.showDirectoryPicker({ id: 'att-photos', mode: 'read' }));
  } catch (e) {
    if (e?.name !== 'AbortError') { console.error(e); say('The browser would not open that folder. Choose another one, not a system folder such as Downloads or Desktop itself.', 'err'); }
  }
});
$('attPhotoInput').addEventListener('change', (e) => {
  const list = [...e.target.files];
  e.target.value = '';
  if (!list.length) return;
  const found = new Map();
  let inner = new Set();
  for (const f of list) {
    const parts = (f.webkitRelativePath || f.name).split('/');
    if (parts.length > 2) inner.add(parts[1]);
    else if (!found.has(stem(f.name))) found.set(stem(f.name), async () => f);
  }
  files = found;
  nested = inner.size;
  folderName = list[0].webkitRelativePath?.split('/')[0] || 'Photos';
  decoded.clear();
  unreadable = new Set();
  report();
});
