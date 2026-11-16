import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent, getMarkdownTheme, ToolExecutionComponent, UserMessageComponent, type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {
  Container, getCapabilities, getImageDimensions, imageFallback, Markdown, Text, type Component, type TUI, type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { object, type ConversationState } from "./client.ts";
import { button, clean, cleanData, colors, line } from "./ui.ts";

type ToolCard = {
  component: ToolExecutionComponent;
  args: string;
  result: string;
  started: boolean;
  argsComplete: boolean;
  complete: boolean;
};

export function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  return Array.isArray(value) ? value.flatMap(part => object(part).type === "text" ? [String(object(part).text ?? "")] : []).join("\n") : "";
}

/** Keep Pi's tool shell and click expansion, without its inline shortcut tutorial. */
const toolRenderers: ToolRenderers = {
  renderResult({ content }, { expanded }, theme, context) {
    const output = content.flatMap(part => {
      if (part.type === "text") return [part.text];
      if (part.type === "image" && (!getCapabilities().images || !context.showImages)) {
        return [imageFallback(part.mimeType, getImageDimensions(part.data, part.mimeType) ?? undefined)];
      }
      return [];
    }).join("\n");
    const lines = output.split("\n");
    const preview = expanded ? lines : lines.slice(0, 10);
    let text = preview.map(value => theme.fg("toolOutput", value)).join("\n");
    if (preview.length < lines.length) text += theme.fg("muted", `\n… (${lines.length - preview.length} more lines)`);
    return new Text(text, 0, 0);
  },
};

export class Transcript extends Container {
  private ui: TUI;
  private epoch = -1;
  private messages = new Map<string, Component>();
  private tools = new Map<string, ToolCard>();
  private partial = new AssistantMessageComponent();
  private hideThinking = false;
  private expanded = false;
  private loadOlder: () => void;
  private activate: () => void;

  constructor(ui: TUI, loadOlder: () => void, activate: () => void) {
    super();
    this.ui = ui;
    this.loadOlder = loadOlder;
    this.activate = activate;
  }

  override handleMouse(event: TuiMouseEvent) {
    if (event.type === "press" || event.type === "click") this.activate();
    return super.handleMouse(event);
  }

  setHideThinkingBlock(hide: boolean) {
    if (this.hideThinking === hide) return;
    this.hideThinking = hide;
    for (const message of this.messages.values()) {
      if (message instanceof AssistantMessageComponent) message.setHideThinkingBlock(hide);
    }
    this.partial.setHideThinkingBlock(hide);
    this.ui.requestRender();
  }

  expand(expanded: boolean) {
    this.expanded = expanded;
    for (const tool of this.tools.values()) tool.component.setExpanded(expanded);
  }

  private tool(call: Pick<ToolCall, "id" | "name" | "arguments">, cwd: string): ToolCard {
    let tool = this.tools.get(call.id);
    const args = JSON.stringify(call.arguments);
    if (!tool) {
      const component = new ToolExecutionComponent(clean(call.name), call.id, cleanData(call.arguments), { showImages: true }, toolRenderers, this.ui, cwd);
      component.setExpanded(this.expanded);
      // Enables argument expansion even before the tool publishes its first output.
      component.updateResult({ content: [], isError: false }, true);
      tool = { component, args, result: "", started: false, argsComplete: false, complete: false };
      this.tools.set(call.id, tool);
    } else if (tool.args !== args) {
      tool.component.updateArgs(cleanData(call.arguments));
      tool.args = args;
    }
    return tool;
  }

  private result(tool: ToolCard, result: Parameters<ToolExecutionComponent["updateResult"]>[0], partial = false) {
    const fingerprint = `${partial}:${JSON.stringify(result)}`;
    if (fingerprint === tool.result) return;
    tool.component.updateResult(cleanData(result), partial);
    tool.result = fingerprint;
  }

