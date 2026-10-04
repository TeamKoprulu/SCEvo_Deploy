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
const TAB_LOADERS = { catalog: loadCatalog, manifest: () => loadManifest(), news: () => loadNews(), settings: loadState };

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

/* ── CATALOG ─────────────────────────────────────────────────────── */

let CAT = null;
let CT_FILTER = 'campaign';

const CHANNELS = { campaign: ['public', 'beta', 'both', 'off'], melee: ['public', 'off'] };
const CH_LABEL = { public: 'Public', beta: 'Beta', both: 'Both', off: 'Off' };
const BUILD_PILL = { built: ['ok', 'built'], changed: ['warn', 'changed'], unbuilt: ['new', 'not built'], off: ['', 'off'] };
// source -> error from the last build, so a failure stays on its row after the toast is gone.
let LAST_BUILD_ERRORS = new Map();

function buildPill(r) {
  const err = LAST_BUILD_ERRORS.get(r.source);
  if (err) return `<span class="pill err" title="${esc(err)}">build failed</span>`;
  const [cls, label] = BUILD_PILL[r.build] ?? ['', r.build ?? ''];
  return label ? `<span class="pill ${cls}">${esc(label)}</span>` : '';
}

async function loadCatalog() {
  CAT = await api('GET', '/api/catalog');
  const warn = [];
  if (CAT.needsInit) {
    $('#ctWarn').innerHTML = `<div class="banner warn"><b>No catalog yet</b>Create <code>deploy-catalog.json</code> from what is deployed today. Nothing changes for players.
      <div class="actions" style="margin-top:var(--s2)"><button class="btn primary" id="ctInit">Create catalog</button></div></div>`;
    $('#ctInit').addEventListener('click', async () => {
      try { const r = await api('POST', '/api/catalog-init'); toast(`Catalog created: ${r.items} items, ${r.ignored} ignored.`, 'ok'); loadCatalog(); }
      catch (e) { toast(e.message, 'err'); }
    });
    return;
  }
  if (CAT.error) warn.push(`<div class="banner err"><b>Cannot scan sources</b>${esc(CAT.error)}</div>`);
  if (CAT.missingRoots?.length) warn.push(`<div class="banner warn"><b>Roots not found in the SC2 install</b><span class="mono">${CAT.missingRoots.map(esc).join('<br>')}</span></div>`);
  $('#ctWarn').innerHTML = warn.join('');
  renderCatalog();
}

async function catalogEdit(body, okMessage) {
  try {
    await api('POST', '/api/catalog', body);
    if (okMessage) toast(okMessage, 'ok');
    await loadCatalog();
  } catch (e) { toast(e.message, 'err'); }
}

const isMeleeMap = (r) => r.kind === 'map' && (r.item?.package === 'melee' || (!r.item && /SCEvo_MPMaps/i.test(r.source)));

function chSeg(r) {
  const pkg = r.item.package;
  return `<div class="seg ch">${CHANNELS[pkg].map((c) =>
    `<button class="seg-btn${r.item.channel === c ? ' active' : ''}" data-ch="${c}">${CH_LABEL[c]}</button>`).join('')}</div>`;
}

function itemRow(r) {
  const pill = r.status === 'missing' ? '<span class="pill err">source missing</span>' : buildPill(r);
  return `<div class="src" data-source="${esc(r.source)}">
    <div class="grow">
      <div class="name truncate">${esc(r.name)}</div>
      <div class="facts">${pill}${r.packed ? ' <span class="pill unchanged">packed</span>' : ''}</div>
    </div>
    <select class="pkg"><option value="campaign"${r.item.package === 'campaign' ? ' selected' : ''}>Campaign</option><option value="melee"${r.item.package === 'melee' ? ' selected' : ''}>Melee</option></select>
    ${chSeg(r)}
    <button class="btn sm ghost ign">Ignore</button>
  </div>`;
}

function newRow(r) {
  return `<div class="src" data-source="${esc(r.source)}">
    <div class="grow">
      <div class="name truncate">${esc(r.name)}</div>
      <div class="facts"><span class="pill new">new</span> <span class="faint small mono">${esc(r.group)}</span>${r.packed ? ' <span class="pill unchanged">packed</span>' : ''}</div>
    </div>
    <button class="btn sm" data-add="campaign:public">Campaign</button>
    <button class="btn sm" data-add="campaign:beta">Campaign beta</button>
    ${r.kind === 'mod' || isMeleeMap(r) ? '<button class="btn sm" data-add="melee:public">Melee</button>' : ''}
    <button class="btn sm ghost" data-add="campaign:off">Track, off</button>
    <button class="btn sm danger ign">Ignore</button>
  </div>`;
}

