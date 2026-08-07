// FCP visual constants (CSS px) — the single home for the timeline's vertical layout and
// clip geometry. Read by the renderer, by the shell's trackRows / hit-testing, and (GUTTER_W)
// by the shell's template. Never duplicate a value here into a component.

// ── FCP visual constants (CSS px) ───────────────────────────────────────────
export const GUTTER_W = 110;      // left track-header column
export const RULER_H = 26;
export const RIBBON_H = 16;      // stories ribbon band, directly under the ruler
export const VIDEO_TRACK_H = 62;
export const AUDIO_TRACK_H = 54;
export const CLIP_INSET_Y = 4;   // vertical padding of a clip inside its lane
export const CLIP_RADIUS = 4;

// Zoom (pixels per timeline second) clamp.
export const ZOOM_MAX = 600;

// A clip narrower than this shows no meaningful waveform — draw plain fill and do
// NOT request peaks. Without this, a zoomed-out timeline with ~2k clips would fire
// an ffmpeg extraction per clip on first paint.
export const MIN_WAVEFORM_PX = 6;
