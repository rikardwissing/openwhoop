const { createRunOncePlugin, withEntitlementsPlist, withInfoPlist } = require('@expo/config-plugins');

function withLocalNotificationsOnly(config) {
  config = withEntitlementsPlist(config, (nextConfig) => {
    delete nextConfig.modResults['aps-environment'];
    return nextConfig;
  });

  config = withInfoPlist(config, (nextConfig) => {
    if (Array.isArray(nextConfig.modResults.UIBackgroundModes)) {
      nextConfig.modResults.UIBackgroundModes = nextConfig.modResults.UIBackgroundModes.filter(
        (mode) => mode !== 'remote-notification',
      );

      if (nextConfig.modResults.UIBackgroundModes.length === 0) {
        delete nextConfig.modResults.UIBackgroundModes;
      }
    }

    return nextConfig;
  });

  return config;
}

module.exports = createRunOncePlugin(
  withLocalNotificationsOnly,
  'with-local-notifications-only',
  '1.0.0',
);