  update(state: ConversationState) {
    if (this.epoch !== state.epoch) {
      this.messages.clear();
      this.tools.clear();
      this.epoch = state.epoch;
    }
    this.clear();
    if (state.before) this.addChild(button(() => colors.accent(state.loading ? "Loading history…" : "↑ Load older messages"), this.loadOlder));
    const shown = new Set<string>();
    const cwd = state.snapshot?.status?.cwd ?? "";
    const addTool = (tool: ToolCard, id: string) => {
      if (!shown.has(id)) { this.addChild(tool.component); shown.add(id); }
    };
    for (const entry of [...state.entries.values()].sort((a, b) => a.id - b.id)) {
      // Worker reports stay in model context; the coordinator's synthesis is user-facing.
      if (entry.kind === "anima.agent-report") continue;
      const data = object(entry.data);
      if (entry.kind === "pi.compaction" || entry.kind === "pi.reset") {
        this.addMessage(`${entry.id}:context`, () => new Text(colors.muted(entry.kind === "pi.reset" ? "Context reset" : "Context compacted"), 1, 1));
        continue;
      }
      for (const [index, message] of (entry.model ?? []).entries()) {
        const key = `${entry.id}:${index}`;
        if (message.role === "user") {
          if (data.origin === "agent") {
            this.addMessage(key, () => {
              const group = new Container();
              group.addChild(new Text(colors.accent("Delegated instruction"), 1, 0));
              group.addChild(new Markdown(clean(entry.kind === "anima.agent-message" && typeof data.content === "string"
                ? data.content : contentText(message.content)), 1, 1, getMarkdownTheme()));
              return group;
            });
          } else this.addMessage(key, () => new UserMessageComponent(clean(contentText(message.content))));
        } else if (message.role === "assistant") {
          this.addMessage(key, () => new AssistantMessageComponent(cleanData(message), this.hideThinking));
          for (const call of message.content) {
            if (call.type !== "toolCall") continue;
            const tool = this.tool(call, cwd);
            if (!tool.argsComplete) { tool.component.setArgsComplete(); tool.argsComplete = true; }
            addTool(tool, call.id);
          }
        } else if (message.role === "toolResult") {
          const tool = this.tools.get(message.toolCallId) ?? this.tool({ id: message.toolCallId, name: message.toolName, arguments: {} }, cwd);
          this.result(tool, { content: message.content, details: message.details, isError: message.isError, durationMs: message.durationMs });
          tool.complete = true;
          addTool(tool, message.toolCallId);
        }
      }
    }
    const live = object(state.snapshot?.docs["pi.live"]);
    const generation = object(live.generation);
    if (generation.message) {
      this.partial.updateContent(cleanData(generation.message as AssistantMessage), true);
      this.addChild(this.partial);
      const message = generation.message as AssistantMessage;
      for (const call of message.content ?? []) {
        if (call.type === "toolCall") addTool(this.tool(call, cwd), call.id);
      }
    }
    for (const slot of Array.isArray(live.tools) ? live.tools : []) {
      const value = object(slot);
      const tool = this.tools.get(String(value.callId));
      if (!tool || tool.complete) continue;
      if (value.status === "running" && !tool.started) {
        tool.component.markExecutionStarted();
        tool.started = true;
      }
      this.result(tool, {
        content: [{ type: "text", text: typeof value.output === "string" ? value.output : value.status === "done" ? "Finished" : "Running…" }],
        details: value.details, isError: false,
      }, value.status !== "done");
    }
    for (const slot of Array.isArray(live.nestedTools) ? live.nestedTools : []) {
      const value = object(slot);
      const id = String(value.callId);
      const tool = this.tool({ id, name: `↳ ${value.name}`, arguments: object(value.arguments) as ToolCall["arguments"] }, cwd);
      const summary = object(value.summary);
      this.result(tool, {
        content: [{ type: "text", text: String(value.output ?? summary.error ?? (value.status === "done" ? "Completed" : "Running…")) }],
        details: value.details, isError: summary.isError === true,
      }, value.status !== "done");
      addTool(tool, id);
    }
    if (!state.snapshot) this.addChild(line(colors.muted("Loading conversation…")));
    const retry = object(generation.retry);
    if (retry.error) this.addChild(line(colors.yellow(`Retrying: ${clean(String(retry.error))}`)));
  }

  private addMessage(key: string, create: () => Component) {
    let message = this.messages.get(key);
    if (!message) { message = create(); this.messages.set(key, message); }
    this.addChild(message);
  }
}
