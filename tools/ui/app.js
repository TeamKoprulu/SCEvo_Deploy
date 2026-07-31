'use strict';
/* SCEvo Deploy Tool — UI */

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
  toast._t = setTimeout(() => { el.hidden = true; }, 5200);
}

const fmtBytes = (n) => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 3);
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ── tabs ────────────────────────────────────────────────────── */
$$('.tab').forEach((btn) => btn.addEventListener('click', () => {
  $$('.tab').forEach((b) => b.classList.toggle('active', b === btn));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${btn.dataset.tab}`));
  const loader = { manifest: loadManifest, package: loadSources, news: loadNews, settings: loadState }[btn.dataset.tab];
  if (loader) loader();
}));

/* ── event stream ────────────────────────────────────────────── */
const listeners = new Set();
function connectEvents() {
  const es = new EventSource(`/api/events?t=${TOKEN}`);
  es.onmessage = (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'job-start') setStatus('busy', `${msg.job}…`);
    if (msg.type === 'job-done')  setStatus('ok', 'ready');
    if (msg.type === 'job-error') setStatus('err', msg.message);
    listeners.forEach((fn) => fn(msg));
  };
  es.onerror = () => setStatus('err', 'disconnected');
  es.onopen = () => setStatus('ok', 'ready');
}
function setStatus(kind, text) {
  $('#statusDot').className = `dot ${kind}`;
  $('#statusText').textContent = text;
}

/* ── state / settings ────────────────────────────────────────── */

// `rclone version` and `listremotes` pass even with a revoked key, so the probe
// is the only row here that proves a deploy will actually work.
function probeLabel(probe) {
  if (!probe) return '<span style="color:var(--muted)">not checked (needs rclone + cf: remote)</span>';
  if (probe.ok) return `reachable — ${probe.prefixes.length} top-level entr${probe.prefixes.length === 1 ? 'y' : 'ies'}`;
  const heading = {
    auth: 'ACCESS DENIED — check the R2 API token',
    network: 'UNREACHABLE',
    timeout: 'TIMED OUT',
    'no-bucket': 'BUCKET/REMOTE NOT FOUND',
    'no-rclone': 'rclone missing',
  }[probe.status] ?? 'FAILED';
  return `${esc(heading)}<div class="detail" style="margin-top:4px">${esc(probe.error)}</div>`;
}

let STATE = null;
async function loadState() {
  STATE = await api('GET', '/api/state');
  $('#stSc2').value = STATE.config.sc2InstallPath;
  $('#stLauncher').value = STATE.config.launcherRepoPath;
  $('#stDebug').checked = STATE.config.showVersionDebug;
  const p = STATE.paths, rc = STATE.rclone;
  const row = (k, v, good) => `<div class="k">${k}</div><div class="${good === undefined ? '' : good ? 'yes' : 'no'}">${v}</div>`;
  $('#stEnv').innerHTML =
    row('Repo root', esc(p.repoRoot)) +
    row('SC2 install', p.sc2Valid ? 'found' : 'NOT FOUND', p.sc2Valid) +
    row('Launcher repo', p.launcherValid ? 'found' : 'NOT FOUND', p.launcherValid) +
    row('MPQEditor.exe', p.mpqEditor ? 'found' : 'NOT FOUND', p.mpqEditor) +
    row('payload/', p.payloadExists ? 'present' : 'missing', p.payloadExists) +
    row('betapayload/', p.betaExists ? 'present' : 'missing', p.betaExists) +
    row('rclone', rc.ok ? esc(rc.version) : esc(rc.error), rc.ok) +
    row('cf: remote', rc.hasCf ? 'configured' : 'NOT CONFIGURED', rc.hasCf) +
    row('R2 bucket', probeLabel(rc.probe), rc.probe ? rc.probe.ok : undefined) +
    row('Hash cache', `${STATE.cache.entries} entries`);
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
$('#stPrune').addEventListener('click', async () => {
  const r = await api('POST', '/api/cache-prune');
  toast(`Pruned ${r.removed} stale entr${r.removed === 1 ? 'y' : 'ies'}.`, 'ok');
  loadState();
});

/* ── PACKAGE ─────────────────────────────────────────────────── */
let SOURCES = [];
async function loadSources() {
  const data = await api('GET', '/api/sources');
  SOURCES = data.sources ?? [];
  const warn = [];
  if (data.error) warn.push(`<div class="banner err">${esc(data.error)}</div>`);
  if (data.missingRoots?.length) {
    warn.push(`<div class="banner warn">Not found in the SC2 install: ${data.missingRoots.map(esc).join(', ')}</div>`);
  }
  $('#pkgWarn').innerHTML = warn.join('');
  renderSources();
}

function renderSources() {
  const tbody = $('#pkgTable tbody');
  $('#pkgEmpty').hidden = SOURCES.length > 0;
  tbody.innerHTML = SOURCES.map((s, i) => {
    const opts = [
      ['', 'Skip'],
      ['payload', 'Payload'],
      ['betapayload', 'Betapayload'],
      ['both', 'Both'],
    ].map(([v, l]) => `<option value="${v}"${s._action === v ? ' selected' : ''}>${l}</option>`).join('');
    return `<tr class="${s.vetoed ? 'vetoed' : ''}" data-i="${i}">
      <td><span class="mono">${esc(s.relPath)}</span></td>
      <td class="num">${s.fileCount}</td>
      <td class="${s.inPayload ? 'yes' : 'no'}">${s.inPayload ? 'yes' : '—'}</td>
      <td class="${s.inBetapayload ? 'yes' : 'no'}">${s.inBetapayload ? 'yes' : '—'}</td>
      <td>${s.vetoed ? '<span class="pill missing">vetoed</span>' : `<select class="act">${opts}</select>`}</td>
      <td><button class="btn sm ${s.vetoed ? '' : 'danger'} veto">${s.vetoed ? 'Un-veto' : 'Veto'}</button></td>
    </tr>`;
  }).join('');

  $$('#pkgTable tbody tr').forEach((tr) => {
    const s = SOURCES[+tr.dataset.i];
    tr.querySelector('.act')?.addEventListener('change', (e) => { s._action = e.target.value; });
    tr.querySelector('.veto').addEventListener('click', async () => {
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

$('#pkgRefresh').addEventListener('click', loadSources);
$('#pkgSelectChanged').addEventListener('click', () => {
  SOURCES.forEach((s) => { if (!s.vetoed && s.inPayload) s._action = 'payload'; });
  renderSources();
});
$('#pkgSelectNew').addEventListener('click', () => {
  SOURCES.forEach((s) => { if (!s.vetoed && !s.inPayload && !s.inBetapayload) s._action = 'payload'; });
  renderSources();
});

$('#pkgBuild').addEventListener('click', async () => {
  const items = SOURCES.filter((s) => !s.vetoed && s._action).map((s) => ({
    relPath: s.relPath,
    targets: s._action === 'both' ? ['payload', 'betapayload'] : [s._action],
  }));
  if (!items.length) return toast('Nothing selected.', 'err');
  $('#pkgBuild').disabled = true;
  try {
    const { results } = await api('POST', '/api/package', { items });
    const bad = results.filter((r) => !r.ok);
    results.forEach((r) => {
      if (!r.ok) console.error(r.name, r.error, r.stdout, r.stderr);
    });
    toast(bad.length ? `${bad.length} failed: ${bad.map((b) => b.name).join(', ')}` : `Packaged ${results.length} archive(s).`,
      bad.length ? 'err' : 'ok');
    await loadSources();
  } catch (e) { toast(e.message, 'err'); }
  finally { $('#pkgBuild').disabled = false; }
});

/* ── MANIFEST ────────────────────────────────────────────────── */
let BRANCH = 'public';
let MANIFEST = null;

$$('#tab-manifest .seg-btn').forEach((b) => b.addEventListener('click', () => {
  $$('#tab-manifest .seg-btn').forEach((x) => x.classList.toggle('active', x === b));
  BRANCH = b.dataset.branch;
  loadManifest();
}));

async function loadManifest() {
  MANIFEST = await api('GET', `/api/manifest?branch=${BRANCH}`);
  const isBeta = BRANCH === 'beta';
  $('#mfPublicVersions').hidden = isBeta;
  $('#mfBetaMeta').hidden = !isBeta;
  $('#mfCritSevWrap').style.display = isBeta ? 'none' : '';

  $('#mfVerCore').value = MANIFEST.versions?.multiplayer ?? '';
  $('#mfVerCampaign').value = MANIFEST.versions?.campaign ?? '';

  const cu = MANIFEST.criticalUpdate ?? {};
  $('#mfCritEnabled').checked = !!cu.enabled;
  $('#mfCritMin').value = cu.minVersion ?? '';
  $('#mfCritMsg').value = cu.message ?? '';
  $('#mfCritSev').value = cu.severity ?? 'critical';

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
  }
  renderModules();
}

function renderModules() {
  const host = $('#mfModules');
  $('#mfCount').textContent = MANIFEST.modules.length;
  host.innerHTML = MANIFEST.modules.map((m, i) => {
    const f = m.files[0] ?? {};
    const urls = f.downloadUrls?.join('\n') ?? f.downloadUrl ?? '';
    const drift = f.state === 'missing' ? ''
      : (f.manifestSize != null && f.manifestSize !== f.size)
        ? `<div class="detail" style="color:var(--warn)">manifest size ${f.manifestSize?.toLocaleString()} → disk ${f.size?.toLocaleString()}</div>` : '';
    return `<div class="module state-${m.state}" data-i="${i}" draggable="true">
      <div class="module-head">
        <span class="drag" title="Drag to reorder">⠿</span>
        <span class="pill ${m.state}">${m.state}</span>
        <span class="name">${esc(m.name || m.id)}</span>
        <span class="module-path">${esc(f.path ?? '')}</span>
        <span class="module-path">${f.size ? fmtBytes(f.size) : ''}</span>
        <button class="btn sm toggle">Edit</button>
      </div>
      <div class="module-body">
        ${drift}
        <div class="field-row">
          <label>Module ID<input type="text" data-k="id" value="${esc(m.id)}"></label>
          <label>Name<input type="text" data-k="name" value="${esc(m.name)}"></label>
          <label>Type<select data-k="type">
            <option value=""${!m.type ? ' selected' : ''}>(omit)</option>
            <option value="core"${m.type === 'core' ? ' selected' : ''}>core</option>
            <option value="campaign"${m.type === 'campaign' ? ' selected' : ''}>campaign</option>
          </select></label>
        </div>
        <label>Description<input type="text" data-k="description" value="${esc(m.description)}"></label>
        <div class="mono small" style="color:var(--muted)">sha256 ${esc(f.hash ?? '—')}</div>
        <details class="adv">
          <summary>Advanced: mirror URLs</summary>
          <p class="hint">Normally empty — the launcher derives the R2 URL from the path. One URL per line; two or more become <code>downloadUrls</code> and are ping-raced by the client.</p>
          <textarea rows="2" data-k="urls" placeholder="(none)">${esc(urls)}</textarea>
        </details>
        <div class="actions left">
          <button class="btn sm promote">${BRANCH === 'beta' ? 'Copy to public' : 'Copy to beta'}</button>
          <button class="btn sm danger remove">Remove module</button>
        </div>
      </div>
    </div>`;
  }).join('');

  $$('.module', host).forEach((el) => {
    const i = +el.dataset.i, m = MANIFEST.modules[i];
    el.querySelector('.toggle').addEventListener('click', () => el.classList.toggle('open'));
    $$('[data-k]', el).forEach((inp) => inp.addEventListener('change', () => {
      const k = inp.dataset.k;
      if (k === 'urls') {
        const list = inp.value.split('\n').map((s) => s.trim()).filter(Boolean);
        delete m.files[0].downloadUrl; delete m.files[0].downloadUrls;
        if (list.length > 1) m.files[0].downloadUrls = list;
        else if (list.length === 1) m.files[0].downloadUrl = list[0];
      } else m[k] = inp.value;
    }));
    el.querySelector('.remove').addEventListener('click', () => {
      MANIFEST.modules.splice(i, 1); renderModules();
    });
    el.querySelector('.promote').addEventListener('click', async () => {
      try {
        await api('POST', '/api/promote', {
          paths: [m.files[0].path],
          direction: BRANCH === 'beta' ? 'toPublic' : 'toBeta',
        });
        toast(`Copied ${m.files[0].path}`, 'ok');
      } catch (e) { toast(e.message, 'err'); }
    });

    el.addEventListener('dragstart', () => { el.classList.add('dragging'); dragIndex = i; });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
    el.addEventListener('dragover', (e) => e.preventDefault());
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      if (dragIndex === null || dragIndex === i) return;
      const [moved] = MANIFEST.modules.splice(dragIndex, 1);
      MANIFEST.modules.splice(i, 0, moved);
      dragIndex = null;
      renderModules();
    });
  });
}
let dragIndex = null;

$('#mfReload').addEventListener('click', loadManifest);
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
    toast(`Wrote ${r.written} (${r.modules} modules).`, 'ok');
    loadManifest();
  } catch (e) { toast(e.message, 'err'); }
});

/* ── VERIFY ──────────────────────────────────────────────────── */
let VBRANCH = 'public';
$$('#vfBranch .seg-btn').forEach((b) => b.addEventListener('click', () => {
  $$('#vfBranch .seg-btn').forEach((x) => x.classList.toggle('active', x === b));
  VBRANCH = b.dataset.branch;
}));

function renderFindings(findings, host) {
  host.innerHTML = findings.map((f) => `<div class="finding ${f.level}">
    <div class="code">${esc(f.code)}</div>
    <div class="msg">${esc(f.message)}${f.detail ? `<div class="detail">${esc(f.detail)}</div>` : ''}</div>
  </div>`).join('') || '<div class="empty">No findings.</div>';
}

$('#vfRun').addEventListener('click', async () => {
  $('#vfRun').disabled = true;
  $('#vfSummary').innerHTML = '<div class="banner warn">Running checks…</div>';
  $('#vfFindings').innerHTML = '';
  try {
    const r = await api('POST', '/api/verify', { branch: VBRANCH });
    $('#vfSummary').innerHTML =
      `<div class="banner ${r.canDeploy ? 'ok' : 'err'}">${r.canDeploy
        ? 'All checks passed — safe to deploy.'
        : `${r.errors} error(s) must be fixed before deploying.`}</div>
       <div class="summary">
         <div class="stat err"><b>${r.errors}</b>errors</div>
         <div class="stat warn"><b>${r.warnings}</b>warnings</div>
         <div class="stat ok"><b>${r.findings.length - r.errors - r.warnings}</b>passed</div>
       </div>`;
    renderFindings(r.findings, $('#vfFindings'));
  } catch (e) { $('#vfSummary').innerHTML = `<div class="banner err">${esc(e.message)}</div>`; }
  finally { $('#vfRun').disabled = false; }
});

$('#vfOrphans').addEventListener('click', async () => {
  const box = $('#vfOrphanBox');
  box.innerHTML = '<div class="banner warn">Listing remote objects…</div>';
  try {
    const r = await api('GET', `/api/remote-orphans?branch=${VBRANCH}`);
    if (!r.ok) return void (box.innerHTML = `<div class="banner err">${esc(r.error)}</div>`);
    if (!r.orphans.length) return void (box.innerHTML = `<div class="banner ok">No orphans — all ${r.total} remote object(s) are referenced by the manifest.</div>`);
    box.innerHTML = `<div class="banner warn">${r.orphans.length} of ${r.total} remote object(s) are not referenced by the manifest.</div>
      <div class="table-wrap"><table><thead><tr><th></th><th>Remote path</th><th class="num">Size</th></tr></thead><tbody>
      ${r.orphans.map((o) => `<tr><td><input type="checkbox" class="orph" value="${esc(o.path)}"></td><td class="mono">${esc(o.path)}</td><td class="num">${fmtBytes(o.size)}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="actions left"><button class="btn danger" id="orphDel">Delete selected from R2</button></div>`;
    $('#orphDel').addEventListener('click', async () => {
      const paths = $$('.orph:checked').map((c) => c.value);
      if (!paths.length) return toast('Nothing selected.', 'err');
      if (!confirm(`Permanently delete ${paths.length} object(s) from R2?\n\n${paths.join('\n')}`)) return;
      await api('POST', '/api/remote-delete', { prefix: VBRANCH === 'beta' ? 'betapayload' : 'payload', paths });
      toast(`Deleted ${paths.length} object(s).`, 'ok');
      $('#vfOrphans').click();
    });
  } catch (e) { box.innerHTML = `<div class="banner err">${esc(e.message)}</div>`; }
});

/* ── DEPLOY ──────────────────────────────────────────────────── */
const STEP_FOR_FOLDER = { payload: 'payload', betapayload: 'payload', assets: 'payload', launcher: 'payload', installer: 'payload', manifests: 'manifests' };
function setStep(name, cls) {
  const li = $(`#dpSteps li[data-step="${name}"]`);
  if (li) li.className = cls;
}
function resetSteps() { $$('#dpSteps li').forEach((li) => (li.className = '')); }

listeners.add((msg) => {
  if (msg.job !== 'deploy' && msg.job !== 'verify') return;
  if (msg.type === 'log') {
    const log = $('#dpLog');
    log.textContent += msg.message + '\n';
    log.scrollTop = log.scrollHeight;
    if (/^Uploading manifests/.test(msg.message)) { setStep('postflight', 'done'); setStep('manifests', 'active'); }
    else if (/^Verifying uploaded/.test(msg.message)) { setStep('payload', 'done'); setStep('postflight', 'active'); }
    else if (/^Uploading /.test(msg.message)) { setStep('stage', 'done'); setStep('payload', 'active'); }
    else if (/^Staged |unchanged, not re-copied|launcher-version\.json/.test(msg.message)) { setStep('preflight', 'done'); setStep('stage', 'active'); }
    else if (/^Confirming published/.test(msg.message)) { setStep('manifests', 'done'); setStep('confirm', 'active'); }
  }
  if (msg.type === 'progress' && msg.folder) {
    $('#dpProgressWrap').hidden = false;
    const pct = msg.totalBytes ? (msg.bytes / msg.totalBytes) * 100 : 0;
    $('#dpBar').style.width = `${pct.toFixed(1)}%`;
    $('#dpFolder').textContent = `${msg.folder} — ${fmtBytes(msg.bytes)} / ${fmtBytes(msg.totalBytes)} (${msg.transfers}/${msg.totalTransfers} files)`;
    $('#dpRate').textContent = `${fmtBytes(msg.speed)}/s${msg.eta ? ` · ETA ${msg.eta}s` : ''}`;
    $('#dpFiles').innerHTML = (msg.transferring ?? []).map((t) => `<div>${esc(t.name)} — ${t.percentage}% (${fmtBytes(t.speed)}/s)</div>`).join('');
  }
});

$('#dpRun').addEventListener('click', async () => {
  const dryRun = $('#dpDry').checked;
  if (!dryRun && !confirm('This will upload to the live R2 bucket. Continue?')) return;
  $('#dpRun').disabled = true;
  $('#dpLog').textContent = '';
  $('#dpResult').innerHTML = '';
  resetSteps(); setStep('preflight', 'active');
  try {
    const r = await api('POST', '/api/deploy', { dryRun, force: $('#dpForce').checked, branch: VBRANCH });
    if (r.aborted) {
      setStep(r.stage, 'failed');
      const findings = r.stage === 'preflight' ? r.preflight.findings : r.postflight;
      $('#dpResult').innerHTML = `<div class="banner err">Aborted at ${r.stage}. Nothing was published.</div><div class="findings"></div>`;
      renderFindings(findings.filter((f) => f.level === 'error'), $('#dpResult .findings'));
    } else {
      $$('#dpSteps li').forEach((li) => (li.className = 'done'));
      $('#dpResult').innerHTML = `<div class="banner ok">${r.dryRun ? 'Dry run complete — nothing was uploaded.' : 'Deploy complete and verified.'}</div>`;
    }
  } catch (e) {
    $('#dpResult').innerHTML = `<div class="banner err">${esc(e.message)}</div>`;
  } finally { $('#dpRun').disabled = false; }
});

/* ── NEWS ────────────────────────────────────────────────────── */
let NEWS = null;
async function loadNews() {
  const r = await api('GET', '/api/news');
  NEWS = r.news ?? { schemaVersion: 1, strings: {}, cards: [], announcement: { enabled: false, message: '', type: 'info' } };
  NEWS.announcement ??= { enabled: false, message: '', type: 'info' };
  NEWS.cards ??= [];
  $('#nwAnnEnabled').checked = !!NEWS.announcement.enabled;
  $('#nwAnnType').value = NEWS.announcement.type ?? 'info';
  $('#nwAnnMsg').value = NEWS.announcement.message ?? '';
  renderCards();
}
function renderCards() {
  $('#nwCards').innerHTML = NEWS.cards.map((c, i) => `<div class="module" data-i="${i}">
    <div class="module-head">
      <span class="name">${esc(c.title ?? c.id ?? 'untitled')}</span>
      <span class="module-path">${esc(c.date ?? '')}</span>
      <button class="btn sm toggle">Edit</button>
    </div>
    <div class="module-body">
      <div class="field-row">
        <label>ID<input type="text" data-k="id" value="${esc(c.id ?? '')}"></label>
        <label>Title<input type="text" data-k="title" value="${esc(c.title ?? '')}"></label>
        <label>Date<input type="text" data-k="date" value="${esc(c.date ?? '')}"></label>
        <label>Type<select data-k="type">
          <option value="update"${c.type === 'update' ? ' selected' : ''}>update</option>
          <option value="patchnotes"${c.type === 'patchnotes' ? ' selected' : ''}>patchnotes</option>
        </select></label>
      </div>
      <label>Excerpt<textarea rows="3" data-k="excerpt">${esc(c.excerpt ?? '')}</textarea></label>
      <div class="field-row">
        <label>Link URL<input type="text" data-k="linkUrl" value="${esc(c.linkUrl ?? '')}"></label>
        <label>Image URL<input type="text" data-k="imageUrl" value="${esc(c.imageUrl ?? '')}"></label>
      </div>
      <label>Highlights <span class="hint-inline">one per line</span><textarea rows="3" data-k="highlights">${esc((c.highlights ?? []).join('\n'))}</textarea></label>
      <div class="actions left"><button class="btn sm danger remove">Remove card</button></div>
    </div>
  </div>`).join('') || '<div class="empty">No cards.</div>';

  $$('#nwCards .module').forEach((el) => {
    const i = +el.dataset.i, c = NEWS.cards[i];
    el.querySelector('.toggle').addEventListener('click', () => el.classList.toggle('open'));
    $$('[data-k]', el).forEach((inp) => inp.addEventListener('change', () => {
      const k = inp.dataset.k;
      if (k === 'highlights') {
        const list = inp.value.split('\n').map((s) => s.trim()).filter(Boolean);
        if (list.length) c.highlights = list; else delete c.highlights;
      } else if (!inp.value.trim() && ['imageUrl', 'linkUrl'].includes(k)) delete c[k];
      else c[k] = inp.value;
    }));
    el.querySelector('.remove').addEventListener('click', () => { NEWS.cards.splice(i, 1); renderCards(); });
  });
}
$('#nwReload').addEventListener('click', loadNews);
$('#nwAddCard').addEventListener('click', () => {
  NEWS.cards.unshift({ id: `news-${Date.now()}`, title: 'New card', date: '', type: 'update', excerpt: '' });
  renderCards();
});
$('#nwSave').addEventListener('click', async () => {
  try {
    NEWS.announcement = {
      enabled: $('#nwAnnEnabled').checked,
      message: $('#nwAnnMsg').value,
      type: $('#nwAnnType').value,
    };
    const r = await api('POST', '/api/news', { news: NEWS });
    toast(`Wrote ${r.written}.`, 'ok');
  } catch (e) { toast(e.message, 'err'); }
});

/* ── boot ────────────────────────────────────────────────────── */
connectEvents();
loadState().then(loadSources).catch((e) => toast(e.message, 'err'));
