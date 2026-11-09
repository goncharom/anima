import { parseArgs } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { App } from "./app.ts";
import { colors, initKeys } from "./ui.ts";

const { values } = parseArgs({
  args: process.argv.slice(2).filter(arg => arg !== "--"),
  options: { server: { type: "string" }, help: { type: "boolean", short: "h" } },
});

if (values.help) {
  console.log("Usage: pnpm tui [--server http://127.0.0.1:4242]\nConnects to an already-running Anima server. /help lists commands.");
} else if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("Anima TUI needs an interactive terminal. Start the server separately with pnpm start.");
  process.exitCode = 1;
} else {
  initTheme("dark", false);
  initKeys();
  const url = values.server ?? process.env.ANIMA_SERVER_URL ?? "http://127.0.0.1:4242";
  const tui = new TuiAltScreen(new ProcessTerminal(), false, undefined, {
    mouse: true, scrollToEndIndicator: () => colors.accent("↓ Follow output"),
  });
  const app = new App(tui, url);
  const stop = () => { void app.stop().catch(error => { console.error(error); process.exitCode = 1; }); };
  app.onExit = stop;
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await app.start();
  } catch (error) {
    const canceled = app.remote.lifetime.signal.aborted;
    await app.stop();
    if (!canceled) {
      console.error(`Cannot connect to ${url}: ${error instanceof Error ? error.message : error}\nStart the server separately with pnpm start.`);
      process.exitCode = 1;
    }
  }
}
