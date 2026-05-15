require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'UnstrapLiveActivityIntents'
  s.version        = package['version']
  s.summary        = 'Unstrap Live Activity App Intents.'
  s.description    = 'Starts the Unstrap sleep Live Activity from App Intents and notification actions.'
  s.license        = { :type => 'MIT' }
  s.author         = 'Unstrap'
  s.homepage       = 'https://github.com/rikardwissing/btwearable'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { :git => 'https://github.com/rikardwissing/btwearable.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'ExpoNotifications'
  s.dependency 'ExpoWidgets'
  s.libraries = 'sqlite3'
  s.source_files = '**/*.{h,m,mm,swift}'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
