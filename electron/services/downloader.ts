/**
 * Downloader — runtime download + verify + extract primitives.
 * Ported from Minutes/BookForge (electron/components/downloader.ts). Plain Node:
 * streamed download with redirects + progress + abort, sha256 verification, and
 * archive extraction via the platform's bundled tar/unzip (no npm dependency).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';
import * as crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';

import type { InstallProgress } from './asset-types';

const execAsync = promisify(exec);

/**
 * Integrity expectations for a download, sourced from the asset catalog. Used to
 * guarantee the finished file can be verified: an empty sha256 AND a zero/absent
 * `bytes` means the catalog gives us no integrity signal, so the download must
 * fall back on the server's content-length — and fail if that's missing too.
 */
export interface DownloadIntegrity {
  /** Expected sha256 from the catalog (verified separately by verifySha256). */
  sha256?: string;
  /** Expected download size in bytes from the catalog. 0/undefined = unknown. */
  bytes?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Streamed download with redirects + progress + abort
// ─────────────────────────────────────────────────────────────────────────────

export function downloadFile(
  url: string,
  destPath: string,
  id: string,
  onProgress: (p: InstallProgress) => void,
  signal?: AbortSignal,
  integrity?: DownloadIntegrity
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Download aborted'));
      return;
    }

    // Integrity signals available up-front from the catalog. A truncated stream
    // must never be silently recorded as installed, so we require at least one
    // way to prove completeness before accepting the file (see file 'finish').
    const expectedSha = integrity?.sha256?.trim() ?? '';
    const hasCatalogSha = expectedSha.length > 0;
    const catalogBytes =
      integrity?.bytes !== undefined && integrity.bytes > 0 ? integrity.bytes : 0;

    const file = fs.createWriteStream(destPath);
    let activeRequest: http.ClientRequest | null = null;
    let settled = false;

    const cleanupPartial = () => {
      try {
        file.close();
      } catch {
        /* ignore */
      }
      fs.unlink(destPath, () => {});
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      try {
        activeRequest?.destroy();
      } catch {
        /* ignore */
      }
      cleanupPartial();
      reject(new Error('Download aborted'));
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      fn();
    };

    const makeRequest = (currentUrl: string, redirectsLeft: number) => {
      let parsed: URL;
      try {
        parsed = new URL(currentUrl);
      } catch {
        finish(() => {
          cleanupPartial();
          reject(new Error(`Invalid URL: ${currentUrl}`));
        });
        return;
      }

      const protocol = parsed.protocol === 'https:' ? https : http;

      activeRequest = protocol.get(currentUrl, (response) => {
        const status = response.statusCode ?? 0;

        // Redirects.
        if (status >= 300 && status < 400 && response.headers.location) {
          if (redirectsLeft <= 0) {
            response.resume();
            finish(() => {
              cleanupPartial();
              reject(new Error('Too many redirects'));
            });
            return;
          }
          const next = new URL(response.headers.location, currentUrl).toString();
          console.log(`[ASSETS] Redirecting to ${next}`);
          response.resume();
          makeRequest(next, redirectsLeft - 1);
          return;
        }

        if (status !== 200) {
          response.resume();
          finish(() => {
            cleanupPartial();
            reject(new Error(`HTTP ${status} downloading ${currentUrl}`));
          });
          return;
        }

        const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
        let receivedBytes = 0;
        let lastPct = -1;

        response.on('data', (chunk: Buffer) => {
          receivedBytes += chunk.length;
          if (totalBytes > 0) {
            const pct = Math.round((receivedBytes / totalBytes) * 100);
            if (pct !== lastPct) {
              lastPct = pct;
              onProgress({ id, phase: 'download', pct, receivedBytes, totalBytes });
            }
          } else {
            onProgress({ id, phase: 'download', pct: 0, receivedBytes });
          }
        });

        response.on('error', (err) => {
          finish(() => {
            cleanupPartial();
            reject(err);
          });
        });

        // Idle guard: if the socket goes quiet mid-transfer (stalled CDN, dropped
        // Wi-Fi), fail fast instead of hanging forever. Resets on every chunk.
        let idleTimer: NodeJS.Timeout | null = null;
        const IDLE_MS = 60_000;
        const armIdle = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            activeRequest?.destroy(new Error('Download stalled (no data for 60s)'));
          }, IDLE_MS);
        };
        const clearIdle = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = null;
        };
        response.on('data', armIdle);
        response.on('end', clearIdle);
        response.on('close', clearIdle);
        response.on('error', clearIdle);
        armIdle();

        response.pipe(file);

        file.on('finish', () => {
          file.close((closeErr) => {
            if (closeErr) {
              finish(() => {
                cleanupPartial();
                reject(closeErr);
              });
              return;
            }
            // Integrity guard. Silent acceptance of a possibly-truncated file is
            // a bug, so require at least one signal that proves completeness.
            //
            // Expected size: prefer the server's content-length (unchanged
            // behavior for well-behaved servers like GitHub releases); fall back
            // to the catalog's declared byte count only when the server sent no
            // content-length, so a known size still guards a header-less server.
            const expectedBytes =
              totalBytes > 0 ? totalBytes : catalogBytes;

            if (expectedBytes > 0) {
              // We know how many bytes to expect — enforce an exact match.
              if (receivedBytes !== expectedBytes) {
                finish(() => {
                  cleanupPartial();
                  reject(
                    new Error(
                      `Incomplete download: received ${receivedBytes} of ${expectedBytes} bytes`
                    )
                  );
                });
                return;
              }
            } else if (!hasCatalogSha) {
              // No size from the server, no size in the catalog, and no checksum
              // to fall back on: the file cannot be verified at all. Refuse it
              // rather than record a possibly-incomplete download as installed.
              finish(() => {
                cleanupPartial();
                reject(
                  new Error(
                    `Cannot verify download of ${id}: the server provided no ` +
                      `content-length and no checksum or expected size is known ` +
                      `for this asset. Refusing to accept a possibly-incomplete ` +
                      `file. (${receivedBytes} bytes received from ${currentUrl})`
                  )
                );
              });
              return;
            }
            // else: size unknown but a sha256 is available — verifySha256 (run by
            // the caller after this resolves) will detect any truncation, since a
            // truncated file hashes differently.
            onProgress({
              id,
              phase: 'download',
              pct: 100,
              receivedBytes,
              totalBytes: totalBytes || receivedBytes,
            });
            finish(resolve);
          });
        });
      });

      activeRequest.on('error', (err) => {
        finish(() => {
          cleanupPartial();
          reject(err);
        });
      });
    };

    file.on('error', (err) => {
      finish(() => {
        cleanupPartial();
        reject(err);
      });
    });

    makeRequest(url, 10);
  });
}

