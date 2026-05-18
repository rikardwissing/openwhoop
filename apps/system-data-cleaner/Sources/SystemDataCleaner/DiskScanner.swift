import Foundation

struct DirectorySize: Sendable {
    let bytes: Int64
    let itemCount: Int
    let inaccessibleCount: Int
}

enum DiskScanner {
    private static let sizeKeys: Set<URLResourceKey> = [
        .isDirectoryKey,
        .isRegularFileKey,
        .isSymbolicLinkKey,
        .fileAllocatedSizeKey,
        .totalFileAllocatedSizeKey,
        .fileSizeKey
    ]

    static func scan(definitions: [ScanDefinition]) -> [ScanResult] {
        definitions.compactMap { definition in
            scan(definition: definition)
        }
        .sorted { left, right in
            if left.size == right.size {
                return left.definition.title < right.definition.title
            }

            return left.size > right.size
        }
    }

    static func scan(definition: ScanDefinition) -> ScanResult? {
        guard FileManager.default.fileExists(atPath: definition.url.path) else {
            return nil
        }

        let size = sizeOfItem(at: definition.url)
        return ScanResult(
            definition: definition,
            size: size.bytes,
            itemCount: size.itemCount,
            inaccessibleCount: size.inaccessibleCount,
            scannedAt: Date()
        )
    }

    static func scanLargeFolders(
        roots: [DeepScanRoot],
        minSize: Int64 = 1_000_000_000,
        limitPerRoot: Int = 12
    ) -> [LargeFolderResult] {
        roots.flatMap { root in
            scanLargeFolders(root: root, minSize: minSize, limit: limitPerRoot)
        }
        .sorted { left, right in
            if left.size == right.size {
                return left.title < right.title
            }

            return left.size > right.size
        }
    }

    static func scanLargeFolders(
        root: DeepScanRoot,
        minSize: Int64 = 1_000_000_000,
        limit: Int = 12
    ) -> [LargeFolderResult] {
        largestChildren(in: root, minSize: minSize, limit: limit)
    }

    static func scanTreeChildren(
        of parent: FolderTreeNode,
        minSize: Int64 = 10_000_000,
        limit: Int = 120
    ) -> [FolderTreeNode] {
        let duChildren = immediateChildrenFromDiskUsage(
            of: parent.url,
            rootTitle: parent.rootTitle,
            category: parent.category,
            note: parent.note,
            symbolName: parent.symbolName,
            depth: parent.depth + 1,
            minSize: minSize,
            limit: limit
        )

        if !duChildren.isEmpty {
            return duChildren
        }

        return immediateChildren(
            of: parent.url,
            rootTitle: parent.rootTitle,
            category: parent.category,
            note: parent.note,
            symbolName: parent.symbolName,
            depth: parent.depth + 1,
            minSize: minSize,
            limit: limit
        )
    }

    static func sizeOfItem(at rootURL: URL) -> DirectorySize {
        let fileManager = FileManager.default

        guard let rootValues = try? rootURL.resourceValues(forKeys: sizeKeys) else {
            return DirectorySize(bytes: 0, itemCount: 0, inaccessibleCount: 1)
        }

        if rootValues.isSymbolicLink == true {
            return DirectorySize(bytes: 0, itemCount: 0, inaccessibleCount: 0)
        }

        if rootValues.isDirectory != true {
            return DirectorySize(bytes: allocatedSize(from: rootValues), itemCount: 1, inaccessibleCount: 0)
        }

        var totalBytes: Int64 = 0
        var itemCount = 0
        var inaccessibleCount = 0

        let enumerator = fileManager.enumerator(
            at: rootURL,
            includingPropertiesForKeys: Array(sizeKeys),
            options: [],
            errorHandler: { _, _ in
                inaccessibleCount += 1
                return true
            }
        )

        while let itemURL = enumerator?.nextObject() as? URL {
            autoreleasepool {
                guard let values = try? itemURL.resourceValues(forKeys: sizeKeys) else {
                    inaccessibleCount += 1
                    return
                }

                if values.isSymbolicLink == true {
                    if values.isDirectory == true {
                        enumerator?.skipDescendants()
                    }
                    return
                }

                itemCount += 1

                if values.isDirectory == true {
                    return
                }

                totalBytes += allocatedSize(from: values)
            }
        }

        return DirectorySize(bytes: totalBytes, itemCount: itemCount, inaccessibleCount: inaccessibleCount)
    }