function mapCard(r) {
  const m = r.meta || {};
  const on = r.item?.package === 'melee' && r.item.channel === 'public';
  const thumb = `/api/thumb?source=${encodeURIComponent(r.source)}&t=${TOKEN}`;
  const warn = [];
  if (m.error) warn.push(`unreadable: ${m.error}`);
  else if (m.supported === false) warn.push(`not a melee map (${m.reason})`);
  if (on && r.missingMods?.length) warn.push(`needs ${r.missingMods.map((p) => p.split('/').pop()).join(', ')}, which isn't shipped`);
  const pill = on ? buildPill(r) : '';
  return `<div class="mapcard${on ? ' on' : ''}" data-source="${esc(r.source)}">
    <img loading="lazy" src="${thumb}" alt="">
    <div class="mc-body">
      <div class="name truncate" title="${esc(m.name || r.name)}">${esc(m.name || r.name)}</div>
      <div class="faint small">${m.players ? `${m.players} players` : '?'}${m.modes ? ` · ${esc(m.modes)}` : ''}</div>
      <div class="faint small mono truncate" title="${esc(r.source)}">${esc(r.name)}</div>
      ${warn.map((w) => `<div class="small" style="color:var(--err)">${esc(w)}</div>`).join('')}
      <div class="mc-actions">
        <button class="btn sm ${on ? 'ghost' : 'primary'} inc">${on ? 'Remove from pool' : 'Add to pool'}</button>
        ${pill}
        ${!r.item ? '<button class="btn sm ghost ign">Ignore</button>' : ''}
      </div>
    </div>
  </div>`;
}

function renderCatalog() {
  const rows = CAT.rows ?? [];
  const fresh = rows.filter((r) => r.status === 'new' && !isMeleeMap(r));
  $('#ctNewSection').hidden = !fresh.length;
  $('#ctNewCount').textContent = fresh.length;
  $('#ctNew').innerHTML = fresh.map(newRow).join('');

  const listed = rows.filter((r) => r.item && r.item.package === CT_FILTER && !(CT_FILTER === 'melee' && r.kind === 'map'));
  const groups = new Map();
  for (const r of listed) { if (!groups.has(r.group)) groups.set(r.group, []); groups.get(r.group).push(r); }
  $('#ctList').innerHTML = listed.length
    ? [...groups].map(([g, rs]) => `<div class="srcgroup"><h4>${esc(g)}</h4>${rs.map(itemRow).join('')}</div>`).join('')
    : `<div class="empty">Nothing in the ${CT_FILTER} package yet.</div>`;

  const maps = rows.filter(isMeleeMap).filter((r) => r.status !== 'ignored');
  $('#ctMapsSection').hidden = CT_FILTER !== 'melee';
  $('#ctMapCount').textContent = `${maps.filter((r) => r.item?.channel === 'public').length} of ${maps.length}`;
  $('#ctMaps').innerHTML = maps.length ? maps.map(mapCard).join('') : '<div class="empty">No maps under the melee roots.</div>';

  const ignored = rows.filter((r) => r.status === 'ignored');
  $('#ctIgnoredCount').textContent = ignored.length;
  $('#ctIgnored').innerHTML = ignored.map((r) => `<div class="src" data-source="${esc(r.source)}">
      <div class="grow"><div class="name truncate">${esc(r.name)}</div><div class="facts faint small mono">${esc(r.group)}</div></div>
      <button class="btn sm ghost unign">Un-ignore</button></div>`).join('') || '<div class="empty">Nothing ignored.</div>';

  const counts = { built: 0, changed: 0, unbuilt: 0 };
  for (const r of rows) if (r.item?.package === CT_FILTER && counts[r.build] !== undefined) counts[r.build]++;
  $('#ctSummary').textContent = `${CT_FILTER}: ${counts.built} built, ${counts.changed} changed, ${counts.unbuilt} not built`;
  $('#ctBuild').textContent = `Build ${CT_FILTER}`;
  bindCatalog();
}

