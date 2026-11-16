import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import {
  getTerminalColorMode, indexedColor, KeybindingsManager, MouseRegion, setKeybindings,
  stripTerminalSequences, styleText, TUI_KEYBINDINGS, truncateToWidth,
  type Component, type EditorTheme, type KeybindingDefinitions,
} from "@earendil-works/pi-tui";

export const windowsKeys = process.platform === "win32"
  || process.platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);

/** Pi's public components consult pi-tui's key registry; no local AgentSession is needed. */
export function initKeys() {
  const keys: KeybindingDefinitions = {
    ...TUI_KEYBINDINGS,
    "app.interrupt": { defaultKeys: "escape" },
    "app.clear": { defaultKeys: "ctrl+c" },
    "app.exit": { defaultKeys: "ctrl+d" },
    "app.model.select": { defaultKeys: "ctrl+l" },
    "app.thinking.cycle": { defaultKeys: "shift+tab" },
    "app.thinking.toggle": { defaultKeys: "ctrl+t" },
    "app.tools.expand": { defaultKeys: "ctrl+o" },
    "app.message.followUp": { defaultKeys: windowsKeys ? "ctrl+q" : "alt+enter" },
    "app.message.dequeue": { defaultKeys: windowsKeys ? "alt+q" : "alt+up" },
  };
  setKeybindings(new KeybindingsManager(keys));
}

export const colors = {
  accent: (text: string) => styleText(text, { fg: indexedColor(6) }, getTerminalColorMode()),
  muted: (text: string) => styleText(text, { fg: indexedColor(8) }, getTerminalColorMode()),
  green: (text: string) => styleText(text, { fg: indexedColor(2) }, getTerminalColorMode()),
  yellow: (text: string) => styleText(text, { fg: indexedColor(3) }, getTerminalColorMode()),
  error: (text: string) => styleText(text, { fg: indexedColor(1) }, getTerminalColorMode()),
};

export function editorTheme(): EditorTheme {
  return { borderColor: colors.accent, selectList: getSelectListTheme() };
}

/** Strip terminal commands from remote data, not from the renderer's own styling. */
export function clean(text: string): string {
  return stripTerminalSequences(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

export function cleanData<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "string" ? clean(item) : item)) as T;
}

export function line(text: string | (() => string)): Component {
  return {
    render: width => [truncateToWidth((typeof text === "string" ? text : text()).replace(/[\r\n\t]/g, " "), width)],
    invalidate() {},
  };
}

export function button(label: string | (() => string), click: () => void): MouseRegion {
  return new MouseRegion(line(label), event => {
    if (event.type !== "click" || event.button !== "left") return;
    click();
    return { handled: true };
  });
}
