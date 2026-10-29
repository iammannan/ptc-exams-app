// Other Tools tab: separate browser tools for exam work, each shown from its own site (so it stays as up to date as its
// repository) and loaded only when you open the tab. Add a tool to TOOLS to list it.
import { $, esc, pref } from './util.js';

const TOOLS = [
  {
    id: 'qpcropper',
    name: 'QP Cropper',
    desc: 'Crop the empty margins off PDF pages and put 2, 3 or 4 pages on one sheet, to print question papers with less paper.',
    url: 'https://iammannan.github.io/qp-cropper/',
    repo: 'https://github.com/iammannan/qp-cropper',
  },
];

let current = TOOLS.find((t) => t.id === pref.get('tool')) || TOOLS[0];

function renderList() {
  $('toolList').innerHTML = TOOLS.map((t) => `<button type="button" role="tab" class="tool-card${t === current ? ' active' : ''}" aria-selected="${t === current}" data-tool="${esc(t.id)}">
      <b>${esc(t.name)}</b><span>${esc(t.desc)}</span></button>`).join('');
}
function show(load) {
  $('toolTitle').textContent = current.name;
  $('toolOpen').href = current.url;
  $('toolRepo').href = current.repo;
  $('toolFrame').title = current.name;
  if (load && $('toolFrame').dataset.src !== current.url) { $('toolFrame').src = current.url; $('toolFrame').dataset.src = current.url; }
}

renderList();
show(false);
// load the tool whenever the tab is shown (also when the app opens on it)
new MutationObserver(() => { if (!$('tab-tools').hidden) show(true); }).observe($('tab-tools'), { attributes: true, attributeFilter: ['hidden'] });
if (!$('tab-tools').hidden) show(true);
$('toolList').addEventListener('click', (e) => {
  const id = e.target.closest('[data-tool]')?.dataset.tool;
  const t = TOOLS.find((x) => x.id === id);
  if (!t || t === current) return;
  current = t;
  pref.set('tool', t.id);
  renderList();
  show(true);
});
