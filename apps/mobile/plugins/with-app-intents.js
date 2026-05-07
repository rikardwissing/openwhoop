const fs = require('fs');
const path = require('path');
const {
  IOSConfig,
  createRunOncePlugin,
  withXcodeProject,
} = require('@expo/config-plugins');

const PLUGIN_NAME = 'with-app-intents';
const PLUGIN_VERSION = '1.0.0';
const APP_INTENTS_FILE_NAME = 'UnstrapAppIntents.swift';
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

function withAppIntents(config) {
  config = withAppIntentsSourceFile(config);
  config = withSQLiteFramework(config);
  return config;
}

const plugin = createRunOncePlugin(withAppIntents, PLUGIN_NAME, PLUGIN_VERSION);

module.exports = plugin;
module.exports.withAppIntents = withAppIntents;
