import { BusyBehavior } from "@anima/protocol-ts";
import {
  copyToClipboard, DynamicBorder, getSelectListTheme, TreeSelectorComponent, type SessionTreeNode,
} from "@earendil-works/pi-coding-agent";
import {
  CancellableLoader, Container, Editor, fuzzyFilter, getKeybindings, Input, isFocusable, matchesKey,
  SelectList, type Component, type Focusable, type OverlayHandle, type SelectItem, type TUI,
} from "@earendil-works/pi-tui";
import { type QueuedInput, type RemoteClient } from "./client.ts";
import { button, clean, colors, editorTheme, line } from "./ui.ts";

class Pane extends Container implements Focusable {
  private body: Component;
  private cancel: () => void;
  private active = false;
  get focused() { return this.active; }
  set focused(value: boolean) {
    this.active = value;
    if (isFocusable(this.body)) this.body.focused = value;
  }
  constructor(title: string, body: Component, cancel: () => void, hint = "Escape to close") {
    super();
    this.body = body;
    this.cancel = cancel;
    this.addChild(new DynamicBorder(colors.accent));
    this.addChild(line(colors.accent(clean(title))));
    this.addChild(body);
    this.addChild(line(colors.muted(hint)));
    this.addChild(new DynamicBorder(colors.accent));
  }
  handleInput(data: string) {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.cancel();
    else this.body.handleInput?.(data);
  }
}

class Picker extends Container implements Focusable {
  private input = new Input({ placeholder: "Search…" });
  private list!: SelectList;
  private items: SelectItem[];
  private ui: TUI;
  private choose: (value: string) => void;
  private height = 0;
  get focused() { return this.input.focused; }
  set focused(value: boolean) { this.input.focused = value; }
  constructor(ui: TUI, items: SelectItem[], choose: (value: string) => void) {
    super();
    this.ui = ui;
    this.items = items;
    this.choose = choose;
    this.rebuild();
  }
  private rebuild() {
    const selected = this.list?.getSelectedItem()?.value;
    this.height = this.ui.terminal.rows;
    const visible = fuzzyFilter(this.items, this.input.getValue(), item => `${item.label} ${item.description ?? ""}`);
    this.list = new SelectList(visible, Math.max(1, Math.floor(this.height * 0.9) - 8), {
      ...getSelectListTheme(), noMatch: () => colors.muted("  No matches"),
    });
    if (selected) this.list.setSelectedIndex(Math.max(0, visible.findIndex(item => item.value === selected)));
    this.list.onSelect = item => this.choose(item.value);
    this.clear();
    this.addChild(this.input);
    this.addChild(this.list);
  }
  override render(width: number) {
    if (this.height !== this.ui.terminal.rows) this.rebuild();
    return super.render(width);
  }
  handleInput(data: string) {
    const kb = getKeybindings();
    if ((["tui.select.up", "tui.select.down", "tui.select.pageUp", "tui.select.pageDown", "tui.select.confirm"] as const)
      .some(action => kb.matches(data, action))) this.list.handleInput(data);
    else {
      const previous = this.input.getValue();
      this.input.handleInput(data);
      if (previous !== this.input.getValue()) this.rebuild();
    }
  }
}

type QueueChange = { content?: string; whenBusy?: BusyBehavior; remove?: boolean };
class QueueEditor extends Container implements Focusable {
  private editor: Editor;
  private mode: BusyBehavior;
  private ui: TUI;
  private saving = false;
  private error = "";
  private apply: (change: QueueChange) => Promise<void>;
  private done: () => void;
  get focused() { return this.editor.focused; }
  set focused(value: boolean) { this.editor.focused = value; }
  constructor(ui: TUI, item: QueuedInput, apply: (change: QueueChange) => Promise<void>, done: () => void) {
    super();
    this.ui = ui;
    this.apply = apply;
    this.done = done;
    this.mode = item.mode === "steer" ? BusyBehavior.STEER : BusyBehavior.QUEUE;
    this.editor = new Editor(ui, editorTheme(), { paddingX: 1 });
    this.editor.disableSubmit = true;
    this.editor.setText(clean(item.content));
    this.addChild(button(() => colors.accent(`Mode: ${this.mode === BusyBehavior.STEER ? "steering" : "follow-up"}  [Tab to change]`), () => this.toggle()));
    this.addChild(this.editor);
    this.addChild(button(() => "Save [Ctrl+S]", () => void this.save(false)));
    this.addChild(button(() => "Withdraw [Ctrl+D]", () => void this.save(true)));
    this.addChild(line(() => this.saving ? "Saving…" : colors.error(this.error)));
  }
  private toggle() {
    if (!this.saving) this.mode = this.mode === BusyBehavior.STEER ? BusyBehavior.QUEUE : BusyBehavior.STEER;
  }
  private async save(remove: boolean) {
    if (this.saving) return;
    this.saving = true;
    this.error = "";
    this.ui.requestRender();
    try {
      await this.apply(remove ? { remove: true } : { content: this.editor.getExpandedText(), whenBusy: this.mode });
      this.done();
    } catch (error) {
      this.error = clean(error instanceof Error ? error.message : String(error));
    } finally {
      this.saving = false;
      this.ui.requestRender();
    }
  }
  handleInput(data: string) {
    if (this.saving) return;
    if (matchesKey(data, "ctrl+s")) void this.save(false);
    else if (matchesKey(data, "ctrl+d")) void this.save(true);
    else if (matchesKey(data, "tab")) this.toggle();
    else if (matchesKey(data, "enter")) this.editor.insertTextAtCursor("\n");
    else this.editor.handleInput(data);
  }
}

