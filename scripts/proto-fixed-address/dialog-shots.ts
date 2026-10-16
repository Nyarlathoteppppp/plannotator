/**
 * PROTOTYPE (proto/inbox-fixed-address): screenshots of the BUILT fixed-address
 * dialog in every state, light and dark, desktop and phone, next to the
 * approved mock's (.product/approved/inbox-fixed-address-dialog/).
 *
 *   bun scripts/proto-fixed-address/dialog-shots.ts <out dir>
 *
 * Nothing privileged ever runs: a SCRATCH Inbox starts with the prototype OFF
 * (temp data dir, no browser, no agents, no tailnet), and the page's
 * `/api/inbox/name*` requests are answered by this script (Playwright routes)
 * with the states the server reports, step by step. The tab's move to the
 * name is aborted, so the done state stays on screen. The Inbox is stopped
 * through its own token-guarded stop route at the end.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "@playwright/test";

const out = resolve(process.argv[2] ?? "dialog-shots");
mkdirSync(out, { recursive: true });
const repo = resolve(import.meta.dir, "..", "..");
const data = mkdtempSync(join(tmpdir(), "pn-fixed-dialog-shots-"));
const env = {
  ...process.env,
  PLANNOTATOR_DATA_DIR: data,
  NO_BROWSER: "/usr/bin/true",
  PLANNOTATOR_BROWSER: undefined,
  PLANNOTATOR_INBOX_CONNECT: "0",
  PLANNOTATOR_INBOX_TAILSCALE: "0",
  PLANNOTATOR_INBOX_PHONES: "0",
  PLANNOTATOR_UPDATE_CHECK: "0",
  PLANNOTATOR_INBOX_NOTES: "0",
  // Off: the server never looks up Node or runs anything for the name. The page's name requests are scripted below.
  PLANNOTATOR_PROTO_FIXED_ADDRESS: undefined,
} as Record<string, string | undefined>;
const started = spawnSync("bun", [join(repo, "apps/hook/server/index.ts"), "inbox", "--background"], { env: env as NodeJS.ProcessEnv, encoding: "utf8", timeout: 60_000 });
if (started.status !== 0) {
  console.error(started.stdout, started.stderr);
  process.exit(1);
}
const registry = JSON.parse(readFileSync(join(data, "inbox", "inbox.json"), "utf8")) as { url: string; port: number; token: string };
if (registry.port === 59812 || registry.port === 59054) throw new Error("refusing: that port belongs to the owner's Inboxes");
const base = registry.url.replace(/\/$/, "");
spawnSync("bun", [join(repo, "scripts/proto-fixed-address/seed-question.ts"), String(registry.port), repo], { env: env as NodeJS.ProcessEnv, encoding: "utf8" });

type Name = Record<string, unknown>;
const nameState = (over: Name = {}): Name => ({
  status: "off",
  url: "http://inbox.plannotator.localhost/",
  host: "inbox.plannotator.localhost",
  reason: null,
  step: null,
  failure: null,
  port_holder: null,
  platform: "darwin",
  listener_port: null,
  dialog_due: true,
  prototype: true,
  verified_at: null,
  probe: null,
  log: [],
  portless: { node: "/usr/local/bin/node", cli: null, state_dir: "~/.portless", home: "" },
  ...over,
});

/** Script the page's name requests: `current` is what GET answers; POST answers `afterPost`. */
async function scripted(page: Page) {
  const s = { current: nameState(), afterPost: nameState({ status: "working", step: "password" }) };
  await page.route("**/api/inbox/name/dialog", (route) => route.fulfill({ json: { show: true, name: nameState() } }));
  await page.route("**/api/inbox/name", (route) => {
    if (route.request().method() === "POST") {
      s.current = s.afterPost;
      return route.fulfill({ json: { name: s.afterPost } });
    }
    return route.fulfill({ json: { name: s.current } });
  });
  // The tab's move to the name: aborted, so the done state stays on screen.
  await page.route("http://inbox.plannotator.localhost/**", (route) => route.abort());
  return s;
}

const steps: [string, Name[]][] = [
  ["1-ask", []],
  ["2-password", [{ status: "working", step: "password" }]],
  ["3-installing", [{ status: "working", step: "password" }, { status: "working", step: "installing" }]],
  ["4-checking", [{ status: "working", step: "password" }, { status: "working", step: "installing" }, { status: "working", step: "starting" }, { status: "working", step: "verifying" }]],
  ["5-done", [{ status: "working", step: "password" }, { status: "working", step: "installing" }, { status: "working", step: "starting" }, { status: "working", step: "verifying" }, { status: "on" }]],
  ["6-failed-port", [{ status: "working", step: "preparing" }, { status: "failed", failure: "port_taken", port_holder: "nginx", reason: "Port 80 is already used…" }]],
  ["7-failed-cancel", [{ status: "working", step: "password" }, { status: "failed", failure: "cancelled", reason: "You cancelled the password prompt. Nothing changed." }]],
];

const browser = await chromium.launch();
const errors: string[] = [];
let shots = 0;
try {
  for (const [frame, viewport] of [
    ["desktop", { width: 1280, height: 860 }],
    ["narrow", { width: 375, height: 780 }],
  ] as const) {
    for (const theme of ["dark", "light"] as const) {
      for (const [label, sequence] of steps) {
        if (frame === "narrow" && (theme === "light" || !["1-ask", "3-installing", "6-failed-port"].includes(label))) continue;
        const context = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: theme, reducedMotion: label === "1-ask" ? "no-preference" : "reduce" });
        const page = await context.newPage();
        page.on("pageerror", (e) => errors.push(`${label}: ${e}`));
        page.on("console", (m) => m.type() === "error" && !/Failed to load resource|ERR_FAILED|net::/.test(m.text()) && errors.push(`${label}: ${m.text()}`));
        const s = await scripted(page);
        await page.goto(base);
        const dialog = page.locator('[data-dialog="fixed-address"]');
        await dialog.waitFor({ timeout: 20_000 });
        if (sequence.length) {
          s.afterPost = nameState(sequence[0]);
          await dialog.locator("[data-name-sure]").click();
          for (const next of sequence) {
            s.current = nameState(next);
            const step = (next.step as string | null | undefined) ?? "";
            await page.waitForSelector(`[data-name-status="${next.status}"][data-name-step="${step}"]`, { timeout: 5000 });
            await page.waitForTimeout(next.step === "installing" ? 400 : next.step === "starting" ? 600 : 200);
          }
        } else await page.waitForTimeout(900);
        const name = frame === "narrow" ? `address-narrow-${label.replace(/^\d-/, "")}-${theme}.png` : `address-${label}-${theme}.png`;
        await page.screenshot({ path: join(out, name) });
        shots++;
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  await fetch(`${base}/api/inbox/control/stop`, { method: "POST", headers: { Authorization: `Bearer ${registry.token}` } }).catch(() => {});
  await Bun.sleep(500);
  rmSync(data, { recursive: true, force: true });
}
console.log(`${shots} shots in ${out}`, errors.length ? `\nERRORS:\n${errors.join("\n")}` : "; no page errors");
