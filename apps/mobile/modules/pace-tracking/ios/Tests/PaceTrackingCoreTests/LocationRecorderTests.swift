import CoreLocation
import Foundation
import XCTest
@testable import PaceTrackingCore

final class LocationRecorderTests: XCTestCase {
  private var dir: URL!
  private var manager: FakeLocationManager!
  private var delegate: RecordingDelegate!
  private var recorder: LocationRecorder!

  override func setUpWithError() throws {
    dir = try makeTempDirectory()
    manager = FakeLocationManager()
    delegate = RecordingDelegate()
    recorder = LocationRecorder(manager: manager, journalDirectory: dir, compactionThreshold: 3)
    recorder.delegate = delegate
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: dir)
  }

  func testEntriesAreDurableBeforeTheyAreReported() throws {
    try recorder.startRecording(activityId: "run", policyDict: runPolicy)
    var checked = 0
    delegate.onRecord = { [unowned self] id, entries in
      // At notification time the journal on disk already holds every reported entry.
      let reader = try! SampleJournal(activityId: id, directory: self.dir)
      let onDisk = Set(try! reader.read(from: 0).map(\.sequence))
      XCTAssertTrue(Set(entries.map(\.sequence)).isSubset(of: onDisk))
      checked += 1
    }
    manager.deliver([fix(0), fix(1)])
    manager.deliver([fix(2)])
    XCTAssertEqual(checked, 2)
    XCTAssertEqual(delegate.recorded.flatMap { $0.entries.map(\.sequence) }, [0, 1, 2])
  }

  func testRecordingUsesBackgroundUpdatesAndAcquisitionDoesNot() throws {
    recorder.startAcquisition(policy: RecorderPolicy(runPolicy))
    XCTAssertTrue(manager.updating)
    XCTAssertFalse(manager.background)
    try recorder.startRecording(activityId: "run", policyDict: runPolicy)
    XCTAssertTrue(manager.background)
    recorder.stopAcquisition()
    XCTAssertTrue(manager.updating, "stopping acquisition must not stop an active recording")
  }

  func testAcquisitionFixesAreNeverJournaled() throws {
    recorder.startAcquisition(policy: RecorderPolicy(runPolicy))
    manager.deliver([fix(0), fix(1)])
    XCTAssertEqual(delegate.acquired.count, 1)
    XCTAssertTrue(delegate.recorded.isEmpty)
    try recorder.startRecording(activityId: "run", policyDict: runPolicy)
    manager.deliver([fix(2)])
    XCTAssertEqual(delegate.recorded.first?.entries.map(\.sequence), [0])
  }

  func testStartRecordingIsIdempotentForTheSameActivity() throws {
    try recorder.startRecording(activityId: "run", policyDict: runPolicy)
    manager.deliver([fix(0), fix(1)])
    try recorder.startRecording(activityId: "run", policyDict: runPolicy)
    manager.deliver([fix(2)])
    XCTAssertEqual(delegate.recorded.flatMap { $0.entries.map(\.sequence) }, [0, 1, 2])
    XCTAssertEqual(manager.appliedPolicies.count, 1)
  }

  func testResumingContinuesNumberingFromTheJournal() throws {
    try recorder.startRecording(activityId: "run", policyDict: runPolicy)
    manager.deliver([fix(0), fix(1), fix(2)])
    recorder.stopRecording()
    try recorder.startRecording(activityId: "run", policyDict: runPolicy, nextSequence: 3)
    manager.deliver([fix(3)])
    XCTAssertEqual(delegate.recorded.last?.entries.map(\.sequence), [3])
  }

  func testLostJournalStillHonoursTheJavaScriptSequence() throws {
    try recorder.startRecording(activityId: "run", policyDict: runPolicy)
    manager.deliver([fix(0), fix(1)])
    recorder.stopRecording()
    XCTAssertTrue(recorder.deleteJournal(activityId: "run")) // journal file lost
    try recorder.startRecording(activityId: "run", policyDict: runPolicy, nextSequence: 2)
    manager.deliver([fix(2)])
    // Regression: numbering restarted at 0 and JavaScript dropped the samples as duplicates.
    XCTAssertEqual(delegate.recorded.last?.entries.map(\.sequence), [2])
  }

  func testANewProcessDoesNotRestartRecordingByItself() throws {
    try recorder.startRecording(activityId: "run", policyDict: runPolicy)
    manager.deliver([fix(0)])
    // Simulate a process restart: a new recorder over the same journal directory.
    let freshManager = FakeLocationManager()
    let fresh = LocationRecorder(manager: freshManager, journalDirectory: dir)
    XCTAssertNil(fresh.recordingActivityId)
    XCTAssertFalse(freshManager.updating)
    // ...but the journal written by the previous process is still readable for recovery.
    XCTAssertEqual(try fresh.readJournal(activityId: "run", from: 0).map(\.sequence), [0])
  }

  func testStopRecordingStopsUpdatesAndRestoresAcquisition() throws {
    try recorder.startRecording(activityId: "run", policyDict: runPolicy)
    recorder.stopRecording()
    XCTAssertFalse(manager.updating)
    XCTAssertNil(recorder.recordingActivityId)
    recorder.startAcquisition(policy: RecorderPolicy(runPolicy))
    try recorder.startRecording(activityId: "ride", policyDict: runPolicy)
    recorder.stopRecording()
    XCTAssertTrue(manager.updating, "acquisition was still requested")
    XCTAssertFalse(manager.background)
  }

  func testTransitionLegStopsGpsButKeepsTheJournal() throws {
    try recorder.startRecording(activityId: "tri", policyDict: runPolicy)
    manager.deliver([fix(0)])
    recorder.updatePolicy(nil)
    XCTAssertFalse(manager.updating)
    XCTAssertEqual(recorder.recordingActivityId, "tri")
    recorder.updatePolicy(RecorderPolicy(["desiredAccuracy": "best_for_navigation"]))
    manager.deliver([fix(1)])
    XCTAssertEqual(delegate.recorded.last?.entries.map(\.sequence), [1])
  }

  func testAcknowledgedEntriesAreCompactedButStayReadableUntilAcknowledged() throws {
    try recorder.startRecording(activityId: "run", policyDict: runPolicy)
    manager.deliver((0..<5).map { fix($0) })
    try recorder.acknowledge(activityId: "run", through: 3)
    XCTAssertEqual(try recorder.readJournal(activityId: "run", from: 0).map(\.sequence), [4])
    manager.deliver([fix(5)])
    XCTAssertEqual(delegate.recorded.last?.entries.map(\.sequence), [5])
  }

  func testJournalCannotBeDeletedWhileRecording() throws {
    try recorder.startRecording(activityId: "run", policyDict: runPolicy)
    XCTAssertFalse(recorder.deleteJournal(activityId: "run"))
    recorder.stopRecording()
    XCTAssertTrue(recorder.deleteJournal(activityId: "run"))
  }

  func testSwitchingActivitiesClosesThePreviousJournal() throws {
    try recorder.startRecording(activityId: "a", policyDict: runPolicy)
    manager.deliver([fix(0)])
    try recorder.startRecording(activityId: "b", policyDict: runPolicy)
    manager.deliver([fix(1)])
    XCTAssertEqual(delegate.recorded.map { $0.activityId }, ["a", "b"])
    XCTAssertEqual(delegate.recorded.last?.entries.map(\.sequence), [0])
  }

  func testAuthorizationRequestsResolveOnChange() {
    manager.authorization = "undetermined"
    var result: String?
    recorder.requestAuthorization(level: "when_in_use") { result = $0 }
    XCTAssertEqual(manager.whenInUseRequests, 1)
    manager.authorization = "when_in_use"
    manager.onAuthorizationChange?()
    XCTAssertEqual(result, "when_in_use")
    XCTAssertEqual(delegate.authorizations, ["when_in_use"])
    recorder.requestAuthorization(level: "always") { result = $0 }
    XCTAssertEqual(manager.alwaysRequests, 1)
  }

  func testTransientLocationUnknownErrorsAreIgnored() {
    manager.onError?(CLError(.locationUnknown))
    XCTAssertTrue(delegate.failures.isEmpty)
    manager.onError?(CLError(.denied))
    XCTAssertEqual(delegate.failures.count, 1)
  }
}
