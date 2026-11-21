import AnimaProtocol
import SwiftUI

struct ChatView: View {
    @Bindable var chat: ConversationModel
    let info: Anima_V1_ConversationInfo?
    let isWorker: Bool
    let selected: Bool
    let hideThinking: Bool
    let taskBusy: Bool
    let reconnectID: UUID
    let backToAgents: (() -> Void)?
    let onActivate: () -> Void
    let onAction: (WorkspaceAction) -> Void
    let onCommand: (AnimaCommand, String) -> Void

    @State private var findOpen = false
    @State private var thinkingOpen = false
    @State private var navigation: TranscriptNavigation?
    @State private var highlightedSuggestion = 0
    @State private var suggestionsDismissed = false
    @State private var historyIndex: Int?
    @State private var draftBeforeHistory = ""
    @State private var recalledText: String?

    private var label: String { cleanText(info?.name ?? "Conversation \(chat.id)") }
    private var isWorking: Bool { chat.ready && (chat.working || taskBusy || chat.waitingForCompaction) }
    private var modeLabel: String { isWorking ? "Steer" : "Send" }
    private var canSubmit: Bool { !chat.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !chat.sending }
    private var commands: [AnimaCommand] {
        let text = chat.draft
        guard !suggestionsDismissed, text.hasPrefix("/"), !text.dropFirst().contains(where: { !$0.isLetter && $0 != "-" }) else { return [] }
        return AnimaCommand.allCases.filter { $0.slash.hasPrefix(text.lowercased()) }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            TranscriptView(chat: chat, hideThinking: hideThinking, isWorker: isWorker,
                           findOpen: $findOpen, navigation: navigation, onActivate: onActivate)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            VStack(alignment: .leading, spacing: 5) {
                notices
                if !commands.isEmpty { commandSuggestions }
                composer
                statusBar
            }
            .chatColumn(worker: isWorker)
            .padding(.vertical, 6)
        }
        .task(id: reconnectID) { await chat.follow() }
        .onChange(of: chat.findRequest) { if chat.findRequest != nil { findOpen = true } }
        .onChange(of: chat.draft) {
            suggestionsDismissed = false
            highlightedSuggestion = 0
            if recalledText != chat.draft { historyIndex = nil; recalledText = nil }
        }
    }

    private var header: some View {
        HStack(spacing: 5) {
            VStack(alignment: .leading, spacing: 2) {
                Text(label).font(Terminal.font(14)).bold().lineLimit(1)
                    .foregroundStyle(Terminal.text).accessibilityAddTraits(.isHeader)
                    .help(info?.hasTaskTitle == true ? cleanText(info?.taskTitle ?? "") : label)
                if let status = chat.status {
                    HStack(spacing: 7) {
                        Label(cleanText(status.cwd), systemImage: "folder").lineLimit(1).truncationMode(.head)
                        if status.hasGitBranch {
                            Label(cleanText(status.gitBranch), systemImage: "arrow.triangle.branch").lineLimit(1)
                        }
                    }
                    .font(Terminal.font(Terminal.metaSize)).foregroundStyle(Terminal.muted)
                    .help(cleanText(status.cwd))
                }
            }
            .overlay(alignment: .leading) {
                if selected { Capsule().fill(Terminal.accent).frame(width: 2, height: 12).offset(x: -7) }
            }
            Spacer(minLength: 4)
            if let backToAgents {
                TerminalIcon(symbol: "chevron.left", label: "Back to subagents", action: backToAgents)
            }
            if !chat.queued.isEmpty {
                Button("\(chat.queued.count) queued") { onCommand(.queue, "") }
                    .buttonStyle(TerminalButtonStyle(tint: Terminal.amber)).disabled(!chat.ready)
                    .help("Edit queued inputs")
            }
            TerminalIcon(symbol: "magnifyingglass", label: "Find in transcript (⌘F)", highlighted: findOpen) {
                findOpen.toggle()
            }
            Menu {
                Group {
                    Button("Rename…") { onCommand(.rename, "") }
                    Button("Change folder…") { onCommand(.cwd, "") }
                    Button("Choose model…") { onCommand(.model, "") }
                    Button("Queued inputs…") { onCommand(.queue, "") }
                    Button("Withdraw all queued input") { onAction(.withdraw) }.disabled(chat.queued.isEmpty)
                    Button("Compact context") { onCommand(.compact, "") }.disabled(chat.waitingForCompaction)
                    Button("Stop work") { onAction(.stop) }
                }
                .disabled(!chat.ready)
                Divider()
                Button(hideThinking ? "Show thinking blocks" : "Hide thinking blocks") { onAction(.toggleThinking) }
                Button(chat.expandAllTools ? "Collapse tool details" : "Expand tool details") { onAction(.toggleTools) }
                Divider()
                Button("Archive…") { onCommand(.archive, "") }.disabled(!chat.ready)
            } label: {
                Image(systemName: "ellipsis").font(.system(size: 12))
                    .frame(width: Terminal.controlSize, height: Terminal.controlSize)
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            .foregroundStyle(Terminal.muted).help("Conversation actions").accessibilityLabel("Conversation actions")
        }
        .contentShape(Rectangle())
        .onTapGesture { chat.focusRequest = UUID(); onActivate() }
        .chatColumn(worker: isWorker).frame(height: Terminal.paneHeaderHeight)
        .overlay(alignment: .bottom) { TerminalRule().allowsHitTesting(false) }
    }

    @ViewBuilder private var notices: some View {
        if let error = chat.connectionError {
            ErrorLine(message: "Reconnecting… \(error)", tint: Terminal.amber)
        } else if let error = chat.error {
            HStack {
                ErrorLine(message: error)
                Spacer()
                TerminalIcon(symbol: "xmark", label: "Dismiss error", action: chat.clearNotice)
            }
        } else if let note = chat.note {
            Text(note).font(Terminal.font(Terminal.labelSize)).foregroundStyle(Terminal.muted)
        }
        if isWorking || chat.sending || chat.stopping {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small).tint(Terminal.amber).scaleEffect(0.72)
                Text(chat.stopping ? "Stopping…" : chat.sending ? "Sending…" :
                     (chat.compacting || chat.waitingForCompaction) ? "Compacting context…" : "Working…")
                    .foregroundStyle(Terminal.amber)
                Spacer()
                if isWorking && !chat.stopping {
                    Button("Stop · Esc") { onAction(.stop) }.buttonStyle(QuietButtonStyle(tint: Terminal.amber))
                }
            }
            .font(Terminal.font(Terminal.labelSize)).padding(.horizontal, 2)
        }
    }

    private var commandSuggestions: some View {
        let options = commands
        return ScrollViewReader { scroll in
            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    SectionCaption("COMMANDS").padding(.horizontal, 8).padding(.vertical, 4)
                    ForEach(Array(options.enumerated()), id: \.element.id) { index, command in
                        Button { accept(command) } label: {
                            HStack(spacing: 8) {
                                Text(command.slash).foregroundStyle(Terminal.accent)
                                Text(command.detail).foregroundStyle(Terminal.muted).lineLimit(1)
                                Spacer(minLength: 0)
                            }
                            .font(Terminal.font(Terminal.labelSize)).padding(.horizontal, 8).frame(height: 21)
                        }
                        .buttonStyle(QuietButtonStyle(highlighted: index == highlightedSuggestion))
                        .id(index)
                    }
                }
                .padding(4)
            }
            .frame(height: min(145, 31 + CGFloat(options.count) * 23))
            .onChange(of: highlightedSuggestion) { scroll.scrollTo(highlightedSuggestion) }
        }
        .background(Terminal.surface, in: RoundedRectangle(cornerRadius: 5))
        .overlay { RoundedRectangle(cornerRadius: 5).strokeBorder(Terminal.border).allowsHitTesting(false) }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .top, spacing: 7) {
                Text("❯").font(Terminal.font()).foregroundStyle(Terminal.accent).padding(.top, Terminal.promptInset)
                    .accessibilityHidden(true)
                ZStack(alignment: .topLeading) {
                    if chat.draft.isEmpty {
                        Text(chat.ready ? "Enter a message or /command…" : "Draft a message while connecting…")
                            .font(Terminal.font()).foregroundStyle(Terminal.muted).lineLimit(1)
                            .padding(.top, Terminal.promptInset).allowsHitTesting(false).accessibilityHidden(true)
                    }
                    PromptEditor(text: $chat.draft, focus: chat.focusRequest, onFocus: onActivate, onKey: key)
                        .frame(height: editorHeight)
                }
            }
            HStack(spacing: 6) {
                Button {
                    onAction(.command(.help))
                } label: {
                    Text("/").font(Terminal.font()).frame(width: 20, height: 20)
                }
                .buttonStyle(QuietButtonStyle()).help("Command palette").accessibilityLabel("Command palette")
                Text("⇧↩ newline").font(Terminal.font(Terminal.metaSize)).foregroundStyle(Terminal.muted).lineLimit(1)
                Spacer(minLength: 0)
                Button("Queue") { submit(.queue) }
                    .buttonStyle(TerminalButtonStyle()).disabled(!canSubmit || !chat.ready)
                    .help("Queue a follow-up (⌥↩)")
                Button("\(modeLabel) ↵") { submit(.steer) }
                    .buttonStyle(TerminalButtonStyle(primary: true))
                    .disabled(!canSubmit || (!chat.ready && !chat.draft.hasPrefix("/")))
                    .help(isWorking ? "Steer the active run (Return)" : "Send message (Return)")
            }
        }
        .padding(7)
        .background(Terminal.black, in: RoundedRectangle(cornerRadius: 6))
        .overlay { RoundedRectangle(cornerRadius: 6).strokeBorder(selected ? Terminal.accent.opacity(0.42) : Terminal.border).allowsHitTesting(false) }
    }

    private var editorHeight: CGFloat {
        let draftLines = chat.draft.utf16.reduce(1) { count, digit in digit == 10 && count < 7 ? count + 1 : count }
        let wrappedEstimate = min(6, chat.draft.utf16.count / (isWorker ? 42 : 98) + 1)
        return CGFloat(max(2, min(6, max(draftLines, wrappedEstimate)))) * Terminal.lineHeight + Terminal.promptInset * 2
    }

    private var statusBar: some View {
        HStack(spacing: 9) {
            Button { onCommand(.model, "") } label: {
                Text(modelLabel).foregroundStyle(Terminal.muted).lineLimit(1)
                    .truncationMode(.middle).frame(height: 16)
            }
            .buttonStyle(QuietButtonStyle()).disabled(!chat.ready).help("Choose model (⌃L)")
            if let status = chat.status, status.supportedThinkingLevels.contains(where: { $0 != "off" }) {
                thinkingControl(status)
            }
            Spacer(minLength: 0)
            if let status = chat.status, status.contextWindow > 0 {
                let fraction = Double(status.contextTokens) / Double(status.contextWindow)
                HStack(spacing: 5) {
                    GeometryReader { bounds in
                        Capsule().fill(Terminal.border)
                        Capsule().fill(fraction > 0.8 ? Terminal.amber : Terminal.accent)
                            .frame(width: min(1, fraction) * bounds.size.width)
                    }
                    .frame(width: isWorker ? 18 : 35, height: 3).accessibilityHidden(true)
                    Text("~\(fraction.formatted(.percent.precision(.fractionLength(1)))) context")
                        .lineLimit(1)
                }
                .foregroundStyle(Terminal.muted)
                .help("Approximately \(status.contextTokens) of \(status.contextWindow) context tokens")
            }
        }
        .font(Terminal.font(Terminal.metaSize))
        .frame(height: 17)
    }

    private func thinkingControl(_ status: Anima_V1_ConversationStatus) -> some View {
        let current = status.hasThinkingLevel ? status.thinkingLevel : "off"
        return Button { thinkingOpen.toggle() } label: {
            HStack(spacing: 3) {
                Text(cleanText(current))
                Image(systemName: "chevron.down").font(.system(size: 7, weight: .medium))
            }
            .padding(.horizontal, 4).frame(height: 17)
        }
        .buttonStyle(QuietButtonStyle(highlighted: thinkingOpen))
        .fixedSize().disabled(!chat.ready)
        .help("Thinking level · Shift-Tab to cycle")
        .accessibilityLabel("Thinking level: \(cleanText(current))")
        .popover(isPresented: $thinkingOpen) {
            VStack(alignment: .leading, spacing: 3) {
                SectionCaption("THINKING LEVEL").padding(.horizontal, 4).padding(.bottom, 3)
                ForEach(status.supportedThinkingLevels, id: \.self) { level in
                    Button {
                        thinkingOpen = false
                        Task { await chat.setThinking(level) }
                    } label: {
                        HStack(spacing: 6) {
                            Text(level == current ? "✓" : " ")
                            Text(cleanText(level))
                            Spacer(minLength: 0)
                        }
                        .font(Terminal.font(Terminal.labelSize)).padding(.horizontal, 5).frame(height: 21)
                    }
                    .buttonStyle(QuietButtonStyle(highlighted: level == current))
                }
            }
            .padding(8).frame(width: 128)
            .background(Terminal.black)
        }
    }

    private var modelLabel: String {
        guard let status = chat.status else { return "Waiting for server status…" }
        if isWorker { return status.hasModel ? cleanText(status.model.modelID) : "No model" }
        return status.hasModel ? cleanText("\(status.model.provider)/\(status.model.modelID)") : "No model"
    }

    private func key(_ key: PromptEditor.Key) -> Bool {
        switch key {
        case .submit: submit(.steer)
        case .queue: submit(.queue)
        case .escape:
            if !commands.isEmpty { suggestionsDismissed = true }
            else if findOpen { findOpen = false }
            else { onAction(.stop) }
        case .complete:
            let visible = commands
            guard visible.indices.contains(highlightedSuggestion) else { return false }
            accept(visible[highlightedSuggestion])
        case .up, .down:
            guard !commands.isEmpty else { return false }
            highlightedSuggestion = max(0, min(commands.count - 1, highlightedSuggestion + (key == .up ? -1 : 1)))
        case .previousHistory, .nextHistory: return moveHistory(key == .previousHistory ? -1 : 1)
        case .models: onCommand(.model, "")
        case .find: onAction(.find)
        case .cycleThinking: onAction(.cycleThinking)
        case .withdraw: onAction(.withdraw)
        case .toggleTools: onAction(.toggleTools)
        case .toggleThinking: onAction(.toggleThinking)
        case .quit: onCommand(.quit, "")
        case .page(let direction): navigation = .init(.page(direction))
        case .prompt(let direction): navigation = .init(.prompt(direction))
        case .edge(let direction): navigation = .init(.edge(direction))
        }
        return true
    }

    private func accept(_ command: AnimaCommand) {
        chat.draft = command.slash + " "
        chat.focusRequest = UUID()
    }

    private func submit(_ mode: Anima_V1_BusyBehavior) {
        let text = chat.draft
        guard canSubmit else { return }
        onActivate()
        if text.hasPrefix("/") {
            let tokens = text.dropFirst().split(maxSplits: 1, whereSeparator: \.isWhitespace)
            guard let command = tokens.first.flatMap({ AnimaCommand(rawValue: $0.lowercased()) }) else {
                if commands.indices.contains(highlightedSuggestion) { accept(commands[highlightedSuggestion]) }
                else { chat.report(ClientIssue("Unknown command. Use /help to see the available commands.")) }
                return
            }
            let argument = tokens.count > 1 ? tokens[1].trimmingCharacters(in: .whitespacesAndNewlines) : ""
            chat.recordInput(text)
            chat.draft = ""
            onCommand(command, argument)
        } else {
            if chat.ready { navigation = .init(.edge(1)) }
            Task { await chat.send(mode: mode) }
        }
    }

    private func moveHistory(_ direction: Int) -> Bool {
        let history = chat.inputHistory
        guard !history.isEmpty, direction < 0 || historyIndex != nil else { return false }
        if historyIndex == nil { draftBeforeHistory = chat.draft }
        let current = historyIndex ?? history.count
        let next = max(0, min(history.count, current + direction))
        let text = next == history.count ? draftBeforeHistory : history[next]
        historyIndex = next == history.count ? nil : next
        recalledText = text
        chat.draft = text
        return true
    }
}

struct TranscriptNavigation: Equatable {
    enum Target: Equatable { case page(Int), prompt(Int), edge(Int) }
    let id = UUID()
    let target: Target
    init(_ target: Target) { self.target = target }
}
