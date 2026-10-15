# PROTOTYPE: a fixed address for the Inbox (portless)

Branch `proto/inbox-fixed-address`. Not for merge. Research: `.product/drafts/portless-local-url/` (BRIEF.md, one-click/README.md).

The flow under test: the Inbox shows a one-time dialog, "Give the Inbox a fixed address: inbox.plannotator.localhost", with Sure and Not now. Sure triggers the OS password prompt once. From then on the Inbox is at `https://inbox.plannotator.localhost`, and that address stays the same when the Inbox's port changes.

## Where the code is

| Piece | File |
|---|---|
| Name listener, request check, portless adapter, privileged command builders | `packages/server/inbox-name.ts` |
| Routes `GET/POST /api/inbox/name`, `POST /api/inbox/name/dialog`, control route `/api/inbox/control/name` | `packages/server/inbox.ts` |
| Hidden `plannotator inbox --name on\|off\|status` | `apps/hook/server/inbox-command.ts` |
| Dialog (third in the chain, after sound and agent note) and Settings → Devices row | `packages/inbox/components/FixedAddress.tsx`, `App.tsx`, `Settings.tsx` |
| Unit and route tests (scripted runner; nothing real runs) | `packages/server/inbox-name.test.ts` |

The prototype is inert unless the Inbox starts with `PLANNOTATOR_PROTO_FIXED_ADDRESS=1`. Without it, nothing looks up Node, opens a listener, spawns a process, or draws the row.

## On the owner's Mac

```sh
bash scripts/proto-fixed-address/try-on-this-mac.sh   # builds, starts a SCRATCH Inbox, opens it
# click Sure in the dialog; type your password ("osascript wants to make changes")
bash scripts/proto-fixed-address/checklist.sh         # verifies; asks you one y/n question
bash scripts/proto-fixed-address/undo.sh              # puts the Mac back (sudo asks for the password)
```

The scratch Inbox uses `$TMPDIR/plannotator-proto-fixed-address/data`. It never uses `~/.plannotator` or the real Inbox on port 59812. The try script refuses to run if portless was already set up on the Mac, because the undo removes portless completely.

## Windows and Linux

### CI (everything except the password prompt)

`gh workflow run 385915726 --ref proto/inbox-fixed-address` runs `ci-check.ts` on ubuntu-latest, windows-latest and macos-latest. The runners are already admin, so the privileged step runs as `sudo -n` (`PLANNOTATOR_PROTO_NAME_ELEVATE=sudo`) or directly in the elevated Windows session (`=direct`). The steps:

- Click Sure in headless Chromium.
- Verify the name over HTTPS against portless's CA.
- Check that a browser loads the name with certificate checks on.
- Move the Inbox to a new port and check that the name follows with no privileged step.
- Turn the address off.

Results go to the job summary. Screenshots are uploaded as artifacts.

### What still needs a person, and how to do it in a VM

| OS | Prompt that CI cannot click | What to check by hand |
|---|---|---|
| Windows 11 | UAC ("Do you want to allow this app to make changes?" for `node.exe`, "Publisher: Unknown" until signed); then Windows' own "Security Warning: install this certificate?" from `certutil -addstore -user Root` (CI confirmed it waits for a click; it timed out with no one to click) | Both prompts appear once. After Sure, Edge and Chrome open the name with no warning. A port change keeps the name. |
| Ubuntu desktop | The polkit dialog from `pkexec`. It names the binary path, not our reason. | The dialog appears. Chromium and Firefox trust the CA. Note: `update-ca-certificates` does not reach Chromium's NSS store, so the CI job adds the CA to NSS by hand. Expect a warning in Chrome on a stock Ubuntu until portless or we also write to `~/.pki/nssdb`. |

**Windows 11 ARM in UTM or Parallels on this Mac:**

1. Install Git for Windows, Bun (`powershell -c "irm bun.sh/install.ps1|iex"`) and Node 24 (nodejs.org MSI).
2. Clone the repo and check out `proto/inbox-fixed-address`.
3. Run `bun install`, then `bun run build:review && bun run build:hook`.
4. In a NON-elevated Git Bash, start the scratch Inbox:

   ```sh
   export PLANNOTATOR_DATA_DIR="$TEMP/pn-fixed" PLANNOTATOR_INBOX_CONNECT=0 PLANNOTATOR_INBOX_NOTES=0 PLANNOTATOR_PROTO_FIXED_ADDRESS=1
   bun apps/hook/server/index.ts inbox --background
   ```

5. Open the printed URL and click Sure. Accept UAC, and the certificate warning if one appears.
6. Run `bun scripts/proto-fixed-address/browser-check.ts <serverSession>`.
7. Test a port change: stop the Inbox, hold its old port, and start it again. `ci-check.ts` step 5 shows how.
8. Undo, in an elevated shell: `node "$PLANNOTATOR_DATA_DIR/portless/node_modules/portless/dist/cli.js" clean`.

**Ubuntu 24.04 desktop VM:** follow the same steps, then click Sure and authenticate in the polkit dialog. Undo with `sudo env HOME=$HOME PORTLESS_STATE_DIR=$HOME/.portless node <cli.js> clean`.

## Open risks (what this prototype exists to find out)

- **Tailscale on 443.** On this Mac, the Tailscale app holds `*:443` for serve. portless binds `127.0.0.1:443` and `::1:443`. Checklist step 6 checks that both still work.
- **CA trust from a root shell on macOS.** It may ask a second time, or fail with no prompt. Then `os_trust` is false and browsers warn. Checklist step 3 checks this.
- **The service plist points at a Node path.** The Inbox uses the real path of the Node it found. If that Node version is uninstalled (fnm, nvm), the proxy stops at the next boot.
- **Linux trust.** Chromium and Firefox need NSS; portless only updates the system store.
- **portless is pre-1.0.** We pin 0.15.8 and install it with npm from the registry at click time, which needs network.

## What CI found (runs on this branch, 2026-10-15)

- **Linux (ubuntu-latest): the flow works.** That covers Sure, `service install` through `sudo -n`, the alias, HTTPS verification, a port change that keeps the name with no privileged step, and off. Chromium does not trust the CA until it is added to NSS (`~/.pki/nssdb`), because portless only runs `update-ca-certificates`.
- **macOS (macos-latest): the flow works through Sure.** OS trust passed (`security verify-cert`, after `service install` as root), and the tab moved itself to the name. Two problems showed up and are fixed. First, the proxy took longer than 15 s to come up after `launchctl`, and plain HTTP on portless's TLS port gets a 302 to https, so the proxy check must not follow redirects. Second, a start-time race: the window's GET and the start-up Node lookup ran at once, and the window read "no Node". A test now covers the race.
- **Windows (windows-latest): routing works,** and a port change keeps the name. The name resolves with no hosts edit. Trusting the CA (`certutil -addstore -user Root`) shows Windows' own Security Warning dialog, which waits for a click. A person gets a second prompt after UAC. CI adds the CA to the machine store instead.
- **Playwright under Bun on Windows never launches Chromium,** so CI drives the browser with Node.
