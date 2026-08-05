#!/usr/bin/env python3
"""
headline-32b-titles — an Ollama-shaped HTTP front end for an MLX LoRA adapter.

WHY THIS EXISTS
---------------
Auto Cut Studio's Titles tab speaks exactly one protocol: Ollama's `POST /api/chat`
on `http://127.0.0.1:11434` (see electron/services/ollama-service.ts). The 32B title
model is not an Ollama model and cannot cheaply become one — it is an **MLX LoRA
adapter** over `mlx-community/Qwen3-32B-4bit`, and Ollama has no loader for that.

Turning it into one would mean fuse -> de-quantize to ~65 GB fp16 -> GGUF ->
re-quantize: hours of wall clock, ~130 GB of transient disk, and a final artifact
whose weights are no longer bit-identical to the ones that were auditioned. For an
A/B test against the shipped 14B that is the wrong trade.

So instead this file stands the model up behind the *same* HTTP shape on a DIFFERENT
port (11435). Real Ollama keeps 11434 and keeps serving chapter splitting, stories
and everything else — nothing about those paths changes. Only the title calls are
pointed here, by one constant (`TITLE_HOST` in electron/services/title-generator.ts).

That makes the whole experiment reversible in one line, and it serves the exact
weights that were auditioned. If the 32B wins, the GGUF/Ollama production route is a
separate, later job — this shim is a test rig, not a shipping component.

THE PROMPT CONTRACT
-------------------
The model was fine-tuned with `mask_prompt: true` against Qwen3's chat template with
thinking DISABLED. Qwen3's template, when told `enable_thinking=False`, pre-fills an
empty `<think>\n\n</think>` pair at the head of the assistant turn; under mask_prompt
that pre-filled block was part of the trained target region. Rendering with thinking
left ON therefore does two bad things at once: it makes the model pay ~8 tokens to
re-emit a block it was trained to receive for free, and it invites a real reasoning
block into a 64-token budget with room for a title and nothing else.

So every request is rendered with:

    apply_chat_template(messages, add_generation_prompt=True, enable_thinking=False)

`think: true` in a request body flips that back on — honoured, never assumed. The app
always sends `think: false`.

GENERATION RUNS ON THE MAIN THREAD, AND THAT IS LOAD-BEARING
------------------------------------------------------------
Measured on mlx 0.32.0 / mlx-lm 0.31.3, 2026-08-04, after this server's first draft
returned the *same title six times in a row* at temperature 0.9:

    main thread   : categorical_sampling(...) -> [2,1,1,0,0,1,2,3]  (varies, advances)
    worker thread : categorical_sampling(...) -> [0,0,0,0,0,0,0,0]  (frozen)
    worker thread : raw mx.random.categorical -> RuntimeError:
                    "There is no Stream(gpu, 0) in current thread."

MLX's random state and its GPU stream are per-thread, and a thread that is not the
main one gets a default state that never advances — `mx.random.seed()` inside that
thread does not fix it either (measured). Sampling there silently degrades to
argmax-like determinism: the text is still coherent, the temperature still changes
the output, so nothing looks broken. It is exactly the kind of failure that would
have shipped, because the only symptom is that ten "independent" title samples come
back identical — which a reader would blame on the model, not the server.

Hence the shape below: the HTTP server runs on background threads (sockets and JSON
are fine there), and every request is handed to the MAIN thread through a queue,
which does the tokenizing and the generating and hands the result back. One job at a
time, by construction — the app fans out three concurrent title calls and they queue.
A 32B on this machine is latency-bound per token anyway, so interleaving would buy
nothing even if MLX allowed it.

NO FALLBACKS
------------
This codebase's rule (read the header of title-generator.ts) is that nothing is ever
silently substituted. Applied here:

  * A missing or unreadable adapter directory aborts at startup. It does not fall
    back to serving the bare base model, which would look like it worked and quietly
    produce base-Qwen titles.
  * A request naming a model this process is not serving is a 404 with both names in
    the message. It is NOT quietly answered by whatever happens to be loaded.
  * A malformed body — no messages, an unknown role, `stream: true` — is a 400 saying
    precisely what was wrong. Nothing is guessed and no default request is invented.
  * A title is never fabricated. What the model emitted is what comes back, and an
    empty generation comes back empty so the app's own loud "empty response" check
    fires exactly as it does against real Ollama.

WHAT IS IMPLEMENTED
-------------------
  POST /api/chat      the real work; Ollama's non-streaming chat response shape.
  GET  /api/tags      the served model, in Ollama's shape, so ollama-service's
                      `listModels()` connection check succeeds against this port.
  POST /api/generate  ONLY the eviction call `ollamaService.unload()` makes
                      (`{prompt: "", keep_alive: 0}`). Answered 200 as a no-op — see
                      the handler for why an actual unload would be self-defeating.
                      A real generate request is a 400: this shim is chat-only.
  GET  /api/version   trivial, and free.

Everything else is a 404 that names the path.

USAGE
-----
    /bin/sh tools/headline32b-server/serve-headline-32b.sh

Loading takes seconds off a warm page cache and ~18.4 GB resident; the model then
stays put for the life of the process. Never reloaded per request — that is the
entire reason this is a server and not a CLI.
"""

