import CoreLocation
import Foundation
@testable import PaceTrackingCore

/// A Core Location stand-in: records what the recorder asks for and delivers synthetic fixes.
final class FakeLocationManager: LocationManaging {
  var authorization = "when_in_use"
  var onLocations: (([CLLocation]) -> Void)?
  var onAuthorizationChange: (() -> Void)?
  var onError: ((Error) -> Void)?

  private(set) var appliedPolicies: [RecorderPolicy] = []
  private(set) var updating = false
  private(set) var background = false
  private(set) var whenInUseRequests = 0
  private(set) var alwaysRequests = 0

  func apply(_ policy: RecorderPolicy) { appliedPolicies.append(policy) }
  func startUpdates(background: Bool) {
    updating = true
    self.background = background
  }
  func stopUpdates() {
    updating = false
    background = false
  }
  func requestWhenInUse() { whenInUseRequests += 1 }
  func requestAlways() { alwaysRequests += 1 }

  /// Delivers fixes only while updates are running, like Core Location.
  func deliver(_ locations: [CLLocation]) {
    guard updating else { return }
    onLocations?(locations)
  }
}

final class RecordingDelegate: LocationRecorderDelegate {
  var recorded: [(activityId: String, entries: [SampleJournal.Entry])] = []
  var acquired: [[[String: Any]]] = []
  var authorizations: [String] = []
  var failures: [String] = []
  /// Called synchronously when entries are reported — used to check journal-before-notify.
  var onRecord: ((String, [SampleJournal.Entry]) -> Void)?

  func recorder(_ recorder: LocationRecorder, didRecord entries: [SampleJournal.Entry], activityId: String) {
    onRecord?(activityId, entries)
    recorded.append((activityId, entries))
  }
  func recorder(_ recorder: LocationRecorder, didAcquire samples: [[String: Any]]) { acquired.append(samples) }
  func recorder(_ recorder: LocationRecorder, didChangeAuthorization status: String) { authorizations.append(status) }
  func recorder(_ recorder: LocationRecorder, didFail message: String) { failures.append(message) }
}

/// A fresh temporary directory per test.
func makeTempDirectory() throws -> URL {
  let url = FileManager.default.temporaryDirectory
    .appendingPathComponent("pace-tracking-tests-\(UUID().uuidString)", isDirectory: true)
  try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
  return url
}

/// A synthetic fix `index` seconds into a straight eastward run at 3 m/s.
func fix(_ index: Int, start: Date = Date(timeIntervalSince1970: 1_780_000_000)) -> CLLocation {
  let metersPerDegree = 111_195.0
  return CLLocation(
    coordinate: CLLocationCoordinate2D(latitude: 1.29, longitude: 103.85 + Double(index) * 3.0 / metersPerDegree),
    altitude: 10,
    horizontalAccuracy: 5,
    verticalAccuracy: 3,
    course: 90,
    courseAccuracy: 5,
    speed: 3,
    speedAccuracy: 0.5,
    timestamp: start.addingTimeInterval(TimeInterval(index)))
}

func sample(_ seq: Int) -> [String: Any] {
  ["latitude": 1.29, "longitude": 103.85, "horizontalAccuracyMeters": 5, "recordedAt": 1_780_000_000_000 + seq * 1000, "source": "device_gps"]
}

let runPolicy: [String: Any] = ["desiredAccuracy": "best", "distanceFilterMeters": 0, "iosActivityType": "fitness"]
