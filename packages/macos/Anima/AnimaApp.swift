import SwiftUI

@main
struct AnimaApp: App {
    @State private var connection = ServerConnection()

    var body: some Scene {
        Window("Anima", id: "workspace") {
            Group {
                if let workspace = connection.workspace {
                    WorkspaceView(workspace: workspace).id(workspace.id)
                } else {
                    VStack(spacing: 0) {
                        AppHeader { ServerSettingsLink() }
                        TerminalRule()
                        WorkspaceEmpty(symbol: ">_", title: "Connect to Anima",
                                       detail: "Choose a server to open your workspace.") {
                            Button("Connect to \(connection.address.authority)") { connection.connect(to: connection.address) }
                                .buttonStyle(TerminalButtonStyle(primary: true))
                            SettingsLink { Text("Server Settings…") }.buttonStyle(TerminalButtonStyle())
                        }
                    }
                }
            }
            .frame(minWidth: 720, minHeight: 500)
            .font(Terminal.font())
            .foregroundStyle(Terminal.text)
            .tint(Terminal.accent)
            .background(Terminal.black)
            .containerBackground(Terminal.black, for: .window)
            .ignoresSafeArea(.container, edges: .top)
            .preferredColorScheme(.dark)
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1160, height: 780)
        .commands { WorkspaceCommands() }

        Settings {
            ServerSettings(connection: connection)
                .preferredColorScheme(.dark)
        }
    }
}

struct AppHeader<Actions: View>: View {
    @ViewBuilder var actions: Actions

    var body: some View {
        HStack(spacing: 8) {
            Spacer()
            actions
        }
        .padding(.trailing, 10).frame(height: 34)
        .background { Terminal.black.gesture(WindowDragGesture()) }
    }
}

struct ServerSettingsLink: View {
    var body: some View {
        SettingsLink {
            Image(systemName: "gearshape").font(.system(size: 11))
                .frame(width: Terminal.controlSize, height: Terminal.controlSize)
        }
        .buttonStyle(QuietButtonStyle())
        .help("Server Settings (⌘,)")
        .accessibilityLabel("Server Settings")
    }
}

struct WorkspaceEmpty<Actions: View>: View {
    let symbol: String
    let title: String
    let detail: String
    @ViewBuilder var actions: Actions

    var body: some View {
        VStack(spacing: 8) {
            Text(symbol).font(Terminal.font(18)).foregroundStyle(Terminal.accent).bold().accessibilityHidden(true)
            Text(title).font(Terminal.font(17)).foregroundStyle(Terminal.text)
            Text(detail).font(Terminal.font()).foregroundStyle(Terminal.muted)
                .multilineTextAlignment(.center).textSelection(.enabled)
            HStack(spacing: 8) { actions }.padding(.top, 9)
        }
        .frame(maxWidth: 480)
        .padding(26)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct ServerSettings: View {
    let connection: ServerConnection
    @State private var host: String
    @State private var port: String
    @State private var tls: Bool
    @State private var error: String?

    init(connection: ServerConnection) {
        self.connection = connection
        _host = State(initialValue: connection.address.host)
        _port = State(initialValue: String(connection.address.port))
        _tls = State(initialValue: connection.address.tls)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionCaption("CONNECTION")
            Text("Anima server").font(Terminal.font(17))
            Text("Connect to an already-running Anima server. The app does not start or stop it.")
                .foregroundStyle(Terminal.muted).fixedSize(horizontal: false, vertical: true)
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 5) {
                    SectionCaption("HOSTNAME OR IP")
                    TextField("127.0.0.1", text: $host).textFieldStyle(TerminalFieldStyle())
                        .accessibilityLabel("Hostname or IP").onSubmit(connect)
                }
                VStack(alignment: .leading, spacing: 5) {
                    SectionCaption("PORT")
                    TextField("4242", text: $port).textFieldStyle(TerminalFieldStyle())
                        .accessibilityLabel("Port").onSubmit(connect)
                }
                .frame(width: 86)
            }
            Toggle("Use HTTPS", isOn: $tls).toggleStyle(.checkbox)
            Text(tls ? "The server or proxy must present a trusted certificate." :
                    "HTTP is unencrypted. For a remote server, use a trusted tunnel or an HTTPS endpoint.")
                .font(Terminal.font(Terminal.labelSize)).foregroundStyle(Terminal.muted)
                .fixedSize(horizontal: false, vertical: true)
            if let error { ErrorLine(message: error) }
            TerminalRule()
            connectionStatus
            HStack {
                Spacer()
                if connection.workspace != nil {
                    Button("Disconnect", action: connection.disconnect).buttonStyle(TerminalButtonStyle())
                }
                Button("Connect", action: connect).buttonStyle(TerminalButtonStyle(primary: true))
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20).frame(width: 440)
        .font(Terminal.font()).foregroundStyle(Terminal.text).tint(Terminal.accent)
        .background(Terminal.black)
        .onChange(of: host) { error = nil }
        .onChange(of: port) { error = nil }
    }

