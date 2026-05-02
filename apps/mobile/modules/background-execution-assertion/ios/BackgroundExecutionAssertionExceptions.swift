import ExpoModulesCore

internal final class BackgroundExecutionAssertionUnavailableException: Exception {
  override var reason: String {
    "Unable to begin an iOS background execution assertion."
  }
}
