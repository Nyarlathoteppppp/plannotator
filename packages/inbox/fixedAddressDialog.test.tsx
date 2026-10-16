/**
 * PROTOTYPE (proto/inbox-fixed-address): the fixed-address dialog as approved
 * ("Address bar", .product/approved/inbox-fixed-address-dialog/), in every
 * state it can reach: the ask, waiting for the password, setting up
 * (installing, starting, checking), done (the tab moves), and the failures
 * (port 80 taken, the prompt cancelled). Then the whole dialog against a
 * scripted server: Set it up → the steps as the server reports them → the
 * tab moves, with focus on the title and each change said once.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxNameState } from './api';
import type { FixedAddressViewProps } from './components/FixedAddress';

const hasDom = typeof document !== 'undefined';
const mod = (hasDom ? await import('./components/FixedAddress') : {}) as typeof import('./components/FixedAddress');

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
  globalThis.fetch = realFetch;
});

function state(over: Partial<InboxNameState> = {}): InboxNameState {
  return {
    status: 'off',
    url: 'http://inbox.plannotator.localhost/',
    host: 'inbox.plannotator.localhost',
    reason: null,
    step: null,
    failure: null,
    port_holder: null,
    platform: 'darwin',
    listener_port: null,
    dialog_due: true,
    prototype: true,
    verified_at: null,
    probe: null,
    log: [],
    portless: { node: '/n', cli: null, state_dir: '/s', home: '/h' },
    ...over,
  };
}

function mount(node: React.ReactNode) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(node);
  });
  return host;
}

function view(over: Partial<FixedAddressViewProps> & { state: InboxNameState }) {
  const seen: string[] = [];
  const props: FixedAddressViewProps = {
    here: 'localhost:59054',
    moving: false,
    seen: {},
    asked: false,
    onSure: () => seen.push('sure'),
    onClose: () => seen.push('close'),
    onOpen: () => seen.push('open'),
    ...over,
  };
  const el = mount(<mod.FixedAddressView {...props} />);
  return { el, seen };
}

/** The words as read: each text node trimmed and joined with a space (as blocks render), no space before punctuation. */
function text(el: Element | null | undefined): string {
  if (!el) return '';
  const parts: string[] = [];
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walk.nextNode(); node; node = walk.nextNode()) {
    const value = node.textContent?.replace(/\s+/g, ' ').trim();
    if (value) parts.push(value);
  }
  return parts.join(' ').replace(/ ([.,;)])/g, '$1').replace(/:\/\/ /g, '://').replace(/\. (?=[a-z])/g, '.'); // a host drawn in parts (it may wrap at a dot) reads whole
}
const buttons = (el: Element) => [...el.querySelectorAll('.ib-fa-acts button, .ib-fa-acts .ib-fa-note')].map((b) => text(b));
const panel = (el: Element) => [...el.querySelectorAll('[data-fa-panel] .ib-fa-row')].map((row) => text(row));

