import { BusyBehavior } from "@anima/protocol-ts";
import { DynamicBorder, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import {
  CancellableLoader, Container, Editor, fuzzyFilter, getKeybindings, Input, isFocusable, isKeyRelease, isKeyRepeat, matchesKey,
  SelectList, Text, type Component, type Focusable, type OverlayHandle, type OverlayOptions, type SelectItem, type TUI,
} from "@earendil-works/pi-tui";
import { type QueuedInput, type RemoteClient } from "./client.ts";
import { button, clean, colors, editorTheme, line } from "./ui.ts";
import { DirectoryNavigator } from "./directory-navigator.ts";

class Pane extends Container implements Focusable {
  private body: Component;
  private cancel: () => void;
  private active = false;
  get focused() { return this.active; }
  set focused(value: boolean) {
    this.active = value;
    if (isFocusable(this.body)) this.body.focused = value;
  }
  constructor(title: string, body: Component, cancel: () => void) {
    super();
    this.body = body;
    this.cancel = cancel;
    this.addChild(new DynamicBorder(colors.accent));
    this.addChild(line(colors.accent(clean(title))));
    this.addChild(body);
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
    this.list = new SelectList(visible, Math.max(1, Math.floor(this.height * 0.9) - 7), {
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
    this.addChild(button(() => colors.accent(`Mode: ${this.mode === BusyBehavior.STEER ? "steering" : "follow-up"}`), () => this.toggle()));
    this.addChild(this.editor);
    this.addChild(button(() => "Save", () => void this.save(false)));
    this.addChild(button(() => "Withdraw", () => void this.save(true)));
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
  private show<T>(build: (done: (value?: T) => void) => Component, dispose = () => {}, options: OverlayOptions = {}) {
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
      handle = this.ui.showOverlay(build(done), { anchor: "center", width: "90%", maxHeight: "90%", margin: 1, ...options });
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
      return new Pane(title, input, () => done());
    });
  }
  reviewCron(detail: string) {
    return this.show<"back" | "delete">(done => {
      const input = new Container();
      const text = new Text(clean(detail), 0, 0);
      let offset = 0, maxOffset = 0, pageSize = 1;
      input.addChild({
        render: width => {
          const lines = text.render(width);
          pageSize = Math.max(1, Math.floor(this.ui.terminal.rows * 0.9) - 6);
          maxOffset = Math.max(0, lines.length - pageSize);
          offset = Math.min(maxOffset, offset);
          return lines.slice(offset, offset + pageSize);
        },
        invalidate: () => text.invalidate(),
      });
      input.addChild(line(() => colors.muted(maxOffset > 0 ? "↑/↓ or PgUp/PgDn to scroll · Esc to go back" : "Esc to go back")));
      input.addChild(button(() => colors.error("D  Delete job…"), () => done("delete")));
      const handleInput = (data: string) => {
        if (isKeyRelease(data)) return;
        const scroll = matchesKey(data, "down") ? 1 : matchesKey(data, "up") ? -1
          : matchesKey(data, "pageDown") ? pageSize : matchesKey(data, "pageUp") ? -pageSize : 0;
        if (scroll) {
          offset = Math.min(maxOffset, Math.max(0, offset + scroll));
          this.ui.requestRender();
        } else if (!isKeyRepeat(data) && matchesKey(data, "d")) done("delete");
      };
      return new Pane("Cron job", Object.assign(input, { handleInput }), () => done("back"));
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
  folder(remote: RemoteClient, initial: string): Promise<string | undefined> {
    let navigator: DirectoryNavigator | undefined;
    return this.show<string>(done => {
      navigator = new DirectoryNavigator(remote, this.ui, initial, done);
      return navigator;
    }, () => navigator?.dispose(), { width: "72%", minWidth: 54, maxHeight: "82%" });
  }
  editQueue(item: QueuedInput, apply: (change: QueueChange) => Promise<void>) {
    return this.show<boolean>(done => new Pane("Edit queued input", new QueueEditor(this.ui, item, apply, () => done(true)), () => done()));
  }
}