function bindCatalog() {
  $$('#tab-catalog [data-source]').forEach((el) => {
    const source = el.dataset.source;
    $$('[data-add]', el).forEach((b) => b.addEventListener('click', () => {
      const [pkg, channel] = b.dataset.add.split(':');
      catalogEdit({ source, patch: { package: pkg, channel } }, `${source.split('\\').pop()} → ${pkg} / ${channel}`);
    }));
    $$('.ch .seg-btn', el).forEach((b) => b.addEventListener('click', () => catalogEdit({ source, patch: { channel: b.dataset.ch } })));
    const pkg = $('.pkg', el);
    if (pkg) pkg.addEventListener('change', () => catalogEdit({ source, patch: { package: pkg.value, channel: pkg.value === 'melee' ? 'public' : 'off' } }));
    const ign = $('.ign', el);
    if (ign) ign.addEventListener('click', () => confirm(`Ignore ${source}?\n\nIt won't ship and won't be shown as new again.`) && catalogEdit({ source, ignore: true }, 'Ignored.'));
    const unign = $('.unign', el);
    if (unign) unign.addEventListener('click', () => catalogEdit({ source, ignore: false }, 'Un-ignored — it shows as new again.'));
    const inc = $('.inc', el);
    if (inc) inc.addEventListener('click', () => {
      const on = el.classList.contains('on');
      catalogEdit({ source, patch: { package: 'melee', channel: on ? 'off' : 'public' } });
    });
  });
}

$$('#ctFilter .seg-btn').forEach((b) => b.addEventListener('click', () => {
  $$('#ctFilter .seg-btn').forEach((x) => x.classList.toggle('active', x === b));
  CT_FILTER = b.dataset.f;
  if (CAT && !CAT.needsInit) renderCatalog();
}));
$('#ctRefresh').addEventListener('click', () => loadCatalog().catch((e) => toast(e.message, 'err')));

$('#ctBuild').addEventListener('click', async () => {
  $('#ctBuild').disabled = true;
  LAST_BUILD_ERRORS = new Map();
  try {
    const r = await api('POST', '/api/build', { packages: [CT_FILTER], force: $('#ctForce').checked });
    const bad = r.results.filter((x) => !x.ok);
    LAST_BUILD_ERRORS = new Map(bad.map((b) => [b.source, b.error]));
    const did = r.results.filter((x) => x.ok && x.action !== 'up-to-date').length;
    const msgs = [`${did} built or copied`, `${r.results.length - did - bad.length} already up to date`];
    if (r.pruned.length) msgs.push(`${r.pruned.length} removed`);
    const changed = r.manifests.filter((m) => m.changed).map((m) => m.file);
    if (changed.length) msgs.push(`wrote ${changed.join(', ')}`);
    toast(bad.length ? `${bad.length} failed: ${bad.map((b) => `${b.source.split('\\').pop()} — ${b.error}`).join(' · ')}` : msgs.join(' · '), bad.length ? 'err' : 'ok');
    if (r.problems.length) toast(r.problems.join(' · '), 'err');
    await loadCatalog();
  } catch (e) { toast(e.message, 'err'); }
  finally { $('#ctBuild').disabled = false; }
});

listeners.add((msg) => {
  if (msg.job !== 'build' || msg.type !== 'progress' || !msg.file) return;
  const detail = msg.phase === 'packing' ? `packing ${msg.fileCount} files` : msg.phase === 'start' ? 'checking' : msg.phase;
  $('#ctSummary').textContent = `${msg.file} — ${detail}${msg.total ? ` (${msg.index}/${msg.total})` : ''}`;
});

/* ── MANIFEST ────────────────────────────────────────────────────── */

let BRANCH = 'public';
let MANIFEST = null;
let MF_DIRTY = false;

function setManifestDirty(on) {
  MF_DIRTY = on;
  $('#mfDirtyDot').hidden = !on;
  $('#mfDirtyBanner').hidden = !on;
  $('#mfSave').textContent = on ? 'Write manifest •' : 'Write manifest';
}

