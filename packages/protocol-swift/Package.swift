// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "AnimaProtocol",
    platforms: [
        .macOS(.v10_15),
        .iOS(.v13),
        .tvOS(.v13),
        .watchOS(.v6),
    ],
    products: [
        .library(name: "AnimaProtocol", targets: ["AnimaProtocol"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-protobuf.git", from: "1.39.0"),
        .package(url: "https://github.com/connectrpc/connect-swift.git", from: "1.2.3"),
    ],
    targets: [
        .target(
            name: "AnimaProtocol",
            dependencies: [
                .product(name: "SwiftProtobuf", package: "swift-protobuf"),
                .product(name: "Connect", package: "connect-swift"),
            ]
        ),
    ]
)
