#!/usr/bin/env bash
# codex-delegate.sh — non-interactive OpenAI Codex (gpt-5.5) wrapper for cross-model review / implementation.
#
# Verified working (2026-06-20, codex-cli 0.141.0, auth=ChatGPT, model gpt-5.5 @ xhigh):
#   codex exec --skip-git-repo-check -c approval_policy=never -c sandbox_mode=read-only -m gpt-5.5 "<prompt>" < /dev/null
#
# Usage:
#   codex-delegate.sh --mode review    --prompt-file P.md  [--cwd DIR] [--model gpt-5.5] [--timeout 600] [--out OUT]
#   codex-delegate.sh --mode implement --prompt "..."      [--cwd DIR] ...
#   echo "prompt" | codex-delegate.sh --mode review        [--cwd DIR] ...
#
# Modes:  review = read-only sandbox (NEVER writes).  implement = workspace-write (edits files under --cwd).
# Safety: approval_policy=never (never prompts), --skip-git-repo-check, stdin closed (no hang), hard timeout.
# Sentinels: prints CODEX_NOT_INSTALLED / CODEX_TIMEOUT to stderr; exit 127 if missing, 124 on timeout.
set -uo pipefail

MODE=review; PROMPT=""; PROMPT_FILE=""; MODEL=gpt-5.5; CWD="."; TIMEOUT=600; OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="$2"; shift 2;;
    --prompt) PROMPT="$2"; shift 2;;
    --prompt-file) PROMPT_FILE="$2"; shift 2;;
    --model) MODEL="$2"; shift 2;;
    --cwd) CWD="$2"; shift 2;;
    --timeout) TIMEOUT="$2"; shift 2;;
    --out) OUT="$2"; shift 2;;
    -h|--help) grep '^#' "$0" | sed 's/^#\s\?//'; exit 0;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

if ! command -v codex >/dev/null 2>&1; then
  echo "CODEX_NOT_INSTALLED" >&2
  echo "Install: npm install -g @openai/codex ; then 'codex login' (ChatGPT) or pipe an API key to 'codex login --with-api-key'." >&2
  exit 127
fi

[ -n "$PROMPT_FILE" ] && PROMPT="$(cat "$PROMPT_FILE")"
[ -z "$PROMPT" ] && PROMPT="$(cat)"   # fall back to stdin
if [ -z "$PROMPT" ]; then echo "empty prompt" >&2; exit 2; fi

case "$MODE" in
  review)    SANDBOX=read-only;;
  implement) SANDBOX=workspace-write;;
  *) echo "bad --mode: $MODE (review|implement)" >&2; exit 2;;
esac

# stdin closed (< /dev/null) so codex never blocks waiting for piped input.
( cd "$CWD" && timeout "$TIMEOUT" codex exec \
    --skip-git-repo-check \
    -c approval_policy=never \
    -c sandbox_mode="$SANDBOX" \
    -m "$MODEL" \
    "$PROMPT" < /dev/null ) | { [ -n "$OUT" ] && tee "$OUT" || cat; }
rc="${PIPESTATUS[0]}"
[ "$rc" = "124" ] && echo "CODEX_TIMEOUT after ${TIMEOUT}s" >&2
exit "$rc"
