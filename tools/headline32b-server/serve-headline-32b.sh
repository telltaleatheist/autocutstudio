#!/bin/sh
# Launch the headline-32b title shim (see serve.py for what it is and why it exists).
#
# Run it as:
#
#     /bin/sh /Volumes/Callisto/Projects/AutoCutStudioApp/tools/headline32b-server/serve-headline-32b.sh
#
# Invoked through `/bin/sh` rather than executed directly on purpose: an external
# volume can be mounted in a way that refuses exec even on a file with +x, and the
# error you get ("Operation not permitted") looks nothing like the cause. Passing the
# script to the interpreter sidesteps the question entirely and works either way.
#
# It runs in the FOREGROUND and logs every request. Leave it in its own Terminal tab;
# ctrl-c stops it and gives the ~20 GB back. Nothing here daemonises, on purpose —
# a 20 GB resident process should be visible.
set -eu

PYTHON="/opt/homebrew/Caskroom/miniconda/base/envs/finetune/bin/python"
ADAPTER="${HEADLINE32B_ADAPTER:-$HOME/headline-32b-titles/adapter}"
PORT="${HEADLINE32B_PORT:-11435}"
HERE="$(cd "$(dirname "$0")" && pwd)"

# The env is not activated, it is addressed: calling the interpreter by absolute path
# gets its site-packages (mlx, mlx-lm, transformers) without depending on conda being
# initialised in whatever shell this was started from.
[ -x "$PYTHON" ] || { echo "FATAL: no python at $PYTHON (is the 'finetune' conda env still there?)" >&2; exit 2; }
[ -d "$ADAPTER" ] || { echo "FATAL: no adapter directory at $ADAPTER" >&2; exit 2; }

echo "python  : $PYTHON"
echo "adapter : $ADAPTER"
echo "port    : $PORT   (real Ollama keeps 11434 — this never touches it)"
echo

exec "$PYTHON" "$HERE/serve.py" --adapter "$ADAPTER" --port "$PORT"