function confirmDiscard() {
  return !MF_DIRTY || confirm('You have unsaved settings. Discard them?');
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
  if (MANIFEST.needsInit) { $('#mfList').innerHTML = '<div class="empty">Create the catalog on the Catalog tab first.</div>'; return; }
  const isBeta = BRANCH === 'beta', isMelee = BRANCH === 'melee';

  $('#mfMetaTitle').textContent = isBeta ? 'Beta metadata' : isMelee ? 'Melee package' : 'Versions';
  $('#mfPublicVersions').hidden = isBeta || isMelee;
  $('#mfBetaMeta').hidden = !isBeta;
  $('#mfMeleeMeta').hidden = !isMelee;
  $('#mfCritSection').hidden = isMelee;
  $('#mfCritSevWrap').style.display = isBeta ? 'none' : '';

  $('#mfVerCore').value = MANIFEST.versions?.multiplayer ?? '';
  $('#mfVerCampaign').value = MANIFEST.versions?.campaign ?? '';
  $('#mfMeleeVersion').value = MANIFEST.meleeVersion ?? '';

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

  setManifestDirty(false);
  renderManifestEntries();
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

['#mfVerCore', '#mfVerCampaign', '#mfCritMin', '#mfCritMsg', '#mfCritSev', '#mfBetaName',
 '#mfBetaAccent', '#mfBetaMajor', '#mfBetaFull', '#mfBetaCore', '#mfBetaCode', '#mfMeleeVersion']
  .forEach((sel) => $(sel).addEventListener('input', () => { setManifestDirty(true); syncCritPill(); }));
$('#mfCritEnabled').addEventListener('change', () => { setManifestDirty(true); syncCritPill(); });
$('#mfBetaEnabled').addEventListener('change', () => { setManifestDirty(true); syncBetaGate(); });

function renderManifestEntries() {
  const entries = MANIFEST.entries ?? [];
  $('#mfCount').textContent = entries.filter((e) => e.state !== 'removed').length;
  const fresh = $('#mfFresh');
  fresh.textContent = MANIFEST.upToDate ? 'matches the catalog' : 'out of date — Write manifest or Build';
  fresh.className = `pill ${MANIFEST.upToDate ? 'ok' : 'warn'}`;
  $('#mfProblems').innerHTML = (MANIFEST.problems ?? []).length
    ? `<div class="banner err"><b>Not everything is built</b>${MANIFEST.problems.map(esc).join('<br>')}</div>` : '';
  $('#mfList').innerHTML = entries.length ? entries.map((e) => `<div class="item">
      <span class="pill ${e.state === 'removed' ? 'err' : e.state}">${esc(e.state)}</span>
      <span class="name grow">${esc(e.name)} <span class="faint small mono">${esc(e.path)}</span></span>
      <span class="meta">${e.players ? `${e.players}P · ` : ''}${e.size ? fmtBytes(e.size) : ''}</span>
    </div>`).join('') : '<div class="empty">Nothing in this manifest. Switch items on in the Catalog tab and build.</div>';
}

$('#mfReload').addEventListener('click', () => {
  if (!confirmDiscard()) return;
  loadManifest().catch((e) => toast(e.message, 'err'));
});

$('#mfSave').addEventListener('click', async () => {
  try {
    const payload = { branch: BRANCH };
    if (BRANCH !== 'melee') {
      payload.criticalUpdate = {
        enabled: $('#mfCritEnabled').checked,
        minVersion: $('#mfCritMin').value.trim(),
        message: $('#mfCritMsg').value.trim(),
        severity: $('#mfCritSev').value,
      };
    }
    if (BRANCH === 'public') {
      payload.versions = { multiplayer: $('#mfVerCore').value.trim(), campaign: $('#mfVerCampaign').value.trim() };
    } else if (BRANCH === 'beta') {
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
    } else {
      payload.meleeVersion = $('#mfMeleeVersion').value.trim();
    }
    const r = await api('POST', '/api/manifest', payload);
    setManifestDirty(false);
    const changed = r.written.filter((w) => w.changed).map((w) => w.file);
    toast(changed.length ? `Wrote ${changed.join(', ')}.` : 'Nothing changed.', 'ok');
    if (r.problems.length) toast(r.problems.join(' · '), 'err');
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
        await api('POST', '/api/remote-delete', { prefix: r.prefix, paths });
        toast(`Deleted ${plural(paths.length, 'object', 'objects')}.`, 'ok');
        $('#vfOrphans').click();
      } catch (e) { toast(e.message, 'err'); }
    });
  } catch (e) { box.innerHTML = `<div class="banner err">${esc(e.message)}</div>`; }
});

/* ── DEPLOY ──────────────────────────────────────────────────────── */

let DRY = true;

const UPLOAD_ORDER = ['payload', 'betapayload', 'meleepayload', 'assets', 'launcher', 'installer', 'manifests'];
const deployPackages = () => [$('#dpPkgCampaign').checked && 'campaign', $('#dpPkgMelee').checked && 'melee'].filter(Boolean);

function syncDeployControls() {
  const pk = deployPackages();
  $('#dpBranchNote').innerHTML = pk.length
    ? `Manifests are regenerated from the catalog first. Only the chosen packages' folders and manifests are uploaded.`
    : '<b>Choose at least one package.</b>';
  $('#dpRun').disabled = !pk.length;
  $('#dpModeNote').innerHTML = DRY
    ? 'Nothing is written to R2. rclone reports what it <em>would</em> transfer.'
    : '<b>Uploads to the live bucket.</b> Users see the new manifests as soon as step 5 finishes.';
  const run = $('#dpRun');
  run.textContent = DRY ? 'Start dry run' : 'Start live deploy';
  run.className = DRY ? 'btn primary' : 'btn danger';
  $$('#dpMode .seg-btn').forEach((b) => b.classList.toggle('hot', !DRY && b.dataset.mode === 'live'));
}

