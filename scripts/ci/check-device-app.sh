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

# The module is linked statically into the main binary (static_framework in the podspec).
if nm -gU "$exe" 2>/dev/null | grep -q "PaceTrackingModule" ||
  strings -a "$exe" | grep -q "PaceTrackingModule"; then
  echo "PACE tracking module: present in the binary"
else
  fail "PaceTrackingModule was not found in the app binary"
fi
echo "device app checks passed"
