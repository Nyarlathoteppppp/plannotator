/**
 * Links inside an attached HTML page, proved in a real browser against the
 * compiled binary. Nothing is mocked: `plannotator inbox --background` runs
 * under a temp PLANNOTATOR_DATA_DIR and HOME, an agent sends through
 * `plannotator inbox mcp` (scripts/inbox-sim.ts) a message attaching
 * `site/SHEET.html` and one frame of the page, and Chromium opens the page.
 * In Interact (the toolbar's pen; an armed click pins a link instead, as in
 * annotate) a real click on each link of the page: a sibling page that is
 * not attached opens read-only over the page with Back and Open in new tab,
 * and its own links follow; Back returns to the page; the attached frame
 * opens in the pane and the browser's Back returns to the page; an image
 * beside it that is not attached opens in the lightbox, loaded; a PDF says
 * why it does not open. A phone does the same.
 *
 * Screenshots (light and dark, desktop and phone) go to
 * PLANNOTATOR_HTML_LINKS_SHOTS when it is set.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = process.env.PLANNOTATOR_HTML_LINKS_SHOTS ?? '';

/** A small PNG drawn here (a gradient, `width` × `height`), so the lightbox has something to show and to measure. */
function png(width: number, height: number, hue: [number, number, number]): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const b of bytes) c = table[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * (width * 3 + 1) + 1 + x * 3;
      const t = (x + y) / (width + height);
      rows[at] = Math.round(hue[0] * (0.4 + 0.6 * t));
      rows[at + 1] = Math.round(hue[1] * (0.4 + 0.6 * t));
      rows[at + 2] = Math.round(hue[2] * (0.4 + 0.6 * t));
    }
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

const STYLE =
  '<style>body{font:15px/1.5 system-ui;margin:32px;color:#222;background:#fafaf7}h1{font-size:22px}ul{padding-left:18px}li{margin:6px 0}a{color:#2563eb}@media (prefers-color-scheme:dark){body{background:#16171a;color:#ddd}a{color:#7aa2ff}}</style>';

const SHEET = `<!doctype html><html><head><meta charset="utf-8"><title>Contact sheet</title>${STYLE}</head><body>
<h1>Guided narrative: contact sheet</h1>
<p>Three directions. Each has a full page and frames.</p>
<ul>
<li><a href="A-story.html">A: Story page</a></li>
<li><a href="B-cards.html#pr1">B: Cards, at PR 1</a></li>
<li><a href="frames/A-1440-light.png">A frame, attached</a></li>
<li><a href="frames/B-1440-light.png">B frame, not attached</a></li>
<li><a href="brief.pdf">The brief (PDF)</a></li>
</ul>
</body></html>`;

const PAGE = (title: string, extra = '') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${STYLE}</head><body><h1>${title}</h1>${extra}<p style="margin-top:900px" id="pr1">PR 1 section</p><p><a href="SHEET.html">Back to the sheet</a></p></body></html>`;

async function shot(page: Page, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

async function world() {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-htmllinks-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const project = scratchProject(join(root, 'src'), 'research');
  const site = join(project, 'guided-narrative');
  mkdirSync(join(site, 'frames'), { recursive: true });
  writeFileSync(join(site, 'SHEET.html'), SHEET);
  writeFileSync(join(site, 'A-story.html'), PAGE('A: Story page', '<p><a href="B-cards.html">On to B</a></p>'));
  writeFileSync(join(site, 'B-cards.html'), PAGE('B: Cards'));
  writeFileSync(join(site, 'frames', 'A-1440-light.png'), png(480, 300, [80, 140, 255]));
  writeFileSync(join(site, 'frames', 'B-1440-light.png'), png(480, 300, [255, 150, 70]));
  writeFileSync(join(site, 'brief.pdf'), '%PDF-1.4\n');
  const agent = await SimAgent.connect({ binary, env, name: 'Claude', host: 'claude-code' });
  const sent = await agent.send({
    project_path: project,
    subject: 'Guided narrative: three directions',
    attachments: ['guided-narrative/SHEET.html', 'guided-narrative/frames/A-1440-light.png'],
    body: 'The contact sheet links every page and frame.',
  });
  const ids = Object.fromEntries((sent.attachments as { id: string; name: string }[]).map((a) => [a.name, a.id]));
  return { root, url, agent, thread: sent.thread_id as string, ids };
}

/** The attached page opened from its tile (full screen), in Interact (an armed click pins a link). */
async function openSheet(page: Page, url: string, thread: string, sheet: string) {
  // From its tile, as the person opens it: HTML opens full screen.
  await page.goto(`${url}#thread=${thread}`);
  await page.locator(`button[data-attachment-id="${sheet}"]`).first().click();
  const pane = page.locator(`[data-attachment-pane="${sheet}"]`);
  await expect(pane).toBeVisible();
  await expect(pane).toHaveAttribute('data-full-view', '');
  const frame = page.frameLocator('.ib-htmlframe iframe');
  await expect(frame.locator('h1')).toHaveText('Guided narrative: contact sheet');
  await page.getByRole('button', { name: 'Annotate mode' }).click();
  await expect(page.getByRole('button', { name: 'Interact mode' })).toBeVisible();
  return { pane, frame };
}

