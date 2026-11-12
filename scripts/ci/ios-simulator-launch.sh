#!/usr/bin/env bash
# Launches a built iOS app on a simulator and verifies it is still running after a delay.
#
# Usage: scripts/ci/ios-simulator-launch.sh <path/to/App.app> <expected-bundle-id> <out-dir> [wait-seconds]
#
# Checks, each failing with a non-zero exit and a precise message:
#   1. the bundle id is the expected one;
#   2. the JS bundle is embedded (Release build: the app must not depend on a Metro server);
#   3. the PACE tracking module's class is present in the app binary;
#   4. after launch, the process is alive after <wait-seconds>;
#   5. no crash report for the app appeared;
#   6. the device log has no fatal native/JS error.
# Artifacts written to <out-dir>: device.log, screenshot, any crash reports, simulator.txt.
# On success the simulator stays booted (for the Maestro step) and its UDID is printed last.
set -euo pipefail

APP="${1:?app path required}"
EXPECTED_ID="${2:?expected bundle id required}"
OUT="${3:?output dir required}"
WAIT="${4:-30}"
mkdir -p "$OUT"

fail() {
  echo "error: $*" >&2
  exit 1
}

[[ -d "$APP" ]] || fail "app bundle not found: $APP"
plist="$APP/Info.plist"
plistbuddy="${PLISTBUDDY:-/usr/libexec/PlistBuddy}"
bundle_id="$("$plistbuddy" -c 'Print :CFBundleIdentifier' "$plist")"
executable="$("$plistbuddy" -c 'Print :CFBundleExecutable' "$plist")"
[[ "$bundle_id" == "$EXPECTED_ID" ]] || fail "bundle id is '$bundle_id', expected '$EXPECTED_ID'"
echo "ok: bundle id $bundle_id (executable $executable)"

[[ -s "$APP/main.jsbundle" ]] || fail "no embedded main.jsbundle: this is not a standalone (Release) build"
echo "ok: embedded JS bundle ($(wc -c < "$APP/main.jsbundle" | tr -d ' ') bytes)"

# Swift type descriptors keep the plain class name (needed by the generated modules provider);
# the mangled class symbol is accepted as well.
if ! strings -a "$APP/$executable" | grep -qx 'PaceTrackingModule' &&
  ! nm "$APP/$executable" 2>/dev/null | grep -qE '12PaceTracking.*ModuleC'; then
  fail "PaceTrackingModule is not present in $executable: the native tracking module was not linked"
fi
echo "ok: PaceTrackingModule present in the app binary"

# Newest iOS runtime, first available iPhone in it.
udid="$(xcrun simctl list devices available -j | python3 -c '
import json, sys
devices = json.load(sys.stdin)["devices"]
candidates = [(runtime, d) for runtime, items in devices.items() if ".iOS-" in runtime
              for d in items if d["name"].startswith("iPhone")]
if not candidates:
    sys.exit("no available iPhone simulator")
candidates.sort(key=lambda c: [int(p) for p in c[0].rsplit(".iOS-", 1)[1].split("-")])
runtime, device = candidates[-1]
print(device["udid"])
print(device["name"], runtime, file=sys.stderr)
' 2> "$OUT/simulator.txt")"
echo "simulator: $(cat "$OUT/simulator.txt") ($udid)"

xcrun simctl boot "$udid" 2>/dev/null || true # already booted is fine
xcrun simctl bootstatus "$udid" -b
xcrun simctl install "$udid" "$APP"

marker="$(mktemp)"
xcrun simctl spawn "$udid" log stream --style compact --level debug \
  --predicate "process == \"$executable\"" > "$OUT/device.log" 2>&1 &
log_pid=$!
trap 'kill "$log_pid" 2>/dev/null || true' EXIT
sleep 2

launch_out="$(xcrun simctl launch "$udid" "$bundle_id")"
pid="${launch_out##*: }"
[[ "$pid" =~ ^[0-9]+$ ]] || fail "could not read the app pid from: $launch_out"
echo "launched pid $pid; waiting ${WAIT}s"
sleep "$WAIT"

xcrun simctl io "$udid" screenshot "$OUT/after-${WAIT}s.png" >/dev/null 2>&1 || echo "warning: screenshot failed"

crashes="$(find "$HOME/Library/Logs/DiagnosticReports" -newer "$marker" -name "*${executable}*" 2>/dev/null || true)"
if [[ -n "$crashes" ]]; then
  while IFS= read -r f; do cp "$f" "$OUT/"; done <<< "$crashes"
  fail "crash report(s) written after launch: $(echo "$crashes" | tr '\n' ' ')"
fi
echo "ok: no crash reports"

ps -p "$pid" > /dev/null || fail "app process $pid is no longer running ${WAIT}s after launch"
echo "ok: app process $pid still running after ${WAIT}s"

if grep -nE "RCTFatal|Unhandled JS Exception|Terminating app due to uncaught exception|Fatal error:" "$OUT/device.log"; then
  fail "fatal error in the device log (see device.log)"
fi
echo "ok: no fatal errors in the device log ($(wc -l < "$OUT/device.log" | tr -d ' ') lines)"
echo "launch check passed on simulator $udid"
