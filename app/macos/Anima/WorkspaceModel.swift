import AnimaProtocol
import Foundation
import Observation

@MainActor @Observable
final class WorkspaceModel: Identifiable {
    enum Connection: Equatable {
        case connecting, connected, retrying(String)

        var isReady: Bool { self == .connected }
    }

    let id = UUID()
    let address: ServerAddress
    let client: HarnessClient
    private(set) var directoryConnection = Connection.connecting
    private(set) var taskError: String?
    private(set) var workingIDs: Set<String>?
    private(set) var directory: [Anima_V1_ConversationInfo] = []
    private(set) var coordinatorID: String?
    private(set) var workerID: String?
    private(set) var activeID: String?
    private(set) var reconnectID = UUID()
    var showsConversations = true
    private(set) var showsAgents = false
    var hidesThinking = false
    var error: String?

    @ObservationIgnored private var chats: [String: ConversationModel] = [:]
    @ObservationIgnored private var rememberedWorkers: [String: String] = [:]
    @ObservationIgnored private var pendingSelection: (id: String, owner: String?)?

    init(address: ServerAddress) {
        self.address = address
        client = HarnessClient(address: address)
    }

    var coordinators: [Anima_V1_ConversationInfo] { conversations(owner: nil) }
    var workers: [Anima_V1_ConversationInfo] { coordinatorID.map { conversations(owner: $0) } ?? [] }

    func conversations(owner: String?, archived: Bool = false) -> [Anima_V1_ConversationInfo] {
        directory.filter {
            $0.archived == archived && ($0.hasOwnerConversationID ? $0.ownerConversationID : nil) == owner
        }
    }

    func info(_ id: String) -> Anima_V1_ConversationInfo? { directory.first { $0.conversationID == id } }
    func name(_ id: String) -> String { info(id)?.name ?? "Conversation \(id)" }

    func chat(_ id: String) -> ConversationModel {
        if let chat = chats[id] { return chat }
        let chat = ConversationModel(id: id, client: client)
        chats[id] = chat
        return chat
    }

    var activeChat: ConversationModel? { (activeID ?? coordinatorID).map(chat) }

    func reconnect() {
        directoryConnection = .connecting
        taskError = nil
        workingIDs = nil
        reconnectID = UUID()
    }

    func follow(for token: UUID) async {
        async let directory: Void = followDirectory(token)
        async let tasks: Void = followTasks(token)
        _ = await (directory, tasks)
    }

    private func followDirectory(_ token: UUID) async {
        await HarnessClient.follow(.init(), open: { client.rpc.watchConversations() }) { response in
            guard reconnectID == token else { throw CancellationError() }
            directoryConnection = .connected
            let next = response.conversations.sorted { left, right in
                let order = left.name.localizedStandardCompare(right.name)
                return order == .orderedSame ? left.conversationID < right.conversationID : order == .orderedAscending
            }
            if next != directory { directory = next }
            if !coordinators.contains(where: { $0.conversationID == coordinatorID }) {
                setCoordinator(coordinators.first?.conversationID)
            }
            if let workerID, !workers.contains(where: { $0.conversationID == workerID }) {
                showAgentList()
            }
            if let pending = pendingSelection { selectWhenVisible(pending.id, owner: pending.owner) }
            let available = Set(next.map(\.conversationID))
            chats = chats.filter { available.contains($0.key) }
        } disconnected: { failure in
            guard reconnectID == token else { return }
            directoryConnection = .retrying(describe(failure))
        }
    }

    private func followTasks(_ token: UUID) async {
        await HarnessClient.follow(.init(), open: { client.rpc.watchTaskGraph() }) { response in
            guard reconnectID == token else { throw CancellationError() }
            guard response.hasGraph else { throw ClientIssue("Received an invalid task graph.") }
            let working = workingConversations(in: response.graph)
            if workingIDs != working { workingIDs = working }
            taskError = nil
        } disconnected: { failure in
            guard reconnectID == token else { return }
            workingIDs = nil
            taskError = describe(failure)
        }
    }

    func selectCoordinator(_ id: String) {
        guard coordinators.contains(where: { $0.conversationID == id }) else { return }
        pendingSelection = nil
        setCoordinator(id)
        requestFocus(id)
    }

    private func setCoordinator(_ id: String?) {
        guard coordinatorID != id else { return }
        coordinatorID = id
        let remembered = id.flatMap { rememberedWorkers[$0] }
        workerID = workers.first(where: { $0.conversationID == remembered })?.conversationID
        if let id { requestFocus(id) }
        else { activeID = nil; showsAgents = false }
    }

    func selectWorker(_ id: String) {
        guard let coordinatorID, workers.contains(where: { $0.conversationID == id }) else { return }
        pendingSelection = nil
        workerID = id
        rememberedWorkers[coordinatorID] = id
        showsAgents = true
        requestFocus(id)
    }

    func showAgentList() {
        let wasActive = workerID != nil && activeID == workerID
        workerID = nil
        if wasActive, let coordinatorID { requestFocus(coordinatorID) }
    }

    func toggleAgents() {
        showsAgents.toggle()
        if showsAgents, let workerID { requestFocus(workerID) }
        else if let coordinatorID { requestFocus(coordinatorID) }
    }

    func activate(_ id: String) {
        if id == coordinatorID || id == workerID { activeID = id }
    }

    func requestFocus(_ id: String) {
        activate(id)
        if activeID == id { chat(id).focusRequest = UUID() }
    }

    func restoreFocus() {
        if let activeID { requestFocus(activeID) }
    }

    func cycleFocus(drawer: Bool) {
        if drawer { toggleAgents(); return }
        if showsAgents, activeID == coordinatorID, let workerID { requestFocus(workerID) }
        else if let coordinatorID { requestFocus(coordinatorID) }
    }

    func createConversation(in folder: String, name: String) async throws {
        let result = try await client.rpc.createConversation(request: .with {
            $0.cwd = folder
            $0.name = name
        }).value()
        selectWhenVisible(result.conversationID, owner: nil)
    }

    func restore(_ item: Anima_V1_ConversationInfo) async throws {
        try await chat(item.conversationID).update { $0.archived = false }
        selectWhenVisible(item.conversationID, owner: item.hasOwnerConversationID ? item.ownerConversationID : nil)
    }

    private func selectWhenVisible(_ id: String, owner: String?) {
        if let owner, owner != coordinatorID { pendingSelection = nil; return }
        if conversations(owner: owner).contains(where: { $0.conversationID == id }) {
            if owner == nil { selectCoordinator(id) } else { selectWorker(id) }
        } else {
            pendingSelection = (id, owner)
        }
    }
}
