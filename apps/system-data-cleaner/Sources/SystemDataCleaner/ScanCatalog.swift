import Foundation

enum ScanCatalog {
    static func definitions() -> [ScanDefinition] {
        [
            ScanDefinition(
                id: "user-caches",
                title: "User application caches",
                category: "Caches",
                path: "~/Library/Caches",
                safety: .cleanable,
                cleanupMode: .trashContents,
                note: "Apps recreate these files as needed.",
                symbolName: "externaldrive.badge.timemachine"
            ),
            ScanDefinition(
                id: "user-logs",
                title: "User logs",
                category: "Logs",
                path: "~/Library/Logs",
                safety: .cleanable,
                cleanupMode: .trashContents,
                note: "Diagnostic logs can usually be removed.",
                symbolName: "doc.text.magnifyingglass"
            ),
            ScanDefinition(
                id: "xcode-derived-data",
                title: "Xcode DerivedData",
                category: "Developer",
                path: "~/Library/Developer/Xcode/DerivedData",
                safety: .cleanable,
                cleanupMode: .trashContents,
                note: "Xcode rebuilds indexes and build products.",
                symbolName: "hammer"
            ),
            ScanDefinition(
                id: "xcode-device-support",
                title: "Xcode iOS DeviceSupport",
                category: "Developer",
                path: "~/Library/Developer/Xcode/iOS DeviceSupport",
                safety: .cleanable,
                cleanupMode: .trashContents,
                note: "Xcode recreates support files when devices reconnect.",
                symbolName: "iphone.gen3"
            ),
            ScanDefinition(
                id: "simulator-caches",
                title: "Simulator caches",
                category: "Developer",
                path: "~/Library/Developer/CoreSimulator/Caches",
                safety: .cleanable,
                cleanupMode: .trashContents,
                note: "Simulator cache data is rebuildable.",
                symbolName: "apps.iphone"
            ),
            ScanDefinition(
                id: "xcode-ios-device-logs",
                title: "Xcode iOS device logs",
                category: "Developer",
                path: "~/Library/Developer/Xcode/iOS Device Logs",
                safety: .cleanable,
                cleanupMode: .trashContents,
                note: "Crash and device logs can be regenerated.",
                symbolName: "iphone.badge.exclamationmark"
            ),
            ScanDefinition(
                id: "xcode-watchos-device-logs",
                title: "Xcode watchOS device logs",
                category: "Developer",
                path: "~/Library/Developer/Xcode/watchOS Device Logs",
                safety: .cleanable,
                cleanupMode: .trashContents,
                note: "Crash and device logs can be regenerated.",
                symbolName: "applewatch"
            ),
            ScanDefinition(
                id: "xcode-tvos-device-logs",
                title: "Xcode tvOS device logs",
                category: "Developer",
                path: "~/Library/Developer/Xcode/tvOS Device Logs",
                safety: .cleanable,
                cleanupMode: .trashContents,
                note: "Crash and device logs can be regenerated.",
                symbolName: "appletv"
            ),
            ScanDefinition(
                id: "npm-cache",
                title: "npm cache",
                category: "Developer",
                path: "~/.npm/_cacache",
                safety: .cleanable,
                cleanupMode: .trashContents,
                note: "npm repopulates this cache on install.",
                symbolName: "curlybraces"
            ),
            ScanDefinition(
                id: "gradle-cache",
                title: "Gradle caches",
                category: "Developer",
                path: "~/.gradle/caches",
                safety: .cleanable,
                cleanupMode: .trashContents,
                note: "Gradle will redownload dependencies.",
                symbolName: "gearshape.2"
            ),
            ScanDefinition(
                id: "cargo-registry-cache",
                title: "Cargo registry cache",
                category: "Developer",
                path: "~/.cargo/registry/cache",
                safety: .cleanable,
                cleanupMode: .trashContents,
                note: "Cargo will redownload crate archives.",
                symbolName: "cube.box"
            ),
            ScanDefinition(
                id: "xcode-build-products",
                title: "Xcode build products",
                category: "Developer",
                path: "~/Library/Developer/Xcode/Products",
                safety: .cleanable,
                cleanupMode: .trashContents,
                note: "Xcode can rebuild these products.",
                symbolName: "hammer.circle"
            ),
            ScanDefinition(
                id: "mobile-sync-backups",
                title: "iPhone and iPad backups",
                category: "Backups",
                path: "~/Library/Application Support/MobileSync/Backup",
                safety: .review,
                cleanupMode: .revealOnly,
                note: "Device backups may be important.",
                symbolName: "externaldrive.badge.icloud"
            ),
            ScanDefinition(
                id: "xcode-archives",
                title: "Xcode archives",
                category: "Developer",
                path: "~/Library/Developer/Xcode/Archives",
                safety: .review,
                cleanupMode: .revealOnly,
                note: "Archives may be needed for releases or symbols.",
                symbolName: "archivebox"
            ),
            ScanDefinition(
                id: "simulator-runtimes",
                title: "Simulator runtimes",
                category: "Developer",
                path: "~/Library/Developer/CoreSimulator/Profiles/Runtimes",
                safety: .review,
                cleanupMode: .revealOnly,
                note: "Remove unused runtimes from Xcode Settings.",
                symbolName: "iphone.sizes"
            ),
            ScanDefinition(
                id: "xcode-previews",
                title: "Xcode preview devices",
                category: "Developer",
                path: "~/Library/Developer/Xcode/UserData/Previews/Simulator Devices",
                safety: .review,
                cleanupMode: .revealOnly,
                note: "Preview simulator state can be large.",
                symbolName: "rectangle.dashed"
            ),
            ScanDefinition(
                id: "simulator-devices",
                title: "Simulator devices",
                category: "Developer",
                path: "~/Library/Developer/CoreSimulator/Devices",
                safety: .review,
                cleanupMode: .revealOnly,
                note: "Contains installed apps and simulator state.",
                symbolName: "iphone.and.arrow.forward"
            ),
            ScanDefinition(
                id: "docker-data",
                title: "Docker Desktop data",
                category: "Developer",
                path: "~/Library/Containers/com.docker.docker/Data",
                safety: .review,
                cleanupMode: .revealOnly,
                note: "Images, volumes, and containers can live here.",
                symbolName: "shippingbox.circle"
            ),
            ScanDefinition(
                id: "messages-attachments",
                title: "Messages attachments",
                category: "Personal data",
                path: "~/Library/Messages/Attachments",
                safety: .review,
                cleanupMode: .revealOnly,
                note: "Attachments are personal data.",
                symbolName: "message.badge"
            ),
            ScanDefinition(
                id: "mail-downloads",
                title: "Mail downloads",
                category: "Personal data",
                path: "~/Library/Containers/com.apple.mail/Data/Library/Mail Downloads",
                safety: .review,
                cleanupMode: .revealOnly,
                note: "Downloaded attachments may be useful.",
                symbolName: "envelope.open"
            ),
            ScanDefinition(
                id: "ios-software-updates",
                title: "iOS software updates",
                category: "Updates",
                path: "~/Library/iTunes/iPhone Software Updates",
                safety: .review,
                cleanupMode: .revealOnly,
                note: "Old IPSW downloads can be very large.",
                symbolName: "arrow.down.iphone"
            ),
            ScanDefinition(
                id: "ipad-software-updates",
                title: "iPad software updates",
                category: "Updates",
                path: "~/Library/iTunes/iPad Software Updates",
                safety: .review,
                cleanupMode: .revealOnly,
                note: "Old IPSW downloads can be very large.",
                symbolName: "arrow.down.right.and.arrow.up.left"
            ),
            ScanDefinition(
                id: "system-caches",
                title: "System caches",
                category: "System",
                path: "/Library/Caches",
                safety: .protected,
                cleanupMode: .revealOnly,
                note: "Administrator-owned cache area.",
                symbolName: "lock.shield"
            ),
            ScanDefinition(
                id: "system-logs",
                title: "System logs",
                category: "System",
                path: "/Library/Logs",
                safety: .protected,
                cleanupMode: .revealOnly,
                note: "Administrator-owned log area.",
                symbolName: "lock.doc"
            ),
            ScanDefinition(
                id: "system-updates",
                title: "macOS update downloads",
                category: "System",
                path: "/Library/Updates",
                safety: .protected,
                cleanupMode: .revealOnly,
                note: "macOS installer/update leftovers.",
                symbolName: "arrow.down.circle"
            ),
            ScanDefinition(
                id: "virtual-memory",
                title: "Virtual memory files",
                category: "System",
                path: "/private/var/vm",
                safety: .protected,
                cleanupMode: .revealOnly,
                note: "Swap files are managed by macOS.",
                symbolName: "memorychip"
            )
        ]
    }

