'use strict';
// Preflight / postflight / drift checks.
//
// Nothing in the old pipeline ever compared the manifest against the files it
// describes, which is how production ended up advertising sizes that are wrong
// by 39 MB (plan B2). Every check here returns a structured finding rather than
// throwing, so the UI can show the full picture at once.

const fs = require('node:fs');
const path = require('node:path');
const {
  REPO_ROOT, PAYLOAD_DIR, BETA_DIR, MANIFEST_DIR, R2_BASE,
  PUBLIC_MANIFEST, BETA_MANIFEST, readConfig, stripJunk,
} = require('./config');
const { hashOf } = require('./hashcache');
const { readManifest, compareVersions, indexByPath } = require('./manifest');
const { walkArchives } = require('./scan');

const ERROR = 'error', WARN = 'warn', OK = 'ok';
const finding = (level, code, message, detail) => ({ level, code, message, detail: detail ?? null });

// Files above this get a mirror-URL recommendation. r2.dev is throttled/blocked
// in China and the launcher's mirror path is currently switched off (plan A6).
const LARGE_FILE_BYTES = 100 * 1024 * 1024;

const payloadRootFor = (branch) => (branch === 'beta' ? BETA_DIR : PAYLOAD_DIR);
const urlPrefixFor   = (branch) => (branch === 'beta' ? 'betapayload' : 'payload');

/* ── JSON hygiene ────────────────────────────────────────────────────────── */

function checkJsonHygiene(file) {
  const out = [];
  const label = path.basename(file);
  if (!fs.existsSync(file)) {
    out.push(finding(ERROR, 'manifest-missing', `${label} does not exist`));
    return { findings: out, parsed: null };
  }
  const raw = fs.readFileSync(file, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) {
    out.push(finding(ERROR, 'bom', `${label} starts with a UTF-8 BOM — the launcher's JSON.parse will fail`));
  }
  const junk = raw.match(/[​‌‍￾�]/g);
  if (junk) {
    out.push(finding(ERROR, 'zero-width', `${label} contains ${junk.length} zero-width/replacement character(s)`));
  }
  let parsed = null;
  try {
    parsed = JSON.parse(stripJunk(raw));
  } catch (err) {
    out.push(finding(ERROR, 'json-parse', `${label} is not valid JSON: ${err.message}`));
    return { findings: out, parsed: null };
  }
  if (parsed.schemaVersion !== 1) {
    out.push(finding(WARN, 'schema-version', `${label} has schemaVersion ${parsed.schemaVersion ?? '(absent)'}, expected 1`));
  }
  return { findings: out, parsed };
}

/* ── structural checks ───────────────────────────────────────────────────── */