describe.if(hasDom)('the fixed-address dialog, state by state', () => {
  test('the ask: the title, the address before and after, three facts, portless credited, Not now · Set it up', () => {
    const { el, seen } = view({ state: state() });
    expect(text(el.querySelector('h2'))).toBe('Give your localhost Inbox a fixed address');
    expect(text(el.querySelector('#ib-name-desc'))).toBe('Open it at inbox.plannotator.localhost, a URL you can remember, instead of a port number that can change.');
    expect(panel(el)).toEqual(['Now http://localhost:59054', 'After http://inbox.plannotator.localhost']);
    expect(el.querySelector('[data-fa-panel]')?.hasAttribute('data-intro')).toBe(true);
    expect([...el.querySelectorAll('.ib-fa-facts b')].map(text)).toEqual(['It all stays on this computer.', 'Just a convenience.', 'Your Mac asks for your password once.']);
    expect(text(el.querySelector('.ib-fa-facts li:nth-child(2) div > span'))).toContain('localhost:59054 keeps working');
    const link = el.querySelector('.ib-fa-credit a') as HTMLAnchorElement;
    expect(link.href).toBe('https://github.com/vercel-labs/portless');
    expect(link.rel).toContain('noopener');
    expect(buttons(el)).toEqual(['Not now', 'Set it up']);
    act(() => (el.querySelector('[data-name-sure]') as HTMLButtonElement).click());
    act(() => (el.querySelector('[data-name-later]') as HTMLButtonElement).click());
    expect(seen).toEqual(['sure', 'close']);
  });

  test('waiting for the password: names the Mac window to look for, a spinner on the address, Close only', () => {
    const { el } = view({ state: state({ status: 'working', step: 'password' }) });
    expect(el.querySelector('[data-fa-phase]')?.getAttribute('data-fa-phase')).toBe('password');
    expect(text(el.querySelector('h2'))).toBe('Type your Mac password');
    expect(text(el.querySelector('[data-fa-mac] b'))).toBe('Look for “osascript wants to make changes.”');
    expect(text(el.querySelector('[data-fa-mac]'))).toContain('It may be behind this one.');
    expect(el.querySelector('[data-fa-badge="busy"] .ib-fa-spin')).not.toBeNull();
    expect(el.querySelector('[data-fa-panel]')?.hasAttribute('data-busy')).toBe(false);
    expect(buttons(el)).toEqual(['Nothing changes until you type it.', 'Close']);
    // Fetching portless before the prompt reads the same: the password is next.
    const before = view({ state: state({ status: 'working', step: 'preparing' }) });
    expect(before.el.querySelector('[data-fa-phase]')?.getAttribute('data-fa-phase')).toBe('password');
  });

  test('Windows and Linux name their own prompt', () => {
    const win = view({ state: state({ status: 'working', step: 'password', platform: 'win32' }) });
    expect(text(win.el.querySelector('h2'))).toBe('Allow it in the Windows prompt');
    expect(text(win.el.querySelector('[data-fa-mac] b'))).toContain('Do you want to allow this app to make changes?');
    act(() => root?.unmount());
    const linux = view({ state: state({ platform: 'linux' }) });
    expect([...linux.el.querySelectorAll('.ib-fa-facts b')].map(text)[2]).toBe('Your computer asks for your password once.');
  });

  for (const [step, now, done] of [
    ['installing', 'Installing', ['Password accepted']],
    ['starting', 'Starting the address', ['Password accepted', 'Installing']],
    ['verifying', 'Checking it works', ['Password accepted', 'Installing', 'Starting the address']],
  ] as const) {
    test(`setting up, ${step}: the steps after the password, the current one spinning, the finished ones timed`, () => {
      const t0 = 1_000_000;
      const { el } = view({
        state: state({ status: 'working', step }),
        asked: true,
        seen: { installing: t0, starting: t0 + 400, verifying: t0 + 1000 },
      });
      expect(text(el.querySelector('h2'))).toBe('Setting up inbox.plannotator.localhost');
      expect(text(el.querySelector('#ib-name-desc'))).toBe('Password accepted. Almost there.');
      const rows = [...el.querySelectorAll('[data-fa-step]')];
      expect(rows.map((r) => r.getAttribute('data-fa-step'))).toEqual(['password', 'installing', 'starting', 'verifying']);
      expect(rows.filter((r) => r.getAttribute('data-s') === 'done').map((r) => text(r).replace(/ \d+\.\d s$/, ''))).toEqual([...done]);
      const current = rows.find((r) => r.getAttribute('data-s') === 'now')!;
      expect(text(current)).toBe(`${now} (in progress)`);
      expect(current.querySelector('.ib-fa-spin')).not.toBeNull();
      if (step === 'verifying') {
        expect(text(el.querySelector('[data-fa-step="installing"] .ib-fa-t'))).toBe('0.4 s');
        expect(text(el.querySelector('[data-fa-step="starting"] .ib-fa-t'))).toBe('0.6 s');
      }
      expect(el.querySelector('[data-fa-panel]')?.hasAttribute('data-busy')).toBe(true);
      expect(buttons(el)).toEqual(['This takes a few seconds.', 'Close']);
    });
  }

  test('setting up with no password asked (portless already on port 80): no "Password accepted" row', () => {
    const { el } = view({ state: state({ status: 'working', step: 'starting' }) });
    expect(text(el.querySelector('#ib-name-desc'))).toBe('Almost there.');
    expect(el.querySelector('[data-fa-step="password"]')).toBeNull();
  });

  test('done: the new address is now, a check on it, "Moving this tab there…" when this page asked, Open it', () => {
    const { el, seen } = view({ state: state({ status: 'on' }), moving: true });
    expect(text(el.querySelector('h2'))).toBe('Your Inbox has a fixed address');
    expect(panel(el)[1]).toBe('Now http://inbox.plannotator.localhost Ready');
    expect(el.querySelector('[data-fa-badge="ready"]')).not.toBeNull();
    expect(text(el.querySelector('[data-fa-moving]'))).toBe('Moving this tab there…');
    expect(buttons(el)).toEqual(['localhost:59054 still works too.', 'Open it']);
    act(() => (el.querySelector('[data-name-open]') as HTMLButtonElement).click());
    expect(seen).toEqual(['open']);
    act(() => root?.unmount());
    expect(view({ state: state({ status: 'on' }), moving: false }).el.querySelector('[data-fa-moving]')).toBeNull();
  });

  test('failed, port 80 taken: one plain cause naming what answered, nothing changed, quit it and try again', () => {
    const { el, seen } = view({ state: state({ status: 'failed', failure: 'port_taken', port_holder: 'nginx', reason: 'Port 80 is already used…' }) });
    expect(text(el.querySelector('h2'))).toBe('The fixed address is not set up');
    const box = el.querySelector('[data-fa-failed="port_taken"]')!;
    expect(box.getAttribute('role')).toBe('alert');
    expect(text(box)).toBe(
      'Another program on this computer already uses port 80 (it answered as “nginx”). The fixed address needs that port. Nothing changed; your Inbox stays at localhost:59054. Quit that program, then try again.',
    );
    expect(el.querySelector('[data-fa-badge="failed"]')).not.toBeNull();
    expect(buttons(el)).toEqual(['Close', 'Try again']);
    act(() => (el.querySelector('[data-name-sure]') as HTMLButtonElement).click());
    expect(seen).toEqual(['sure']);
    act(() => root?.unmount());
    // Nothing answered HTTP (EADDRINUSE after the prompt): the cause without a name.
    const noName = view({ state: state({ status: 'failed', failure: 'port_taken' }) });
    expect(text(noName.el.querySelector('[data-fa-failed] p'))).toBe('Another program on this computer already uses port 80. The fixed address needs that port.');
  });

  test('failed, the prompt cancelled: calm (a status, not an alert), Not now · Try again', () => {
    const { el } = view({ state: state({ status: 'failed', failure: 'cancelled', reason: 'You cancelled the password prompt. Nothing changed.' }) });
    const box = el.querySelector('[data-fa-failed="cancelled"]')!;
    expect(box.classList.contains('ib-fa-calm')).toBe(true);
    expect(box.getAttribute('role')).toBe('status');
    expect(text(box)).toBe('You closed the password window. Nothing changed. Your Inbox stays at localhost:59054.');
    expect(buttons(el)).toEqual(['Not now', 'Try again']);
  });

  test('failed for another reason: the server’s own words', () => {
    const { el } = view({ state: state({ status: 'failed', failure: 'other', reason: 'npm was not found next to /n.' }) });
    expect(text(el.querySelector('[data-fa-failed="other"]'))).toBe('npm was not found next to /n. Your Inbox stays at localhost:59054.');
  });
});

