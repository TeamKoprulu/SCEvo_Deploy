'use strict';
// rclone driver with parsed progress + launcher artifact staging.
//
// Fixes vs deploy-to-r2.ps1:
//   B1 - upload order is payload-first, manifests last. Enforced by the caller
//        (app.js) but the folder lists in config.js encode it.
//   B7 - launcher-version.json is JSON.stringify'd rather than concatenated, and
//        deploy-config.json is never rewritten from a template.
//   Progress comes from --use-json-log instead of rclone's raw --progress
//        scrawl, so the UI gets real bytes/rate/ETA per folder.

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const {
  REPO_ROOT, BUCKET, R2_BASE, LAUNCHER_VER,
  readConfig, writeTextAtomic,
} = require('./config');
const { hashFileStream } = require('./hashcache');

const PORTABLE_EXE = 'SC Evo Launcher.exe';
const SETUP_EXE    = 'SC Evo Launcher Setup.exe';

function rcloneAvailable() {
  return new Promise((resolve) => {
    execFile('rclone', ['version'], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: err.code === 'ENOENT'
        ? 'rclone is not installed or not on PATH. Install with: winget install Rclone.Rclone'
        : err.message });
      resolve({ ok: true, version: String(stdout).split('\n')[0].trim() });
    });
  });
}

// Confirms the "cf" remote actually exists before a deploy starts failing halfway.
// NOTE: this only reads the local rclone.conf — it proves nothing about whether
// the credentials in it still work. Use rcloneProbe() for that.
function rcloneRemotes() {
  return new Promise((resolve) => {
    execFile('rclone', ['listremotes'], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(String(stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
    });
  });
}

// Actually talks to Cloudflare. `rclone version` and `listremotes` both pass with
// a revoked or wrong-permission key — the failure would otherwise only appear
// partway into a 1.1 GB upload. This is a cheap top-level listing that turns an
// expired R2 API token into an up-front, named error.
//
// Fails soft: a probe failure never prevents the app from starting.
function rcloneProbe(timeoutMs = 15000) {
  return new Promise((resolve) => {
    execFile(
      'rclone',
      ['lsjson', BUCKET, '--max-depth', '1', '--no-modtime', '--no-mimetype'],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 << 20 },
      (err, stdout, stderr) => {
        if (!err) {
          let prefixes = [];
          try { prefixes = JSON.parse(stdout).map((o) => o.Path); } catch {}
          return resolve({ ok: true, status: 'reachable', bucket: BUCKET, prefixes });
        }

        const text = `${stderr || ''}${err.message || ''}`;
        const has = (...needles) => needles.some((n) => text.toLowerCase().includes(n.toLowerCase()));

        // Order matters: auth first, since a bad key often also reports 403.
        let status = 'failed';
        let message = text.trim().split('\n').slice(-3).join(' ').trim() || err.message;

        if (err.code === 'ENOENT') {
          status = 'no-rclone';
          message = 'rclone is not installed or not on PATH.';
        } else if (err.killed || err.signal === 'SIGTERM') {
          status = 'timeout';
          message = `No response from Cloudflare within ${timeoutMs / 1000}s.`;
        } else if (has('InvalidAccessKeyId', 'SignatureDoesNotMatch', 'AccessDenied', 'Unauthorized', '401', '403')) {
          status = 'auth';
          message = 'Cloudflare rejected the credentials. The R2 API token is likely expired or ' +
                    'revoked, or lacks read/write on this bucket. Mint a new token in the ' +
                    'Cloudflare dashboard (R2 → Manage API Tokens) and update the remote with `rclone config`.';
        } else if (has('NoSuchBucket', "didn't find section", 'not found')) {
          status = 'no-bucket';
          message = `Remote or bucket not found for "${BUCKET}". Check the remote is named "cf" ` +
                    `and the bucket exists.`;
        } else if (has('no such host', 'dial tcp', 'network', 'connection refused', 'timeout', 'EOF')) {
          status = 'network';
          message = 'Could not reach Cloudflare. Check your internet connection.';
        }
        resolve({ ok: false, status, bucket: BUCKET, error: message });
      },
    );
  });
}

