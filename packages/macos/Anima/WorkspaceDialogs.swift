import AnimaProtocol
import Foundation
import SwiftUI

enum WorkspaceDialog {
    case new(String), folder(ConversationModel), rename(ConversationModel), archive(ConversationModel)
    case conversations, archived(String?), models(ConversationModel), queue(ConversationModel)
    case editQueue(ConversationModel, QueuedInput), comment(ConversationModel, String), help(ConversationModel?)
}

struct PresentedDialog: Identifiable {
    let id = UUID()
    let kind: WorkspaceDialog
}

private struct DialogFrame<Content: View>: View {
    let title: String
    var subtitle: String? = nil
    var width: CGFloat = 440
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            SectionCaption("ANIMA / WORKSPACE")
            Text(title).font(Terminal.font(17)).foregroundStyle(Terminal.text)
            if let subtitle {
                Text(subtitle).font(Terminal.font(Terminal.labelSize)).foregroundStyle(Terminal.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            content
        }
        .padding(19).frame(width: width)
        .background(Terminal.black)
    }
}

private struct DialogButtons: View {
    @Environment(\.dismiss) private var dismiss
    var actionLabel: String
    var busy = false
    var enabled = true
    var destructive = false
    var canCancel = true
    var action: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            if busy { ProgressView().controlSize(.small) }
            Spacer()
            Button("Cancel") { dismiss() }.buttonStyle(TerminalButtonStyle()).keyboardShortcut(.cancelAction)
                .disabled(!canCancel)
            Button(actionLabel, action: action)
                .buttonStyle(TerminalButtonStyle(primary: !destructive, tint: destructive ? Terminal.red : Terminal.text))
                .keyboardShortcut(.defaultAction).disabled(!enabled || busy)
        }
    }
}

struct SelectionOption: Identifiable {
    let id: String
    let title: String
    var subtitle: String? = nil

    init(id: String, title: String, subtitle: String? = nil) {
        self.id = id
        self.title = title
        self.subtitle = subtitle
    }

    init(_ info: Anima_V1_ConversationInfo) {
        self.init(id: info.conversationID, title: cleanText(info.name),
                  subtitle: info.hasTaskTitle ? cleanText(info.taskTitle) : nil)
    }
}

struct SelectionDialog: View {
    let title: String
    var subtitle: String? = nil
    let options: [SelectionOption]
    var actionLabel = "Open"
    let select: (String) async throws -> Void
    @Environment(\.dismiss) private var dismiss
    @FocusState private var searchFocus: Bool
    @State private var query = ""
    @State private var cursor: String?
    @State private var error: String?
    @State private var request: String?

    private var filtered: [SelectionOption] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return options }
        return options.compactMap { option -> (SelectionOption, Int)? in
            let haystack = "\(option.title) \(option.subtitle ?? "")".lowercased()
            if let hit = haystack.range(of: needle) { return (option, haystack.distance(from: haystack.startIndex, to: hit.lowerBound)) }
            var remaining = needle[...]
            for character in haystack where character == remaining.first { remaining = remaining.dropFirst() }
            return remaining.isEmpty ? (option, 1_000) : nil
        }.sorted { $0.1 < $1.1 }.map(\.0)
    }

    private var selected: String? { filtered.first(where: { $0.id == cursor })?.id ?? filtered.first?.id }

    var body: some View {
        let visible = filtered
        DialogFrame(title: title, subtitle: subtitle, width: 460) {
            TextField("Filter…", text: $query).textFieldStyle(TerminalFieldStyle()).focused($searchFocus)
                .disabled(request != nil)
                .onSubmit(apply)
                .onKeyPress(.upArrow) { move(-1); return .handled }
                .onKeyPress(.downArrow) { move(1); return .handled }
                .onKeyPress(.pageUp) { move(-8); return .handled }
                .onKeyPress(.pageDown) { move(8); return .handled }
            ScrollViewReader { scroll in
                ScrollView {
                    LazyVStack(spacing: 3) {
                        if visible.isEmpty {
                            Text(options.isEmpty ? "Nothing here yet." : "No matches.")
                                .foregroundStyle(Terminal.muted).frame(maxWidth: .infinity, alignment: .leading).padding(9)
                        }
                        ForEach(visible) { item in
                            Button { cursor = item.id; apply() } label: {
                                HStack(alignment: .top, spacing: 9) {
                                    Text((selected == item.id) ? "›" : " ").foregroundStyle(Terminal.accent)
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(item.title).foregroundStyle(Terminal.text).lineLimit(2)
                                        if let subtitle = item.subtitle {
                                            Text(subtitle).font(Terminal.font(Terminal.metaSize)).foregroundStyle(Terminal.muted).lineLimit(2)
                                        }
                                    }
                                    Spacer(minLength: 0)
                                }
                                .padding(7)
                            }
                            .buttonStyle(QuietButtonStyle(highlighted: selected == item.id))
                            .id(item.id)
                            .disabled(request != nil)
                        }
                    }
                }
                .frame(height: min(280, max(72, CGFloat(visible.count) * (visible.first?.subtitle == nil ? 30 : 44))))
                .onChange(of: selected) { if let selected { scroll.scrollTo(selected) } }
            }
            if let error { ErrorLine(message: error) }
            TerminalRule()
            DialogButtons(actionLabel: actionLabel, busy: request != nil, enabled: selected != nil, action: apply)
        }
        .onAppear { searchFocus = true }
        .onChange(of: query) { cursor = nil }
        .task(id: request) {
            guard let request else { return }
            error = nil
            do {
                try await select(request)
                if !Task.isCancelled { dismiss() }
            } catch {
                if !Task.isCancelled { self.error = describe(error); self.request = nil }
            }
        }
    }

    private func move(_ delta: Int) {
        let values = filtered
        guard !values.isEmpty else { return }
        let index = values.firstIndex(where: { $0.id == selected }) ?? 0
        cursor = values[max(0, min(values.count - 1, index + delta))].id
    }

    private func apply() {
        if request == nil { request = selected }
    }
}

