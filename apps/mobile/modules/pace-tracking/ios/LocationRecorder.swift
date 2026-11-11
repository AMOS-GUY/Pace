import CoreLocation
import Foundation

/// Recording configuration derived from the shared TypeScript `GpsPolicy`.
struct RecorderPolicy {
  let desiredAccuracy: CLLocationAccuracy
  let distanceFilter: CLLocationDistance
  let activityType: CLActivityType

  init(_ dict: [String: Any]) {
    switch dict["desiredAccuracy"] as? String {
    case "best_for_navigation": desiredAccuracy = kCLLocationAccuracyBestForNavigation
    case "ten_meters": desiredAccuracy = kCLLocationAccuracyNearestTenMeters
    default: desiredAccuracy = kCLLocationAccuracyBest
    }
    let filter = dict["distanceFilterMeters"] as? Double ?? 0
    distanceFilter = filter > 0 ? filter : kCLDistanceFilterNone
    switch dict["iosActivityType"] as? String {
    case "other_navigation": activityType = .otherNavigation
    case "automotive_navigation": activityType = .automotiveNavigation
    case "other": activityType = .other
    default: activityType = .fitness
    }
  }
}

protocol LocationRecorderDelegate: AnyObject {
  func recorder(_ recorder: LocationRecorder, didRecord entries: [SampleJournal.Entry], activityId: String)
  func recorder(_ recorder: LocationRecorder, didAcquire samples: [[String: Any]])
  func recorder(_ recorder: LocationRecorder, didChangeAuthorization status: String)
  func recorder(_ recorder: LocationRecorder, didFail message: String)
}

/// Owns CLLocationManager for both GPS acquisition (pre-start, foreground only) and journaled
/// recording (background capable). All CLLocationManager access happens on the main thread.
final class LocationRecorder: NSObject, CLLocationManagerDelegate {
  weak var delegate: LocationRecorderDelegate?

  private let manager = CLLocationManager()
  private var journal: SampleJournal?
  private(set) var recordingActivityId: String?
  private var acquiring = false
  private var authorizationContinuations: [(String) -> Void] = []
  private var backgroundSession: AnyObject?

  private static let activeKey = "app.pace.tracking.active"
  private static let policyKey = "app.pace.tracking.policy"

  override init() {
    super.init()
    manager.delegate = self
    manager.pausesLocationUpdatesAutomatically = false
  }

  // MARK: - Authorization

  var authorizationString: String {
    switch manager.authorizationStatus {
    case .notDetermined: return "undetermined"
    case .restricted: return "restricted"
    case .denied: return "denied"
    case .authorizedAlways: return "always"
    case .authorizedWhenInUse: return "when_in_use"
    @unknown default: return "undetermined"
    }
  }