import argparse
import datetime
import json
import os
import queue
import secrets
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_BASE = "mlx-community/Qwen3-32B-4bit"
DEFAULT_ADAPTER = os.path.expanduser("~/headline-32b-titles/adapter")
DEFAULT_MODEL_NAME = "headline-32b-titles"
DEFAULT_PORT = 11435  # NEVER 11434 — real Ollama owns that and other features need it.

# How long an HTTP thread waits for the main thread to finish its job before giving up.
# Generous: three queued 64-token calls on a 32B is well inside it, and the app's own
# per-call timeout (300 s) is the real deadline anyway.
JOB_TIMEOUT_S = 900

# Set once at startup, read by every request. Assigned in main().
MODEL = None
TOKENIZER = None
SERVED_NAME = None
ADAPTER_PATH = None
BASE_MODEL = None

# The hand-off to the main thread. See the module docstring — this is not an
# optimisation, it is the only place MLX will sample properly.
JOB_QUEUE: "queue.Queue" = queue.Queue()


def log(msg: str) -> None:
    stamp = datetime.datetime.now().strftime("%H:%M:%S")
    print(f"[{stamp}] {msg}", flush=True)


def die(msg: str, code: int = 2) -> None:
    """Startup failures are fatal and loud. There is no degraded mode worth having."""
    print(f"FATAL: {msg}", file=sys.stderr, flush=True)
    sys.exit(code)


class BadRequest(Exception):
    """A 400. The message goes to the client verbatim — it is the whole diagnostic."""


class ModelNotFound(Exception):
    """A 404 for a model this process is not serving."""

    def __init__(self, requested):
        super().__init__(requested)
        self.requested = requested


class Job:
    """One /api/chat request, in flight between an HTTP thread and the main thread."""

    __slots__ = ("body", "done", "result", "error")

    def __init__(self, body):
        self.body = body
        self.done = threading.Event()
        self.result = None
        self.error = None


# ── Prompt rendering ─────────────────────────────────────────────────────────


def render_prompt(messages, enable_thinking: bool):
    """
    Messages -> (prompt string for the log, token ids for the model).

    Rendered twice on purpose: `tokenize=False` gives an exact, greppable record of
    what the model saw, and `tokenize=True` gives the ids without a round trip through
    a string whose special-token parsing would have to be trusted.
    """
    text = TOKENIZER.apply_chat_template(
        messages,
        tokenize=False,
        add_generation_prompt=True,
        enable_thinking=enable_thinking,
    )
    encoded = TOKENIZER.apply_chat_template(
        messages,
        tokenize=True,
        add_generation_prompt=True,
        enable_thinking=enable_thinking,
    )
    # transformers returns either a bare list of ids or a BatchEncoding, depending on
    # version and template. Both are fine; anything else is not, and says so.
    ids = encoded["input_ids"] if hasattr(encoded, "keys") else encoded
    if len(ids) > 0 and isinstance(ids[0], (list, tuple)):
        ids = ids[0]
    if not isinstance(ids, (list, tuple)) or not all(isinstance(t, int) for t in ids):
        raise RuntimeError(
            f"chat template returned token ids of an unusable type: {type(encoded)!r}"
        )
    return text, list(ids)


# ── Request validation ───────────────────────────────────────────────────────


def validate_messages(raw):
    if not isinstance(raw, list) or not raw:
        raise BadRequest("`messages` must be a non-empty array.")
    out = []
    for i, m in enumerate(raw):
        if not isinstance(m, dict):
            raise BadRequest(f"messages[{i}] is not an object.")
        role = m.get("role")
        content = m.get("content")
        if role not in ("system", "user", "assistant"):
            raise BadRequest(
                f"messages[{i}].role must be system|user|assistant, got: {role!r}"
            )
        if not isinstance(content, str) or not content.strip():
            raise BadRequest(f"messages[{i}].content is missing or empty.")
        out.append({"role": role, "content": content})
    return out


