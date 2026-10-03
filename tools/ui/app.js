'use strict';
/* SCEvo Deploy Tool — UI
 *
 * Vanilla on purpose: no build step, no dependencies. Lists are 12-16 rows, so
 * "rebuild innerHTML then rebind" is the right amount of machinery.
 *
 * Two things that used to be implicit and now are not:
 *   - Deploy has its own branch selector. It used to read the Verify tab's.
 *   - Deploy steps come from `step` events off the server, not from regex-
 *     matching log text.
 */

const TOKEN = new URLSearchParams(location.search).get('t') || '';
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

async function api(method, path, body) {
  const res = await fetch(`${path}${path.includes('?') ? '&' : '?'}t=${TOKEN}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-token': TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 5600);
}

const fmtBytes = (n) => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 3);
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/* ── tabs ────────────────────────────────────────────────────────── */

// Loaders run on tab entry so a tab is never showing data from three actions ago.
const TAB_LOADERS = { package: loadSources, manifest: () => loadManifest(), news: () => loadNews(), settings: loadState };

$$('.tab').forEach((btn) => btn.addEventListener('click', () => {
  $$('.tab').forEach((b) => b.classList.toggle('active', b === btn));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${btn.dataset.tab}`));
  const loader = TAB_LOADERS[btn.dataset.tab];
  if (loader) Promise.resolve(loader()).catch((e) => toast(e.message, 'err'));
}));

/* ── event stream ────────────────────────────────────────────────── */

const listeners = new Set();

function connectEvents() {
  const es = new EventSource(`/api/events?t=${TOKEN}`);
  es.onmessage = (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'job-start') setJob('busy', `${msg.job}…`);
    if (msg.type === 'job-done')  { setJob('ok', 'ready'); refreshReady(); }
    if (msg.type === 'job-error') setJob('err', msg.message);
    listeners.forEach((fn) => fn(msg));
  };
  es.onerror = () => setJob('err', 'disconnected');
  es.onopen  = () => setJob('ok', 'ready');
}

function setJob(kind, text) {
  $('#jobDot').className = `dot ${kind}`;
  $('#jobText').textContent = text;
}

/* ── readiness strip ─────────────────────────────────────────────── */

let STATE = null;
let PROBE = null;   // null while unknown; the R2 chip says "checking…" until it lands

// `rclone version` and `listremotes` pass even with a revoked key, so the probe
// is the only signal here that proves a deploy will actually reach Cloudflare.
function probeHeadline(probe) {
  if (!probe) return { cls: '', label: 'checking…' };
  if (probe.ok) return { cls: 'good', label: `R2 reachable · ${plural(probe.prefixes?.length ?? 0, 'prefix', 'prefixes')}` };
  return { cls: 'bad', label: {
    auth:        'R2 access denied',
    network:     'R2 unreachable',
    timeout:     'R2 timed out',
    'no-bucket': 'R2 bucket/remote missing',
    'no-rclone': 'rclone missing',
  }[probe.status] ?? 'R2 check failed' };
}

function renderReady() {
  if (!STATE) return;
  const p = STATE.paths, rc = STATE.rclone;
  const DOT = { good: 'ok', warn: 'busy', bad: 'err' };
  const chip = (state, label, value, title) =>
    `<span class="chip ${state === 'good' ? '' : state}" title="${esc(title ?? '')}">
       <span class="dot ${DOT[state] ?? ''}"></span>
       ${esc(label)}${value ? ` <b>${esc(value)}</b>` : ''}
     </span>`;

  const pr = probeHeadline(PROBE);
  const chips = [
    chip(pr.cls || 'warn', pr.label, '', PROBE && !PROBE.ok ? PROBE.error : ''),
    chip(rc.ok ? 'good' : 'bad', 'rclone', rc.ok ? (rc.version || '').replace(/^rclone /, '') : 'missing'),
    chip(p.sc2Valid ? 'good' : 'bad', 'SC2 install', p.sc2Valid ? 'found' : 'not set'),
    chip(p.mpqEditor ? 'good' : 'bad', 'MPQEditor', p.mpqEditor ? 'found' : 'missing'),
    chip(p.payloadExists ? 'good' : 'warn', 'payload/', p.payloadExists ? 'present' : 'missing'),
    chip(p.betaExists ? 'good' : 'warn', 'betapayload/', p.betaExists ? 'present' : 'missing'),
  ];
  $('#ready').innerHTML = chips.join('');
}

async function refreshReady() {
  STATE = await api('GET', '/api/state');
  renderReady();
  return STATE;
}

// Fire-and-forget: the strip paints from /api/state immediately and the R2 chip
// upgrades itself when Cloudflare answers. A dead network never blocks the UI.
async function refreshProbe() {
  PROBE = null;
  renderReady();
  try { PROBE = (await api('GET', '/api/probe')).probe; }
  catch (e) { PROBE = { ok: false, status: 'failed', error: e.message }; }
  renderReady();
  renderEnv();
}

/* ── SETTINGS ────────────────────────────────────────────────────── */

function envRow(state, key, value, fix) {
  return `<div class="env-row ${state}">
    <span class="icon">${state === 'good' ? '●' : state === 'bad' ? '✕' : '!'}</span>
    <span class="k">${esc(key)}</span>
    <span class="v">${value}${fix ? `<span class="fix">${fix}</span>` : ''}</span>
  </div>`;
}

