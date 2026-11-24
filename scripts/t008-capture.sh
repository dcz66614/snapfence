#!/usr/bin/env bash
# P030-T008 — automated screenshot + interaction evidence capture.
#
# Serves the production build (04_source/source/dist) on 127.0.0.1:4173 and
# captures real screenshots with the Playwright-managed Google Chrome for
# Testing 159 (no system browser exists on this VM; T001 ENVIRONMENT.md).
# Also dumps the rendered DOM for each URL and greps it for the markers the
# acceptance criteria require, so the interaction log records machine
# checks, not eyeballing. Everything is appended to
# 00_control/T008_INTERACTION.log. Exit 0 only when every screenshot and
# every DOM check succeeds.
#
# Usage (from the repo root):
#   bash 04_source/source/scripts/t008-capture.sh
set -u
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SRC="$ROOT/04_source/source"
SHOTS="$ROOT/07_evidence/screenshots"
LOG="$ROOT/00_control/T008_INTERACTION.log"
CHROME="$HOME/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome"
PORT=4173

mkdir -p "$SHOTS"
: > "$LOG"
log() { echo "$1" | tee -a "$LOG"; }
fail=0

log "P030-T008 interaction + screenshot capture — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
log "Chrome: $CHROME"
"$CHROME" --version 2>&1 | tee -a "$LOG"
log "Build: npm run build (tsc --noEmit && vite build)"
(cd "$SRC" && npm run build >> "$LOG" 2>&1) || { log "BUILD FAILED"; exit 1; }
log "Build OK."

cd "$SRC" || exit 1
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory dist >> "$LOG" 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT
for _ in 1 2 3 4 5 6 7 8 9 10; do
  curl -fsS "http://127.0.0.1:$PORT/index.html" -o /dev/null 2>/dev/null && break
  sleep 0.5
done

shot() { # $1 = file, $2 = url
  log "Screenshot: $2 -> $1"
  "$CHROME" --headless --no-sandbox --disable-gpu --hide-scrollbars \
    --window-size=1280,1400 --virtual-time-budget=8000 \
    --screenshot="$SHOTS/$1" "$2" >> "$LOG" 2>&1
  code=$?
  log "  chrome exit: $code"
  if [ $code -ne 0 ] || [ ! -s "$SHOTS/$1" ]; then log "  FAILED"; fail=1; fi
}

domcheck() { # $1 = label, $2 = url, $3... = grep patterns (all must match)
  local label="$1" url="$2"; shift 2
  log "DOM check: $label — $url"
  local dom_file
  dom_file="$(mktemp)"
  "$CHROME" --headless --no-sandbox --disable-gpu --virtual-time-budget=8000 \
    --dump-dom "$url" > "$dom_file" 2>> "$LOG"
  for pattern in "$@"; do
    if grep -q -- "$pattern" "$dom_file"; then
      log "  OK: contains '$pattern'"
    else
      log "  MISSING: '$pattern'"
      fail=1
    fi
  done
  rm -f "$dom_file"
}

BASE="http://127.0.0.1:$PORT"
shot "t008-main-ui.png"              "$BASE/"
shot "t008-scenario-a-u01-orphan.png" "$BASE/?scenario=U01&run=1"
shot "t008-scenario-b-u07.png"       "$BASE/?scenario=U07&run=1"
shot "t008-delete-cross-snapshot-u02.png" "$BASE/?scenario=U02&run=1"
shot "t008-safe-g12.png"            "$BASE/?scenario=G12&run=1"

domcheck "main UI (no run)" "$BASE/" \
  "运行模型检查" "合成场景" "备份策略" "刷新页面可清空当前状态"
domcheck "scenario A U01 (orphan)" "$BASE/?scenario=U01&run=1" \
  "UNSAFE_WITHIN_BOUND" "ORPHAN_BLOB" "孤立对象" "数据库快照" "Blob 快照" \
  "最短反例路径" "upload-A:BLOB_PUT" "第 0 / 3 步"
domcheck "scenario B U07" "$BASE/?scenario=U07&run=1" \
  "UNSAFE_WITHIN_BOUND" "ORPHAN_BLOB" "upload-B:BLOB_PUT"
domcheck "delete cross-snapshot U02" "$BASE/?scenario=U02&run=1" \
  "UNSAFE_WITHIN_BOUND" "delete-C:DB_UNLINK" "最短反例路径"
domcheck "safe G12" "$BASE/?scenario=G12&run=1" \
  "SAFE_WITHIN_BOUND" "完整事件顺序" "无诊断"

log "Screenshot files:"
ls -l "$SHOTS"/t008-*.png | tee -a "$LOG"
log "PNG headers:"
for f in "$SHOTS"/t008-*.png; do file "$f" | tee -a "$LOG"; done

kill $SERVER_PID 2>/dev/null
trap - EXIT
if [ $fail -ne 0 ]; then log "CAPTURE RESULT: FAILED"; exit 1; fi
log "CAPTURE RESULT: OK"
