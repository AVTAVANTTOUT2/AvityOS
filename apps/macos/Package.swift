// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "AvityOS",
    platforms: [.macOS("26.0")],
    targets: [
        .executableTarget(
            name: "AvityOS",
            path: "Sources/AvityOS",
            linkerSettings: [
                .linkedFramework("Security"),
                .linkedFramework("WebKit"),
            ]
        ),
        .testTarget(
            name: "AvityOSTests",
            dependencies: ["AvityOS"],
            path: "Tests/AvityOSTests",
            resources: [.process("Fixtures")]
        ),
    ]
)
