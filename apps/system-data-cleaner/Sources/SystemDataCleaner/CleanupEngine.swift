import Foundation

enum CleanupEngine {
    static func moveToTrash(definitions: [ScanDefinition]) -> CleanupSummary {
        let fileManager = FileManager.default
        var movedCount = 0
        var failures: [CleanupFailure] = []

        for definition in definitions {
            guard definition.isCleanable else {
                continue
            }

            switch definition.cleanupMode {
            case .trashContents:
                do {
                    let children = try fileManager.contentsOfDirectory(
                        at: definition.url,
                        includingPropertiesForKeys: nil,
                        options: []
                    )

                    for child in children {
                        do {
                            try fileManager.trashItem(at: child, resultingItemURL: nil)
                            movedCount += 1
                        } catch {
                            failures.append(CleanupFailure(path: child.path, message: error.localizedDescription))
                        }
                    }
                } catch {
                    failures.append(CleanupFailure(path: definition.url.path, message: error.localizedDescription))
                }

            case .trashDirectory:
                do {
                    try fileManager.trashItem(at: definition.url, resultingItemURL: nil)
                    movedCount += 1
                } catch {
                    failures.append(CleanupFailure(path: definition.url.path, message: error.localizedDescription))
                }

            case .revealOnly:
                break
            }
        }

        return CleanupSummary(movedCount: movedCount, failures: failures)
    }
}
