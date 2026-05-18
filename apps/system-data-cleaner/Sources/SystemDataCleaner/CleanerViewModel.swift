import AppKit
import Foundation

@MainActor
final class CleanerViewModel: ObservableObject {
    @Published private(set) var results: [ScanResult] = []
    @Published private(set) var largeFolders: [LargeFolderResult] = []
    @Published private(set) var forensicFolders: [LargeFolderResult] = []
    @Published private(set) var forensicSummary = ForensicScanSummary.empty
    @Published private(set) var scanActivity: ScanActivity?
    @Published private(set) var treeChildrenByID: [String: [FolderTreeNode]] = [:]
    @Published private(set) var expandedTreeNodeIDs: Set<String> = []
    @Published private(set) var loadingTreeNodeIDs: Set<String> = []
    @Published private(set) var diskOverview: DiskOverview?
    @Published private(set) var snapshotInfo = SnapshotInfo(snapshots: [], errorMessage: nil)
    @Published private(set) var isScanning = false
    @Published private(set) var isCleaning = false
    @Published private(set) var scanIncludedDeepFolders = false
    @Published private(set) var scanIncludedForensicFolders = false
    @Published private(set) var lastCleanupSummary: CleanupSummary?
    @Published var selectedIDs: Set<String> = []

    var foundBytes: Int64 {
        results.reduce(0) { $0 + $1.size }
    }

    var selectedBytes: Int64 {
        results
            .filter { selectedIDs.contains($0.id) && $0.definition.isCleanable }
            .reduce(0) { $0 + $1.size }
    }

    var selectedCleanableResults: [ScanResult] {
        results.filter { selectedIDs.contains($0.id) && $0.definition.isCleanable }
    }

    var largestFolderBytes: Int64 {
        largeFolders.reduce(0) { $0 + $1.size }
    }

    var topForensicFolderBytes: Int64 {
        forensicSummary.largestEntryBytes
    }

    func scan(deep: Bool = false, forensic: Bool = false) {
        guard !isScanning else {
            return
        }

        Task {
            await scanNow(deep: deep, forensic: forensic)
        }
    }

