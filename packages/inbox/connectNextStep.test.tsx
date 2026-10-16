/**
 * First run, "One next step" (components/EmptyState.tsx; the approved design
 * inbox-connect-next-step, variant C), on each of the mock's computers:
 * Typical, Plugin missing, Nothing found, Tool locked off, and a page that
 * cannot read this computer's agents (opened over the tailnet). Turn on goes
 * through POST /api/inbox/agents (a recording fetch) and the card moves to the
 * next step; Not now puts a step off; installing is a command to copy; MCP is
 * folded behind "Use MCP instead"; Message opens compose to the live session.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { inboxToolCostText, type InboxAgentsModel } from '@plannotator/core/inbox-types';
import type { ComposeSessionsModel } from './api';
import { SCENARIOS, ready } from './connectSteps.fixtures';

const hasDom = typeof document !== 'undefined';
const { EmptyState } = (hasDom ? await import('./components/EmptyState') : {}) as typeof import('./components/EmptyState');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
});

const context = { command: ['/opt/plannotator', 'inbox', 'mcp'], mcpUrl: 'http://127.0.0.1:1/mcp', platform: 'mac' as const };
const live: ComposeSessionsModel = {
  serverSession: 's',
  home: '/Users/me',
  projects: [
    {
      project: { id: 'prj_1', name: 'plannotator', root: '/Users/me/plannotator' },
      sessions: [{ session: 'ses_cc', host: 'claude-code', started_at: '2026-10-16T10:00:00Z', last_seen_at: '2026-10-16T10:00:00Z', busy: false, idle_since: null, last_thread: null }],
    },
  ],
};

interface Mounted {
  el: HTMLElement;
  messages: { session: string }[];
  model: () => InboxAgentsModel | null;
}

function mount(start: InboxAgentsModel | null, options: { unavailable?: boolean; sessions?: ComposeSessionsModel | null } = {}): Mounted {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  let current = start;
  const messages: { session: string }[] = [];
  const render = () =>
    root!.render(
      <SidebarProvider>
      <EmptyState
        context={context}
        agents={current}
        agentsUnavailable={options.unavailable ?? false}
        sessions={options.sessions ?? null}
        onAgents={(next) => {
          current = next;
          render();
        }}
        onMessage={(session) => messages.push({ session })}
      />
      </SidebarProvider>,
    );
  act(() => {
    root = createRoot(host!);
    render();
  });
  return { el: host, messages, model: () => current };
}

const card = (el: HTMLElement) => el.querySelector<HTMLElement>('.ib-cn')!;
const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const button = (el: Element, name: string) => [...el.querySelectorAll('button')].find((b) => text(b) === name) as HTMLButtonElement | undefined;
const listOf = (el: HTMLElement, heading: string) =>
  [...el.querySelectorAll('.ib-cl > div')].find((col) => text(col.querySelector('h4')) === heading)!.querySelectorAll('li');
const click = async (target: HTMLElement) => {
  await act(async () => {
    target.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

test.skipIf(!hasDom)('typical: the next step turns on Pi\'s Inbox tool, naming its measured cost; the lists say what is done and left; Message Claude Code opens compose', async () => {
  const m = mount(SCENARIOS.typical(), { sessions: live });
  const hero = card(m.el);
  expect(hero.getAttribute('data-connect-step')).toBe('pi');
  expect(text(hero.querySelector('.ib-cn-eb'))).toBe('Next step · 1 of 2');
  expect(text(hero.querySelector('h3'))).toBe("Turn on Pi's Inbox tool");
  expect(text(hero.querySelector('p'))).toBe(
    `Plannotator's extension is installed. Turn its Inbox tool on so Pi can send you messages and get your replies in the session. It adds the tool to every Pi request: ${inboxToolCostText('pi')}.`,
  );
  expect(text(hero.querySelector('p b'))).toBe(inboxToolCostText('pi'));
  expect(button(hero, 'Turn on')).toBeDefined();
  expect(button(hero, 'Not now')).toBeDefined();
  // One primary per card; nothing to copy for a one-click step.
  expect(hero.querySelectorAll('.ib-btn.ib-pri')).toHaveLength(1);
  expect(hero.querySelector('pre')).toBeNull();

  expect([...listOf(m.el, 'Already connected')].map(text)).toEqual(['Claude Code plugin · running now', 'Codex MCP', 'Cursor MCP']);
  expect([...listOf(m.el, 'Left to do')].map(text)).toEqual(['Pi now', 'OpenCode install']);

  const message = button(m.el, 'Message Claude Code')!;
  expect(message).toBeDefined();
  // Something is left to do, so Message is not the primary.
  expect(message.classList.contains('ib-pri')).toBe(false);
  expect(text(m.el.querySelector('.ib-try-where'))).toBe('Claude Code is running in plannotator. It answers here.');
  expect(text(m.el.querySelector('.ib-try p'))).toBe('Or in a new Claude Code or Codex session, ask:');
  await click(message);
  expect(m.messages).toEqual([{ session: 'ses_cc' }]);
});

test.skipIf(!hasDom)('Turn on saves through POST /api/inbox/agents, says when it applies, and the card moves to the next step', async () => {
  const m = mount(SCENARIOS.typical());
  const sent: unknown[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    const next = SCENARIOS.typical();
    next.agents = next.agents.map((row) => (row.id === 'pi' ? { ...row, ...ready() } : row));
    return new Response(JSON.stringify({ ...next, error: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  await click(button(card(m.el), 'Turn on')!);
  expect(sent).toHaveLength(1);
  expect((sent[0] as { url: string }).url).toContain('/api/inbox/agents');
  expect((sent[0] as { body: object }).body).toMatchObject({ agent: 'pi', reach: true });
  const hero = card(m.el);
  expect(hero.getAttribute('data-connect-step')).toBe('opencode');
  expect(text(hero.querySelector('.ib-cn-eb'))).toBe('Next step · last one');
  expect([...listOf(m.el, 'Already connected')].map(text)).toContain('Pi next session');
  expect(text(m.el.querySelector('[aria-live="polite"]'))).toBe("Pi's Inbox tool is on. Start a new Pi session, or run /reload in one that is running.");
});

test.skipIf(!hasDom)('a refused Turn on says why on the card and offers Try again', async () => {
  const m = mount(SCENARIOS.typical());
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ...SCENARIOS.typical(), error: "Plannotator's config.json can't be written" }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
  await click(button(card(m.el), 'Turn on')!);
  expect(text(card(m.el).querySelector('[role="alert"]'))).toBe("Plannotator's config.json can't be written");
  expect(button(card(m.el), 'Try again')).toBeDefined();
  expect(card(m.el).getAttribute('data-connect-step')).toBe('pi');
});

test.skipIf(!hasDom)('Not now puts the step off: OpenCode is next, with its plugin line to copy, OpenCode 1 or 2, and MCP folded', async () => {
  const m = mount(SCENARIOS.typical());
  await click(button(card(m.el), 'Not now')!);
  const hero = card(m.el);
  expect(hero.getAttribute('data-connect-step')).toBe('opencode');
  expect(text(hero.querySelector('h3'))).toBe("Connect OpenCode with Plannotator's plugin");
  expect(text(hero.querySelector('.ib-clab'))).toBe('~/.config/opencode/opencode.json');
  expect(text(hero.querySelector('pre'))).toBe('"plugins": [{ "package": "@plannotator/opencode@latest" }]');
  const v1 = [...hero.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((input) => input.value === '1')!;
  await act(async () => {
    v1.click();
  });
  expect(text(card(m.el).querySelector('pre'))).toBe('"plugin": ["@plannotator/opencode@latest"]');
  expect([...listOf(m.el, 'Left to do')].map(text)).toEqual(['OpenCode now', 'Pi later']);
  // MCP is one fold away, never first.
  const fold = button(card(m.el), 'Use MCP instead')!;
  expect(fold.getAttribute('aria-expanded')).toBe('false');
  expect(card(m.el).querySelectorAll('pre')).toHaveLength(1);
  await click(fold);
  const mcp = [...card(m.el).querySelectorAll('pre')].map(text);
  expect(mcp[1]).toBe('"mcp": { "plannotator-inbox": { "type": "local", "command": ["/opt/plannotator","inbox","mcp"], "enabled": true } }');
  expect(text(card(m.el))).toContain("Works, but your replies won't come back into the session by themselves.");
});

test.skipIf(!hasDom)('plugin missing: Claude Code\'s install command, restart, Use MCP instead; Pi through MCP is done but left to give its extension', async () => {
  const m = mount(SCENARIOS.missing());
  const hero = card(m.el);
  expect(text(hero.querySelector('h3'))).toBe("Connect Claude Code with Plannotator's plugin");
  expect(text(hero.querySelector('.ib-cn-eb'))).toBe('Next step · 1 of 2');
  expect(hero.querySelector('pre')?.textContent).toBe('claude plugin marketplace add backnotprop/plannotator\nclaude plugin install plannotator@plannotator');
  expect(text(hero)).toContain('Run it in a terminal, then restart Claude Code.');
  expect(button(hero, 'Use MCP instead')).toBeDefined();
  expect([...listOf(m.el, 'Already connected')].map(text)).toEqual(['Pi MCP, no wake', 'Codex MCP']);
  expect([...listOf(m.el, 'Left to do')].map(text)).toEqual(['Claude Code now', 'Pi install', 'OpenCode: not on this computer']);
  await click(button(hero, 'Not now')!);
  const next = card(m.el);
  expect(text(next.querySelector('h3'))).toBe("Give Pi Plannotator's extension");
  expect(text(next.querySelector('pre'))).toBe('pi install npm:@plannotator/pi-extension');
  // Pi already reaches the Inbox through MCP: no MCP fold.
  expect(button(next, 'Use MCP instead')).toBeUndefined();
  expect(text(m.el.querySelector('.ib-try p'))).toBe('In a new Pi or Codex session, ask:');
});

test.skipIf(!hasDom)('nothing found: connect your first agent, Claude Code, Pi or OpenCode, each with its install command; no lists', async () => {
  const m = mount(SCENARIOS.none());
  const hero = card(m.el);
  expect(text(hero.querySelector('.ib-cn-eb'))).toBe('First step');
  expect(text(hero.querySelector('h3'))).toBe('Connect your first agent');
  expect(m.el.querySelector('.ib-cl')).toBeNull();
  expect(hero.querySelector('pre')?.textContent).toContain('claude plugin install plannotator@plannotator');
  const pi = [...hero.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((input) => input.value === 'pi')!;
  await act(async () => {
    pi.click();
  });
  expect(text(card(m.el).querySelector('pre'))).toBe('pi install npm:@plannotator/pi-extension');
  expect(text(m.el.querySelector('.ib-try p'))).toBe('Once an agent is connected, ask it in a new session:');
  // The picker for every other agent or editor, folded.
  const picker = button(m.el, 'Another agent or editor')!;
  expect(text(picker.parentElement)).toBe('Another agent or editor VS Code, Zed, JetBrains, Goose, any MCP client');
  await click(picker);
  const tabs = [...m.el.querySelectorAll('[role="tab"]')].map(text);
  expect(tabs).not.toContain('Claude Code');
  expect(tabs).not.toContain('Pi');
  expect(tabs).toContain('VS Code');
});

test.skipIf(!hasDom)('locked: the tools PLANNOTATOR_INBOX_TOOL=0 keeps off are not steps; they say so in Left to do', () => {
  const m = mount(SCENARIOS.locked());
  expect(card(m.el).getAttribute('data-connect-step')).toBe('opencode');
  expect(text(card(m.el).querySelector('.ib-cn-eb'))).toBe('Next step · last one');
  expect([...listOf(m.el, 'Left to do')].map(text)).toEqual([
    'OpenCode now',
    'Claude Code locked by PLANNOTATOR_INBOX_TOOL=0',
    'Pi locked by PLANNOTATOR_INBOX_TOOL=0',
  ]);
  expect(button(m.el, 'Turn on')).toBeUndefined();
});

test.skipIf(!hasDom)('all set: nothing left, a quiet card, and Message is the primary', () => {
  const model = SCENARIOS.typical();
  model.agents = model.agents.map((row) => (row.id === 'pi' ? { ...row, ...ready() } : row.id === 'opencode' ? { ...row, detected: false } : row));
  const m = mount(model, { sessions: live });
  expect(text(card(m.el).querySelector('h3'))).toBe('Your agents reach the Inbox');
  expect(button(m.el, 'Message Claude Code')!.classList.contains('ib-pri')).toBe(true);
});

test.skipIf(!hasDom)('the agents cannot be read here (a page over the tailnet): the first step with the commands, and where to connect in one click', () => {
  const m = mount(null, { unavailable: true });
  expect(text(card(m.el).querySelector('h3'))).toBe('Connect your first agent');
  expect(text(card(m.el))).toContain('Open the Inbox on the computer to connect agents with one click.');
});

test.skipIf(!hasDom)('while the agents load, nothing but the heading shows', () => {
  const m = mount(null);
  expect(m.el.querySelector('.ib-cn')).toBeNull();
  expect(m.el.querySelector('.ib-try')).toBeNull();
  expect(text(m.el.querySelector('h2'))).toBe('No agent has written yet');
});
