import AppIntents
import Foundation
import SQLite3
internal import UnstrapLiveActivityIntents

private let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

@available(iOS 16.0, *)
enum UnstrapIntentEventKind: String, AppEnum {
  case any
  case wearableAlarm = "wearable_alarm"
  case bedtimeStart = "bedtime_start"
  case fallingAsleep = "falling_asleep"
  case wakingUp = "waking_up"
  case sleepScore100 = "sleep_score_100"

  static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Unstrap Event")

  static var caseDisplayRepresentations: [UnstrapIntentEventKind: DisplayRepresentation] = [
    .any: "Any Event",
    .wearableAlarm: "Wearable Alarm",
    .bedtimeStart: "Bedtime Start",
    .fallingAsleep: "Falling Asleep",
    .wakingUp: "Waking Up",
    .sleepScore100: "100% Sleep Score",
  ]
}

@available(iOS 16.0, *)
enum UnstrapSleepStateValue: String, AppEnum {
  case unknown
  case awake
  case asleep

  static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Unstrap Sleep State")

  static var caseDisplayRepresentations: [UnstrapSleepStateValue: DisplayRepresentation] = [
    .unknown: "Unknown",
    .awake: "Awake",
    .asleep: "Asleep",
  ]
}

@available(iOS 16.0, *)
struct GetLatestUnstrapEventIntent: AppIntent {
  static var title: LocalizedStringResource = "Get Latest Unstrap Event"
  static var description = IntentDescription("Returns the latest matching Unstrap event as JSON text.")

  @Parameter(title: "Event")
  var event: UnstrapIntentEventKind

  @Parameter(title: "Include Handled Events")
  var includeHandled: Bool

  init() {
    event = .any
    includeHandled = false
  }

  static var parameterSummary: some ParameterSummary {
    Summary("Get latest \(\.$event) event")
  }

  func perform() async throws -> some IntentResult & ReturnsValue<String> {
    let store = UnstrapIntentStore()
    let result = try store.latestEvent(kind: event, includeHandled: includeHandled)
    return .result(value: result)
  }
}

@available(iOS 16.0, *)
struct HasUnstrapEventHappenedIntent: AppIntent {
  static var title: LocalizedStringResource = "Has Unstrap Event Happened"
  static var description = IntentDescription("Checks whether an Unstrap event happened within a recent time window.")

  @Parameter(title: "Event")
  var event: UnstrapIntentEventKind

  @Parameter(title: "Minutes Back")
  var minutesBack: Int

  @Parameter(title: "Include Handled Events")
  var includeHandled: Bool

  init() {
    event = .any
    minutesBack = 30
    includeHandled = false
  }

  static var parameterSummary: some ParameterSummary {
    Summary("Check if \(\.$event) happened in the last \(\.$minutesBack) minutes")
  }

  func perform() async throws -> some IntentResult & ReturnsValue<Bool> {
    let store = UnstrapIntentStore()
    let happened = try store.hasEventHappened(
      kind: event,
      minutesBack: minutesBack,
      includeHandled: includeHandled
    )
    return .result(value: happened)
  }
}

@available(iOS 16.0, *)
struct GetPendingUnstrapEventsIntent: AppIntent {
  static var title: LocalizedStringResource = "Get Pending Unstrap Events"
  static var description = IntentDescription("Returns unhandled Unstrap events as JSON text.")

  @Parameter(title: "Event")
  var event: UnstrapIntentEventKind

  @Parameter(title: "Limit")
  var limit: Int

  init() {
    event = .any
    limit = 5
  }

  static var parameterSummary: some ParameterSummary {
    Summary("Get pending \(\.$event) events")
  }

  func perform() async throws -> some IntentResult & ReturnsValue<String> {
    let store = UnstrapIntentStore()
    let result = try store.pendingEvents(kind: event, limit: limit)
    return .result(value: result)
  }
}

@available(iOS 16.0, *)
struct MarkUnstrapEventsHandledIntent: AppIntent {
  static var title: LocalizedStringResource = "Mark Unstrap Events Handled"
  static var description = IntentDescription("Marks recent Unstrap events as handled so future Shortcuts checks can ignore them.")

  @Parameter(title: "Event")
  var event: UnstrapIntentEventKind

  @Parameter(title: "Minutes Back")
  var minutesBack: Int

  init() {
    event = .any
    minutesBack = 60
  }

