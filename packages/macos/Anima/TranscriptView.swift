import AppKit
import ImageIO
import SwiftUI

struct TranscriptView: View {
    let chat: ConversationModel
    let hideThinking: Bool
    let hideToolCalls: Bool
    let isWorker: Bool
    @Binding var findOpen: Bool
    let navigation: TranscriptNavigation?
    let onActivate: () -> Void
    let onComment: (String) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var query = ""
    @State private var matchID: String?
    @State private var contentOffset: CGFloat = 0
    @State private var contentHeight: CGFloat = 0
    @State private var viewportHeight: CGFloat = 0
    @State private var userScroll = false
    @State private var selection = TranscriptSelection()
    @State private var scroll = ScrollPosition(idType: String.self, edge: .bottom)
    @FocusState private var searchFocused: Bool

    private let start = "transcript:start"
    private static let end = "transcript:end"

    private var rows: [TranscriptRow] {
        guard hideThinking || hideToolCalls else { return chat.transcript.rows }
        return chat.transcript.rows.filter { row in
            switch row.content {
            case .text(.thinking, _): !hideThinking
            case .tool: !hideToolCalls
            default: true
            }
        }
    }

    var body: some View {
        let visible = rows
        let matches = findOpen ? matches(in: visible) : []
        VStack(spacing: 0) {
            if findOpen { findBar(matches).transition(.offset(y: -4).combined(with: .opacity)) }
            if visible.isEmpty && chat.olderCursor == nil {
                empty
            } else {
                transcript(visible, matches: Set(matches))
            }
        }
        .animation(Terminal.motion(reduced: reduceMotion), value: findOpen)
        .onChange(of: findOpen) {
            if findOpen { searchFocused = true; onActivate(); jumpToMatch(matches, offset: 0) }
            else { searchFocused = false; matchID = nil; chat.focusRequest = UUID() }
        }
        .onChange(of: query) { jumpToMatch(matches, offset: 0, reset: true) }
        .onChange(of: hideToolCalls) {
            if let matchID, !matches.contains(matchID) { self.matchID = nil }
        }
        .onChange(of: chat.findRequest) { if findOpen { searchFocused = true } }
    }

