// Pure string / number formatting for the editor. No Angular, no component state.

export const COMPOUNDS_SUFFIX = '_compounds.zip';

/** Pick a "nice" tick interval so labels sit ~80 px apart at the given zoom. */
export function chooseTickStep(pxPerSec: number): number {
  const targetPx = 80;
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  for (const s of steps) {
    if (s * pxPerSec >= targetPx) return s;
  }
  return steps[steps.length - 1];
}

export function pad2(n: number): string { return n < 10 ? '0' + n : String(n); }

export function formatRulerLabel(t: number): string {
  const total = Math.round(t);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

// ── Timecode readout (HH:MM:SS:FF, NDF colons) ──────────────────────────────
/**
 * Format an EDITED-timeline time (seconds) as HH:MM:SS:FF at `frameSeconds`.
 * The caller supplies the frame duration — including the `1001 / 30000` fallback for a
 * manifest that has not loaded yet, which stays at the call site where the manifest lives.
 */
export function formatTimecode(t: number, frameSeconds: number): string {
  const fs = frameSeconds;
  const fps = Math.round(1 / fs);
  const totalFrames = Math.round(t / fs);
  const ff = totalFrames % fps;
  const totalSeconds = Math.floor(totalFrames / fps);
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3600);
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}:${pad2(ff)}`;
}

/** Compact clock (H:MM:SS / M:SS, no frames). */
export function fmtClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

// ── File URL (copied technique from alignment.component.ts) ──────────────────
export function pathToFileUrl(p: string): string {
  return 'file://' + p.split('/').map(encodeURIComponent).join('/');
}

/** Strip a leading "Chapter:", "Chapter 3:", "3." etc. that models often prepend, so story/chapter
 *  labels read cleanly. Falls back to the original if stripping would empty it. */
export function cleanChapterLabel(label: string): string {
  const cleaned = (label || '').replace(/^\s*(chapter|part|section)\s*\d*\s*[:\-.)]?\s*/i, '').trim();
  return cleaned || (label || '').trim();
}

/**
 * Friendly DISPLAY name for a track/speaker id: strip a trailing '_voiceiso_processed',
 * '_processed', or '_voiceiso' (longest first), turn remaining underscores into spaces,
 * collapse whitespace, trim, and capitalize the first character. Pure — never mutates the
 * underlying track ids used for logic. 'mic audio_voiceiso_processed' → 'Mic audio';
 * 'screen audio_processed' → 'Screen audio'; 'merged'/'Merged' → 'Merged'.
 */
export function prettyLabel(raw: string): string {
  if (!raw) return raw;
  let s = raw;
  for (const suf of ['_voiceiso_processed', '_processed', '_voiceiso']) {
    if (s.toLowerCase().endsWith(suf)) { s = s.slice(0, s.length - suf.length); break; }
  }
  s = s.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Filename minus the _compounds.zip suffix (mirrors the launcher's deriveName). */
export function deriveName(zipPath: string): string {
  const base = zipPath.split(/[\\/]/).pop() || zipPath;
  if (base.endsWith(COMPOUNDS_SUFFIX)) return base.slice(0, -COMPOUNDS_SUFFIX.length);
  return base.replace(/\.zip$/i, '');
}