    static func deepScanRoots() -> [DeepScanRoot] {
        [
            DeepScanRoot(
                id: "library-caches-top",
                title: "User cache folders",
                path: "~/Library/Caches",
                category: "Caches",
                note: "Large app caches usually appear here.",
                symbolName: "folder.badge.gearshape",
                childDepth: 1
            ),
            DeepScanRoot(
                id: "application-support-top",
                title: "Application Support",
                path: "~/Library/Application Support",
                category: "App data",
                note: "Often contains backups, media indexes, VMs, and app databases.",
                symbolName: "app.badge",
                childDepth: 1
            ),
            DeepScanRoot(
                id: "containers-top",
                title: "App containers",
                path: "~/Library/Containers",
                category: "App data",
                note: "Sandboxed app data, including hidden downloads and attachments.",
                symbolName: "square.stack.3d.up",
                childDepth: 1
            ),
            DeepScanRoot(
                id: "group-containers-top",
                title: "Group containers",
                path: "~/Library/Group Containers",
                category: "App data",
                note: "Shared app data used by suites like Mail, Photos, and Office.",
                symbolName: "rectangle.3.group",
                childDepth: 1
            ),
            DeepScanRoot(
                id: "developer-top",
                title: "Developer folder",
                path: "~/Library/Developer",
                category: "Developer",
                note: "Xcode, simulators, archives, and device support.",
                symbolName: "hammer",
                childDepth: 2
            ),
            DeepScanRoot(
                id: "home-hidden-cache-top",
                title: "Hidden home caches",
                path: "~/.cache",
                category: "Developer",
                note: "Language and tool caches from CLI workflows.",
                symbolName: "terminal",
                childDepth: 1
            ),
            DeepScanRoot(
                id: "home-trash-top",
                title: "User Trash",
                path: "~/.Trash",
                category: "Trash",
                note: "Trash still occupies disk until emptied.",
                symbolName: "trash",
                childDepth: 1
            ),
            DeepScanRoot(
                id: "system-application-support-top",
                title: "System Application Support",
                path: "/Library/Application Support",
                category: "System",
                note: "Shared app support data, often from installers and developer tools.",
                symbolName: "lock.app.dashed",
                childDepth: 1
            ),
            DeepScanRoot(
                id: "system-developer-top",
                title: "System Developer folder",
                path: "/Library/Developer",
                category: "Developer",
                note: "Shared simulator runtimes and developer resources.",
                symbolName: "lock.square.stack",
                childDepth: 2
            ),
            DeepScanRoot(
                id: "var-folders-top",
                title: "Temporary system folders",
                path: "/private/var/folders",
                category: "System",
                note: "Per-user temporary and cache data managed by macOS.",
                symbolName: "clock.badge.exclamationmark",
                childDepth: 3
            ),
            DeepScanRoot(
                id: "users-shared-top",
                title: "Users Shared",
                path: "/Users/Shared",
                category: "Shared",
                note: "Installers, shared assets, and app leftovers can accumulate here.",
                symbolName: "person.2",
                childDepth: 1
            )
        ]
    }

