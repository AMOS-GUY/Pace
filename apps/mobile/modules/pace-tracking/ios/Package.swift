// swift-tools-version:5.9
// Swift package for unit-testing the platform-neutral recorder core on macOS:
//   cd apps/mobile/modules/pace-tracking/ios && swift test
// The app itself builds these files through PaceTracking.podspec.
import PackageDescription

let package = Package(
  name: "PaceTrackingCore",
  platforms: [.iOS(.v16), .macOS(.v13)],
  products: [.library(name: "PaceTrackingCore", targets: ["PaceTrackingCore"])],
  targets: [
    .target(name: "PaceTrackingCore", path: "Core"),
    .testTarget(name: "PaceTrackingCoreTests", dependencies: ["PaceTrackingCore"], path: "Tests/PaceTrackingCoreTests"),
  ]
)
