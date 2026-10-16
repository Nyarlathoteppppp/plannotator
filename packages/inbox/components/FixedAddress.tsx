/**
 * PROTOTYPE (proto/inbox-fixed-address, not for merge): the one-time
 * "Give your localhost Inbox a fixed address" dialog (approved variant
 * "Address bar", .product/approved/inbox-fixed-address-dialog/) and Settings → Devices' row.
 * Server: packages/server/inbox-name.ts. Sure runs portless's one privileged
 * step (the OS asks for the password), registers the name, verifies it, and
 * this page then moves to http://inbox.plannotator.localhost.
 */
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { inboxApi, type InboxNameState } from '../api';
import { Icon } from '../icons';
import { Modal } from './Updates';

const STEP_TEXT: Record<NonNullable<InboxNameState['step']>, string> = {
  preparing: 'Getting portless ready…',
  password: 'Waiting for your password. Your computer asks for it in its own window.',
  installing: 'Password accepted. Setting it up…',
  starting: 'Starting the address…',
  verifying: 'Checking the new address…',
};

/** How often the window reads the state while setup runs (the server moves a step within 250 ms of it happening). */
const SETUP_POLL_MS = 250;

export function stepText(state: InboxNameState): string {
  return state.step ? STEP_TEXT[state.step] : 'Starting…';
}

