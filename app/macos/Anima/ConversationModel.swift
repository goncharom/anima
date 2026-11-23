import AnimaProtocol
import Foundation
import Observation
import SwiftProtobuf

@MainActor @Observable
final class ConversationModel {
    let id: String
    private let client: HarnessClient

    private(set) var ready = false
    private(set) var connectionError: String?
    private(set) var status: Anima_V1_ConversationStatus?
    private(set) var queued: [QueuedInput] = []
    private(set) var working = false
    private(set) var compacting = false
    private(set) var transcript = TranscriptContent()
    private(set) var historyEpoch = 0
    private(set) var olderCursor: String?
    private(set) var loadingOlder = false
    private(set) var sending = false
    private(set) var stopping = false
    private(set) var waitingForCompaction = false
    private(set) var note: String?
    private(set) var error: String?

    var draft = ""
    var focusRequest: UUID?
    var findRequest: UUID?
    var scrollPositionID: String?
    var followsLatest = true
    private(set) var inputHistory: [String] = []
    private(set) var expandAllTools = false
    private var toolOverrides: [String: Bool] = [:]

    @ObservationIgnored private var entries: [Int64: DurableEntry] = [:]
    @ObservationIgnored private var committed = TranscriptContent()
    @ObservationIgnored private var lastLive: Google_Protobuf_Struct?
    @ObservationIgnored private var watchID: UUID?
    @ObservationIgnored private var pendingInput: (content: String, mode: Anima_V1_BusyBehavior, id: String)?
    @ObservationIgnored private var pendingThinking: (level: String, model: Anima_V1_ModelRef?, saving: Bool)?
    @ObservationIgnored private var withdrawing = false

    init(id: String, client: HarnessClient) {
        self.id = id
        self.client = client
    }

    func follow() async {
        let watch = UUID()
        watchID = watch
        ready = false
        connectionError = nil
        defer {
            if watchID == watch { ready = false }
        }
        await HarnessClient.follow(.with { $0.conversationID = id }, open: { client.rpc.watchConversation() }) { response in
            guard watchID == watch else { throw CancellationError() }
            guard response.hasSnapshot, response.snapshot.conversationID == id else {
                throw ClientIssue("Received an invalid conversation snapshot.")
            }
            try await accept(response.snapshot, watch: watch)
            ready = true
            connectionError = nil
        } disconnected: { failure in
            guard watchID == watch else { return }
            ready = false
            connectionError = describe(failure)
        }
    }

    private func accept(_ snapshot: Anima_V1_ConversationSnapshot, watch: UUID) async throws {
        let incoming = snapshot.entries.compactMap(DurableEntry.init)
        let previous = entries.keys.max()
        let newest = incoming.last?.id ?? 0
        let reset = previous.map { $0 > newest } == true || incoming.contains { entry in
            entries[entry.id].map { $0 != entry } == true
        }

        // A disconnected/slow reader may jump past the server's bounded window.
        // Repair that gap before publishing; an interrupted read then retries from the same head.
        var bridge: [DurableEntry] = []
        if !reset, let previous, let first = incoming.first, first.id > previous, snapshot.hasBeforeEntryID {
            var cursor: String? = String(first.id)
            while let before = cursor {
                let page = try await fetch(before: before, limit: 200)
                let records = page.entries.compactMap(DurableEntry.init)
                bridge.append(contentsOf: records.filter { $0.id > previous })
                if records.contains(where: { $0.id <= previous }) { break }
                cursor = page.hasNextBeforeEntryID && page.nextBeforeEntryID != before ? page.nextBeforeEntryID : nil
            }
        }
        try Task.checkCancellation()
        guard watchID == watch else { throw CancellationError() }
        if reset {
            entries.removeAll()
            historyEpoch += 1
            toolOverrides.removeAll()
        }
        if previous == nil || reset {
            // Snapshot marker is the entry just *outside* the window, not the exclusive RPC cursor.
            olderCursor = snapshot.hasBeforeEntryID ? incoming.first.map { String($0.id) } : nil
        }
        if merge(bridge + incoming) || reset { rebuildCommitted() }

        let nextStatus = snapshot.hasStatus ? snapshot.status : nil
        if status != nextStatus { status = nextStatus }
        if pendingThinking?.saving == false { pendingThinking = nil }
        let live = snapshot.docs["pi.live"]
        let activeCompaction = !(live?["compactions"]?.items.isEmpty ?? true)
        if compacting != activeCompaction { compacting = activeCompaction }
        let activeWork = activeCompaction || live?["run"]?.object != nil
        if working != activeWork { working = activeWork }
        let inbox = (snapshot.docs["pi.inbox"]?["items"]?.items ?? []).compactMap(QueuedInput.init)
        if queued != inbox { queued = inbox }
        refreshTranscript(live: live)
        lastLive = live
    }