function checkStructure(manifest, branch) {
  const out = [];
  const modules = Array.isArray(manifest?.modules) ? manifest.modules : [];
  const ids = new Map(), paths = new Map();

  for (const m of modules) {
    if (!m.id) out.push(finding(ERROR, 'module-no-id', `A module has no id (name: ${m.name ?? '?'})`));
    else if (ids.has(m.id)) out.push(finding(ERROR, 'module-dup-id', `Duplicate module id "${m.id}"`));
    else ids.set(m.id, m);

    if (m.type && !['core', 'campaign'].includes(m.type)) {
      out.push(finding(WARN, 'module-type', `Module "${m.id}" has unexpected type "${m.type}"`));
    }
    if (!Array.isArray(m.files) || m.files.length === 0) {
      out.push(finding(ERROR, 'module-no-files', `Module "${m.id}" has no files`));
      continue;
    }
    for (const f of m.files) {
      if (!f.path) { out.push(finding(ERROR, 'file-no-path', `Module "${m.id}" has a file with no path`)); continue; }
      if (paths.has(f.path)) out.push(finding(ERROR, 'file-dup-path', `Duplicate path "${f.path}" (modules "${paths.get(f.path)}" and "${m.id}")`));
      else paths.set(f.path, m.id);

      if (f.path.includes('\\')) out.push(finding(ERROR, 'path-backslash', `"${f.path}" uses backslashes — must be forward slashes`));
      if (f.path.startsWith('/'))  out.push(finding(ERROR, 'path-leading-slash', `"${f.path}" has a leading slash`));
      if (!/^(Maps|Mods)\//.test(f.path)) {
        out.push(finding(ERROR, 'path-root', `"${f.path}" must start with "Maps/" or "Mods/" (exact casing)`));
      }
      if (typeof f.size !== 'number' || f.size <= 0) out.push(finding(ERROR, 'file-size', `"${f.path}" has invalid size ${f.size}`));
      if (!/^[0-9a-f]{64}$/.test(String(f.hash || ''))) {
        out.push(finding(ERROR, 'file-hash', `"${f.path}" hash is not a lowercase 64-char SHA-256`));
      }
      if (f.downloadUrl && Array.isArray(f.downloadUrls) && f.downloadUrls.length) {
        out.push(finding(WARN, 'url-both', `"${f.path}" sets both downloadUrl and downloadUrls — the launcher will use downloadUrls`));
      }
      for (const u of [f.downloadUrl, ...(f.downloadUrls || [])].filter(Boolean)) {
        if (/github\.com\/.*\/releases\/download\//.test(u)) {
          out.push(finding(ERROR, 'url-dead-github', `"${f.path}" points at a GitHub Release URL that no longer hosts these files: ${u}`));
        } else if (!/^https:\/\//.test(u)) {
          out.push(finding(ERROR, 'url-scheme', `"${f.path}" has a non-https download URL: ${u}`));
        }
      }
    }
  }

  // Critical update completeness (plan B3).
  const cu = manifest?.criticalUpdate;
  if (cu?.enabled) {
    if (!String(cu.minVersion || '').trim()) out.push(finding(ERROR, 'critical-no-min', 'criticalUpdate.enabled is true but minVersion is empty'));
    if (!String(cu.message || '').trim())    out.push(finding(ERROR, 'critical-no-msg', 'criticalUpdate.enabled is true but message is empty'));
  }

  if (branch === 'beta') {
    if (manifest?.betaEnabled) {
      if (!Array.isArray(manifest.modules) || !manifest.modules.length) {
        out.push(finding(ERROR, 'beta-no-modules', 'betaEnabled is true but the manifest has no modules'));
      }
      if (!/^[0-9a-f]{64}$/.test(String(manifest.codeHash || ''))) {
        out.push(finding(ERROR, 'beta-no-code', 'betaEnabled is true but codeHash is missing or malformed'));
      }
    } else if (manifest?.modules || manifest?.criticalUpdate) {
      // Harmless, but production serves the stripped shape — keep them identical.
      out.push(finding(WARN, 'beta-shape', 'betaEnabled is false but modules/criticalUpdate are still present'));
    }
  }
  return out;
}

/* ── manifest vs disk ────────────────────────────────────────────────────── */

async function checkAgainstDisk(manifest, branch, onProgress) {
  const out = [];
  const root = payloadRootFor(branch);
  const modules = Array.isArray(manifest?.modules) ? manifest.modules : [];
  const claimed = new Set();
  let checked = 0;
  const total = modules.reduce((n, m) => n + (m.files?.length ?? 0), 0);

  for (const m of modules) {
    for (const f of (m.files ?? [])) {
      if (!f.path) continue;
      const abs = path.join(root, f.path.replace(/\//g, path.sep));
      claimed.add(abs.toLowerCase());
      onProgress && onProgress({ phase: 'verify', file: f.name ?? f.path, checked, total });
      checked++;

      if (!fs.existsSync(abs)) {
        out.push(finding(ERROR, 'file-absent', `${f.path} is in the manifest but not in ${path.basename(root)}/`, abs));
        continue;
      }
      const st = fs.statSync(abs);
      if (st.size !== f.size) {
        out.push(finding(ERROR, 'size-mismatch',
          `${f.path}: manifest says ${f.size.toLocaleString()} bytes, file is ${st.size.toLocaleString()}`,
          `difference ${(st.size - f.size).toLocaleString()} bytes`));
        continue; // hash will obviously differ too
      }
      const { hash } = await hashOf(abs);
      if (hash !== f.hash) {
        out.push(finding(ERROR, 'hash-mismatch', `${f.path}: hash does not match the file on disk`,
          `manifest ${f.hash}\ndisk     ${hash}`));
      }
      if (st.size >= LARGE_FILE_BYTES && !f.downloadUrl && !(f.downloadUrls?.length)) {
        out.push(finding(WARN, 'large-no-mirror',
          `${f.path} is ${(st.size / 1048576).toFixed(0)} MB with no mirror URL — CN users have no fallback if r2.dev is blocked`));
      }
    }
  }

  // Orphans: built archives nobody references.
  for (const f of walkArchives(root)) {
    if (!claimed.has(f.abs.toLowerCase())) {
      out.push(finding(WARN, 'orphan', `${path.relative(REPO_ROOT, f.abs)} is not referenced by the manifest — it will still be uploaded`));
    }
  }
  onProgress && onProgress({ phase: 'done', checked, total });
  return out;
}

/* ── news feed / localisation ────────────────────────────────────────────── */

// The launcher's t() helper falls back with `||`, so an empty string degrades to
// English rather than rendering blank. That makes untranslated stubs invisible
// in testing — this surfaces them instead.
// `en` is deliberately sparse: App.jsx's DEFAULT_STRINGS is its source of truth,
// so the feed only needs to carry overrides for it.
function checkNewsStrings(news) {
  const out = [];
  const strings = news?.strings;
  if (!strings || typeof strings !== 'object') {
    out.push(finding(WARN, 'news-no-strings', 'news-feed.json has no strings block — every locale falls back to built-in English'));
    return out;
  }
  const locales = Object.keys(strings).filter((l) => l !== 'en');
  const reference = locales
    .map((l) => Object.keys(strings[l] ?? {}))
    .reduce((a, b) => (b.length > a.length ? b : a), []);

  // Keys blank in EVERY locale are reported once, not per-locale. This is the
  // usual shape of "someone added strings and never translated them" — the most
  // important case to surface, so it must not be mistaken for an intentional
  // default and filtered out.
  const allKeys = [...new Set(locales.flatMap((l) => Object.keys(strings[l] ?? {})))];
  const blankEverywhere = allKeys.filter((k) =>
    locales.every((l) => strings[l]?.[k] === ''));
  if (blankEverywhere.length) {
    out.push(finding(WARN, 'locale-untranslated',
      `${blankEverywhere.length} key(s) are empty in every locale — untranslated, or intentionally defaulted in App.jsx`,
      blankEverywhere.join(', ')));
  }

  for (const loc of locales) {
    const table = strings[loc] ?? {};
    const empty = Object.keys(table).filter((k) => table[k] === '' && !blankEverywhere.includes(k));
    const missing = reference.filter((k) => !(k in table));
    if (empty.length) {
      out.push(finding(WARN, 'locale-empty',
        `Locale "${loc}" has ${empty.length} empty string(s) that other locales translate — silently falls back to English`,
        empty.join(', ')));
    }
    if (missing.length) {
      out.push(finding(WARN, 'locale-missing',
        `Locale "${loc}" is missing ${missing.length} key(s) present in other locales`,
        missing.join(', ')));
    }
  }
  return out;
}

/* ── live CDN + cross-repo drift ─────────────────────────────────────────── */

async function fetchJson(url, timeoutMs = 15000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, cache: 'no-store' });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, data: JSON.parse(stripJunk(await res.text())) };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : err.message };
  } finally {
    clearTimeout(timer);
  }
}

