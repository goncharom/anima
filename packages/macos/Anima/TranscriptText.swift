import AppKit
import SwiftUI

// Selection is local to a response or tool. The surrounding transcript remains
// the only scroll view, and selecting text does not change its follow mode.
@MainActor final class TranscriptSelection {
    weak var textView: TranscriptText.TextView?

    var isDragging: Bool { textView?.trackingMouse == true }

    var holdsPosition: Bool {
        guard let textView else { return false }
        return textView.trackingMouse ||
            (textView.window?.firstResponder === textView && textView.selectedRange().length > 0)
    }

    func release() { textView = nil }
}

struct TranscriptTextInteraction {
    let selection: TranscriptSelection
    let activate: () -> Void
}

extension EnvironmentValues {
    @Entry var transcriptTextInteraction: TranscriptTextInteraction?
}

struct TranscriptText: NSViewRepresentable {
    let content: NSAttributedString
    var onComment: ((String) -> Void)? = nil
    @Environment(\.transcriptTextInteraction) private var interaction

    func makeNSView(context: Context) -> TextView {
        let view = TextView(frame: .zero)
        view.isEditable = false
        view.isSelectable = true
        view.drawsBackground = false
        view.textContainerInset = .zero
        view.isVerticallyResizable = false
        view.isHorizontallyResizable = false
        // Use the same TextKit layout mode for display and measurement.
        _ = view.layoutManager
        view.textContainer?.lineFragmentPadding = 0
        view.textContainer?.widthTracksTextView = true
        view.textContainer?.heightTracksTextView = false
        view.linkTextAttributes = [.foregroundColor: NSColor(Terminal.accent),
                                   .underlineStyle: NSUnderlineStyle.single.rawValue]
        view.replaceContent(content)
        return view
    }

    func updateNSView(_ view: TextView, context: Context) {
        view.interaction = interaction
        view.onComment = onComment
        view.replaceContent(content)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: TextView, context: Context) -> CGSize? {
        let width = max(1, proposal.width.flatMap { $0.isFinite ? $0 : nil } ?? 822)
        return CGSize(width: width, height: nsView.height(at: width))
    }

    final class TextView: NSTextView {
        var interaction: TranscriptTextInteraction?
        var onComment: ((String) -> Void)?
        private(set) var trackingMouse = false
        private var measuredSize: CGSize?

        // SwiftUI can probe several widths before placing a lazy row. Never resize
        // the live text container (or scroll its selection) during a size probe.
        private let sizing = TextSizing()

        override func mouseDown(with event: NSEvent) {
            interaction?.selection.textView = self
            trackingMouse = true
            super.mouseDown(with: event)
            trackingMouse = false
            interaction?.activate()
        }

        override func menu(for event: NSEvent) -> NSMenu? {
            // Capture the current selection before AppKit handles the click or a reply streams in.
            let excerpt = onComment == nil ? nil : selectedExcerpt
            let menu = super.menu(for: event)
            guard let excerpt else { return menu }
            let contextualMenu = menu?.copy() as? NSMenu ?? NSMenu()
            let item = NSMenuItem(title: "Add Comment…", action: #selector(addComment(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = excerpt
            if !contextualMenu.items.isEmpty { contextualMenu.insertItem(.separator(), at: 0) }
            contextualMenu.insertItem(item, at: 0)
            return contextualMenu
        }

        private var selectedExcerpt: String? {
            let selection = selectedRange()
            let text = string as NSString
            guard selection.length > 0, NSMaxRange(selection) <= text.length else { return nil }
            let excerpt = text.substring(with: selection)
            return excerpt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : excerpt
        }

        @objc private func addComment(_ item: NSMenuItem) {
            if let excerpt = item.representedObject as? String { onComment?(excerpt) }
        }

        func replaceContent(_ content: NSAttributedString) {
            guard let storage = textStorage, !storage.isEqual(to: content) else { return }
            let selection = selectedRange()
            let selectedText = selection.length > 0 && NSMaxRange(selection) <= storage.length
                ? (storage.string as NSString).substring(with: selection) : nil
            storage.setAttributedString(content)
            sizing.storage.setAttributedString(content)
            measuredSize = nil
            if let selectedText, NSMaxRange(selection) <= content.length,
               (content.string as NSString).substring(with: selection) == selectedText {
                setSelectedRange(selection)
            }
        }

        func height(at width: CGFloat) -> CGFloat {
            if let measuredSize, measuredSize.width == width { return measuredSize.height }
            sizing.container.containerSize = NSSize(width: width, height: 10_000_000)
            sizing.layout.ensureLayout(for: sizing.container)
            let used = sizing.layout.usedRect(for: sizing.container)
            let extra = sizing.layout.extraLineFragmentTextContainer === sizing.container
                ? sizing.layout.extraLineFragmentRect.maxY : 0
            let height = ceil(max(used.maxY, extra))
            measuredSize = CGSize(width: width, height: height)
            return height
        }
    }

    private final class TextSizing {
        let storage = NSTextStorage()
        let layout = NSLayoutManager()
        let container = NSTextContainer(size: .zero)

        init() {
            container.lineFragmentPadding = 0
            storage.addLayoutManager(layout)
            layout.addTextContainer(container)
        }
    }
}