function renderEnv() {
  if (!STATE) return;
  const p = STATE.paths, rc = STATE.rclone, c = STATE.config;
  const rows = [];

  rows.push(`<h4 style="margin-bottom:var(--s2)">Paths</h4>`);
  rows.push(envRow('good', 'Repo root', `<span class="mono">${esc(p.repoRoot)}</span>`));
  rows.push(envRow(p.sc2Valid ? 'good' : 'bad', 'SC2 install',
    c.sc2InstallPath ? `<span class="mono">${esc(c.sc2InstallPath)}</span>` : '<i>not set</i>',
    p.sc2Valid ? '' : 'Set it above — source discovery and packaging cannot run without it.'));
  rows.push(envRow(c.launcherRepoPath ? (p.launcherValid ? 'good' : 'bad') : 'good', 'Launcher repo',
    c.launcherRepoPath ? `<span class="mono">${esc(c.launcherRepoPath)}</span>` : 'not configured',
    c.launcherRepoPath
      ? (p.launcherValid ? '' : 'No package.json there — staging will warn and skip, and launcher-version.json will be left alone.')
      : 'Correct unless you are shipping a new launcher build. The exes and version file already in this repo upload unchanged.'));
  rows.push(envRow(p.payloadExists ? 'good' : 'warn', 'payload/', p.payloadExists ? 'present' : 'missing'));
  rows.push(envRow(p.betaExists ? 'good' : 'warn', 'betapayload/', p.betaExists ? 'present' : 'missing'));

  rows.push(`<h4 style="margin:var(--s4) 0 var(--s2)">Tooling</h4>`);
  rows.push(envRow(p.mpqEditor ? 'good' : 'bad', 'MPQEditor.exe', p.mpqEditor ? 'found at repo root' : 'not found',
    p.mpqEditor ? '' : 'Packaging cannot run. Restore MPQEditor.exe to the repo root.'));
  rows.push(envRow(rc.ok ? 'good' : 'bad', 'rclone', rc.ok ? esc(rc.version) : esc(rc.error),
    rc.ok ? '' : 'Install with <span class="mono">winget install Rclone.Rclone</span>.'));

  rows.push(`<h4 style="margin:var(--s4) 0 var(--s2)">Cloudflare</h4>`);
  rows.push(envRow(rc.hasCf ? 'good' : 'bad', 'cf: remote',
    rc.hasCf ? `configured${rc.remotes?.length > 1 ? ` (${rc.remotes.length} remotes total)` : ''}` : 'NOT CONFIGURED',
    rc.hasCf ? '' : 'Create it with <span class="mono">rclone config</span>.'));
  const pr = probeHeadline(PROBE);
  rows.push(envRow(PROBE ? (PROBE.ok ? 'good' : 'bad') : 'warn', 'R2 bucket',
    esc(pr.label),
    PROBE && !PROBE.ok ? `<span class="mono">${esc(PROBE.error)}</span>` : ''));

  rows.push(`<h4 style="margin:var(--s4) 0 var(--s2)">Cache</h4>`);
  rows.push(envRow('good', 'Hash cache', `${plural(STATE.cache.entries, 'entry', 'entries')}`,
    'Skips re-hashing unchanged archives. Pruning only drops entries for files that no longer exist.'));

  $('#stEnv').innerHTML = rows.join('');
}

async function loadState() {
  await refreshReady();
  $('#stSc2').value = STATE.config.sc2InstallPath;
  $('#stLauncher').value = STATE.config.launcherRepoPath;
  $('#stDebug').checked = STATE.config.showVersionDebug;
  renderEnv();
  return STATE;
}

$('#stSave').addEventListener('click', async () => {
  try {
    await api('POST', '/api/config', {
      sc2InstallPath: $('#stSc2').value,
      launcherRepoPath: $('#stLauncher').value,
      showVersionDebug: $('#stDebug').checked,
    });
    await loadState();
    toast('Settings saved.', 'ok');
  } catch (e) { toast(e.message, 'err'); }
});

$('#stRecheck').addEventListener('click', () => { refreshProbe(); toast('Re-checking Cloudflare…'); });

$('#stPrune').addEventListener('click', async () => {
  try {
    const r = await api('POST', '/api/cache-prune');
    toast(`Pruned ${plural(r.removed, 'stale entry', 'stale entries')}.`, 'ok');
    loadState();
  } catch (e) { toast(e.message, 'err'); }
});

/* ── PACKAGE ─────────────────────────────────────────────────────── */

let SOURCES = [];

async function loadSources() {
  const data = await api('GET', '/api/sources');
  SOURCES = data.sources ?? [];
  const warn = [];
  if (data.error) warn.push(`<div class="banner err"><b>Cannot scan sources</b>${esc(data.error)}</div>`);
  if (data.missingRoots?.length) {
    warn.push(`<div class="banner warn"><b>Not found in the SC2 install</b><span class="mono">${data.missingRoots.map(esc).join('<br>')}</span></div>`);
  }
  $('#pkgWarn').innerHTML = warn.join('');
  renderSources();
}

// Groups by the parent folder inside the SC2 install, so Maps and Mods don't
// interleave into one 12-row wall.
function groupOf(relPath) {
  const parts = relPath.split('\\');
  return parts.length > 1 ? parts.slice(0, -1).join('\\') : relPath;
}

const DESTS = [['', 'Skip'], ['payload', 'Payload'], ['betapayload', 'Beta'], ['both', 'Both']];

function srcRow(s, i) {
  const facts = [
    `<span class="pill unchanged">${plural(s.fileCount, 'file', 'files')}</span>`,
    s.inPayload ? '<span class="pill acc">in payload</span>' : '',
    s.inBetapayload ? '<span class="pill acc">in beta</span>' : '',
    !s.inPayload && !s.inBetapayload ? '<span class="pill new">new</span>' : '',
  ].filter(Boolean).join(' ');

  const dest = s.vetoed ? '' : `<div class="seg dest">${DESTS.map(([v, l]) =>
    `<button class="seg-btn${(s._action ?? '') === v ? ' active' : ''}" data-dest="${v}">${l}</button>`).join('')}</div>`;

  return `<div class="src ${s.vetoed ? 'is-vetoed' : ''}" data-i="${i}">
    <div class="grow">
      <div class="name truncate">${esc(s.name)}</div>
      <div class="facts">${facts}</div>
    </div>
    ${dest}
    <button class="btn sm ${s.vetoed ? 'ghost' : 'danger'} veto">${s.vetoed ? 'Un-veto' : 'Veto'}</button>
  </div>`;
}