  static var parameterSummary: some ParameterSummary {
    Summary("Mark \(\.$event) events handled from the last \(\.$minutesBack) minutes")
  }

  func perform() async throws -> some IntentResult & ReturnsValue<Int> {
    let store = UnstrapIntentStore()
    let count = try store.markEventsHandled(kind: event, minutesBack: minutesBack)
    return .result(value: count)
  }
}

@available(iOS 16.0, *)
struct GetCurrentUnstrapSleepStateIntent: AppIntent {
  static var title: LocalizedStringResource = "Get Current Unstrap Sleep State"
  static var description = IntentDescription("Returns the latest Unstrap sleep state.")

  static var parameterSummary: some ParameterSummary {
    Summary("Get current Unstrap sleep state")
  }

  func perform() async throws -> some IntentResult & ReturnsValue<UnstrapSleepStateValue> {
    let store = UnstrapIntentStore()
    let result = try store.currentSleepState()
    return .result(value: result)
  }
}

@available(iOS 16.0, *)
struct ShowUnstrapSleepLiveActivityIntent: AppIntent {
  static var title: LocalizedStringResource = "Show Unstrap Live Activity"
  static var description = IntentDescription("Starts or updates the Unstrap sleep Live Activity.")

  static var parameterSummary: some ParameterSummary {
    Summary("Show Unstrap Live Activity")
  }

  func perform() async throws -> some IntentResult {
    guard #available(iOS 17.0, *) else {
      throw UnstrapAppIntentError.liveActivitiesUnavailable
    }

    try await UnstrapSleepLiveActivity.start()
    return .result()
  }
}

@available(iOS 16.0, *)
struct UnstrapAppShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: GetLatestUnstrapEventIntent(),
      phrases: [
        "Get latest \(.applicationName) event",
        "Check latest \(.applicationName) event",
      ],
      shortTitle: "Latest Event",
      systemImageName: "waveform.path.ecg"
    )
    AppShortcut(
      intent: HasUnstrapEventHappenedIntent(),
      phrases: [
        "Has \(.applicationName) event happened",
        "Check \(.applicationName) event",
      ],
      shortTitle: "Event Happened",
      systemImageName: "checkmark.circle"
    )
    AppShortcut(
      intent: GetPendingUnstrapEventsIntent(),
      phrases: [
        "Get pending \(.applicationName) events",
      ],
      shortTitle: "Pending Events",
      systemImageName: "tray.full"
    )
    AppShortcut(
      intent: MarkUnstrapEventsHandledIntent(),
      phrases: [
        "Mark \(.applicationName) events handled",
      ],
      shortTitle: "Mark Handled",
      systemImageName: "checkmark.seal"
    )
    AppShortcut(
      intent: GetCurrentUnstrapSleepStateIntent(),
      phrases: [
        "Get \(.applicationName) sleep state",
        "Check \(.applicationName) sleep state",
      ],
      shortTitle: "Sleep State",
      systemImageName: "bed.double"
    )
    AppShortcut(
      intent: ShowUnstrapSleepLiveActivityIntent(),
      phrases: [
        "Show \(.applicationName) live activity",
        "Start \(.applicationName) live activity",
      ],
      shortTitle: "Show Live Activity",
      systemImageName: "livephoto"
    )
  }
}

private enum UnstrapAppIntentError: LocalizedError {
  case liveActivitiesUnavailable

  var errorDescription: String? {
    switch self {
    case .liveActivitiesUnavailable:
      return "Unstrap Live Activities require iOS 17 or later."
    }
  }
}

private struct UnstrapIntentEventRecord: Encodable {
  let id: Int64
  let kind: String
  let entityId: String
  let occurredAt: String
  let payload: String
  let handledAt: String?
}

@available(iOS 16.0, *)
private struct UnstrapIntentStore {
  private let databaseName = "btwearable.db"
  private let databaseBusyTimeoutMs: Int32 = 10_000

  func latestEvent(kind: UnstrapIntentEventKind, includeHandled: Bool) throws -> String {
    let records = try queryEvents(
      kind: kind,
      includeHandled: includeHandled,
      since: nil,
      limit: 1
    )

    guard let record = records.first else {
      return encode([
        "found": false,
        "event": kind.rawValue,
      ])
    }

    return encode([
      "found": true,
      "event": record.kind,
      "entityId": record.entityId,
      "occurredAt": record.occurredAt,
      "handledAt": (record.handledAt as Any?) ?? NSNull(),
      "payload": payloadObject(from: record.payload),
    ])
  }

