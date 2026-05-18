import SwiftUI

enum ResultFilter: String, CaseIterable, Identifiable {
    case all = "All"
    case cleanable = "Cleanable"
    case review = "Review"
    case protected = "Protected"
    case largest = "Largest"
    case forensic = "Forensic"

    var id: String {
        rawValue
    }
}

struct ContentView: View {
    @StateObject private var model = CleanerViewModel()
    @State private var filter = ResultFilter.all
    @State private var showingCleanupAlert = false
    @State private var copiedSnapshotCommand = false

    private var filteredResults: [ScanResult] {
        switch filter {
        case .all:
            model.results
        case .cleanable:
            model.results.filter { $0.definition.safety == .cleanable }
        case .review:
            model.results.filter { $0.definition.safety == .review }
        case .protected:
            model.results.filter { $0.definition.safety == .protected }
        case .largest:
            []
        case .forensic:
            []
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            header

            Divider()

            HStack(spacing: 0) {
                sidebar

                Divider()

                VStack(spacing: 0) {
                    resultToolbar
                    resultList
                    statusBar
                }
            }
        }
        .frame(minWidth: 980, minHeight: 640)
        .task {
            if model.results.isEmpty {
                model.scan()
            }
        }
        .alert("Move selected items to Trash?", isPresented: $showingCleanupAlert) {
            Button("Move to Trash", role: .destructive) {
                model.moveSelectedToTrash()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("\(model.selectedCleanableResults.count) locations, \(model.selectedBytes.fileSizeString).")
        }
    }

    private var header: some View {
        HStack(spacing: 14) {
            Image(systemName: "internaldrive")
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(.blue)

            VStack(alignment: .leading, spacing: 3) {
                Text("System Data Cleaner")
                    .font(.title2.weight(.semibold))
                Text("macOS storage scan")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            Button {
                model.scan(deep: false)
            } label: {
                Label("Quick Scan", systemImage: "arrow.clockwise")
            }
            .disabled(model.isScanning || model.isCleaning)
            .keyboardShortcut("r", modifiers: .command)

            Button {
                model.scan(deep: true)
                filter = .largest
            } label: {
                Label(model.isScanning ? "Scanning" : "Deep Scan", systemImage: "scope")
            }
            .disabled(model.isScanning || model.isCleaning)

            Button {
                model.scan(deep: true, forensic: true)
                filter = .forensic
            } label: {
                Label("Forensic Scan", systemImage: "waveform.path.ecg.rectangle")
            }
            .disabled(model.isScanning || model.isCleaning)
            .help("Runs a broader APFS/Data-volume scan. This can take several minutes.")

            Button {
                showingCleanupAlert = true
            } label: {
                Label("Move to Trash", systemImage: "trash")
            }
            .buttonStyle(.borderedProminent)
            .tint(.red)
            .disabled(model.selectedCleanableResults.isEmpty || model.isScanning || model.isCleaning)
        }
        .padding(.horizontal, 22)
        .padding(.vertical, 16)
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 18) {
            MetricView(
                title: "Found",
                value: model.foundBytes.fileSizeString,
                symbolName: "magnifyingglass.circle"
            )

            MetricView(
                title: "Selected",
                value: model.selectedBytes.fileSizeString,
                symbolName: "checkmark.circle"
            )

            if model.scanIncludedDeepFolders {
                MetricView(
                    title: "Largest list",
                    value: model.largestFolderBytes.fileSizeString,
                    symbolName: "list.bullet.rectangle"
                )
            }

            if model.scanIncludedForensicFolders {
                MetricView(
                    title: "Top forensic",
                    value: model.topForensicFolderBytes.fileSizeString,
                    symbolName: "waveform.path.ecg.rectangle"
                )
            }

            if let overview = model.diskOverview {
                Divider()

                MetricView(
                    title: "Available",
                    value: overview.availableCapacity.fileSizeString,
                    symbolName: "internaldrive"
                )

                if let purgeableEstimate = overview.purgeableEstimate {
                    MetricView(
                        title: "Purgeable",
                        value: purgeableEstimate.fileSizeString,
                        symbolName: "sparkles"
                    )
                }

                CapacityBar(overview: overview)
            }

            Divider()

            SnapshotView(
                snapshotInfo: model.snapshotInfo,
                copiedCommand: copiedSnapshotCommand,
                copyCommand: {
                    model.copySnapshotThinCommand()
                    copiedSnapshotCommand = true
                }
            )

            if model.scanIncludedForensicFolders {
                Divider()

                ForensicSummaryView(summary: model.forensicSummary)
            }

            Spacer()
        }
        .padding(20)
        .frame(width: 260)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var resultToolbar: some View {
        HStack(spacing: 12) {
            Picker("Filter", selection: $filter) {
                ForEach(ResultFilter.allCases) { filter in
                    Text(filter.rawValue).tag(filter)
                }
            }
            .pickerStyle(.segmented)
            .frame(width: 450)

            Spacer()

            Button {
                model.selectAllCleanable()
            } label: {
                Label("Select Cleanable", systemImage: "checklist.checked")
            }
            .disabled(model.isScanning || model.isCleaning)

            Button {
                model.clearSelection()
            } label: {
                Label("Clear", systemImage: "xmark.circle")
            }
            .disabled(model.selectedIDs.isEmpty || model.isScanning || model.isCleaning)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
        .background(Color(nsColor: .controlBackgroundColor))
    }

    private var resultList: some View {
        Group {
            if filter == .largest {
                largeFolderList
            } else if filter == .forensic {
                forensicFolderList
            } else if model.isScanning || !filteredResults.isEmpty {
                ScrollView {
                    LazyVStack(spacing: 8) {
                        liveScanPanel

                        ForEach(filteredResults) { result in
                            ResultRow(
                                result: result,
                                isSelected: model.selectedIDs.contains(result.id),
                                isBusy: model.isScanning || model.isCleaning,
                                onSelect: { isSelected in
                                    model.toggleSelection(for: result, isSelected: isSelected)
                                },
                                onReveal: {
                                    model.reveal(result)
                                }
                            )
                        }
                    }
                    .padding(16)
                    .animation(.easeInOut(duration: 0.18), value: filteredResults.map(\.id))
                }
            } else if filteredResults.isEmpty {
                ContentUnavailableView("No matching locations", systemImage: "tray")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .textBackgroundColor))
    }

    private var statusBar: some View {
        HStack {
            if model.isCleaning {
                ProgressView()
                    .scaleEffect(0.6)
                Text("Moving selected items to Trash")
                    .foregroundStyle(.secondary)
            } else if model.isScanning {
                ProgressView()
                    .scaleEffect(0.6)
                Group {
                    if let activity = model.scanActivity {
                        Text("\(activity.title): \(activity.currentTitle) • \(activity.completedSteps)/\(activity.totalSteps)")
                            .lineLimit(1)
                            .truncationMode(.middle)
                    } else {
                        Text("Scanning")
                    }
                }
                .foregroundStyle(.secondary)
            } else if let summary = model.lastCleanupSummary {
                let failureText = summary.failures.isEmpty ? "" : " • \(summary.failures.count) failed"
                Text("Moved \(summary.movedCount) items to Trash\(failureText)")
                    .foregroundStyle(summary.failures.isEmpty ? Color.secondary : Color.orange)
            } else {
                if model.scanIncludedForensicFolders {
                    Text("\(model.results.count) locations scanned • \(model.largeFolders.count) large folders • \(model.forensicFolders.count) forensic entries")
                } else if model.scanIncludedDeepFolders {
                    Text("\(model.results.count) locations scanned • \(model.largeFolders.count) large folders found")
                } else {
                    Text("\(model.results.count) locations scanned")
                }
            }

            Spacer()
        }
        .font(.footnote)
        .padding(.horizontal, 18)
        .padding(.vertical, 8)
        .background(Color(nsColor: .controlBackgroundColor))
    }

    private var largeFolderList: some View {
        Group {
            if !model.scanIncludedDeepFolders && !model.isScanning {
                ContentUnavailableView {
                    Label("Run a deep scan", systemImage: "scope")
                } description: {
                    Text("Deep scan breaks down large folders under Library, Containers, Developer, Trash, and temporary system areas.")
                } actions: {
                    Button {
                        model.scan(deep: true)
                    } label: {
                        Label("Deep Scan", systemImage: "scope")
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if model.largeFolders.isEmpty && !model.isScanning {
                ContentUnavailableView("No folders over 1 GB", systemImage: "checkmark.circle")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 8) {
                        liveScanPanel

                        ForEach(model.treeRoots(forensic: false)) { node in
                            FolderTreeRow(
                                node: node,
                                model: model
                            )
                        }
                    }
                    .padding(16)
                    .animation(.easeInOut(duration: 0.18), value: model.largeFolders.map(\.id))
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .textBackgroundColor))
    }

    private var forensicFolderList: some View {
        Group {
            if !model.scanIncludedForensicFolders && !model.isScanning {
                ContentUnavailableView {
                    Label("Run a forensic scan", systemImage: "waveform.path.ecg.rectangle")
                } description: {
                    Text("Forensic scan uses macOS disk usage accounting across APFS Data, VM, Update, and Preboot volumes.")
                } actions: {
                    Button {
                        model.scan(deep: true, forensic: true)
                    } label: {
                        Label("Forensic Scan", systemImage: "waveform.path.ecg.rectangle")
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if model.forensicFolders.isEmpty && !model.isScanning {
                ContentUnavailableView("No forensic entries over 500 MB", systemImage: "checkmark.circle")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 8) {
                        liveScanPanel

                        if model.forensicSummary.deniedCount > 0 {
                            PermissionBanner(summary: model.forensicSummary)
                        }

                        ForEach(model.treeRoots(forensic: true)) { node in
                            FolderTreeRow(
                                node: node,
                                model: model
                            )
                        }
                    }
                    .padding(16)
                    .animation(.easeInOut(duration: 0.18), value: model.forensicFolders.map(\.id))
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .textBackgroundColor))
    }

    @ViewBuilder
    private var liveScanPanel: some View {
        if model.isScanning, let activity = model.scanActivity {
            LiveScanPanel(activity: activity)
                .transition(.opacity.combined(with: .move(edge: .top)))
        }
    }
}

private struct LiveScanPanel: View {
    let activity: ScanActivity

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                ProgressView()
                    .scaleEffect(0.7)
                    .frame(width: 20, height: 20)

                VStack(alignment: .leading, spacing: 2) {
                    Text(activity.title)
                        .font(.headline)
                    Text(activity.currentTitle)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer()

                Text("\(activity.completedSteps)/\(activity.totalSteps)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }

            ProgressView(value: activity.progress)
                .progressViewStyle(.linear)

            if !activity.currentPath.isEmpty {
                Text(activity.currentPath)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            if !activity.recentItems.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Recently found")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)

                    ForEach(activity.recentItems) { item in
                        HStack(spacing: 8) {
                            Image(systemName: item.symbolName)
                                .foregroundStyle(.blue)
                                .frame(width: 18)

                            VStack(alignment: .leading, spacing: 1) {
                                Text(item.title)
                                    .font(.caption.weight(.semibold))
                                    .lineLimit(1)
                                Text(item.detail)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                            }

                            Spacer(minLength: 8)

                            Text(item.size.fileSizeString)
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(.secondary)
                        }
                        .transition(.opacity.combined(with: .move(edge: .top)))
                    }
                }
            }
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(Color(nsColor: .controlBackgroundColor))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color.blue.opacity(0.22), lineWidth: 1)
        )
    }
}

private struct FolderTreeRow: View {
    let node: FolderTreeNode
    @ObservedObject var model: CleanerViewModel

    private var isExpanded: Bool {
        model.expandedTreeNodeIDs.contains(node.id)
    }

    private var isLoading: Bool {
        model.loadingTreeNodeIDs.contains(node.id)
    }

    private var children: [FolderTreeNode] {
        model.treeChildren(for: node)
    }

    var body: some View {
        VStack(spacing: 6) {
            HStack(spacing: 10) {
                HStack(spacing: 0) {
                    Spacer()
                        .frame(width: CGFloat(min(node.depth, 8)) * 18)

                    Button {
                        model.toggleExpanded(node)
                    } label: {
                        if isLoading {
                            ProgressView()
                                .scaleEffect(0.55)
                                .frame(width: 22, height: 22)
                        } else {
                            Image(systemName: node.isDirectory ? (isExpanded ? "chevron.down" : "chevron.right") : "minus")
                                .font(.caption.weight(.semibold))
                                .frame(width: 22, height: 22)
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled(!node.isDirectory)
                    .help(node.isDirectory ? "Expand folder" : "File")
                }

                Image(systemName: node.isDirectory ? node.symbolName : "doc")
                    .font(.title3)
                    .foregroundStyle(node.isDirectory ? Color.blue : Color.secondary)
                    .frame(width: 30)

                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 8) {
                        Text(node.title)
                            .font(.headline)
                            .lineLimit(1)

                        Text(node.rootTitle)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.blue)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(
                                Capsule()
                                    .fill(Color.blue.opacity(0.12))
                            )

                        if !node.isDirectory {
                            Text("File")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 7)
                                .padding(.vertical, 3)
                                .background(
                                    Capsule()
                                        .fill(Color.secondary.opacity(0.12))
                                )
                        }
                    }

                    Text(node.url.path)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)

                    HStack(spacing: 8) {
                        Text(node.category)
                        Text(node.note)
                        if node.inaccessibleCount > 0 {
                            Text("\(node.inaccessibleCount) inaccessible")
                                .foregroundStyle(.orange)
                        }
                        if isExpanded && children.isEmpty && !isLoading {
                            Text("No child entries over 10 MB")
                                .foregroundStyle(.secondary)
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                }

                Spacer(minLength: 12)

                VStack(alignment: .trailing, spacing: 6) {
                    Text(node.size.fileSizeString)
                        .font(.title3.weight(.semibold))
                        .monospacedDigit()
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)

                    Text(node.itemCount > 0 ? "\(node.itemCount) items" : "du estimate")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(width: 120, alignment: .trailing)

                Button {
                    model.reveal(node)
                } label: {
                    Image(systemName: "magnifyingglass")
                }
                .buttonStyle(.borderless)
                .help("Reveal in Finder")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(Color(nsColor: .controlBackgroundColor))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(Color.secondary.opacity(0.12), lineWidth: 1)
            )

            if isExpanded {
                ForEach(children) { child in
                    FolderTreeRow(node: child, model: model)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
        }
        .animation(.easeInOut(duration: 0.16), value: isExpanded)
        .animation(.easeInOut(duration: 0.16), value: children.map(\.id))
    }
}

private struct PermissionBanner: View {
    let summary: ForensicScanSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "lock.trianglebadge.exclamationmark")
                    .foregroundStyle(.orange)
                Text("Some locations were hidden by macOS privacy permissions")
                    .font(.headline)
            }

            Text("\(summary.deniedCount) denied paths. Grant Full Disk Access to the built app or Terminal, then run Forensic Scan again for a more complete map.")
                .font(.caption)
                .foregroundStyle(.secondary)

            if let sample = summary.errorSamples.first {
                Text(sample)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(Color.orange.opacity(0.10))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color.orange.opacity(0.22), lineWidth: 1)
        )
    }
}

private struct MetricView: View {
    let title: String
    let value: String
    let symbolName: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: symbolName)
                .font(.title3)
                .foregroundStyle(.blue)
                .frame(width: 24)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(value)
                    .font(.title3.weight(.semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
            }

            Spacer()
        }
    }
}