function renderSources() {
  const active = SOURCES.map((s, i) => [s, i]).filter(([s]) => !s.vetoed);
  const vetoed = SOURCES.map((s, i) => [s, i]).filter(([s]) => s.vetoed);

  const groups = new Map();
  for (const [s, i] of active) {
    const g = groupOf(s.relPath);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push([s, i]);
  }

  $('#pkgList').innerHTML = active.length
    ? [...groups].map(([g, rows]) =>
        `<div class="srcgroup"><h4>${esc(g)}</h4>${rows.map(([s, i]) => srcRow(s, i)).join('')}</div>`).join('')
    : '<div class="empty">No source folders found. Check the SC2 install path in Settings.</div>';

  $('#pkgVetoSection').hidden = vetoed.length === 0;
  $('#pkgVetoCount').textContent = vetoed.length;
  $('#pkgVetoList').innerHTML = vetoed.map(([s, i]) => srcRow(s, i)).join('');

  bindSources($('#pkgList'));
  bindSources($('#pkgVetoList'));
  renderPkgSummary();
}

function bindSources(host) {
  $$('.src', host).forEach((el) => {
    const s = SOURCES[+el.dataset.i];
    $$('.dest .seg-btn', el).forEach((b) => b.addEventListener('click', () => {
      s._action = b.dataset.dest;
      $$('.dest .seg-btn', el).forEach((x) => x.classList.toggle('active', x === b));
      renderPkgSummary();
    }));
    el.querySelector('.veto').addEventListener('click', async () => {
      try {
        await api('POST', '/api/veto', { relPath: s.relPath, vetoed: !s.vetoed });
        s.vetoed = !s.vetoed;
        if (s.vetoed) s._action = '';
        renderSources();
        toast(s.vetoed ? `Vetoed ${s.name}` : `Un-vetoed ${s.name}`, 'ok');
      } catch (e) { toast(e.message, 'err'); }
    });
  });
}

function selectedItems() {
  return SOURCES.filter((s) => !s.vetoed && s._action).map((s) => ({
    relPath: s.relPath,
    targets: s._action === 'both' ? ['payload', 'betapayload'] : [s._action],
  }));
}

function renderPkgSummary() {
  const items = selectedItems();
  const toPayload = items.filter((i) => i.targets.includes('payload')).length;
  const toBeta    = items.filter((i) => i.targets.includes('betapayload')).length;
  $('#pkgSummary').textContent = items.length
    ? `${plural(items.length, 'source', 'sources')} selected — ${toPayload} → payload, ${toBeta} → betapayload`
    : 'Nothing selected.';
  $('#pkgBuild').disabled = items.length === 0;
}

$('#pkgRefresh').addEventListener('click', () => loadSources().catch((e) => toast(e.message, 'err')));
$('#pkgSelectChanged').addEventListener('click', () => {
  SOURCES.forEach((s) => { if (!s.vetoed && s.inPayload) s._action = 'payload'; });
  renderSources();
});
$('#pkgSelectNew').addEventListener('click', () => {
  SOURCES.forEach((s) => { if (!s.vetoed && !s.inPayload && !s.inBetapayload) s._action = 'payload'; });
  renderSources();
});
$('#pkgClear').addEventListener('click', () => {
  SOURCES.forEach((s) => { s._action = ''; });
  renderSources();
});

$('#pkgBuild').addEventListener('click', async () => {
  const items = selectedItems();
  if (!items.length) return toast('Nothing selected.', 'err');
  $('#pkgBuild').disabled = true;
  $('#pkgBuild').textContent = 'Packaging…';
  try {
    const { results } = await api('POST', '/api/package', { items });
    const bad = results.filter((r) => !r.ok);
    bad.forEach((r) => console.error(r.name, r.error, r.stdout, r.stderr));
    toast(bad.length
      ? `${bad.length} failed: ${bad.map((b) => `${b.name} — ${b.error}`).join(' · ')}`
      : `Packaged ${plural(results.length, 'archive', 'archives')}.`, bad.length ? 'err' : 'ok');
    await loadSources();
  } catch (e) { toast(e.message, 'err'); }
  finally { $('#pkgBuild').textContent = 'Package selected'; renderPkgSummary(); }
});

// Live packaging progress in the action bar.
listeners.add((msg) => {
  if (msg.job !== 'package') return;
  if (msg.type === 'progress' && msg.file) {
    const detail = msg.phase === 'packing' ? `packing ${msg.fileCount} files`
      : msg.phase === 'deployed' ? `copied to ${msg.dest}` : msg.phase;
    $('#pkgSummary').textContent = `${msg.file} — ${detail}${msg.total ? ` (${msg.index}/${msg.total})` : ''}`;
  }
});

/* ── MANIFEST ────────────────────────────────────────────────────── */

let BRANCH = 'public';
let MANIFEST = null;
let MF_SEL = 0;
let MF_DIRTY = false;

function setManifestDirty(on) {
  MF_DIRTY = on;
  $('#mfDirtyDot').hidden = !on;
  $('#mfDirtyBanner').hidden = !on;
  $('#mfSave').textContent = on ? 'Save manifest •' : 'Save manifest';
}

// Every path that throws away in-memory edits goes through here. Previously the
// branch buttons and Reload silently discarded them.
function confirmDiscard() {
  return !MF_DIRTY || confirm('You have unsaved manifest changes. Discard them?');
}

$$('#mfBranch .seg-btn').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.branch === BRANCH) return;
  if (!confirmDiscard()) return;
  $$('#mfBranch .seg-btn').forEach((x) => x.classList.toggle('active', x === b));
  BRANCH = b.dataset.branch;
  loadManifest().catch((e) => toast(e.message, 'err'));
}));