    @discardableResult
    func loadOlder() async -> Bool {
        guard ready, let before = olderCursor, !loadingOlder else { return false }
        loadingOlder = true
        let epoch = historyEpoch
        defer { loadingOlder = false }
        do {
            let page = try await fetch(before: before, limit: 100)
            guard epoch == historyEpoch, olderCursor == before else { return false }
            olderCursor = page.hasNextBeforeEntryID && page.nextBeforeEntryID != before ? page.nextBeforeEntryID : nil
            if merge(page.entries.compactMap(DurableEntry.init)) {
                rebuildCommitted()
                refreshTranscript(live: lastLive)
            }
            return true
        } catch {
            report(error)
            return false
        }
    }

    private func fetch(before: String, limit: UInt32) async throws -> Anima_V1_GetEntriesResponse {
        try await client.rpc.getEntries(request: .with {
            $0.conversationID = id
            $0.beforeEntryID = before
            $0.limit = limit
        }).value()
    }

    private func merge(_ records: [DurableEntry]) -> Bool {
        var changed = false
        for record in records where entries[record.id] != record {
            entries[record.id] = record
            changed = true
        }
        return changed
    }

    private func rebuildCommitted() {
        committed = TranscriptContent(entries: entries.values.sorted { $0.id < $1.id })
    }

    private func refreshTranscript(live: Google_Protobuf_Struct?) {
        let next = committed.includingLive(live)
        if next != transcript { transcript = next }
    }

