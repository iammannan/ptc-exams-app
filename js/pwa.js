// Installable app (PWA): registers sw.js, tells you when a new release is out, and offers Install in Settings.
// A new release is noticed by reading the live page's version tag (?v=… on app.js) and comparing it with this one.
import { $ } from './util.js';

const mine = new URL(import.meta.url).searchParams.get('v');
const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
let shown = false;

async function checkForUpdate() {
  if (shown || !mine || !navigator.onLine) return;
  try {
    const html = await (await fetch('./', { cache: 'no-cache' })).text();
    const live = html.match(/js\/app\.js\?v=(\w+)/)?.[1];
    if (live && live !== mine) {
      shown = true;
      $('updateBar').hidden = false;
    }
  } catch { /* offline: try again later */ }
}

if ('serviceWorker' in navigator && (location.protocol === 'https:' || local)) {
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    setInterval(() => { reg.update().catch(() => {}); checkForUpdate(); }, 30 * 60 * 1000);
  }).catch((e) => console.error('Service worker not registered', e));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForUpdate(); });
  window.addEventListener('online', checkForUpdate);
  checkForUpdate();
}
$('updateReload').addEventListener('click', () => location.reload());
$('updateLater').addEventListener('click', () => { $('updateBar').hidden = true; });

/* ---------- Settings → Install as an app ---------- */
const installed = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
let prompt = null;
function renderInstall() {
  $('installBtn').hidden = !prompt;
  $('installNote').textContent = installed()
    ? 'You are using the installed app.'
    : prompt
      ? 'Install it to open PTC Exams App from its own icon, in its own window, even without internet.'
      : 'To install: Chrome or Edge on a computer, the install icon at the right of the address bar (or menu → Install PTC Exams App); on Android, menu → Add to Home screen; on iPhone, Share → Add to Home Screen.';
}
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  prompt = e;
  renderInstall();
});
window.addEventListener('appinstalled', () => { prompt = null; renderInstall(); });
$('installBtn').addEventListener('click', async () => {
  if (!prompt) return;
  prompt.prompt();
  await prompt.userChoice;
  prompt = null;
  renderInstall();
});
renderInstall();