    static func forensicScanRoots() -> [DeepScanRoot] {
        let fileManager = FileManager.default
        let dataVolume = "/System/Volumes/Data"

        let dataVolumeRoots = [
            DeepScanRoot(
                id: "data-users",
                title: "Users",
                path: "\(dataVolume)/Users",
                category: "Volume",
                note: "User homes, Library data, and account-local caches.",
                symbolName: "person.crop.circle",
                childDepth: 6
            ),
            DeepScanRoot(
                id: "data-library",
                title: "Library",
                path: "\(dataVolume)/Library",
                category: "System",
                note: "Shared support, caches, developer data, and update leftovers.",
                symbolName: "building.columns",
                childDepth: 5
            ),
            DeepScanRoot(
                id: "data-private-var",
                title: "private var",
                path: "\(dataVolume)/private/var",
                category: "System",
                note: "Temporary, log, VM, and system-managed data.",
                symbolName: "folder.badge.gearshape",
                childDepth: 5
            ),
            DeepScanRoot(
                id: "data-applications",
                title: "Applications",
                path: "\(dataVolume)/Applications",
                category: "Apps",
                note: "Applications and bundled app resources.",
                symbolName: "app.dashed",
                childDepth: 4
            ),
            DeepScanRoot(
                id: "data-opt",
                title: "opt",
                path: "\(dataVolume)/opt",
                category: "Developer",
                note: "Homebrew and tool-managed data can live here.",
                symbolName: "terminal",
                childDepth: 4
            ),
            DeepScanRoot(
                id: "data-usr-local",
                title: "usr local",
                path: "\(dataVolume)/usr/local",
                category: "Developer",
                note: "Local tools, packages, and caches.",
                symbolName: "wrench.and.screwdriver",
                childDepth: 4
            ),
            DeepScanRoot(
                id: "data-users-shared",
                title: "Users Shared",
                path: "\(dataVolume)/Users/Shared",
                category: "Shared",
                note: "Shared installers, assets, caches, and app leftovers.",
                symbolName: "person.2",
                childDepth: 4
            )
        ]

        let fallbackRoots = [
            DeepScanRoot(
                id: "root-users",
                title: "Users",
                path: "/Users",
                category: "Volume",
                note: "User homes, Library data, and account-local caches.",
                symbolName: "person.crop.circle",
                childDepth: 6
            ),
            DeepScanRoot(
                id: "root-library",
                title: "Library",
                path: "/Library",
                category: "System",
                note: "Shared support, caches, developer data, and update leftovers.",
                symbolName: "building.columns",
                childDepth: 5
            ),
            DeepScanRoot(
                id: "root-private-var",
                title: "private var",
                path: "/private/var",
                category: "System",
                note: "Temporary, log, VM, and system-managed data.",
                symbolName: "folder.badge.gearshape",
                childDepth: 5
            ),
            DeepScanRoot(
                id: "root-opt",
                title: "opt",
                path: "/opt",
                category: "Developer",
                note: "Homebrew and tool-managed data can live here.",
                symbolName: "terminal",
                childDepth: 4
            ),
            DeepScanRoot(
                id: "root-usr-local",
                title: "usr local",
                path: "/usr/local",
                category: "Developer",
                note: "Local tools, packages, and caches.",
                symbolName: "wrench.and.screwdriver",
                childDepth: 4
            )
        ]

        var roots = fileManager.fileExists(atPath: dataVolume) ? dataVolumeRoots : fallbackRoots

        roots.append(contentsOf: [
            DeepScanRoot(
                id: "apfs-vm-volume",
                title: "APFS VM volume",
                path: "/System/Volumes/VM",
                category: "System",
                note: "Swap and sleep image storage managed by macOS.",
                symbolName: "memorychip",
                childDepth: 3
            ),
            DeepScanRoot(
                id: "apfs-update-volume",
                title: "APFS Update volume",
                path: "/System/Volumes/Update",
                category: "Updates",
                note: "macOS update staging and leftovers.",
                symbolName: "arrow.down.circle",
                childDepth: 5
            ),
            DeepScanRoot(
                id: "apfs-preboot-volume",
                title: "APFS Preboot volume",
                path: "/System/Volumes/Preboot",
                category: "System",
                note: "Boot support data. Large entries here are review-only.",
                symbolName: "power.circle",
                childDepth: 4
            )
        ])

        return roots.filter { fileManager.fileExists(atPath: $0.url.path) }
    }
}
