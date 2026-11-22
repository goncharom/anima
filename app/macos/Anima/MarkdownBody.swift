import AppKit
import SwiftUI

struct MarkdownBody: View {
    let text: String

    var body: some View {
        TranscriptText(content: formatted)
    }

    private var formatted: NSAttributedString {
        // One attributed string, including fenced code, so a drag can cross any
        // paragraph, list, heading, or code boundary within this response.
        let result = NSMutableAttributedString()
        var previousWasList = false
        for block in MarkdownBlock.parse(text) {
            let style = NSMutableParagraphStyle()
            style.lineSpacing = 2
            let content: NSAttributedString
            var isList = false
            switch block {
            case .paragraph(let value):
                content = inline(value, style: style)
            case .heading(let level, let title):
                content = inline(title, size: level < 3 ? 14 : 13, bold: true, style: style)
            case .list(let marker, let value):
                isList = true
                style.firstLineHeadIndent = 6
                style.headIndent = 6 + CGFloat(marker.count + 1) * Terminal.columnWidth
                style.tabStops = [NSTextTab(textAlignment: .left, location: style.headIndent)]
                let item = NSMutableAttributedString(string: marker + "\t", attributes: Markup.attributes(color: Terminal.accent, style: style))
                item.append(inline(value, style: style))
                content = item
            case .quote(let value):
                style.firstLineHeadIndent = 10
                style.headIndent = 10
                content = inline(value, color: Terminal.muted, style: style)
            case .code(let language, let value):
                content = Markup.code(value, diff: language == "diff" || language == "patch", highlight: true)
            case .rule:
                content = NSAttributedString(string: String(repeating: "─", count: 16), attributes: Markup.attributes(color: Terminal.muted))
            }
            guard content.length > 0 else { continue }
            Markup.separate(result, gap: !(isList && previousWasList))
            result.append(content)
            previousWasList = isList
        }
        return result
    }