    @ViewBuilder private var connectionStatus: some View {
        switch connection.workspace?.directoryConnection {
        case .connected:
            Label("Connected to \(connection.address.authority)", systemImage: "checkmark.circle")
                .foregroundStyle(Terminal.good).font(Terminal.font(Terminal.labelSize))
        case .connecting:
            Text("Connecting to \(connection.address.authority)…").foregroundStyle(Terminal.amber)
        case .retrying(let failure):
            ErrorLine(message: "\(connection.address.authority) · \(failure) Retrying…", tint: Terminal.amber)
        case nil:
            Text("Disconnected").foregroundStyle(Terminal.muted)
        }
    }

    private func connect() {
        do {
            let address = try ServerAddress(host: host, port: port, tls: tls)
            host = address.host
            port = String(address.port)
            error = nil
            connection.connect(to: address)
        } catch {
            self.error = describe(error)
        }
    }
}

enum AnimaCommand: String, CaseIterable, Identifiable {
    case new, conversations, rename, archive, archived, cwd, model, queue, compact, sidebar, agents, resize, help, quit, server

    var id: String { rawValue }
    var slash: String { "/\(rawValue)" }

    var detail: String {
        switch self {
        case .new: "New conversation in a server folder"
        case .conversations: "Find and switch conversations"
        case .rename: "Rename this conversation"
        case .archive: "Archive this conversation without stopping its work"
        case .archived: "Restore archived conversations or sibling agents"
        case .cwd: "Change the server folder while idle"
        case .model: "Choose the chat model (⌃L)"
        case .queue: "Edit or withdraw queued inputs"
        case .compact: "Summarize older context: /compact [instructions]"
        case .sidebar: "Toggle conversations (F2)"
        case .agents: "Toggle subagents (F3)"
        case .resize: "Resize a panel: /resize left|right columns"
        case .help: "Show commands and keyboard shortcuts"
        case .quit: "Quit Anima without stopping the server"
        case .server: "Open Server Settings (⌘,)"
        }
    }
}

enum WorkspaceAction {
    case command(AnimaCommand)
    case toggleThinking, toggleTools, cycleFocus, find, stop, withdraw, cycleThinking
}

struct WorkspaceActions {
    let connected: Bool
    let hasChat: Bool
    let handle: (WorkspaceAction) -> Void
}

extension FocusedValues {
    @Entry var animaWorkspace: WorkspaceActions?
}

private struct WorkspaceCommands: Commands {
    @FocusedValue(\.animaWorkspace) private var workspace
    @Environment(\.openWindow) private var openWindow

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("New Conversation…") { workspace?.handle(.command(.new)) }
                .keyboardShortcut("n").disabled(workspace?.connected != true)
        }
        CommandMenu("Workspace") {
            Button("Show Workspace") { openWindow(id: "workspace") }
            Divider()
            Button("Switch Conversation…") { workspace?.handle(.command(.conversations)) }
                .keyboardShortcut("k").disabled(workspace?.connected != true)
            Button("Toggle Conversations") { workspace?.handle(.command(.sidebar)) }
                .keyboardShortcut(functionKey(2), modifiers: []).disabled(workspace == nil)
            Button("Toggle Subagents") { workspace?.handle(.command(.agents)) }
                .keyboardShortcut(functionKey(3), modifiers: []).disabled(workspace?.hasChat != true)
            Button("Switch Chat Focus") { workspace?.handle(.cycleFocus) }
                .keyboardShortcut(functionKey(6), modifiers: []).disabled(workspace?.hasChat != true)
            Divider()
            Button("Find in Transcript…") { workspace?.handle(.find) }
                .keyboardShortcut("f").disabled(workspace?.hasChat != true)
            Button("Toggle Thinking Blocks") { workspace?.handle(.toggleThinking) }
                .keyboardShortcut("t", modifiers: .control).disabled(workspace == nil)
            Button("Toggle Tool Details") { workspace?.handle(.toggleTools) }
                .keyboardShortcut("o", modifiers: .control).disabled(workspace?.hasChat != true)
            Button("Choose Model…") { workspace?.handle(.command(.model)) }
                .keyboardShortcut("l", modifiers: .control).disabled(workspace?.hasChat != true)
            Button("Stop Work") { workspace?.handle(.stop) }
                .keyboardShortcut(".").disabled(workspace?.hasChat != true)
            Button("Withdraw All Queued Input") { workspace?.handle(.withdraw) }
                .disabled(workspace?.hasChat != true)
            Divider()
            Button("Command Palette…") { workspace?.handle(.command(.help)) }
                .keyboardShortcut("p", modifiers: [.command, .shift]).disabled(workspace == nil)
        }
    }

    private func functionKey(_ number: Int) -> KeyEquivalent {
        KeyEquivalent(Character(UnicodeScalar(0xF703 + number)!))
    }
}
