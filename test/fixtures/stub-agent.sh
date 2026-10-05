#!/bin/bash
# Test double for the codex and agy CLIs. Records its argv and cwd, then writes
# a 1x1 PNG where the prompt asked for it.
#   STUB_ARGS_FILE  where to append "cwd=<dir>" and one line per argument
#   STUB_MODE       codex (prompt on stdin, absolute path) | agy (--prompt, ./generated.png)
#   STUB_EXIT       exit code (default 0)
#   STUB_NO_FILE    if set, write nothing
#   STUB_SLEEP      seconds to sleep before acting
[ -n "$STUB_SLEEP" ] && sleep "$STUB_SLEEP"
{ echo "cwd=$(pwd -P)"; for a in "$@"; do echo "$a"; done; } >> "${STUB_ARGS_FILE:-/dev/null}"
PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
if [ "$STUB_MODE" = "codex" ]; then
  prompt="$(cat)"
  echo "$prompt" > "${STUB_ARGS_FILE:-/dev/null}.prompt"
  target="$(printf '%s\n' "$prompt" | sed -n 's/^Save the selected image as a PNG exactly to: //p' | head -1)"
else
  target="generated.png"
  for a in "$@"; do last="$a"; done
  echo "$last" > "${STUB_ARGS_FILE:-/dev/null}.prompt"
fi
[ -z "$STUB_NO_FILE" ] && printf '%s' "$PNG" | base64 -D > "$target"
exit "${STUB_EXIT:-0}"