['#dpPkgCampaign', '#dpPkgMelee'].forEach((sel) => $(sel).addEventListener('change', syncDeployControls));
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
    `Packages: ${deployPackages().join(' + ')}\n` +
    (force ? `\nWARNING: check failures will be ignored.\n` : '') +
    `\nUsers see the new manifests as soon as the upload finishes.`)) return;

  $('#dpRun').disabled = true;
  $('#dpLog').textContent = '';
  $('#dpResult').innerHTML = '';
  resetRail();
  resetXfer();

  try {
    const r = await api('POST', '/api/deploy', { dryRun: DRY, force, packages: deployPackages() });
    if (r.aborted) {
      const findings = r.stage === 'preflight' ? Object.values(r.preflight).flatMap((p) => p.findings)
        : r.stage === 'generate' ? (r.problems ?? []).map((p) => ({ level: 'error', code: 'unbuilt', message: p }))
        : (r.postflight ?? []);
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

// news-feed.json "feed" is an ordered list of slots:
//   post    a site post picked by rule (tag + nth newest), fields overridable
//   banner  an image-only card
//   custom  a hand-written card (the old "cards" format)
// Saving also writes "cards", the English snapshot older launchers read.
let NEWS = null;
let NW_SEL = 0;
let NW_DIRTY = false;
let NW_LOC = '';          // '' = all languages (base), else a launcher language
let NW_PREVIEW = new Map(); // feed index → resolved card in the preview language
let NW_SITE = { posts: [], tags: [], error: null };
const NW_LANGS = ['en', 'es', 'zh', 'ko', 'ru'];
const NW_KIND_LABEL = { post: 'site post', banner: 'banner', custom: 'custom' };

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
  // First edit of an old file: its cards become custom slots.
  NEWS.feed ??= NEWS.cards.map((c) => ({ kind: 'custom', ...c }));
  $('#nwAnnEnabled').checked = !!NEWS.announcement.enabled;
  $('#nwAnnType').value = NEWS.announcement.type ?? 'info';
  $('#nwAnnMsg').value = NEWS.announcement.message ?? '';
  syncAnnPill();
  NW_SEL = Math.min(NW_SEL, Math.max(0, NEWS.feed.length - 1));
  setNewsDirty(false);
  renderLocales();
  renderCardList();
  renderCardDetail();
  if (!NW_SITE.posts.length) loadSitePosts(false);
  else refreshPreview();
}

async function loadSitePosts(refresh) {
  $('#nwSiteState').textContent = 'Fetching scevo.org posts…';
  try {
    const r = await api('GET', `/api/site-posts${refresh ? '?refresh=1' : ''}`);
    NW_SITE = { posts: r.posts, tags: r.tags, error: null };
    $('#nwSiteState').textContent = r.posts.length ? `${plural(r.posts.length, 'site post', 'site posts')} · newest ${r.posts[0].date}` : 'scevo.org returned no posts';
  } catch (e) {
    NW_SITE = { posts: [], tags: [], error: e.message };
    $('#nwSiteState').textContent = `scevo.org unreachable: ${e.message}`;
  }
  renderCardDetail();
  refreshPreview();
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

const previewLang = () => NW_LOC || 'en';
let nwPreviewTimer = null;
let nwPreviewSeq = 0;
function refreshPreview() {
  clearTimeout(nwPreviewTimer);
  nwPreviewTimer = setTimeout(async () => {
    const seq = ++nwPreviewSeq;
    try {
      const r = await api('POST', '/api/news-preview', { feed: NEWS.feed, lang: previewLang() });
      if (seq !== nwPreviewSeq) return;
      NW_PREVIEW = new Map(r.cards.map((c) => [c.slot, c]));
    } catch (e) {
      if (seq !== nwPreviewSeq) return;
      NW_PREVIEW = new Map();
    }
    renderCardList();
    renderPreviewPane();
    fillPlaceholders();
  }, 250);
}

function slotLabel(s) {
  if (s.kind === 'post') {
    const n = Number(s.rule?.index) || 1;
    return `${s.rule?.tag ? `Latest “${s.rule.tag}”` : 'Latest post'}${n > 1 ? ` #${n}` : ''}${s.exclude === 'used' ? ' · skip shown' : ''}`;
  }
  if (s.kind === 'banner') return s.title || s.imageUrl?.split('/').pop() || 'Image banner';
  return s.title || s.id || 'untitled';
}

function renderCardList() {
  const host = $('#nwList');
  const feed = NEWS.feed;
  $('#nwCount').textContent = feed.length;
  if (!feed.length) { host.innerHTML = '<div class="empty">No cards. Add a site post, a banner or a custom card.</div>'; return; }
  host.innerHTML = feed.map((s, i) => {
    const shown = NW_PREVIEW.get(i);
    const meta = s.kind === 'post' ? (shown ? shown.title : (NW_SITE.posts.length ? 'no matching post' : '')) : (s.date ?? '');
    return `<div class="item ${i === NW_SEL ? 'sel' : ''}${s.enabled === false ? ' off' : ''}" data-i="${i}" draggable="true">
      <span class="drag" title="Drag to reorder">⠿</span>
      <span class="pill ${s.kind === 'post' ? 'acc' : s.kind === 'banner' ? 'warn' : ''}">${NW_KIND_LABEL[s.kind] ?? 'custom'}</span>
      ${s.variant ? `<span class="pill">${esc(s.variant)}</span>` : ''}
      <span class="grow"><span class="name truncate" style="display:block">${esc(slotLabel(s))}</span>
        ${meta ? `<span class="meta truncate" style="display:block">${s.kind === 'post' ? '→ ' : ''}${esc(meta)}</span>` : ''}</span>
    </div>`;
  }).join('');

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
      const [moved] = feed.splice(nwDrag, 1);
      feed.splice(i, 0, moved);
      NW_SEL = i; nwDrag = null;
      newsChanged(true);
    });
  });
}
let nwDrag = null;

