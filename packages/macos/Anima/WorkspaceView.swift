import AnimaProtocol
import AppKit
import SwiftUI

struct WorkspaceView: View {
    let workspace: WorkspaceModel
    @AppStorage("workspace.leftWidth") private var leftWidth = 204.0
    @AppStorage("workspace.rightWidth") private var rightWidth = 340.0
    @Environment(\.openSettings) private var openSettings
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dialog: PresentedDialog?
    @State private var afterDismiss: (() -> Void)?
    @State private var agentListFocus: UUID?
    @State private var agentListActive = false

    var body: some View {
        let token = workspace.reconnectID
        GeometryReader { geometry in
            let width = geometry.size.width
            let narrow = width < 840
            let drawer = workspace.showsAgents && narrow
            let right = max(280, min(rightWidth, width - 480))
            let remaining = width - (workspace.showsAgents && !narrow ? right + PanelDivider.thickness : 0)
            let left = max(158, min(leftWidth, remaining - 365))
            let showsLeft = workspace.showsConversations && !drawer && remaining >= 530
            VStack(spacing: 0) {
                header(drawer: drawer)
                TerminalRule()
                HStack(spacing: 0) {
                    DockedPanel(open: showsLeft, width: left + PanelDivider.thickness, edge: .trailing) {
                        HStack(spacing: 0) {
                            sidebar.frame(width: left)
                            PanelDivider(width: left, direction: 1) { leftWidth = min(420, max(158, $0)) }
                        }
                    }
                    if !drawer { main.frame(maxWidth: .infinity).transition(.opacity) }
                    DockedPanel(open: workspace.showsAgents,
                                width: narrow ? width : right + PanelDivider.thickness, edge: .leading) {
                        HStack(spacing: 0) {
                            if !narrow {
                                PanelDivider(width: right, direction: -1) { rightWidth = min(640, max(280, $0)) }
                            }
                            agents(drawer: drawer).frame(width: narrow ? width : right)
                        }
                    }
                }
                footer
            }
            .focusedSceneValue(\.animaWorkspace, WorkspaceActions(
                connected: workspace.directoryConnection.isReady,
                hasChat: workspace.coordinatorID != nil
            ) { handle($0, origin: origin(drawer: drawer), drawer: drawer) })
            .onChange(of: drawer) {
                if drawer { focusAgents() }
                else if let id = workspace.coordinatorID { workspace.requestFocus(id) }
            }
            .sheet(item: $dialog, onDismiss: {
                if let next = afterDismiss { afterDismiss = nil; next() }
                else if workspace.showsAgents, workspace.workerID == nil, drawer || agentListActive { focusAgents() }
                else { workspace.restoreFocus() }
            }) { presentation in
                dialogView(presentation.kind)
                    .font(Terminal.font())
                    .foregroundStyle(Terminal.text)
                    .tint(Terminal.accent)
                    .background(Terminal.black)
                    .preferredColorScheme(.dark)
            }
        }
        .task(id: token) { await workspace.follow(for: token) }
    }

    private func header(drawer: Bool) -> some View {
        AppHeader {
            TerminalIcon(symbol: "sidebar.left", label: "Toggle conversations (F2)",
                         highlighted: workspace.showsConversations && !drawer) {
                animate {
                    if drawer { toggleAgents(); workspace.showsConversations = true }
                    else { workspace.showsConversations.toggle() }
                }
            }
            Button(action: toggleAgents) {
                HStack(spacing: 6) {
                    Image(systemName: "sidebar.right").font(.system(size: 11, weight: .medium))
                    Text("Subagents  \(workspace.workers.count)").font(Terminal.font(Terminal.labelSize))
                }
                .padding(.horizontal, 7).frame(height: Terminal.controlSize)
            }
            .buttonStyle(QuietButtonStyle(highlighted: workspace.showsAgents))
            .help("Toggle subagents (F3)")
            .disabled(workspace.coordinatorID == nil)
            TerminalRule(vertical: true).frame(height: 15)
            TerminalIcon(symbol: "plus", label: "New conversation (⌘N)") { command(.new, in: origin(drawer: drawer)) }
                .disabled(!workspace.directoryConnection.isReady)
            ServerSettingsLink()
        }
    }

