// swift-tools-version: 6.2
import PackageDescription

// The Core contract layer: models, HTTP client, and event stream, with no UI and no platform
// frameworks. Kept a separate package so `swift test` can exercise it without a simulator, a
// signing identity, or Xcode — every model here is a hand-written mirror of an internal C# record
// in apps/core with no OpenAPI spec to check it against, so it has to be cheap to test.
let package = Package(
    name: "HostyKit",
    platforms: [
        .iOS("26.0"),
        .macOS("26.0"),
    ],
    products: [
        .library(name: "HostyKit", targets: ["HostyKit"]),
    ],
    targets: [
        .target(name: "HostyKit"),
        .testTarget(name: "HostyKitTests", dependencies: ["HostyKit"]),
    ]
)
