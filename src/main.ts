import './style.css';
import { parseSpec, diffSpecs, countChanges, toMarkdown, type Change, type Area, type Counts } from './review';

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector<T>(s)!;
const esc = (s: any) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
// Render the plain-English one-liners: `code spans` become <code>, **bold** becomes <strong>.
const md = (s: string) => esc(s)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
const val = (s: string) => ($(s) as HTMLTextAreaElement | HTMLInputElement).value;
const setVal = (s: string, v: string) => { ($(s) as HTMLTextAreaElement | HTMLInputElement).value = v; };

const AREAS: Area[] = ['Paths/Operations', 'Parameters', 'Request/Response bodies', 'Schemas/Models', 'Security'];

let sampleOld = '', sampleNew = '';
let lastChanges: Change[] = [];

init();
async function init() {
  wire();
  try {
    [sampleOld, sampleNew] = await Promise.all([
      fetch(`${import.meta.env.BASE_URL}sample-old.json`).then((r) => r.text()),
      fetch(`${import.meta.env.BASE_URL}sample-new.json`).then((r) => r.text()),
    ]);
    setVal('#old-text', sampleOld);
    setVal('#new-text', sampleNew);
    run();
  } catch (e) { $('#report').innerHTML = `<div class="cov-error">Couldn't load samples. ${esc((e as Error).message)}</div>`; }
}

function wire() {
  $('#review').addEventListener('click', run);
  $('#load-sample').addEventListener('click', () => { setVal('#old-text', sampleOld); setVal('#new-text', sampleNew); run(); });
  $('#up-old').addEventListener('click', () => $('#file-old').click());
  $('#up-new').addEventListener('click', () => $('#file-new').click());
  $('#file-old').addEventListener('change', (e) => readFile(e, '#old-text'));
  $('#file-new').addEventListener('change', (e) => readFile(e, '#new-text'));
  $('#breaking-only').addEventListener('change', () => { if (lastChanges.length || $('#report').querySelector('.hero')) render(); });
  $('#copy-md').addEventListener('click', copyMarkdown);
  $('#engage-ae').addEventListener('click', () => { location.href = 'mailto:info@apievangelist.com?subject=' + encodeURIComponent('API design review & versioning'); });
  $('#nav-about').addEventListener('click', (e) => { e.preventDefault(); about(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.getElementById('about-modal')?.remove(); });
}

function readFile(e: Event, target: string) {
  const f = (e.target as HTMLInputElement).files?.[0]; if (!f) return;
  const r = new FileReader(); r.onload = () => { setVal(target, String(r.result)); run(); }; r.readAsText(f);
}

function run() {
  let oldDoc: any, newDoc: any;
  try { oldDoc = parseSpec(val('#old-text')); }
  catch (e) { return err(`Couldn't parse the OLD spec: ${(e as Error).message}`); }
  try { newDoc = parseSpec(val('#new-text')); }
  catch (e) { return err(`Couldn't parse the NEW spec: ${(e as Error).message}`); }

  try { lastChanges = diffSpecs(oldDoc, newDoc); }
  catch (e) { return err(`Couldn't diff the specs: ${(e as Error).message}`); }

  const c = countChanges(lastChanges);
  $('#status').innerHTML = `<b>${c.total}</b> changes · <b style="color:var(--ok)">${c.added}</b> added · <b style="color:var(--warn)">${c.changed}</b> changed · <b style="color:var(--error)">${c.breaking}</b> breaking`;
  render();
}
function err(msg: string) { lastChanges = []; $('#report').innerHTML = `<div class="cov-error">${esc(msg)}</div>`; $('#status').innerHTML = ''; }

function render() {
  const breakingOnly = ($('#breaking-only') as HTMLInputElement).checked;
  const c: Counts = countChanges(lastChanges);
  const shown = breakingOnly ? lastChanges.filter((x) => x.breaking) : lastChanges;

  const empty = !lastChanges.length
    ? `<div class="panel"><h3>No differences</h3><p class="small">The two documents resolve to the same shape — nothing to review.</p></div>`
    : '';

  $('#report').innerHTML = `
    <div class="hero">
      <div class="gauge">
        <div class="gauge-num" style="color:${c.breaking ? 'var(--error)' : 'var(--ok)'}">${c.breaking}</div>
        <div class="gauge-cap">breaking<br>change${c.breaking === 1 ? '' : 's'}</div>
      </div>
      <div class="facts">
        <div class="fact"><b>${c.total}</b><span>total changes</span></div>
        <div class="fact okf"><b>${c.added}</b><span>added</span></div>
        <div class="fact errf"><b>${c.removed}</b><span>removed</span></div>
        <div class="fact ${c.changed ? 'warnf' : ''}"><b>${c.changed}</b><span>changed</span></div>
        <div class="fact ${c.breaking ? 'errf' : 'okf'}"><b>${c.breaking}</b><span>breaking</span></div>
      </div>
    </div>
    <p class="hint small">Both documents were parsed and their internal <code>$ref</code> pointers <strong>resolved</strong> before diffing — so this is the <strong>real resolved shape</strong>, not a pointer chase. Changes are grouped by area and tagged <strong>added / removed / changed</strong>; anything that can break a consumer is flagged <span class="vstate live" style="vertical-align:middle">breaking</span>. Use <strong>Breaking only</strong> to see just the risky set, and <strong>Copy Markdown</strong> to drop a summary into the PR.</p>
    ${empty}
    ${AREAS.map((a) => section(a, shown)).filter(Boolean).join('')}
    ${lastChanges.length && !shown.length ? `<div class="panel"><h3>No breaking changes</h3><p class="small">Nothing in this diff is flagged breaking. Untick <strong>Breaking only</strong> to see the full change list.</p></div>` : ''}

    <div class="export-bar">
      <button class="measure-btn" id="copy-md2" type="button">Copy Markdown summary ⧉</button>
      <button class="ghost-btn" id="dl-md" type="button">Download review.md ↓</button>
      <span class="muted small">Paste the Markdown into your pull request so reviewers see the resolved, breaking-flagged diff — not raw YAML.</span>
    </div>`;

  $('#copy-md2').addEventListener('click', copyMarkdown);
  $('#dl-md').addEventListener('click', () => download('spec-review.md', toMarkdown(lastChanges), 'text/markdown'));
}

function section(area: Area, changes: Change[]): string {
  const inArea = changes.filter((c) => c.area === area);
  if (!inArea.length) return '';
  const order = { removed: 0, changed: 1, added: 2 } as const;
  const rows = [...inArea].sort((a, b) => (Number(b.breaking) - Number(a.breaking)) || (order[a.kind] - order[b.kind]));
  const breaking = inArea.filter((c) => c.breaking).length;
  return `<section class="panel">
    <h3>${esc(area)} <span class="muted">(${inArea.length}${breaking ? ` · ${breaking} breaking` : ''})</span></h3>
    <div class="vlist">${rows.map(crow).join('')}</div>
  </section>`;
}

function crow(c: Change): string {
  const state = c.breaking ? 'live' : c.kind === 'added' ? 'waived' : c.kind === 'removed' ? 'expired' : 'changed';
  const label = c.breaking ? 'breaking' : c.kind;
  return `<div class="vrow ${state}"><span class="vstate ${state}">${esc(label)}</span>
    <div class="vmain"><div class="vcode">${md(c.summary)}</div><div class="vpath">${esc(c.path)}${c.breaking && c.kind !== 'removed' ? '' : ''}</div>${c.detail ? `<div class="vpath">${md(c.detail)}</div>` : ''}</div>
    ${c.breaking ? '<div class="vby">⚠ BREAKING</div>' : `<div class="vby">${esc(c.kind)}</div>`}</div>`;
}

async function copyMarkdown() {
  if (!lastChanges.length) { alert('Nothing to copy yet — review two specs first.'); return; }
  const text = toMarkdown(lastChanges);
  try { await navigator.clipboard.writeText(text); flash('Markdown copied to clipboard ✓'); }
  catch { download('spec-review.md', text, 'text/markdown'); }
}

function flash(msg: string) {
  const el = document.createElement('div');
  el.className = 'flash'; el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1800);
}

