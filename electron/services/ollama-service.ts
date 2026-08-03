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
  /** Request Ollama's constrained JSON decoding (`format: "json"`). The chapter pipeline sets this
   *  on every call — with temperature 0 it is what makes a run a measurement rather than a sample. */
  json?: boolean;
  /** Caller's cancellation signal, combined with the per-call timeout. Aborting kills the in-flight
   *  HTTP request; Ollama stops generating once the connection drops. */
  signal?: AbortSignal;
}

/** Thrown when a call is aborted by the caller (not by the timeout). Callers distinguish this from
 *  a real failure so a user-initiated stop never surfaces as an error. */
export class OllamaCancelledError extends Error {
  constructor(message = 'Cancelled.') {
    super(message);
    this.name = 'OllamaCancelledError';
  }
}

/**
 * The model most recently asked to generate, so the app can evict it on quit without the caller
 * having to remember what it used. Set on every `generate()`; cleared by `unload()`.
 */
let lastUsed: { model: string; host?: string } | null = null;

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
    json = false,
    signal,
  } = opts;
  if (signal?.aborted) throw new OllamaCancelledError();
  lastUsed = { model, host };
  // An explicit numCtx is honoured verbatim (never clamped): the chapter summarizer sizes context
  // to a whole chapter and would rather refuse than have a prompt silently truncated under it.
  const numCtx = opts.numCtx ?? computeNumCtx(prompt, numPredict);
  log.info(
    `[Ollama] generate model=${model} prompt=${prompt.length}c num_ctx=${numCtx} ` +
    `num_predict=${numPredict} temp=${temperature}${json ? ' format=json' : ''}`
  );

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
          ...(json ? { format: 'json' } : {}),
          options: { temperature, num_ctx: numCtx, num_predict: numPredict },
        }),
        // The caller's cancellation and the per-call timeout both abort this request; whichever
        // fires first wins. They are told apart afterwards by the caller's own signal state.
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
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
      // A user-initiated stop is not a failure — surface it as such so no retry, no host
      // fall-through, and no error banner treats it like one.
      if (signal?.aborted) throw new OllamaCancelledError();
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

// ── Chat completions (POST /api/chat) ────────────────────────────────────────
// `generate()` above is the single-prompt path the chapter pipeline uses. A model
// fine-tuned on a chat template (the title model) must be called through /api/chat
// instead: its system/user turns have to be rendered by the model's OWN template,
// and hand-splicing that into a /api/generate prompt string would silently train
// the model on a shape it never saw.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  /** Nucleus sampling (`top_p`). Omitted from the request when undefined so Ollama's default holds. */
  topP?: number;
  /** `top_k`. Omitted when undefined so the MODELFILE's value holds (headline's carries top_k 20);
   *  pass 0 to disable top-k entirely for that call. */
  topK?: number;
  numPredict?: number;
  numCtx?: number;
  timeoutMs?: number;
  host?: string;
  signal?: AbortSignal;
  /**
   * Ollama's `think` flag. Defaults to FALSE and is always sent: the title model is a Qwen3
   * derivative, whose base template turns thinking ON unless told otherwise. A thinking title
   * model burns its whole num_predict budget inside <think> and returns nothing.
   */
  think?: boolean;
}

interface OllamaChatResponse {
  message?: { role?: string; content?: string };
  error?: string;
}

/**
 * One chat completion (POST /api/chat, stream:false). Same loud-failure contract as `generate()`:
 * any HTTP/Ollama error — including "model not found" — is thrown with the server's own message,
 * never swallowed and never retried against a different model.
 */
export async function chat(model: string, messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  if (!model || !model.trim()) {
    throw new Error('No Ollama model specified for the chat call.');
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('No chat messages provided.');
  }
  const {
    temperature = 0.7,
    topP,
    topK,
    numPredict = 256,
    timeoutMs = 300000,
    host,
    signal,
    think = false,
  } = opts;
  if (signal?.aborted) throw new OllamaCancelledError();
  lastUsed = { model, host };

  const joined = messages.map((m) => m.content).join('\n');
  const numCtx = opts.numCtx ?? computeNumCtx(joined, numPredict);

  const bases = hostsToTry(host);
  let lastErr: unknown = null;
  for (const base of bases) {
    try {
      const res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          think,
          options: {
            temperature,
            num_ctx: numCtx,
            num_predict: numPredict,
            ...(topP === undefined ? {} : { top_p: topP }),
            ...(topK === undefined ? {} : { top_k: topK }),
          },
        }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Ollama HTTP ${res.status}: ${body.slice(0, 300)}`);
      }
      const data = (await res.json()) as OllamaChatResponse;
      if (data.error) throw new Error(`Ollama error: ${data.error}`);
      const text = (data.message?.content || '').trim();
      if (!text) throw new Error('Ollama returned an empty response.');
      return text;
    } catch (err) {
      if (signal?.aborted) throw new OllamaCancelledError();
      lastErr = err;
      if (bases.length > 1 && err instanceof TypeError) continue;
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error('Could not reach Ollama. Is it running on 127.0.0.1:11434?');
}

/**
 * Evict a model from memory (`keep_alive: 0` on an empty generate). Called once a long chapter run
 * finishes so the VRAM/RAM goes back to the machine — the method serves one model at a time, and a
 * 14B left resident after a 25-minute run is 9-ish GB nobody asked for.
 *
 * Best-effort by design: a failure to unload is logged, never thrown. The analysis already
 * succeeded, and failing it at the door over housekeeping would throw away the real result.
 */
export async function unload(model: string, host?: string, timeoutMs = 15000): Promise<void> {
  if (!model || !model.trim()) return;
  if (lastUsed?.model === model) lastUsed = null;
  for (const base of hostsToTry(host)) {
    try {
      const res = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: '', keep_alive: 0 }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        log.info(`[Ollama] unloaded ${model}`);
        return;
      }
    } catch {
      // try next host variant
    }
  }
  log.warn(`[Ollama] could not unload ${model} — it stays resident until Ollama's own keep_alive expires`);
}

/**
 * Evict whatever model this process last asked to generate. Used on app quit so closing the app
 * never leaves a 9-to-20 GB model resident — the user quit, they are done with it.
 *
 * `timeoutMs` is short by default because this runs on the quit path: a machine where Ollama has
 * already gone away must not hold the app open. No-op when nothing was ever generated.
 */
export async function unloadLastUsed(timeoutMs = 3000): Promise<void> {
  const target = lastUsed;
  if (!target) return;
  await unload(target.model, target.host, timeoutMs);
}