def read_options(body):
    """
    Ollama's `options` object -> MLX sampler arguments.

    Only the knobs ollama-service actually sends are read. `num_ctx` is accepted and
    logged but has no MLX equivalent: mlx-lm's KV cache grows with the sequence, there
    is no context to pre-size, and pretending otherwise would be theatre.
    """
    opts = body.get("options")
    if opts is None:
        opts = {}
    if not isinstance(opts, dict):
        raise BadRequest("`options` must be an object when present.")

    def num(key, default):
        v = opts.get(key)
        if v is None:
            return default
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            raise BadRequest(f"options.{key} must be a number, got: {v!r}")
        return v

    temperature = float(num("temperature", 0.7))
    top_p = float(num("top_p", 0.0))  # 0 == off, matching mlx-lm's own convention
    top_k = int(num("top_k", 0))  # 0 == off; the app sends 0 deliberately
    num_predict = int(num("num_predict", 256))
    num_ctx = opts.get("num_ctx")

    if temperature < 0:
        raise BadRequest(f"options.temperature must be >= 0, got: {temperature}")
    if num_predict < 1:
        raise BadRequest(f"options.num_predict must be >= 1, got: {num_predict}")
    return temperature, top_p, top_k, num_predict, num_ctx


# ── Generation (MAIN THREAD ONLY — see the module docstring) ─────────────────


def run_chat(body):
    from mlx_lm import stream_generate
    from mlx_lm.sample_utils import make_sampler

    requested = body.get("model")
    if not isinstance(requested, str) or not requested.strip():
        raise BadRequest("`model` is required.")
    if requested.strip() != SERVED_NAME:
        # Deliberately a hard error. Answering for a model we were not asked for is the
        # exact silent substitution this project forbids.
        raise ModelNotFound(requested.strip())

    if body.get("stream"):
        raise BadRequest(
            "`stream: true` is not implemented by this shim; the Titles feature sends "
            "stream:false. Use real Ollama if you need streaming."
        )

    messages = validate_messages(body.get("messages"))
    temperature, top_p, top_k, num_predict, num_ctx = read_options(body)
    # `think` defaults to False and the app always sends it explicitly. True is honoured
    # rather than refused — it is a legitimate thing to ask a Qwen3 for — but it is not
    # what this adapter was trained under, so it is logged loudly when it happens.
    think = bool(body.get("think", False))

    prompt_text, ids = render_prompt(messages, enable_thinking=think)
    sampler = make_sampler(temp=temperature, top_p=top_p, top_k=top_k)

    log(
        f"chat model={requested} temp={temperature} top_p={top_p} top_k={top_k} "
        f"num_predict={num_predict} num_ctx={num_ctx} think={think} "
        f"prompt={len(prompt_text)}c/{len(ids)}tok"
    )
    if think:
        log("  !! think=true — this adapter was trained with thinking DISABLED")

    started = time.time()
    pieces = []
    finish_reason = None
    gen_tokens = 0
    for resp in stream_generate(
        MODEL, TOKENIZER, ids, max_tokens=num_predict, sampler=sampler
    ):
        pieces.append(resp.text)
        gen_tokens = resp.generation_tokens
        finish_reason = resp.finish_reason
    elapsed = time.time() - started
    content = "".join(pieces)

    rate = gen_tokens / elapsed if elapsed else 0
    log(f"  -> {gen_tokens}tok in {elapsed:.1f}s ({rate:.1f} tok/s) finish={finish_reason}")
    log(f"  -> {content!r}")
    if not content.strip():
        # Not patched over: an empty string is returned as an empty string, exactly as
        # Ollama would, so ollama-service's own "returned an empty response" error is
        # what the user sees. A fabricated title here would be indistinguishable from
        # a real one, which is the worst possible failure mode for this feature.
        log("  !! EMPTY generation — the app will surface this as a failed call")

    return {
        "model": SERVED_NAME,
        "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "message": {"role": "assistant", "content": content},
        "done": True,
        "done_reason": finish_reason or "stop",
        "prompt_eval_count": len(ids),
        "eval_count": gen_tokens,
        "total_duration": int(elapsed * 1e9),
    }