function download(name: string, content: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
}

function about() {
  const el = document.createElement('div');
  el.id = 'about-modal';
  el.innerHTML = `<div class="about-backdrop"></div><div class="about-card">
    <button class="detail-close" id="about-close">&times;</button>
    <h2>Review the design, not the diff</h2>
    <p>Reviewing an API change in a pull request usually means squinting at a raw YAML or JSON diff — a format that is hostile to the very people who most need to weigh in: product owners, partners, security, the humans who will actually consume the API. And <code>$ref</code> makes it worse: the diff shows a pointer moving, not the shape it resolves to, so the real change hides one indirection away.</p>
    <p>Spectral lints a spec against rules, but it won't tell you what <em>changed</em> between two versions or whether that change breaks anyone. That's the gap this fills. Paste the <strong>old</strong> and <strong>new</strong> spec; Spec Review parses both, <strong>resolves every internal <code>$ref</code></strong> (cycle-safe), and walks the resolved shapes into a readable, categorized change list — Paths &amp; Operations, Parameters, Request/Response bodies, Schemas, Security.</p>
    <p>Each change is tagged <strong>added</strong>, <strong>removed</strong>, or <strong>changed</strong>, and flagged <strong>breaking</strong> where a consumer could break: a removed operation, a removed or newly-required property, a narrowed type, a dropped enum value, a removed response, a new required parameter, tightened auth. Copy the Markdown summary into the PR so reviewers argue about the <em>design</em>, not the syntax.</p>
    <p class="muted small">Runs entirely in your browser. Nothing you paste leaves the page.</p>
  </div>`;
  document.body.appendChild(el);
  el.querySelector('#about-close')!.addEventListener('click', () => el.remove());
  el.querySelector('.about-backdrop')!.addEventListener('click', () => el.remove());
}
