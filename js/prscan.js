// Practicals → Scan (from app): reads the Android app's session QR codes (Saved → QR) with this computer's camera.
// One QR per timetable session, plain text (the app's FormQrCodec):
//   PTCEXAMS QR v1 / Form ID: <8 hex> / Session No: i/n / College Code / Course Code / Subject Code / Date / Session /
//   Reg No (<count>): <reg>, <reg>, …
// A subject is handed over once all n sessions of its form are scanned and the Form ID, recomputed from them, matches —
// the same check the app's own scanner makes, so a half-scanned or mixed-up set is never imported.
import { $, esc, loadScript } from './util.js';

const JSQR = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
const HEADER = 'PTCEXAMS QR v1';
let jsqrP;
const loadJsQr = () => (jsqrP ??= loadScript(JSQR).then(() => window.jsQR));

export function decodeSessionQr(raw) {
  const lines = String(raw).replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines[0] !== HEADER) throw new Error('not a PTC Exams form QR code');
  const f = {};
  let regNos = null;
  for (const line of lines.slice(1)) {
    const reg = line.match(/^Reg No \((\d+)\):\s*(.*)$/);
    if (reg) {
      regNos = reg[2].split(',').map((r) => r.trim()).filter(Boolean);
      if (regNos.length !== +reg[1]) throw new Error(`register number count mismatch (${reg[1]} expected, ${regNos.length} read)`);
    } else {
      const i = line.indexOf(': ');
      if (i > 0) f[line.slice(0, i)] = line.slice(i + 2).trim();
    }
  }
  for (const k of ['Form ID', 'Session No', 'College Code', 'Course Code', 'Subject Code']) if (!f[k]) throw new Error(`QR is missing "${k}"`);
  const sn = f['Session No'].match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!sn || +sn[2] < 1 || +sn[1] < 1 || +sn[1] > +sn[2]) throw new Error('invalid session number');
  if (!regNos) throw new Error('QR is missing register numbers');
  return {
    formId: f['Form ID'], index: +sn[1], total: +sn[2], collegeCode: f['College Code'], courseCode: f['Course Code'],
    subjectCode: f['Subject Code'], date: f.Date || '', session: f.Session || '', regNos,
  };
}

// The app's FormQrCodec.formId: first 4 bytes of SHA-1 over college|course|subject|n|date~session|…
async function formId(sessions) {
  const s0 = sessions[0];
  const key = [s0.collegeCode, s0.courseCode, s0.subjectCode, sessions.length, ...sessions.map((s) => `${s.date}~${s.session}`)].join('|');
  const d = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(key)));
  return [...d.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('');
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
    const chips = Array.from({ length: f.total }, (_, i) => `<span class="badge${f.sessions.has(i + 1) ? ' ok' : ''}">${i + 1}</span>`).join(' ');
    const missing = Array.from({ length: f.total }, (_, i) => i + 1).filter((i) => !f.sessions.has(i));
    const state = f.done ? '<span class="badge ok">Imported ✓</span>' : `<span class="muted">Missing session(s): ${missing.join(', ')}</span>`;
    return `<div class="result"><div class="r-main"><b>${esc(f.course)} · ${esc(f.code)}</b> <span class="muted">Form ID ${esc(f.id)}</span><br>Sessions ${chips} ${state}</div></div>`;
  }).join('');
}

async function handle(text) {
  let qr;
  try { qr = decodeSessionQr(text); } catch (e) { return say(e.message, 'err'); }
  const f = forms.get(qr.formId) || forms.set(qr.formId, { id: qr.formId, total: qr.total, course: qr.courseCode, code: qr.subjectCode, sessions: new Map(), done: false }).get(qr.formId);
  const who = `${qr.courseCode} · ${qr.subjectCode}`;
  if (f.done) return say(`${who} is already imported.`);
  if (qr.total !== f.total) return say(`${who}: this QR is from a different version of the form. Show the latest QR on the phone.`, 'err');
  if (f.sessions.has(qr.index)) return say(`${who}: session ${qr.index} was already scanned.`);
  f.sessions.set(qr.index, qr);
  beep();
  if (f.sessions.size < f.total) {
    say(`${who}: session ${qr.index} of ${qr.total} scanned. Show the next session (Next on the phone).`, 'ok');
    return renderForms();
  }
  const sessions = Array.from({ length: f.total }, (_, i) => f.sessions.get(i + 1));
  if ((await formId(sessions)) !== f.id) {
    f.sessions.clear();
    lastText = '';
    renderForms();
    return say(`${who}: the scanned sessions don't match the form. Scan its sessions again.`, 'err');
  }
  f.done = true;
  renderForms();
  say(`${who}: all ${f.total} session(s) scanned — importing…`, 'ok');
  await onForm(sessions);
  say(`${who}: imported. Show the next subject's QR, or click Done.`, 'ok');
}

function tick() {
  const v = $('scanVideo');
  if (v.readyState >= 2 && v.videoWidth) {
    const s = Math.min(1, 1000 / v.videoWidth); // enough pixels for a dense QR, small enough to decode quickly
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
  say(forms.size ? 'Show the next QR to the camera.' : 'Show a session QR from the phone to the camera.');
  timer = setInterval(tick, 150);
}
function stopCamera() {
  clearInterval(timer); timer = 0;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  $('scanVideo').srcObject = null;
}

/** Opens the scanner. onComplete(sessions) runs for each fully scanned, verified form (sessions in order 1…n). */
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