    private static func largestChildren(
        in root: DeepScanRoot,
        minSize: Int64,
        limit: Int
    ) -> [LargeFolderResult] {
        let candidates = childURLs(in: root.url, depth: root.childDepth)

        return candidates.compactMap { childURL in
            let size = sizeOfItem(at: childURL)
            guard size.bytes >= minSize else {
                return nil
            }

            return LargeFolderResult(
                id: "\(root.id):\(childURL.path)",
                title: displayName(for: childURL),
                rootTitle: root.title,
                category: root.category,
                url: childURL,
                size: size.bytes,
                itemCount: size.itemCount,
                inaccessibleCount: size.inaccessibleCount,
                note: root.note,
                symbolName: root.symbolName
            )
        }
        .sorted { left, right in
            if left.size == right.size {
                return left.title < right.title
            }

            return left.size > right.size
        }
        .prefix(limit)
        .map { $0 }
    }

    private static func childURLs(in rootURL: URL, depth: Int) -> [URL] {
        guard depth > 0 else {
            return [rootURL]
        }

        let fileManager = FileManager.default
        guard let children = try? fileManager.contentsOfDirectory(
            at: rootURL,
            includingPropertiesForKeys: Array(sizeKeys),
            options: []
        ) else {
            return []
        }

        if depth == 1 {
            return children.filter { childURL in
                guard let values = try? childURL.resourceValues(forKeys: sizeKeys) else {
                    return false
                }
                return values.isSymbolicLink != true
            }
        }

        return children.flatMap { childURL in
            guard let values = try? childURL.resourceValues(forKeys: sizeKeys),
                  values.isDirectory == true,
                  values.isSymbolicLink != true else {
                return [childURL]
            }

            return childURLs(in: childURL, depth: depth - 1)
        }
    }

    private static func immediateChildren(
        of parentURL: URL,
        rootTitle: String,
        category: String,
        note: String,
        symbolName: String,
        depth: Int,
        minSize: Int64,
        limit: Int
    ) -> [FolderTreeNode] {
        let fileManager = FileManager.default
        guard let children = try? fileManager.contentsOfDirectory(
            at: parentURL,
            includingPropertiesForKeys: Array(sizeKeys),
            options: []
        ) else {
            return []
        }

        return children.compactMap { childURL -> FolderTreeNode? in
            guard let values = try? childURL.resourceValues(forKeys: sizeKeys),
                  values.isSymbolicLink != true else {
                return nil
            }

            let isDirectory = values.isDirectory == true
            let size: DirectorySize

            if isDirectory {
                size = sizeOfItem(at: childURL)
            } else {
                let bytes = allocatedSize(from: values)
                size = DirectorySize(bytes: bytes, itemCount: 1, inaccessibleCount: 0)
            }

            guard size.bytes >= minSize else {
                return nil
            }

            return FolderTreeNode(
                title: displayName(for: childURL),
                rootTitle: rootTitle,
                category: category,
                url: childURL,
                size: size.bytes,
                itemCount: size.itemCount,
                inaccessibleCount: size.inaccessibleCount,
                note: isDirectory ? note : "Large file in this folder.",
                symbolName: isDirectory ? symbolName : "doc",
                isDirectory: isDirectory,
                depth: depth
            )
        }
        .sorted { left, right in
            if left.size == right.size {
                return left.title < right.title
            }

            return left.size > right.size
        }
        .prefix(limit)
        .map { $0 }
    }