# ── HTTP ─────────────────────────────────────────────────────────────────────


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "headline32b-shim"

    def log_message(self, fmt, *args):  # noqa: A003 - BaseHTTPRequestHandler's name
        # Route the access log through our own logger so stdout is one coherent stream.
        log(f"http {fmt % args}")

    # -- plumbing ------------------------------------------------------------

    def _send(self, code, payload):
        blob = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(blob)))
        self.end_headers()
        self.wfile.write(blob)

    def _error(self, code, message):
        # Ollama reports failures as `{"error": "..."}`; ollama-service checks both the
        # status code and that key, so keeping the shape means its existing error
        # handling reports our message unchanged.
        log(f"  !! {code}: {message}")
        self._send(code, {"error": message})

    def _read_json(self):
        length = self.headers.get("Content-Length")
        if length is None:
            raise BadRequest("Content-Length is required.")
        raw = self.rfile.read(int(length))
        try:
            body = json.loads(raw.decode("utf-8"))
        except Exception as exc:
            raise BadRequest(f"body is not valid JSON: {exc}")
        if not isinstance(body, dict):
            raise BadRequest("body must be a JSON object.")
        return body

    # -- routes --------------------------------------------------------------

    def do_GET(self):
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        if path == "/api/tags":
            self._send(
                200,
                {
                    "models": [
                        {
                            "name": SERVED_NAME,
                            "model": SERVED_NAME,
                            "modified_at": datetime.datetime.now(
                                datetime.timezone.utc
                            ).isoformat(),
                            "size": 0,
                            "digest": "mlx-lora-adapter",
                            "details": {
                                "parent_model": BASE_MODEL,
                                "format": "mlx",
                                "family": "qwen3",
                                "families": ["qwen3"],
                                "parameter_size": "32B",
                                "quantization_level": "Q4",
                            },
                        }
                    ]
                },
            )
            return
        if path == "/api/version":
            self._send(200, {"version": "headline32b-shim"})
            return
        self._error(404, f"{path} is not implemented by the headline-32b shim.")

    def do_POST(self):
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        try:
            if path == "/api/chat":
                self._send(200, self._dispatch_to_main(self._read_json()))
                return
            if path == "/api/generate":
                self._handle_generate(self._read_json())
                return
            self._error(404, f"{path} is not implemented by the headline-32b shim.")
        except BadRequest as exc:
            self._error(400, str(exc))
        except ModelNotFound as exc:
            self._error(
                404,
                f"model '{exc.requested}' is not served here — this process serves "
                f"'{SERVED_NAME}' only. Point TITLE_MODEL at it, or send the title "
                f"calls to real Ollama on 11434.",
            )
        except Exception as exc:  # noqa: BLE001 - deliberately broad, deliberately loud
            import traceback

            traceback.print_exc()
            self._error(500, f"{type(exc).__name__}: {exc}")

    def _dispatch_to_main(self, body):
        """
        Hand the request to the main thread and block until it answers.

        Validation happens over there too, so that every code path — good request and
        bad — is executed in exactly one place, and the exception it raises maps to the
        same status code it would have if this were a single-threaded server.
        """
        job = Job(body)
        JOB_QUEUE.put(job)
        if not job.done.wait(JOB_TIMEOUT_S):
            raise RuntimeError(
                f"generation did not finish within {JOB_TIMEOUT_S}s — the main thread "
                "is stuck or the queue is backed up."
            )
        if job.error is not None:
            raise job.error
        return job.result

    def _handle_generate(self, body):
        """
        `ollamaService.unload()` evicts a model by POSTing `/api/generate` with an empty
        prompt and `keep_alive: 0`. The Titles tab does that on leaving the tab, and the
        app does it again on quit.

        Answered as a successful no-op. Actually unloading would be self-defeating: this
        process exists to hold a 32B resident, and the app's eviction reflex is tuned to
        Ollama, which can bring a model back in seconds. The model is released when this
        process is stopped, which is the honest control surface.

        A *real* generate request (non-empty prompt) is a 400: this shim implements chat
        only, and quietly answering a completion request through the chat template would
        put the model on a prompt shape it was never trained for.
        """
        prompt = body.get("prompt")
        keep_alive = body.get("keep_alive")
        if (prompt is None or prompt == "") and keep_alive == 0:
            log(
                f"unload requested for {body.get('model')!r} — ignored on purpose; the "
                "MLX model stays resident until this process exits"
            )
            self._send(
                200,
                {
                    "model": body.get("model") or SERVED_NAME,
                    "created_at": datetime.datetime.now(
                        datetime.timezone.utc
                    ).isoformat(),
                    "response": "",
                    "done": True,
                    "done_reason": "unload",
                },
            )
            return
        raise BadRequest(
            "/api/generate is not implemented by the headline-32b shim (only the "
            "keep_alive:0 eviction call is tolerated). The title model is chat-shaped: "
            "use POST /api/chat."
        )