    private var sidebar: some View {
        VStack(spacing: 0) {
            HStack {
                SectionCaption("CONVERSATIONS")
                Spacer()
                Text(workspace.coordinators.count, format: .number)
                    .font(Terminal.font(Terminal.metaSize)).foregroundStyle(Terminal.muted)
            }
            .padding(.horizontal, Terminal.paneInset).frame(height: Terminal.paneHeaderHeight)
            .overlay(alignment: .bottom) { TerminalRule() }
            ConversationList(items: workspace.coordinators, selectedID: workspace.coordinatorID, working: workspace.workingIDs,
                             empty: "No conversations yet") { id in
                animate { workspace.selectCoordinator(id) }
            }
            TerminalRule()
            VStack(alignment: .leading, spacing: 2) {
                sidebarButton("New conversation", icon: "plus", shortcut: "⌘N", accent: true) {
                    command(.new, in: workspace.coordinatorID.map(workspace.chat))
                }
                sidebarButton("Archived…", icon: "archivebox") { present(.archived(nil)) }
            }
            .disabled(!workspace.directoryConnection.isReady)
            .padding(8)
        }
        .frame(maxHeight: .infinity)
    }

    private func sidebarButton(
        _ label: String, icon: String, shortcut: String? = nil, accent: Bool = false, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 7) {
                Image(systemName: icon).font(.system(size: 10)).frame(width: 13)
                Text(label).font(Terminal.font(Terminal.labelSize)).lineLimit(1)
                Spacer(minLength: 0)
                if let shortcut { KeyHint(shortcut) }
            }
            .padding(.horizontal, 5).frame(height: Terminal.controlSize)
        }
        .buttonStyle(QuietButtonStyle(tint: accent ? Terminal.accent : nil))
    }

    @ViewBuilder private var main: some View {
        if let id = workspace.coordinatorID {
            chatPane(id, worker: false)
        } else {
            switch workspace.directoryConnection {
            case .connected:
                WorkspaceEmpty(symbol: ">_", title: "Start a conversation",
                               detail: "Choose a folder on \(workspace.address.authority) to start working.") {
                    Button("New conversation", systemImage: "plus") { command(.new, in: nil) }
                        .buttonStyle(TerminalButtonStyle(primary: true))
                    Button("Archived…") { present(.archived(nil)) }.buttonStyle(TerminalButtonStyle())
                }
            case .connecting:
                WorkspaceEmpty(symbol: "···", title: "Connecting to Anima", detail: workspace.address.origin) {
                    SettingsLink { Text("Server Settings…") }.buttonStyle(TerminalButtonStyle())
                }
            case .retrying(let error):
                WorkspaceEmpty(symbol: ">_", title: "Waiting for the server",
                               detail: "\(workspace.address.authority) · \(cleanText(error))") {
                    SettingsLink { Text("Server Settings…") }.buttonStyle(TerminalButtonStyle(primary: true))
                    Button("Retry now", action: workspace.reconnect).buttonStyle(TerminalButtonStyle())
                }
            }
        }
    }

    @ViewBuilder private func agents(drawer: Bool) -> some View {
        if let id = workspace.workerID {
            chatPane(id, worker: true, drawer: drawer)
        } else {
            VStack(spacing: 0) {
                HStack(spacing: 7) {
                    SectionCaption("SUBAGENTS")
                    Text(workspace.workers.count, format: .number)
                        .font(Terminal.font(Terminal.metaSize)).foregroundStyle(Terminal.muted)
                    Spacer()
                    TerminalIcon(symbol: "xmark", label: "Hide subagents (F3)", action: toggleAgents)
                }
                .padding(.horizontal, Terminal.paneInset).frame(height: Terminal.paneHeaderHeight)
                .overlay(alignment: .bottom) { TerminalRule() }
                ConversationList(items: workspace.workers, selectedID: nil, working: workspace.workingIDs,
                                 empty: "No subagents yet", showsTask: true, focusRequest: agentListFocus,
                                 focusChanged: { agentListActive = $0 }, close: toggleAgents) { id in
                    animate { workspace.selectWorker(id) }
                }
                TerminalRule()
                sidebarButton("Archived subagents…", icon: "archivebox") {
                    if let owner = workspace.coordinatorID { present(.archived(owner)) }
                }
                .disabled(!workspace.directoryConnection.isReady)
                .padding(8)
            }
            .frame(maxHeight: .infinity)
            .transition(.opacity)
        }
    }

    private func chatPane(_ id: String, worker: Bool, drawer: Bool = false) -> some View {
        let chat = workspace.chat(id)
        let back: (() -> Void)? = worker ? { backToAgentList() } : nil
        let pane = ChatView(chat: chat, info: workspace.info(id), isWorker: worker,
                            selected: workspace.activeID == id && !agentListActive, hideThinking: workspace.hidesThinking,
                            taskBusy: workspace.workingIDs?.contains(id) == true,
                            reconnectID: workspace.reconnectID, backToAgents: back,
                            onActivate: { agentListActive = false; workspace.activate(id) },
                            onComment: { excerpt in
                                guard dialog == nil else { return }
                                agentListActive = false
                                workspace.activate(id)
                                present(.comment(chat, excerpt))
                            },
                            onAction: { handle($0, origin: chat, drawer: drawer) },
                            onCommand: { command($0, argument: $1, in: chat) })
        return pane.id(id).transition(.opacity)
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 0) {
            TerminalRule()
            if let error = workspace.error {
                HStack {
                    ErrorLine(message: error)
                    Spacer()
                    TerminalIcon(symbol: "xmark", label: "Dismiss error") { workspace.error = nil }
                }
                .padding(.horizontal, 10)
                TerminalRule()
            }
            HStack(spacing: 9) {
                SettingsLink {
                    HStack(spacing: 7) {
                        Circle().fill(connectionTint).frame(width: 5, height: 5)
                        Text(connectionLabel).foregroundStyle(connectionTint)
                        Text(workspace.address.authority).foregroundStyle(Terminal.muted)
                        if workspace.address.tls { Image(systemName: "lock").foregroundStyle(Terminal.muted) }
                    }
                    .padding(.horizontal, 6).frame(height: 23)
                }
                .buttonStyle(QuietButtonStyle()).help("Server Settings (⌘,)")
                if let detail = connectionDetail {
                    Text(cleanText(detail)).foregroundStyle(Terminal.muted).lineLimit(1).help(cleanText(detail))
                }
                Spacer(minLength: 4)
                Button {
                    command(.help, in: workspace.activeChat)
                } label: {
                    HStack(spacing: 6) { Text("Commands"); KeyHint("⇧⌘P") }
                        .padding(.horizontal, 5).frame(height: 23)
                }
                .buttonStyle(QuietButtonStyle())
            }
            .font(Terminal.font(Terminal.metaSize)).padding(.horizontal, 7).frame(height: 24)
        }
    }

    private var connectionTint: Color { workspace.directoryConnection.isReady ? Terminal.good : Terminal.amber }
    private var connectionLabel: String {
        switch workspace.directoryConnection {
        case .connected: "CONNECTED"
        case .connecting: "CONNECTING"
        case .retrying: "RECONNECTING"
        }
    }

    private var connectionDetail: String? {
        if case .retrying(let error) = workspace.directoryConnection { return error }
        return workspace.taskError.map { "Task status unavailable: \($0)" }
    }

    private func origin(drawer: Bool) -> ConversationModel? {
        if drawer { return workspace.workerID.map(workspace.chat) }
        return agentListActive ? workspace.coordinatorID.map(workspace.chat) : workspace.activeChat
    }

    private func handle(_ action: WorkspaceAction, origin chat: ConversationModel?, drawer: Bool) {
        guard dialog == nil else { return }
        switch action {
        case .command(let name): command(name, in: chat)
        case .toggleThinking: workspace.hidesThinking.toggle()
        case .toggleTools: animate { chat?.toggleAllTools() }
        case .cycleFocus:
            if drawer { toggleAgents() }
            else if workspace.showsAgents, workspace.workerID == nil, !agentListActive { focusAgents() }
            else { agentListActive = false; workspace.cycleFocus(drawer: false) }
        case .find: chat?.findRequest = UUID()
        case .stop: if let chat { Task { await chat.abort() } }
        case .withdraw: if let chat { Task { await chat.withdrawAll() } }
        case .cycleThinking: if let chat { Task { await chat.cycleThinking() } }
        }
    }

    private func animate(_ change: () -> Void) {
        withAnimation(Terminal.motion(reduced: reduceMotion), change)
    }

    private func toggleAgents() {
        animate {
            workspace.toggleAgents()
            if workspace.showsAgents { focusAgents() } else { agentListActive = false }
        }
    }

    private func backToAgentList() {
        animate {
            workspace.showAgentList()
            focusAgents()
        }
    }

    private func focusAgents() {
        if let id = workspace.workerID { agentListActive = false; workspace.requestFocus(id) }
        else { agentListFocus = UUID() }
    }

    private func present(_ kind: WorkspaceDialog) { dialog = PresentedDialog(kind: kind) }

    private func advance(_ next: @escaping () -> Void) {
        afterDismiss = next
    }

    private func command(_ name: AnimaCommand, argument: String = "", in chat: ConversationModel?) {
        workspace.error = nil
        chat?.clearNotice()
        switch name {
        case .sidebar: animate { workspace.showsConversations.toggle() }
        case .agents: toggleAgents()
        case .quit: NSApplication.shared.terminate(nil)
        case .server: openSettings()
        case .help: present(.help(chat))
        case .resize:
            let parts = argument.split(whereSeparator: \.isWhitespace)
            guard parts.count == 2, let columns = Double(parts[1]), columns.isFinite, columns >= 1,
                  parts[0] == "left" || parts[0] == "right" else {
                workspace.error = "Usage: /resize left|right columns. You can also drag the divider."
                return
            }
            let pixels = min(columns, 200) * Terminal.columnWidth
            animate {
                if parts[0] == "left" { leftWidth = min(420, max(158, pixels)) }
                else { rightWidth = min(640, max(280, pixels)) }
            }
        case .new:
            guard workspace.directoryConnection.isReady else { workspace.error = "Connect to a server first."; return }
            present(.new(argument.isEmpty ? chat?.status?.cwd ?? "" : argument))
        case .conversations: present(.conversations)
        case .archived:
            let info = chat.flatMap { workspace.info($0.id) }
            present(.archived(info?.hasOwnerConversationID == true ? info?.ownerConversationID : nil))
        default:
            guard let chat else { workspace.error = "Create or select a conversation first."; return }
            guard chat.ready else { chat.report(ClientIssue("Wait for the conversation to reconnect.")); return }
            switch name {
            case .rename:
                if argument.isEmpty { present(.rename(chat)) }
                else { Task { do { try await chat.update { $0.name = argument } } catch { chat.report(error) } } }
            case .archive: present(.archive(chat))
            case .cwd:
                if argument.isEmpty { present(.folder(chat)) }
                else { Task { do { try await chat.update { $0.cwd = argument } } catch { chat.report(error) } } }
            case .model: present(.models(chat))
            case .queue: present(.queue(chat))
            case .compact: Task { await chat.compact(instructions: argument) }
            default: break
            }
        }
    }

    @ViewBuilder private func dialogView(_ route: WorkspaceDialog) -> some View {
        switch route {
        case .new(let path):
            FolderDialog(client: workspace.client, initialPath: path, creating: true) { path, name in
                try await workspace.createConversation(in: path, name: name)
            }
        case .folder(let chat):
            FolderDialog(client: workspace.client, initialPath: chat.status?.cwd ?? "", creating: false) { path, _ in
                try await chat.update { $0.cwd = path }
            }
        case .rename(let chat):
            NameDialog(current: workspace.name(chat.id)) { name in try await chat.update { $0.name = name } }
        case .archive(let chat):
            ArchiveDialog(name: workspace.name(chat.id)) { try await chat.update { $0.archived = true } }
        case .conversations:
            SelectionDialog(title: "Switch conversation", options: workspace.coordinators.map(SelectionOption.init)) { id in
                agentListActive = false
                workspace.selectCoordinator(id)
            }
        case .archived(let owner):
            let archived = workspace.conversations(owner: owner, archived: true)
            SelectionDialog(title: owner == nil ? "Archived conversations" : "Archived subagents",
                            options: archived.map(SelectionOption.init), actionLabel: "Restore") { id in
                guard let item = archived.first(where: { $0.conversationID == id }) else { return }
                try await workspace.restore(item)
            }
        case .models(let chat):
            ModelDialog(client: workspace.client, chat: chat)
        case .queue(let chat):
            SelectionDialog(title: "Queued inputs", options: chat.queued.map {
                SelectionOption(id: $0.id, title: cleanText(String($0.content.prefix(200))), subtitle: $0.modeLabel)
            }, actionLabel: "Edit") { id in
                guard let item = chat.queued.first(where: { $0.id == id }) else { return }
                advance { present(.editQueue(chat, item)) }
            }
        case .editQueue(let chat, let item):
            QueueDialog(chat: chat, item: item)
        case .comment(let chat, let excerpt):
            CommentDialog(excerpt: excerpt) { comment in
                chat.appendComment(comment, on: excerpt)
            }
        case .help(let chat):
            SelectionDialog(title: "Command palette", subtitle: "F2 / F3 panels · F6 focus · ⌘F find · ⌥↩ queue · Esc stop",
                            options: AnimaCommand.allCases.filter { $0 != .help }.map {
                SelectionOption(id: $0.rawValue, title: $0.slash, subtitle: $0.detail)
            }, actionLabel: "Run") { id in
                if let name = AnimaCommand(rawValue: id) { advance { command(name, in: chat) } }
            }
        }
    }
}