struct NameDialog: View {
    @State private var name: String
    @State private var saving = false
    @State private var error: String?
    @FocusState private var focused: Bool
    @Environment(\.dismiss) private var dismiss
    let save: (String) async throws -> Void

    init(current: String, save: @escaping (String) async throws -> Void) {
        _name = State(initialValue: cleanText(current))
        self.save = save
    }

    var body: some View {
        DialogFrame(title: "Rename conversation") {
            TextField("Conversation name", text: $name).textFieldStyle(TerminalFieldStyle())
                .focused($focused).onSubmit(submit).disabled(saving)
            if let error { ErrorLine(message: error) }
            DialogButtons(actionLabel: "Rename", busy: saving, enabled: valid, action: submit)
        }
        .onAppear { focused = true }
        .task(id: saving) {
            guard saving else { return }
            error = nil
            do { try await save(name); if !Task.isCancelled { dismiss() } }
            catch { if !Task.isCancelled { self.error = describe(error); saving = false } }
        }
    }

    private var valid: Bool { !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private func submit() { if valid { saving = true } }
}

struct ArchiveDialog: View {
    let name: String
    let archive: () async throws -> Void
    @State private var saving = false
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        DialogFrame(title: "Archive conversation?", subtitle: "\(cleanText(name)) will move to Archived. Any running work continues.") {
            if let error { ErrorLine(message: error) }
            DialogButtons(actionLabel: "Archive", busy: saving, destructive: true) { saving = true }
        }
        .task(id: saving) {
            guard saving else { return }
            error = nil
            do { try await archive(); if !Task.isCancelled { dismiss() } }
            catch { if !Task.isCancelled { self.error = describe(error); saving = false } }
        }
    }
}

struct ModelDialog: View {
    let client: HarnessClient
    let chat: ConversationModel
    @State private var models: [Anima_V1_ModelInfo]?
    @State private var error: String?
    @State private var loadID = UUID()
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Group {
            if let models {
                let selected = chat.status.flatMap { $0.hasModel ? $0.model : nil }
                SelectionDialog(title: "Chat model", options: models.enumerated().map { index, info in
                    SelectionOption(id: String(index), title: (selected == info.model ? "✓ " : "") + cleanText(info.name),
                                    subtitle: "\(cleanText(info.model.provider))/\(cleanText(info.model.modelID)) · \(info.contextWindow / 1_000)k context")
                }, actionLabel: "Use model") { index in
                    guard let index = Int(index), models.indices.contains(index) else { return }
                    try await chat.update { $0.model = models[index].model }
                }
            } else {
                DialogFrame(title: "Chat model") {
                    if let error {
                        ErrorLine(message: error)
                        DialogButtons(actionLabel: "Retry") { loadID = UUID() }
                    } else {
                        HStack { ProgressView().controlSize(.small); Text("Loading server models…").foregroundStyle(Terminal.muted) }
                        Button("Cancel") { dismiss() }.buttonStyle(TerminalButtonStyle()).keyboardShortcut(.cancelAction)
                    }
                }
            }
        }
        .task(id: loadID) {
            error = nil
            do { models = try await client.rpc.listModels(request: .init()).value().models.filter(\.hasModel) }
            catch { if !Task.isCancelled { self.error = describe(error) } }
        }
    }
}

struct CommentDialog: View {
    let excerpt: String
    let onAdd: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var comment = ""
    @FocusState private var focused: Bool

