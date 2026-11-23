import AppKit
import SwiftUI

// NSTextView keeps native input methods, selection, paste and undo while exposing
// the terminal's send, history, completion and transcript navigation keys.
struct PromptEditor: NSViewRepresentable {
    enum Key: Equatable {
        case submit, queue, escape, complete, up, down, previousHistory, nextHistory
        case cycleThinking, withdraw, toggleTools, toggleThinking, models, quit, find
        case page(Int), prompt(Int), edge(Int)
    }

    @Binding var text: String
    let focus: UUID?
    let onFocus: () -> Void
    let onKey: (Key) -> Bool

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true

        let editor = PromptTextView(frame: .zero)
        editor.font = Terminal.nativeFont()
        editor.textColor = NSColor(Terminal.text)
        editor.insertionPointColor = NSColor(Terminal.accent)
        editor.drawsBackground = false
        editor.textContainerInset = NSSize(width: 0, height: Terminal.promptInset)
        editor.isRichText = false
        editor.importsGraphics = false
        editor.allowsUndo = true
        editor.isAutomaticQuoteSubstitutionEnabled = false
        editor.isAutomaticDashSubstitutionEnabled = false
        editor.isAutomaticTextReplacementEnabled = false
        editor.isAutomaticSpellingCorrectionEnabled = false
        editor.isContinuousSpellCheckingEnabled = false
        editor.smartInsertDeleteEnabled = false
        editor.isVerticallyResizable = true
        editor.isHorizontallyResizable = false
        editor.autoresizingMask = [.width]
        editor.textContainer?.widthTracksTextView = true
        editor.textContainer?.lineFragmentPadding = 0
        editor.minSize = .zero
        editor.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        editor.setAccessibilityLabel("Message composer")
        editor.delegate = context.coordinator
        editor.string = text
        scroll.documentView = editor
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let editor = scroll.documentView as? PromptTextView else { return }
        let coordinator = context.coordinator
        coordinator.view = self
        editor.onKey = onKey
        editor.onFocus = onFocus
        if editor.string != text, !editor.hasMarkedText() {
            editor.string = text
            let end = NSRange(location: (text as NSString).length, length: 0)
            editor.setSelectedRange(end)
            editor.scrollRangeToVisible(end)
        }
        if let focus, coordinator.lastFocus != focus {
            coordinator.lastFocus = focus
            editor.takeFocus = true
            DispatchQueue.main.async { [weak editor] in editor?.focusIfAttached() }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(view: self) }

    @MainActor final class Coordinator: NSObject, NSTextViewDelegate {
        var view: PromptEditor
        var lastFocus: UUID?

        init(view: PromptEditor) { self.view = view }

        func textDidChange(_ notification: Notification) {
            if let editor = notification.object as? NSTextView, view.text != editor.string {
                view.text = editor.string
            }
        }
    }
}

private final class PromptTextView: NSTextView {
    var onKey: ((PromptEditor.Key) -> Bool)?
    var onFocus: (() -> Void)?
    var takeFocus = false
    private var jumpDirection: Int?

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if takeFocus { DispatchQueue.main.async { [weak self] in self?.focusIfAttached() } }
    }

    func focusIfAttached() {
        guard takeFocus, let window else { return }
        takeFocus = false
        window.makeFirstResponder(self)
    }

    override func becomeFirstResponder() -> Bool {
        let became = super.becomeFirstResponder()
        if became { DispatchQueue.main.async { [weak self] in self?.onFocus?() } }
        return became
    }

    override func keyDown(with event: NSEvent) {
        if hasMarkedText() { super.keyDown(with: event); return }
        let modifiers = event.modifierFlags.intersection([.control, .command, .option, .shift])
        if let direction = jumpDirection {
            jumpDirection = nil
            if modifiers.subtracting(.shift).isEmpty, let character = event.characters, character.count == 1 {
                jump(to: character, direction: direction)
                return
            }
        }
        func handle(_ key: PromptEditor.Key) -> Bool { onKey?(key) == true }
        switch event.keyCode {
        case 36, 76:
            if modifiers == .option, handle(.queue) { return }
            if modifiers.isEmpty, handle(.submit) { return }
            if modifiers == .shift { insertNewline(nil); return }
        case 53:
            if modifiers.isEmpty, handle(.escape) { return }
        case 48:
            if modifiers == .shift, handle(.cycleThinking) { return }
            if modifiers.isEmpty, handle(.complete) { return }
        case 126, 125:
            let up = event.keyCode == 126
            if modifiers == .option && up, handle(.withdraw) { return }
            if modifiers == .control || modifiers == [.control, .shift], handle(.prompt(up ? -1 : 1)) { return }
            if modifiers.isEmpty {
                if handle(up ? .up : .down) { return }
                if atLineEdge(top: up), handle(up ? .previousHistory : .nextHistory) { return }
            }
        case 116, 121:
            if modifiers.isEmpty || modifiers == .control, handle(.page(event.keyCode == 116 ? -1 : 1)) { return }
        case 115, 119:
            if modifiers == .control, handle(.edge(event.keyCode == 115 ? -1 : 1)) { return }
        default:
            let key = event.charactersIgnoringModifiers?.lowercased()
            if key == "]", modifiers == .control || modifiers == [.control, .option] {
                jumpDirection = modifiers.contains(.option) ? -1 : 1
                return
            }
            if key == "f", modifiers == [.control, .shift], handle(.find) { return }
            if modifiers == .control {
                switch key {
                case "l": if handle(.models) { return }
                case "o": if handle(.toggleTools) { return }
                case "t": if handle(.toggleThinking) { return }
                case "j": insertNewline(nil); return
                case "-": undoManager?.undo(); return
                case "c":
                    if selectedRange().length > 0 { copy(nil); return }
                    if !string.isEmpty {
                        setSelectedRange(NSRange(location: 0, length: (string as NSString).length))
                        insertText("", replacementRange: selectedRange())
                        return
                    }
                    if handle(.quit) { return }
                case "d": if string.isEmpty, handle(.quit) { return }
                default: break
                }
            }
        }
        super.keyDown(with: event)
    }

    private func atLineEdge(top: Bool) -> Bool {
        let selection = selectedRange()
        guard selection.length == 0, let layoutManager, let textContainer else { return false }
        layoutManager.ensureLayout(for: textContainer)
        let length = (string as NSString).length
        if length == 0 || layoutManager.numberOfGlyphs == 0 { return true }
        if selection.location >= length && layoutManager.extraLineFragmentTextContainer != nil { return !top }
        let glyph = layoutManager.glyphIndexForCharacter(at: min(selection.location, length - 1))
        var line = NSRange()
        _ = layoutManager.lineFragmentRect(forGlyphAt: glyph, effectiveRange: &line)
        return top ? line.location == 0 : NSMaxRange(line) == layoutManager.numberOfGlyphs && layoutManager.extraLineFragmentTextContainer == nil
    }

    private func jump(to character: String, direction: Int) {
        let text = string as NSString
        let start = min(selectedRange().location, text.length)
        let lower = direction > 0 ? min(start + 1, text.length) : 0
        let upper = direction > 0 ? text.length : start
        let range = text.range(of: character, options: direction < 0 ? .backwards : [],
                               range: NSRange(location: lower, length: upper - lower))
        if range.location != NSNotFound {
            setSelectedRange(NSRange(location: range.location, length: 0))
            scrollRangeToVisible(selectedRange())
        }
    }
}