/** One overlay interaction at a time. Selection changes and shutdown dispose it. */
export class Dialogs {
  private ui: TUI;
  private focusEditor: () => void;
  private error: (error: unknown) => void;
  private current?: () => void;
  constructor(ui: TUI, focusEditor: () => void, error: (error: unknown) => void) {
    this.ui = ui;
    this.focusEditor = focusEditor;
    this.error = error;
  }
  cancel() { this.current?.(); }
  private show<T>(build: (done: (value?: T) => void) => Component, dispose = () => {}) {
    this.cancel();
    return new Promise<T | undefined>(resolve => {
      let handle: OverlayHandle | undefined;
      let closed = false;
      const done = (value?: T) => {
        if (closed) return;
        closed = true;
        dispose();
        handle?.hide();
        this.current = undefined;
        this.focusEditor();
        resolve(value);
      };
      this.current = () => done();
      handle = this.ui.showOverlay(build(done), { anchor: "center", width: "90%", maxHeight: "90%", margin: 1 });
    });
  }
  choose(title: string, items: SelectItem[]) {
    return this.show<string>(done => new Pane(title, new Picker(this.ui, items.map(item => ({
      ...item, label: clean(item.label), description: item.description === undefined ? undefined : clean(item.description),
    })), done), () => done()));
  }
  ask(title: string, initial = "") {
    return this.show<string>(done => {
      const input = new Input();
      input.setValue(clean(initial).replace(/[\r\n\t]/g, " "));
      input.handleInput("\x05"); // Place the cursor after the initial value (Ctrl+E).
      input.onSubmit = value => { if (value.trim()) done(value); };
      return new Pane(title, input, () => done(), "Enter to save · Escape to cancel");
    });
  }
  async wait<T>(title: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    const controller = new AbortController();
    let loader: CancellableLoader | undefined;
    return this.show<T>(done => {
      loader = new CancellableLoader(this.ui, colors.accent, colors.muted, title);
      void operation(controller.signal).then(value => {
        if (!controller.signal.aborted) done(value);
      }, error => {
        if (!controller.signal.aborted) { this.error(error); done(); }
      });
      return new Pane(title, loader, () => done());
    }, () => { controller.abort(); loader?.stop(); });
  }
  async folder(remote: RemoteClient, initial: string): Promise<string | undefined> {
    let path = initial;
    let offset = 0;
    let known = new Map<string, { name: string; path: string }>();
    while (!remote.lifetime.signal.aborted) {
      const page = await this.wait("Loading server folders…", signal => remote.rpc.listDirectories({ path, offset }, { signal }));
      if (!page) return;
      path = page.path;
      for (const directory of page.directories) known.set(directory.path, directory);
      const items: SelectItem[] = [
        { value: "select", label: "✓ Use this folder", description: path },
        { value: "parent", label: ".. Parent folder", description: page.parent },
        { value: "path", label: "Enter a path…", description: "On the server; ~ is its home folder" },
        ...[...known.values()].map(directory => ({ value: `dir:${directory.path}`, label: `${directory.name}/` })),
        ...(page.nextOffset === undefined ? [] : [{ value: "more", label: "Load more folders…" }]),
      ];
      const choice = await this.choose(`Server folder · ${path}`, items);
      if (choice === undefined) return;
      if (choice === "select") return path;
      if (choice === "more") { offset = page.nextOffset!; continue; }
      if (choice === "path") {
        const typed = await this.ask("Server folder path", path);
        if (typed === undefined) continue;
        path = typed;
      } else path = choice === "parent" ? page.parent : choice.slice(4);
      offset = 0;
      known = new Map();
    }
  }
  editQueue(item: QueuedInput, apply: (change: QueueChange) => Promise<void>) {
    return this.show<boolean>(done => new Pane("Edit queued input", new QueueEditor(this.ui, item, apply, () => done(true)), () => done()));
  }
  tree(nodes: SessionTreeNode[], current: string) {
    return this.show<string>(done => {
      let selector: TreeSelectorComponent;
      let rows = 0;
      let focused = false;
      const rebuild = () => {
        const selected = selector?.getTreeList().getSelectedNode()?.entry.id;
        const query = selector?.getTreeList().getSearchQuery() ?? "";
        rows = this.ui.terminal.rows;
        selector = new TreeSelectorComponent(nodes, current, Math.max(10, (Math.floor(rows * 0.9) - 7) * 2),
          value => done(value), () => done(), undefined, selected, "default");
        selector.onCopy = text => { if (text) void copyToClipboard(text).catch(this.error); };
        selector.focused = focused;
        for (const char of query) selector.handleInput(char);
      };
      rebuild();
      return {
        get focused() { return focused; },
        set focused(value: boolean) { focused = value; selector.focused = value; },
        render: width => {
          if (rows !== this.ui.terminal.rows) rebuild();
          if (rows < 14) return line("Tree needs 14 terminal rows; resize or Escape.").render(width);
          // Reuse Pi's tree/list controls, with help that describes Durable forks rather than session mutation/labels.
          const list = selector.getTreeList();
          return [
            ...new DynamicBorder(colors.accent).render(width),
            ...line(colors.accent("History tree · conversation labels open; earlier entries fork")).render(width),
            ...line(colors.muted(`Search: ${clean(list.getSearchQuery())}`)).render(width),
            ...list.render(width),
            ...line(colors.muted("↑↓ move · ←→ page · Ctrl+←/→ branch · Ctrl+U users · Ctrl+L branches")).render(width),
            ...line(colors.muted("Enter open/fork · user inputs restore for editing · Ctrl+X copy · Escape close")).render(width),
            ...new DynamicBorder(colors.accent).render(width),
          ];
        },
        handleInput: data => {
          if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) done();
          else if (rows >= 14) selector.handleInput(data);
        },
        invalidate() { selector.invalidate(); },
      } satisfies Component & Focusable;
    });
  }
}