    var body: some View {
        let note = comment.trimmingCharacters(in: .whitespacesAndNewlines)
        DialogFrame(title: "Add Comment", subtitle: "The excerpt and your comment will be added to the draft. Nothing is sent.", width: 480) {
            SectionCaption("SELECTED EXCERPT")
            ScrollView {
                Text(verbatim: excerpt)
                    .font(Terminal.font()).foregroundStyle(Terminal.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
            }
            .frame(maxHeight: 100)
            .background(Terminal.surface, in: RoundedRectangle(cornerRadius: 5))
            SectionCaption("YOUR COMMENT")
            TextEditor(text: $comment).font(Terminal.font()).scrollContentBackground(.hidden)
                .padding(5).frame(height: 95)
                .background(Terminal.surface, in: RoundedRectangle(cornerRadius: 5))
                .overlay { RoundedRectangle(cornerRadius: 5).strokeBorder(Terminal.border).allowsHitTesting(false) }
                .accessibilityLabel("Your comment").focused($focused)
            DialogButtons(actionLabel: "Add to Draft", enabled: !note.isEmpty) {
                onAdd(note)
                dismiss()
            }
        }
        .defaultFocus($focused, true)
    }
}

struct QueueDialog: View {
    enum Change { case save, withdraw }
    let chat: ConversationModel
    let item: QueuedInput
    @Environment(\.dismiss) private var dismiss
    @State private var content: String
    @State private var mode: Anima_V1_BusyBehavior
    @State private var request: Change?
    @State private var error: String?

    init(chat: ConversationModel, item: QueuedInput) {
        self.chat = chat
        self.item = item
        _content = State(initialValue: item.content)
        _mode = State(initialValue: item.mode)
    }

    var body: some View {
        DialogFrame(title: "Edit queued input", subtitle: "Edits apply only while this exact input is still queued.", width: 460) {
            Picker("Delivery", selection: $mode) {
                Text("Steering").tag(Anima_V1_BusyBehavior.steer)
                Text("Follow-up").tag(Anima_V1_BusyBehavior.queue)
            }
            .pickerStyle(.segmented).disabled(request != nil)
            TextEditor(text: $content).font(Terminal.font()).scrollContentBackground(.hidden)
                .padding(5).frame(height: 125)
                .background(Terminal.surface, in: RoundedRectangle(cornerRadius: 5))
                .overlay { RoundedRectangle(cornerRadius: 5).strokeBorder(Terminal.border).allowsHitTesting(false) }
                .accessibilityLabel("Queued input text").disabled(request != nil)
            if let error { ErrorLine(message: error) }
            TerminalRule()
            HStack(spacing: 8) {
                Button("Withdraw to draft") { request = .withdraw }.buttonStyle(TerminalButtonStyle(tint: Terminal.amber))
                    .keyboardShortcut("d", modifiers: .control).disabled(request != nil)
                DialogButtons(actionLabel: "Save", busy: request != nil,
                              enabled: !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                              canCancel: request == nil) { request = .save }
            }
        }
        .interactiveDismissDisabled(request != nil)
        .task(id: request) {
            guard let request else { return }
            error = nil
            do {
                switch request {
                case .save: try await chat.changeQueue(item, content: content, mode: mode)
                case .withdraw:
                    let restored = try await chat.changeQueue(item, remove: true)
                    chat.restoreDraft([restored])
                }
                if !Task.isCancelled { dismiss() }
            } catch {
                if !Task.isCancelled { self.error = describe(error); self.request = nil }
            }
        }
    }
}

struct FolderDialog: View {
    let client: HarnessClient
    let creating: Bool
    let apply: (String, String) async throws -> Void
    @Environment(\.dismiss) private var dismiss
    @FocusState private var filterFocused: Bool
    @State private var location: Location
    @State private var pathInput: String
    @State private var path: String?
    @State private var parent: String?
    @State private var directories: [Anima_V1_Directory] = []
    @State private var filter = ""
    @State private var cursor: String?
    @State private var name = ""
    @State private var error: String?
    @State private var loading = false
    @State private var saving = false

    private struct Location: Equatable {
        let id = UUID()
        let path: String
    }

    init(client: HarnessClient, initialPath: String, creating: Bool, apply: @escaping (String, String) async throws -> Void) {
        self.client = client
        self.creating = creating
        self.apply = apply
        _location = State(initialValue: Location(path: initialPath))
        _pathInput = State(initialValue: initialPath)
    }

    private var visible: [Anima_V1_Directory] {
        directories.filter { filter.isEmpty || $0.name.localizedCaseInsensitiveContains(filter) }
    }