private struct CapacityBar: View {
    let overview: DiskOverview

    private var usedRatio: Double {
        guard overview.totalCapacity > 0 else {
            return 0
        }

        let used = overview.totalCapacity - overview.availableCapacity
        return min(max(Double(used) / Double(overview.totalCapacity), 0), 1)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Color.secondary.opacity(0.16))
                    Capsule()
                        .fill(Color.blue)
                        .frame(width: proxy.size.width * usedRatio)
                }
            }
            .frame(height: 8)

            Text("\((overview.totalCapacity - overview.availableCapacity).fileSizeString) used of \(overview.totalCapacity.fileSizeString)")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
    }
}

private struct ForensicSummaryView: View {
    let summary: ForensicScanSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "waveform.path.ecg.rectangle")
                    .foregroundStyle(.blue)
                Text("Forensic scan")
                    .font(.headline)
            }

            Text("\(summary.scannedRootCount) roots")
                .font(.caption)
                .foregroundStyle(.secondary)

            Text(summary.largestEntryBytes.fileSizeString)
                .font(.title3.weight(.semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.75)

            if summary.deniedCount > 0 {
                Text("\(summary.deniedCount) denied paths")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }

            if summary.failedRootCount > 0 {
                Text("\(summary.failedRootCount) roots returned warnings")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

private struct SnapshotView: View {
    let snapshotInfo: SnapshotInfo
    let copiedCommand: Bool
    let copyCommand: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "clock.arrow.circlepath")
                    .foregroundStyle(.purple)
                Text("Local snapshots")
                    .font(.headline)
            }

            if let errorMessage = snapshotInfo.errorMessage, !errorMessage.isEmpty {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
            } else {
                Text("\(snapshotInfo.count)")
                    .font(.title2.weight(.semibold))

                Button {
                    copyCommand()
                } label: {
                    Label(copiedCommand ? "Copied" : "Copy tmutil Command", systemImage: "terminal")
                }
                .disabled(snapshotInfo.count == 0)
                .help("Copies a Time Machine thinning command to the clipboard.")
            }
        }
    }
}