  func hasEventHappened(
    kind: UnstrapIntentEventKind,
    minutesBack: Int,
    includeHandled: Bool
  ) throws -> Bool {
    let since = Date().addingTimeInterval(-TimeInterval(max(minutesBack, 1) * 60))
    return try countEvents(kind: kind, includeHandled: includeHandled, since: since) > 0
  }

  func pendingEvents(kind: UnstrapIntentEventKind, limit: Int) throws -> String {
    let records = try queryEvents(
      kind: kind,
      includeHandled: false,
      since: nil,
      limit: max(1, min(limit, 25))
    )

    return encode([
      "count": records.count,
      "events": records.map { record in
        [
          "id": record.id,
          "event": record.kind,
          "entityId": record.entityId,
          "occurredAt": record.occurredAt,
          "payload": payloadObject(from: record.payload),
        ] as [String: Any]
      },
    ])
  }

  func markEventsHandled(kind: UnstrapIntentEventKind, minutesBack: Int) throws -> Int {
    let since = Date().addingTimeInterval(-TimeInterval(max(minutesBack, 1) * 60))
    return try withDatabase(readonly: false) { database in
      try ensureEventTable(database)

      let sql: String
      if kind == .any {
        sql = """
          UPDATE app_intent_events
          SET handled_at = ?
          WHERE occurred_at <= ?
            AND occurred_at >= ?
            AND handled_at IS NULL
        """
      } else {
        sql = """
          UPDATE app_intent_events
          SET handled_at = ?
          WHERE occurred_at <= ?
            AND occurred_at >= ?
            AND kind = ?
            AND handled_at IS NULL
        """
      }

      let handledAt = sqlDate(Date())
      let now = sqlDate(Date())
      let sinceText = sqlDate(since)
      var statement: OpaquePointer?
      guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK else {
        throw sqliteError(database)
      }
      defer {
        sqlite3_finalize(statement)
      }

      bindText(statement, 1, handledAt)
      bindText(statement, 2, now)
      bindText(statement, 3, sinceText)
      if kind != .any {
        bindText(statement, 4, kind.rawValue)
      }

      guard sqlite3_step(statement) == SQLITE_DONE else {
        throw sqliteError(database)
      }

      return Int(sqlite3_changes(database))
    }
  }

  func currentSleepState() throws -> UnstrapSleepStateValue {
    try withDatabase(readonly: true) { database in
      let sql = """
        SELECT completion_status
        FROM sleep_cycles
        ORDER BY end DESC
        LIMIT 1
      """
      var statement: OpaquePointer?
      guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK else {
        return .unknown
      }
      defer {
        sqlite3_finalize(statement)
      }

      guard sqlite3_step(statement) == SQLITE_ROW else {
        return .unknown
      }

      return columnText(statement, 0) == "in_progress" ? .asleep : .awake
    }
  }

  private func queryEvents(
    kind: UnstrapIntentEventKind,
    includeHandled: Bool,
    since: Date?,
    limit: Int
  ) throws -> [UnstrapIntentEventRecord] {
    try withDatabase(readonly: true) { database in
      try ensureEventTable(database)

      var clauses = ["occurred_at <= ?"]
      if kind != .any {
        clauses.append("kind = ?")
      }
      if !includeHandled {
        clauses.append("handled_at IS NULL")
      }
      if since != nil {
        clauses.append("occurred_at >= ?")
      }

      let sql = """
        SELECT id, kind, entity_id, occurred_at, payload_json, handled_at
        FROM app_intent_events
        WHERE \(clauses.joined(separator: " AND "))
        ORDER BY occurred_at DESC, id DESC
        LIMIT ?
      """

      var statement: OpaquePointer?
      guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK else {
        throw sqliteError(database)
      }
      defer {
        sqlite3_finalize(statement)
      }

      var bindIndex: Int32 = 1
      bindText(statement, bindIndex, sqlDate(Date()))
      bindIndex += 1
      if kind != .any {
        bindText(statement, bindIndex, kind.rawValue)
        bindIndex += 1
      }
      if let since = since {
        bindText(statement, bindIndex, sqlDate(since))
        bindIndex += 1
      }
      sqlite3_bind_int(statement, bindIndex, Int32(max(1, limit)))

      var records: [UnstrapIntentEventRecord] = []
      while sqlite3_step(statement) == SQLITE_ROW {
        records.append(UnstrapIntentEventRecord(
          id: sqlite3_column_int64(statement, 0),
          kind: columnText(statement, 1) ?? "",
          entityId: columnText(statement, 2) ?? "",
          occurredAt: columnText(statement, 3) ?? "",
          payload: columnText(statement, 4) ?? "{}",
          handledAt: columnText(statement, 5)
        ))
      }

      return records
    }
  }