// Fields per kind. In a language tab only the translatable ones show.
const NW_FIELDS = {
  post:   ['title', 'excerpt', 'highlights', 'imageUrl', 'linkUrl', 'badge', 'badgeColor'],
  banner: ['imageUrl', 'linkUrl', 'title'],
  custom: ['title', 'date', 'type', 'excerpt', 'highlights', 'imageUrl', 'linkUrl', 'badge', 'badgeColor', 'readMoreLabel'],
};
const NW_LOCAL_FIELDS = ['title', 'excerpt', 'highlights', 'imageUrl', 'linkUrl', 'badge', 'readMoreLabel'];
const NW_LABEL = {
  title: 'Title', excerpt: 'Description', highlights: 'Highlights', imageUrl: 'Image URL', linkUrl: 'Link URL',
  badge: 'Badge', badgeColor: 'Badge colour', date: 'Date', type: 'Type', readMoreLabel: '“Read more” text',
};

// The object a field edit writes to: the slot (or its overrides) for all languages, else locales[lang].
function editTarget(s, create) {
  if (NW_LOC) {
    if (create) { s.locales ??= {}; s.locales[NW_LOC] ??= {}; }
    return s.locales?.[NW_LOC] ?? {};
  }
  if (s.kind === 'post') { if (create) s.overrides ??= {}; return s.overrides ?? {}; }
  return s;
}

function cleanSlot(s) {
  if (s.overrides && !Object.keys(s.overrides).length) delete s.overrides;
  if (s.locales) {
    for (const l of Object.keys(s.locales)) if (!Object.keys(s.locales[l] ?? {}).length) delete s.locales[l];
    if (!Object.keys(s.locales).length) delete s.locales;
  }
}

function fieldHtml(k, v) {
  const val = k === 'highlights' ? (v ?? []).join('\n') : (v ?? '');
  if (k === 'type') {
    return `<label style="max-width:170px">${NW_LABEL[k]}<select data-f="type">
      ${['update', 'patchnotes'].map((t) => `<option value="${t}"${(v ?? 'update') === t ? ' selected' : ''}>${t}</option>`).join('')}</select></label>`;
  }
  if (k === 'excerpt' || k === 'highlights') {
    return `<label>${NW_LABEL[k]}${k === 'highlights' ? ' <span class="hint-inline">one per line; makes a patch-notes card</span>' : ''}
      <textarea rows="3" data-f="${k}">${esc(val)}</textarea></label>`;
  }
  return `<label>${NW_LABEL[k]}<input type="text" data-f="${k}" value="${esc(val)}"></label>`;
}