private struct ResultRow: View {
    let result: ScanResult
    let isSelected: Bool
    let isBusy: Bool
    let onSelect: (Bool) -> Void
    let onReveal: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Toggle(
                "",
                isOn: Binding(
                    get: { isSelected },
                    set: { onSelect($0) }
                )
            )
            .labelsHidden()
            .disabled(!result.definition.isCleanable || isBusy)
            .frame(width: 24)

            Image(systemName: result.definition.symbolName)
                .font(.title3)
                .foregroundStyle(result.definition.safety.accentColor)
                .frame(width: 30)

            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 8) {
                    Text(result.definition.title)
                        .font(.headline)
                        .lineLimit(1)

                    SafetyBadge(safety: result.definition.safety)
                }

                Text(result.definition.url.path)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)

                HStack(spacing: 8) {
                    Text(result.definition.category)
                    Text(result.definition.note)
                    if result.inaccessibleCount > 0 {
                        Text("\(result.inaccessibleCount) inaccessible")
                            .foregroundStyle(.orange)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            }

            Spacer(minLength: 12)

            VStack(alignment: .trailing, spacing: 6) {
                Text(result.size.fileSizeString)
                    .font(.title3.weight(.semibold))
                    .monospacedDigit()
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)

                Text("\(result.itemCount) items")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .frame(width: 120, alignment: .trailing)

            Button {
                onReveal()
            } label: {
                Image(systemName: "magnifyingglass")
            }
            .buttonStyle(.borderless)
            .help("Reveal in Finder")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(Color(nsColor: .controlBackgroundColor))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color.secondary.opacity(0.12), lineWidth: 1)
        )
    }
}

private struct SafetyBadge: View {
    let safety: CleanupSafety

    var body: some View {
        Text(safety.label)
            .font(.caption.weight(.semibold))
            .foregroundStyle(safety.accentColor)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(
                Capsule()
                    .fill(safety.accentColor.opacity(0.12))
            )
    }
}

private extension CleanupSafety {
    var accentColor: Color {
        switch self {
        case .cleanable:
            .green
        case .review:
            .orange
        case .protected:
            .secondary
        }
    }
}
