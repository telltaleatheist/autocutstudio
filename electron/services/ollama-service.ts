// electron/services/ollama-service.ts
import * as log from 'electron-log';

/**
 * Minimal Ollama HTTP client for local LLM calls (story chapter-splitting and
 * title suggestions). Ollama-only for now — a deliberate first step: the user
 * already has models pulled locally, so nothing is downloaded. When a model is
 * settled on, a llama.cpp/GGUF managed-download backend can be slotted behind
 * the same `generate()` shape (see the Minutes app's llama-runtime for a port).
 *
 * Uses the built-in global `fetch` (Electron 32 / Node 20) — no axios dependency.
 * Default host is 127.0.0.1 (more reliable than `localhost` on Windows); the
 * `localhost` variant is retried once as a courtesy, never as a silent mask for
 * a real connection failure.
 */

const DEFAULT_HOST = 'http://127.0.0.1:11434';

export interface OllamaModel {
  id: string;
  name: string;
}

interface OllamaTagsResponse {
  models?: Array<{ name: string }>;
}

interface OllamaGenerateResponse {
  response?: string;
  error?: string;
}

function hostsToTry(host?: string): string[] {
  const primary = host || DEFAULT_HOST;
  if (primary.includes('localhost')) {
    return [primary, primary.replace('localhost', '127.0.0.1')];
  }
  return [primary];
}

/**
 * List installed Ollama models (GET /api/tags). Returns `{ connected, models }`.
 * A failed connection is reported as `connected: false` (not thrown) so the UI
 * can prompt the user to start Ollama — this is a status query, not an operation
 * whose failure should abort a pipeline.
 */
export async function listModels(host?: string): Promise<{ connected: boolean; models: OllamaModel[] }> {
  for (const base of hostsToTry(host)) {
    try {
      const res = await fetch(`${base}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as OllamaTagsResponse;
      const models = (data.models || []).map((m) => ({ id: m.name, name: m.name }));
      return { connected: true, models };
    } catch {
      // try next host variant
    }
  }
  return { connected: false, models: [] };
}

export interface GenerateOptions {
  temperature?: number;
  numCtx?: number;
  numPredict?: number;
  timeoutMs?: number;
  host?: string;
}

// Context sizing. Ollama reloads the model whenever num_ctx changes, so we quantize the requested
// context to 4096-token buckets: successive calls of similar size reuse the same loaded context
// instead of thrashing. ~3 chars/token is a deliberately conservative estimate (real English is
// closer to 4) so we never under-size and truncate the prompt.
const CHARS_PER_TOKEN = 3;
const CTX_BUCKET = 4096;
const CTX_MIN = 4096;
const CTX_MAX = 32768;

/**
 * Size num_ctx to what we're actually sending — prompt tokens + the output reserve + a little
 * scaffold — rounded up to a 4096 bucket and clamped. Sizing to the maximum wastes memory (the KV
 * cache scales with context); this keeps each call's footprint proportional to its input.
 */
function computeNumCtx(prompt: string, numPredict: number): number {
  const promptTokens = Math.ceil(prompt.length / CHARS_PER_TOKEN);
  const needed = promptTokens + numPredict + 512;
  const bucketed = Math.ceil(needed / CTX_BUCKET) * CTX_BUCKET;
  return Math.max(CTX_MIN, Math.min(bucketed, CTX_MAX));
}

/**
 * One-shot completion (POST /api/generate, stream:false). Throws LOUDLY with the
 * Ollama error / HTTP status on any failure — callers surface it to the user
 * rather than proceeding with a fabricated result. num_ctx is sized dynamically
 * from the prompt unless an explicit `numCtx` is given.
 */
export async function generate(model: string, prompt: string, opts: GenerateOptions = {}): Promise<string> {
  if (!model || !model.trim()) {
    throw new Error('No Ollama model selected. Pick a model in the Stories panel first.');
  }
  const {
    temperature = 0.2,
    numPredict = 1024,
    timeoutMs = 600000,
    host,
  } = opts;
  const numCtx = opts.numCtx ?? computeNumCtx(prompt, numPredict);
  log.info(`[Ollama] generate model=${model} prompt=${prompt.length}c num_ctx=${numCtx} num_predict=${numPredict}`);

  const bases = hostsToTry(host);
  let lastErr: unknown = null;
  for (const base of bases) {
    try {
      const res = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt,
          stream: false,
          options: { temperature, num_ctx: numCtx, num_predict: numPredict },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Ollama HTTP ${res.status}: ${body.slice(0, 300)}`);
      }
      const data = (await res.json()) as OllamaGenerateResponse;
      if (data.error) throw new Error(`Ollama error: ${data.error}`);
      const text = (data.response || '').trim();
      if (!text) throw new Error('Ollama returned an empty response.');
      return text;
    } catch (err) {
      lastErr = err;
      // Only fall through to the next host variant on connection-class errors;
      // an HTTP/error-body failure is real and should surface, not be retried.
      if (bases.length > 1 && err instanceof TypeError) continue;
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error('Could not reach Ollama. Is it running on 127.0.0.1:11434?');
}
