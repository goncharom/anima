import {
  Container, getKeybindings, HStack, MouseRegion, ScrollView, truncateToWidth, VStack,
  type Component, type Focusable, type TuiMouseEvent, type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { ConversationInfo } from "@anima/protocol-ts";
import { button, clean, colors, line } from "./ui.ts";

/** Shared shell for the human sidebar and list/chat worker panel. */
export class SidePanel extends VStack {
  private body = new VStack();
  private content?: Component;
  constructor(title: () => string, openList: () => void, collapse: () => void) {
    super();
    this.addChild(new HStack([
      { component: button(() => colors.accent(title()), openList), basis: 0, grow: 1 },
      { component: button(() => colors.muted(" × "), collapse), basis: 3, shrink: 0 },
    ]), { basis: 1, shrink: 0 });
    this.addChild(this.body, { basis: 0, grow: 1, minSize: 1 });
  }
  setBody(component: Component) {
    if (component === this.content) return;
    this.content = component;
    this.body.clear();
    this.body.addChild(component, { basis: 0, grow: 1, minSize: 1 });
  }
}

/** Both sidebars use the same keyboard/mouse conversation rows and scroll behavior. */
export class ConversationList extends ScrollView implements Focusable {
  focused = false;
  private rows: Container;
  private items: ConversationInfo[] = [];
  private cursor = "";
  private selected = "";
  private busy = new Set<string>();
  private connected = false;
  private select: (id: string) => void;
  private empty: string;
  private showTaskTitle: boolean;
  constructor(select: (id: string) => void, empty: string, showTaskTitle = false) {
    const rows = new Container();
    super(rows, { overscroll: "contain" });
    this.rows = rows;
    this.select = select;
    this.empty = empty;
    this.showTaskTitle = showTaskTitle;
    Object.defineProperty(this, "primary", { get: () => this.focused });
  }
  update(items: ConversationInfo[], selected: string, busy: Set<string>, connected: boolean) {
    this.items = [...items].sort((a, b) => a.name.localeCompare(b.name));
    if (selected !== this.selected || !this.items.some(item => item.conversationId === this.cursor)) {
      this.cursor = selected || this.items[0]?.conversationId || "";
    }
    this.selected = selected;
    this.busy = busy;
    this.connected = connected;
    this.rebuild();
  }
  override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void) {
    super.updateLayout(contentHeight, viewportHeight, requestRender);
    if (!this.showTaskTitle) return;
    const index = this.items.findIndex(item => item.conversationId === this.cursor);
    if (index < 0) return;
    const rowTop = index * 2;
    const rowBottom = rowTop + 2;
    const visibleHeight = Math.max(1, this.viewportHeight);
    if (visibleHeight < 2) this.scrollTo(rowTop);
    else if (rowTop < this.scrollTop) this.scrollTo(rowTop);
    else if (rowBottom > this.scrollTop + visibleHeight) this.scrollTo(rowBottom - visibleHeight);
  }
  private rebuild() {
    this.rows.clear();
    for (const info of this.items) {
      const id = info.conversationId;
      const label = () => {
        const dot = !this.connected ? colors.muted("○") : this.busy.has(id) ? colors.yellow("●") : colors.green("●");
        const highlighted = this.focused ? id === this.cursor : id === this.selected;
        return `${highlighted ? colors.accent("›") : " "} ${dot} ${highlighted ? colors.accent(clean(info.name)) : clean(info.name)}`;
      };
      const select = () => { this.cursor = id; this.select(id); };
      if (!this.showTaskTitle) this.rows.addChild(button(label, select));
      else {
        const row: Component = {
          render: width => [
            truncateToWidth(label(), width),
            truncateToWidth(colors.muted(`    ${clean(info.taskTitle ?? "")}`), width),
          ],
          invalidate() {},
        };
        this.rows.addChild(new MouseRegion(row, event => {
          if (event.type !== "click" || event.button !== "left") return;
          select();
          return { handled: true };
        }));
      }
    }
    if (!this.items.length) this.rows.addChild(line(colors.muted(this.empty)));
  }
  handleInput(data: string) {
    const kb = getKeybindings();
    const index = Math.max(0, this.items.findIndex(item => item.conversationId === this.cursor));
    let next = index;
    if (kb.matches(data, "tui.select.up")) next = Math.max(0, index - 1);
    else if (kb.matches(data, "tui.select.down")) next = Math.min(this.items.length - 1, index + 1);
    else if (kb.matches(data, "tui.select.confirm")) { if (this.cursor) this.select(this.cursor); return; }
    else return;
    this.cursor = this.items[next]?.conversationId ?? "";
    const rowHeight = this.showTaskTitle ? 2 : 1;
    const rowTop = next * rowHeight;
    const rowBottom = rowTop + rowHeight;
    const viewportHeight = Math.max(1, this.viewportHeight);
    if (rowHeight > viewportHeight) this.scrollTo(rowTop);
    else if (rowTop < this.scrollTop) this.scrollTo(rowTop);
    else if (rowBottom > this.scrollTop + viewportHeight) this.scrollTo(rowBottom - viewportHeight);
    this.rebuild();
  }
}

