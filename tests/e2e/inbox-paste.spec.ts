/**
 * Dictated (pasted) text lands in the field the person is writing in,
 * proved in a real Chromium against the compiled binary.
 *
 * Dictation apps on macOS (Hex and others) insert text by putting it on the
 * clipboard and posting a synthetic ⌘V. In the Inbox, focus often leaves the
 * field the person is writing in without them noticing: a click on a question
 * card's choice moves it to that radio, a click on the message text or on a
 * chip in the reply box moves it to the page, and the reply box stays open.
 * Before the fix the ⌘V then pasted into nothing. Each case below writes the
 * clipboard, moves focus the way a person does, presses ⌘V, and expects the
 * words in the field: the reply box, a question card's note, and compose.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

const QUESTIONS = [
  'I checked the 409 row. Two things before I go on.',
  '',
  ':::question',
  'Which way should the worker go on a Stripe 409?',
  '',
  '- [ ] Retry with the same idempotency key',
  '- [ ] Fail the job',
  ':::',
  '',
  ':::question',
  'Ship it behind a flag?',
  '',
  '- [ ] Yes',
  '- [ ] No',
  ':::',
].join('\n');

let url = '';
let threadId = '';
let claude: SimAgent;
let context: BrowserContext;
let page: Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-paste-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  url = started.stdout.trim();
  const project = scratchProject(join(root, 'src'), 'plannotator');
  claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  threadId = (await claude.send({ project_path: project, subject: 'The 409 row', thread: 'retry', body: QUESTIONS })).thread_id as string;
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  page = await context.newPage();
});

test.afterAll(async () => {
  try {
    await claude?.close().catch(() => {});
    await context?.close();
  } finally {
    await removeInboxScratch();
  }
});

/** What a dictation app does: the words on the clipboard, then ⌘V. */
async function dictate(words: string): Promise<void> {
  await page.evaluate((text) => navigator.clipboard.writeText(text), words);
  await page.keyboard.press('ControlOrMeta+v');
}

async function expectLanded(field: Locator, words: string): Promise<void> {
  await expect(field).toHaveValue(new RegExp(`${words.trim()}`));
  await expect(field).toBeFocused();
}

test('the reply box: after a pick, after a click on the message, after a chip', async () => {
  await page.goto(`${url}#thread=${threadId}`);
  await page.locator('.ib-pfoot').getByRole('button', { name: 'Reply' }).click();
  const box = page.locator('section.ib-pane .ib-rbox textarea');
  await expect(box).toBeFocused();
  await dictate('Focused dictation. ');
  await expectLanded(box, 'Focused dictation.');

  await page.getByText('Retry with the same idempotency key').click();
  await expect(box).not.toBeFocused();
  await dictate('After a pick. ');
  await expectLanded(box, 'After a pick.');
  // The caret comes back where the person left it: at the end.
  expect(await box.inputValue()).toBe('Focused dictation. After a pick. ');

  await page.getByText('I checked the 409 row.').click();
  await expect(box).not.toBeFocused();
  await dictate('After reading. ');
  await expectLanded(box, 'After reading.');

  await page.locator('section.ib-pane .ib-rfoot button').first().click();
  await expect(box).not.toBeFocused();
  await dictate('After a chip. ');
  await expectLanded(box, 'After a chip.');
  expect(await box.inputValue()).toBe('Focused dictation. After a pick. After reading. After a chip. ');
});

test('a question card note: after a pick on the same card', async () => {
  await page.goto(`${url}#thread=${threadId}`);
  const card = page.locator('section.ib-pane fieldset[data-question-key]').nth(1);
  await card.getByRole('button', { name: 'Add note' }).click();
  const note = card.getByPlaceholder('Context for the agent…');
  await expect(note).toBeFocused();
  await dictate('Only if the flag is off by default. ');
  await expectLanded(note, 'Only if the flag is off by default.');
  await card.getByText('Yes', { exact: true }).click();
  await expect(note).not.toBeFocused();
  await dictate('And tell the team. ');
  await expectLanded(note, 'And tell the team.');
});

test('compose: after focus moves to another control in the dialog', async () => {
  await page.goto(`${url}#thread=${threadId}`);
  await page.locator('[data-open-compose]').first().click();
  const message = page.getByRole('dialog').getByRole('textbox', { name: 'Message' });
  await expect(message).toBeVisible();
  await message.click();
  await dictate('An idea for later. ');
  await expectLanded(message, 'An idea for later.');
  // Focus moves to another of the dialog's controls (no agent is live here, so To is plain text).
  await page.getByRole('dialog').getByRole('button', { name: 'Save draft' }).focus();
  await expect(message).not.toBeFocused();
  await dictate('With one more thought. ');
  await expectLanded(message, 'With one more thought.');
});

test('a paste aimed at a field stays there; nothing moves when no field was used', async () => {
  // A page with no field used yet: ⌘V on the page leaves focus alone.
  await page.goto(`${url}#thread=${threadId}`);
  await page.reload();
  await page.getByText('I checked the 409 row.').click();
  await dictate('Nowhere. ');
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('TEXTAREA');
});
