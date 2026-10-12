// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "HomeComputeBar",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "HomeComputeBar", path: "Sources/HomeComputeBar"),
        .testTarget(name: "HomeComputeBarTests", dependencies: ["HomeComputeBar"], path: "Tests/HomeComputeBarTests"),
    ]
)
