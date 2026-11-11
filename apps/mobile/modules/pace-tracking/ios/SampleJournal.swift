import Foundation

/// Append-only, crash-safe journal of location samples for one activity.
///
/// Every sample is written (and the file handle synchronised) before JavaScript is notified,
/// so samples survive JS suspension, app termination and crashes. Files use
/// `completeUntilFirstUserAuthentication` protection so writes keep working while the
/// device is locked during an activity.
final class SampleJournal {
  struct Entry {
    let sequence: Int
    let sample: [String: Any]
  }

  private let queue = DispatchQueue(label: "app.pace.tracking.journal")
  private let directory: URL
  private let activityId: String
  private var handle: FileHandle?
  private(set) var nextSequence: Int = 0

  init(activityId: String) throws {
    self.activityId = activityId
    let support = try FileManager.default.url(
      for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    directory = support.appendingPathComponent("PaceTracking", isDirectory: true)
    try FileManager.default.createDirectory(
      at: directory, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    try queue.sync {
      try openFile()
      nextSequence = try lastSequence() + 1
    }
  }

  private var fileURL: URL { directory.appendingPathComponent("\(activityId).jsonl") }

  private func openFile() throws {
    if !FileManager.default.fileExists(atPath: fileURL.path) {
      FileManager.default.createFile(
        atPath: fileURL.path, contents: nil,
        attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    }
    let h = try FileHandle(forWritingTo: fileURL)
    try h.seekToEnd()
    handle = h
  }

  /// Highest sequence ever assigned. Compaction keeps an `ackThrough` header line so sequence
  /// numbers never restart after acknowledged entries are removed (JS relies on gap-free,
  /// monotonically increasing sequences to detect duplicates and gaps).
  private func lastSequence() throws -> Int {
    var last = -1
    for line in try readLines() {
      if let seq = line["seq"] as? Int { last = max(last, seq) }
      if let ack = line["ackThrough"] as? Int { last = max(last, ack) }
    }
    return last
  }

  private func readLines() throws -> [[String: Any]] {
    guard let data = try? Data(contentsOf: fileURL), !data.isEmpty else { return [] }
    var result: [[String: Any]] = []
    for chunk in data.split(separator: UInt8(ascii: "\n")) where !chunk.isEmpty {
      // A torn final line (power loss mid-write) fails to parse and is skipped.
      if let obj = try? JSONSerialization.jsonObject(with: Data(chunk)) as? [String: Any] {
        result.append(obj)
      }
    }
    return result
  }

  /// Appends samples and fsyncs. Returns the entries with their assigned sequence numbers.
  func append(_ samples: [[String: Any]]) throws -> [Entry] {
    try queue.sync {
      guard let handle else { throw NSError(domain: "PaceTracking", code: 1) }
      var entries: [Entry] = []
      var buffer = Data()
      for sample in samples {
        let entry = Entry(sequence: nextSequence, sample: sample)
        nextSequence += 1
        let line = try JSONSerialization.data(withJSONObject: ["seq": entry.sequence, "s": sample])
        buffer.append(line)
        buffer.append(UInt8(ascii: "\n"))
        entries.append(entry)
      }
      try handle.write(contentsOf: buffer)
      try handle.synchronize()
      return entries
    }
  }

  func read(from sequence: Int) throws -> [Entry] {
    try queue.sync {
      try readLines().compactMap { line in
        guard let seq = line["seq"] as? Int, seq >= sequence, let s = line["s"] as? [String: Any] else { return nil }
        return Entry(sequence: seq, sample: s)
      }
    }
  }

  /// Drops entries up to and including `sequence` once JavaScript has persisted them to SQLite.
  /// Compaction rewrites atomically and only every 500 acknowledged samples to limit I/O.
  func acknowledge(through sequence: Int) throws {
    try queue.sync {
      let lines = try readLines()
      let acknowledged = lines.filter { ($0["seq"] as? Int ?? Int.max) <= sequence }.count
      guard acknowledged >= 500 else { return }
      let remaining = lines.filter { ($0["seq"] as? Int ?? -1) > sequence }
      var data = try JSONSerialization.data(withJSONObject: ["ackThrough": sequence])
      data.append(UInt8(ascii: "
"))
      for line in remaining {
        data.append(try JSONSerialization.data(withJSONObject: line))
        data.append(UInt8(ascii: "\n"))
      }
      try handle?.close()
      try data.write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
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