private struct DockedPanel<Content: View>: View {
    let open: Bool
    let width: CGFloat
    let edge: Alignment
    @ViewBuilder var content: Content

    var body: some View {
        ZStack(alignment: edge) {
            if open { content.frame(width: width).transition(.opacity) }
        }
        .frame(width: open ? width : 0, alignment: edge)
        .frame(maxHeight: .infinity)
        .clipped()
        .allowsHitTesting(open)
    }
}

private struct PanelDivider: View {
    static let thickness: CGFloat = 5
    let width: CGFloat
    let direction: CGFloat
    let resize: (CGFloat) -> Void
    @State private var start: CGFloat?
    @State private var hovering = false

    var body: some View {
        TerminalRule(vertical: true).frame(width: Self.thickness)
            .overlay(alignment: .top) {
                TerminalRule().frame(height: Terminal.paneHeaderHeight, alignment: .bottom)
            }
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0, coordinateSpace: .global)
                .onChanged { value in
                    if start == nil { start = width }
                    resize((start ?? width) + value.translation.width * direction)
                }
                .onEnded { _ in start = nil })
            .onHover { inside in
                guard inside != hovering else { return }
                hovering = inside
                if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() }
            }
            .onDisappear { if hovering { NSCursor.pop(); hovering = false } }
    }
}

