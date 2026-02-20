#!/bin/bash
# Test runner — invokes tree.test.cjs via sandbox-escape (needed for Playwright).
# Usage:
#   npm test                       runs all tests
#   npm test -- "gear icon"        runs tests matching "gear icon"
#
# INVARIANT: sandbox-escape returns HTTP 200 on exit 0, HTTP 500 on non-zero.
# Using curl -f maps this to a non-zero curl exit code, so `npm test` propagates
# test failures correctly.
#
# Progress is written to /tmp/oneplay-music-test.log so it can be monitored via
# `tail -f /tmp/oneplay-music-test.log` while sandbox-escape buffers stdout.
FILTER="${*:+\"$*\"}"
LOGFILE="/tmp/oneplay-music-test.log"
URL_PREFIX="${ONEPLAY_MUSIC_TEST_URL:+ONEPLAY_MUSIC_TEST_URL=\"$ONEPLAY_MUSIC_TEST_URL\" }"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEST_FILE="$APP_ROOT/test/integration/test-main.cjs"
CMD="${URL_PREFIX}NODE_PATH=/opt/homebrew/lib/node_modules node \"$TEST_FILE\" --log \"$LOGFILE\" $FILTER"
curl --unix-socket /tmp/sandbox-escape.sock -sS -f -X POST --data-raw "$CMD" http://localhost/bash