    private func inline(_ value: String, size: CGFloat = Terminal.textSize, bold: Bool = false,
                        color: Color = Terminal.text, style: NSParagraphStyle) -> NSAttributedString {
        let content = (try? AttributedString(markdown: value, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(value)
        let result = NSMutableAttributedString()
        for run in content.runs {
            var attributes = Markup.attributes(size: size, color: color, style: style)
            let intent = run.inlinePresentationIntent ?? []
            var traits: NSFontTraitMask = []
            if bold || intent.contains(.stronglyEmphasized) { traits.insert(.boldFontMask) }
            if intent.contains(.emphasized) { traits.insert(.italicFontMask) }
            if !traits.isEmpty { attributes[.font] = NSFontManager.shared.convert(Terminal.nativeFont(size), toHaveTrait: traits) }
            if intent.contains(.strikethrough) { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
            if intent.contains(.code) { attributes[.backgroundColor] = NSColor(Terminal.surface) }
            if let url = run.link, let scheme = url.scheme?.lowercased(), ["https", "http", "mailto"].contains(scheme) {
                attributes[.link] = url
            }
            result.append(NSAttributedString(string: String(content[run.range].characters), attributes: attributes))
        }
        return result
    }
}

struct ToolOutputText: View {
    let sections: [(label: String, text: String)]

    var body: some View {
        let content = NSMutableAttributedString()
        for section in sections {
            Markup.separate(content, gap: true)
            content.append(NSAttributedString(string: section.label + "\n", attributes: Markup.attributes(size: Terminal.metaSize, color: Terminal.muted)))
            content.append(Markup.code(section.text, diff: section.label == "diff"))
        }
        return TranscriptText(content: content)
    }
}

@MainActor private enum Markup {
    static func attributes(size: CGFloat = Terminal.textSize, color: Color = Terminal.text,
                           style: NSParagraphStyle = .default) -> [NSAttributedString.Key: Any] {
        [.font: Terminal.nativeFont(size), .foregroundColor: NSColor(color), .paragraphStyle: style]
    }

    static func code(_ text: String, diff: Bool, highlight: Bool = false) -> NSAttributedString {
        let style = NSMutableParagraphStyle()
        style.defaultTabInterval = 4 * Terminal.columnWidth
        var base = attributes(size: Terminal.labelSize, style: style)
        if highlight { base[.backgroundColor] = NSColor(Terminal.surface) }
        guard diff else { return NSAttributedString(string: text, attributes: base) }
        let result = NSMutableAttributedString()
        for (index, line) in text.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
            if index > 0 { result.append(NSAttributedString(string: "\n", attributes: base)) }
            var themed = base
            if line.hasPrefix("+") { themed[.foregroundColor] = NSColor(Terminal.good) }
            else if line.hasPrefix("-") { themed[.foregroundColor] = NSColor(Terminal.red) }
            result.append(NSAttributedString(string: String(line), attributes: themed))
        }
        return result
    }

    static func separate(_ output: NSMutableAttributedString, gap: Bool) {
        guard output.length > 0 else { return }
        var last = output.attributes(at: output.length - 1, effectiveRange: nil)
        last[.link] = nil
        output.append(NSAttributedString(string: "\n", attributes: last))
        if gap { output.append(NSAttributedString(string: "\n", attributes: attributes(size: 4))) }
    }
}

private enum MarkdownBlock {
    case paragraph(String), heading(Int, String), list(String, String), quote(String), code(String, String), rule

    static func parse(_ source: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        var quote: [String] = []
        var code: [String] = []
        var fence: (marker: Character, length: Int, language: String)?
        let lines = source.split(omittingEmptySubsequences: false) { $0.isNewline }.map(String.init)

        func flush() {
            if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))); paragraph = [] }
            if !quote.isEmpty { blocks.append(.quote(quote.joined(separator: "\n"))); quote = [] }
        }

        var index = 0
        while index < lines.count {
            let original = lines[index]
            let line = original.trimmingCharacters(in: .whitespaces)
            index += 1
            if let current = fence {
                let markers = line.prefix { $0 == current.marker }
                if markers.count >= current.length && markers.count == line.count {
                    blocks.append(.code(current.language, code.joined(separator: "\n")))
                    code = []
                    fence = nil
                } else { code.append(original) }
                continue
            }
            if let marker = line.first, marker == "`" || marker == "~" {
                let length = line.prefix { $0 == marker }.count
                if length >= 3 {
                    flush()
                    let language = line.dropFirst(length).split(whereSeparator: \.isWhitespace).first.map(String.init) ?? ""
                    fence = (marker, length, language)
                    continue
                }
            }
            if line.isEmpty { flush(); continue }
            if line.hasPrefix(">") {
                if !paragraph.isEmpty { flush() }
                quote.append(line.dropFirst().trimmingCharacters(in: .whitespaces))
                continue
            }
            if !quote.isEmpty { flush() }
            let heading = line.prefix { $0 == "#" }.count
            if (1...6).contains(heading), line.dropFirst(heading).first == " " {
                flush()
                blocks.append(.heading(heading, line.dropFirst(heading + 1).trimmingCharacters(in: .whitespaces)))
                continue
            }
            let tight = line.filter { !$0.isWhitespace }
            if let marker = tight.first, tight.count >= 3, "-*_".contains(marker), tight.allSatisfy({ $0 == marker }) {
                flush()
                blocks.append(.rule)
                continue
            }
            if line.contains("|"), index < lines.count, tableSeparator(lines[index]) {
                flush()
                var table = [original, lines[index]]
                index += 1
                while index < lines.count, lines[index].contains("|") {
                    table.append(lines[index]); index += 1
                }
                blocks.append(.code("table", table.joined(separator: "\n")))
                continue
            }
            let digits = line.prefix { $0.isNumber }
            if !digits.isEmpty, line.dropFirst(digits.count).hasPrefix(". ") || line.dropFirst(digits.count).hasPrefix(") ") {
                flush()
                blocks.append(.list(String(digits) + ".", String(line.dropFirst(digits.count + 2))))
            } else if line.hasPrefix("- ") || line.hasPrefix("+ ") || line.hasPrefix("* ") {
                flush()
                let value = line.dropFirst(2)
                if value.hasPrefix("[ ] ") || value.hasPrefix("[x] ") || value.hasPrefix("[X] ") {
                    blocks.append(.list(value.hasPrefix("[ ]") ? "☐" : "☑", String(value.dropFirst(4))))
                } else { blocks.append(.list("•", String(value))) }
            } else {
                paragraph.append(original)
            }
        }
        flush()
        if let fence { blocks.append(.code(fence.language, code.joined(separator: "\n"))) }
        return blocks
    }

    private static func tableSeparator(_ line: String) -> Bool {
        line.contains("|") && line.contains("-") && line.allSatisfy { "-:|".contains($0) || $0.isWhitespace }
    }
}