  private func countEvents(
    kind: UnstrapIntentEventKind,
    includeHandled: Bool,
    since: Date
  ) throws -> Int {
    try withDatabase(readonly: true) { database in
      try ensureEventTable(database)

      var clauses = ["occurred_at <= ?", "occurred_at >= ?"]
      if kind != .any {
        clauses.append("kind = ?")
      }
      if !includeHandled {
        clauses.append("handled_at IS NULL")
      }

      let sql = """
        SELECT COUNT(*) AS count
        FROM app_intent_events
        WHERE \(clauses.joined(separator: " AND "))
      """

      var statement: OpaquePointer?
      guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK else {
        throw sqliteError(database)
      }
      defer {
        sqlite3_finalize(statement)
      }

      bindText(statement, 1, sqlDate(Date()))
      bindText(statement, 2, sqlDate(since))
      if kind != .any {
        bindText(statement, 3, kind.rawValue)
      }

      guard sqlite3_step(statement) == SQLITE_ROW else {
        return 0
      }

      return Int(sqlite3_column_int(statement, 0))
    }
  }

  private func ensureEventTable(_ database: OpaquePointer?) throws {
    let sql = """
      CREATE TABLE IF NOT EXISTS app_intent_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        kind TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        handled_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (kind, entity_id)
      );

      CREATE INDEX IF NOT EXISTS idx_app_intent_events_lookup
        ON app_intent_events(kind, occurred_at, handled_at);
    """

    guard sqlite3_exec(database, sql, nil, nil, nil) == SQLITE_OK else {
      throw sqliteError(database)
    }
  }

  private func withDatabase<T>(readonly: Bool, _ body: (OpaquePointer?) throws -> T) throws -> T {
    let url = databaseURL()
    var database: OpaquePointer?
    let flags = readonly
      ? SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX
      : SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX

    guard sqlite3_open_v2(url.path, &database, flags, nil) == SQLITE_OK else {
      let message = database.flatMap { sqlite3_errmsg($0) }.map { String(cString: $0) }
        ?? "Unable to open Unstrap database."
      if database != nil {
        sqlite3_close(database)
      }
      throw NSError(domain: "UnstrapAppIntents", code: 1, userInfo: [
        NSLocalizedDescriptionKey: message,
      ])
    }

    sqlite3_busy_timeout(database, databaseBusyTimeoutMs)
    defer {
      sqlite3_close(database)
    }

    return try body(database)
  }

  private func databaseURL() -> URL {
    FileManager.default
      .urls(for: .documentDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("SQLite", isDirectory: true)
      .appendingPathComponent(databaseName, isDirectory: false)
  }

  private func sqlDate(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
    return formatter.string(from: date)
  }

  private func bindText(_ statement: OpaquePointer?, _ index: Int32, _ value: String) {
    sqlite3_bind_text(statement, index, value, -1, sqliteTransient)
  }

  private func columnText(_ statement: OpaquePointer?, _ index: Int32) -> String? {
    guard let value = sqlite3_column_text(statement, index) else {
      return nil
    }

    return String(cString: value)
  }

  private func columnDoubleOrNil(_ statement: OpaquePointer?, _ index: Int32) -> Double? {
    if sqlite3_column_type(statement, index) == SQLITE_NULL {
      return nil
    }

    return sqlite3_column_double(statement, index)
  }

  private func payloadObject(from payload: String) -> Any {
    guard let data = payload.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data),
          JSONSerialization.isValidJSONObject(object) else {
      return payload
    }

    return object
  }

  private func sqliteError(_ database: OpaquePointer?) -> Error {
    let message = database.flatMap { sqlite3_errmsg($0) }.map { String(cString: $0) }
      ?? "SQLite error."
    return NSError(domain: "UnstrapAppIntents", code: 2, userInfo: [
      NSLocalizedDescriptionKey: message,
    ])
  }

  private func encode(_ value: Any) -> String {
    guard JSONSerialization.isValidJSONObject(value),
          let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
          let string = String(data: data, encoding: .utf8) else {
      return "{}"
    }

    return string
  }
}
