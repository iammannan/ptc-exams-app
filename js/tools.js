// Other Tools tab: separate browser tools for exam work. Each one is its own site (so it stays as up to date as its
// repository) and opens in a new tab. Add a tool to TOOLS to list it.
import { $, esc } from './util.js';

const TOOLS = [
  {
    name: 'QP Cropper',
    desc: 'Crop the empty margins off PDF pages and put several pages on one sheet (by default 3 on the first sheet, then 2, so a 5-page question paper prints on 2 sheets).',
    url: 'https://iammannan.github.io/qp-cropper/',
    repo: 'https://github.com/iammannan/qp-cropper',
  },
];

const NEW_TAB = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';

$('toolList').innerHTML = TOOLS.map((t) => `<div class="tool-card">
    <b>${esc(t.name)}</b><span>${esc(t.desc)}</span>
    <div class="actions">
      <a class="btn primary" href="${esc(t.url)}" target="_blank" rel="noopener" title="Open ${esc(t.name)} in a new tab">Open ${esc(t.name)} ${NEW_TAB}</a>
      <a class="btn ghost sm" href="${esc(t.repo)}" target="_blank" rel="noopener">Source on GitHub</a>
    </div>
  </div>`).join('');
