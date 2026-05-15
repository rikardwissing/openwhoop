import AppIntents
import ExpoModulesCore
import ExpoNotifications
import ExpoWidgets
import Foundation
import SQLite3
import UIKit
import UserNotifications

private let unstrapSqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

private enum UnstrapLiveActivityConstants {
  static let actionIdentifier = "start_sleep_live_activity"
  static let liveActivityName = "SleepWidgetV2"
  static let liveActivityPropsKey = "liveActivityProps"
  static let liveActivityURL = "btwearable://"
}

@available(iOS 17.0, *)
public struct StartUnstrapSleepLiveActivityIntent: LiveActivityIntent {
  public static var title: LocalizedStringResource = "Start Unstrap Live Activity"
  public static var description = IntentDescription("Starts the Unstrap wind-down or sleep Live Activity.")

  private var notificationPropsJSON: String?

  public init() {
    notificationPropsJSON = nil
  }

  public init(propsJSON: String?) {
    notificationPropsJSON = propsJSON
  }

  public static var parameterSummary: some ParameterSummary {
    Summary("Start Unstrap sleep Live Activity")
  }

  public func perform() async throws -> some IntentResult {
    try await UnstrapSleepLiveActivityStarter.start(propsJSON: notificationPropsJSON)
    return .result()
  }
}

@available(iOS 17.0, *)
public struct UnstrapLiveActivityIntentsPackage: AppIntentsPackage {}

public final class UnstrapLiveActivityIntentsAppDelegateSubscriber: ExpoAppDelegateSubscriber, NotificationDelegate {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    NotificationCenterManager.shared.addDelegate(self)
    return true
  }

  public func didReceive(
    _ response: UNNotificationResponse,
    completionHandler: @escaping () -> Void
  ) -> Bool {
    guard response.actionIdentifier == UnstrapLiveActivityConstants.actionIdentifier else {
      return false
    }

    guard #available(iOS 17.0, *) else {
      return true
    }

    let propsJSON = UnstrapNotificationPayload.liveActivityPropsJSON(
      from: response.notification.request.content.userInfo
    )

    Task {
      do {
        _ = try await StartUnstrapSleepLiveActivityIntent(propsJSON: propsJSON).perform()
      } catch {
        NSLog("[Unstrap] Failed to start sleep Live Activity from notification action: \(error.localizedDescription)")
      }
    }

    return true
  }
}

@available(iOS 17.0, *)
private enum UnstrapSleepLiveActivityStarter {
  static func start(propsJSON: String?) async throws {
    let props = propsJSON
      ?? UnstrapLiveActivityEventStore().latestPropsJSON()
      ?? UnstrapNotificationPayload.fallbackLiveActivityPropsJSON()
    let url = URL(string: UnstrapLiveActivityConstants.liveActivityURL)

    try await ExpoWidgetsLiveActivityLauncher.startOrUpdate(
      name: UnstrapLiveActivityConstants.liveActivityName,
      props: props,
      url: url
    )
  }
}

private enum UnstrapNotificationPayload {
  static func liveActivityPropsJSON(from userInfo: [AnyHashable: Any]) -> String? {
    guard let props = userInfo[UnstrapLiveActivityConstants.liveActivityPropsKey] else {
      return nil
    }

    if let props = props as? String {
      return props
    }

    return encode(props)
  }

  static func fallbackLiveActivityPropsJSON(now: Date = Date()) -> String {
    encode([
      "alarmStatusLabel": "Open Unstrap",
      "batteryCharging": false,
      "batteryLabel": "--%",
      "bedtimeLabel": "--",
      "bedtimeTimestamp": 0,
      "bedtimePassed": false,
      "greetingLabel": "Time to wind down",
      "phaseLabel": "Wind down",
      "projectedSleepLabel": "--",
      "progress": 0,
      "score": NSNull(),
      "scoreLabel": "Waiting for sleep",
      "sleepDebtLabel": "Sync to update",
      "sleepInProgress": false,
      "sleepNeedLabel": "Need --",
      "sleepProgress": 0,
      "sleepThemeActive": true,
      "sleepThemeLabel": "Time to wind down",
      "updatedAtLabel": clockString(now),
      "wakeLabel": "--",
    ]) ?? "{}"
  }

  static func encode(_ value: Any) -> String? {
    guard let jsonValue = jsonReadyValue(value),
          JSONSerialization.isValidJSONObject(jsonValue),
          let data = try? JSONSerialization.data(withJSONObject: jsonValue, options: [.sortedKeys]) else {
      return nil
    }

    return String(data: data, encoding: .utf8)
  }

  private static func jsonReadyValue(_ value: Any) -> Any? {
    if value is NSNull || value is String || value is NSNumber || value is Bool {
      return value
    }

    if let dictionary = value as? [String: Any] {
      return jsonReadyDictionary(dictionary)
    }

    if let dictionary = value as? [AnyHashable: Any] {
      var result: [String: Any] = [:]
      for (key, value) in dictionary {
        guard let key = key as? String, let nextValue = jsonReadyValue(value) else {
          continue
        }
        result[key] = nextValue
      }
      return result
    }

    if let array = value as? [Any] {
      return array.compactMap { jsonReadyValue($0) }
    }

    return nil
  }

  private static func jsonReadyDictionary(_ dictionary: [String: Any]) -> [String: Any] {
    var result: [String: Any] = [:]
    for (key, value) in dictionary {
      guard let nextValue = jsonReadyValue(value) else {
        continue
      }
      result[key] = nextValue
    }
    return result
  }

  private static func clockString(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.dateStyle = .none
    formatter.timeStyle = .short
    return formatter.string(from: date)
  }
}

private struct UnstrapLiveActivityEventStore {
  private let databaseName = "btwearable.db"

  func latestPropsJSON() -> String? {
    withDatabase { database in
      let sql = """
        SELECT payload_json
        FROM app_intent_events
        WHERE kind = 'bedtime_start'
          AND occurred_at <= ?
        ORDER BY occurred_at DESC, id DESC
        LIMIT 1
      """
      var statement: OpaquePointer?
      guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK else {
        return nil
      }
      defer {
        sqlite3_finalize(statement)
      }

      sqlite3_bind_text(statement, 1, sqlDate(Date()), -1, unstrapSqliteTransient)

      guard sqlite3_step(statement) == SQLITE_ROW,
            let payloadText = columnText(statement, 0),
            let payloadData = payloadText.data(using: .utf8),
            let payload = try? JSONSerialization.jsonObject(with: payloadData) as? [String: Any],
            let liveActivityProps = payload[UnstrapLiveActivityConstants.liveActivityPropsKey] else {
        return nil
      }

      return UnstrapNotificationPayload.encode(liveActivityProps)
    }
  }

  private func withDatabase<T>(_ body: (OpaquePointer?) -> T?) -> T? {
    let url = databaseURL()
    var database: OpaquePointer?

    guard sqlite3_open_v2(url.path, &database, SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
      if database != nil {
        sqlite3_close(database)
      }
      return nil
    }

    sqlite3_busy_timeout(database, 1000)
    defer {
      sqlite3_close(database)
    }

    return body(database)
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

  private func columnText(_ statement: OpaquePointer?, _ index: Int32) -> String? {
    guard let value = sqlite3_column_text(statement, index) else {
      return nil
    }

    return String(cString: value)
  }
}
