import Foundation

/// Append-only, crash-safe journal of location samples for one activity.
///
/// Contract (mirrored by the TypeScript `TrackingBridge` and its test double):
/// - every sample is written and the file synchronised (fsync) *before* anyone is notified;
/// - sequence numbers are gap-free and strictly increasing per activity, and never restart —
///   not after reopening, not after compaction, not after the file is lost (callers pass the
///   number of samples they already hold via `ensureNextSequence(atLeast:)`);
/// - a torn final line (power loss mid-write) is ignored on read and repaired before appending.
///
/// Files use `completeUntilFirstUserAuthentication` protection on iOS so writes keep working
/// while the phone is locked during an activity.
final class SampleJournal {
  struct Entry {
    let sequence: Int
    let sample: [String: Any]
  }

  enum JournalError: Error {
    case closed
  }

  private let queue = DispatchQueue(label: "app.pace.tracking.journal")
  private let directory: URL
  private let activityId: String
  private let compactionThreshold: Int
  private var handle: FileHandle?
  private(set) var nextSequence: Int = 0

  /// Default location: Application Support/PaceTracking (backed up, never purged by the OS).
  static func defaultDirectory() throws -> URL {
    let support = try FileManager.default.url(
      for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    return support.appendingPathComponent("PaceTracking", isDirectory: true)
  }

  init(activityId: String, directory: URL, compactionThreshold: Int = 500) throws {
    self.activityId = activityId
    self.directory = directory
    self.compactionThreshold = compactionThreshold
    try FileManager.default.createDirectory(
      at: directory, withIntermediateDirectories: true, attributes: Self.protectedAttributes)
    try queue.sync {
      try openFile()
      nextSequence = try lastSequence() + 1
    }
  }

  var fileURL: URL { directory.appendingPathComponent("\(activityId).jsonl") }

  private static var protectedAttributes: [FileAttributeKey: Any] {
    #if os(iOS)
      return [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
    #else
      return [:]
    #endif
  }

  private static var atomicProtectedWrite: Data.WritingOptions {
    #if os(iOS)
      return [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
    #else
      return [.atomic]
    #endif
  }

  private func openFile() throws {
    if !FileManager.default.fileExists(atPath: fileURL.path) {
      FileManager.default.createFile(atPath: fileURL.path, contents: nil, attributes: Self.protectedAttributes)
    }
    let h = try FileHandle(forUpdating: fileURL)
    let end = try h.seekToEnd()
    // Repair a torn tail: if the last write was interrupted, the file does not end with a
    // newline and the next line would be glued onto the fragment (and become unreadable).
    if end > 0 {
      try h.seek(toOffset: end - 1)
      let last = try h.read(upToCount: 1)
      try h.seekToEnd()
      if last?.first != UInt8(ascii: "\n") {
        try h.write(contentsOf: Data([UInt8(ascii: "\n")]))
        try h.synchronize()
      }
    }
    handle = h
  }

  /// Highest sequence ever assigned, including the `ackThrough` high-water mark kept by
  /// compaction, so numbering never restarts after acknowledged entries are removed.
  private func lastSequence() throws -> Int {
    var last = -1
    for line in try readLines() {
      if let seq = (line["seq"] as? NSNumber)?.intValue { last = max(last, seq) }
      if let ack = (line["ackThrough"] as? NSNumber)?.intValue { last = max(last, ack) }
    }
    return last
  }

  private func readLines() throws -> [[String: Any]] {
    guard let data = try? Data(contentsOf: fileURL), !data.isEmpty else { return [] }
    var result: [[String: Any]] = []
    for chunk in data.split(separator: UInt8(ascii: "\n")) where !chunk.isEmpty {
      // A torn line fails to parse and is skipped; it was never reported to JavaScript.
      if let obj = try? JSONSerialization.jsonObject(with: Data(chunk)) as? [String: Any] {
        result.append(obj)
      }
    }
    return result
  }

  /// Raise the next sequence number to at least `value` (never lowers it).
  func ensureNextSequence(atLeast value: Int) {
    queue.sync { nextSequence = max(nextSequence, value) }
  }

  /// Appends samples and fsyncs. Returns the entries with their assigned sequence numbers.
  /// On failure nothing is reported and the sequence counter is not advanced.
  func append(_ samples: [[String: Any]]) throws -> [Entry] {
    try queue.sync {
      guard let handle else { throw JournalError.closed }
      var entries: [Entry] = []
      var buffer = Data()
      var seq = nextSequence
      for sample in samples {
        let line = try JSONSerialization.data(withJSONObject: ["seq": seq, "s": sample])
        buffer.append(line)
        buffer.append(UInt8(ascii: "\n"))
        entries.append(Entry(sequence: seq, sample: sample))
        seq += 1
      }
      try handle.write(contentsOf: buffer)
      try handle.synchronize()
      nextSequence = seq
      return entries
    }
  }

  func read(from sequence: Int) throws -> [Entry] {
    try queue.sync {
      try readLines().compactMap { line in
        guard let seq = (line["seq"] as? NSNumber)?.intValue, seq >= sequence,
              let s = line["s"] as? [String: Any] else { return nil }
        return Entry(sequence: seq, sample: s)
      }
    }
  }

  /// Drops entries up to and including `sequence` once JavaScript has persisted them to SQLite.
  /// Compaction rewrites atomically, and only once `compactionThreshold` entries are
  /// acknowledged, to bound I/O.
  func acknowledge(through sequence: Int) throws {
    try queue.sync {
      let lines = try readLines()
      let acknowledged = lines.filter { ((($0["seq"] as? NSNumber)?.intValue) ?? Int.max) <= sequence }.count
      guard acknowledged >= compactionThreshold else { return }
      let remaining = lines.filter { ((($0["seq"] as? NSNumber)?.intValue) ?? -1) > sequence }
      let highWater = max(sequence, nextSequence - 1)
      var data = try JSONSerialization.data(withJSONObject: ["ackThrough": highWater])
      data.append(UInt8(ascii: "\n"))
      for line in remaining {
        data.append(try JSONSerialization.data(withJSONObject: line))
        data.append(UInt8(ascii: "\n"))
      }
      try handle?.close()
      handle = nil
      do {
        try data.write(to: fileURL, options: Self.atomicProtectedWrite)
      } catch {
        // The atomic write left the original file intact: reopen it so recording continues.
        try openFile()
        throw error
      }
      try openFile()
    }
  }

  func close() {
    queue.sync {
      try? handle?.close()
      handle = nil
    }
  }

  /// Removes the journal once the activity has been finalised or discarded by JavaScript.
  func delete() {
    close()
    try? FileManager.default.removeItem(at: fileURL)
  }
}