/* ── upload ──────────────────────────────────────────────────────────────── */

// Runs `rclone copy` for one folder, streaming parsed stats to onProgress.
// `copy` not `sync` — a blind sync on a 1.1 GB bucket is one typo away from
// deleting production. Orphan cleanup is an explicit, reviewed action instead.
// include: only these file names (rclone --include). exclude: patterns to skip.
function uploadFolder(localName, { dryRun = false, onProgress, onLog, include = null, exclude = [] } = {}) {
  const localPath = path.join(REPO_ROOT, localName);
  return new Promise((resolve) => {
    if (!fs.existsSync(localPath)) {
      return resolve({ folder: localName, ok: true, skipped: true, reason: 'folder does not exist' });
    }
    const args = [
      'copy', localPath, `${BUCKET}/${localName}`,
      '--checksum',
      '--use-json-log',
      '--stats', '1s',
      '--stats-log-level', 'NOTICE',
      '-v',
    ];
    if (dryRun) args.push('--dry-run');
    // Ordered rules: excludes first, then the allow-list, then drop everything else.
    for (const pattern of exclude) args.push('--filter', `- ${pattern}`);
    if (include) {
      for (const name of include) args.push('--filter', `+ ${name}`);
      args.push('--filter', '- **');
    }

    const child = spawn('rclone', args, { windowsHide: true });
    let stderrTail = '';
    let last = null;

    const handleLine = (line) => {
      if (!line.trim()) return;
      let obj = null;
      try { obj = JSON.parse(line); } catch { onLog && onLog(line); return; }
      if (obj.stats) {
        last = obj.stats;
        onProgress && onProgress({
          folder: localName,
          bytes: obj.stats.bytes ?? 0,
          totalBytes: obj.stats.totalBytes ?? 0,
          speed: obj.stats.speed ?? 0,
          eta: obj.stats.eta ?? null,
          transfers: obj.stats.transfers ?? 0,
          totalTransfers: obj.stats.totalTransfers ?? 0,
          errors: obj.stats.errors ?? 0,
          transferring: (obj.stats.transferring ?? []).map((t) => ({
            name: t.name, percentage: t.percentage ?? 0, size: t.size ?? 0, speed: t.speed ?? 0,
          })),
        });
      } else if (obj.msg) {
        onLog && onLog(`${obj.level ?? 'info'}: ${obj.msg}${obj.object ? ` (${obj.object})` : ''}`);
      }
    };

    let buf = '';
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      stderrTail = (stderrTail + text).slice(-8000);
      buf += text;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      lines.forEach(handleLine);
    });
    child.stdout.on('data', (c) => onLog && onLog(String(c).trim()));

    child.on('error', (err) => resolve({
      folder: localName, ok: false,
      error: err.code === 'ENOENT' ? 'rclone not found on PATH' : err.message,
    }));
    child.on('close', (code) => {
      if (buf) handleLine(buf);
      resolve({
        folder: localName,
        ok: code === 0,
        dryRun,
        bytes: last?.bytes ?? 0,
        transfers: last?.transfers ?? 0,
        error: code === 0 ? null : `rclone exited ${code}\n${stderrTail.slice(-2000)}`,
      });
    });
  });
}

// Lists remote objects under a prefix, for orphan review.
function listRemote(prefix) {
  return new Promise((resolve) => {
    execFile('rclone', ['lsjson', `${BUCKET}/${prefix}`, '--recursive', '--files-only'],
      { windowsHide: true, maxBuffer: 32 << 20 }, (err, stdout) => {
        if (err) return resolve({ ok: false, error: err.message, items: [] });
        try {
          const items = JSON.parse(stdout).map((o) => ({ path: o.Path, size: o.Size }));
          resolve({ ok: true, items });
        } catch (e) {
          resolve({ ok: false, error: e.message, items: [] });
        }
      });
  });
}

