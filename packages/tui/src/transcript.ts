import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent, getMarkdownTheme, ToolExecutionComponent, UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text, type Component, type TUI } from "@earendil-works/pi-tui";
import { object, type ConversationState, type Entry } from "./client.ts";
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

export class Transcript extends Container {
  private ui: TUI;
  private epoch = -1;
  private messages = new Map<string, Component>();
  private tools = new Map<string, ToolCard>();
  private partial = new AssistantMessageComponent();
  private expanded = false;
  private loadOlder: () => void;

  constructor(ui: TUI, loadOlder: () => void) {
    super();
    this.ui = ui;
    this.loadOlder = loadOlder;
  }

  expand(expanded: boolean) {
    this.expanded = expanded;
    for (const tool of this.tools.values()) tool.component.setExpanded(expanded);
  }

  private tool(call: Pick<ToolCall, "id" | "name" | "arguments">, cwd: string): ToolCard {
    let tool = this.tools.get(call.id);
    const args = JSON.stringify(call.arguments);
    if (!tool) {
      const component = new ToolExecutionComponent(clean(call.name), call.id, cleanData(call.arguments), { showImages: true }, {}, this.ui, cwd);
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
      const data = object(entry.data);
      if (entry.kind === "anima.routing-input") {
        this.addMessage(`${entry.id}:user`, () => new UserMessageComponent(clean(String(data.content ?? ""))));
      }
      if (entry.kind === "anima.routing-outcome") {
        if (data.status === "dispatched" && String(data.conversationId) !== state.id) {
          this.addMessage(`${entry.id}:route`, () => new Text(colors.muted(`→ ${clean(String(data.destination ?? "Subagent"))} · ${data.deliveryStatus === "queued" ? "queued" : "dispatched"}`), 1, 0));
        } else if (data.status === "failed" || data.status === "aborted") {
          this.addMessage(`${entry.id}:notice`, () => new Text(colors.yellow(`Input ${data.status}: ${clean(String(data.reason ?? ""))}`), 1, 0));
        }
      }
      if (entry.kind === "pi.compaction" || entry.kind === "pi.reset") {
        this.addMessage(`${entry.id}:context`, () => new Text(colors.muted(entry.kind === "pi.reset" ? "Context reset" : "Context compacted"), 1, 1));
        continue;
      }
      for (const [index, message] of (entry.model ?? []).entries()) {
        const key = `${entry.id}:${index}`;
        if (message.role === "user") {
          // Root already displays its routing receipt; its internal delivery is not a second user message.
          if (entry.kind === "anima.routed-message" && String(data.sourceConversationId) === state.id) continue;
          if (data.origin === "agent") {
            this.addMessage(key, () => {
              const group = new Container();
              group.addChild(new Text(colors.accent(entry.kind === "anima.agent-report"
                ? `Agent report${data.sourceName ? ` · ${clean(String(data.sourceName))}` : ""}` : "Delegated instruction"), 1, 0));
              group.addChild(new Markdown(clean(contentText(message.content)), 1, 1, getMarkdownTheme()));
              return group;
            });
          } else this.addMessage(key, () => new UserMessageComponent(clean(contentText(message.content))));
        } else if (message.role === "assistant") {
          this.addMessage(key, () => new AssistantMessageComponent(cleanData(message)));
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
        content: [{ type: "text", text: String(value.output ?? summary.error ?? (value.status === "done" ? "Completed · result returned to parent tool" : "Running…")) }],
        details: value.details, isError: summary.isError === true,
      }, value.status !== "done");
      addTool(tool, id);
    }
    if (!state.snapshot) this.addChild(line(colors.muted("Loading conversation…")));
    else if (!this.children.length) this.addChild(new Text(colors.muted("Write a message, or /help for commands."), 1, 1));
    if (live.run) {
      const retry = object(generation.retry);
      this.addChild(line(colors.yellow(retry.error ? `Retrying: ${clean(String(retry.error))}` : "● Working…  Escape to stop")));
    }
  }

  private addMessage(key: string, create: () => Component) {
    let message = this.messages.get(key);
    if (!message) { message = create(); this.messages.set(key, message); }
    this.addChild(message);
  }
}

/** Used by the tree adapter; reports remain visibly distinct from human messages. */
export function userText(entry: Entry): string | undefined {
  if (entry.kind === "anima.routing-input") return String(object(entry.data).content ?? "");
  const origin = object(entry.data).origin;
  if (origin === "agent" || entry.kind !== "pi.user" && origin !== "user") return;
  const message = entry.model?.find(message => message.role === "user");
  return message ? contentText(message.content) : undefined;
}