private struct ConversationList: View {
    let items: [Anima_V1_ConversationInfo]
    let selectedID: String?
    let working: Set<String>?
    let empty: String
    var showsTask = false
    var focusRequest: UUID? = nil
    var focusChanged: ((Bool) -> Void)? = nil
    var close: (() -> Void)? = nil
    let select: (String) -> Void
    @FocusState private var focused: Bool
    @State private var cursor: String?

    var body: some View {
        ScrollViewReader { scroll in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 3) {
                    if items.isEmpty {
                        Text(empty).font(Terminal.font(Terminal.labelSize)).foregroundStyle(Terminal.muted)
                            .padding(.horizontal, 6).padding(.vertical, 8)
                    }
                    ForEach(items, id: \.conversationID) { info in
                        row(info).id(info.conversationID)
                    }
                }
                .padding(.horizontal, 6).padding(.vertical, 5)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .focusable().focused($focused).focusEffectDisabled()
            .onChange(of: focused) {
                if focused { cursor = selectedID ?? cursor ?? items.first?.conversationID }
                focusChanged?(focused)
            }
            .onChange(of: cursor) { if let cursor { scroll.scrollTo(cursor) } }
            .onChange(of: selectedID) { if let selectedID { scroll.scrollTo(selectedID) } }
            .task(id: focusRequest) { if focusRequest != nil { focused = true } }
            .onKeyPress(.upArrow) { move(-1); return .handled }
            .onKeyPress(.downArrow) { move(1); return .handled }
            .onKeyPress(.return) {
                if let cursor { select(cursor) }
                return .handled
            }
            .onKeyPress(.escape) {
                guard let close else { return .ignored }
                close()
                return .handled
            }
        }
    }

    private func row(_ info: Anima_V1_ConversationInfo) -> some View {
        let id = info.conversationID
        let current = selectedID == id || (focused && cursor == id)
        return Button {
            cursor = id
            select(id)
        } label: {
            HStack(alignment: .top, spacing: 7) {
                Text(current ? "›" : " ").font(Terminal.font()).foregroundStyle(Terminal.accent)
                TerminalDot(state: working.map { $0.contains(id) ? .busy : .idle } ?? .unknown).padding(.top, 5)
                VStack(alignment: .leading, spacing: 2) {
                    Text(cleanText(info.name)).font(Terminal.font())
                        .foregroundStyle(current ? Terminal.accent : Terminal.text).lineLimit(1)
                    if showsTask, info.hasTaskTitle {
                        Text(cleanText(info.taskTitle)).font(Terminal.font(Terminal.metaSize)).foregroundStyle(Terminal.muted).lineLimit(2)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 6).padding(.vertical, 5)
        }
        .buttonStyle(QuietButtonStyle(highlighted: current))
        .help(info.name)
    }

    private func move(_ offset: Int) {
        guard !items.isEmpty else { return }
        let index = items.firstIndex { $0.conversationID == cursor } ?? (offset > 0 ? -1 : items.count)
        cursor = items[max(0, min(items.count - 1, index + offset))].conversationID
    }
}
