import AnimaProtocol
import Connect
import Foundation
import Network
import Observation
import SwiftProtobuf

struct ServerAddress: Equatable {
    let host: String
    let port: Int
    let tls: Bool

    static let local = ServerAddress(host: "127.0.0.1", port: 4242, tls: false)

    private init(host: String, port: Int, tls: Bool) {
        self.host = host
        self.port = port
        self.tls = tls
    }

    init(host input: String, port: String, tls: Bool) throws {
        var host = input.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if host.first == "[", host.last == "]" { host = String(host.dropFirst().dropLast()) }
        let labelCharacters = Set("abcdefghijklmnopqrstuvwxyz0123456789-")
        let dnsName = host.hasSuffix(".") ? String(host.dropLast()) : host
        let validDNS = !dnsName.isEmpty && dnsName.utf8.count <= 253 &&
            dnsName.split(separator: ".", omittingEmptySubsequences: false).allSatisfy { label in
                (1...63).contains(label.count) && label.first != "-" && label.last != "-" &&
                    label.allSatisfy { labelCharacters.contains($0) }
            }
        guard (host.contains(":") && IPv6Address(host) != nil) || validDNS else {
            throw ClientIssue("Enter an IP address or hostname without a scheme, port, or path.")
        }
        let digits = port.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !digits.isEmpty, digits.utf8.allSatisfy({ (48...57).contains($0) }),
              let value = Int(digits), (1...65535).contains(value) else {
            throw ClientIssue("Port must be a number from 1 to 65535.")
        }
        self.init(host: host, port: value, tls: tls)
    }

    var authority: String { "\(host.contains(":") ? "[\(host)]" : host):\(port)" }
    var origin: String { "\(tls ? "https" : "http")://\(authority)" }
}

struct ClientIssue: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

@MainActor @Observable
final class ServerConnection {
    private(set) var address: ServerAddress
    private(set) var workspace: WorkspaceModel?
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let saved = try? ServerAddress(
            host: defaults.string(forKey: "server.host") ?? ServerAddress.local.host,
            port: defaults.string(forKey: "server.port") ?? String(ServerAddress.local.port),
            tls: defaults.bool(forKey: "server.tls")
        )
        address = saved ?? .local
        if defaults.object(forKey: "server.autoConnect") as? Bool != false {
            workspace = WorkspaceModel(address: address)
        }
    }

    func connect(to address: ServerAddress) {
        defaults.set(address.host, forKey: "server.host")
        defaults.set(String(address.port), forKey: "server.port")
        defaults.set(address.tls, forKey: "server.tls")
        defaults.set(true, forKey: "server.autoConnect")
        if let workspace, self.address == address {
            workspace.reconnect()
        } else {
            self.address = address
            workspace = WorkspaceModel(address: address)
        }
    }

    func disconnect() {
        defaults.set(false, forKey: "server.autoConnect")
        workspace = nil
    }
}

struct HarnessClient: Sendable {
    let rpc: Anima_V1_HarnessServiceClient

    init(address: ServerAddress) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        // A healthy task graph can be quiet for minutes at a time. The first-message
        // deadline in readStream handles unreachable or misconfigured endpoints.
        configuration.timeoutIntervalForRequest = 600
        configuration.timeoutIntervalForResource = 7 * 24 * 60 * 60
        rpc = Anima_V1_HarnessServiceClient(client: ProtocolClient(
            httpClient: URLSessionHTTPClient(configuration: configuration),
            config: ProtocolClientConfig(host: address.origin, networkProtocol: .connect, codec: ProtoCodec())
        ))
    }

    /// Reopen replacement streams, never retry mutations automatically.
    @MainActor
    static func follow<Input: SwiftProtobuf.Message, Output: SwiftProtobuf.Message>(
        _ request: Input,
        open: () -> any ServerOnlyAsyncStreamInterface<Input, Output>,
        receive: (Output) async throws -> Void,
        disconnected: (Error) -> Void
    ) async {
        var delay = 500
        while !Task.isCancelled {
            do {
                try await readStream(open(), request: request) { value in
                    delay = 500
                    try await receive(value)
                }
            } catch {
                guard !Task.isCancelled else { return }
                disconnected(error)
                do { try await Task.sleep(for: .milliseconds(delay)) }
                catch { return }
                delay = min(delay * 2, 5_000)
            }
        }
    }

    @MainActor
    private static func readStream<Input: SwiftProtobuf.Message, Output: SwiftProtobuf.Message>(
        _ stream: any ServerOnlyAsyncStreamInterface<Input, Output>, request: Input,
        receive: (Output) async throws -> Void
    ) async throws {
        let deadline = ContinuousClock.now + .seconds(12)
        let firstMessage = Task {
            try await Task.sleep(until: deadline, clock: .continuous)
            stream.cancel()
        }
        defer { firstMessage.cancel(); stream.cancel() }
        try await withTaskCancellationHandler {
            try Task.checkCancellation()
            try stream.send(request)
            var started = false
            for await event in stream.results() {
                try Task.checkCancellation()
                switch event {
                case .headers:
                    break
                case .message(let value):
                    started = true
                    firstMessage.cancel()
                    try await receive(value)
                case .complete(_, let failure, _):
                    if !started && ContinuousClock.now >= deadline {
                        throw ClientIssue("The server did not send an initial update.")
                    }
                    if let failure { throw failure }
                    throw ClientIssue("The server closed the stream.")
                }
            }
            try Task.checkCancellation()
            throw ClientIssue("The server closed the stream.")
        } onCancel: {
            stream.cancel()
        }
    }
}

extension ResponseMessage {
    func value() throws -> Output {
        try Task.checkCancellation()
        return try result.get()
    }
}

func describe(_ error: Error) -> String {
    if let rpc = error as? ConnectError, let message = rpc.message, !message.isEmpty { return message }
    return error.localizedDescription
}