function deleteRemote(prefix, relPath) {
  return new Promise((resolve) => {
    execFile('rclone', ['deletefile', `${BUCKET}/${prefix}/${relPath}`], { windowsHide: true },
      (err) => resolve({ ok: !err, error: err ? err.message : null, path: relPath }));
  });
}

/* ── launcher artifacts ──────────────────────────────────────────────────── */

// Copies the built exes out of the launcher repo, skipping the copy when the
// hash is unchanged (ported from deploy-to-r2.ps1:54-66).
async function stageLauncherArtifacts() {
  const cfg = readConfig();
  const repo = cfg.launcherRepoPath;
  const out = { staged: [], skipped: [], warnings: [] };
  if (!repo || !fs.existsSync(path.join(repo, 'package.json'))) {
    out.warnings.push(`Launcher repo not configured or invalid: ${repo || '(unset)'}`);
    return out;
  }
  const pairs = [
    { src: path.join(repo, 'dist-electron', PORTABLE_EXE), dest: path.join(REPO_ROOT, 'launcher',  PORTABLE_EXE) },
    { src: path.join(repo, 'dist-electron', SETUP_EXE),    dest: path.join(REPO_ROOT, 'installer', SETUP_EXE)    },
  ];
  for (const { src, dest } of pairs) {
    if (!fs.existsSync(src)) {
      out.warnings.push(`Not built: ${path.basename(src)} — run "npm run build" in the launcher repo`);
      continue;
    }
    const srcHash = await hashFileStream(src);
    const dstHash = fs.existsSync(dest) ? await hashFileStream(dest) : null;
    if (srcHash === dstHash) { out.skipped.push(path.basename(dest)); continue; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    out.staged.push(path.basename(dest));
  }
  // Launchers self-update only when the published version differs from their own,
  // so a new exe under the old version number reaches nobody.
  const published = publishedLauncherVersion();
  let repoVersion = null;
  try { repoVersion = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version; } catch {}
  if (out.staged.length && repoVersion && repoVersion === published) {
    out.warnings.push(`The launcher exe changed but its version is still ${repoVersion}, so players won't be offered it. Bump "version" in the launcher repo's package.json and rebuild.`);
  }
  return out;
}

function publishedLauncherVersion() {
  try { return JSON.parse(fs.readFileSync(LAUNCHER_VER, 'utf8')).version ?? null; } catch { return null; }
}

// Writes launcher-version.json from the launcher repo's package.json version.
// Built with JSON.stringify — the old script concatenated it by hand, and this
// is the one file a broken launcher cannot fix by self-updating.
function writeLauncherVersion() {
  const cfg = readConfig();
  const pkgPath = cfg.launcherRepoPath ? path.join(cfg.launcherRepoPath, 'package.json') : null;
  if (!pkgPath || !fs.existsSync(pkgPath)) {
    return { ok: false, error: `package.json not found (launcherRepoPath: ${cfg.launcherRepoPath || 'unset'})` };
  }
  const version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
  const previous = publishedLauncherVersion();
  const doc = { version };
  if (cfg.showVersionDebug === true) doc.showVersionDebug = true;
  doc.portable  = { url: `${R2_BASE}/launcher/${encodeURI(PORTABLE_EXE)}` };
  doc.installer = { url: `${R2_BASE}/installer/${encodeURI(SETUP_EXE)}` };
  writeTextAtomic(LAUNCHER_VER, JSON.stringify(doc, null, 2) + '\n');
  return { ok: true, version, previous, path: LAUNCHER_VER };
}

module.exports = {
  rcloneAvailable, rcloneRemotes, rcloneProbe, uploadFolder, listRemote, deleteRemote,
  stageLauncherArtifacts, writeLauncherVersion, PORTABLE_EXE, SETUP_EXE,
};
