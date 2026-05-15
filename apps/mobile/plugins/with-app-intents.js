const fs = require('fs');
const path = require('path');
const {
  IOSConfig,
  createRunOncePlugin,
  withAppDelegate,
  withXcodeProject,
} = require('@expo/config-plugins');
const { addSwiftImports } = require('@expo/config-plugins/build/ios/codeMod');
const { mergeContents } = require('@expo/config-plugins/build/utils/generateCode');

const PLUGIN_NAME = 'with-app-intents';
const PLUGIN_VERSION = '1.0.0';
const APP_INTENTS_FILE_NAME = 'UnstrapAppIntents.swift';
const SHORTCUT_REFRESH_TAG = 'btwearable-app-intents-shortcut-refresh';
const APP_INTENTS_TEMPLATE_PATH = path.join(
  __dirname,
  'ios-app-intents',
  APP_INTENTS_FILE_NAME,
);

function withAppIntentsSourceFile(config) {
  return IOSConfig.XcodeProjectFile.withBuildSourceFile(config, {
    filePath: APP_INTENTS_FILE_NAME,
    contents: fs.readFileSync(APP_INTENTS_TEMPLATE_PATH, 'utf8'),
    overwrite: true,
  });
}

function withSQLiteFramework(config) {
  return withXcodeProject(config, (nextConfig) => {
    const projectName = IOSConfig.XcodeUtils.getProjectName(
      nextConfig.modRequest.projectRoot,
    );

    IOSConfig.XcodeUtils.addFramework({
      project: nextConfig.modResults,
      projectName,
      framework: 'libsqlite3.tbd',
    });

    return nextConfig;
  });
}

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

function applyAppIntentShortcutRefreshToAppDelegate(src) {
  const contents = addSwiftImports(src, ['AppIntents']);
  const refreshCall = `    if #available(iOS 16.0, *) {
      UnstrapAppShortcuts.updateAppShortcutParameters()
    }`;

  return mergeSwiftSection(
    contents,
    refreshCall,
    SHORTCUT_REFRESH_TAG,
    /^\s*return super\.application\(application, didFinishLaunchingWithOptions: launchOptions\)/,
    0,
  );
}

function withAppIntentShortcutRefresh(config) {
  return withAppDelegate(config, (nextConfig) => {
    if (nextConfig.modResults.language !== 'swift') {
      return nextConfig;
    }

    nextConfig.modResults.contents = applyAppIntentShortcutRefreshToAppDelegate(
      nextConfig.modResults.contents,
    );
    return nextConfig;
  });
}

function withAppIntents(config) {
  config = withAppIntentsSourceFile(config);
  config = withSQLiteFramework(config);
  config = withAppIntentShortcutRefresh(config);
  return config;
}

const plugin = createRunOncePlugin(withAppIntents, PLUGIN_NAME, PLUGIN_VERSION);

module.exports = plugin;
module.exports.withAppIntents = withAppIntents;
module.exports.applyAppIntentShortcutRefreshToAppDelegate = applyAppIntentShortcutRefreshToAppDelegate;
