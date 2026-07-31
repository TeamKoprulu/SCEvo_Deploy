'use strict';
// MPQEditor driver.
//
// Two fixes over build-sc2files.ps1 (plan B8):
//   - Uses an NTFS junction instead of a full recursive copy of the source. The
//     old script's comment claimed a junction "always" was used but the code did
//     Copy-Item -Recurse, so every build copied ~500 MB before packing it.
//   - Verifies the built archive actually contains the files, by reading the MPQ
//     block-table count out of the header. The old script only checked that some
//     output file existed, which is exactly the silent-truncation failure the
//     65536-slot change was meant to prevent.
//
// MPQEditor console scripts REQUIRE relative paths — absolute paths are silently
// ignored and it still exits 0 (build-sc2files.ps1:334-339). Everything below is
// relative to REPO_ROOT, which is also the child process's cwd.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { REPO_ROOT, MPQ_EDITOR, PAYLOAD_DIR, BETA_DIR, writeTextAtomic } = require('./config');
const { countFiles } = require('./scan');

const TEMP_DIR    = path.join(REPO_ROOT, 'build-temp');
const HASH_MIN    = 4;
const MPQ_MAGIC   = 0x1a51504d; // 'MPQ\x1A' little-endian

/* ── MPQ header ──────────────────────────────────────────────────────────── */

// Reads the 32-byte MPQ header. blockTableEntries is the archive's file count
// (including specials like (listfile)/(attributes)), which is all we need to
// prove nothing was dropped.
function readMpqHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(32);
    const read = fs.readSync(fd, buf, 0, 32, 0);
    if (read < 32) throw new Error('file too small to be an MPQ');
    if (buf.readUInt32LE(0) !== MPQ_MAGIC) throw new Error('missing MPQ signature');
    return {
      headerSize:        buf.readUInt32LE(4),
      archiveSize:       buf.readUInt32LE(8),
      formatVersion:     buf.readUInt16LE(12),
      blockSize:         buf.readUInt16LE(14),
      hashTableOffset:   buf.readUInt32LE(16),
      blockTableOffset:  buf.readUInt32LE(20),
      hashTableEntries:  buf.readUInt32LE(24),
      blockTableEntries: buf.readUInt32LE(28),
    };
  } finally {
    fs.closeSync(fd);
  }
}

// Next power of two >= fileCount*2, floor HASH_MIN — keeps the load factor near
// 50% so hash collisions can't drop files (build-sc2files.ps1:358-363).
function hashTableSizeFor(fileCount) {
  let size = HASH_MIN;
  while (size < fileCount * 2) size *= 2;
  return size;
}

/* ── junction handling ───────────────────────────────────────────────────── */

function makeJunction(linkPath, targetDir) {
  removeLink(linkPath);
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(path.resolve(targetDir), linkPath, 'junction');
}

// Removes a junction WITHOUT following it. A recursive delete through a junction
// would wipe the user's real SC2 mod source, so this never uses rm -rf here.
function removeLink(linkPath) {
  let st;
  try { st = fs.lstatSync(linkPath); } catch { return; }
  if (st.isSymbolicLink() || st.isDirectory()) {
    try { fs.unlinkSync(linkPath); return; } catch {}
    try { fs.rmdirSync(linkPath); return; } catch {}
  }
  try { fs.rmSync(linkPath, { force: true }); } catch {}
}

// Clears build-temp, unlinking any junctions first so nothing is followed.
function cleanTemp() {
  if (!fs.existsSync(TEMP_DIR)) return;
  for (const e of fs.readdirSync(TEMP_DIR, { withFileTypes: true })) {
    const full = path.join(TEMP_DIR, e.name);
    if (e.isSymbolicLink() || e.name.startsWith('_src_')) removeLink(full);
    else { try { fs.rmSync(full, { recursive: true, force: true }); } catch {} }
  }
  try { fs.rmSync(TEMP_DIR, { recursive: true, force: true }); } catch {}
}

/* ── build ───────────────────────────────────────────────────────────────── */

