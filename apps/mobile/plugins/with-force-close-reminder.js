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

const REMINDER_CONSTANTS = `private let keepAliveReminderNotificationId = "btwearable-keep-open-reminder"
private let keepAliveReminderDelaySeconds: TimeInterval = 1
private let keepAliveReminderRoute = "/settings"`;

const DID_FINISH_CALL = '    clearKeepAliveReminder()';

const LIFECYCLE_METHODS = `  public override func applicationDidBecomeActive(_ application: UIApplication) {
    clearKeepAliveReminder()
    super.applicationDidBecomeActive(application)
  }

  public override func applicationWillTerminate(_ application: UIApplication) {
    scheduleKeepAliveReminder()
    super.applicationWillTerminate(application)
  }`;

const HELPER_EXTENSION = `private extension AppDelegate {
  func clearKeepAliveReminder() {
    let center = UNUserNotificationCenter.current()
    center.removePendingNotificationRequests(withIdentifiers: [keepAliveReminderNotificationId])
    center.removeDeliveredNotifications(withIdentifiers: [keepAliveReminderNotificationId])
  }

  func scheduleKeepAliveReminder() {
    let content = UNMutableNotificationContent()
    content.title = "Keep Unstrap open in the background"
    content.body = "If you fully close Unstrap, iPhone is less likely to keep your wearable insights syncing in the background."
    content.sound = nil
    content.userInfo = [
      "route": keepAliveReminderRoute
    ]

    let trigger = UNTimeIntervalNotificationTrigger(
      timeInterval: keepAliveReminderDelaySeconds,
      repeats: false
    )

    let request = UNNotificationRequest(
      identifier: keepAliveReminderNotificationId,
      content: content,
      trigger: trigger
    )

    let center = UNUserNotificationCenter.current()
    center.removePendingNotificationRequests(withIdentifiers: [keepAliveReminderNotificationId])
    center.add(request)
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
