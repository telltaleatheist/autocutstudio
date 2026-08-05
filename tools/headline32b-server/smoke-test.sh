#!/bin/sh
# Smoke-test the headline-32b shim with a request body byte-identical in SHAPE to what
# electron/services/ollama-service.ts `chat()` sends for one title call: the same two
# messages title-generator.ts builds, `stream:false`, `think:false`, and the SAMPLING
# object (temperature 0.9 / top_p 0.95 / top_k 0 / num_predict 64) with the num_ctx the
# service computes for a prompt this size.
#
# Run it as:
#
#     /bin/sh /Volumes/Callisto/Projects/AutoCutStudioApp/tools/headline32b-server/smoke-test.sh
#
# Run it twice: the two titles should DIFFER. Identical output across runs means the
# sampler is not sampling — see the "GENERATION RUNS ON THE MAIN THREAD" section of
# serve.py for the MLX threading trap that causes exactly that.
set -eu
PORT="${HEADLINE32B_PORT:-11435}"

echo "--- GET /api/tags ---"
curl -sS "http://127.0.0.1:${PORT}/api/tags"
echo
echo "--- POST /api/chat ---"
curl -sS -X POST "http://127.0.0.1:${PORT}/api/chat" \
  -H "Content-Type: application/json" \
  --data-binary @- <<'JSON'
{"model":"headline-32b-titles","messages":[{"role":"system","content":"You write YouTube titles for independent commentary channels covering religion, politics and the far right - the atheist, ex-religious, skeptic and left-of-centre corner of YouTube. Given a description of a video, write one title. Name names; plain concrete language, no corporate phrasing; be the prosecutor, not the journalist - state what happened and why it matters, don't hedge. Specificity plus an open loop beats vague drama. This is a standard upload: the hook lands inside the first 45 characters and the whole title runs 45-70 characters, covering one story."},{"role":"user","content":"task: title\nformat: normal\ntarget: top-decile\n\nVideo:\n- Ken Ham announces a new Ark Encounter expansion after attendance drops\n- Louisiana school board votes to put chaplains in every public school\n- Turning Point USA speaker caught fabricating a hate-crime story\n- Listener questions about deconstructing in a small town"}],"stream":false,"think":false,"options":{"temperature":0.9,"num_ctx":4096,"num_predict":64,"top_p":0.95,"top_k":0}}
JSON
echo
echo "--- POST /api/chat with a model this process does not serve (must be a loud 404) ---"
curl -sS -o /dev/stdout -w " [HTTP %{http_code}]\n" -X POST "http://127.0.0.1:${PORT}/api/chat" \
  -H "Content-Type: application/json" \
  --data-binary '{"model":"headline-14b-titles","messages":[{"role":"user","content":"hi"}],"stream":false,"think":false,"options":{"temperature":0.9,"num_predict":8}}'
echo "--- POST /api/generate, the keep_alive:0 eviction ollamaService.unload() sends ---"
curl -sS -o /dev/stdout -w " [HTTP %{http_code}]\n" -X POST "http://127.0.0.1:${PORT}/api/generate" \
  -H "Content-Type: application/json" \
  --data-binary '{"model":"headline-32b-titles","prompt":"","keep_alive":0}'
echo "--- real Ollama on 11434 must be untouched ---"
curl -sS -o /dev/null -w "11434 /api/tags [HTTP %{http_code}]\n" http://127.0.0.1:11434/api/tags