function runMpqEditor(scriptRelPath) {
  return new Promise((resolve) => {
    execFile(
      MPQ_EDITOR,
      ['console', scriptRelPath],
      { cwd: REPO_ROOT, windowsHide: true, maxBuffer: 8 << 20 },
      (err, stdout, stderr) => resolve({
        code: err ? (err.code ?? 1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: err ? err.message : null,
      }),
    );
  });
}

// Packages one source directory into an MPQ and copies it to the requested
// payload folders. Returns a per-item result rather than throwing, so one bad
// archive never aborts the rest of the batch.
async function buildOne(src, targets, onProgress) {
  const name = path.basename(src.relPath);
  const emit = (phase, detail) => onProgress && onProgress({ file: name, phase, ...detail });

  const linkRel = path.join('build-temp', `_src_${name}`);
  const outRel  = path.join('build-temp', name);
  const linkAbs = path.join(REPO_ROOT, linkRel);
  const outAbs  = path.join(REPO_ROOT, outRel);
  const scriptRel = 'Build-SC2Files.mpq2k';
  const scriptAbs = path.join(REPO_ROOT, scriptRel);

  try {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    emit('linking');
    makeJunction(linkAbs, src.sourceDir);

    const fileCount = countFiles(linkAbs);
    if (fileCount === 0) throw new Error('source directory is empty');
    const hashSize = hashTableSizeFor(fileCount);
    emit('packing', { fileCount, hashSize });

    // Backslashes throughout — MPQEditor is a Windows tool.
    const script = [
      `new ${outRel} ${hashSize}`,
      `add ${outRel} ${linkRel}\\* /r /c`,
      `flush ${outRel}`,
      '',
    ].join('\r\n');
    writeTextAtomic(scriptAbs, script);

    const run = await runMpqEditor(scriptRel);

    if (!fs.existsSync(outAbs)) {
      return fail(`MPQEditor produced no output (exit ${run.code}). Script kept at ${scriptRel}`, run);
    }

    // Verify nothing was silently dropped.
    emit('verifying');
    let header;
    try {
      header = readMpqHeader(outAbs);
    } catch (err) {
      return fail(`built archive is not a valid MPQ: ${err.message}`, run);
    }
    if (header.blockTableEntries < fileCount) {
      return fail(
        `archive contains ${header.blockTableEntries} entries but the source has ${fileCount} files ` +
        `— MPQEditor dropped ${fileCount - header.blockTableEntries}`,
        run,
      );
    }

    const built = { size: fs.statSync(outAbs).size, entries: header.blockTableEntries, fileCount, hashSize };

    const copied = [];
    for (const folder of targets) {
      const destRoot = folder === 'betapayload' ? BETA_DIR : PAYLOAD_DIR;
      const dest = path.join(destRoot, src.relPath);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(outAbs, dest);
      copied.push(path.relative(REPO_ROOT, dest));
      emit('deployed', { dest: path.relative(REPO_ROOT, dest) });
    }

    try { fs.rmSync(scriptAbs, { force: true }); } catch {}
    return { name, relPath: src.relPath, ok: true, ...built, copied };
  } catch (err) {
    return fail(err.message, null);
  } finally {
    removeLink(linkAbs);
    try { fs.rmSync(outAbs, { force: true }); } catch {}
  }

  function fail(message, run) {
    emit('error', { error: message });
    return {
      name, relPath: src.relPath, ok: false, error: message,
      stdout: run?.stdout?.slice(-4000) ?? null,
      stderr: run?.stderr?.slice(-4000) ?? null,
    };
  }
}

// Builds a batch. Every item is attempted; failures are reported per item.
async function buildAll(items, onProgress) {
  if (!fs.existsSync(MPQ_EDITOR)) {
    throw new Error(`MPQEditor.exe not found at ${MPQ_EDITOR}`);
  }
  cleanTemp();
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const results = [];
  let index = 0;
  for (const { src, targets } of items) {
    index++;
    onProgress && onProgress({ phase: 'start', file: path.basename(src.relPath), index, total: items.length });
    results.push(await buildOne(src, targets, onProgress));
  }
  cleanTemp();
  return results;
}

module.exports = { buildAll, buildOne, readMpqHeader, hashTableSizeFor, cleanTemp, TEMP_DIR };
