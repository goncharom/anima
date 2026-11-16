import { setTimeout as delay } from "node:timers/promises";
import { HarnessService, type ConversationSnapshot, type GetEntriesResponse } from "@anima/protocol-ts";
import type { JsonObject } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import type { Message } from "@earendil-works/pi-ai";

// Presentation types for the raw Durable JSON on the wire. No server/runtime imports.
export type Entry = {
  id: number;
  conversationId: number;
  kind: string;
  model?: Message[];
  data?: unknown;
};
export type Graph = { tasks: Record<string, {
  id: number; kind: string; conversationId: number; owner?: number; background: boolean;
  state: { status: string; phase?: string }; abortRequested: boolean; blocked?: string;
}> };
export type QueuedInput = { id: string; content: string; mode: "steer" | "followUp" };
export type ConversationState = {
  id: string;
  snapshot?: ConversationSnapshot;
  entries: Map<number, Entry>;
  before?: string;
  loading: boolean;
  epoch: number;
};

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function entries(values: JsonObject[]): Entry[] {
  return values.filter(value => typeof value.id === "number" && typeof value.kind === "string") as unknown as Entry[];
}

export function queuedInputs(state: ConversationState): QueuedInput[] {
  const inbox = object(state.snapshot?.docs["pi.inbox"]);
  return (Array.isArray(inbox.items) ? inbox.items : []).flatMap(value => {
    const item = object(value);
    if ((item.mode !== "steer" && item.mode !== "followUp") || typeof item.content !== "string") return [];
    if (item.entry && object(object(item.entry).data).origin !== "user") return [];
    return [{ id: String(item.id), content: item.content, mode: item.mode }];
  });
}

export class RemoteClient {
  readonly rpc;
  readonly lifetime = new AbortController();
  readonly conversations = new Map<string, ConversationState>();
  private jobs = new Set<Promise<void>>();
  onChange: (state: ConversationState) => void = () => {};

  constructor(url: string) {
    this.rpc = createClient(HarnessService, createConnectTransport({ baseUrl: url, httpVersion: "1.1" }));
  }

  state(id: string): ConversationState {
    let state = this.conversations.get(id);
    if (!state) {
      state = { id, entries: new Map(), loading: false, epoch: 0 };
      this.conversations.set(id, state);
    }
    return state;
  }

  /** Retry only reads. Writes are explicit, idempotent submissions or compare-and-set edits. */
  watch<T>(
    open: (signal: AbortSignal) => AsyncIterable<T>,
    receive: (value: T, signal: AbortSignal) => void | Promise<void>,
    connected: (ready: boolean, error?: unknown) => void,
  ): () => void {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
    const job = (async () => {
      let backoff = 500;
      while (!signal.aborted) {
        try {
          for await (const value of open(signal)) {
            if (signal.aborted) break;
            connected(true);
            backoff = 500;
            await receive(value, signal);
          }
          if (!signal.aborted) throw new Error("Server stream ended");
        } catch (error) {
          if (signal.aborted) break;
          connected(false, error);
          await delay(backoff, undefined, { signal }).catch(() => {});
          backoff = Math.min(backoff * 2, 5_000);
        }
      }
    })().finally(() => this.jobs.delete(job));
    this.jobs.add(job);
    return () => controller.abort();
  }

  follow(id: string, connected: (ready: boolean, error?: unknown) => void) {
    return this.watch(
      signal => this.rpc.watchConversation({ conversationId: id }, { signal }),
      async (value, signal) => {
        if (value.snapshot) await this.acceptSnapshot(id, value.snapshot, signal);
      },
      connected,
    );
  }

  private async acceptSnapshot(id: string, snapshot: ConversationSnapshot, signal: AbortSignal) {
    const state = this.state(id);
    const incoming = entries(snapshot.entries);
    const newest = incoming.at(-1)?.id ?? 0;
    let previous = 0;
    for (const id of state.entries.keys()) previous = Math.max(previous, id);
    const reset = previous > newest || incoming.some(entry => {
      const old = state.entries.get(entry.id);
      return old && JSON.stringify(old) !== JSON.stringify(entry);
    });
    const first = !state.snapshot || reset;
    if (reset) {
      state.entries.clear();
      state.epoch++;
    }
    if (first) state.before = snapshot.beforeEntryId === undefined ? undefined : String(incoming[0]?.id);
    state.snapshot = snapshot;
    for (const entry of incoming) state.entries.set(entry.id, entry);
    this.onChange(state);
    // A reconnect or coalesced snapshot can skip more than its bounded history window.
    if (!first && previous && newest > previous && !incoming.some(entry => entry.id === previous)) {
      let before: string | undefined = String(incoming[0].id);
      do {
        const page = await this.rpc.getEntries({ conversationId: id, beforeEntryId: before, limit: 200 }, { signal });
        if (signal.aborted) return;
        const values = this.mergeOlder(state, page);
        this.onChange(state);
        if (values.some(entry => entry.id <= previous)) break;
        before = page.nextBeforeEntryId;
      } while (before !== undefined);
    }
  }

  async older(id: string) {
    const state = this.state(id);
    if (!state.before || state.loading) return;
    state.loading = true;
    this.onChange(state);
    try {
      const page = await this.rpc.getEntries({ conversationId: id, beforeEntryId: state.before, limit: 100 }, { signal: this.lifetime.signal });
      this.mergeOlder(state, page);
    } finally {
      state.loading = false;
      this.onChange(state);
    }
  }

  private mergeOlder(state: ConversationState, page: GetEntriesResponse) {
    const values = entries(page.entries);
    let oldest = Infinity;
    for (const id of state.entries.keys()) oldest = Math.min(oldest, id);
    for (const entry of values) state.entries.set(entry.id, entry);
    // Gap repair and explicit paging can overlap. Never move the oldest cursor forward.
    if (!values.length || values[0].id <= oldest) state.before = page.nextBeforeEntryId;
    return values;
  }

  async close() {
    this.lifetime.abort();
    await Promise.all(this.jobs);
  }
}
