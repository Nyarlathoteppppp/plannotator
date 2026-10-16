/**
 * When a pane covers the one under it in a window too narrow for both
 * (stack.ts). The failures these catch: a wide desktop window starting to
 * stack (it must be drawn as before), an iPad on its side losing the list
 * beside the thread, a narrow window squeezing the thread again, and the
 * widths here drifting from the columns inbox.css draws.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DECISIONS_LIST_WIDTH, DECISION_MIN_WIDTH, FILE_MIN_WIDTH, LIST_MIN_WIDTH, THREAD_BESIDE_FILE_WIDTH, THREAD_MIN_WIDTH, PANE_GUTTERS, stackFor } from './stack';

// The docked sidebar's default width.
const SIDEBAR = 232;
const NONE = { thread: false, file: false, decision: false };
/** A window `width` px wide, as useStack measures it: the room past the sidebar and the window, each less the panes' gutters. */
const windowOf = (width: number, sidebar = SIDEBAR) => stackFor(width - sidebar - PANE_GUTTERS, width - PANE_GUTTERS);

test('a wide window never stacks: the list beside the thread, the file beside the thread', () => {
  for (const width of [1280, 1440, 1920]) expect(windowOf(width)).toEqual(NONE);
});

test('an iPad on its side (1080) keeps the list beside a 444 px thread, as iPad Mail does', () => {
  // An open decision covers the Decisions list there: 460 + 380 px and the gutters need 1096 px.
  expect(windowOf(1080)).toEqual({ thread: false, file: false, decision: true });
  expect(windowOf(1100)).toEqual(NONE);
  // The narrowest window that keeps the list beside a thread with the sidebar docked.
  expect(windowOf(SIDEBAR + LIST_MIN_WIDTH + THREAD_BESIDE_FILE_WIDTH + PANE_GUTTERS).thread).toBe(false);
  expect(windowOf(SIDEBAR + LIST_MIN_WIDTH + THREAD_BESIDE_FILE_WIDTH + PANE_GUTTERS - 1).thread).toBe(true);
});

test('an iPad upright and a 900 px window: the thread covers the list, a file covers the thread, a decision covers its list', () => {
  expect(windowOf(810)).toEqual({ thread: true, file: true, decision: true });
  expect(windowOf(900)).toEqual({ thread: true, file: true, decision: true });
  // At 1000 the thread covers the list; the file has room beside its thread.
  expect(windowOf(1000)).toEqual({ thread: true, file: false, decision: true });
  // With the sidebar collapsed a 900 px window has room for the list beside the thread.
  expect(windowOf(900, 0).thread).toBe(false);
  // A file keeps its readable 480 px beside a 440 px thread: from 944 px (920 and the gutters).
  expect(windowOf(THREAD_BESIDE_FILE_WIDTH + FILE_MIN_WIDTH + PANE_GUTTERS).file).toBe(false);
  expect(windowOf(THREAD_BESIDE_FILE_WIDTH + FILE_MIN_WIDTH + PANE_GUTTERS - 1).file).toBe(true);
});

test('the edges: stacking starts exactly where a pane would get less than its minimum', () => {
  expect(stackFor(LIST_MIN_WIDTH + THREAD_BESIDE_FILE_WIDTH, 2000).thread).toBe(false);
  expect(stackFor(LIST_MIN_WIDTH + THREAD_BESIDE_FILE_WIDTH - 1, 2000).thread).toBe(true);
  expect(stackFor(2000, THREAD_BESIDE_FILE_WIDTH + FILE_MIN_WIDTH).file).toBe(false);
  expect(stackFor(2000, THREAD_BESIDE_FILE_WIDTH + FILE_MIN_WIDTH - 1).file).toBe(true);
  expect(stackFor(DECISIONS_LIST_WIDTH + DECISION_MIN_WIDTH, 2000).decision).toBe(false);
  expect(stackFor(DECISIONS_LIST_WIDTH + DECISION_MIN_WIDTH - 1, 2000).decision).toBe(true);
  // Not measured yet (0): nothing stacks.
  expect(stackFor(0, 0)).toEqual(NONE);
});

test('the widths are the ones inbox.css draws the columns at', () => {
  const css = readFileSync(join(import.meta.dir, 'inbox.css'), 'utf8');
  expect(css).toContain(`.ib-listcol.ib-resizable { position: relative; min-width: ${LIST_MIN_WIDTH}px; max-width: calc(100% - ${THREAD_MIN_WIDTH}px - var(--ib-gutter)); }`);
  // The gutters the panes float in: one each side of .ib-main and one between its panes.
  expect(css).toContain(`--ib-gutter: ${PANE_GUTTERS / 3}px;`);
  expect(css).toContain('.ib-main { display: flex; flex: 1; min-width: 0; height: 100%; padding: var(--ib-gutter); gap: var(--ib-gutter); }');
  expect(css).toContain(`.ib-pane.ib-withfile { flex: none; width: ${THREAD_BESIDE_FILE_WIDTH}px;`);
  expect(css).toContain(`.ib-dpage.ib-narrow { flex: none; width: ${DECISIONS_LIST_WIDTH}px;`);
});
