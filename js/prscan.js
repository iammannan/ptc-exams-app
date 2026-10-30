// Practicals → Scan (from app): reads the Android app's form QR codes (Saved → QR) with this computer's camera.
// The app's FormQrCodec v2 puts the complete .ptcexams form (JSON → gzip → Base64) into numbered parts, each a plain-text QR:
//   PTCEXAMS QR v2 / Form: <college-course-subject> / Form ID: <12 hex> / Part: i/n / <up to 800 Base64 characters>
// A form is handed over once all n parts are scanned and the Form ID (first 6 bytes of SHA-256 over the joined Base64)
// matches — the same check the app's own scanner makes, so a half-scanned or mixed-up set is never imported.
import { $, esc, loadScript } from './util.js';

const JSQR = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
const HEADER = 'PTCEXAMS QR v2';
let jsqrP;
const loadJsQr = () => (jsqrP ??= loadScript(JSQR).then(() => window.jsQR));

export function decodePart(raw) {
  const lines = String(raw).replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines[0] !== HEADER) throw new Error(/^PTCEXAMS QR v\d/.test(lines[0] || '') ? 'this QR is from an older version of the app — update the app and show its QR again' : 'not a PTC Exams form QR code');
  if (lines.length < 5) throw new Error('incomplete QR code');
  const field = (line, key) => {
    if (!line.startsWith(key + ': ')) throw new Error(`QR is missing "${key}"`);
    return line.slice(key.length + 2).trim();
  };
  const name = field(lines[1], 'Form'), id = field(lines[2], 'Form ID');
  const m = field(lines[3], 'Part').match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!m || +m[2] < 1 || +m[1] < 1 || +m[1] > +m[2]) throw new Error('invalid part number');
  return { formId: id, formName: name, index: +m[1], total: +m[2], data: lines.slice(4).join('') };
}

const hex = (buf, n) => [...new Uint8Array(buf).slice(0, n)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Joins parts 1…n, checks the Form ID and returns the form (the .ptcexams JSON object). */
export async function assemble(parts, formId) {
  const payload = parts.map((p) => p.data).join('');
  if (hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload)), 6) !== formId) throw new Error("the scanned QR codes don't match the form");
  const gz = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
  const json = await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  return JSON.parse(json);
}

let stream = null, timer = 0, forms = new Map(), onForm = null, lastText = '';
const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

function beep() {
  try {
    const a = new AudioContext(), o = a.createOscillator(), g = a.createGain();
    o.frequency.value = 880; g.gain.value = 0.08;
    o.connect(g).connect(a.destination); o.start(); o.stop(a.currentTime + 0.12);
    o.onended = () => a.close();
  } catch { /* no sound is fine */ }
}
function say(text, kind = '') {
  $('scanMsg').textContent = text;
  $('scanMsg').className = 'scan-msg' + (kind ? ' ' + kind : '');
}
function renderForms() {
  $('scanForms').innerHTML = [...forms.values()].reverse().map((f) => {
    const chips = Array.from({ length: f.total }, (_, i) => `<span class="badge${f.parts.has(i + 1) ? ' ok' : ''}">${i + 1}</span>`).join(' ');
    const missing = Array.from({ length: f.total }, (_, i) => i + 1).filter((i) => !f.parts.has(i));
    const state = f.done ? '<span class="badge ok">Imported ✓</span>' : `<span class="muted">Missing QR: ${missing.join(', ')}</span>`;
    return `<div class="result"><div class="r-main"><b>${esc(f.name)}</b> <span class="muted">Form ID ${esc(f.id)}</span><br>QR ${chips} ${state}</div></div>`;
  }).join('');
}