    func appendComment(_ comment: String, on excerpt: String) {
        let instruction = "Please address each of my comments on the following excerpts from your earlier replies."
        let lines = draft.split(whereSeparator: \.isNewline)
        // Keep the composer text as the source of truth, even after edits or draft recall.
        let prefix = "Comment "
        let previousNumber = lines.compactMap { line -> Int? in
            guard line.hasPrefix(prefix), line.hasSuffix(":"),
                  let number = Int(line.dropFirst(prefix.count).dropLast()), (1..<Int.max).contains(number) else { return nil }
            return number
        }.max() ?? 0
        let quote = excerpt.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline)
            .map { "> \($0)" }.joined(separator: "\n")
        let block = "Comment \(previousNumber + 1):\n\(quote)\n\nMy comment: \(comment)"
        // Keep any slash-prefixed text, but don't let it dispatch the annotated draft as a command.
        let parts = draft.hasPrefix("/") ? [instruction, draft, block]
            : [draft, lines.contains(Substring(instruction)) ? "" : instruction, block]
        draft = parts.filter { !$0.isEmpty }.joined(separator: "\n\n")
    }

    func recordInput(_ text: String) {
        if inputHistory.last != text {
            inputHistory.append(text)
            if inputHistory.count > 100 { inputHistory.removeFirst() }
        }
    }

    func send(mode: Anima_V1_BusyBehavior) async {
        let content = draft
        guard !sending, !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        guard ready else { report(ClientIssue("Wait for the conversation to reconnect before sending.")); return }
        let requestID = pendingInput.flatMap { $0.content == content && $0.mode == mode ? $0.id : nil } ?? UUID().uuidString
        pendingInput = (content, mode, requestID)
        sending = true
        note = nil
        error = nil
        draft = ""
        defer { sending = false }
        do {
            _ = try await client.rpc.submitInput(request: .with {
                $0.conversationID = id
                $0.content = content
                $0.whenBusy = mode
                $0.requestID = requestID
            }).value()
            pendingInput = nil
            recordInput(content)
        } catch {
            restoreDraft([content], resetPending: false)
            report(error)
        }
    }

    func abort() async {
        guard ready, !stopping else { return }
        stopping = true
        defer { stopping = false }
        do {
            _ = try await client.rpc.abortConversation(request: .with { $0.conversationID = id }).value()
            pendingInput = nil
            error = nil
            note = nil
        } catch { report(error) }
    }

    func update(_ change: (inout Anima_V1_UpdateConversationRequest) -> Void) async throws {
        var request = Anima_V1_UpdateConversationRequest()
        change(&request)
        request.conversationID = id
        _ = try await client.rpc.updateConversation(request: request).value()
    }

    func compact(instructions: String) async {
        guard !waitingForCompaction else { return }
        waitingForCompaction = true
        error = nil
        note = nil
        defer { waitingForCompaction = false }
        do {
            let result = try await client.rpc.compactConversation(request: .with {
                $0.conversationID = id
                if !instructions.isEmpty { $0.instructions = instructions }
            }).value()
            note = result.compacted ? "Context compacted." : "Context unchanged; no compaction was applied."
        } catch { report(error) }
    }

    func setThinking(_ level: String) async {
        guard ready, let status, status.supportedThinkingLevels.contains(level), pendingThinking?.saving != true else { return }
        pendingThinking = (level, status.hasModel ? status.model : nil, true)
        do {
            try await update { $0.thinkingLevel = level }
            if self.status?.thinkingLevel == level || self.status?.model != pendingThinking?.model { pendingThinking = nil }
            else { pendingThinking?.saving = false }
            error = nil
        } catch {
            pendingThinking = nil
            report(error)
        }
    }

    func cycleThinking() async {
        guard let status, status.supportedThinkingLevels.contains(where: { $0 != "off" }) else { return }
        let levels = status.supportedThinkingLevels
        let current = pendingThinking?.level ?? (status.hasThinkingLevel ? status.thinkingLevel : "off")
        await setThinking(levels[((levels.firstIndex(of: current) ?? -1) + 1) % levels.count])
    }

    @discardableResult
    func changeQueue(_ item: QueuedInput, content: String? = nil, mode: Anima_V1_BusyBehavior? = nil,
                     remove: Bool = false) async throws -> String {
        let result = try await client.rpc.updateQueuedInput(request: .with {
            $0.conversationID = id
            $0.submissionID = item.id
            $0.expectedContent = item.content
            $0.expectedMode = item.mode
            $0.remove = remove
            if let content { $0.content = content }
            if let mode { $0.whenBusy = mode }
        }).value()
        return result.content
    }

    func withdrawAll() async {
        guard ready, !withdrawing else { return }
        withdrawing = true
        var restored: [String] = []
        defer { restoreDraft(restored); withdrawing = false }
        do {
            for item in queued { restored.append(try await changeQueue(item, remove: true)) }
            error = nil
        } catch { report(error) }
    }

    func restoreDraft(_ texts: [String], resetPending: Bool = true) {
        guard !texts.isEmpty else { return }
        if resetPending { pendingInput = nil }
        draft = (texts + [draft]).filter { !$0.isEmpty }.joined(separator: "\n\n")
    }

    func toolExpanded(_ id: String) -> Bool { toolOverrides[id] ?? expandAllTools }
    func toggleTool(_ id: String) { toolOverrides[id] = !toolExpanded(id) }
    func toggleAllTools() { expandAllTools.toggle(); toolOverrides.removeAll() }

    func report(_ failure: Error) {
        guard !Task.isCancelled else { return }
        error = describe(failure)
        note = nil
    }

    func clearNotice() { error = nil; note = nil }
}
