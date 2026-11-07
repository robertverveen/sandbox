/** App-schil: zijbalk, werkvlak, inspector, palet, hulp, toast en het toetsenbordmodel. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { bucketDate, DAY_CAP, inbox, openCommits, pd, plannedOn, short } from '@hz/shared/logic';
import logo from '../assets/logo.svg';
import { decide, isTyping, KBD_MODE_KEYS, type KeyState } from '../lib/keyboard';
import { Icon, type IconName } from '../lib/icons';
import { useDagstart, useSession } from '../lib/queries';
import { OnboardingNudge } from './OnboardingNudge';
import { toggleTheme, useUi } from '../lib/ui';
import { Help } from './Help';
import { Inspector } from './Inspector';
import { Palette } from './Palette';

const NAV: Array<{ to: string; icon: IconName; label: string; key: string }> = [
  { to: '/dagstart', icon: 'sun', label: 'Dagstart', key: 'd' },
  { to: '/planning', icon: 'inbox', label: 'Planning', key: 'p' },
  { to: '/agenda', icon: 'meeting', label: 'Agenda', key: 'a' },
  { to: '/tracker', icon: 'commit', label: 'Tracker', key: 't' },
  { to: '/chat', icon: 'chat', label: 'Chat', key: 'c' },
];

function Sidebar() {
  const loc = useLocation();
  const ui = useUi();
  const d = useDagstart().data;
  const session = useSession().data;
  const now = d ? pd(d.now) : null;
  const counts: Record<string, { n: string | number; hot?: boolean }> = {};
  if (d && now) {
    counts['/dagstart'] = { n: inbox(d.items, now).length };
    const todayN = plannedOn(d.items, bucketDate(d.items, 1, now), now).length;
    counts['/planning'] = { n: todayN ? `${todayN}/${DAY_CAP}` : '', hot: todayN > DAY_CAP };
    const late = openCommits(d.items).filter((c) => c.status === 'te_laat').length;
    counts['/tracker'] = { n: late || '', hot: late > 0 };
  }
  const active = (to: string) => loc.pathname === to || (to === '/dagstart' && loc.pathname === '/');
  const demo = session?.mode === 'fixture' && session.fixtureSet === 'demo';
  return (
    <aside className="sidebar" id="sidebar" aria-label="Navigatie">
      <div className="brand">
        <img className="brand-logo" src={logo} alt="HomeZero" />
        {demo && <span>voorbeeld</span>}
      </div>
      <button type="button" className="searchbtn" data-action="palette" onClick={() => ui.setPalette(true)}>
        <Icon name="search" />
        <span>Zoeken</span>
        <span className="kbd">⌘K</span>
      </button>
      <nav className="nav">
        <div className="nav-group">
          {NAV.map((n) => {
            const c = counts[n.to];
            return (
              <Link
                key={n.to}
                to={n.to}
                className={`nav-item${active(n.to) ? ' active' : ''}`}
                aria-current={active(n.to) ? 'page' : undefined}
                onClick={() => ui.setNavOpen(false)}
              >
                <Icon name={n.icon} />
                {n.label}
                {c && c.n !== '' && c.n !== 0 ? <span className={`count${c.hot ? ' hot' : ''}`}>{c.n}</span> : null}
                <span className="kbd nav-kbd" aria-hidden="true">
                  g {n.key}
                </span>
              </Link>
            );
          })}
        </div>
      </nav>
      <OnboardingNudge />
      <div className="sources quiet-foot">
        <button
          type="button"
          className="foot-btn"
          data-action="help"
          onClick={() => ui.setHelp(true)}
          aria-label="Sneltoetsen"
        >
          <span className="sd" style={{ background: session?.mode === 'live' ? 'var(--accent)' : 'var(--faint)' }} />
          <span className="kbd">?</span>
        </button>
        <Link
          to="/instellingen"
          className="iconbtn theme-btn set-btn"
          aria-label="Instellingen en koppelingen"
          title="Instellingen (g i)"
          onClick={() => ui.setNavOpen(false)}
        >
          <Icon name="gear" />
        </Link>
        <button
          type="button"
          className="iconbtn theme-btn"
          onClick={() => toggleTheme()}
          aria-label="Wissel licht en donker"
          title="Licht of donker"
        >
          <Icon name="sun" />
        </button>
      </div>
    </aside>
  );
}

function Topbar() {
  const ui = useUi();
  return (
    <div className="topbar">
      <button
        type="button"
        className="iconbtn"
        data-action="nav"
        aria-label="Menu"
        onClick={() => ui.setNavOpen(!ui.navOpen)}
      >
        <Icon name="menu" />
      </button>
      <button type="button" className="searchbtn" data-action="palette" onClick={() => ui.setPalette(true)}>
        <Icon name="search" />
        <span>Zoeken</span>
        <span className="kbd">⌘K</span>
      </button>
    </div>
  );
}

const HINTS: Record<string, Array<[string, string]>> = {
  reply: [
    ['1–5', 'plannen'],
    ['e', 'gelezen'],
    ['w', 'wachten op'],
    ['b', 'bespreken'],
    ['o', 'openen'],
  ],
  mega: [
    ['1–5', 'plannen'],
    ['e', 'afgehandeld'],
    ['o', 'openen'],
  ],
  task: [
    ['1–5', 'plannen'],
    ['x', 'klaar'],
    ['o', 'Google Tasks'],
  ],
  commit: [
    ['1–5', 'plannen'],
    ['x', 'klaar'],
    ['b', 'bespreken'],
    ['o', 'bron'],
  ],
  waiting: [
    ['x', 'binnen'],
    ['1–4', 'reminder'],
    ['5', 'parkeren'],
    ['o', 'thread'],
  ],
  bespreken: [
    ['x', 'besproken'],
    ['o', 'bron'],
  ],
  invite: [
    ['y', 'ja'],
    ['m', 'misschien'],
    ['n', 'nee'],
    ['o', 'Google Agenda'],
  ],
  prep: [
    ['1–4', 'prep plannen'],
    ['5', 'geen prep'],
    ['r', 'recap met Claude'],
    ['o', 'Google Agenda'],
  ],
  meeting: [
    ['1–4', 'prep plannen'],
    ['r', 'recap met Claude'],
    ['o', 'Google Agenda'],
  ],
  process: [
    ['e', 'geen recap nodig'],
    ['r', 'recap met Claude'],
    ['t', 'afspraken naar tracker'],
    ['o', 'Wispr'],
  ],
  conn: [
    ['↵', 'rechten'],
    ['v', 'verbinden'],
    ['⇧1–3', 'tab'],
  ],
  other: [['↵', 'openen']],
};

function HintBar({ focus }: { focus: { id: string | null; kind: string; title: string } }) {
  const hints = HINTS[focus.kind] ?? HINTS.other!;
  return (
    <div className="hintbar" id="hintbar" aria-live="polite">
      {focus.title && <span className="hb-title">{short(focus.title, 46)}</span>}
      {[['j k', 'bewegen'] as [string, string], ['↵', 'details'] as [string, string], ...hints].map(([k, l]) => (
        <span key={k + l}>
          <span className="kbd">{k}</span>
          {l}
        </span>
      ))}
      <span>
        <span className="kbd">?</span>alles
      </span>
    </div>
  );
}

/** Focus (kf) op de rijen in het werkvlak, zoals applyFocus() in het prototype; overleeft her-renders. */
function useRowFocus(mainRef: React.RefObject<HTMLElement | null>) {
  const focusId = useRef<string | null>(null);
  const idx = useRef(0);
  const listeners = useRef(new Set<() => void>());
  const apply = (scroll: boolean) => {
    const main = mainRef.current;
    if (!main) return;
    const rows = [...main.querySelectorAll<HTMLElement>('[data-k]')];
    rows.forEach((r) => r.classList.remove('kf'));
    if (!rows.length) return;
    let i = focusId.current ? rows.findIndex((r) => r.dataset.k === focusId.current) : -1;
    if (i < 0) i = Math.min(Math.max(0, idx.current), rows.length - 1);
    idx.current = i;
    focusId.current = rows[i]!.dataset.k ?? null;
    rows[i]!.classList.add('kf');
    if (scroll) rows[i]!.scrollIntoView({ block: 'nearest' });
    listeners.current.forEach((f) => f());
  };
  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const mo = new MutationObserver(() => {
      if (document.body.classList.contains('kbd-mode') && focusId.current && !main.querySelector('.kf')) apply(false);
    });
    mo.observe(main, { childList: true, subtree: true });
    return () => mo.disconnect();
  });
  // Alleen refs: één stabiel object per Shell, zodat effecten niet bij elke render opnieuw koppelen.
  return useMemo(
    () => ({
      move(delta: number) {
        const rows = mainRef.current ? [...mainRef.current.querySelectorAll<HTMLElement>('[data-k]')] : [];
        if (!rows.length) return;
        const cur = focusId.current ? rows.findIndex((r) => r.dataset.k === focusId.current) : -1;
        idx.current = cur < 0 ? 0 : Math.min(Math.max(0, cur + delta), rows.length - 1);
        focusId.current = rows[idx.current]!.dataset.k ?? null;
        apply(true);
      },
      reset() {
        focusId.current = null;
        idx.current = 0;
      },
      current: () => focusId.current,
      currentEl: () => mainRef.current?.querySelector<HTMLElement>('.kf') ?? null,
      subscribe(f: () => void) {
        listeners.current.add(f);
        return () => {
          listeners.current.delete(f);
        };
      },
    }),
    [],
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const ui = useUi();
  const nav = useNavigate();
  const loc = useLocation();
  const mainRef = useRef<HTMLElement | null>(null);
  const hintRef = useRef<{ id: string | null; kind: string; title: string }>({ id: null, kind: 'other', title: '' });
  const focus = useRowFocus(mainRef);
  const keyState = useRef<KeyState>({ gAt: null });
  const uiRef = useRef(ui);
  uiRef.current = ui;
  const [, setHintTick] = useState(0);

  // Bij een ander scherm: focus en selectie terug naar boven.
  useEffect(() => {
    focus.reset();
    mainRef.current?.scrollTo?.({ top: 0 });
    // focus is stabiel per render-boom; alleen het pad telt hier.
  }, [loc.pathname]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const u = uiRef.current;
      if (KBD_MODE_KEYS.test(ev.key) && !ev.metaKey && !ev.ctrlKey && !isTyping(document.activeElement))
        document.body.classList.add('kbd-mode');
      if (u.palette && !((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'k')) return; // het palet regelt zijn eigen toetsen
      const r = decide(keyState.current, {
        key: ev.key,
        meta: ev.metaKey,
        ctrl: ev.ctrlKey,
        alt: ev.altKey,
        typing: isTyping(document.activeElement),
        path: loc.pathname,
      });
      keyState.current = r.state;
      const a = r.action;
      if (u.help && a.type !== 'escape' && a.type !== 'help') return;
      switch (a.type) {
        case 'palette':
          ev.preventDefault();
          u.setPalette(!u.palette);
          break;
        case 'help':
          ev.preventDefault();
          u.setHelp(!u.help);
          break;
        case 'escape':
          if (u.help) u.setHelp(false);
          else if (isTyping(document.activeElement)) (document.activeElement as HTMLElement).blur();
          else if (u.selected) u.select(null);
          else if (u.navOpen) u.setNavOpen(false);
          break;
        case 'go':
          ev.preventDefault();
          nav(a.to);
          break;
        case 'move':
          ev.preventDefault();
          focus.move(a.delta);
          break;
        case 'open': {
          const id = focus.current();
          if (id && !(document.activeElement instanceof HTMLButtonElement && !document.activeElement.dataset.k)) {
            ev.preventDefault();
            u.select(id);
          }
          break;
        }
        case 'plansessie':
          ev.preventDefault();
          u.toast('De plansessie komt in een volgend stuk');
          break;
        default:
          break;
      }
    };
    let mouseT = 0;
    const onMouse = () => {
      if (Date.now() - mouseT > 400) {
        mouseT = Date.now();
        document.body.classList.remove('kbd-mode');
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousemove', onMouse);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousemove', onMouse);
    };
  }, [nav, loc.pathname, focus]);

  // Hintbalk volgt het gefocuste item (zonder het hele werkvlak opnieuw te tekenen).
  useEffect(
    () =>
      focus.subscribe(() => {
        const el = focus.currentEl();
        hintRef.current = {
          id: el?.dataset.k ?? null,
          kind: el?.dataset.kind ?? 'other',
          title: el?.querySelector('.row-title')?.textContent ?? '',
        };
        setHintTick((t) => t + 1);
      }),
    [focus],
  );

  return (
    <>
      <div className={`app${ui.selected ? ' has-inspector' : ''}${ui.navOpen ? ' nav-open' : ''}`} id="app">
        <Sidebar />
        <main
          className="main"
          id="main"
          ref={mainRef}
          onClick={(e) => {
            if (ui.navOpen && !(e.target as Element).closest('.sidebar')) ui.setNavOpen(false);
          }}
        >
          <Topbar />
          {children}
          <HintBar focus={hintRef.current} />
        </main>
        <Inspector />
      </div>
      {ui.palette && <Palette />}
      {ui.help && <Help />}
      {ui.toastMsg && (
        <div className="toast" role="status">
          {ui.toastMsg}
        </div>
      )}
    </>
  );
}