describe.if(hasDom)('the fixed-address dialog against a scripted server', () => {
  test('Set it up: password, then installing the moment the server says so, then starting, checking, done; the tab moves', async () => {
    // The server's answers, one per GET after the POST; the last one repeats.
    const script: Partial<InboxNameState>[] = [
      { status: 'working', step: 'password' },
      { status: 'working', step: 'installing' },
      { status: 'working', step: 'starting' },
      { status: 'working', step: 'verifying' },
      { status: 'on', step: null },
    ];
    let reads = 0;
    let posted = 0;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posted++;
        return new Response(JSON.stringify({ name: state({ status: 'working', step: 'preparing' }) }), { headers: { 'Content-Type': 'application/json' } });
      }
      const next = posted ? script[Math.min(reads++, script.length - 1)]! : {};
      return new Response(JSON.stringify({ name: state(next) }), { headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const went: string[] = [];
    const el = mount(<mod.FixedAddressDialog initial={state()} onClose={() => {}} assign={(url) => went.push(url)} />);
    const dialog = el.querySelector('dialog[data-dialog="fixed-address"]') as HTMLDialogElement;
    expect(dialog.classList.contains('ib-fa-dlg')).toBe(true);
    expect(document.activeElement?.textContent).toBe('Set it up');

    await act(async () => (dialog.querySelector('[data-name-sure]') as HTMLButtonElement).click());
    const phases: string[] = [];
    const spoken: string[] = [];
    const until = Date.now() + 5000;
    while (Date.now() < until && went.length === 0) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });
      const phase = `${dialog.querySelector('[data-fa-phase]')?.getAttribute('data-fa-phase')}:${dialog.querySelector('[data-name-step]')?.getAttribute('data-name-step')}`;
      if (phases.at(-1) !== phase) {
        phases.push(phase);
        // Each change puts focus on the title, since the button that had it may be gone.
        expect(document.activeElement?.tagName).toBe('H2');
      }
      const said = text(dialog.querySelector('[data-fa-live]'));
      if (said && spoken.at(-1) !== said) spoken.push(said);
    }
    expect(posted).toBe(1);
    expect(phases).toEqual(['password:preparing', 'password:password', 'setup:installing', 'setup:starting', 'setup:verifying', 'done:']);
    expect(spoken).toEqual([
      'Waiting for your password. It is asked in its own window.',
      'Password accepted. Installing.',
      'Starting the address.',
      'Checking it works.',
      'Done. Your Inbox is at inbox.plannotator.localhost.',
    ]);
    expect(went).toEqual(['http://inbox.plannotator.localhost/']);
    expect(dialog.querySelector('[data-fa-step="password"]')).toBeNull(); // done shows no steps
  }, 10_000);
});