# ── Startup ──────────────────────────────────────────────────────────────────


def main():
    global MODEL, TOKENIZER, SERVED_NAME, ADAPTER_PATH, BASE_MODEL

    ap = argparse.ArgumentParser(
        description="Ollama-shaped HTTP server for the headline-32b MLX LoRA adapter."
    )
    ap.add_argument("--adapter", default=DEFAULT_ADAPTER, help="adapter directory")
    ap.add_argument("--base", default=DEFAULT_BASE, help="base model (HF repo or path)")
    ap.add_argument("--model-name", default=DEFAULT_MODEL_NAME, help="name to serve as")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--bind", default="127.0.0.1", help="loopback only, by design")
    ap.add_argument(
        "--seed",
        type=int,
        default=None,
        help="RNG seed. Omitted means a fresh one from the OS, printed at startup — so "
        "a restart gives new candidates, and a run can still be reproduced by passing "
        "the seed it logged.",
    )
    args = ap.parse_args()

    if args.port == 11434:
        die(
            "refusing to bind 11434 — real Ollama owns that port and the rest of the "
            "app depends on it. Use 11435."
        )

    ADAPTER_PATH = os.path.abspath(os.path.expanduser(args.adapter))
    BASE_MODEL = args.base
    SERVED_NAME = args.model_name

    # Checked before the model load, so a typo'd path fails in a second, not a minute.
    if not os.path.isdir(ADAPTER_PATH):
        die(f"adapter directory does not exist: {ADAPTER_PATH}")
    for required in ("adapters.safetensors", "adapter_config.json"):
        if not os.path.isfile(os.path.join(ADAPTER_PATH, required)):
            die(f"{required} is missing from {ADAPTER_PATH}")

    log(f"base    : {BASE_MODEL}")
    log(f"adapter : {ADAPTER_PATH}")
    log(f"serving : {SERVED_NAME} on http://{args.bind}:{args.port}")
    log("loading (a 32B at 4-bit — ~18 GB resident) ...")

    import mlx.core as mx
    from mlx_lm import load, stream_generate
    from mlx_lm.sample_utils import make_sampler

    seed = args.seed if args.seed is not None else secrets.randbits(31)
    mx.random.seed(seed)
    log(f"rng seed: {seed}  (pass --seed {seed} to reproduce this session)")

    started = time.time()
    MODEL, TOKENIZER = load(BASE_MODEL, adapter_path=ADAPTER_PATH)
    if not hasattr(TOKENIZER, "apply_chat_template"):
        die(
            "the loaded tokenizer has no apply_chat_template — cannot render the "
            "trained prompt shape, refusing to serve."
        )
    log(
        f"loaded in {time.time() - started:.1f}s · "
        f"{mx.get_active_memory() / 1e9:.1f} GB active"
    )

    # One tiny generation so the first REAL request does not also pay Metal's kernel
    # compilation. Its output is discarded; it only proves the stack is alive.
    warm_started = time.time()
    _, warm_ids = render_prompt(
        [
            {
                "role": "user",
                "content": "task: title\nformat: normal\ntarget: typical\n\nVideo:\n- warmup",
            }
        ],
        enable_thinking=False,
    )
    for _ in stream_generate(
        MODEL, TOKENIZER, warm_ids, max_tokens=4, sampler=make_sampler(temp=0.0)
    ):
        pass
    log(f"warmup done in {time.time() - warm_started:.1f}s — ready")

    server = ThreadingHTTPServer((args.bind, args.port), Handler)
    # The socket loop lives on a daemon thread; the MAIN thread below does every piece
    # of MLX work. Not an arbitrary split — see the module docstring for the measurement
    # that forced it.
    threading.Thread(target=server.serve_forever, daemon=True, name="http").start()
    log(f"listening on http://{args.bind}:{args.port}  (ctrl-c to stop and free the RAM)")

    try:
        while True:
            # Poll rather than block forever so ctrl-c is answered promptly: a bare
            # Queue.get() on the main thread swallows SIGINT until something arrives.
            try:
                job = JOB_QUEUE.get(timeout=0.5)
            except queue.Empty:
                continue
            try:
                job.result = run_chat(job.body)
            except Exception as exc:  # noqa: BLE001 - marshalled to the HTTP thread
                job.error = exc
            finally:
                job.done.set()
    except KeyboardInterrupt:
        log("stopping")
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
