import ExpoModulesCore

/// Expo module exposing the native recording service to JavaScript.
/// Contract: `TrackingBridge` in packages/activity-engine/src/coordinator.ts.
public class PaceTrackingModule: Module, LocationRecorderDelegate {
  private lazy var recorder: LocationRecorder = {
    let r = LocationRecorder()
    r.delegate = self
    return r
  }()

  public func definition() -> ModuleDefinition {
    Name("PaceTracking")

    Events("onSamples", "onAuthorizationChange", "onError")

    OnCreate {
      DispatchQueue.main.async {
        // If iOS relaunched the app (or JS reloaded) mid-recording, keep journaling.
        self.recorder.restoreIfNeeded()
      }
    }

    AsyncFunction("getAuthorization") { () -> String in
      self.recorder.authorizationString
    }.runOnQueue(.main)

    AsyncFunction("requestAuthorization") { (level: String, promise: Promise) in
      self.recorder.requestAuthorization(level: level) { promise.resolve($0) }
    }.runOnQueue(.main)

    AsyncFunction("startAcquisition") { (policy: [String: Any]) in
      self.recorder.startAcquisition(policy: RecorderPolicy(policy))
    }.runOnQueue(.main)

    AsyncFunction("stopAcquisition") {
      self.recorder.stopAcquisition()
    }.runOnQueue(.main)

    AsyncFunction("startRecording") { (activityId: String, policy: [String: Any]) in
      try self.recorder.startRecording(activityId: activityId, policyDict: policy)
    }.runOnQueue(.main)

    AsyncFunction("updatePolicy") { (policy: [String: Any]?) in
      self.recorder.updatePolicy(policy.map(RecorderPolicy.init))
    }.runOnQueue(.main)

    AsyncFunction("stopRecording") {
      self.recorder.stopRecording()
    }.runOnQueue(.main)

    AsyncFunction("getRecordingActivityId") { () -> String? in
      self.recorder.recordingActivityId
    }.runOnQueue(.main)

    AsyncFunction("readJournal") { (activityId: String, fromSequence: Int) -> [[String: Any]] in
      try self.recorder.readJournal(activityId: activityId, from: fromSequence).map {
        ["sequence": $0.sequence, "sample": $0.sample]
      }
    }.runOnQueue(.main)

    AsyncFunction("acknowledge") { (activityId: String, throughSequence: Int) in
      try self.recorder.acknowledge(activityId: activityId, through: throughSequence)
    }.runOnQueue(.main)

    AsyncFunction("deleteJournal") { (activityId: String) in
      self.recorder.deleteJournal(activityId: activityId)
    }.runOnQueue(.main)
  }

  // MARK: - LocationRecorderDelegate

  func recorder(_ recorder: LocationRecorder, didRecord entries: [SampleJournal.Entry], activityId: String) {
    sendEvent("onSamples", [
      "activityId": activityId,
      "entries": entries.map { ["sequence": $0.sequence, "sample": $0.sample] },
    ])
  }

  func recorder(_ recorder: LocationRecorder, didAcquire samples: [[String: Any]]) {
    sendEvent("onSamples", [
      "activityId": NSNull(),
      "entries": samples.map { ["sequence": -1, "sample": $0] },
    ])
  }

  func recorder(_ recorder: LocationRecorder, didChangeAuthorization status: String) {
    sendEvent("onAuthorizationChange", ["status": status])
  }

  func recorder(_ recorder: LocationRecorder, didFail message: String) {
    sendEvent("onError", ["message": message])
  }
}
