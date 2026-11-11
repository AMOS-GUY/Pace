#!/usr/bin/env bash
# Fails fast when the selected Xcode's Swift is older than a Swift package the iOS build compiles.
#
# Why: Expo builds some of its pods (e.g. ExpoModulesJSI) through a nested SwiftPM `xcodebuild`.
# SwiftPM refuses a Package.swift whose `swift-tools-version` is newer than the toolchain, and
# the resulting error is buried deep in the build log. This check names the cause up front.
#
# Usage: scripts/ci/check-swift-toolchain.sh [repo-root]
set -euo pipefail
root="${1:-.}"

swift_line="$(xcrun swift --version 2>/dev/null || swift --version)"
installed="$(printf '%s\n' "$swift_line" | sed -nE 's/.*Swift version ([0-9]+(\.[0-9]+)*).*/\1/p' | head -n 1)"
if [[ -z "$installed" ]]; then
  echo "error: could not determine the Swift version from: $swift_line" >&2
  exit 1
fi

required="0"
required_by=""
while IFS= read -r manifest; do
  v="$(head -n 1 "$manifest" | sed -nE 's#^// *swift-tools-version: *([0-9]+(\.[0-9]+)*).*#\1#p')"
  [[ -z "$v" ]] && continue
  if [[ "$(printf '%s\n%s\n' "$required" "$v" | sort -V | tail -n 1)" == "$v" && "$v" != "$required" ]]; then
    required="$v"
    required_by="$manifest"
  fi
done < <(find "$root/node_modules" -maxdepth 4 -path '*/expo*/apple/Package.swift' 2>/dev/null; \
         find "$root/apps/mobile/modules" -name Package.swift -not -path '*/.build/*' 2>/dev/null)

echo "Selected Swift: $installed"
echo "Highest required swift-tools-version: $required${required_by:+ ($required_by)}"
if [[ "$(printf '%s\n%s\n' "$installed" "$required" | sort -V | head -n 1)" != "$required" ]]; then
  echo "error: Swift $installed is older than swift-tools-version $required required by $required_by." >&2
  echo "       Select a newer Xcode (sudo xcode-select -s /Applications/Xcode_<version>.app)." >&2
  exit 1
fi