    private static func immediateChildrenFromDiskUsage(
        of parentURL: URL,
        rootTitle: String,
        category: String,
        note: String,
        symbolName: String,
        depth: Int,
        minSize: Int64,
        limit: Int
    ) -> [FolderTreeNode] {
        let output = runDiskUsage(at: parentURL, depth: 1)
        guard output.didRun else {
            return []
        }

        let parentPath = parentURL.standardizedFileURL.path
        let deniedCount = output.errorLines.filter {
            $0.localizedCaseInsensitiveContains("Permission denied")
                || $0.localizedCaseInsensitiveContains("Operation not permitted")
        }.count

        return output.outputLines.compactMap { line -> FolderTreeNode? in
            guard let parsed = parseDiskUsageLine(line), parsed.bytes >= minSize else {
                return nil
            }

            let childURL = URL(fileURLWithPath: parsed.path).standardizedFileURL
            let childPath = childURL.path
            guard childPath != parentPath,
                  childURL.deletingLastPathComponent().path == parentPath else {
                return nil
            }

            guard let values = try? childURL.resourceValues(forKeys: sizeKeys),
                  values.isSymbolicLink != true else {
                return nil
            }

            let isDirectory = values.isDirectory == true
            return FolderTreeNode(
                title: displayName(for: childURL),
                rootTitle: rootTitle,
                category: category,
                url: childURL,
                size: parsed.bytes,
                itemCount: isDirectory ? 0 : 1,
                inaccessibleCount: deniedCount,
                note: isDirectory ? note : "Large file in this folder.",
                symbolName: isDirectory ? symbolName : "doc",
                isDirectory: isDirectory,
                depth: depth
            )
        }
        .sorted { left, right in
            if left.size == right.size {
                return left.title < right.title
            }

            return left.size > right.size
        }
        .prefix(limit)
        .map { $0 }
    }

    private static func runDiskUsage(at url: URL, depth: Int) -> DiskUsageOutput {
        let fileManager = FileManager.default
        let outputURL = fileManager.temporaryDirectory.appendingPathComponent("SystemDataCleaner-expand-\(UUID().uuidString).out")
        let errorURL = fileManager.temporaryDirectory.appendingPathComponent("SystemDataCleaner-expand-\(UUID().uuidString).err")
        fileManager.createFile(atPath: outputURL.path, contents: nil)
        fileManager.createFile(atPath: errorURL.path, contents: nil)

        guard let outputHandle = try? FileHandle(forWritingTo: outputURL),
              let errorHandle = try? FileHandle(forWritingTo: errorURL) else {
            return DiskUsageOutput(didRun: false, outputLines: [], errorLines: [])
        }

        defer {
            try? outputHandle.close()
            try? errorHandle.close()
            try? fileManager.removeItem(at: outputURL)
            try? fileManager.removeItem(at: errorURL)
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/du")
        process.arguments = [
            "-x",
            "-k",
            "-d",
            "\(depth)",
            url.path
        ]
        process.standardOutput = outputHandle
        process.standardError = errorHandle

        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return DiskUsageOutput(didRun: false, outputLines: [], errorLines: [error.localizedDescription])
        }

        return DiskUsageOutput(
            didRun: true,
            outputLines: readLines(from: outputURL),
            errorLines: readLines(from: errorURL)
        )
    }

    private static func readLines(from url: URL) -> [String] {
        let data = (try? Data(contentsOf: url)) ?? Data()
        let output = String(data: data, encoding: .utf8) ?? ""
        return output
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    private static func parseDiskUsageLine(_ line: String) -> (bytes: Int64, path: String)? {
        let tabParts = line.split(separator: "\t", maxSplits: 1, omittingEmptySubsequences: true)
        let spaceParts = line.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
        let parts = tabParts.count == 2 ? tabParts : spaceParts

        guard parts.count == 2,
              let kibibytes = Int64(parts[0].trimmingCharacters(in: .whitespacesAndNewlines)) else {
            return nil
        }

        return (kibibytes * 1024, String(parts[1]))
    }

    private static func displayName(for url: URL) -> String {
        let displayName = FileManager.default.displayName(atPath: url.path)
        if displayName.isEmpty {
            return url.lastPathComponent
        }

        return displayName
    }

    private static func allocatedSize(from values: URLResourceValues) -> Int64 {
        let byteCount = values.totalFileAllocatedSize ?? values.fileAllocatedSize ?? values.fileSize ?? 0
        return Int64(byteCount)
    }
}

private struct DiskUsageOutput {
    let didRun: Bool
    let outputLines: [String]
    let errorLines: [String]
}
