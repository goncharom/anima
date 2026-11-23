import AppKit
import CoreText
import SwiftUI

enum Terminal {
    static let black = Color.black
    static let surface = Color(white: 0.045)
    static let hover = Color(white: 0.085)
    static let selected = Color(red: 0.042, green: 0.082, blue: 0.078)
    static let border = Color(white: 0.16)
    static let text = Color(white: 0.88)
    static let muted = Color(red: 0.54, green: 0.58, blue: 0.61)
    static let accent = Color(red: 0.55, green: 0.90, blue: 0.83)
    static let good = Color(red: 0.51, green: 0.84, blue: 0.63)
    static let amber = Color(red: 0.96, green: 0.76, blue: 0.47)
    static let red = Color(red: 0.99, green: 0.57, blue: 0.60)

    static let textSize: CGFloat = 12
    static let labelSize: CGFloat = 11
    static let metaSize: CGFloat = 10
    static let paneHeaderHeight: CGFloat = 42
    static let controlSize: CGFloat = 24
    static let paneInset: CGFloat = 12
    static let promptInset: CGFloat = 2
    static let lineHeight = ceil(NSLayoutManager().defaultLineHeight(for: nativeFont()))

    static func motion(reduced: Bool) -> Animation? {
        reduced ? nil : .easeInOut(duration: 0.17)
    }

    private static let postScriptName: String? = {
        guard let url = Bundle.main.url(forResource: "Iosevka-Extended", withExtension: "ttf") else { return nil }
        CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        return (CTFontManagerCreateFontDescriptorsFromURL(url as CFURL) as? [CTFontDescriptor])?
            .first.flatMap { CTFontDescriptorCopyAttribute($0, kCTFontNameAttribute) as? String }
    }()

    static func font(_ size: CGFloat = textSize) -> Font {
        if let postScriptName { return .custom(postScriptName, size: size) }
        return .system(size: size, design: .monospaced)
    }

    static func nativeFont(_ size: CGFloat = textSize) -> NSFont {
        if let postScriptName, let font = NSFont(name: postScriptName, size: size) { return font }
        return .monospacedSystemFont(ofSize: size, weight: .regular)
    }

    static var columnWidth: CGFloat { ("0" as NSString).size(withAttributes: [.font: nativeFont()]).width }
}

extension View {
    func chatColumn(worker: Bool) -> some View {
        padding(.horizontal, worker ? Terminal.paneInset : 18)
            .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
    }
}

struct TerminalRule: View {
    var vertical = false
    @Environment(\.displayScale) private var scale

    var body: some View {
        Rectangle().fill(Terminal.border)
            .frame(width: vertical ? 1 / scale : nil, height: vertical ? nil : 1 / scale)
            .accessibilityHidden(true)
    }
}

struct SectionCaption: View {
    let label: String

    init(_ label: String) { self.label = label }

    var body: some View {
        Text(label).font(Terminal.font(Terminal.metaSize)).tracking(1.45)
            .foregroundStyle(Terminal.muted).lineLimit(1)
            .accessibilityAddTraits(.isHeader)
    }
}

struct TerminalDot: View {
    enum State { case unknown, idle, busy }
    let state: State

    var body: some View {
        Circle()
            .fill(state == .busy ? Terminal.amber : (state == .idle ? Terminal.good : Terminal.muted.opacity(0.15)))
            .overlay { if state == .unknown { Circle().strokeBorder(Terminal.muted.opacity(0.65), lineWidth: 1) } }
            .frame(width: 5, height: 5)
            .accessibilityLabel(state == .busy ? "Working" : (state == .idle ? "Idle" : "Status unavailable"))
    }
}

struct TerminalButtonStyle: ButtonStyle {
    var primary = false
    var tint = Terminal.text

    func makeBody(configuration: Configuration) -> some View {
        ButtonBody(configuration: configuration, primary: primary, tint: tint)
    }

    private struct ButtonBody: View {
        let configuration: Configuration
        let primary: Bool
        let tint: Color
        @State private var hovering = false
        @Environment(\.isEnabled) private var enabled

        var body: some View {
            configuration.label
                .font(Terminal.font(Terminal.labelSize))
                .padding(.horizontal, 8).frame(minHeight: Terminal.controlSize)
                .foregroundStyle(primary ? Terminal.black : tint)
                .background(background, in: RoundedRectangle(cornerRadius: 5))
                .overlay {
                    RoundedRectangle(cornerRadius: 5).strokeBorder(primary ? .clear : Terminal.border)
                        .allowsHitTesting(false)
                }
                .opacity(enabled ? 1 : 0.38)
                .contentShape(Rectangle())
                .onHover { hovering = $0 }
        }

        private var background: Color {
            if primary { return Terminal.accent.opacity(configuration.isPressed ? 0.7 : 1) }
            return hovering || configuration.isPressed ? Terminal.hover : Terminal.surface
        }
    }
}

struct TerminalIcon: View {
    let symbol: String
    let label: String
    var highlighted = false
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 11, weight: .medium))
                .frame(width: Terminal.controlSize, height: Terminal.controlSize)
        }
        .buttonStyle(QuietButtonStyle(highlighted: highlighted))
        .help(label)
        .accessibilityLabel(label)
    }
}

struct QuietButtonStyle: ButtonStyle {
    var highlighted = false
    var tint: Color? = nil

    func makeBody(configuration: Configuration) -> some View {
        QuietBody(configuration: configuration, highlighted: highlighted, tint: tint)
    }

    private struct QuietBody: View {
        let configuration: Configuration
        let highlighted: Bool
        let tint: Color?
        @State private var hovering = false
        @Environment(\.isEnabled) private var enabled

        var body: some View {
            configuration.label
                .foregroundStyle(tint ?? (highlighted ? Terminal.accent : Terminal.muted))
                .background(highlighted ? Terminal.selected : (hovering || configuration.isPressed ? Terminal.hover : .clear),
                            in: RoundedRectangle(cornerRadius: 5))
                .opacity(enabled ? 1 : 0.4)
                .contentShape(Rectangle())
                .onHover { hovering = $0 }
        }
    }
}

struct KeyHint: View {
    let label: String

    init(_ label: String) { self.label = label }

    var body: some View {
        Text(label).font(Terminal.font(Terminal.metaSize)).foregroundStyle(Terminal.muted)
            .padding(.horizontal, 4).padding(.vertical, 1)
            .background(Terminal.surface, in: RoundedRectangle(cornerRadius: 3))
            .overlay { RoundedRectangle(cornerRadius: 3).strokeBorder(Terminal.border) }
    }
}

struct TerminalFieldStyle: TextFieldStyle {
    func _body(configuration: TextField<Self._Label>) -> some View {
        configuration.textFieldStyle(.plain).font(Terminal.font())
            .padding(.horizontal, 8).padding(.vertical, 6)
            .foregroundStyle(Terminal.text)
            .background(Terminal.surface, in: RoundedRectangle(cornerRadius: 5))
            .overlay { RoundedRectangle(cornerRadius: 5).strokeBorder(Terminal.border).allowsHitTesting(false) }
    }
}

struct ErrorLine: View {
    let message: String
    var tint = Terminal.red

    var body: some View {
        Label(cleanText(message), systemImage: "exclamationmark.circle")
            .font(Terminal.font(Terminal.labelSize)).foregroundStyle(tint)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
    }
}
