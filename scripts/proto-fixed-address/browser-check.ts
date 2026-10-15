/**
 * PROTOTYPE (proto/inbox-fixed-address): load the fixed address in real
 * browser engines WITHOUT ignoring certificate errors, so a pass means the
 * OS (or the browser) trusts portless's CA. Prints one JSON line per engine.
 *
 *   bun scripts/proto-fixed-address/browser-check.ts <expected serverSession> [url]
 *
 * Engines: the installed Google Chrome (channel "chrome") when present, then
 * Playwright's Chromium, WebKit and Firefox when installed
 * (`bunx playwright install chromium webkit firefox`). Firefox keeps its own
 * certificate store, so a Firefox failure is expected unless its enterprise
 * roots setting is on; it is reported, not counted.
 * Exit 0 when at least one Chromium-family engine passed.
 */
import { chromium, firefox, webkit, type BrowserType } from "@playwright/test";

const expected = process.argv[2] ?? "";
const url = (process.argv[3] ?? "https://inbox.plannotator.localhost").replace(/\/$/, "");

interface Outcome {
  engine: string;
  ok: boolean;
  detail: string;
  secureContext?: boolean;
  notification?: string;
}

async function check(engine: string, type: BrowserType, options: Parameters<BrowserType["launch"]>[0] = {}): Promise<Outcome> {
  let browser;
  try {
    browser = await type.launch({ headless: true, ...options });
  } catch (error) {
    return { engine, ok: false, detail: `not available: ${String(error).split("\n")[0]}` };
  }
  try {
    const page = await (await browser.newContext({ ignoreHTTPSErrors: false })).newPage();
    const response = await page.goto(`${url}/api/inbox/health`, { timeout: 15_000 });
    const body = JSON.parse((await response?.text()) ?? "{}") as { serverSession?: string };
    if (body.serverSession !== expected) return { engine, ok: false, detail: `answered serverSession ${body.serverSession ?? "(none)"}, expected ${expected}` };
    await page.goto(`${url}/`, { timeout: 15_000 });
    const secureContext = await page.evaluate(() => window.isSecureContext);
    const notification = await page.evaluate(() => (typeof Notification === "undefined" ? "unsupported" : Notification.permission));
    return { engine, ok: true, detail: `HTTP ${response?.status()} with a trusted certificate`, secureContext, notification };
  } catch (error) {
    return { engine, ok: false, detail: String(error).split("\n")[0]! };
  } finally {
    await browser.close().catch(() => {});
  }
}

const outcomes: Outcome[] = [];
outcomes.push(await check("chrome (installed)", chromium, { channel: "chrome" }));
outcomes.push(await check("chromium (playwright)", chromium));
outcomes.push(await check("webkit (playwright)", webkit));
outcomes.push(await check("firefox (playwright, own CA store)", firefox));
for (const outcome of outcomes) console.log(JSON.stringify(outcome));
process.exit(outcomes.some((o) => o.ok && o.engine.startsWith("chrom")) ? 0 : 1);