async function loadManifest() {
  MANIFEST = await api('GET', `/api/manifest?branch=${BRANCH}`);
  const isBeta = BRANCH === 'beta';

  $('#mfMetaTitle').textContent = isBeta ? 'Beta metadata' : 'Versions';
  $('#mfPublicVersions').hidden = isBeta;
  $('#mfBetaMeta').hidden = !isBeta;
  // Severity is a public-manifest concept only.
  $('#mfCritSevWrap').style.display = isBeta ? 'none' : '';

  $('#mfVerCore').value = MANIFEST.versions?.multiplayer ?? '';
  $('#mfVerCampaign').value = MANIFEST.versions?.campaign ?? '';

  const cu = MANIFEST.criticalUpdate ?? {};
  $('#mfCritEnabled').checked = !!cu.enabled;
  $('#mfCritMin').value = cu.minVersion ?? '';
  $('#mfCritMsg').value = cu.message ?? '';
  $('#mfCritSev').value = cu.severity ?? 'critical';
  syncCritPill();

  if (isBeta && MANIFEST.betaMeta) {
    const m = MANIFEST.betaMeta;
    $('#mfBetaEnabled').checked = m.betaEnabled;
    $('#mfBetaName').value = m.betaName;
    $('#mfBetaAccent').value = m.accentColor;
    $('#mfBetaMajor').value = m.majorVersion;
    $('#mfBetaFull').value = m.fullVersion;
    $('#mfBetaCore').value = m.coreVersion;
    $('#mfBetaCode').value = '';
    $('#mfBetaHash').textContent = m.codeHash ? `current codeHash: ${m.codeHash}` : 'no codeHash set';
    syncBetaGate();
  }

  MF_SEL = Math.min(MF_SEL, Math.max(0, MANIFEST.modules.length - 1));
  setManifestDirty(false);
  renderModuleList();
  renderModuleDetail();
}

function syncCritPill() {
  const on = $('#mfCritEnabled').checked;
  const pill = $('#mfCritPill');
  pill.textContent = on ? `on · ≥ ${$('#mfCritMin').value.trim() || '?'}` : 'off';
  pill.className = `pill ${on ? 'err' : ''}`;
}
function syncBetaGate() {
  $('#mfBetaFields').style.opacity = $('#mfBetaEnabled').checked ? '1' : '.5';
}

// Meta fields live outside MANIFEST until save, so they mark dirty by hand.
['#mfVerCore', '#mfVerCampaign', '#mfCritMin', '#mfCritMsg', '#mfCritSev', '#mfBetaName',
 '#mfBetaAccent', '#mfBetaMajor', '#mfBetaFull', '#mfBetaCore', '#mfBetaCode']
  .forEach((sel) => $(sel).addEventListener('input', () => { setManifestDirty(true); syncCritPill(); }));
$('#mfCritEnabled').addEventListener('change', () => { setManifestDirty(true); syncCritPill(); });
$('#mfBetaEnabled').addEventListener('change', () => { setManifestDirty(true); syncBetaGate(); });

function renderModuleList() {
  const host = $('#mfList');
  $('#mfCount').textContent = MANIFEST.modules.length;
  if (!MANIFEST.modules.length) {
    host.innerHTML = '<div class="empty">No modules. Build archives on the Package tab first.</div>';
    return;
  }
  host.innerHTML = MANIFEST.modules.map((m, i) => {
    const f = m.files?.[0] ?? {};
    return `<div class="item ${i === MF_SEL ? 'sel' : ''}" data-i="${i}" draggable="true">
      <span class="drag" title="Drag to reorder">⠿</span>
      <span class="pill ${m.state}">${esc(m.state)}</span>
      <span class="name grow">${esc(m.name || m.id)}</span>
      <span class="meta">${f.size ? fmtBytes(f.size) : '—'}</span>
    </div>`;
  }).join('');

  $$('.item', host).forEach((el) => {
    const i = +el.dataset.i;
    el.addEventListener('click', () => { MF_SEL = i; renderModuleList(); renderModuleDetail(); });
    el.addEventListener('dragstart', () => { el.classList.add('dragging'); dragIndex = i; });
    el.addEventListener('dragend', () => { el.classList.remove('dragging'); $$('.item', host).forEach((x) => x.classList.remove('drop-target')); });
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drop-target'); });
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      if (dragIndex === null || dragIndex === i) return;
      const [moved] = MANIFEST.modules.splice(dragIndex, 1);
      MANIFEST.modules.splice(i, 0, moved);
      MF_SEL = i;
      dragIndex = null;
      setManifestDirty(true);
      renderModuleList();
      renderModuleDetail();
    });
  });
}
let dragIndex = null;

