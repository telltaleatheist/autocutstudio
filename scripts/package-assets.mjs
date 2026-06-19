#!/usr/bin/env node
/**
 * package-assets.mjs — build downloadable asset archives for the GitHub release.
 *
 * Produces archives in dist-assets/ matching the names the in-app catalog
 * expects (electron/services/asset-catalog.ts), and prints the sha256 + bytes to
 * paste back into that catalog.
 *
 * Components:
 *   ffmpeg-tools  — tar.gz of ffmpeg + ffprobe from binaries/<platformDir>/
 *   python-env    — conda-pack of a conda env (requires `conda-pack`)
 *   whisper-base  — NOT packaged here (served from Hugging Face)
 *
 * Usage:
 *   node scripts/package-assets.mjs                         # ffmpeg-tools, current platform
 *   node scripts/package-assets.mjs --component ffmpeg-tools,python-env
 *   node scripts/package-assets.mjs --platform darwin-arm64
 *   node scripts/package-assets.mjs --component python-env --env-name autocutstudio
 */

import { execFileSync, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist-assets');

// ── CLI args ────────────────────────────────────────────────────────────────
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function currentPlatform() {
  const p = process.platform; // darwin | win32 | linux
  const a = process.arch === 'arm64' ? 'arm64' : 'x64';
  return `${p}-${a}`;
}
// asset platform key (node-style) -> binaries/ dir name
function binariesDirFor(platformKey) {
  const [p, a] = platformKey.split('-');
  const plat = p === 'darwin' ? 'mac' : p === 'win32' ? 'win' : 'linux';
  return `${plat}-${a}`;
}

const components = arg('component', 'ffmpeg-tools').split(',').map((s) => s.trim());
const platformKey = arg('platform', currentPlatform());
const envName = arg('env-name', 'autocutstudio');

fs.mkdirSync(OUT, { recursive: true });

const results = [];

function record(name, file) {
  const buf = fs.readFileSync(file);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const bytes = buf.length;
  results.push({ name, file, sha256, bytes });
}

// ── ffmpeg-tools ──────────────────────────────────────────────────────────────
function packageFfmpegTools() {
  const dir = path.join(ROOT, 'binaries', binariesDirFor(platformKey));
  const isWin = platformKey.startsWith('win32');
  const names = isWin ? ['ffmpeg.exe', 'ffprobe.exe'] : ['ffmpeg', 'ffprobe'];
  for (const n of names) {
    const p = path.join(dir, n);
    if (!fs.existsSync(p)) {
      throw new Error(`Missing ${n} at ${p} — cannot package ffmpeg-tools for ${platformKey}`);
    }
  }
  const ext = isWin ? 'zip' : 'tar.gz';
  const out = path.join(OUT, `ffmpeg-tools-${platformKey}.${ext}`);
  fs.rmSync(out, { force: true });
  if (isWin) {
    // bsdtar (ships on Win10+) can create zips; flat archive at root.
    execFileSync('tar', ['-a', '-c', '-f', out, '-C', dir, ...names], { stdio: 'inherit' });
  } else {
    execFileSync('tar', ['-czf', out, '-C', dir, ...names], { stdio: 'inherit' });
  }
  record('ffmpeg-tools', out);
  console.log(`✓ ffmpeg-tools → ${path.relative(ROOT, out)}`);
}

// ── python-env (conda-pack) ───────────────────────────────────────────────────
function packagePythonEnv() {
  // conda-pack produces a relocatable tarball of the named env.
  try {
    execSync('conda-pack --version', { stdio: 'ignore' });
  } catch {
    throw new Error(
      'conda-pack not found. Install it (`conda install -c conda-forge conda-pack` or `pip install conda-pack`) and retry.'
    );
  }
  const out = path.join(OUT, `python-env-${platformKey}.tar.gz`);
  fs.rmSync(out, { force: true });
  console.log(`Packing conda env "${envName}" → ${path.relative(ROOT, out)} (this can take a while)…`);
  execFileSync('conda-pack', ['-n', envName, '-o', out, '--force'], { stdio: 'inherit' });
  record('python-env', out);
  console.log(`✓ python-env → ${path.relative(ROOT, out)}`);
}

// ── run ───────────────────────────────────────────────────────────────────────
console.log(`Packaging [${components.join(', ')}] for ${platformKey}\n`);
for (const c of components) {
  if (c === 'ffmpeg-tools') packageFfmpegTools();
  else if (c === 'python-env') packagePythonEnv();
  else if (c === 'whisper-base') console.log('• whisper-base is served from Hugging Face — nothing to package.');
  else console.warn(`! Unknown component: ${c}`);
}

// ── report ──────────────────────────────────────────────────────────────────
console.log('\n──────── paste into electron/services/asset-catalog.ts ────────');
for (const r of results) {
  console.log(`\n# ${path.basename(r.file)}  (component: ${r.name}, platform: ${platformKey})`);
  console.log(`        sha256: '${r.sha256}',`);
  console.log(`        bytes: ${r.bytes},`);
}
console.log('\nNext: node scripts/publish-assets.mjs   (uploads dist-assets/* to the GitHub release)');
