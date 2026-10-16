/**
 * Dictated (pasted) text lands in the field the person is writing in,
 * proved in a real Chromium (and WebKit) against the compiled binary.
 *
 * Dictation apps on macOS (Hex and others) insert text by putting it on the
 * clipboard and posting a synthetic ⌘V. In the Inbox, focus often leaves the
 * field the person is writing in without them noticing: a click on a question
 * card's choice moves it to that radio, a click on the message text or on a
 * chip in the reply box moves it to the page, and the reply box stays open.
 * Before the fix the ⌘V then pasted into nothing. Each case below writes the
 * clipboard, moves focus the way a person does, presses ⌘V, and expects the
 * words in the field: the reply box, a question card's note, and compose. And
 * the other side: a paste aimed at a field stays in it, a page where no field
 * was used keeps it nowhere, and a file shown full screen over the thread
 * keeps it out of the reply box hidden under it.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { expect, test, webkit, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
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
let filesThreadId = '';
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
  writeFileSync(join(project, 'retry-plan.md'), '# Retry plan\n\nRetry with the same key, three times, then the dead-letter queue.\n');
  claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  threadId = (await claude.send({ project_path: project, subject: 'The 409 row', thread: 'retry', body: QUESTIONS })).thread_id as string;
  filesThreadId = (await claude.send({ project_path: project, subject: 'The retry plan', thread: 'plan', body: 'The plan is attached.', attachments: ['retry-plan.md'] }))
    .thread_id as string;
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
async function dictate(on: Page, words: string): Promise<void> {
  await on.evaluate((text) => navigator.clipboard.writeText(text), words);
  await on.keyboard.press('ControlOrMeta+v');
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function expectLanded(field: Locator, words: string): Promise<void> {
  await expect(field).toHaveValue(new RegExp(escapeRegExp(words.trim())));
  await expect(field).toBeFocused();
}

/** Every text field's value on the page, so a paste that landed anywhere is seen. */
const allValues = (on: Page) =>
  on.evaluate(() => [...document.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>('textarea, input')].map((el) => el.value).join('\n'));

test('the reply box: after a pick, after a click on the message, after a chip', async () => {
  await page.goto(`${url}#thread=${threadId}`);
  await page.locator('.ib-pfoot').getByRole('button', { name: 'Reply' }).click();
  const box = page.locator('section.ib-pane .ib-rbox textarea');
  await expect(box).toBeFocused();
  await dictate(page, 'Focused dictation. ');
  await expectLanded(box, 'Focused dictation.');

  await page.getByText('Retry with the same idempotency key').click();
  await expect(box).not.toBeFocused();
  await dictate(page, 'After a pick. ');
  await expectLanded(box, 'After a pick.');
  // The caret comes back where the person left it: at the end.
  expect(await box.inputValue()).toBe('Focused dictation. After a pick. ');

  await page.getByText('I checked the 409 row.').click();
  await expect(box).not.toBeFocused();
  await dictate(page, 'After reading. ');
  await expectLanded(box, 'After reading.');

  await page.locator('section.ib-pane .ib-rfoot button').first().click();
  await expect(box).not.toBeFocused();
  await dictate(page, 'After a chip. ');
  await expectLanded(box, 'After a chip.');
  expect(await box.inputValue()).toBe('Focused dictation. After a pick. After reading. After a chip. ');
});

test('a range selected in the reply box before a pick is not replaced: the dictation goes after it', async () => {
  await page.goto(`${url}#thread=${threadId}`);
  const box = page.locator('section.ib-pane .ib-rbox textarea');
  if (!(await box.isVisible())) await page.locator('.ib-pfoot').getByRole('button', { name: 'Reply' }).click();
  await box.fill('Keep these words.');
  await box.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(5, 10)); // "these", selected
  await page.getByText('Fail the job').click();
  await expect(box).not.toBeFocused();
  await dictate(page, ' Dictated.');
  await expect(box).toHaveValue('Keep these Dictated. words.');
});

test('a question card note: after a pick on the same card', async () => {
  await page.goto(`${url}#thread=${threadId}`);
  const card = page.locator('section.ib-pane fieldset[data-question-key]').nth(1);
  await card.getByRole('button', { name: 'Add note' }).click();
  const note = card.getByPlaceholder('Context for the agent…');
  await expect(note).toBeFocused();
  await dictate(page, 'Only if the flag is off by default. ');
  await expectLanded(note, 'Only if the flag is off by default.');
  await card.getByText('Yes', { exact: true }).click();
  await expect(note).not.toBeFocused();
  await dictate(page, 'And tell the team. ');
  await expectLanded(note, 'And tell the team.');
});