    var body: some View {
        let visit = location
        DialogFrame(title: creating ? "New conversation" : "Change folder",
                    subtitle: "Folders are on the server, not this Mac.", width: 500) {
            HStack(spacing: 6) {
                TerminalIcon(symbol: "arrow.up", label: "Parent folder") { if let parent { navigate(parent) } }
                    .disabled(parent == nil || parent == path || saving)
                TerminalIcon(symbol: "house", label: "Server home folder") { navigate("~") }.disabled(saving)
                TextField("Server working directory", text: $pathInput).textFieldStyle(TerminalFieldStyle())
                    .onSubmit { navigate(pathInput) }.disabled(saving)
                Button("Go") { navigate(pathInput) }.buttonStyle(TerminalButtonStyle()).disabled(saving)
            }
            TextField("Filter folders…", text: $filter).textFieldStyle(TerminalFieldStyle()).focused($filterFocused)
                .onKeyPress(.upArrow) { move(-1); return .handled }
                .onKeyPress(.downArrow) { move(1); return .handled }
                .onKeyPress(.leftArrow) {
                    guard filter.isEmpty, let parent, parent != path else { return .ignored }
                    navigate(parent)
                    return .handled
                }
                .onSubmit { if let cursor { navigate(cursor) } else { submit() } }
                .disabled(saving)
            folders
            if creating {
                TextField("Conversation name", text: $name).textFieldStyle(TerminalFieldStyle())
                    .onSubmit(submit).disabled(saving)
            }
            if let error { ErrorLine(message: error) }
            TerminalRule()
            DialogButtons(actionLabel: creating ? "Create conversation" : "Use this folder", busy: saving,
                          enabled: valid, action: submit)
        }
        .onAppear { filterFocused = true }
        .onChange(of: filter) { cursor = nil }
        .task(id: visit.id) { await load(visit) }
        .task(id: saving) {
            guard saving, let path else { return }
            error = nil
            do { try await apply(path, name); if !Task.isCancelled { dismiss() } }
            catch { if !Task.isCancelled { self.error = describe(error); saving = false } }
        }
    }

    private var folders: some View {
        VStack(alignment: .leading, spacing: 5) {
            ScrollViewReader { scroll in
                ScrollView {
                    LazyVStack(spacing: 2) {
                        ForEach(visible, id: \.path) { directory in
                            Button { navigate(directory.path) } label: {
                                HStack(spacing: 8) {
                                    Image(systemName: "folder").foregroundStyle(Terminal.accent)
                                    Text(cleanText(directory.name) + "/").foregroundStyle(Terminal.text).lineLimit(1)
                                    Spacer()
                                    Image(systemName: "chevron.right").font(.system(size: 9))
                                }
                                .padding(.horizontal, 7).frame(height: Terminal.controlSize)
                            }
                            .buttonStyle(QuietButtonStyle(highlighted: cursor == directory.path))
                            .disabled(saving)
                            .id(directory.path)
                        }
                    }
                }
                .frame(height: 196)
                .onChange(of: cursor) { if let cursor { scroll.scrollTo(cursor) } }
            }
            Text(path.map { pathInput != $0 } == true ? "Press Go to open the entered path." :
                 loading ? "Loading folders…" : "\(visible.count) / \(directories.count) folders")
                .font(Terminal.font(Terminal.labelSize)).foregroundStyle(Terminal.muted)
        }
    }

    private var valid: Bool {
        path == pathInput && (!creating || !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }
    private func submit() { if valid { saving = true } }

    private func move(_ offset: Int) {
        let values = visible
        guard !values.isEmpty else { return }
        let index = values.firstIndex { $0.path == cursor } ?? -1
        let next = max(-1, min(values.count - 1, index + offset))
        cursor = next < 0 ? nil : values[next].path
    }

    private func navigate(_ path: String) {
        if !saving {
            location = Location(path: path)
            self.path = nil
            filterFocused = true
        }
    }

    private func load(_ visit: Location) async {
        var target = visit.path
        var offset: UInt32 = 0
        var known: [String: Anima_V1_Directory] = [:]
        loading = true
        cursor = nil
        filter = ""
        directories = []
        pathInput = target
        path = nil
        error = nil
        defer { if location == visit { loading = false } }
        do {
            while true {
                let page = try await client.rpc.listDirectories(request: .with {
                    $0.path = target
                    $0.offset = offset
                }).value()
                guard location == visit else { return }
                if offset == 0 {
                    path = page.path
                    parent = page.parent
                    pathInput = page.path
                    if creating { name = page.path.split(separator: "/").last.map(String.init) ?? "Conversation" }
                }
                for child in page.directories { known[child.path] = child }
                directories = known.values.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
                guard page.hasNextOffset, page.nextOffset > offset else { return }
                target = page.path
                offset = page.nextOffset
            }
        } catch {
            if location == visit && !Task.isCancelled { self.error = describe(error) }
        }
    }
}
