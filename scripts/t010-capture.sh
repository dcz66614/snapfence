#!/usr/bin/env bash
# P030-T010 — real-browser capture + interaction evidence.
#
# Serves the production build (04_source/source/dist) on 127.0.0.1:4174 and
# captures real screenshots with the Playwright-managed Google Chrome for
# Testing 159 (no system browser exists on this VM; T001 ENVIRONMENT.md),
# driven over CDP by scripts/t010-capture.mjs with real-time waits for the
# rendered verdict. Everything is appended to
# 00_control/T010_INTERACTION.log. Exit 0 only when every screenshot and
# every DOM check succeeds.
#
# This script proves the REAL Web Worker path in the browser: the App shell
# (src/app/App.tsx) obtains every result exclusively through
# SnapFenceWorkerClient, so a verdict rendered from ?scenario=&run=1 can
# only appear if the Worker (dist/assets/snapfence.worker-*.js) loaded and
# answered. It also re-captures U01/U02 at 1280x1400 for the V-01 chip
# fix visual check.
#
# Usage (from the repo root):
#   bash 04_source/source/scripts/t010-capture.sh
set -u
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SRC="$ROOT/04_source/source"
SHOTS="$ROOT/07_evidence/screenshots"
LOG="$ROOT/00_control/T010_INTERACTION.log"
PORT=4174

mkdir -p "$SHOTS"
: > "$LOG"
log() { echo "$1" | tee -a "$LOG"; }

log "P030-T010 browser capture + Worker interaction evidence — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
log "Chrome: $HOME/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome"
"$HOME/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome" --version 2>&1 | tee -a "$LOG"
log "Build: npm run build (tsc --noEmit && vite build)"
(cd "$SRC" && npm run build >> "$LOG" 2>&1) || { log "BUILD FAILED"; exit 1; }
log "Build OK."
log "Worker chunk:"
ls -l "$SRC"/dist/assets/snapfence.worker-*.js | tee -a "$LOG" || { log "WORKER CHUNK MISSING"; exit 1; }

cd "$SRC" || exit 1
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory dist >> "$LOG" 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT
for _ in 1 2 3 4 5 6 7 8 9 10; do
  curl -fsS "http://127.0.0.1:$PORT/index.html" -o /dev/null 2>/dev/null && break
  sleep 0.5
done

# Real-browser capture via CDP (scripts/t010-capture.mjs): screenshots +
# DOM checks with real-time waits for the rendered verdict. (Do NOT use
# --virtual-time-budget here: under virtual time the 5000 ms client
# timeout can fire before the Worker thread answers in real time — the
# first run of this script showed exactly that: U01 passed, U07/U02/G12
# timed out. The Worker itself is fine; the wait was wrong.)
log "Capture: node scripts/t010-capture.mjs (CDP, real-time waits)"
node scripts/t010-capture.mjs "$PORT" "$SHOTS" "$LOG" 2>&1 | tee -a "$LOG"
code=${PIPESTATUS[0]}
if [ $code -ne 0 ]; then log "CAPTURE RESULT: FAILED"; exit 1; fi

log "Screenshot files:"
ls -l "$SHOTS"/t010-*.png | tee -a "$LOG"
log "PNG headers:"
for f in "$SHOTS"/t010-*.png; do file "$f" | tee -a "$LOG"; done

kill $SERVER_PID 2>/dev/null
trap - EXIT
# (The "CAPTURE RESULT: OK" line above already comes from t010-capture.mjs
# via the tee; no second copy is logged here.)