for (const scheme of ['light', 'dark'] as const) {
  test(`links in an attached page open: a sibling page, an attached frame, an image beside it, and a refusal (${scheme})`, async ({ browser }) => {
    const { root, url, agent, thread, ids } = await world();
    const context = await browser.newContext({ colorScheme: scheme });
    try {
      const page = await context.newPage();
      const { pane, frame } = await openSheet(page, url, thread, ids['SHEET.html']!);
      await shot(page, `1-attached-page-${scheme}`);

      // A sibling page that is not attached: read-only over the page, with Back and the reason.
      await frame.getByRole('link', { name: 'B: Cards, at PR 1' }).click();
      const linked = page.locator('[data-linked-page="B-cards.html"]');
      await expect(linked).toBeVisible();
      await expect(page.locator('[data-linked-note]')).toHaveText('B-cards.html is not attached, so comments are off.');
      await expect(page.locator('[data-linked-back]')).toHaveText(/Back to SHEET\.html/);
      await expect(page.locator('[data-linked-open-tab]')).toHaveAttribute('href', /^\/api\/html-assets\/[A-Za-z0-9_-]+\/B-cards\.html$/);
      const linkedFrame = page.frameLocator('.ib-linkedframe iframe');
      await expect(linkedFrame.locator('h1')).toHaveText('B: Cards');
      // The fragment scrolled the page to its section.
      await expect.poll(() => linkedFrame.locator('#pr1').evaluate((el) => el.getBoundingClientRect().top < window.innerHeight)).toBe(true);
      // Focus on Back.
      expect(await page.locator('[data-linked-back]').evaluate((el) => el === document.activeElement)).toBe(true);
      await shot(page, `2-sibling-page-${scheme}`);
      // Open in new tab serves the page itself from its folder.
      const tab = await context.request.get(new URL((await page.locator('[data-linked-open-tab]').getAttribute('href'))!, url).href);
      expect(tab.status()).toBe(200);
      expect(await tab.text()).toContain('B: Cards');
      // The sibling's own link back to the attached page goes home.
      await linkedFrame.getByRole('link', { name: 'Back to the sheet' }).click();
      await expect(linked).toHaveCount(0);
      await expect(frame.locator('h1')).toHaveText('Guided narrative: contact sheet');

      // A sibling, then its own link to another sibling, then Back twice.
      await frame.getByRole('link', { name: 'A: Story page' }).click();
      await expect(page.locator('[data-linked-page="A-story.html"]')).toBeVisible();
      await page.frameLocator('.ib-linkedframe iframe').getByRole('link', { name: 'On to B' }).click();
      await expect(page.locator('[data-linked-page="B-cards.html"]')).toBeVisible();
      await expect(page.locator('[data-linked-back]')).toHaveText(/Back to A-story\.html/);
      await page.locator('[data-linked-back]').click();
      await expect(page.locator('[data-linked-page="A-story.html"]')).toBeVisible();
      await page.locator('[data-linked-back]').click();
      await expect(page.locator('[data-linked-page]')).toHaveCount(0);

      // An image beside the page, not attached: the lightbox, loaded through the page's asset route.
      await frame.getByRole('link', { name: 'B frame, not attached' }).click();
      const lightbox = page.locator('[data-image-lightbox]');
      await expect(lightbox).toBeVisible();
      await expect.poll(() => lightbox.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(480);
      await shot(page, `3-unattached-image-lightbox-${scheme}`);
      await page.keyboard.press('Escape');
      await expect(lightbox).toHaveCount(0);

      // A PDF beside it: a note says why, never silent.
      await frame.getByRole('link', { name: 'The brief (PDF)' }).click();
      const note = page.locator('[data-link-note="shown"]');
      await expect(note).toContainText('brief.pdf is not attached to this thread');
      await shot(page, `4-refusal-note-${scheme}`);

      // The attached frame opens in the pane, full screen kept, and the browser's Back returns to the page.
      await frame.getByRole('link', { name: 'A frame, attached' }).click();
      const image = page.locator(`[data-attachment-pane="${ids['A-1440-light.png']}"]`);
      await expect(image).toBeVisible();
      await expect(image).toHaveAttribute('data-full-view', '');
      await shot(page, `5-attachment-from-link-${scheme}`);
      await page.goBack();
      await expect(pane).toBeVisible();
    } finally {
      await agent.close().catch(() => {});
      await context.close().catch(() => {});
      await removeInboxScratch(root);
    }
  });
}

test('on a phone the same links open, with Back in reach', async ({ browser }) => {
  const { root, url, agent, thread, ids } = await world();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  try {
    const page = await context.newPage();
    const { frame } = await openSheet(page, url, thread, ids['SHEET.html']!);
    await shot(page, '6-phone-attached-page');
    await frame.getByRole('link', { name: 'B: Cards, at PR 1' }).click();
    await expect(page.locator('[data-linked-page="B-cards.html"]')).toBeVisible();
    const back = page.locator('[data-linked-back]');
    const box = (await back.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await shot(page, '7-phone-sibling-page');
    await back.click();
    await expect(page.locator('[data-linked-page]')).toHaveCount(0);
    await frame.getByRole('link', { name: 'The brief (PDF)' }).click();
    await expect(page.locator('[data-link-note="shown"]')).toBeVisible();
    await shot(page, '8-phone-refusal-note');
  } finally {
    await agent.close().catch(() => {});
    await context.close().catch(() => {});
    await removeInboxScratch(root);
  }
});
