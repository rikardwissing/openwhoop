import Foundation

enum ForensicScanner {
    static func scan(
        roots: [DeepScanRoot],
        minSize: Int64 = 500_000_000,
        limit: Int = 250
    ) -> ForensicScanPayload {
        var results: [LargeFolderResult] = []
        var scannedRootCount = 0
        var deniedCount = 0
        var failedRootCount = 0
        var errorSamples: [String] = []
        var seenPaths = Set<String>()

        for root in roots {
            let payload = scan(root: root, minSize: minSize, limit: limit)
            scannedRootCount += payload.summary.scannedRootCount
            deniedCount += payload.summary.deniedCount
            failedRootCount += payload.summary.failedRootCount
            errorSamples.append(contentsOf: payload.summary.errorSamples)
            errorSamples = Array(errorSamples.prefix(6))

            for result in payload.folders where seenPaths.insert(result.url.standardizedFileURL.path).inserted {
                results.append(result)
            }
        }

        let sortedResults = results.sorted { left, right in
            if left.size == right.size {
                return left.url.path < right.url.path
            }

            return left.size > right.size
        }

        let limitedResults = Array(sortedResults.prefix(limit))

        return ForensicScanPayload(
            folders: limitedResults,
            summary: ForensicScanSummary(
                scannedRootCount: scannedRootCount,
                largestEntryBytes: limitedResults.first?.size ?? 0,
                deniedCount: deniedCount,
                errorSamples: errorSamples,
                failedRootCount: failedRootCount
            )
        )
    }

    static func scan(
        root: DeepScanRoot,
        minSize: Int64 = 500_000_000,
        limit: Int = 250
    ) -> ForensicScanPayload {
        let output = runDu(root: root)
        var deniedCount = 0
        var errorSamples: [String] = []

        for errorLine in output.errorLines {
            if errorLine.localizedCaseInsensitiveContains("Permission denied")
                || errorLine.localizedCaseInsensitiveContains("Operation not permitted") {
                deniedCount += 1
            }

            if errorSamples.count < 6 {
                errorSamples.append(errorLine)
            }
        }

        let folders = output.outputLines.compactMap { line -> LargeFolderResult? in
            guard let parsed = parseDuLine(line), parsed.bytes >= minSize else {
                return nil
            }

            let url = URL(fileURLWithPath: parsed.path)
            let path = url.standardizedFileURL.path
            return LargeFolderResult(
                id: "forensic:\(path)",
                title: displayName(for: url),
                rootTitle: root.title,
                category: root.category,
                url: url,
                size: parsed.bytes,
                itemCount: 0,
                inaccessibleCount: 0,
                note: root.note,
                symbolName: root.symbolName
            )
        }
        .sorted { left, right in
            if left.size == right.size {
                return left.url.path < right.url.path
            }

            return left.size > right.size
        }
        .prefix(limit)
        .map { $0 }

        return ForensicScanPayload(
            folders: folders,
            summary: ForensicScanSummary(
                scannedRootCount: output.didRun ? 1 : 0,
                largestEntryBytes: folders.first?.size ?? 0,
                deniedCount: deniedCount,
                errorSamples: errorSamples,
                failedRootCount: output.exitCode == 0 ? 0 : 1
            )
        )
    }

    private static func runDu(root: DeepScanRoot) -> DuOutput {
        let fileManager = FileManager.default
        let temporaryDirectory = fileManager.temporaryDirectory
        let outputURL = temporaryDirectory.appendingPathComponent("SystemDataCleaner-du-\(UUID().uuidString).out")
        let errorURL = temporaryDirectory.appendingPathComponent("SystemDataCleaner-du-\(UUID().uuidString).err")
        fileManager.createFile(atPath: outputURL.path, contents: nil)
        fileManager.createFile(atPath: errorURL.path, contents: nil)

        guard let outputHandle = try? FileHandle(forWritingTo: outputURL),
              let errorHandle = try? FileHandle(forWritingTo: errorURL) else {
            return DuOutput(
                didRun: false,
                exitCode: -1,
                outputLines: [],
                errorLines: ["Could not create temporary scan output files."]
            )
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
            "\(root.childDepth)",
            root.url.path
        ]
        process.standardOutput = outputHandle
        process.standardError = errorHandle

        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return DuOutput(
                didRun: false,
                exitCode: -1,
                outputLines: [],
                errorLines: [error.localizedDescription]
            )
        }

        return DuOutput(
            didRun: true,
            exitCode: process.terminationStatus,
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

    private static func parseDuLine(_ line: String) -> (bytes: Int64, path: String)? {
        let pieces = line.split(separator: "\t", maxSplits: 1, omittingEmptySubsequences: true)
        let fallbackPieces = line.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
        let parts = pieces.count == 2 ? pieces : fallbackPieces

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
}

private struct DuOutput {
    let didRun: Bool
    let exitCode: Int32
    let outputLines: [String]
    let errorLines: [String]
}
