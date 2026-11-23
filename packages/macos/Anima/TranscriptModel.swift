import AnimaProtocol
import Foundation
import SwiftProtobuf

// Durable payloads are protobuf Structs. Keep their string keys out of the views.
extension Google_Protobuf_Struct {
    subscript(_ key: String) -> Google_Protobuf_Value? { fields[key] }
}

extension Google_Protobuf_Value {
    var object: Google_Protobuf_Struct? {
        if case .structValue(let value) = kind { return value }
        return nil
    }

    var text: String? {
        if case .stringValue(let value) = kind { return value }
        return nil
    }

    var items: [Google_Protobuf_Value] { listValue.values }

    var durableNumber: Int64? {
        if case .numberValue(let value) = kind, value > 0, value <= 9_007_199_254_740_991 {
            return Int64(exactly: value)
        }
        return nil
    }

    var durableID: String? { text.flatMap { $0.isEmpty ? nil : $0 } ?? durableNumber.map(String.init) }
}

func cleanText(_ text: String) -> String {
    let stripped = text.contains("\u{1b}") ? text.replacingOccurrences(
        of: #"\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[PX^_][\s\S]*?\x1b\\|[@-_])"#,
        with: "", options: .regularExpression
    ) : text
    return stripped.replacingOccurrences(of: #"[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f-\x9f]"#, with: "", options: .regularExpression)
}

struct QueuedInput: Equatable, Identifiable {
    let id: String
    let content: String
    let mode: Anima_V1_BusyBehavior

    init?(_ value: Google_Protobuf_Value) {
        guard let item = value.object, let id = item["id"]?.durableID, let content = item["content"]?.text,
              item["entry"]?.object == nil || item["entry"]?.object?["data"]?.object?["origin"]?.text == "user"
        else { return nil }
        switch item["mode"]?.text {
        case "steer": mode = .steer
        case "followUp": mode = .queue
        default: return nil
        }
        self.id = id
        self.content = content
    }

    var modeLabel: String { mode == .steer ? "Steering" : "Follow-up" }
}

struct DurableEntry: Equatable {
    let id: Int64
    let record: Google_Protobuf_Struct

    init?(_ record: Google_Protobuf_Struct) {
        guard let id = record["id"]?.durableNumber else { return nil }
        self.id = id
        self.record = record
    }
}

struct InlineImage: Equatable {
    let data: String
    let mimeType: String

    init?(_ block: Google_Protobuf_Struct) {
        guard let data = block["data"]?.text, !data.isEmpty else { return nil }
        self.data = data
        mimeType = block["mimeType"]?.text ?? "image"
    }
}

struct TranscriptTool: Equatable {
    enum State: String {
        case pending, running, done, failed, stopped
    }

    var name: String
    var arguments: Google_Protobuf_Struct?
    var output = ""
    var images: [InlineImage] = []
    var details: Google_Protobuf_Value?
    var state = State.pending
    var duration: Double?
    var nested = false

    var target: String? {
        for key in ["path", "file_path", "command", "query", "name", "title"] {
            if let value = arguments?[key]?.text, !value.isEmpty { return cleanText(value) }
        }
        return nil
    }

    var argumentText: String? {
        guard let arguments, !arguments.fields.isEmpty else { return nil }
        return prettyJSON(try? arguments.jsonUTF8Data())
    }

    var diff: String? { details?.object?["diff"]?.text.map(cleanText) }
    var detailText: String? {
        guard let details, details.object?.fields.isEmpty != true, details.kind != .nullValue(.nullValue) else { return nil }
        if let diff, !diff.isEmpty, details.object?.fields.count == 1 { return nil }
        return prettyJSON(try? details.jsonUTF8Data())
    }

    private func prettyJSON(_ data: Data?) -> String? {
        guard let data,
              let object = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]),
              let sorted = try? JSONSerialization.data(withJSONObject: object, options: [.fragmentsAllowed, .prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
        else { return nil }
        return cleanText(String(decoding: sorted, as: UTF8.self))
    }
}

struct TranscriptRow: Equatable, Identifiable {
    enum Style: Equatable { case user, scheduled, delegated, assistant, thinking, notice, warning, error }
    enum Content: Equatable {
        case text(Style, String)
        case image(InlineImage)
        case tool(String)
    }

    let id: String
    let content: Content
    var streaming = false
}

struct TranscriptContent: Equatable {
    var rows: [TranscriptRow] = []
    var tools: [String: TranscriptTool] = [:]

    init() {}

    init(entries: [DurableEntry]) {
        for entry in entries {
            let payload = entry.record
            let kind = payload["kind"]?.text
            // Reports contribute to model context, not the coordinator's visible chat.
            if kind == "anima.agent-report" { continue }
            if kind == "pi.compaction" || kind == "pi.reset" {
                appendText(kind == "pi.reset" ? "Context reset" : "Context compacted", .notice, id: "\(entry.id):context")
                continue
            }
            let data = payload["data"]?.object
            for (index, value) in (payload["model"]?.items ?? []).enumerated() {
                guard let message = value.object else { continue }
                appendMessage(message, id: "\(entry.id):\(index)", delegated: data?["origin"]?.text == "agent",
                              scheduled: kind == "anima.scheduled-message" || data?["origin"]?.text == "schedule",
                              delegatedText: kind == "anima.agent-message" ? data?["content"]?.text : nil)
            }
        }
    }

    func includingLive(_ live: Google_Protobuf_Struct?) -> TranscriptContent {
        var frame = self
        let generation = live?["generation"]?.object
        if let message = generation?["message"]?.object {
            frame.appendMessage(message, id: "live", streaming: true)
        }
        for (key, nested) in [("tools", false), ("nestedTools", true)] {
            for slot in live?[key]?.items ?? [] {
                guard let value = slot.object, let id = value["callId"]?.durableID else { continue }
                var tool = frame.tools[id] ?? TranscriptTool(name: value["name"]?.text ?? "tool", nested: nested)
                guard tool.state != .done, tool.state != .failed else { continue }
                let summary = value["summary"]?.object
                tool.arguments = value["arguments"]?.object ?? tool.arguments
                tool.details = value["details"]
                tool.duration = summary?["durationMs"]?.numberValue
                tool.output = cleanText(value["output"]?.text ?? summary?["error"]?.text ?? "")
                tool.state = summary?["isError"]?.boolValue == true ? .failed :
                    (value["status"]?.text.flatMap(TranscriptTool.State.init(rawValue:)) ?? .pending)
                frame.putTool(tool, id: id)
            }
        }
        if let error = generation?["retry"]?.object?["error"]?.text {
            frame.appendText("Retrying: \(error)", .warning, id: "generation-retry")
        }
        for (index, status) in (live?["compactions"]?.items ?? []).enumerated() {
            if let error = status.object?["retry"]?.object?["error"]?.text {
                frame.appendText("Retrying compaction: \(error)", .warning, id: "compaction-retry:\(index)")
            }
        }
        if let error = live?["compactionFailure"]?.object?["error"]?.text {
            frame.appendText("Compaction failed: \(error)", .error, id: "compaction-failure")
        }
        return frame
    }

    private mutating func putTool(_ tool: TranscriptTool, id: String) {
        if tools.updateValue(tool, forKey: id) == nil {
            rows.append(.init(id: "tool:\(id)", content: .tool(id)))
        }
    }

    private mutating func appendText(_ text: String, _ style: TranscriptRow.Style, id: String, streaming: Bool = false) {
        let text = cleanText(text)
        if !text.isEmpty { rows.append(.init(id: id, content: .text(style, text), streaming: streaming)) }
    }

    private mutating func appendMessage(
        _ message: Google_Protobuf_Struct, id: String, delegated: Bool = false, scheduled: Bool = false,
        delegatedText: String? = nil, streaming: Bool = false
    ) {
        let content = message["content"]
        switch message["role"]?.text {
        case "user", "assistant":
            let style: TranscriptRow.Style = message["role"]?.text == "assistant" ? .assistant :
                (scheduled ? .scheduled : (delegated ? .delegated : .user))
            let textID = style == .assistant ? "\(id):response" : id
            if delegated, let delegatedText {
                appendText(delegatedText, style, id: textID)
            } else if let text = content?.text {
                appendText(text, style, id: textID, streaming: streaming)
            } else {
                let parts = content?.items ?? []
                var responseParts: [String] = []
                var calls: [Google_Protobuf_Struct] = []
                for (index, part) in parts.enumerated() {
                    guard let block = part.object else { continue }
                    let key = "\(id):\(index)"
                    switch block["type"]?.text {
                    case "text":
                        guard let text = block["text"]?.text, !text.isEmpty else { continue }
                        if style == .assistant { responseParts.append(text) }
                        else { appendText(text, style, id: key, streaming: streaming) }
                    case "thinking": appendText(block["thinking"]?.text ?? "", .thinking, id: key, streaming: streaming)
                    case "image":
                        if let image = InlineImage(block) { rows.append(.init(id: key, content: .image(image))) }
                    case "toolCall": calls.append(block)
                    default: break
                    }
                }
                // Prose blocks from the same response share a selection range.
                // Tool disclosures remain separate, in call order below the response.
                appendText(responseParts.joined(separator: "\n\n"), style, id: textID, streaming: streaming)
                for block in calls {
                    guard let call = block["id"]?.text else { continue }
                    var tool = tools[call] ?? TranscriptTool(name: block["name"]?.text ?? "tool", state: streaming ? .pending : .stopped)
                    tool.arguments = block["arguments"]?.object ?? tool.arguments
                    putTool(tool, id: call)
                }
            }
            if let error = message["errorMessage"]?.text { appendText(error, .error, id: "\(id):error") }
        case "toolResult":
            guard let call = message["toolCallId"]?.text else { return }
            let parts = content?.items.compactMap(\.object) ?? []
            var tool = tools[call] ?? TranscriptTool(name: message["toolName"]?.text ?? "tool")
            tool.output = cleanText(content?.text ?? parts.compactMap { $0["type"]?.text == "text" ? $0["text"]?.text : nil }.joined(separator: "\n"))
            tool.images = parts.compactMap { $0["type"]?.text == "image" ? InlineImage($0) : nil }
            tool.details = message["details"]
            tool.state = message["isError"]?.boolValue == true ? .failed : .done
            tool.duration = message["durationMs"]?.numberValue
            putTool(tool, id: call)
        default: break
        }
    }
}

func workingConversations(in graph: Google_Protobuf_Struct) -> Set<String> {
    let tasks = graph["tasks"]?.object?.fields ?? [:]
    var working = Set<String>()
    for (id, value) in tasks {
        guard let conversation = value.object?["conversationId"]?.durableID else { continue }
        var seen = Set<String>()
        var current: String? = id
        var background = false
        while let key = current, seen.insert(key).inserted, let node = tasks[key]?.object {
            if node["background"]?.boolValue == true { background = true; break }
            current = node["owner"]?.durableID
        }
        if !background { working.insert(conversation) }
    }
    return working
}