    func scanNow(deep: Bool = false, forensic: Bool = false) async {
        isScanning = true
        scanIncludedDeepFolders = deep || forensic
        scanIncludedForensicFolders = forensic
        lastCleanupSummary = nil
        results = []
        largeFolders = []
        forensicFolders = []
        forensicSummary = .empty
        treeChildrenByID = [:]
        expandedTreeNodeIDs = []
        loadingTreeNodeIDs = []
        selectedIDs = []

        let definitions = ScanCatalog.definitions()
        let deepRoots = (deep || forensic) ? ScanCatalog.deepScanRoots() : []
        let forensicRoots = forensic ? ScanCatalog.forensicScanRoots() : []
        let totalSteps = definitions.count + deepRoots.count + forensicRoots.count + 2
        var completedSteps = 0

        beginScanActivity(title: scanTitle(deep: deep, forensic: forensic), totalSteps: totalSteps)

        updateScanActivity(
            currentTitle: "Reading disk capacity",
            currentPath: FileManager.default.homeDirectoryForCurrentUser.path,
            completedSteps: completedSteps
        )
        diskOverview = await Task.detached(priority: .userInitiated) {
            DiskOverview.load()
        }.value
        completedSteps += 1
        updateScanActivity(completedSteps: completedSteps)

        updateScanActivity(
            currentTitle: "Checking Time Machine snapshots",
            currentPath: "/",
            completedSteps: completedSteps
        )
        snapshotInfo = await Task.detached(priority: .userInitiated) {
            SnapshotInfo.load()
        }.value
        completedSteps += 1
        updateScanActivity(completedSteps: completedSteps)

        for definition in definitions {
            updateScanActivity(
                currentTitle: definition.title,
                currentPath: definition.url.path,
                completedSteps: completedSteps
            )

            let result = await Task.detached(priority: .userInitiated) {
                DiskScanner.scan(definition: definition)
            }.value
            if let result {
                upsert(result)
                pushRecentItem(
                    title: result.definition.title,
                    detail: result.definition.url.path,
                    size: result.size,
                    symbolName: result.definition.symbolName
                )
            }

            completedSteps += 1
            updateScanActivity(completedSteps: completedSteps)
        }

        for root in deepRoots {
            updateScanActivity(
                currentTitle: root.title,
                currentPath: root.url.path,
                completedSteps: completedSteps
            )

            let folders = await Task.detached(priority: .userInitiated) {
                DiskScanner.scanLargeFolders(root: root)
            }.value
            largeFolders = mergeLargeFolderResults(largeFolders, with: folders, limit: 160)
            pushRecentItems(from: folders.prefix(3))

            completedSteps += 1
            updateScanActivity(completedSteps: completedSteps)
        }

        for root in forensicRoots {
            updateScanActivity(
                currentTitle: root.title,
                currentPath: root.url.path,
                completedSteps: completedSteps
            )

            let payload = await Task.detached(priority: .userInitiated) {
                ForensicScanner.scan(root: root)
            }.value
            forensicFolders = mergeLargeFolderResults(forensicFolders, with: payload.folders, limit: 250)
            forensicSummary = mergeForensicSummary(forensicSummary, with: payload.summary)
            forensicSummary = ForensicScanSummary(
                scannedRootCount: forensicSummary.scannedRootCount,
                largestEntryBytes: forensicFolders.first?.size ?? 0,
                deniedCount: forensicSummary.deniedCount,
                errorSamples: forensicSummary.errorSamples,
                failedRootCount: forensicSummary.failedRootCount
            )
            pushRecentItems(from: payload.folders.prefix(4))

            completedSteps += 1
            updateScanActivity(completedSteps: completedSteps)
        }

        selectedIDs = Set(
            results
                .filter { $0.definition.isCleanable && $0.size > 0 }
                .map(\.id)
        )

        isScanning = false
        updateScanActivity(
            currentTitle: "Scan complete",
            currentPath: "",
            completedSteps: totalSteps
        )
    }

    func moveSelectedToTrash() {
        let definitions = selectedCleanableResults.map(\.definition)
        guard !definitions.isEmpty else {
            return
        }

        Task {
            isCleaning = true
            let summary = await Task.detached(priority: .userInitiated) {
                CleanupEngine.moveToTrash(definitions: definitions)
            }.value

            lastCleanupSummary = summary
            isCleaning = false
            await scanNow(deep: scanIncludedDeepFolders, forensic: scanIncludedForensicFolders)
            lastCleanupSummary = summary
        }
    }

    func reveal(_ result: ScanResult) {
        NSWorkspace.shared.activateFileViewerSelecting([result.definition.url])
    }

    func reveal(_ result: LargeFolderResult) {
        NSWorkspace.shared.activateFileViewerSelecting([result.url])
    }

    func reveal(_ node: FolderTreeNode) {
        NSWorkspace.shared.activateFileViewerSelecting([node.url])
    }

    func treeRoots(forensic: Bool) -> [FolderTreeNode] {
        let source = forensic ? forensicFolders : largeFolders
        return source.map { FolderTreeNode(result: $0) }
    }

    func treeChildren(for node: FolderTreeNode) -> [FolderTreeNode] {
        treeChildrenByID[node.id] ?? []
    }

    func toggleExpanded(_ node: FolderTreeNode) {
        guard node.isDirectory else {
            return
        }

        if expandedTreeNodeIDs.contains(node.id) {
            expandedTreeNodeIDs.remove(node.id)
            return
        }

        expandedTreeNodeIDs.insert(node.id)

        if treeChildrenByID[node.id] == nil {
            loadChildren(for: node)
        }
    }

    func toggleSelection(for result: ScanResult, isSelected: Bool) {
        guard result.definition.isCleanable else {
            selectedIDs.remove(result.id)
            return
        }

        if isSelected {
            selectedIDs.insert(result.id)
        } else {
            selectedIDs.remove(result.id)
        }
    }