test('a paste aimed at another field stays in it: the reply box keeps its words', async () => {
  await page.goto(`${url}#thread=${threadId}`);
  const box = page.locator('section.ib-pane .ib-rbox textarea');
  if (!(await box.isVisible())) await page.locator('.ib-pfoot').getByRole('button', { name: 'Reply' }).click();
  await box.fill('My reply.');
  const card = page.locator('section.ib-pane fieldset[data-question-key]').nth(1);
  const note = card.getByPlaceholder('Context for the agent…');
  if (!(await note.isVisible())) await card.getByRole('button', { name: 'Add note' }).click();
  await note.click();
  await dictate(page, 'Into the note. ');
  await expectLanded(note, 'Into the note.');
  await expect(box).toHaveValue('My reply.');
});

test('compose: after focus moves to another control in the dialog', async () => {
  await page.goto(`${url}#thread=${threadId}`);
  await page.locator('[data-open-compose]').first().click();
  const message = page.getByRole('dialog').getByRole('textbox', { name: 'Message' });
  await expect(message).toBeVisible();
  await message.click();
  await dictate(page, 'An idea for later. ');
  await expectLanded(message, 'An idea for later.');
  // Focus moves to another of the dialog's controls (no agent is live here, so To is plain text).
  await page.getByRole('dialog').getByRole('button', { name: 'Save draft' }).focus();
  await expect(message).not.toBeFocused();
  await dictate(page, 'With one more thought. ');
  await expectLanded(message, 'With one more thought.');
});

test('no field used on the page yet: a paste lands nowhere and opens nothing', async () => {
  const fresh = await context.newPage();
  try {
    await fresh.goto(`${url}#thread=${threadId}`);
    await expect(fresh.locator('section.ib-pane fieldset[data-question-key]').first()).toBeVisible();
    await fresh.getByText('I checked the 409 row.').click();
    await dictate(fresh, 'Nowhere at all. ');
    await fresh.waitForTimeout(300);
    expect(await allValues(fresh)).not.toContain('Nowhere at all.');
    expect(await fresh.evaluate(() => document.activeElement?.tagName)).not.toMatch(/^(TEXTAREA|INPUT)$/);
  } finally {
    await fresh.close();
  }
});

test('a file full screen over the thread: the reply box hidden under it takes no paste', async () => {
  const p = await context.newPage();
  try {
    await p.goto(`${url}#thread=${filesThreadId}`);
    await p.locator('.ib-pfoot').getByRole('button', { name: 'Reply' }).click();
    const box = p.locator('section.ib-pane .ib-rbox textarea');
    await box.fill('Under the file.');
    await p.locator('section.ib-pane .ib-atts [data-attachment-id]').first().click();
    await p.getByRole('button', { name: 'Full screen' }).click();
    await expect(p.locator('.ib-view.ib-full')).toBeVisible();
    await p.locator('.ib-view.ib-full').getByText('Retry with the same key').click();
    await dictate(p, 'Not into the hidden box. ');
    await p.waitForTimeout(300);
    await expect(box).toHaveValue('Under the file.');
    await expect(box).not.toBeFocused();
  } finally {
    await p.close();
  }
});

test('WebKit: after a pick, the paste goes back to the reply box', async () => {
  let browser: Browser | null = null;
  try {
    browser = await webkit.launch();
  } catch (error) {
    test.skip(true, `WebKit is not installed here: ${(error as Error).message.split('\n')[0]}`);
    return;
  }
  try {
    const wk = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await wk.newPage();
    await p.goto(`${url}#thread=${threadId}`);
    await p.locator('.ib-pfoot').getByRole('button', { name: 'Reply' }).click();
    const box = p.locator('section.ib-pane .ib-rbox textarea');
    await box.fill('Typed. ');
    await p.getByText('Retry with the same idempotency key').click();
    await expect(box).not.toBeFocused();
    // WebKit gives the page no clipboard permission to set, so this proves the half that is ours:
    // the ⌘V keydown puts focus back in the reply box, caret at its end, before the browser pastes.
    await p.keyboard.press('ControlOrMeta+v');
    await expect(box).toBeFocused();
    expect(await box.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([7, 7]);
  } finally {
    await browser.close();
  }
});
