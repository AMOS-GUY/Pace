import CoreLocation
import Foundation

/// The subset of Core Location the recorder needs. Production uses `SystemLocationManager`
/// (a `CLLocationManager` wrapper); unit tests use a fake that delivers synthetic fixes.
protocol LocationManaging: AnyObject {
  /// "undetermined" | "denied" | "restricted" | "when_in_use" | "always"
  var authorization: String { get }
  var onLocations: (([CLLocation]) -> Void)? { get set }
  var onAuthorizationChange: (() -> Void)? { get set }
  var onError: ((Error) -> Void)? { get set }
  func apply(_ policy: RecorderPolicy)
  /// Start or stop delivering fixes. `background` enables background updates, the location
  /// indicator and (iOS 17+) a background activity session.
  func startUpdates(background: Bool)
  func stopUpdates()
  func requestWhenInUse()
  func requestAlways()
}

protocol LocationRecorderDelegate: AnyObject {
  func recorder(_ recorder: LocationRecorder, didRecord entries: [SampleJournal.Entry], activityId: String)
  func recorder(_ recorder: LocationRecorder, didAcquire samples: [[String: Any]])
  func recorder(_ recorder: LocationRecorder, didChangeAuthorization status: String)
  func recorder(_ recorder: LocationRecorder, didFail message: String)
}

/// Owns location capture for GPS acquisition (pre-start, foreground, not journaled) and for
/// journaled recording (background capable).
///
/// Lifetime: one instance per *process* (see `PaceTrackingModule`). Reloading the JavaScript
/// runtime recreates the Expo module but not the recorder, so a reload never stops a recording.
/// After the process dies, nothing is restarted automatically: JavaScript recovers the activity
/// as INTERRUPTED and the athlete decides whether to resume.
///
/// Threading: all methods must be called on the main thread (Core Location delivers callbacks on
/// the thread that created the manager). The journal does its file I/O on its own serial queue.
final class LocationRecorder {
  weak var delegate: LocationRecorderDelegate?

  private let manager: LocationManaging
  private let journalDirectory: URL
  private let compactionThreshold: Int
  private var journal: SampleJournal?
  private(set) var recordingActivityId: String?
  private(set) var acquiring = false
  /// Whether location updates are currently requested (recording leg with GPS, or acquisition).
  private(set) var updating = false
  private var authorizationContinuations: [(String) -> Void] = []

  init(manager: LocationManaging, journalDirectory: URL, compactionThreshold: Int = 500) {
    self.manager = manager
    self.journalDirectory = journalDirectory
    self.compactionThreshold = compactionThreshold
    manager.onLocations = { [weak self] in self?.handle(locations: $0) }
    manager.onAuthorizationChange = { [weak self] in self?.authorizationChanged() }
    manager.onError = { [weak self] in self?.handle(error: $0) }
  }

  // MARK: - Authorization

  var authorizationString: String { manager.authorization }

  func requestAuthorization(level: String, completion: @escaping (String) -> Void) {
    let status = manager.authorization
    if level == "always" && status == "when_in_use" {
      authorizationContinuations.append(completion)
      manager.requestAlways()
    } else if status == "undetermined" {
      authorizationContinuations.append(completion)
      manager.requestWhenInUse()
    } else {
      completion(status)
    }
  }

  private func authorizationChanged() {
    let status = manager.authorization
    let pending = authorizationContinuations
    authorizationContinuations.removeAll()
    pending.forEach { $0(status) }
    delegate?.recorder(self, didChangeAuthorization: status)
  }

  // MARK: - Acquisition

  func startAcquisition(policy: RecorderPolicy) {
    acquiring = true
    if recordingActivityId == nil {
      manager.apply(policy)
      manager.startUpdates(background: false)
      updating = true
    }
  }

  func stopAcquisition() {
    acquiring = false
    if recordingActivityId == nil && updating {
      manager.stopUpdates()
      updating = false
    }
  }

  // MARK: - Recording

  /// Begin journaled recording. Idempotent for the activity already being recorded.
  /// `nextSequence` is how many samples JavaScript already holds: numbering continues from at
  /// least there even if the journal file was lost.
  func startRecording(activityId: String, policyDict: [String: Any], nextSequence: Int = 0) throws {
    if recordingActivityId == activityId {
      journal?.ensureNextSequence(atLeast: nextSequence)
      return
    }
    if recordingActivityId != nil { stopRecording() }
    let j = try SampleJournal(
      activityId: activityId, directory: journalDirectory, compactionThreshold: compactionThreshold)
    j.ensureNextSequence(atLeast: nextSequence)
    journal = j
    recordingActivityId = activityId
    manager.apply(RecorderPolicy(policyDict))
    manager.startUpdates(background: true)
    updating = true
  }

  /// Switch the GPS policy between multisport legs. `nil` = a leg without GPS (transition):
  /// updates stop but the journal stays open for the next leg.
  func updatePolicy(_ policy: RecorderPolicy?) {
    guard recordingActivityId != nil else { return }
    if let policy {
      manager.apply(policy)
      manager.startUpdates(background: true)
      updating = true
    } else if updating {
      manager.stopUpdates()
      updating = false
    }
  }

  func stopRecording() {
    if updating {
      manager.stopUpdates()
      updating = false
    }
    journal?.close()
    journal = nil
    recordingActivityId = nil
    if acquiring {
      manager.startUpdates(background: false)
      updating = true
    }
  }

  func readJournal(activityId: String, from sequence: Int) throws -> [SampleJournal.Entry] {
    if activityId == recordingActivityId, let journal { return try journal.read(from: sequence) }
    // Not recording this activity (finished, or the process restarted): read the file directly.
    let j = try SampleJournal(
      activityId: activityId, directory: journalDirectory, compactionThreshold: compactionThreshold)
    defer { j.close() }
    return try j.read(from: sequence)
  }

  func acknowledge(activityId: String, through sequence: Int) throws {
    if activityId == recordingActivityId, let journal {
      try journal.acknowledge(through: sequence)
    }
  }

  /// Delete an activity's journal. Refused while that activity is being recorded.
  @discardableResult
  func deleteJournal(activityId: String) -> Bool {
    guard activityId != recordingActivityId,
          let j = try? SampleJournal(activityId: activityId, directory: journalDirectory) else { return false }
    j.delete()
    return true
  }

  // MARK: - Core Location callbacks

  func handle(locations: [CLLocation]) {
    let samples = locations.map(SampleSerializer.serialize)
    if let id = recordingActivityId, let journal {
      do {
        // Journal first: an entry is only ever reported after it is durably on disk.
        let entries = try journal.append(samples)
        delegate?.recorder(self, didRecord: entries, activityId: id)
      } catch {
        delegate?.recorder(self, didFail: "Failed to persist location samples: \(error.localizedDescription)")
      }
    } else if acquiring {
      delegate?.recorder(self, didAcquire: samples)
    }
  }

  func handle(error: Error) {
    if let clError = error as? CLError, clError.code == .locationUnknown { return } // transient
    delegate?.recorder(self, didFail: error.localizedDescription)
  }
}