/** The fixed address's state, with on/off; polls every 250 ms while the server works. */
export function useFixedAddress(enabled: boolean) {
  const [state, setState] = useState<InboxNameState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  const poll = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const { name } = await inboxApi.nameState();
        if (!alive.current) return;
        setState(name);
        if (name.status === 'working') poll();
      } catch (e) {
        if (alive.current) setError(e instanceof Error ? e.message : String(e));
      }
    }, SETUP_POLL_MS);
  }, []);

  useEffect(() => {
    alive.current = true;
    if (!enabled) return;
    inboxApi
      .nameState()
      .then(({ name }) => {
        if (!alive.current) return;
        setState(name);
        if (name.status === 'working') poll();
      })
      .catch(() => {});
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [enabled, poll]);

  const set = useCallback(
    async (on: boolean) => {
      setError(null);
      try {
        const { name } = await inboxApi.setName(on);
        setState(name);
        if (name.status === 'working') poll();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [poll],
  );

  return { state, setState, error, turnOn: () => set(true), turnOff: () => set(false) };
}

/** Move this tab to the name (keeping the route), once it answers. */
export function goToName(state: InboxNameState, assign: (url: string) => void = (url) => location.assign(url)): void {
  if (location.host === state.host) return;
  assign(`${state.url.replace(/\/$/, '')}/${location.hash}`);
}

// ───────────────────────── The dialog (approved: "Address bar") ─────────────────────────
// Design of record: .product/approved/inbox-fixed-address-dialog/ (variant Address bar, 2026-10-16).
// The Now → After address panel stays on screen through every step; the words follow the server's
// steps (inbox-name.ts NameStep) and its failure kind.

/** What the dialog shows, from the server's state. */
export type DialogPhase = 'ask' | 'password' | 'setup' | 'done' | 'failed';
/** The setup rows after the password: the server's steps, with `verifying` read as "Checking it works". */
export const SETUP_ROWS = ['installing', 'starting', 'verifying'] as const;
export type SetupRow = (typeof SETUP_ROWS)[number];

export function dialogPhase(state: InboxNameState): DialogPhase {
  if (state.status === 'on') return 'done';
  if (state.status === 'failed') return 'failed';
  if (state.status !== 'working') return 'ask';
  // Before the prompt (fetching portless, or the first moment of Sure) reads as the password step: it is next.
  return state.step === 'installing' || state.step === 'starting' || state.step === 'verifying' ? 'setup' : 'password';
}

/** Which OS prompt asks, for the words. */
type Prompt = 'mac' | 'windows' | 'other';
const promptOf = (platform: string | undefined): Prompt => (platform === 'win32' ? 'windows' : platform === 'linux' ? 'other' : 'mac');

const WORDS = {
  mac: {
    fact: 'Your Mac asks for your password once.',
    title: 'Type your Mac password',
    lead: 'Your Mac needs it once to start the local helper that answers the new address.',
    look: 'Look for “osascript wants to make changes.”',
    where: 'macOS asks in its own window. It may be behind this one. Type your Mac password there.',
    wait: 'Nothing changes until you type it.',
    cancelled: 'You closed the password window.',
  },
  windows: {
    fact: 'Windows asks for your permission once.',
    title: 'Allow it in the Windows prompt',
    lead: 'Windows asks once, to start the local helper that answers the new address.',
    look: 'Look for “Do you want to allow this app to make changes?”',
    where: 'Windows asks in its own window. It may be behind this one. Choose Yes.',
    wait: 'Nothing changes until you choose Yes.',
    cancelled: 'You closed the Windows prompt.',
  },
  other: {
    fact: 'Your computer asks for your password once.',
    title: 'Type your password',
    lead: 'Your computer needs it once to start the local helper that answers the new address.',
    look: 'Look for “Authentication is needed.”',
    where: 'Your system asks in its own window. It may be behind this one.',
    wait: 'Nothing changes until you type it.',
    cancelled: 'You closed the password window.',
  },
} as const;

const ROW_LABEL: Record<SetupRow, string> = { installing: 'Installing', starting: 'Starting the address', verifying: 'Checking it works' };
const PORTLESS_URL = 'https://github.com/vercel-labs/portless';

/** What the polite live region says on each change. */
export function phaseSpeech(phase: DialogPhase, state: InboxNameState, prompt: Prompt = promptOf(state.platform)): string {
  if (phase === 'password') return prompt === 'windows' ? 'Waiting for you to allow it in the Windows prompt.' : 'Waiting for your password. It is asked in its own window.';
  if (phase === 'setup') return state.step === 'installing' ? 'Password accepted. Installing.' : state.step === 'starting' ? 'Starting the address.' : 'Checking it works.';
  if (phase === 'done') return `Done. Your Inbox is at ${state.host}.`;
  if (phase === 'failed') return state.failure === 'cancelled' ? `${WORDS[prompt].cancelled} Nothing changed.` : 'The fixed address is not set up.';
  return '';
}

/** Seconds, one decimal: "0.4 s". */
const seconds = (ms: number) => `${(Math.max(ms, 0) / 1000).toFixed(1)} s`;

export interface FixedAddressViewProps {
  state: InboxNameState;
  /** The page's own address, `localhost:59054` (the "Now" row). */
  here: string;
  /** This page pressed Set it up, so it moves itself once done. */
  moving: boolean;
  /** When each setup step was first seen (ms since epoch); the rows show how long the finished ones took. */
  seen: Partial<Record<SetupRow | 'password' | 'done', number>>;
  /** A password (or Windows prompt) was asked in this run: "Password accepted" heads the steps. */
  asked: boolean;
  onSure: () => void;
  onClose: () => void;
  onOpen: () => void;
}

/** A host name that may wrap only after a dot (a phone), never inside a word. */
function withDotBreaks(host: string): React.ReactNode {
  return host.split('.').map((part, i, all) => (
    <span key={i}>
      {part}
      {i < all.length - 1 ? '.' : ''}
      {i < all.length - 1 && <wbr />}
    </span>
  ));
}

/** The Now → After panel: the anchor in every state. */
function AddressPanel({ state, here, phase, intro }: { state: InboxNameState; here: string; phase: DialogPhase; intro: boolean }) {
  const badge =
    phase === 'done' ? (
      <span className="ib-fa-badge ib-fa-ok" data-fa-badge="ready">
        <Icon name="checkCircle" />
        <span className="ib-fa-sr">Ready</span>
      </span>
    ) : phase === 'password' || phase === 'setup' ? (
      <span className="ib-fa-badge" data-fa-badge="busy">
        <span className="ib-fa-spin" aria-hidden="true" />
        <span className="ib-fa-sr">{phase === 'password' ? 'Waiting' : 'Setting up'}</span>
      </span>
    ) : phase === 'failed' ? (
      <span className="ib-fa-badge ib-fa-warn" data-fa-badge="failed">
        <Icon name="warn" />
        <span className="ib-fa-sr">Not set up</span>
      </span>
    ) : null;
  return (
    <div className="ib-fa-omni" data-intro={intro ? '' : undefined} data-busy={phase === 'setup' ? '' : undefined} role="group" aria-label="The address, before and after" data-fa-panel="">
      <div className="ib-fa-row ib-fa-old">
        <span className="ib-fa-k">Now</span>
        <span className="ib-fa-v">
          <span className="ib-fa-sch">http://</span>
          {here}
        </span>
      </div>
      <div className="ib-fa-div" />
      <div className="ib-fa-row ib-fa-new">
        <span className="ib-fa-k">{phase === 'done' ? 'Now' : 'After'}</span>
        <span className="ib-fa-v">
          <span className="ib-fa-sch">http://</span>
          <span className="ib-fa-host">{withDotBreaks(state.host)}</span>
        </span>
        {badge}
      </div>
    </div>
  );
}

/** The dialog's body for one state (pure: the DOM tests render each state through it). */
export function FixedAddressView({ state, here, moving, seen, asked, onSure, onClose, onOpen }: FixedAddressViewProps) {
  const phase = dialogPhase(state);
  const prompt = promptOf(state.platform);
  const words = WORDS[prompt];
  const at = phase === 'setup' ? SETUP_ROWS.indexOf(state.step as SetupRow) : -1;

  let title: string;
  let lead: React.ReactNode = null;
  let body: React.ReactNode = null;
  if (phase === 'ask') {
    title = 'Give your localhost Inbox a fixed address';
    lead = (
      <>
        Open it at <b>{state.host}</b>, a URL you can remember, instead of a port number that can change.
      </>
    );
    body = (
      <>
        <ul className="ib-fa-facts">
          <li>
            <span className="ib-fa-fi"><Icon name="home" /></span>
            <div><b>It all stays on this computer.</b><span>A nicer name for localhost. Nothing goes online.</span></div>
          </li>
          <li>
            <span className="ib-fa-fi"><Icon name="link" /></span>
            <div><b>Just a convenience.</b><span>{here} keeps working, and nothing your agents use changes.</span></div>
          </li>
          <li>
            <span className="ib-fa-fi"><Icon name="key" /></span>
            <div><b>{words.fact}</b><span>To start the small local helper that answers the name.</span></div>
          </li>
        </ul>
        <p className="ib-fa-credit">
          Uses{' '}
          <a className="ib-lnk" href={PORTLESS_URL} target="_blank" rel="noopener noreferrer">
            portless
          </a>
          , a small open-source tool, under the hood.
        </p>
      </>
    );
  } else if (phase === 'password') {
    title = words.title;
    lead = words.lead;
    body = (
      <div className="ib-fa-mac" data-fa-mac="">
        <span className="ib-fa-mac-ic"><Icon name="lock" /></span>
        <div className="ib-fa-mac-t"><b>{words.look}</b><span>{words.where}</span></div>
      </div>
    );
  } else if (phase === 'setup') {
    title = `Setting up ${state.host}`;
    lead = asked ? 'Password accepted. Almost there.' : 'Almost there.';
    const rows: { key: string; label: string; s: 'done' | 'now' | 'next'; took?: string }[] = [];
    if (asked) rows.push({ key: 'password', label: prompt === 'windows' ? 'Allowed' : 'Password accepted', s: 'done' });
    SETUP_ROWS.forEach((row, i) => {
      const s = i < at ? 'done' : i === at ? 'now' : 'next';
      const start = seen[row];
      const end = SETUP_ROWS[i + 1] ? seen[SETUP_ROWS[i + 1]!] : undefined;
      rows.push({ key: row, label: ROW_LABEL[row], s, took: s === 'done' && start !== undefined && end !== undefined ? seconds(end - start) : undefined });
    });
    body = (
      <ol className="ib-fa-steps" aria-label="Setup steps">
        {rows.map((row) => (
          <li key={row.key} data-s={row.s} data-fa-step={row.key}>
            <span className="ib-fa-dot">{row.s === 'done' ? <Icon name="check" /> : row.s === 'now' ? <span className="ib-fa-spin" aria-hidden="true" /> : <i />}</span>
            {row.label}
            {row.s === 'now' && <span className="ib-fa-sr"> (in progress)</span>}
            {row.took && <span className="ib-fa-t">{row.took}</span>}
          </li>
        ))}
      </ol>
    );
  } else if (phase === 'done') {
    title = 'Your Inbox has a fixed address';
    lead = 'Bookmark it: links and notifications keep working when the Inbox’s port changes.';
    body = moving ? (
      <div className="ib-fa-status" data-fa-moving="">
        <span className="ib-fa-spin" aria-hidden="true" />
        Moving this tab there…
      </div>
    ) : null;
  } else {
    title = 'The fixed address is not set up';
    const calm = state.failure === 'cancelled' || state.failure === 'timed_out';
    body = calm ? (
      <div className="ib-fa-err ib-fa-calm" role="status" data-fa-failed={state.failure ?? ''}>
        <Icon name="info" />
        <div>
          <p>
            <b>{state.failure === 'timed_out' ? 'The password window closed without an answer.' : words.cancelled}</b> Nothing changed.
          </p>
          <p>Your Inbox stays at {here}.</p>
        </div>
      </div>
    ) : state.failure === 'port_taken' ? (
      <div className="ib-fa-err" role="alert" data-fa-failed="port_taken">
        <Icon name="warn" />
        <div>
          <p>
            <b>Another program on this computer already uses port 80</b>
            {state.port_holder ? ` (it answered as “${state.port_holder}”)` : ''}. The fixed address needs that port.
          </p>
          <p>Nothing changed; your Inbox stays at {here}. Quit that program, then try again.</p>
        </div>
      </div>
    ) : (
      <div className="ib-fa-err" role="alert" data-fa-failed="other">
        <Icon name="warn" />
        <div>
          <p>{state.reason ?? 'It did not work.'}</p>
          <p>Your Inbox stays at {here}.</p>
        </div>
      </div>
    );
  }

  let actions: React.ReactNode;
  if (phase === 'ask') {
    actions = (
      <>
        <button type="button" className="ib-btn ib-ghost ib-fa-left" data-name-later="" onClick={onClose}>Not now</button>
        <button type="button" className="ib-btn ib-pri" data-name-sure="" onClick={onSure}>Set it up</button>
      </>
    );
  } else if (phase === 'password' || phase === 'setup') {
    actions = (
      <>
        <span className="ib-fa-note">{phase === 'password' ? words.wait : 'This takes a few seconds.'}</span>
        <button type="button" className="ib-btn ib-ghost" data-name-later="" onClick={onClose}>Close</button>
      </>
    );
  } else if (phase === 'done') {
    actions = (
      <>
        <span className="ib-fa-note">{here} still works too.</span>
        <button type="button" className="ib-btn ib-pri" data-name-open="" onClick={onOpen}>Open it</button>
      </>
    );
  } else {
    actions = (
      <>
        <button type="button" className="ib-btn ib-ghost ib-fa-left" data-name-later="" onClick={onClose}>
          {state.failure === 'cancelled' || state.failure === 'timed_out' ? 'Not now' : 'Close'}
        </button>
        <button type="button" className="ib-btn ib-pri" data-name-sure="" onClick={onSure}>Try again</button>
      </>
    );
  }

  return (
    <div className="ib-fa" data-name-status={state.status} data-name-step={state.step ?? ''} data-fa-phase={phase}>
      <h2 id="ib-name-title" tabIndex={-1}>{title}</h2>
      {lead && <p className="ib-fa-lead" id="ib-name-desc">{lead}</p>}
      <AddressPanel state={state} here={here} phase={phase} intro={phase === 'ask'} />
      {body}
      <div className="ib-fa-acts">{actions}</div>
    </div>
  );
}

export interface FixedAddressDialogProps {
  initial: InboxNameState;
  onClose: () => void;
  /** Tests: where the tab would go (default `location.assign`). */
  assign?: (url: string) => void;
}

/** The one-time offer, on the Inbox's Modal; polls the server's steps while it works. */
export function FixedAddressDialog({ initial, onClose, assign }: FixedAddressDialogProps) {
  const name = useFixedAddress(true);
  const state = name.state ?? initial;
  const [moving, setMoving] = useState(false);
  const [seen, setSeen] = useState<FixedAddressViewProps['seen']>({});
  const [asked, setAsked] = useState(false);
  const phase = dialogPhase(state);
  const here = typeof location !== 'undefined' ? location.host : 'localhost';
  const wrap = useRef<HTMLDivElement>(null);
  const [speech, setSpeech] = useState('');

  // When each step was first seen, for the finished rows' times.
  useEffect(() => {
    const key = phase === 'done' ? 'done' : phase === 'setup' ? (state.step as SetupRow) : state.step === 'password' ? 'password' : null;
    if (key && seen[key] === undefined) setSeen((prev) => ({ ...prev, [key]: Date.now() }));
    if (state.step === 'password' || state.step === 'installing') setAsked(true);
  }, [phase, state.step, seen]);

  // Each change of state: focus the title (the button that had focus may be gone) and say it once.
  const said = useRef(`${phase}:${state.step ?? ''}`);
  useEffect(() => {
    const now = `${phase}:${state.step ?? ''}`;
    if (said.current === now) return;
    said.current = now;
    setSpeech(phaseSpeech(phase, state));
    wrap.current?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
  }, [phase, state]);

  // Done after this page asked: a short beat so "Done" is seen, then the tab moves.
  useEffect(() => {
    if (moving && state.status === 'on') {
      const id = setTimeout(() => goToName(state, assign), 400);
      return () => clearTimeout(id);
    }
  }, [moving, state, assign]);

  return (
    <Modal labelledBy="ib-name-title" describedBy="ib-name-desc" testId="fixed-address" onClose={onClose} ownKeys className="ib-fa-dlg">
      <div ref={wrap} data-fa-wrap="">
        <FixedAddressView
          state={state}
          here={here}
          moving={moving}
          seen={seen}
          asked={asked}
          onSure={() => {
            setMoving(true);
            setSeen({});
            setAsked(false);
            void name.turnOn();
          }}
          onClose={onClose}
          onOpen={() => goToName(state, assign)}
        />
        {name.error && (
          <div className="ib-callout ib-err" role="alert">
            <Icon name="xCircle" />
            <span>{name.error}</span>
          </div>
        )}
        <div className="ib-fa-sr" aria-live="polite" data-fa-live="">
          {speech}
        </div>
      </div>
    </Modal>
  );
}

/** Settings → Devices: the fixed address, on/off, its state and Try again. */
export function FixedAddressSection({ via, localUrl }: { via: 'local' | 'tailnet'; localUrl: string }) {
  const remote = via === 'tailnet';
  const name = useFixedAddress(!remote);
  const state = name.state;
  // Nothing at all unless the prototype is switched on in the Inbox's environment.
  if (remote || !state || !state.prototype) return null;
  const here = state && typeof location !== 'undefined' && location.host === state.host;
  return (
    <section className="ib-sgroup" data-settings-fixed-address="" aria-labelledby="ib-g-name">
      <h2 id="ib-g-name">Fixed address</h2>
      <p>The Inbox at {state?.host ?? 'inbox.plannotator.localhost'} on this computer, whatever port it runs on. Prototype, through portless.</p>
      <div className="ib-card">
        <div className="ib-prow" data-name-row={state?.status ?? 'loading'}>
          <span className="ib-txt">
            <span className="ib-l">{state?.status === 'on' ? state.url : 'http://inbox.plannotator.localhost'}</span>
            <span className="ib-desc">
              {!state
                ? 'Checking…'
                : state.status === 'on'
                  ? `On${here ? ', and this page uses it' : ''}.${state.reason ? ` ${state.reason}` : ''}`
                  : state.status === 'off'
                    ? 'Off. The Inbox is at localhost and its port.'
                    : state.status === 'working'
                      ? stepText(state)
                      : state.status === 'unavailable'
                        ? `Not available: ${state.reason ?? ''}`
                        : `Did not work: ${state.reason ?? ''}`}
            </span>
            {state?.probe && <span className="ib-desc">Last check: {state.probe}</span>}
          </span>
          <span className="ib-ctl">
            {state?.status === 'on' && !here && (
              <button type="button" className="ib-btn" onClick={() => goToName(state)}>
                Open it
              </button>
            )}
            {state && state.status !== 'unavailable' && (
              <button
                type="button"
                className={`ib-btn${state.status === 'on' ? '' : ' ib-pri'}`}
                disabled={state.status === 'working'}
                data-name-toggle={state.status}
                onClick={() => {
                  if (state.status !== 'on') return void name.turnOn();
                  // This page came through the name: its listener closes, so go back to localhost.
                  void name.turnOff().then(() => {
                    if (here) location.assign(`${localUrl.replace(/\/$/, '')}/${location.hash}`);
                  });
                }}
              >
                {state.status === 'on' ? 'Turn off' : state.status === 'failed' ? 'Try again' : 'Turn on'}
              </button>
            )}
          </span>
        </div>
      </div>
      {name.error && (
        <div className="ib-callout ib-err" role="alert">
          <Icon name="xCircle" />
          <span>{name.error}</span>
        </div>
      )}
    </section>
  );
}