// Compares the local manifest against what R2 actually serves and against the
// launcher repo's copy. Three divergent copies exist today with no source of
// truth, and publishing the local one would roll production back (plan B2).
async function checkDrift(branch) {
  const out = [];
  const localFile = branch === 'beta' ? BETA_MANIFEST : PUBLIC_MANIFEST;
  const name = path.basename(localFile);
  const local = readManifest(localFile);

  const live = await fetchJson(`${R2_BASE}/manifests/${name}`);
  if (!live.ok) {
    out.push(finding(WARN, 'live-unreachable', `Could not read live ${name} from R2: ${live.error}`));
  } else if (local) {
    if (branch === 'public') {
      for (const key of ['multiplayer', 'campaign']) {
        const l = local.versions?.[key], r = live.data.versions?.[key];
        const cmp = compareVersions(l, r);
        if (cmp < 0) {
          out.push(finding(ERROR, 'version-rollback',
            `versions.${key}: local "${l}" is OLDER than live "${r}" — publishing would roll production back`));
        } else if (cmp > 0) {
          out.push(finding(OK, 'version-ahead', `versions.${key}: local "${l}" is ahead of live "${r}"`));
        }
      }
    }
    const liveCu = live.data.criticalUpdate ?? {};
    const localCu = local.criticalUpdate ?? {};
    if (liveCu.enabled && !localCu.enabled) {
      out.push(finding(ERROR, 'critical-would-disable',
        `Live has criticalUpdate enabled ("${liveCu.message}") but the local manifest has it disabled — publishing would silently turn it off`));
    }
    const liveCount = live.data.modules?.length ?? 0;
    const localCount = local.modules?.length ?? 0;
    if (liveCount !== localCount) {
      out.push(finding(WARN, 'module-count-drift', `Live has ${liveCount} modules, local has ${localCount}`));
    }
  }

  // The launcher repo keeps its own manifests/ — stale fixtures that must never
  // be confused with the deploy source.
  const cfg = readConfig();
  if (cfg.launcherRepoPath) {
    const other = path.join(cfg.launcherRepoPath, 'manifests', name);
    if (fs.existsSync(other)) {
      const om = readManifest(other);
      if (branch === 'public' && om?.versions && local?.versions) {
        if (om.versions.multiplayer !== local.versions.multiplayer || om.versions.campaign !== local.versions.campaign) {
          out.push(finding(WARN, 'launcher-repo-drift',
            `Launcher repo's ${name} is at ${om.versions.multiplayer}/${om.versions.campaign}, this repo is at ${local.versions.multiplayer}/${local.versions.campaign}`,
            `${other}\nThese are dev fixtures — only this repo's manifests/ should be deployed.`));
        }
      }
    }
  }
  return out;
}

