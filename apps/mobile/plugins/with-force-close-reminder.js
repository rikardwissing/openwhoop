const { createRunOncePlugin, withAppDelegate } = require('@expo/config-plugins');
const {
  addSwiftImports,
  insertContentsInsideSwiftClassBlock,
} = require('@expo/config-plugins/build/ios/codeMod');
const { mergeContents } = require('@expo/config-plugins/build/utils/generateCode');

const PLUGIN_NAME = 'with-force-close-reminder';
const PLUGIN_VERSION = '1.0.0';

const CONSTANTS_TAG = 'btwearable-force-close-reminder-constants';
const DID_FINISH_TAG = 'btwearable-force-close-reminder-launch';
const LIFECYCLE_TAG = 'btwearable-force-close-reminder-lifecycle';
const HELPERS_TAG = 'btwearable-force-close-reminder-helpers';

const REMINDER_CONSTANTS = `private let keepAliveReminderDeliveredClearDelaySeconds: TimeInterval = 3
private let keepAliveReminderRequests: [(identifier: String, delaySeconds: TimeInterval, title: String, body: String)] = [
  (
    identifier: "btwearable-keep-open-reminder",
    delaySeconds: 1,
    title: "Keep Unstrap open in the background",
    body: "If you fully close Unstrap, iPhone is less likely to keep your wearable insights syncing in the background."
  ),
  (
    identifier: "btwearable-keep-open-reminder-1h",
    delaySeconds: 10 * 60,
    title: "Unstrap is still closed",
    body: "Unstrap has been closed for 10 minutes. Reopen it to help keep your wearable insights syncing."
  ),
  (
    identifier: "btwearable-keep-open-reminder-1h",
    delaySeconds: 60 * 60,
    title: "Unstrap is still closed",
    body: "Unstrap has been closed for 1 hour. Reopen it to help keep your wearable insights syncing."
  ),
  (
    identifier: "btwearable-keep-open-reminder-3h",
    delaySeconds: 3 * 60 * 60,
    title: "Unstrap is still closed",
    body: "Unstrap has been closed for 3 hours. Reopen it to help keep your wearable insights syncing."
  ),
  (
    identifier: "btwearable-keep-open-reminder-12h",
    delaySeconds: 12 * 60 * 60,
    title: "Unstrap is still closed",
    body: "Unstrap has been closed for 12 hours. Reopen it to help keep your wearable insights syncing."
  ),
  (
    identifier: "btwearable-keep-open-reminder-24h",
    delaySeconds: 24 * 60 * 60,
    title: "Unstrap is still closed",
    body: "Unstrap has been closed for 24 hours. Reopen it to help keep your wearable insights syncing."
  ),
]`;

const DID_FINISH_CALL = '    clearPendingKeepAliveReminder()';

const LIFECYCLE_METHODS = `  public override func applicationDidBecomeActive(_ application: UIApplication) {
    clearKeepAliveReminder()
    super.applicationDidBecomeActive(application)
  }

  public override func applicationWillTerminate(_ application: UIApplication) {
    scheduleKeepAliveReminder()
    super.applicationWillTerminate(application)
  }`;

const HELPER_EXTENSION = `private extension AppDelegate {
  func keepAliveReminderNotificationIds() -> [String] {
    keepAliveReminderRequests.map { $0.identifier }
  }

  func clearPendingKeepAliveReminder() {
    let center = UNUserNotificationCenter.current()
    center.removePendingNotificationRequests(withIdentifiers: keepAliveReminderNotificationIds())
  }

  func clearKeepAliveReminder() {
    let center = UNUserNotificationCenter.current()
    let identifiers = keepAliveReminderNotificationIds()
    center.removePendingNotificationRequests(withIdentifiers: identifiers)

    DispatchQueue.main.asyncAfter(deadline: .now() + keepAliveReminderDeliveredClearDelaySeconds) {
      center.removeDeliveredNotifications(withIdentifiers: identifiers)
    }
  }

  func scheduleKeepAliveReminder() {
    let center = UNUserNotificationCenter.current()
    center.removePendingNotificationRequests(withIdentifiers: keepAliveReminderNotificationIds())

    for reminder in keepAliveReminderRequests {
      let content = UNMutableNotificationContent()
      content.title = reminder.title
      content.body = reminder.body
      content.sound = nil

      let trigger = UNTimeIntervalNotificationTrigger(
        timeInterval: reminder.delaySeconds,
        repeats: false
      )

      let request = UNNotificationRequest(
        identifier: reminder.identifier,
        content: content,
        trigger: trigger
      )

      center.add(request)
    }
  }
}`;

function mergeSwiftSection(src, newSrc, tag, anchor, offset = 0) {
  return mergeContents({
    src,
    newSrc,
    tag,
    anchor,
    offset,
    comment: '//',
  }).contents;
}

function insertLifecycleMethods(src) {
  if (src.includes(`@generated begin ${LIFECYCLE_TAG}`)) {
    return mergeSwiftSection(src, LIFECYCLE_METHODS, LIFECYCLE_TAG, /^\s*\/\/ Linking API$/, 0);
  }

  if (
    src.includes('public override func applicationDidBecomeActive(_ application: UIApplication)') ||
    src.includes('public override func applicationWillTerminate(_ application: UIApplication)')
  ) {
    return src;
  }

  try {
    return mergeSwiftSection(src, LIFECYCLE_METHODS, LIFECYCLE_TAG, /^\s*\/\/ Linking API$/, 0);
  } catch {
    return insertContentsInsideSwiftClassBlock(src, 'class AppDelegate', `\n\n${LIFECYCLE_METHODS}\n`, {
      position: 'tail',
    });
  }
}

function insertHelperExtension(src) {
  if (src.includes(`@generated begin ${HELPERS_TAG}`)) {
    return mergeSwiftSection(src, HELPER_EXTENSION, HELPERS_TAG, /^class ReactNativeDelegate/, 0);
  }

  if (src.includes('private extension AppDelegate {')) {
    return src;
  }

  try {
    return mergeSwiftSection(src, HELPER_EXTENSION, HELPERS_TAG, /^class ReactNativeDelegate/, 0);
  } catch {
    return `${src}\n\n${HELPER_EXTENSION}\n`;
  }
}

function applyForceCloseReminderToAppDelegate(src) {
  let contents = addSwiftImports(src, ['UserNotifications']);
  contents = mergeSwiftSection(contents, REMINDER_CONSTANTS, CONSTANTS_TAG, /^@main$/, 0);
  contents = mergeSwiftSection(
    contents,
    DID_FINISH_CALL,
    DID_FINISH_TAG,
    /^\s*return super\.application\(application, didFinishLaunchingWithOptions: launchOptions\)/,
    0,
  );
  contents = insertLifecycleMethods(contents);
  contents = insertHelperExtension(contents);
  return contents;
}

function withForceCloseReminder(config) {
  return withAppDelegate(config, (nextConfig) => {
    if (nextConfig.modResults.language !== 'swift') {
      return nextConfig;
    }

    nextConfig.modResults.contents = applyForceCloseReminderToAppDelegate(
      nextConfig.modResults.contents,
    );
    return nextConfig;
  });
}

const plugin = createRunOncePlugin(withForceCloseReminder, PLUGIN_NAME, PLUGIN_VERSION);

module.exports = plugin;
module.exports.withForceCloseReminder = withForceCloseReminder;
module.exports.applyForceCloseReminderToAppDelegate = applyForceCloseReminderToAppDelegate;