function renderModuleDetail() {
  const host = $('#mfDetail');
  const m = MANIFEST.modules[MF_SEL];
  if (!m) { host.innerHTML = '<div class="detail-empty">Select a module to edit it.</div>'; return; }
  const f = m.files?.[0] ?? {};
  const urls = f.downloadUrls?.join('\n') ?? f.downloadUrl ?? '';
  const drift = (f.state !== 'missing' && f.manifestSize != null && f.manifestSize !== f.size)
    ? `<div class="banner warn"><b>Size drift</b>Manifest says ${f.manifestSize?.toLocaleString()} bytes, the file on disk is ${f.size?.toLocaleString()}. Saving adopts the disk value.</div>`
    : '';
  const gone = m.state === 'missing'
    ? '<div class="banner err"><b>File missing on disk</b>This module points at an archive that is not in the payload folder. Either rebuild it on the Package tab, remove the module, or tick "Drop modules whose file is missing".</div>'
    : '';

  host.innerHTML = `
    ${gone}${drift}
    <div class="field-row">
      <label>Module ID<input type="text" data-k="id" value="${esc(m.id)}"></label>
      <label>Name<input type="text" data-k="name" value="${esc(m.name)}"></label>
      <label style="max-width:170px">Type<select data-k="type">
        <option value=""${!m.type ? ' selected' : ''}>(omit)</option>
        <option value="core"${m.type === 'core' ? ' selected' : ''}>core</option>
        <option value="campaign"${m.type === 'campaign' ? ' selected' : ''}>campaign</option>
      </select></label>
    </div>
    <label>Description<input type="text" data-k="description" value="${esc(m.description)}"></label>

    <h4 style="margin:var(--s4) 0 var(--s2)">File</h4>
    <div class="env">
      ${envRow('good', 'Path', `<span class="mono">${esc(f.path ?? '—')}</span>`)}
      ${envRow('good', 'Size', f.size ? `${fmtBytes(f.size)} <span class="faint">(${f.size.toLocaleString()} bytes)</span>` : '—')}
      ${envRow('good', 'sha256', `<span class="mono small">${esc(f.hash ?? '—')}</span>`)}
    </div>

    <details class="section" style="margin-top:var(--s4)">
      <summary class="sec-head"><h3>Mirror URLs</h3><span class="pill ${urls ? 'acc' : ''}">${urls ? 'set' : 'default'}</span></summary>
      <div class="sec-body">
        <p class="hint">Normally empty — the launcher derives the R2 URL from the path. One URL per line; two or more become <code>downloadUrls</code> and are ping-raced by the client.</p>
        <textarea rows="3" data-k="urls" placeholder="(none)">${esc(urls)}</textarea>
      </div>
    </details>

    <div class="actions" style="margin-top:var(--s4)">
      <button class="btn" id="mfPromote">${BRANCH === 'beta' ? 'Copy file to payload/' : 'Copy file to betapayload/'}</button>
      <button class="btn danger" id="mfRemove">Remove module</button>
    </div>`;

  $$('[data-k]', host).forEach((inp) => inp.addEventListener('change', () => {
    const k = inp.dataset.k;
    if (k === 'urls') {
      const list = inp.value.split('\n').map((s) => s.trim()).filter(Boolean);
      delete m.files[0].downloadUrl; delete m.files[0].downloadUrls;
      if (list.length > 1) m.files[0].downloadUrls = list;
      else if (list.length === 1) m.files[0].downloadUrl = list[0];
    } else m[k] = inp.value;
    setManifestDirty(true);
    renderModuleList();
  }));

  $('#mfRemove').addEventListener('click', () => {
    if (!confirm(`Remove "${m.name || m.id}" from the manifest?\n\nThe built archive stays on disk; only the manifest entry goes.`)) return;
    MANIFEST.modules.splice(MF_SEL, 1);
    MF_SEL = Math.max(0, MF_SEL - 1);
    setManifestDirty(true);
    renderModuleList();
    renderModuleDetail();
  });

  $('#mfPromote').addEventListener('click', async () => {
    try {
      await api('POST', '/api/promote', {
        paths: [m.files[0].path],
        direction: BRANCH === 'beta' ? 'toPublic' : 'toBeta',
      });
      toast(`Copied ${m.files[0].path}`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  });
}

$('#mfReload').addEventListener('click', () => {
  if (!confirmDiscard()) return;
  loadManifest().catch((e) => toast(e.message, 'err'));
});

$('#mfSave').addEventListener('click', async () => {
  try {
    const payload = {
      branch: BRANCH,
      modules: MANIFEST.modules,
      dropMissing: $('#mfDropMissing').checked,
      criticalUpdate: {
        enabled: $('#mfCritEnabled').checked,
        minVersion: $('#mfCritMin').value.trim(),
        message: $('#mfCritMsg').value.trim(),
        severity: $('#mfCritSev').value,
      },
    };
    if (BRANCH === 'public') {
      payload.versions = { multiplayer: $('#mfVerCore').value.trim(), campaign: $('#mfVerCampaign').value.trim() };
    } else {
      let codeHash = MANIFEST.betaMeta?.codeHash ?? '';
      const plain = $('#mfBetaCode').value.trim();
      if (plain) codeHash = (await api('POST', '/api/beta-code-hash', { code: plain })).codeHash;
      payload.betaMeta = {
        betaEnabled: $('#mfBetaEnabled').checked,
        betaName: $('#mfBetaName').value.trim(),
        majorVersion: $('#mfBetaMajor').value.trim(),
        fullVersion: $('#mfBetaFull').value.trim(),
        accentColor: $('#mfBetaAccent').value.trim() || '#ff6600',
        coreVersion: $('#mfBetaCore').value.trim(),
        codeHash,
      };
    }
    const r = await api('POST', '/api/manifest', payload);
    setManifestDirty(false);
    toast(`Wrote ${r.written} — ${plural(r.modules, 'module', 'modules')}.`, 'ok');
    await loadManifest();
  } catch (e) { toast(e.message, 'err'); }
});

/* ── VERIFY ──────────────────────────────────────────────────────── */

let VBRANCH = 'public';
$$('#vfBranch .seg-btn').forEach((b) => b.addEventListener('click', () => {
  $$('#vfBranch .seg-btn').forEach((x) => x.classList.toggle('active', x === b));
  VBRANCH = b.dataset.branch;
}));

const LEVELS = [
  { key: 'error', title: 'Errors',   open: true,  cls: 'err'  },
  { key: 'warn',  title: 'Warnings', open: false, cls: 'warn' },
  { key: 'ok',    title: 'Passed',   open: false, cls: 'ok'   },
];

// Errors expanded, warnings and passes folded away. The old flat list buried
// three real errors under twenty locale warnings.
function renderFindings(findings, host) {
  if (!findings.length) { host.innerHTML = '<div class="section"><div class="empty">No findings.</div></div>'; return; }
  host.innerHTML = LEVELS.map(({ key, title, open, cls }) => {
    const rows = findings.filter((f) => f.level === key);
    if (!rows.length) return '';
    return `<details class="section" ${open ? 'open' : ''}>
      <summary class="sec-head"><h3>${title}</h3><span class="pill ${cls}">${rows.length}</span></summary>
      <div class="sec-body flush">${rows.map((f) => `
        <div class="finding ${esc(f.level)}">
          <span class="code">${esc(f.code)}</span>
          <div class="grow">${esc(f.message)}${f.detail ? `<div class="detail">${esc(f.detail)}</div>` : ''}</div>
        </div>`).join('')}</div>
    </details>`;
  }).join('');
}

$('#vfRun').addEventListener('click', async () => {
  $('#vfRun').disabled = true;
  $('#vfSummary').innerHTML = '<div class="banner info" id="vfProgress">Running checks…</div>';
  $('#vfGroups').innerHTML = '';
  try {
    const r = await api('POST', '/api/verify', { branch: VBRANCH });
    const passed = r.findings.length - r.errors - r.warnings;
    $('#vfSummary').innerHTML =
      `<div class="banner ${r.canDeploy ? 'ok' : 'err'}">
         <b>${r.canDeploy ? 'All checks passed — safe to deploy.' : `${plural(r.errors, 'error', 'errors')} must be fixed before deploying.`}</b>
         Checked the ${VBRANCH} manifest against disk, the live CDN, and the launcher repo.
       </div>
       <div class="stats">
         <div class="stat err"><b>${r.errors}</b><span>errors</span></div>
         <div class="stat warn"><b>${r.warnings}</b><span>warnings</span></div>
         <div class="stat ok"><b>${passed}</b><span>passed</span></div>
       </div>`;
    renderFindings(r.findings, $('#vfGroups'));
  } catch (e) {
    $('#vfSummary').innerHTML = `<div class="banner err"><b>Checks could not run</b>${esc(e.message)}</div>`;
  } finally { $('#vfRun').disabled = false; }
});

// verify.js already emits per-file progress; surface it instead of a dead spinner.
listeners.add((msg) => {
  if (msg.job !== 'verify' || msg.type !== 'progress') return;
  const el = $('#vfProgress');
  if (!el) return;
  if (msg.phase === 'done') el.textContent = 'Collating findings…';
  else if (msg.file) el.textContent = `Hashing ${msg.file} (${(msg.checked ?? 0) + 1}/${msg.total ?? '?'})…`;
});

$('#vfOrphans').addEventListener('click', async () => {
  const box = $('#vfOrphanBox');
  box.innerHTML = '<div class="banner info">Listing remote objects…</div>';
  try {
    const r = await api('GET', `/api/remote-orphans?branch=${VBRANCH}`);
    if (!r.ok) return void (box.innerHTML = `<div class="banner err"><b>Could not list R2</b>${esc(r.error)}</div>`);
    if (!r.orphans.length) {
      return void (box.innerHTML = `<div class="banner ok"><b>No orphans</b>All ${plural(r.total, 'remote object', 'remote objects')} under <span class="mono">${esc(r.prefix)}/</span> are referenced by the manifest.</div>`);
    }
    box.innerHTML = `<details class="section" open>
      <summary class="sec-head"><h3>Remote orphans</h3><span class="pill warn">${r.orphans.length} of ${r.total}</span>
        <p class="sub">Objects under <span class="mono">${esc(r.prefix)}/</span> that no manifest module references.</p>
      </summary>
      <div class="sec-body flush">
        ${r.orphans.map((o) => `<div class="finding">
          <input type="checkbox" class="orph" value="${esc(o.path)}">
          <span class="grow mono small">${esc(o.path)}</span>
          <span class="faint small nowrap">${fmtBytes(o.size)}</span>
        </div>`).join('')}
      </div>
      <div class="actionbar">
        <span class="summary">Deleting is permanent and immediate.</span>
        <div class="actions" style="margin-left:auto"><button class="btn danger" id="orphDel">Delete selected from R2</button></div>
      </div>
    </details>`;
    $('#orphDel').addEventListener('click', async () => {
      const paths = $$('.orph:checked').map((c) => c.value);
      if (!paths.length) return toast('Nothing selected.', 'err');
      if (!confirm(`Permanently delete ${plural(paths.length, 'object', 'objects')} from R2?\n\n${paths.join('\n')}`)) return;
      try {
        await api('POST', '/api/remote-delete', { prefix: VBRANCH === 'beta' ? 'betapayload' : 'payload', paths });
        toast(`Deleted ${plural(paths.length, 'object', 'objects')}.`, 'ok');
        $('#vfOrphans').click();
      } catch (e) { toast(e.message, 'err'); }
    });
  } catch (e) { box.innerHTML = `<div class="banner err">${esc(e.message)}</div>`; }
});

/* ── DEPLOY ──────────────────────────────────────────────────────── */

// Its own branch state. This used to read VBRANCH — a control on another tab.
let DBRANCH = 'public';
let DRY = true;

const UPLOAD_ORDER = ['payload', 'betapayload', 'assets', 'launcher', 'installer', 'manifests'];

function syncDeployControls() {
  $('#dpBranchNote').innerHTML =
    `Preflight and CDN verification run against <code>manifests/${DBRANCH === 'beta' ? 'beta-manifest.json' : 'update-manifest.json'}</code>. ` +
    `Both <code>payload/</code> and <code>betapayload/</code> upload either way — this picks which manifest is checked, not what is sent.`;
  $('#dpModeNote').innerHTML = DRY
    ? 'Nothing is written to R2. rclone reports what it <em>would</em> transfer.'
    : '<b>Uploads to the live bucket.</b> Users see the new manifests as soon as step 5 finishes.';
  const run = $('#dpRun');
  run.textContent = DRY ? 'Start dry run' : 'Start live deploy';
  run.className = DRY ? 'btn primary' : 'btn danger';
  $$('#dpMode .seg-btn').forEach((b) => b.classList.toggle('hot', !DRY && b.dataset.mode === 'live'));
}

$$('#dpBranch .seg-btn').forEach((b) => b.addEventListener('click', () => {
  $$('#dpBranch .seg-btn').forEach((x) => x.classList.toggle('active', x === b));
  DBRANCH = b.dataset.branch;
  syncDeployControls();
}));
$$('#dpMode .seg-btn').forEach((b) => b.addEventListener('click', () => {
  $$('#dpMode .seg-btn').forEach((x) => x.classList.toggle('active', x === b));
  DRY = b.dataset.mode === 'dry';
  syncDeployControls();
}));
$('#dpForce').addEventListener('change', (e) => { $('#dpForceWarn').hidden = !e.target.checked; });

function resetRail() {
  $$('#dpRail li').forEach((li, i) => {
    li.className = '';
    li.querySelector('.marker').textContent = String(i + 1);
    li.querySelector('.note').textContent = '';
  });
}

function setStep(id, state, detail) {
  const li = $(`#dpRail li[data-step="${id}"]`);
  if (!li) return;
  li.className = state;
  const marker = li.querySelector('.marker');
  marker.textContent = state === 'done' ? '✓' : state === 'failed' ? '✕' : state === 'skipped' ? '–'
    : String([...$$('#dpRail li')].indexOf(li) + 1);
  if (detail != null) li.querySelector('.note').textContent = detail;
}

function resetXfer() {
  $('#dpXfer').innerHTML = UPLOAD_ORDER.map((f) => `<div class="xfer-row idle" data-folder="${f}">
    <div class="xfer-top"><span class="folder">${f}/</span><span class="nums">waiting</span></div>
    <div class="progress"><div class="progress-bar"></div></div>
    <div class="xfer-files"></div>
  </div>`).join('');
  $('#dpTotals').textContent = 'idle';
}

const LOG_LEVEL = /^(error|critical|warning|notice|info|debug):/i;

function appendLog(message) {
  const log = $('#dpLog');
  // Only auto-scroll when already parked at the bottom, so reading history
  // mid-deploy isn't yanked away every second.
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  const m = LOG_LEVEL.exec(message);
  const cls = m ? ` class="l-${m[1].toLowerCase()}"` : '';
  log.insertAdjacentHTML('beforeend', `<span${cls}>${esc(message)}</span>\n`);
  if (atBottom) log.scrollTop = log.scrollHeight;
}

listeners.add((msg) => {
  if (msg.job !== 'deploy') return;

  if (msg.type === 'log') appendLog(msg.message);

  if (msg.type === 'step') setStep(msg.step, msg.state, msg.detail);

  if (msg.type === 'progress' && msg.folder) {
    const row = $(`#dpXfer .xfer-row[data-folder="${msg.folder}"]`);
    if (!row) return;
    row.classList.remove('idle');
    const pct = msg.totalBytes ? (msg.bytes / msg.totalBytes) * 100 : 0;
    row.querySelector('.progress-bar').style.width = `${pct.toFixed(1)}%`;
    row.classList.toggle('done', msg.totalBytes > 0 && msg.bytes >= msg.totalBytes);
    row.querySelector('.nums').textContent =
      `${fmtBytes(msg.bytes)} / ${fmtBytes(msg.totalBytes)} · ${msg.transfers}/${msg.totalTransfers} files` +
      (msg.speed ? ` · ${fmtBytes(msg.speed)}/s` : '') + (msg.eta ? ` · ETA ${msg.eta}s` : '');
    row.querySelector('.xfer-files').innerHTML = (msg.transferring ?? [])
      .map((t) => `<div>${esc(t.name)} — ${t.percentage}% (${fmtBytes(t.speed)}/s)</div>`).join('');
    $('#dpTotals').textContent = `${msg.folder} · ${fmtBytes(msg.speed)}/s`;
  }
});

$('#dpCopyLog').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#dpLog').textContent); toast('Log copied.', 'ok'); }
  catch { toast('Clipboard blocked — select the text instead.', 'err'); }
});
$('#dpClearLog').addEventListener('click', () => { $('#dpLog').textContent = ''; });

