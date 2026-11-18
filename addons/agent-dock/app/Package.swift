// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "AgentDock",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "AgentDock", path: "Sources/AgentDock")
    ]
)