/**
 * downloadFile with automatic retries. Large downloads (a 1–2 GB Python env) can
 * be killed by a single transient network blip or a stalled socket; without retry
 * the whole multi-minute download is lost. Retries the full download (no resume)
 * on transient errors, with a short backoff. Never retries a user cancellation.
 */
export async function downloadFileWithRetry(
  url: string,
  destPath: string,
  id: string,
  onProgress: (p: InstallProgress) => void,
  signal?: AbortSignal,
  integrity?: DownloadIntegrity,
  attempts = 3
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await downloadFile(url, destPath, id, onProgress, signal, integrity);
      return;
    } catch (err) {
      // A user cancel aborts immediately — do not retry.
      if (signal?.aborted) throw err;
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[ASSETS] ${id}: download attempt ${attempt}/${attempts} failed: ${msg}`);
      if (attempt < attempts) {
        onProgress({
          id,
          phase: 'download',
          pct: 0,
          message: `Connection lost — retrying (${attempt}/${attempts - 1})…`,
        });
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
  }
  throw lastErr;
}

// ─────────────────────────────────────────────────────────────────────────────
// sha256 verification
// ─────────────────────────────────────────────────────────────────────────────

export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (data) => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/** Verify a file's sha256 against `expected` (case-insensitive). No-op when
 *  `expected` is empty/undefined (logged). Throws on mismatch. */
export async function verifySha256(
  filePath: string,
  expected: string | undefined,
  id: string,
  onProgress: (p: InstallProgress) => void
): Promise<void> {
  if (!expected || expected.trim() === '') {
    console.warn(`[ASSETS] ${id}: no sha256 provided - skipping verification`);
    onProgress({ id, phase: 'verify', pct: 100, message: 'Checksum skipped (none provided)' });
    return;
  }
  onProgress({ id, phase: 'verify', pct: 0, message: 'Verifying checksum…' });
  const actual = await sha256File(filePath);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`Checksum mismatch: expected ${expected}, got ${actual}`);
  }
  onProgress({ id, phase: 'verify', pct: 100, message: 'Checksum OK' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Archive extraction (uses the OS's bundled tar / bsdtar / unzip — no npm dep)
// ─────────────────────────────────────────────────────────────────────────────

export async function extractArchive(
  archivePath: string,
  destDir: string,
  url?: string
): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });

  const lower = (url || archivePath).toLowerCase();
  const isTarGz = lower.endsWith('.tar.gz') || lower.endsWith('.tgz');
  const isZip = lower.endsWith('.zip');

  const maxBuffer = 50 * 1024 * 1024;

  if (isTarGz) {
    await execAsync(`tar -xzf "${archivePath}" -C "${destDir}"`, { maxBuffer });
    return;
  }

  if (isZip) {
    if (os.platform() === 'win32') {
      // Win10+ ships bsdtar, which reads zip files.
      await execAsync(`tar -xf "${archivePath}" -C "${destDir}"`, { maxBuffer });
    } else {
      await execAsync(`unzip -q -o "${archivePath}" -d "${destDir}"`, { maxBuffer });
    }
    return;
  }

  throw new Error(
    `Unsupported archive type for ${url || archivePath} (expected .tar.gz/.tgz/.zip)`
  );
}

/** Recursively find the first file matching `predicate`, or null. */
export function findFile(dir: string, predicate: (name: string) => boolean): string | null {
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    // A dangling symlink or an unreadable entry must skip that entry, not reject
    // the whole dependency check.
    let isDir: boolean;
    try {
      isDir = fs.statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      const found = findFile(full, predicate);
      if (found) return found;
    } else if (predicate(entry)) {
      return full;
    }
  }
  return null;
}