$('#dpRun').addEventListener('click', async () => {
  const force = $('#dpForce').checked;
  if (!DRY && !confirm(
    `Upload to the LIVE R2 bucket?\n\n` +
    `Validating against: ${DBRANCH} manifest\n` +
    (force ? `\nWARNING: check failures will be ignored.\n` : '') +
    `\nUsers see the new manifests as soon as the upload finishes.`)) return;

  $('#dpRun').disabled = true;
  $('#dpLog').textContent = '';
  $('#dpResult').innerHTML = '';
  resetRail();
  resetXfer();

  try {
    const r = await api('POST', '/api/deploy', { dryRun: DRY, force, branch: DBRANCH });
    if (r.aborted) {
      const findings = (r.stage === 'preflight' ? r.preflight.findings : r.postflight) ?? [];
      $('#dpResult').innerHTML =
        `<div class="banner err"><b>Aborted at ${esc(r.stage)} — nothing was published.</b>` +
        (r.stage === 'postflight'
          ? 'Payload files were uploaded, but the manifests were not, so the CDN still describes the previous release.'
          : 'No files were uploaded.') +
        `</div><div id="dpFindings"></div>`;
      renderFindings(findings.filter((f) => f.level === 'error'), $('#dpFindings'));
    } else {
      $('#dpResult').innerHTML = `<div class="banner ok"><b>${r.dryRun
        ? 'Dry run complete — nothing was uploaded.'
        : 'Deploy complete and verified.'}</b>${r.launcherVersion?.ok
          ? `launcher-version.json published at v${esc(r.launcherVersion.version)}.`
          : 'launcher-version.json was left as it is (no launcher repo configured).'}</div>`;
    }
  } catch (e) {
    $('#dpResult').innerHTML = `<div class="banner err"><b>Deploy failed</b>${esc(e.message)}</div>`;
  } finally { $('#dpRun').disabled = false; }
});

