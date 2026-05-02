import ExpoModulesCore
import UIKit

public class BackgroundExecutionAssertionModule: Module {
  private let lock = NSLock()
  private var nextIdentifier = 1
  private var tasks: [Int: UIBackgroundTaskIdentifier] = [:]

  public func definition() -> ModuleDefinition {
    Name("BackgroundExecutionAssertion")

    AsyncFunction("begin") { (name: String) -> Int in
      var nativeIdentifier = UIBackgroundTaskIdentifier.invalid
      let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
      let taskName = trimmedName.isEmpty ? "BackgroundExecutionAssertion" : trimmedName

      nativeIdentifier = UIApplication.shared.beginBackgroundTask(withName: taskName) { [weak self] in
        guard nativeIdentifier != .invalid else {
          return
        }

        self?.removeAssertion(nativeIdentifier: nativeIdentifier)
        UIApplication.shared.endBackgroundTask(nativeIdentifier)
        nativeIdentifier = .invalid
      }

      if nativeIdentifier == .invalid {
        throw BackgroundExecutionAssertionUnavailableException()
      }

      return self.storeAssertion(nativeIdentifier: nativeIdentifier)
    }
    .runOnQueue(.main)

    AsyncFunction("end") { (identifier: Int) in
      guard let nativeIdentifier = self.takeAssertion(identifier: identifier) else {
        return
      }

      UIApplication.shared.endBackgroundTask(nativeIdentifier)
    }
    .runOnQueue(.main)
  }

  private func storeAssertion(nativeIdentifier: UIBackgroundTaskIdentifier) -> Int {
    lock.lock()
    defer {
      lock.unlock()
    }

    let identifier = nextIdentifier
    nextIdentifier += 1
    tasks[identifier] = nativeIdentifier
    return identifier
  }

  private func takeAssertion(identifier: Int) -> UIBackgroundTaskIdentifier? {
    lock.lock()
    defer {
      lock.unlock()
    }

    return tasks.removeValue(forKey: identifier)
  }

  private func removeAssertion(nativeIdentifier: UIBackgroundTaskIdentifier) {
    lock.lock()
    defer {
      lock.unlock()
    }

    tasks = tasks.filter { $0.value != nativeIdentifier }
  }
}
