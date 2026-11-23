# Anima for macOS

A native SwiftUI workspace for the Anima harness. It uses the shared `AnimaProtocol` Swift package; the server still owns execution, conversation history, models, and files.

## Run

1. Open [`Anima.xcodeproj`](Anima.xcodeproj) with Xcode 26 or later (Swift 6.2+) and run the **Anima** scheme. The app targets macOS 15 or later.
2. Click the gear icon or open **Anima → Settings…** (`⌘,`). Enter the hostname/IP and port, select HTTPS if the endpoint uses it, and click **Connect**. The app remembers the endpoint and reconnects when reopened. It never starts or stops the server.
3. Create or select a conversation. Folder browsing uses the **server's** filesystem.

The default address is `127.0.0.1:4242`. For a local server, run `pnpm start` from the repo root. The stock server listens on loopback and has no client authentication. Keep it off untrusted networks. For a server running on another machine, you can forward its loopback port:

```sh
ssh -N -L 127.0.0.1:4242:127.0.0.1:4242 user@anima-host
```

Then connect the app to `127.0.0.1:4242` with HTTPS off. For a directly reachable HTTPS endpoint, use a trusted certificate and enforce access at the proxy or network layer.

## Build a DMG with GitHub Actions

The **Build macOS DMG** workflow (`.github/workflows/macos-dmg.yml`) builds a Release app for both Apple Silicon and Intel using the macOS 26 runner's Xcode toolchain, then packages it into a compressed DMG with an Applications shortcut. The app still requires macOS 15 or later.

- **Automatic build:** push to `master` with changes under `app/macos/`, `packages/protocol-swift/`, or to `.github/workflows/macos-dmg.yml`. Other branches and tag pushes do not trigger builds.
- **Download:** open the completed workflow run and download the **Anima-macos-universal** artifact. Unzip it to get `Anima-macos-universal.dmg`, open the DMG, and drag Anima into Applications. Artifacts are retained for 30 days; the workflow does not create a GitHub Release.

No Apple credentials are required: the app is ad-hoc signed, **not Developer ID signed or notarized**. Gatekeeper may block downloaded builds on other Macs; this workflow is intended for development/internal distribution. Public distribution without those warnings requires an Apple Developer ID certificate and Apple's notarization service. The DMG contains only the client; run the server separately as described above.

## Workspace

- **Conversations** on the left and **Subagents** on the right. Select a subagent to open its own transcript and composer. Drag the dividers to resize, or use `/resize left|right columns`. On narrow windows, the agents panel opens as a drawer. Transitions respect macOS Reduce Motion.
- **Transcript** streams messages, thinking, tool calls/results and progress. Drag across paragraphs or code within a response and press `⌘C` to copy. Each expandable tool has its own text selection. Use **Load older messages** to page back and **↓ Latest** to resume following. Search operates on loaded history.
- **Comment on replies:** Select text in a model reply, right-click the selection, and choose **Add Comment…**. Write your note and click **Add to Draft**. Repeat on any passage in the conversation to add more numbered comments to the same editable follow-up. Nothing is sent automatically.
- **Composer** supports steering, follow-ups, draft recall, slash completion, and the same slash commands as the TUI. Use `/help` or the command palette. The conversation menu exposes rename, archive, folder changes, model selection, queue editing/withdrawal, compaction and stop controls. The footer shows current model, thinking level and approximate context use.
- Archiving, closing the app, or changing endpoints does not stop server work. Use **Stop** for the selected conversation.

| Key | Action |
| --- | --- |
| `⌘N` / `⌘K` | New / switch conversation |
| `F2` / `F3` / `F6` | Conversations / subagents / cycle pane focus |
| `↩` / `⇧↩` / `⌥↩` | Send or steer / newline / queue follow-up |
| `Esc` / `⌘.` | Stop work (`Esc` first dismisses search or completion) |
| `⌥↑` | Withdraw queued messages to the draft |
| `⌃L` / `⇧Tab` | Choose a model / cycle thinking level |
| `⌃T` / `⌃O` | Toggle thinking blocks / all tool details |
| `⌘F` / `⇧⌘P` | Find in transcript / command palette |
| `Page Up` / `Page Down` | Scroll transcript |
| `⌃↑` / `⌃↓` | Jump to the previous / next prompt |

[Iosevka Extended 33.2.9](https://github.com/be5invis/Iosevka/releases/tag/v33.2.9) is bundled under the [SIL Open Font License](Anima/Resources/Iosevka-LICENSE.txt).
