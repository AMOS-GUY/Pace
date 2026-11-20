#!/usr/bin/env bash
# Checks an iOS app built for a physical device (iphoneos), without signing it.
#
# Usage: scripts/ci/check-device-app.sh <path/to/App.app> <expected-bundle-id> <expected-min-ios>
#
# Fails with a precise message unless:
#   1. the main binary is an arm64 device binary (not a simulator build);
#   2. the bundle id and the minimum iOS version are the expected ones;
#   3. background location is declared (UIBackgroundModes contains "location");
#   4. both location permission texts are present and not empty;
#   5. the PACE tracking module is compiled into the app.
# It prints the facts it checked, so the job log documents the build.
set -euo pipefail

APP="${1:?app path required}"
EXPECTED_ID="${2:?expected bundle id required}"
EXPECTED_MIN="${3:?expected minimum iOS version required}"
plistbuddy="${PLISTBUDDY:-/usr/libexec/PlistBuddy}"

fail() {
  echo "error: $*" >&2
  exit 1
}

[[ -d "$APP" ]] || fail "app bundle not found: $APP"
plist="$APP/Info.plist"
get() { "$plistbuddy" -c "Print :$1" "$plist" 2>/dev/null || true; }

exe="$APP/$(get CFBundleExecutable)"
[[ -f "$exe" ]] || fail "main binary not found: $exe"
archs="$(lipo -archs "$exe")"
echo "binary: $(basename "$exe") ($archs)"
[[ " $archs " == *" arm64 "* ]] || fail "binary is not arm64: $archs"
# A device build records the iphoneos platform; a simulator build would record iphonesimulator.
platform="$(get DTPlatformName)"
echo "platform: $platform (SDK $(get DTSDKName), Xcode $(get DTXcode))"
[[ "$platform" == "iphoneos" ]] || fail "not a device build: DTPlatformName is '$platform'"

id="$(get CFBundleIdentifier)"
echo "bundle id: $id"
[[ "$id" == "$EXPECTED_ID" ]] || fail "bundle id is '$id', expected '$EXPECTED_ID'"
min="$(get MinimumOSVersion)"
echo "minimum iOS: $min"
[[ "$min" == "$EXPECTED_MIN" ]] || fail "minimum iOS is '$min', expected '$EXPECTED_MIN'"

modes="$(get UIBackgroundModes)"
echo "background modes: $(echo "$modes" | tr -d '\n' | tr -s ' ')"
grep -qx '[[:space:]]*location' <<<"$modes" || fail "UIBackgroundModes does not contain location"
for key in NSLocationWhenInUseUsageDescription NSLocationAlwaysAndWhenInUseUsageDescription; do
  text="$(get "$key")"
  [[ -n "$text" ]] || fail "$key is missing or empty"
  echo "$key: present (${#text} characters)"
done

# The module is linked statically. In a Debug build (Xcode 15+), the app's code lives in
# <App>.debug.dylib next to a small stub executable, so both are searched. Tool output goes to a
# file first: piping into `grep -q` kills the producer with SIGPIPE under `pipefail` and turns a
# match into "not found" (see ios-simulator-launch.sh).
scan="$(mktemp)"
found=""
for bin in "$exe" "$APP"/*.debug.dylib; do
  [[ -f "$bin" ]] || continue
  { strings -a "$bin"; nm "$bin" 2>/dev/null; } > "$scan" || true
  if grep -qE 'PaceTrackingModule|12PaceTracking.*ModuleC' "$scan"; then
    found="$(basename "$bin")"
    break
  fi
done
rm -f "$scan"
[[ -n "$found" ]] || fail "PaceTrackingModule was not found in the app binary or its debug dylib"
echo "PACE tracking module: present in $found"
echo "device app checks passed"