    private func transcript(_ visible: [TranscriptRow], matches: Set<String>) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                // Measure the loaded page before using its coordinates for history and selection.
                VStack(alignment: .leading, spacing: 9) {
                    Color.clear.frame(height: 1).id(start).accessibilityHidden(true)
                    if chat.olderCursor != nil {
                        Button(chat.loadingOlder ? "Loading history…" : "↑  Load older messages") {
                            onActivate()
                            chat.followsLatest = false
                            let visibleID = scroll.viewID(type: String.self)
                            let anchor = visible.first(where: { $0.id == visibleID })?.id ?? visible.first?.id
                            let previousOffset = contentOffset
                            Task {
                                // Keep the current page's first visible entry in view. If the user
                                // scrolled while fetching, leave the current scroll target alone.
                                if await chat.loadOlder(), let anchor, abs(contentOffset - previousOffset) < 1 {
                                    chat.scrollPositionID = anchor
                                    scroll.scrollTo(id: anchor, anchor: .top)
                                }
                            }
                        }
                        .buttonStyle(TerminalButtonStyle(tint: Terminal.accent))
                        .disabled(!chat.ready || chat.loadingOlder)
                    }
                    ForEach(visible) { row in
                        rowView(row)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(matches.contains(row.id) ? Terminal.amber.opacity(matchID == row.id ? 0.19 : 0.075) : .clear,
                                        in: RoundedRectangle(cornerRadius: 4))
                            .id(row.id)
                    }
                    Color.clear.frame(height: 1).id(Self.end).accessibilityHidden(true)
                }
                .scrollTargetLayout()
                .chatColumn(worker: isWorker)
                .padding(.bottom, 3)
            }
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .scrollPosition($scroll, anchor: .top)
            .onAppear {
                if chat.followsLatest { scroll.scrollTo(edge: .bottom) }
                else if let id = chat.scrollPositionID { scroll.scrollTo(id: id, anchor: .top) }
                if findOpen { searchFocused = true }
            }
            .onScrollGeometryChange(for: ScrollMetrics.self) { geometry in
                ScrollMetrics(y: geometry.contentOffset.y + geometry.contentInsets.top,
                              height: geometry.contentSize.height + geometry.contentInsets.bottom,
                              viewport: geometry.containerSize.height)
            } action: { previous, bounds in
                contentOffset = bounds.y
                contentHeight = bounds.height
                viewportHeight = bounds.viewport
                if !selection.isDragging,
                   userScroll || (scroll.isPositionedByUser && previous.y != bounds.y && previous.height == bounds.height) {
                    chat.followsLatest = bounds.y + bounds.viewport >= bounds.height - 28
                    if let id = scroll.viewID(type: String.self), id != Self.end { chat.scrollPositionID = id }
                }
            }
            .onScrollPhaseChange { _, phase in
                userScroll = phase == .interacting || phase == .decelerating
            }
            .onChange(of: chat.transcript) {
                if chat.followsLatest && !userScroll && !selection.holdsPosition { proxy.scrollTo(Self.end, anchor: .bottom) }
            }
            .onChange(of: hideThinking) {
                if chat.followsLatest && !selection.holdsPosition { proxy.scrollTo(Self.end, anchor: .bottom) }
            }
            .onChange(of: hideToolCalls) {
                if chat.followsLatest && !selection.holdsPosition { proxy.scrollTo(Self.end, anchor: .bottom) }
            }
            .onChange(of: chat.historyEpoch) { followLatest(proxy) }
            .onChange(of: matchID) { if let matchID { proxy.scrollTo(matchID, anchor: .center) } }
            .onChange(of: navigation) {
                if let navigation { navigate(navigation.target, visible: visible, proxy: proxy) }
            }
            .environment(\.transcriptTextInteraction, .init(selection: selection, activate: onActivate))
            .overlay(alignment: .bottomTrailing) {
                if !chat.followsLatest || (selection.holdsPosition && contentHeight - contentOffset - viewportHeight > 28) {
                    Button("↓ Latest") {
                        onActivate()
                        if contentHeight - contentOffset - viewportHeight < viewportHeight * 2 {
                            withAnimation(Terminal.motion(reduced: reduceMotion)) { followLatest(proxy) }
                        } else { followLatest(proxy) }
                    }
                    .buttonStyle(TerminalButtonStyle(tint: Terminal.accent))
                    .padding(8).help("Jump to the live end (⌃End)")
                }
            }
        }
    }

    @ViewBuilder private func rowView(_ row: TranscriptRow) -> some View {
        switch row.content {
        case .tool(let id):
            if let tool = chat.transcript.tools[id] {
                ToolCard(tool: tool, expanded: chat.toolExpanded(id) || matchID == row.id) {
                    onActivate()
                    withAnimation(Terminal.motion(reduced: reduceMotion)) {
                        if matchID == row.id { matchID = nil }
                        else { chat.toggleTool(id) }
                    }
                }
            }
        case .image(let image): TranscriptImage(payload: image)
        case .text(let style, let text):
            switch style {
            case .user, .scheduled, .delegated:
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .firstTextBaseline, spacing: 5) {
                        Text(style == .delegated ? "↳" : "❯").font(Terminal.font(Terminal.metaSize)).foregroundStyle(Terminal.accent)
                        SectionCaption(style == .scheduled ? "SCHEDULED PROMPT" :
                                         (style == .delegated ? "DELEGATED INSTRUCTION" : "YOU"))
                    }
                    if style == .delegated {
                        MarkdownBody(text: text)
                    } else {
                        Text(text).font(Terminal.font()).foregroundStyle(Terminal.text).textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                .background(Terminal.selected.opacity(0.55), in: RoundedRectangle(cornerRadius: 4))
                .overlay(alignment: .leading) { Rectangle().fill(Terminal.accent.opacity(0.6)).frame(width: 1) }
            case .assistant: MarkdownBody(text: text, onComment: onComment)
            case .thinking:
                VStack(alignment: .leading, spacing: 4) {
                    SectionCaption(row.streaming ? "THINKING…" : "THINKING")
                    Text(text).font(Terminal.font()).foregroundStyle(Terminal.muted).textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.leading, 10).overlay(alignment: .leading) { TerminalRule(vertical: true) }
            case .notice:
                HStack(spacing: 8) {
                    TerminalRule()
                    Text(text).font(Terminal.font(Terminal.metaSize)).foregroundStyle(Terminal.muted).fixedSize()
                    TerminalRule()
                }
                .padding(.vertical, 3)
            case .warning: ErrorLine(message: text, tint: Terminal.amber)
            case .error: ErrorLine(message: text)
            }
        }
    }

    private var empty: some View {
        VStack(spacing: 8) {
            Text(chat.ready ? "❯" : "···").font(Terminal.font(17)).foregroundStyle(Terminal.accent)
            Text(chat.ready ? "Ready for input" : "Attaching to conversation…")
                .font(Terminal.font()).foregroundStyle(Terminal.muted)
            if chat.ready && !isWorker {
                Text("Start typing below, or enter /help for commands.")
                    .font(Terminal.font(Terminal.labelSize)).foregroundStyle(Terminal.muted)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
        .onTapGesture { chat.focusRequest = UUID(); onActivate() }
    }

    private func findBar(_ matches: [String]) -> some View {
        HStack(spacing: 5) {
            TextField("Find in transcript…", text: $query).textFieldStyle(TerminalFieldStyle()).focused($searchFocused)
                .onSubmit { jumpToMatch(matches, offset: 1) }
                .onKeyPress(keys: [.return, "g"]) { press in
                    if press.key == "g", press.modifiers.contains(.control) {
                        jumpToMatch(matches, offset: press.modifiers.contains(.shift) ? -1 : 1)
                        return .handled
                    }
                    if press.key == .return, press.modifiers.contains(.shift) {
                        jumpToMatch(matches, offset: -1)
                        return .handled
                    }
                    return .ignored
                }
                .onKeyPress(.escape) { findOpen = false; return .handled }
            if !query.isEmpty {
                let index = matchID.flatMap { matches.firstIndex(of: $0) }.map { $0 + 1 } ?? 0
                Text(matches.isEmpty ? "No matches" : "\(index)/\(matches.count)")
                    .font(Terminal.font(Terminal.metaSize)).foregroundStyle(Terminal.muted).fixedSize()
            }
            TerminalIcon(symbol: "chevron.up", label: "Previous match (Shift-Return)") { jumpToMatch(matches, offset: -1) }
                .disabled(matches.isEmpty)
            TerminalIcon(symbol: "chevron.down", label: "Next match (Return)") { jumpToMatch(matches, offset: 1) }
                .disabled(matches.isEmpty)
            TerminalIcon(symbol: "xmark", label: "Close find (Esc)") { findOpen = false }
        }
        .padding(.vertical, 5)
        .chatColumn(worker: isWorker)
        .background(Terminal.surface)
        .overlay(alignment: .bottom) { TerminalRule() }
    }

    private func matches(in rows: [TranscriptRow]) -> [String] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return [] }
        return rows.compactMap { row in
            let found: Bool
            switch row.content {
            case .text(_, let value): found = value.localizedCaseInsensitiveContains(needle)
            case .image(let image): found = image.mimeType.localizedCaseInsensitiveContains(needle)
            case .tool(let id):
                let tool = chat.transcript.tools[id]
                found = [tool?.name, tool?.target, tool?.output, tool?.argumentText, tool?.diff, tool?.detailText].contains {
                    $0?.localizedCaseInsensitiveContains(needle) == true
                }
            }
            return found ? row.id : nil
        }
    }

    private func jumpToMatch(_ ids: [String], offset: Int, reset: Bool = false) {
        guard !ids.isEmpty else { matchID = nil; return }
        let current = reset ? nil : matchID.flatMap { ids.firstIndex(of: $0) }
        let next = current.map { ($0 + offset + ids.count) % ids.count } ?? (offset < 0 ? ids.count - 1 : 0)
        chat.followsLatest = false
        matchID = ids[next]
        chat.scrollPositionID = matchID
    }

    private func followLatest(_ proxy: ScrollViewProxy) {
        selection.release()
        chat.followsLatest = true
        chat.scrollPositionID = nil
        scroll.scrollTo(edge: .bottom)
        proxy.scrollTo(Self.end, anchor: .bottom)
    }

    private func navigate(_ target: TranscriptNavigation.Target, visible: [TranscriptRow], proxy: ScrollViewProxy) {
        switch target {
        case .edge(let direction):
            if direction > 0 { followLatest(proxy) }
            else {
                chat.followsLatest = false
                chat.scrollPositionID = start
                scroll.scrollTo(edge: .top)
            }
        case .page(let direction):
            let y = max(0, contentOffset + CGFloat(direction) * max(1, viewportHeight - 25))
            if direction > 0 && y + viewportHeight >= contentHeight - 12 { followLatest(proxy) }
            else { chat.followsLatest = false; scroll.scrollTo(y: y) }
        case .prompt(let direction):
            let current = scroll.viewID(type: String.self).flatMap { id in visible.firstIndex { $0.id == id } }
                ?? (chat.followsLatest ? visible.count : -1)
            let indices = visible.indices.filter {
                if case .text(.user, _) = visible[$0].content { return true }
                if case .text(.scheduled, _) = visible[$0].content { return true }
                if case .text(.delegated, _) = visible[$0].content { return true }
                return false
            }
            let index = direction > 0 ? indices.first { $0 > current } : indices.last { $0 < current }
            if let index {
                chat.followsLatest = false
                chat.scrollPositionID = visible[index].id
                scroll.scrollTo(id: visible[index].id, anchor: .top)
            } else if direction > 0 { followLatest(proxy) }
        }
    }

    private struct ScrollMetrics: Equatable {
        let y: CGFloat
        let height: CGFloat
        let viewport: CGFloat
    }
}

