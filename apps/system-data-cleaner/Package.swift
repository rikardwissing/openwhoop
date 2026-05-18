// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "SystemDataCleaner",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "SystemDataCleaner", targets: ["SystemDataCleaner"])
    ],
    targets: [
        .executableTarget(name: "SystemDataCleaner")
    ]
)