function renderCardDetail() {
  const host = $('#nwDetail');
  const s = NEWS?.feed?.[NW_SEL];
  if (!s) { host.innerHTML = '<div class="detail-empty">Select a card to edit it, or add one.</div>'; return; }
  const target = editTarget(s, false);
  const fields = NW_FIELDS[s.kind] ?? NW_FIELDS.custom;
  const shownFields = NW_LOC ? fields.filter((k) => NW_LOCAL_FIELDS.includes(k)) : fields;
  const tags = [...new Set([...(NW_SITE.tags ?? []), ...(s.rule?.tag ? [s.rule.tag] : [])])];

  host.innerHTML = `
    <div class="field-row">
      <label>ID<input type="text" data-s="id" value="${esc(s.id ?? '')}"></label>
      <label style="max-width:170px">Shown on<select data-s="variant">
        ${[['', 'both channels'], ['public', 'public only'], ['beta', 'beta only']].map(([v, l]) =>
          `<option value="${v}"${(s.variant ?? '') === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="check" style="flex:none;align-self:end"><input type="checkbox" data-s="enabled"${s.enabled === false ? '' : ' checked'}> Shown</label>
    </div>
    ${s.kind === 'post' ? `
    <div class="field-row">
      <label>Post with tag<select data-r="tag">
        <option value="">any tag (latest posts)</option>
        ${tags.map((t) => `<option${s.rule?.tag === t ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
      <label style="max-width:120px">Which<input type="number" min="1" data-r="index" value="${Number(s.rule?.index) || 1}"></label>
      <label class="check" style="flex:none;align-self:end" title="Skip posts that an earlier card already shows">
        <input type="checkbox" data-x="exclude"${s.exclude === 'used' ? ' checked' : ''}> Skip posts shown above</label>
    </div>
    <p class="hint">“Which” 1 is the newest matching post, 2 the one before, and so on.${NW_SITE.error ? ` <b>scevo.org unreachable:</b> ${esc(NW_SITE.error)}` : ''}</p>` : ''}
    ${s.kind === 'banner' ? '<p class="hint">The image fills the whole card; no text is shown. Title is only the hover text.</p>' : ''}

    <div class="sec-head" style="padding:var(--s3) 0 var(--s2);background:none;border:0">
      <h3>${s.kind === 'post' ? 'Overrides' : 'Content'}</h3>
      <div class="seg" id="nwLocSeg">
        ${['', ...NW_LANGS].map((l) => `<button class="seg-btn${NW_LOC === l ? ' active' : ''}" data-l="${l}">${l || 'All languages'}${l && s.locales?.[l] ? ' •' : ''}</button>`).join('')}
      </div>
    </div>
    <p class="hint">${NW_LOC
      ? `Only for the launcher in <b>${NW_LOC}</b>. Empty fields use ${s.kind === 'post' ? 'the site post (in that language when translated)' : 'the All languages value'}.`
      : s.kind === 'post' ? 'Empty fields are filled from the site post. Grey text is what it shows now.' : ''}</p>
    <div class="nw-fields">${shownFields.map((k) => fieldHtml(k, target[k])).join('')}</div>

    <div class="sec-head" style="padding:var(--s3) 0 var(--s2);background:none;border:0"><h3>Preview <span class="faint small">(${previewLang()})</span></h3></div>
    <div id="nwPreview"></div>

    <div class="actions" style="margin-top:var(--s4)">
      <button class="btn danger" id="nwRemove">Remove card</button>
    </div>`;

  $$('[data-s]', host).forEach((inp) => inp.addEventListener('change', () => {
    const k = inp.dataset.s;
    if (k === 'enabled') { if (inp.checked) delete s.enabled; else s.enabled = false; }
    else if (inp.value.trim()) s[k] = inp.value.trim(); else delete s[k];
    newsChanged(false);
  }));
  $$('[data-r]', host).forEach((inp) => inp.addEventListener('change', () => {
    s.rule ??= {};
    if (inp.dataset.r === 'index') s.rule.index = Math.max(1, Number(inp.value) || 1);
    else if (inp.value) s.rule.tag = inp.value; else delete s.rule.tag;
    newsChanged(false);
  }));
  $$('[data-x]', host).forEach((inp) => inp.addEventListener('change', () => {
    if (inp.checked) s.exclude = 'used'; else delete s.exclude;
    newsChanged(false);
  }));
  $$('[data-f]', host).forEach((inp) => inp.addEventListener('change', () => {
    const k = inp.dataset.f;
    const t = editTarget(s, true);
    if (k === 'highlights') {
      const list = inp.value.split('\n').map((x) => x.trim()).filter(Boolean);
      if (list.length) t.highlights = list; else delete t.highlights;
    } else if (inp.value.trim()) t[k] = k === 'excerpt' ? inp.value : inp.value.trim();
    else delete t[k];
    cleanSlot(s);
    newsChanged(false);
  }));
  $$('#nwLocSeg .seg-btn', host).forEach((b) => b.addEventListener('click', () => {
    NW_LOC = b.dataset.l;
    renderCardDetail();
    refreshPreview();
  }));
  $('#nwRemove').addEventListener('click', () => {
    if (!confirm(`Remove "${slotLabel(s)}"?`)) return;
    NEWS.feed.splice(NW_SEL, 1);
    NW_SEL = Math.max(0, NW_SEL - 1);
    newsChanged(true);
  });
  renderPreviewPane();
  fillPlaceholders();
}

// Grey placeholder = what the card shows without this field (post slots).
function fillPlaceholders() {
  const s = NEWS?.feed?.[NW_SEL];
  if (!s || s.kind !== 'post') return;
  const c = NW_PREVIEW.get(NW_SEL) ?? {};
  $$('#nwDetail [data-f]').forEach((inp) => {
    if (inp.tagName === 'SELECT') return;
    const v = c[inp.dataset.f];
    inp.placeholder = Array.isArray(v) ? v.join('\n') : (v ?? '');
  });
}

function renderPreviewPane() {
  const host = $('#nwPreview');
  if (!host) return;
  const s = NEWS.feed[NW_SEL];
  const c = NW_PREVIEW.get(NW_SEL);
  if (!c) {
    host.innerHTML = `<div class="empty small">${s?.enabled === false ? 'Hidden.' : s?.kind === 'post'
      ? (NW_SITE.posts.length ? 'No site post matches this rule; the card is left out.' : 'Waiting for scevo.org…')
      : s?.kind === 'banner' ? 'Set an image URL.' : 'Nothing to show.'}</div>`;
    return;
  }
  if (c.type === 'banner') {
    host.innerHTML = `<div class="nwcard banner"><img src="${esc(c.imageUrl)}" alt=""></div>`;
    return;
  }
  const body = Array.isArray(c.highlights) && c.highlights.length && c.type === 'patchnotes'
    ? `<ul>${c.highlights.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>`
    : `<p>${esc(c.excerpt ?? '')}</p>`;
  host.innerHTML = `<div class="nwcard">
    <div class="nwimg">${c.imageUrl ? `<img src="${esc(c.imageUrl)}" alt="">` : ''}
      ${c.badge ? `<span class="nwbadge" style="${c.badgeColor ? `border-color:${esc(c.badgeColor)};color:${esc(c.badgeColor)}` : ''}">${esc(c.badge)}</span>` : ''}</div>
    <div class="nwbody"><b>${esc(c.title ?? '')}</b><span class="faint small">${esc(c.date ?? '')}</span>${body}
      ${c.linkUrl ? `<span class="faint small truncate">${esc(c.linkUrl)}</span>` : ''}</div>
  </div>`;
}

function newsChanged(listOnly) {
  setNewsDirty(true);
  renderCardList();
  if (listOnly) renderCardDetail();
  refreshPreview();
}

function addSlot(slot) {
  NEWS.feed.unshift(slot);
  NW_SEL = 0;
  NW_LOC = '';
  newsChanged(true);
}
$('#nwAddPost').addEventListener('click', () => addSlot({ id: `post-${Date.now()}`, kind: 'post', rule: { index: 1 }, exclude: 'used' }));
$('#nwAddBanner').addEventListener('click', () => addSlot({ id: `banner-${Date.now()}`, kind: 'banner' }));
$('#nwAddCustom').addEventListener('click', () => addSlot({ id: `news-${Date.now()}`, kind: 'custom', title: 'New card', date: '', type: 'update', excerpt: '' }));
$('#nwRefreshSite').addEventListener('click', () => loadSitePosts(true));

$('#nwReload').addEventListener('click', () => {
  if (NW_DIRTY && !confirm('You have unsaved news changes. Discard them?')) return;
  loadNews().catch((e) => toast(e.message, 'err'));
});
$('#nwSave').addEventListener('click', async () => {
  try {
    const { cards, ...rest } = NEWS;
    const news = {
      ...rest,
      announcement: {
        ...NEWS.announcement,
        enabled: $('#nwAnnEnabled').checked,
        message: $('#nwAnnMsg').value,
        type: $('#nwAnnType').value,
      },
    };
    const r = await api('POST', '/api/news', { news });
    setNewsDirty(false);
    if (r.warnings?.length) toast(r.warnings.join(' '), 'warn');
    else toast(`Wrote ${r.written}.`, 'ok');
    await loadNews();
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
  .then(loadCatalog)
  .catch((e) => toast(e.message, 'err'));