/** Captures only divider drags; transcript selection and editor focus stay untouched. */
export class ResizeDivider implements Component {
  private start?: { x: number; width: number };
  private rows: () => number;
  private width: () => number;
  private resize: (width: number) => void;
  private sign: number;
  constructor(rows: () => number, width: () => number, resize: (width: number) => void, side: "left" | "right") {
    this.rows = rows;
    this.width = width;
    this.resize = resize;
    this.sign = side === "left" ? 1 : -1;
  }
  render(width: number) { return Array(this.rows()).fill(width ? colors.muted("│") : ""); }
  invalidate() {}
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "press" && event.button === "left") {
      this.start = { x: event.screenX, width: this.width() };
      return { handled: true, capture: true };
    }
    if (event.type === "drag" && this.start) {
      this.resize(this.start.width + this.sign * (event.screenX - this.start.x));
      return { handled: true };
    }
    if (event.type === "release") { this.start = undefined; return { handled: true }; }
    return undefined;
  }
}

/** Layout entries retain their components while widths adapt to each viewport frame. */
export class Workspace extends HStack {
  leftOpen = true;
  rightOpen = false;
  leftWidth = 27;
  rightWidth = 48;
  private leftVisible = false;
  private mainVisible = true;
  private rightVisible = false;
  private drawer = false;
  private changed: () => void;

  constructor(left: Component, main: Component, right: Component, rows: () => number, changed: () => void) {
    super();
    this.changed = changed;
    const resize = (side: "left" | "right", width: number) => { this.setWidth(side, width); changed(); };
    const leftDivider = new ResizeDivider(rows, () => this.entries[0].basis as number, width => resize("left", width), "left");
    const rightDivider = new ResizeDivider(rows, () => this.entries[4].basis as number, width => resize("right", width), "right");
    this.addChild(left, { basis: this.leftWidth, shrink: 0, visible: ({ width }) => { this.size(width); return this.leftVisible; } });
    this.addChild(leftDivider, { basis: 1, shrink: 0, visible: () => this.leftVisible });
    this.addChild(main, { basis: 0, grow: 1, minSize: 1, visible: () => this.mainVisible });
    this.addChild(rightDivider, { basis: 1, shrink: 0, visible: () => this.rightVisible && this.mainVisible });
    this.addChild(right, { basis: this.rightWidth, grow: 0, shrink: 0, visible: () => this.rightVisible });
  }
  setWidth(side: "left" | "right", width: number) {
    if (side === "left") this.leftWidth = Math.max(20, Math.floor(width));
    else this.rightWidth = Math.max(32, Math.floor(width));
  }
  isDrawer(width: number) { return this.rightOpen && width < 88; }
  private size(width: number) {
    this.rightVisible = this.rightOpen;
    const drawer = this.isDrawer(width);
    if (drawer !== this.drawer) {
      this.drawer = drawer;
      queueMicrotask(this.changed);
    }
    this.mainVisible = !drawer;
    const right = this.rightOpen ? this.mainVisible ? Math.min(this.rightWidth, Math.max(32, width - 49)) : width : 0;
    const remaining = width - right - (this.rightOpen && this.mainVisible ? 1 : 0);
    this.leftVisible = this.leftOpen && this.mainVisible && remaining >= 72;
    this.entries[0].basis = Math.min(this.leftWidth, Math.max(20, remaining - 49));
    this.entries[4].basis = right;
  }
}