    func selectAllCleanable() {
        selectedIDs = Set(results.filter { $0.definition.isCleanable && $0.size > 0 }.map(\.id))
    }

    func clearSelection() {
        selectedIDs.removeAll()
    }

    func copySnapshotThinCommand() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString("sudo tmutil thinlocalsnapshots / 20000000000 4", forType: .string)
    }

    private func loadChildren(for node: FolderTreeNode) {
        guard !loadingTreeNodeIDs.contains(node.id) else {
            return
        }

        loadingTreeNodeIDs.insert(node.id)

        Task {
            let children = await Task.detached(priority: .userInitiated) {
                DiskScanner.scanTreeChildren(of: node)
            }.value

            treeChildrenByID[node.id] = children
            loadingTreeNodeIDs.remove(node.id)
        }
    }

    private func scanTitle(deep: Bool, forensic: Bool) -> String {
        if forensic {
            return "Forensic scan"
        }

        if deep {
            return "Deep scan"
        }

        return "Quick scan"
    }

    private func beginScanActivity(title: String, totalSteps: Int) {
        scanActivity = ScanActivity(
            title: title,
            currentTitle: "Preparing scan",
            currentPath: "",
            completedSteps: 0,
            totalSteps: totalSteps,
            recentItems: []
        )
    }

    private func updateScanActivity(
        currentTitle: String? = nil,
        currentPath: String? = nil,
        completedSteps: Int? = nil
    ) {
        guard var activity = scanActivity else {
            return
        }

        if let currentTitle {
            activity.currentTitle = currentTitle
        }

        if let currentPath {
            activity.currentPath = currentPath
        }

        if let completedSteps {
            activity.completedSteps = completedSteps
        }

        scanActivity = activity
    }

    private func upsert(_ result: ScanResult) {
        results.removeAll { $0.id == result.id }
        results.append(result)
        results.sort { left, right in
            if left.size == right.size {
                return left.definition.title < right.definition.title
            }

            return left.size > right.size
        }

        if result.definition.isCleanable && result.size > 0 {
            selectedIDs.insert(result.id)
        }
    }

    private func pushRecentItems(from folders: ArraySlice<LargeFolderResult>) {
        for folder in folders.reversed() {
            pushRecentItem(
                title: folder.title,
                detail: folder.url.path,
                size: folder.size,
                symbolName: folder.symbolName
            )
        }
    }

    private func pushRecentItem(title: String, detail: String, size: Int64, symbolName: String) {
        guard size > 0, var activity = scanActivity else {
            return
        }

        activity.recentItems.insert(
            ScanActivityItem(
                title: title,
                detail: detail,
                size: size,
                symbolName: symbolName
            ),
            at: 0
        )
        activity.recentItems = Array(activity.recentItems.prefix(6))
        scanActivity = activity
    }

    private func mergeLargeFolderResults(
        _ existing: [LargeFolderResult],
        with incoming: [LargeFolderResult],
        limit: Int
    ) -> [LargeFolderResult] {
        var byPath = Dictionary(uniqueKeysWithValues: existing.map { ($0.url.standardizedFileURL.path, $0) })

        for result in incoming {
            byPath[result.url.standardizedFileURL.path] = result
        }

        return Array(byPath.values)
            .sorted { left, right in
                if left.size == right.size {
                    return left.url.path < right.url.path
                }

                return left.size > right.size
            }
            .prefix(limit)
            .map { $0 }
    }

    private func mergeForensicSummary(
        _ existing: ForensicScanSummary,
        with incoming: ForensicScanSummary
    ) -> ForensicScanSummary {
        ForensicScanSummary(
            scannedRootCount: existing.scannedRootCount + incoming.scannedRootCount,
            largestEntryBytes: max(existing.largestEntryBytes, incoming.largestEntryBytes),
            deniedCount: existing.deniedCount + incoming.deniedCount,
            errorSamples: Array((existing.errorSamples + incoming.errorSamples).prefix(6)),
            failedRootCount: existing.failedRootCount + incoming.failedRootCount
        )
    }
}
