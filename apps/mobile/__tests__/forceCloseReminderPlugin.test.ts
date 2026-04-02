const {
  applyForceCloseReminderToAppDelegate,
} = require('../plugins/with-force-close-reminder');

const baseAppDelegate = `internal import Expo
import React
import ReactAppDependencyProvider

@main
class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  // Linking API
  public override func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    return super.application(app, open: url, options: options) || RCTLinkingManager.application(app, open: url, options: options)
  }

  // Universal Links
  public override func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    let result = RCTLinkingManager.application(application, continue: userActivity, restorationHandler: restorationHandler)
    return super.application(application, continue: userActivity, restorationHandler: restorationHandler) || result
  }
}

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
  // Extension point for config-plugins

  override func sourceURL(for bridge: RCTBridge) -> URL? {
    // needed to return the correct URL for expo-dev-client.
    bridge.bundleURL ?? bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: ".expo/.virtual-metro-entry")
#else
    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
`;

describe('with-force-close-reminder plugin', () => {
  it('injects the force-close reminder into a clean AppDelegate', () => {
    const result = applyForceCloseReminderToAppDelegate(baseAppDelegate);

    expect(result).toContain('import UserNotifications');
    expect(result).toContain('private let keepAliveReminderNotificationId = "btwearable-keep-open-reminder"');
    expect(result).toContain('clearKeepAliveReminder()');
    expect(result).toContain('public override func applicationWillTerminate(_ application: UIApplication)');
    expect(result).toContain('private extension AppDelegate {');
  });

  it('is idempotent when the transform runs more than once', () => {
    const once = applyForceCloseReminderToAppDelegate(baseAppDelegate);
    const twice = applyForceCloseReminderToAppDelegate(once);

    expect(twice).toBe(once);
    expect(
      (twice.match(/public override func applicationWillTerminate\(_ application: UIApplication\)/g) ??
        []).length,
    ).toBe(1);
    expect((twice.match(/private extension AppDelegate/g) ?? []).length).toBe(1);
  });
});