  func requestAuthorization(level: String, completion: @escaping (String) -> Void) {
    let status = manager.authorizationStatus
    if level == "always" && status == .authorizedWhenInUse {
      authorizationContinuations.append(completion)
      manager.requestAlwaysAuthorization()
    } else if status == .notDetermined {
      authorizationContinuations.append(completion)
      manager.requestWhenInUseAuthorization()
    } else {
      completion(authorizationString)
    }
  }

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    let status = authorizationString
    let pending = authorizationContinuations
    authorizationContinuations.removeAll()
    pending.forEach { $0(status) }
    delegate?.recorder(self, didChangeAuthorization: status)
  }

  // MARK: - Acquisition

  func startAcquisition(policy: RecorderPolicy) {
    apply(policy)
    acquiring = true
    manager.startUpdatingLocation()
  }

  func stopAcquisition() {
    acquiring = false
    if recordingActivityId == nil { manager.stopUpdatingLocation() }
  }

  // MARK: - Recording

  func startRecording(activityId: String, policyDict: [String: Any]) throws {
    if recordingActivityId == activityId { return }
    if recordingActivityId != nil { stopRecording() }
    journal = try SampleJournal(activityId: activityId)
    recordingActivityId = activityId
    UserDefaults.standard.set(activityId, forKey: Self.activeKey)
    if let data = try? JSONSerialization.data(withJSONObject: policyDict) {
      UserDefaults.standard.set(data, forKey: Self.policyKey)
    }
    apply(RecorderPolicy(policyDict))
    manager.allowsBackgroundLocationUpdates = true
    manager.showsBackgroundLocationIndicator = true
    if #available(iOS 17.0, *) {
      // Keeps the app eligible for background location with "When In Use" authorization.
      backgroundSession = CLBackgroundActivitySession()
    }
    manager.startUpdatingLocation()
  }

  func updatePolicy(_ policy: RecorderPolicy?) {
    if let policy {
      apply(policy)
      manager.startUpdatingLocation()
    } else {
      // Leg without GPS (e.g. transition): stop updates but keep the journal open.
      manager.stopUpdatingLocation()
    }
  }

  func stopRecording() {
    manager.stopUpdatingLocation()
    manager.allowsBackgroundLocationUpdates = false
    if #available(iOS 17.0, *) {
      (backgroundSession as? CLBackgroundActivitySession)?.invalidate()
    }
    backgroundSession = nil
    journal?.close()
    journal = nil
    recordingActivityId = nil
    UserDefaults.standard.removeObject(forKey: Self.activeKey)
    UserDefaults.standard.removeObject(forKey: Self.policyKey)
    if acquiring { manager.startUpdatingLocation() }
  }

  /// After a relaunch, resume journaling for an activity that native was recording.
  func restoreIfNeeded() {
    guard recordingActivityId == nil,
          let id = UserDefaults.standard.string(forKey: Self.activeKey) else { return }
    var policy: [String: Any] = [:]
    if let data = UserDefaults.standard.data(forKey: Self.policyKey),
       let stored = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
      policy = stored
    }
    do {
      try startRecording(activityId: id, policyDict: policy)
    } catch {
      delegate?.recorder(self, didFail: "Could not reopen journal: \(error.localizedDescription)")
    }
  }

  func readJournal(activityId: String, from sequence: Int) throws -> [SampleJournal.Entry] {
    if activityId == recordingActivityId, let journal { return try journal.read(from: sequence) }
    // Recording already stopped: read the file directly (it is kept until acknowledged).
    let j = try SampleJournal(activityId: activityId)
    defer { j.close() }
    return try j.read(from: sequence)
  }

  func acknowledge(activityId: String, through sequence: Int) throws {
    if activityId == recordingActivityId, let journal {
      try journal.acknowledge(through: sequence)
    }
  }

  func deleteJournal(activityId: String) {
    guard activityId != recordingActivityId, let j = try? SampleJournal(activityId: activityId) else { return }
    j.delete()
  }

  private func apply(_ policy: RecorderPolicy) {
    manager.desiredAccuracy = policy.desiredAccuracy
    manager.distanceFilter = policy.distanceFilter
    manager.activityType = policy.activityType
  }

  // MARK: - CLLocationManagerDelegate

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    let samples = locations.map(Self.serialize)
    if let id = recordingActivityId, let journal {
      do {
        let entries = try journal.append(samples)
        delegate?.recorder(self, didRecord: entries, activityId: id)
      } catch {
        delegate?.recorder(self, didFail: "Failed to persist location samples: \(error.localizedDescription)")
      }
    } else if acquiring {
      delegate?.recorder(self, didAcquire: samples)
    }
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    if let clError = error as? CLError, clError.code == .locationUnknown { return } // transient
    delegate?.recorder(self, didFail: error.localizedDescription)
  }

  /// Converts a CLLocation into the shared `LocationSample` shape. Invalid components
  /// (negative accuracy/speed/course) become null; nothing is fabricated.
  static func serialize(_ l: CLLocation) -> [String: Any] {
    var s: [String: Any] = [
      "latitude": l.coordinate.latitude,
      "longitude": l.coordinate.longitude,
      "horizontalAccuracyMeters": l.horizontalAccuracy,
      "recordedAt": Int64((l.timestamp.timeIntervalSince1970 * 1000).rounded()),
      "source": "device_gps",
    ]
    s["altitudeMeters"] = l.verticalAccuracy >= 0 ? l.altitude : NSNull()
    s["verticalAccuracyMeters"] = l.verticalAccuracy >= 0 ? l.verticalAccuracy : NSNull()
    s["speedMps"] = l.speed >= 0 && l.speedAccuracy >= 0 ? l.speed : NSNull()
    s["courseDegrees"] = l.course >= 0 ? l.course : NSNull()
    return s
  }
}
