// Other Tools tab: separate browser tools for exam work. Each one is its own site and opens in a new tab.
// Add a tool to TOOLS to list it (repo only if it has a public one).
import { $, esc } from './util.js';

const TOOLS = [
  {
    name: 'QP Cropper',
    desc: 'Crop the empty margins off PDF pages and put several pages on one sheet (by default 3 on the first sheet, then 2, so a 5-page question paper prints on 2 sheets). Runs in your browser: files you open in it are not uploaded anywhere.',
    url: 'https://iammannan.github.io/qp-cropper/',
    repo: 'https://github.com/iammannan/qp-cropper',
  },
  {
    name: 'Label Generator',
    desc: 'Make A4 sticker sheets from a CSV or Excel file: pick an MSM S or R series sheet, preview it, then print or download a PDF. A separate site (Label Crop AI), not part of this app.',
    url: 'https://labelcropai.in/label-generator',
  },
];

const NEW_TAB = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';

$('toolList').innerHTML = TOOLS.map((t) => `<div class="tool-card">
    <b>${esc(t.name)}</b><span>${esc(t.desc)}</span>
    <div class="actions">
      <a class="btn primary" href="${esc(t.url)}" target="_blank" rel="noopener" title="Open ${esc(t.name)} in a new tab">Open ${esc(t.name)} ${NEW_TAB}</a>
      ${t.repo ? `<a class="btn ghost sm" href="${esc(t.repo)}" target="_blank" rel="noopener">Source on GitHub</a>` : ''}
    </div>
  </div>`).join('');