/* ── postflight (after upload, before manifests go live) ─────────────────── */

async function headFile(url, timeoutMs = 20000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'HEAD', signal: ac.signal, cache: 'no-store' });
    return { ok: res.ok, status: res.status, length: Number(res.headers.get('content-length')) || 0 };
  } catch (err) {
    return { ok: false, status: 0, length: 0, error: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

// Confirms every file the manifest describes is actually on the CDN at the right
// size BEFORE the manifest itself is published (plan B1).
async function postflight(manifest, branch, onProgress) {
  const out = [];
  const prefix = urlPrefixFor(branch);
  const files = (manifest?.modules ?? []).flatMap((m) => m.files ?? []);
  let done = 0;

  for (const f of files) {
    // encodeURI leaves "/" alone and turns the spaces in "SC Evolution Complete"
    // into %20, matching what the launcher's URL parsing produces.
    const url = `${R2_BASE}/${prefix}/${encodeURI(f.path)}`;
    onProgress && onProgress({ phase: 'head', file: f.name ?? f.path, done, total: files.length });
    done++;
    const r = await headFile(url);
    if (!r.ok) {
      out.push(finding(ERROR, 'cdn-missing', `${f.path} is not reachable on the CDN (${r.error ?? 'HTTP ' + r.status})`, url));
    } else if (r.length !== f.size) {
      out.push(finding(ERROR, 'cdn-size', `${f.path}: CDN serves ${r.length.toLocaleString()} bytes, manifest says ${f.size.toLocaleString()}`, url));
    }
  }
  onProgress && onProgress({ phase: 'done', done, total: files.length });
  if (!out.length) out.push(finding(OK, 'cdn-ok', `All ${files.length} file(s) verified on the CDN at the correct size`));
  return out;
}

// Confirms the published manifests parse and match what we just wrote.
async function verifyPublishedManifests() {
  const out = [];
  for (const file of [PUBLIC_MANIFEST, BETA_MANIFEST]) {
    if (!fs.existsSync(file)) continue;
    const name = path.basename(file);
    const live = await fetchJson(`${R2_BASE}/manifests/${name}`);
    if (!live.ok) { out.push(finding(ERROR, 'published-unreachable', `${name}: ${live.error}`)); continue; }
    const local = readManifest(file);
    if (JSON.stringify(live.data) !== JSON.stringify(local)) {
      out.push(finding(ERROR, 'published-mismatch', `${name} on the CDN does not match the local file (R2 may still be propagating)`));
    } else {
      out.push(finding(OK, 'published-ok', `${name} published and verified`));
    }
  }
  return out;
}

/* ── entry point ─────────────────────────────────────────────────────────── */

async function preflight(branch, onProgress) {
  const file = branch === 'beta' ? BETA_MANIFEST : PUBLIC_MANIFEST;
  const findings = [];

  const hygiene = checkJsonHygiene(file);
  findings.push(...hygiene.findings);
  if (!hygiene.parsed) return summarize(findings);

  findings.push(...checkStructure(hygiene.parsed, branch));
  // A disabled beta legitimately has nothing to check against disk.
  if (branch !== 'beta' || hygiene.parsed.betaEnabled) {
    findings.push(...await checkAgainstDisk(hygiene.parsed, branch, onProgress));
  }
  findings.push(...await checkDrift(branch));

  // news-feed.json is served to every client on launch; a parse failure there
  // breaks the whole news pane.
  const news = checkJsonHygiene(path.join(MANIFEST_DIR, 'news-feed.json'));
  findings.push(...news.findings.filter((f) => f.code !== 'schema-version'));
  if (news.parsed) findings.push(...checkNewsStrings(news.parsed));

  return summarize(findings);
}

function summarize(findings) {
  const errors = findings.filter((f) => f.level === ERROR);
  const warnings = findings.filter((f) => f.level === WARN);
  return {
    findings,
    errors: errors.length,
    warnings: warnings.length,
    canDeploy: errors.length === 0,
  };
}

module.exports = {
  preflight, postflight, verifyPublishedManifests, checkDrift,
  checkJsonHygiene, checkStructure, checkAgainstDisk, checkNewsStrings,
  fetchJson, headFile, summarize,
  LARGE_FILE_BYTES,
};