/* ── NEWS ────────────────────────────────────────────────────────── */

let NEWS = null;
let NW_SEL = 0;
let NW_DIRTY = false;

function setNewsDirty(on) {
  NW_DIRTY = on;
  $('#nwDirtyDot').hidden = !on;
  $('#nwDirtyBanner').hidden = !on;
  $('#nwSave').textContent = on ? 'Save news-feed.json •' : 'Save news-feed.json';
}

async function loadNews() {
  const r = await api('GET', '/api/news');
  NEWS = r.news ?? { schemaVersion: 1, strings: {}, cards: [], announcement: { enabled: false, message: '', type: 'info' } };
  NEWS.announcement ??= { enabled: false, message: '', type: 'info' };
  NEWS.cards ??= [];
  $('#nwAnnEnabled').checked = !!NEWS.announcement.enabled;
  $('#nwAnnType').value = NEWS.announcement.type ?? 'info';
  $('#nwAnnMsg').value = NEWS.announcement.message ?? '';
  syncAnnPill();
  NW_SEL = Math.min(NW_SEL, Math.max(0, NEWS.cards.length - 1));
  setNewsDirty(false);
  renderLocales();
  renderCardList();
  renderCardDetail();
}

function syncAnnPill() {
  const on = $('#nwAnnEnabled').checked;
  const pill = $('#nwAnnPill');
  pill.textContent = on ? ($('#nwAnnType').value || 'on') : 'off';
  pill.className = `pill ${on ? ({ critical: 'err', warning: 'warn' }[$('#nwAnnType').value] ?? 'acc') : ''}`;
}
['#nwAnnMsg', '#nwAnnType'].forEach((s) => $(s).addEventListener('input', () => { setNewsDirty(true); syncAnnPill(); }));
$('#nwAnnEnabled').addEventListener('change', () => { setNewsDirty(true); syncAnnPill(); });

