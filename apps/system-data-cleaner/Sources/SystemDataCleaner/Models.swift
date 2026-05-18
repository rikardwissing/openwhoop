import Foundation

enum CleanupSafety: String, CaseIterable, Sendable {
    case cleanable
    case review
    case protected

    var label: String {
        switch self {
        case .cleanable:
            "Cleanable"
        case .review:
            "Review"
        case .protected:
            "Protected"
        }
    }
}

enum CleanupMode: Sendable {
    case trashContents
    case trashDirectory
    case revealOnly
}

struct ScanDefinition: Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let category: String
    let path: String
    let safety: CleanupSafety
    let cleanupMode: CleanupMode
    let note: String
    let symbolName: String

    var url: URL {
        URL(fileURLWithPath: NSString(string: path).expandingTildeInPath)
    }

    var isCleanable: Bool {
        safety == .cleanable && cleanupMode != .revealOnly
    }
}

struct ScanResult: Identifiable, Hashable, Sendable {
    let definition: ScanDefinition
    let size: Int64
    let itemCount: Int
    let inaccessibleCount: Int
    let scannedAt: Date

    var id: String {
        definition.id
    }
}

struct DeepScanRoot: Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let path: String
    let category: String
    let note: String
    let symbolName: String
    let childDepth: Int

    var url: URL {
        URL(fileURLWithPath: NSString(string: path).expandingTildeInPath)
    }
}

struct LargeFolderResult: Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let rootTitle: String
    let category: String
    let url: URL
    let size: Int64
    let itemCount: Int
    let inaccessibleCount: Int
    let note: String
    let symbolName: String
}

struct FolderTreeNode: Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let rootTitle: String
    let category: String
    let url: URL
    let size: Int64
    let itemCount: Int
    let inaccessibleCount: Int
    let note: String
    let symbolName: String
    let isDirectory: Bool
    let depth: Int

    init(
        title: String,
        rootTitle: String,
        category: String,
        url: URL,
        size: Int64,
        itemCount: Int,
        inaccessibleCount: Int,
        note: String,
        symbolName: String,
        isDirectory: Bool,
        depth: Int
    ) {
        self.id = url.standardizedFileURL.path
        self.title = title
        self.rootTitle = rootTitle
        self.category = category
        self.url = url
        self.size = size
        self.itemCount = itemCount
        self.inaccessibleCount = inaccessibleCount
        self.note = note
        self.symbolName = symbolName
        self.isDirectory = isDirectory
        self.depth = depth
    }

    init(result: LargeFolderResult, depth: Int = 0) {
        self.init(
            title: result.title,
            rootTitle: result.rootTitle,
            category: result.category,
            url: result.url,
            size: result.size,
            itemCount: result.itemCount,
            inaccessibleCount: result.inaccessibleCount,
            note: result.note,
            symbolName: result.symbolName,
            isDirectory: true,
            depth: depth
        )
    }
}

struct ScanActivityItem: Identifiable, Hashable, Sendable {
    let id = UUID()
    let title: String
    let detail: String
    let size: Int64
    let symbolName: String
}

struct ScanActivity: Sendable {
    var title: String
    var currentTitle: String
    var currentPath: String
    var completedSteps: Int
    var totalSteps: Int
    var recentItems: [ScanActivityItem]

    var progress: Double {
        guard totalSteps > 0 else {
            return 0
        }

        return min(max(Double(completedSteps) / Double(totalSteps), 0), 1)
    }
}

struct ForensicScanSummary: Sendable {
    let scannedRootCount: Int
    let largestEntryBytes: Int64
    let deniedCount: Int
    let errorSamples: [String]
    let failedRootCount: Int

    static let empty = ForensicScanSummary(
        scannedRootCount: 0,
        largestEntryBytes: 0,
        deniedCount: 0,
        errorSamples: [],
        failedRootCount: 0
    )
}

struct ForensicScanPayload: Sendable {
    let folders: [LargeFolderResult]
    let summary: ForensicScanSummary
}

struct DiskOverview: Sendable {
    let totalCapacity: Int64
    let availableCapacity: Int64
    let importantAvailableCapacity: Int64?
    let opportunisticAvailableCapacity: Int64?

    var purgeableEstimate: Int64? {
        guard let importantAvailableCapacity, importantAvailableCapacity > availableCapacity else {
            return nil
        }

        return importantAvailableCapacity - availableCapacity
    }

    static func load() -> DiskOverview? {
        let homeURL = FileManager.default.homeDirectoryForCurrentUser
        let keys: Set<URLResourceKey> = [
            .volumeTotalCapacityKey,
            .volumeAvailableCapacityKey,
            .volumeAvailableCapacityForImportantUsageKey,
            .volumeAvailableCapacityForOpportunisticUsageKey
        ]

        guard let values = try? homeURL.resourceValues(forKeys: keys),
              let totalCapacity = values.volumeTotalCapacity,
              let availableCapacity = values.volumeAvailableCapacity else {
            return nil
        }

        return DiskOverview(
            totalCapacity: Int64(totalCapacity),
            availableCapacity: Int64(availableCapacity),
            importantAvailableCapacity: values.volumeAvailableCapacityForImportantUsage,
            opportunisticAvailableCapacity: values.volumeAvailableCapacityForOpportunisticUsage
        )
    }
}

struct SnapshotInfo: Sendable {
    let snapshots: [String]
    let errorMessage: String?

    var count: Int {
        snapshots.count
    }

    static func load() -> SnapshotInfo {
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/tmutil")
        process.arguments = ["listlocalsnapshots", "/"]
        process.standardOutput = pipe
        process.standardError = pipe

        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return SnapshotInfo(snapshots: [], errorMessage: error.localizedDescription)
        }

        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let output = String(data: data, encoding: .utf8) ?? ""

        if process.terminationStatus != 0 {
            return SnapshotInfo(
                snapshots: [],
                errorMessage: output.trimmingCharacters(in: .whitespacesAndNewlines)
            )
        }

        let snapshots = output
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { $0.hasPrefix("com.apple.TimeMachine.") }

        return SnapshotInfo(snapshots: snapshots, errorMessage: nil)
    }
}

struct CleanupFailure: Identifiable, Sendable {
    let id = UUID()
    let path: String
    let message: String
}

struct CleanupSummary: Identifiable, Sendable {
    let id = UUID()
    let movedCount: Int
    let failures: [CleanupFailure]
}

extension Int64 {
    var fileSizeString: String {
        ByteCountFormatter.string(fromByteCount: self, countStyle: .file)
    }
}
