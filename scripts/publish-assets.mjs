#!/usr/bin/env node
/**
 * publish-assets.mjs — upload built asset archives to the GitHub release.
 *
 * Uploads everything in dist-assets/ to the release tag the in-app catalog
 * points at (RELEASE_TAG in electron/services/asset-catalog.ts), creating the
 * release if it doesn't exist, and prints the final catalog values (sha256,
 * bytes, url) for each uploaded file.
 *
 * Requires the `gh` CLI, authenticated (`gh auth status`).
 *
 * Usage:
 *   node scripts/publish-assets.mjs                  # upload all of dist-assets/
 *   node scripts/publish-assets.mjs --tag assets-v1
 *   node scripts/publish-assets.mjs --dry-run        # show what would happen
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist-assets');

const REPO = 'telltaleatheist/autocutstudio';
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const TAG = arg('tag', 'assets-v1');
const DRY = process.argv.includes('--dry-run');

function gh(args, opts = {}) {
  return execFileSync('gh', args, { encoding: 'utf-8', ...opts });
}

// ── preflight ─────────────────────────────────────────────────────────────────
try {
  execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' });
} catch {
  console.error('✗ gh CLI not authenticated. Run: gh auth login');
  process.exit(1);
}

if (!fs.existsSync(OUT)) {
  console.error(`✗ ${path.relative(ROOT, OUT)} does not exist. Run scripts/package-assets.mjs first.`);
  process.exit(1);
}
const files = fs
  .readdirSync(OUT)
  .filter((f) => f.endsWith('.tar.gz') || f.endsWith('.tgz') || f.endsWith('.zip'))
  .map((f) => path.join(OUT, f));

if (files.length === 0) {
  console.error(`✗ No archives in ${path.relative(ROOT, OUT)}. Run scripts/package-assets.mjs first.`);
  process.exit(1);
}

console.log(`Repo:  ${REPO}`);
console.log(`Tag:   ${TAG}`);
console.log(`Files: ${files.map((f) => path.basename(f)).join(', ')}\n`);

if (DRY) {
  console.log('(dry run — no upload)');
  process.exit(0);
}

// ── ensure the release exists ───────────────────────────────────────────────────
let releaseExists = true;
try {
  gh(['release', 'view', TAG, '--repo', REPO], { stdio: 'ignore' });
} catch {
  releaseExists = false;
}
if (!releaseExists) {
  console.log(`Creating release ${TAG}…`);
  gh([
    'release', 'create', TAG,
    '--repo', REPO,
    '--title', `Assets (${TAG})`,
    '--notes', 'Managed binaries, Python runtime, and models downloaded by AutoCutStudio at runtime.',
  ], { stdio: 'inherit' });
}

// ── upload (clobber so re-publishing updates in place) ───────────────────────────
for (const f of files) {
  console.log(`Uploading ${path.basename(f)}…`);
  gh(['release', 'upload', TAG, f, '--repo', REPO, '--clobber'], { stdio: 'inherit' });
}

// ── final catalog values ────────────────────────────────────────────────────────
console.log('\n──────── catalog values (electron/services/asset-catalog.ts) ────────');
for (const f of files) {
  const buf = fs.readFileSync(f);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const url = `https://github.com/${REPO}/releases/download/${TAG}/${path.basename(f)}`;
  console.log(`\n# ${path.basename(f)}`);
  console.log(`        url: '${url}',`);
  console.log(`        sha256: '${sha256}',`);
  console.log(`        bytes: ${buf.length},`);
}
console.log('\n✓ Done. Paste the sha256 + bytes into the matching artifacts in the catalog.');
