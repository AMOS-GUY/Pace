import Foundation
import XCTest
@testable import PaceTrackingCore

final class SampleJournalTests: XCTestCase {
  private var dir: URL!

  override func setUpWithError() throws {
    dir = try makeTempDirectory()
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: dir)
  }

  func testAppendAssignsContiguousSequencesAndPersistsThem() throws {
    let j = try SampleJournal(activityId: "a", directory: dir)
    let first = try j.append([sample(0), sample(1)])
    let second = try j.append([sample(2)])
    XCTAssertEqual(first.map(\.sequence), [0, 1])
    XCTAssertEqual(second.map(\.sequence), [2])
    XCTAssertEqual(try j.read(from: 0).map(\.sequence), [0, 1, 2])
    XCTAssertEqual(try j.read(from: 2).map(\.sequence), [2])
    XCTAssertEqual(try j.read(from: 0)[1].sample["recordedAt"] as? Int, 1_780_000_001_000)
  }

  func testReopeningContinuesNumbering() throws {
    var j: SampleJournal? = try SampleJournal(activityId: "a", directory: dir)
    _ = try j!.append([sample(0), sample(1), sample(2)])
    j!.close()
    j = nil
    let reopened = try SampleJournal(activityId: "a", directory: dir)
    XCTAssertEqual(reopened.nextSequence, 3)
    XCTAssertEqual(try reopened.append([sample(3)]).map(\.sequence), [3])
  }

  func testAcknowledgeBelowThresholdKeepsEverything() throws {
    let j = try SampleJournal(activityId: "a", directory: dir, compactionThreshold: 10)
    _ = try j.append((0..<5).map(sample))
    try j.acknowledge(through: 4)
    XCTAssertEqual(try j.read(from: 0).count, 5)
  }

  func testCompactionNeverRestartsNumbering() throws {
    let j = try SampleJournal(activityId: "a", directory: dir, compactionThreshold: 3)
    _ = try j.append((0..<5).map(sample))
    try j.acknowledge(through: 4) // everything acknowledged: only the high-water mark remains
    XCTAssertEqual(try j.read(from: 0).count, 0)
    XCTAssertEqual(try j.append([sample(5)]).map(\.sequence), [5])
    j.close()
    // Regression: without the persisted high-water mark a reopened journal restarted at 0, and
    // JavaScript discarded the new samples as duplicates.
    let reopened = try SampleJournal(activityId: "a", directory: dir, compactionThreshold: 3)
    XCTAssertEqual(reopened.nextSequence, 6)
    XCTAssertEqual(try reopened.read(from: 0).map(\.sequence), [5])
  }

  func testCompactionKeepsUnacknowledgedEntries() throws {
    let j = try SampleJournal(activityId: "a", directory: dir, compactionThreshold: 3)
    _ = try j.append((0..<6).map(sample))
    try j.acknowledge(through: 2)
    XCTAssertEqual(try j.read(from: 0).map(\.sequence), [3, 4, 5])
  }

  func testTornTailIsRepairedBeforeAppending() throws {
    let j = try SampleJournal(activityId: "a", directory: dir)
    _ = try j.append([sample(0), sample(1)])
    j.close()
    // Simulate power loss in the middle of writing entry 2.
    let h = try FileHandle(forWritingTo: j.fileURL)
    try h.seekToEnd()
    try h.write(contentsOf: Data(#"{"seq":2,"s":{"latit"#.utf8))
    try h.close()

    let reopened = try SampleJournal(activityId: "a", directory: dir)
    XCTAssertEqual(reopened.nextSequence, 2, "the torn entry was never reported, so its number is reused")
    XCTAssertEqual(try reopened.append([sample(2)]).map(\.sequence), [2])
    // Regression: the new line used to be glued onto the fragment and become unreadable.
    XCTAssertEqual(try reopened.read(from: 0).map(\.sequence), [0, 1, 2])
  }

  func testEnsureNextSequenceOnlyRaises() throws {
    let j = try SampleJournal(activityId: "a", directory: dir)
    _ = try j.append([sample(0), sample(1)])
    j.ensureNextSequence(atLeast: 1)
    XCTAssertEqual(j.nextSequence, 2)
    j.ensureNextSequence(atLeast: 40)
    XCTAssertEqual(try j.append([sample(40)]).map(\.sequence), [40])
  }

  func testAppendAfterCloseFailsWithoutAdvancing() throws {
    let j = try SampleJournal(activityId: "a", directory: dir)
    _ = try j.append([sample(0)])
    j.close()
    XCTAssertThrowsError(try j.append([sample(1)]))
    XCTAssertEqual(j.nextSequence, 1)
  }

  func testDeleteRemovesTheFile() throws {
    let j = try SampleJournal(activityId: "a", directory: dir)
    _ = try j.append([sample(0)])
    j.delete()
    XCTAssertFalse(FileManager.default.fileExists(atPath: j.fileURL.path))
  }

  func testJournalsAreIsolatedPerActivity() throws {
    let a = try SampleJournal(activityId: "a", directory: dir)
    let b = try SampleJournal(activityId: "b", directory: dir)
    _ = try a.append([sample(0), sample(1)])
    XCTAssertEqual(try b.append([sample(0)]).map(\.sequence), [0])
    XCTAssertEqual(try a.read(from: 0).count, 2)
  }
}
