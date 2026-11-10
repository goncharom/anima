/*
 * Adapted from my-pi/packages/extensions/pi-go/src/ui.ts.
 * MIT License — Copyright (c) 2026 Gonzalo
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import {
  Input, getTerminalColorMode, indexedColor, matchesKey, styleText, truncateToWidth, visibleWidth,
  type Component, type Focusable, type TUI, type TuiMouseEvent, type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { RemoteClient } from "./client.ts";
import { clean, colors } from "./ui.ts";

type Directory = { name: string; path: string };

function panel(lines: string[], width: number): string[] {
  if (width < 4) return lines.map(text => truncateToWidth(text, Math.max(0, width), ""));
  const innerWidth = width - 4;
  const horizontal = "─".repeat(width - 2);
  return [
    colors.accent(`╭${horizontal}╮`),
    ...lines.map(text => {
      const clipped = truncateToWidth(text, innerWidth, "…");
      return `${colors.accent("│")} ${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))} ${colors.accent("│")}`;
    }),
    colors.accent(`╰${horizontal}╯`),
  ];
}

/** pi-go's folder-only navigation, backed exclusively by the server filesystem. */
export class DirectoryNavigator implements Component, Focusable {
  private remote: RemoteClient;
  private ui: TUI;
  private done: (path?: string) => void;
  private filter = new Input({ prompt: "filter: " });
  private path: string;
  private parent?: string;
  private directories: Directory[] = [];
  private selected = 0;
  private valid = false;
  private loading = false;
  private error = "";
  private request?: AbortController;
  private disposed = false;
  private renderedEntries = new Map<number, Directory | null>();

  get focused() { return this.filter.focused; }
  set focused(value: boolean) { this.filter.focused = value; }

  constructor(remote: RemoteClient, ui: TUI, initialPath: string, done: (path?: string) => void) {
    this.remote = remote;
    this.ui = ui;
    this.path = initialPath;
    this.done = done;
    void this.moveTo(initialPath);
  }

  private entries(): (Directory | null)[] {
    const query = this.filter.getValue().toLocaleLowerCase();
    return [null, ...this.directories.filter(entry => entry.name.toLocaleLowerCase().includes(query))];
  }

  private async moveTo(path: string, parent?: string) {
    this.request?.abort();
    const request = this.request = new AbortController();
    const signal = AbortSignal.any([request.signal, this.remote.lifetime.signal]);
    this.path = path;
    this.parent = parent;
    this.directories = [];
    this.filter.setValue("");
    this.selected = 0;
    this.valid = false;
    this.loading = true;
    this.error = "";
    this.ui.requestRender();
    try {
      const known = new Map<string, Directory>();
      let offset: number | undefined;
      do {
        const page = await this.remote.rpc.listDirectories({ path, offset }, { signal });
        if (signal.aborted || this.disposed) return;
        const selected = this.entries()[this.selected];
        this.path = page.path;
        this.parent = page.parent;
        this.valid = true;
        for (const directory of page.directories) known.set(directory.path, directory);
        this.directories = [...known.values()].sort((a, b) => a.name.localeCompare(b.name));
        this.selected = selected ? Math.max(0, this.entries().findIndex(entry => entry?.path === selected.path)) : 0;
        path = page.path;
        offset = page.nextOffset;
        this.ui.requestRender();
      } while (offset !== undefined);
    } catch (error) {
      if (!signal.aborted && !this.disposed) this.error = clean(error instanceof Error ? error.message : String(error));
    } finally {
      if (!signal.aborted && !this.disposed) {
        this.loading = false;
        this.ui.requestRender();
      }
    }
  }

  private open(entry: Directory | null) {
    if (this.disposed) return;
    if (entry) void this.moveTo(entry.path, this.path);
    else if (this.valid) this.done(this.path);
    else if (!this.loading) void this.moveTo(this.path, this.parent);
  }

  handleInput(data: string) {
    if (matchesKey(data, "up")) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, "down")) this.selected = Math.min(this.entries().length - 1, this.selected + 1);
    else if (matchesKey(data, "enter")) {
      const entry = this.entries()[this.selected];
      if (entry !== undefined) this.open(entry);
      return;
    } else if (matchesKey(data, "left") || matchesKey(data, "backspace") && !this.filter.getValue()) {
      if (this.parent && this.parent !== this.path) void this.moveTo(this.parent);
      return;
    } else if (matchesKey(data, "escape")) {
      if (!this.filter.getValue()) { this.done(); return; }
      this.filter.setValue("");
      this.selected = 0;
    } else if (matchesKey(data, "ctrl+c")) {
      this.done();
      return;
    } else {
      const previous = this.filter.getValue();
      this.filter.handleInput(data);
      if (previous !== this.filter.getValue()) this.selected = 0;
    }
    this.ui.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "wheel" && event.wheelDelta) {
      this.selected = Math.max(0, Math.min(this.entries().length - 1, this.selected + Math.sign(event.wheelDelta)));
      return { handled: true, render: true };
    }
    if (event.x < 2 || event.x >= event.width - 2) return;
    if (event.y === 3) return this.filter.handleMouse({ ...event, x: event.x - 2, y: 0, width: event.width - 4, height: 1 });
    if (event.type !== "click" || event.button !== "left") return;
    if (!this.renderedEntries.has(event.y)) return;
    this.open(this.renderedEntries.get(event.y)!);
    return { handled: true };
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 4);
    const entries = this.entries();
    this.selected = Math.max(0, Math.min(this.selected, entries.length - 1));
    const limit = Math.max(1, Math.min(16, Math.floor(this.ui.terminal.rows * 0.82) - 6));
    const start = Math.max(0, Math.min(this.selected - Math.floor(limit / 2), entries.length - limit));
    const lines = [
      colors.accent("GO TO DIRECTORY"),
      colors.muted(clean(this.path).replace(/[\n\t]/g, " ")),
      ...this.filter.render(innerWidth),
    ];
    this.renderedEntries.clear();
    for (let index = start; index < Math.min(start + limit, entries.length); index++) {
      const entry = entries[index];
      const text = entry === null
        ? `${colors.green("📍")} Use this directory`
        : `${colors.accent("📁")} ${clean(entry.name).replace(/[\n\t]/g, " ")}/`;
      const clipped = truncateToWidth(`  ${text}`, innerWidth, "…");
      const row = clipped + " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
      this.renderedEntries.set(lines.length + 1, entry);
      lines.push(index === this.selected ? styleText(row, { bg: indexedColor(8) }, getTerminalColorMode()) : row);
    }
    lines.push(this.error ? colors.error(this.error.replace(/[\n\t]/g, " "))
      : colors.muted(this.loading ? "Loading…" : `${entries.length - 1} / ${this.directories.length} folders`));
    return panel(lines, width);
  }

  invalidate() { this.filter.invalidate(); }

  dispose() {
    this.disposed = true;
    this.request?.abort();
  }
}
