import AnimaProtocol
import SwiftUI

struct SubagentDefaultsView: View {
    private struct ModelKey: Hashable, Identifiable {
        let provider: String
        let modelID: String
        var id: ModelKey { self }
        var label: String { "\(provider)/\(modelID)" }
    }

    private struct ModelOption: Identifiable {
        let key: ModelKey
        let info: Anima_V1_ModelInfo
        var id: ModelKey { key }
    }

    private let client: HarnessClient
    @Environment(\.dismiss) private var dismiss
    @State private var models: [Anima_V1_ModelInfo] = []
    @State private var selectedModel: ModelKey?
    @State private var thinkingLevel = ""
    @State private var loadID = UUID()
    @State private var loaded = false
    @State private var loading = false
    @State private var saving = false
    @State private var error: String?

    init(client: HarnessClient) { self.client = client }

    private var selectedInfo: Anima_V1_ModelInfo? {
        guard let selectedModel else { return nil }
        return models.first { $0.model.provider == selectedModel.provider && $0.model.modelID == selectedModel.modelID }
    }

    private var thinkingChoices: [String] { selectedInfo?.supportedThinkingLevels ?? [] }
    private var unavailableThinking: Bool { !thinkingLevel.isEmpty && !thinkingChoices.contains(thinkingLevel) }
    private var canSave: Bool { selectedInfo != nil && thinkingChoices.contains(thinkingLevel) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionCaption("ANIMA / SUBAGENTS")
            Text("Subagent defaults").font(Terminal.font(17)).foregroundStyle(Terminal.text)
            Text("Server-wide defaults for new subagents. Existing subagents are unchanged.")
                .font(Terminal.font(Terminal.labelSize)).foregroundStyle(Terminal.muted)
                .fixedSize(horizontal: false, vertical: true)

            if loading || !loaded {
                if let error {
                    ErrorLine(message: error)
                    Button("Retry", systemImage: "arrow.clockwise") { loadID = UUID() }
                        .buttonStyle(TerminalButtonStyle())
                } else {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Loading server defaults and models…").font(Terminal.font(Terminal.labelSize)).foregroundStyle(Terminal.muted)
                    }
                    .frame(maxWidth: .infinity, minHeight: 96, alignment: .center)
                }
            } else {
                settings
                if let error { ErrorLine(message: error) }
            }

            TerminalRule()
            HStack {
                if saving { ProgressView().controlSize(.small) }
                Spacer()
                Button("Cancel") { dismiss() }.buttonStyle(TerminalButtonStyle())
                    .keyboardShortcut(.cancelAction).disabled(saving)
                if loaded {
                    Button("Save", action: save).buttonStyle(TerminalButtonStyle(primary: true))
                        .keyboardShortcut(.defaultAction).disabled(!canSave || saving)
                }
            }
        }
        .padding(19)
        .frame(width: 460)
        .background(Terminal.black)
        .interactiveDismissDisabled(saving)
        .task(id: loadID) { await load() }
        .task(id: saving) { if saving { await saveDefaults() } }
        .onChange(of: selectedModel) { oldValue, newValue in
            guard oldValue != nil, newValue != nil, !thinkingChoices.contains(thinkingLevel) else { return }
            thinkingLevel = ""
        }
    }

    private var modelOptions: [ModelOption] {
        models.compactMap { info in
            guard info.hasModel else { return nil }
            return ModelOption(key: ModelKey(provider: info.model.provider, modelID: info.model.modelID), info: info)
        }
    }

    private var settings: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 5) {
                SectionCaption("MODEL")
                Picker("Model", selection: $selectedModel) {
                    if let selectedModel, selectedInfo == nil {
                        Text("Unavailable · \(selectedModel.label)").tag(Optional(selectedModel))
                    }
                    ForEach(modelOptions) { option in
                        Text("\(cleanText(option.info.name)) · \(option.key.label)").tag(Optional(option.key))
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .disabled(saving || models.isEmpty)
                if selectedInfo == nil, let selectedModel {
                    Text("This saved model is not in the current catalog. Choose an available model to save changes, or close without saving to retain the existing defaults.")
                        .font(Terminal.font(Terminal.metaSize)).foregroundStyle(Terminal.amber)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(selectedModel.label).font(Terminal.font(Terminal.labelSize))
                        .foregroundStyle(Terminal.muted).textSelection(.enabled)
                } else if models.isEmpty {
                    Text("The server returned no available models.")
                        .font(Terminal.font(Terminal.metaSize)).foregroundStyle(Terminal.muted)
                }
            }

            VStack(alignment: .leading, spacing: 5) {
                SectionCaption("THINKING LEVEL")
                Picker("Thinking level", selection: $thinkingLevel) {
                    if unavailableThinking {
                        Text("Choose a supported level").tag(thinkingLevel)
                    } else if thinkingLevel.isEmpty {
                        Text("Choose a level").tag("")
                    }
                    ForEach(thinkingChoices, id: \.self) { level in
                        Text(cleanText(level)).tag(level)
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .disabled(saving || thinkingChoices.isEmpty)
                if unavailableThinking {
                    Text("Saved level “\(thinkingLevel)” is not supported by this model. Choose a listed level to save changes, or close without saving to retain the existing defaults.")
                        .font(Terminal.font(Terminal.metaSize)).foregroundStyle(Terminal.amber)
                        .fixedSize(horizontal: false, vertical: true)
                } else if thinkingChoices.isEmpty {
                    Text("No supported thinking levels are advertised for this model. Close without saving to retain the existing defaults.")
                        .font(Terminal.font(Terminal.metaSize)).foregroundStyle(Terminal.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func load() async {
        loading = true
        loaded = false
        error = nil
        defer { if !Task.isCancelled { loading = false } }
        do {
            let response = try await client.rpc.getSubagentDefaults(request: .init()).value()
            guard response.hasDefaults, response.defaults.hasModel else { throw ClientIssue("Server returned no subagent defaults.") }
            let catalog = try await client.rpc.listModels(request: .init()).value().models.filter(\.hasModel)
            guard !Task.isCancelled else { return }
            models = catalog
            let defaults = response.defaults
            selectedModel = ModelKey(provider: defaults.model.provider, modelID: defaults.model.modelID)
            thinkingLevel = defaults.thinkingLevel
            loaded = true
        } catch {
            if !Task.isCancelled { self.error = describe(error) }
        }
    }

    private func save() {
        guard canSave, !saving else { return }
        error = nil
        saving = true
    }

    private func saveDefaults() async {
        guard let selectedModel, !thinkingLevel.isEmpty else { return }
        do {
            let response = try await client.rpc.updateSubagentDefaults(request: .with {
                $0.model.provider = selectedModel.provider
                $0.model.modelID = selectedModel.modelID
                $0.thinkingLevel = thinkingLevel
            }).value()
            guard response.hasDefaults else { throw ClientIssue("Server did not confirm the updated defaults.") }
            if !Task.isCancelled { dismiss() }
        } catch {
            if !Task.isCancelled { self.error = describe(error); saving = false }
        }
    }
}