async function handle(text) {
  let p;
  try { p = decodePart(text); } catch (e) { return say(`Could not read that QR: ${e.message}`, 'err'); }
  const f = forms.get(p.formId) || forms.set(p.formId, { id: p.formId, name: p.formName, total: p.total, parts: new Map(), done: false }).get(p.formId);
  if (f.done) return say(`${f.name} is already imported.`);
  if (p.total !== f.total) return say(`${f.name}: this QR is from a different version of the form. Show the latest QR on the phone.`, 'err');
  if (f.parts.has(p.index)) return say(`${f.name}: QR ${p.index} was already scanned.`);
  f.parts.set(p.index, p);
  beep();
  if (f.parts.size < f.total) {
    say(`${f.name}: QR ${p.index} of ${p.total} scanned. Show the next one (Next on the phone).`, 'ok');
    return renderForms();
  }
  let form;
  try {
    form = await assemble(Array.from({ length: f.total }, (_, i) => f.parts.get(i + 1)), f.id);
  } catch (e) {
    f.parts.clear();
    lastText = '';
    renderForms();
    return say(`${f.name}: ${e.message || 'the form could not be read'}. Scan its QR codes again.`, 'err');
  }
  f.done = true;
  renderForms();
  say(`${f.name}: all ${f.total} QR code(s) scanned — importing…`, 'ok');
  await onForm(form, f);
  say(`${f.name}: imported. Show the next form's QR, or click Done.`, 'ok');
}

function tick() {
  const v = $('scanVideo');
  if (v.readyState >= 2 && v.videoWidth) {
    const s = Math.min(1, 1280 / v.videoWidth); // a part is a dense QR (about 100×100 modules): keep every pixel of a 720p camera
    canvas.width = Math.round(v.videoWidth * s);
    canvas.height = Math.round(v.videoHeight * s);
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const hit = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
    if (hit?.data && hit.data !== lastText) { // the QR still held up after its beep is not read again
      lastText = hit.data;
      clearInterval(timer); timer = 0;
      return handle(hit.data).catch((e) => say(e.message || String(e), 'err')).finally(() => { if (stream) timer = setInterval(tick, 150); });
    }
  }
}

async function startCamera(deviceId) {
  stopCamera();
  say('Starting the camera…');
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: deviceId ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } } : { width: { ideal: 1280 }, height: { ideal: 720 } },
    });
  } catch (e) {
    stream = null;
    return say(e?.name === 'NotAllowedError' ? 'Camera permission was refused. Allow the camera for this site (the camera icon in the address bar) and open Scan again.'
      : e?.name === 'NotFoundError' ? 'No camera found on this computer.'
      : !navigator.mediaDevices ? 'The camera needs the app opened over https (or localhost).'
      : `Could not start the camera: ${e?.message || e}`, 'err');
  }
  const v = $('scanVideo');
  v.srcObject = stream;
  await v.play().catch(() => {});
  // list the cameras once permission is given (labels are empty before that)
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  const current = stream.getVideoTracks()[0]?.getSettings().deviceId;
  $('scanCam').innerHTML = cams.map((c, i) => `<option value="${esc(c.deviceId)}"${c.deviceId === current ? ' selected' : ''}>${esc(c.label || `Camera ${i + 1}`)}</option>`).join('');
  $('scanCamWrap').hidden = cams.length < 2;
  say(forms.size ? 'Show the next QR to the camera.' : 'Show a form QR from the phone to the camera.');
  timer = setInterval(tick, 150);
}
function stopCamera() {
  clearInterval(timer); timer = 0;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  $('scanVideo').srcObject = null;
}

/** Opens the scanner. onComplete(form, { name, id }) runs for each fully scanned, verified form. */
export async function openScanner(onComplete) {
  onForm = onComplete;
  forms = new Map();
  lastText = '';
  renderForms();
  $('scanDlg').showModal();
  say('Loading the QR reader…');
  try { await loadJsQr(); } catch { return say('Could not load the QR reader. Check the internet connection and try again.', 'err'); }
  if ($('scanDlg').open) await startCamera();
}

$('scanCam').addEventListener('change', () => startCamera($('scanCam').value));
$('scanDlg').addEventListener('close', stopCamera);
$('scanDone').addEventListener('click', () => $('scanDlg').close());
$('scanClose').addEventListener('click', () => $('scanDlg').close());