// Read-only, but visible: verify.js reports locale gaps and there was previously
// nowhere in the UI to see what it was talking about.
function renderLocales() {
  const strings = NEWS.strings ?? {};
  const locales = Object.keys(strings);
  if (!locales.length) {
    $('#nwLocales').innerHTML = '<div class="empty">No strings block — every locale falls back to the launcher\'s built-in English.</div>';
    return;
  }
  const widest = Math.max(...locales.map((l) => Object.keys(strings[l] ?? {}).length));
  $('#nwLocales').innerHTML = locales.map((l) => {
    const keys = Object.keys(strings[l] ?? {});
    const empty = keys.filter((k) => strings[l][k] === '').length;
    const missing = widest - keys.length;
    const state = empty || missing ? 'warn' : 'good';
    const notes = [empty ? `${empty} empty` : '', missing > 0 ? `${missing} fewer keys than the fullest locale` : ''].filter(Boolean);
    return envRow(state, l, `${plural(keys.length, 'key', 'keys')}`, notes.join(' · '));
  }).join('');
}

function renderCardList() {
  const host = $('#nwList');
  $('#nwCount').textContent = NEWS.cards.length;
  if (!NEWS.cards.length) { host.innerHTML = '<div class="empty">No cards.</div>'; return; }
  host.innerHTML = NEWS.cards.map((c, i) => `<div class="item ${i === NW_SEL ? 'sel' : ''}" data-i="${i}" draggable="true">
    <span class="drag" title="Drag to reorder">⠿</span>
    <span class="pill ${c.type === 'patchnotes' ? 'acc' : ''}">${esc(c.type ?? 'update')}</span>
    <span class="name grow">${esc(c.title || c.id || 'untitled')}</span>
    <span class="meta">${esc(c.date ?? '')}</span>
  </div>`).join('');

  $$('.item', host).forEach((el) => {
    const i = +el.dataset.i;
    el.addEventListener('click', () => { NW_SEL = i; renderCardList(); renderCardDetail(); });
    el.addEventListener('dragstart', () => { el.classList.add('dragging'); nwDrag = i; });
    el.addEventListener('dragend', () => { el.classList.remove('dragging'); $$('.item', host).forEach((x) => x.classList.remove('drop-target')); });
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drop-target'); });
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      if (nwDrag === null || nwDrag === i) return;
      const [moved] = NEWS.cards.splice(nwDrag, 1);
      NEWS.cards.splice(i, 0, moved);
      NW_SEL = i; nwDrag = null;
      setNewsDirty(true);
      renderCardList(); renderCardDetail();
    });
  });
}
let nwDrag = null;

function renderCardDetail() {
  const host = $('#nwDetail');
  const c = NEWS.cards[NW_SEL];
  if (!c) { host.innerHTML = '<div class="detail-empty">Select a card to edit it, or add one.</div>'; return; }
  host.innerHTML = `
    <div class="field-row">
      <label>ID<input type="text" data-k="id" value="${esc(c.id ?? '')}"></label>
      <label>Date<input type="text" data-k="date" value="${esc(c.date ?? '')}"></label>
      <label style="max-width:170px">Type<select data-k="type">
        <option value="update"${c.type === 'update' ? ' selected' : ''}>update</option>
        <option value="patchnotes"${c.type === 'patchnotes' ? ' selected' : ''}>patchnotes</option>
      </select></label>
    </div>
    <label>Title<input type="text" data-k="title" value="${esc(c.title ?? '')}"></label>
    <label>Excerpt<textarea rows="3" data-k="excerpt">${esc(c.excerpt ?? '')}</textarea></label>
    <label>Highlights <span class="hint-inline">one per line</span><textarea rows="4" data-k="highlights">${esc((c.highlights ?? []).join('\n'))}</textarea></label>
    <div class="field-row">
      <label>Link URL<input type="text" data-k="linkUrl" value="${esc(c.linkUrl ?? '')}"></label>
      <label>Image URL<input type="text" data-k="imageUrl" value="${esc(c.imageUrl ?? '')}"></label>
    </div>
    <div class="actions" style="margin-top:var(--s4)">
      <button class="btn danger" id="nwRemove">Remove card</button>
    </div>`;

  $$('[data-k]', host).forEach((inp) => inp.addEventListener('change', () => {
    const k = inp.dataset.k;
    if (k === 'highlights') {
      const list = inp.value.split('\n').map((s) => s.trim()).filter(Boolean);
      if (list.length) c.highlights = list; else delete c.highlights;
    } else if (!inp.value.trim() && ['imageUrl', 'linkUrl'].includes(k)) delete c[k];
    else c[k] = inp.value;
    setNewsDirty(true);
    renderCardList();
  }));

  $('#nwRemove').addEventListener('click', () => {
    if (!confirm(`Remove the card "${c.title || c.id}"?`)) return;
    NEWS.cards.splice(NW_SEL, 1);
    NW_SEL = Math.max(0, NW_SEL - 1);
    setNewsDirty(true);
    renderCardList(); renderCardDetail();
  });
}

$('#nwReload').addEventListener('click', () => {
  if (NW_DIRTY && !confirm('You have unsaved news changes. Discard them?')) return;
  loadNews().catch((e) => toast(e.message, 'err'));
});
$('#nwAddCard').addEventListener('click', () => {
  NEWS.cards.unshift({ id: `news-${Date.now()}`, title: 'New card', date: '', type: 'update', excerpt: '' });
  NW_SEL = 0;
  setNewsDirty(true);
  renderCardList(); renderCardDetail();
});
$('#nwSave').addEventListener('click', async () => {
  try {
    NEWS.announcement = {
      enabled: $('#nwAnnEnabled').checked,
      message: $('#nwAnnMsg').value,
      type: $('#nwAnnType').value,
    };
    const r = await api('POST', '/api/news', { news: NEWS });
    setNewsDirty(false);
    toast(`Wrote ${r.written}.`, 'ok');
  } catch (e) { toast(e.message, 'err'); }
});

/* ── leaving with unsaved work ───────────────────────────────────── */

window.addEventListener('beforeunload', (e) => {
  if (MF_DIRTY || NW_DIRTY) { e.preventDefault(); e.returnValue = ''; }
});

/* ── boot ────────────────────────────────────────────────────────── */

resetXfer();
syncDeployControls();
connectEvents();
refreshProbe();
loadState()
  .then(loadSources)
  .catch((e) => toast(e.message, 'err'));
