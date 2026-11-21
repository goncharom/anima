import AppKit
import SwiftUI

struct MarkdownBody: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(MarkdownBlock.parse(text).enumerated()), id: \.offset) { _, block in
                switch block {
                case .paragraph(let value): inline(value)
                case .heading(let level, let title):
                    inline(title).font(Terminal.font(level < 3 ? 14 : 13)).bold().foregroundStyle(Terminal.text)
                        .accessibilityAddTraits(.isHeader)
                case .list(let marker, let value):
                    HStack(alignment: .firstTextBaseline, spacing: 7) {
                        Text(marker).foregroundStyle(Terminal.accent)
                        inline(value)
                    }
                    .padding(.leading, 6)
                case .quote(let value):
                    inline(value).foregroundStyle(Terminal.muted).padding(.leading, 10)
                        .overlay(alignment: .leading) { TerminalRule(vertical: true) }
                case .code(let language, let value): CodeBlock(text: value, language: language)
                case .rule: TerminalRule()
                }
            }
        }
        .font(Terminal.font()).foregroundStyle(Terminal.text)
        .environment(\.openURL, OpenURLAction { url in
            guard let scheme = url.scheme?.lowercased(), ["https", "http", "mailto"].contains(scheme) else { return .discarded }
            return .systemAction
        })
    }

    private func inline(_ value: String) -> some View {
        let content = (try? AttributedString(markdown: value, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(value)
        return Text(content).tint(Terminal.accent).textSelection(.enabled)
            .lineSpacing(2).fixedSize(horizontal: false, vertical: true)
    }
}

struct CodeBlock: View {
    let text: String
    let language: String
    var outlined = true
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Text(language.isEmpty ? "code" : language)
                    .font(Terminal.font(Terminal.metaSize)).foregroundStyle(Terminal.muted).lineLimit(1)
                Spacer()
                TerminalIcon(symbol: copied ? "checkmark" : "document.on.document", label: "Copy \(language.isEmpty ? "code" : language)") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(text, forType: .string)
                    copied = true
                }
            }
            .padding(.horizontal, 7).frame(height: Terminal.controlSize)
            TerminalRule()
            ScrollView(.horizontal) {
                displayedCode.font(Terminal.font(Terminal.labelSize)).textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: false)
                    .padding(7)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(outlined ? Terminal.surface : Terminal.black, in: RoundedRectangle(cornerRadius: 4))
        .overlay { RoundedRectangle(cornerRadius: 4).strokeBorder(Terminal.border).allowsHitTesting(false) }
        .task(id: copied) {
            if copied {
                do { try await Task.sleep(for: .seconds(1.3)); copied = false } catch {}
            }
        }
    }

    private var displayedCode: Text {
        guard language == "diff" || language == "patch" else { return Text(text).foregroundColor(Terminal.text) }
        var attributed = AttributedString()
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            if !attributed.characters.isEmpty { attributed.append(AttributedString("\n")) }
            var part = AttributedString(String(line))
            part.foregroundColor = line.hasPrefix("+") ? Terminal.good : line.hasPrefix("-") ? Terminal.red : Terminal.text
            attributed.append(part)
        }
        return Text(attributed)
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