private struct ToolCard: View {
    let tool: TranscriptTool
    let expanded: Bool
    let toggle: () -> Void

    private var stateColor: Color {
        switch tool.state {
        case .running: Terminal.amber
        case .done: Terminal.good
        case .failed: Terminal.red
        case .pending, .stopped: Terminal.muted
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: toggle) {
                HStack(spacing: 7) {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right").font(.system(size: 8, weight: .semibold))
                        .foregroundStyle(Terminal.muted)
                    Text((tool.nested ? "↳ " : "") + cleanText(tool.name)).foregroundStyle(Terminal.accent)
                        .lineLimit(1).layoutPriority(1)
                    if let target = tool.target {
                        Text(target).foregroundStyle(Terminal.muted).lineLimit(1).truncationMode(.middle)
                    }
                    Spacer(minLength: 2)
                    Text(tool.state.rawValue).foregroundStyle(stateColor).lineLimit(1)
                }
                .font(Terminal.font(Terminal.labelSize)).padding(.horizontal, 7).frame(height: Terminal.controlSize)
            }
            .buttonStyle(QuietButtonStyle())
            .accessibilityLabel("\(tool.name), \(tool.state.rawValue), \(expanded ? "collapse" : "expand") tool details")
            if expanded {
                TerminalRule()
                let sections: [(label: String, text: String)] = [
                    ("args", tool.argumentText), ("output", tool.output), ("diff", tool.diff), ("details", tool.detailText)
                ].compactMap { label, text in
                    guard let text, !text.isEmpty else { return nil }
                    return (label, text)
                }
                VStack(alignment: .leading, spacing: 7) {
                    if !sections.isEmpty { ToolOutputText(sections: sections) }
                    ForEach(Array(tool.images.enumerated()), id: \.offset) { _, image in TranscriptImage(payload: image) }
                    if let ms = tool.duration, ms.isFinite, ms >= 0 {
                        Text(Duration.milliseconds(ms).formatted(.units(allowed: [.seconds, .milliseconds], width: .abbreviated)))
                            .font(Terminal.font(Terminal.metaSize)).foregroundStyle(Terminal.muted)
                    }
                    if sections.isEmpty, tool.images.isEmpty, tool.duration == nil {
                        Text("No output yet.").font(Terminal.font(Terminal.labelSize)).foregroundStyle(Terminal.muted)
                    }
                }
                .padding(7).transition(.opacity)
            } else if !tool.output.isEmpty {
                let preview = tool.output.prefix(800).trimmingCharacters(in: .newlines)
                    .split(separator: "\n", maxSplits: 3, omittingEmptySubsequences: false)
                Text(preview.prefix(2).joined(separator: "\n") + (preview.count > 2 ? "\n…" : ""))
                    .font(Terminal.font(Terminal.metaSize)).foregroundStyle(Terminal.muted).lineLimit(3).textSelection(.enabled)
                    .padding(.horizontal, 20).padding(.bottom, 5)
                    .transition(.opacity)
            }
        }
        .background(Terminal.surface, in: RoundedRectangle(cornerRadius: 5))
        .overlay { RoundedRectangle(cornerRadius: 5).strokeBorder(Terminal.border).allowsHitTesting(false) }
        .padding(.leading, tool.nested ? 10 : 0)
    }
}

private struct TranscriptImage: View {
    let payload: InlineImage
    @State private var image: NSImage?

    var body: some View {
        Group {
            if let image {
                Image(nsImage: image).resizable().scaledToFit().frame(maxWidth: 480, maxHeight: 320, alignment: .leading)
                    .clipShape(RoundedRectangle(cornerRadius: 4)).accessibilityLabel("Attached image")
            } else {
                Label("Image · \(cleanText(payload.mimeType))", systemImage: "photo")
                    .font(Terminal.font(Terminal.labelSize)).foregroundStyle(Terminal.muted)
            }
        }
        .task(id: payload.data) {
            image = nil
            let thumbnail = await Self.decode(payload.data)
            if let thumbnail, !Task.isCancelled { image = NSImage(cgImage: thumbnail, size: .zero) }
        }
    }

    nonisolated private static func decode(_ encoded: String) async -> CGImage? {
        await Task.detached(priority: .utility) {
            guard encoded.utf8.count <= 24_000_000, let data = Data(base64Encoded: encoded),
                  let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
            return CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 1400
            ] as CFDictionary)
        }.value
    }
}
