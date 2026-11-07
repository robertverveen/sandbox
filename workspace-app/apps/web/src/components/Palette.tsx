/**
 * ⌘K-palet: commando's, organisaties uit het register met komma-verfijning, gesprekken (kanalen, DM's,
 * mail), items per bron en de contextlaag; ⌘↵ zet de zoekopdracht vast (POST /api/pins).
 * Het zoek-stuk voegt de resultatenpagina met tijdlijn en Gantt toe.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type { Conversation, Item } from '@hz/shared';
import { dayLabel, hashColor, initialsOf, avTone, pd, short } from '@hz/shared/logic';
import { Icon, type IconName } from '../lib/icons';
import { searchEntries, type Entry as SearchEntry } from '../lib/palette';
import { useAddPin, useConversations, useDagstart } from '../lib/queries';
import { toggleTheme, useUi } from '../lib/ui';
import { itemSub, relTime, SRC, SrcLabel } from './Row';

export { matchPartners } from '../lib/palette';

interface Command {
  label: string;
  hint: string;
  icon: IconName;
  run: () => void;
}

type Entry = Exclude<SearchEntry, { kind: 'cmd' }> | { kind: 'cmd'; c: Command };

const SRC_PLURAL = Object.fromEntries(Object.entries(SRC).map(([k, v]) => [k, v.plural])) as Record<
  Item['type'],
  string
>;

function convSub(c: Conversation) {
  return short(c.preview || (c.kind === 'ch' ? 'Slack-kanaal' : c.kind === 'mail' ? 'Mail' : 'Direct bericht'), 90);
}

export function Palette() {
  const ui = useUi();
  const nav = useNavigate();
  const d = useDagstart().data;
  const [q, setQ] = useState('');
  const convs = useConversations(q.trim().length > 0).data?.conversations;
  const addPin = useAddPin();
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const res = useRef<HTMLDivElement>(null);
  const close = () => ui.setPalette(false);

  const commands: Command[] = useMemo(
    () => [
      { label: 'Ga naar Dagstart', hint: 'g d', icon: 'sun', run: () => nav('/dagstart') },
      { label: 'Ga naar Planning', hint: 'g p', icon: 'inbox', run: () => nav('/planning') },
      { label: 'Ga naar Agenda', hint: 'g a', icon: 'meeting', run: () => nav('/agenda') },
      { label: 'Ga naar Tracker', hint: 'g t', icon: 'commit', run: () => nav('/tracker') },
      { label: 'Ga naar Chat', hint: 'g c', icon: 'chat', run: () => nav('/chat') },
      { label: 'Toon sneltoetsen', hint: '?', icon: 'search', run: () => ui.setHelp(true) },
      {
        label: 'Start plansessie',
        hint: 's',
        icon: 'inbox',
        run: () => ui.toast('De plansessie komt in een volgend stuk'),
      },
      { label: 'Wissel licht/donker', hint: 'thema', icon: 'sun', run: () => toggleTheme() },
    ],
    [nav, ui],
  );

  const search = useMemo(() => {
    const t = q.trim();
    if (!t || t.startsWith('>')) return null;
    return searchEntries(t, {
      items: d?.items ?? [],
      partners: Object.values(d?.context.partners ?? {}),
      conversations: convs ?? [],
      context: d?.context,
      srcPlural: SRC_PLURAL,
    });
  }, [q, d, convs]);

  const entries: Entry[] = useMemo(() => {
    const t = q.trim();
    if (t.startsWith('>')) {
      const rest = t.slice(1).trim().toLowerCase();
      return commands.filter((c) => !rest || c.label.toLowerCase().includes(rest)).map((c) => ({ kind: 'cmd', c }));
    }
    if (!search) return commands.slice(0, 5).map((c) => ({ kind: 'cmd', c }));
    const out: Entry[] = search.entries.filter((e): e is Exclude<SearchEntry, { kind: 'cmd' }> => e.kind !== 'cmd');
    if (!out.some((e) => e.kind === 'live')) out.unshift({ kind: 'live', q: t, title: t, mode: 'list' });
    for (const c of commands) if (c.label.toLowerCase().includes(t.toLowerCase())) out.push({ kind: 'cmd', c });
    return out;
  }, [q, search, commands]);

  const pin = () => {
    const t = q.trim();
    if (!t || t.startsWith('>')) return;
    const label = search?.entries.find((e) => e.kind === 'live')?.title ?? t;
    close();
    addPin.mutate(
      { kind: 'search', label: short(label, 80), q: t },
      {
        onSuccess: () => ui.toast(`Vastgezet in de zijbalk: ${label}`),
        onError: () => ui.toast('Vastzetten lukte niet'),
      },
    );
  };

  useEffect(() => input.current?.focus(), []);
  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    res.current?.querySelector('.active')?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  const pick = (i: number) => {
    const en = entries[i];
    if (!en) return;
    close();
    if (en.kind === 'cmd') en.c.run();
    else if (en.kind === 'entity') nav(`/o/${en.p.slug}`);
    else if (en.kind === 'live') nav(`/zoeken?q=${encodeURIComponent(en.q)}`);
    else if (en.kind === 'item') ui.select(en.it.id);
    else if (en.kind === 'conv') nav(`/chat?c=${encodeURIComponent(en.c.key)}`);
    else if (en.kind === 'ctx') nav(`/o/${en.h.slug}`);
  };

  const onKey = (ev: React.KeyboardEvent) => {
    if (['Enter', 'Escape', 'ArrowUp', 'ArrowDown'].includes(ev.key)) ev.stopPropagation();
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      setActive((a) => Math.min(a + 1, entries.length - 1));
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      pin();
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      pick(active);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      close();
    }
  };

  const now = d ? pd(d.now) : new Date();
  const titles: Record<string, string> = {
    cmd: 'Commando’s',
    entity: 'Organisatie',
    live: 'Zoeken',
    conv: 'Gesprekken',
  };
  let last: string | null = null;
  const rows: React.ReactNode[] = [];
  entries.forEach((en, i) => {
    const g = en.kind === 'item' ? en.it.type : en.kind === 'ctx' ? 'context' : en.kind;
    if (g !== last) {
      const type = en.kind === 'item' ? en.it.type : en.kind === 'ctx' ? 'context' : null;
      rows.push(
        <div className="group-label" key={'g' + g + i}>
          {type ? (
            <>
              <SrcLabel type={type} />
              <span>{search?.counts[type] || ''}</span>
            </>
          ) : (
            titles[g]
          )}
        </div>,
      );
      last = g;
    }
    const a = i === active ? ' active' : '';
    const common = {
      'data-pi': i,
      onMouseMove: () => setActive(i),
      onClick: () => pick(i),
      role: 'option',
      'aria-selected': i === active,
    };
    if (en.kind === 'entity') {
      const col = hashColor(en.p.slug);
      rows.push(
        <div key={i} className={`pal-entity${a}`} {...common}>
          <div
            className="entity-logo"
            style={{ background: `color-mix(in srgb, ${col} 16%, var(--panel))`, color: col }}
          >
            {en.p.naam.slice(0, 2).toUpperCase()}
          </div>
          <div className="row-main">
            <div style={{ fontWeight: 600 }}>
              {en.p.naam}{' '}
              <span className="sub" style={{ fontWeight: 400 }}>
                · {en.p.soort === 'project' ? 'Project' : 'Partner'}
                {en.p.fase ? ` · ${en.p.fase}` : ''}
              </span>
            </div>
            <div className="sub" style={{ fontSize: 12.5 }}>
              {en.counts || 'nog geen items'}
            </div>
          </div>
          <span className="enter kbd">↵</span>
        </div>,
      );
    } else if (en.kind === 'item') {
      rows.push(
        <div key={i} className={`pal-item${a}`} {...common}>
          <span className={`ic ${en.it.type}`}>
            <Icon name={SRC[en.it.type].icon} />
          </span>
          <div className="row-main">
            <div className="row-title">{short(en.it.title, 80)}</div>
            <div className="row-sub">{itemSub(en.it)}</div>
          </div>
          <span className="row-meta">{relTime(en.it, now)}</span>
        </div>,
      );
    } else if (en.kind === 'live') {
      rows.push(
        <div key={i} className={`pal-item pal-live${a}`} {...common}>
          <span className="ic">
            <Icon name={en.mode === 'list' ? 'search' : 'meeting'} />
          </span>
          <div className="row-main">
            <div className="row-title">
              {en.mode === 'timeline' ? 'Tijdlijn' : en.mode === 'gantt' ? 'Gantt' : 'Zoek overal'}: <b>{en.title}</b>
            </div>
            <div className="row-sub">Live in Slack en Gmail, plus agenda, taken, tracker en de contextlaag</div>
          </div>
          <span className="enter kbd">↵</span>
        </div>,
      );
    } else if (en.kind === 'conv') {
      const c = en.c;
      const [bg, fg] = avTone(c.name);
      rows.push(
        <div key={i} className={`pal-item${a}`} {...common}>
          <span className="ic">
            {c.kind === 'mail' ? (
              <Icon name="mail" />
            ) : c.kind === 'ch' ? (
              <Icon name="slack" />
            ) : (
              <span className="avatar" style={{ width: 22, height: 22, fontSize: 9, background: bg, color: fg }}>
                {initialsOf(c.name)}
              </span>
            )}
          </span>
          <div className="row-main">
            <div className="row-title">
              {c.kind === 'ch' && !c.name.startsWith('#') ? '#' : ''}
              {c.name}
              {c.unread && (
                <>
                  {' '}
                  <span className="dot-unread" aria-label="ongelezen" />
                </>
              )}
            </div>
            <div className="row-sub">{convSub(c)}</div>
          </div>
          <span className="row-meta">{c.time ? dayLabel(pd(c.time), now).toLowerCase() : 'Open gesprek'}</span>
        </div>,
      );
    } else if (en.kind === 'ctx') {
      const h = en.h;
      rows.push(
        <div key={i} className={`pal-item${a}`} {...common}>
          <span className="ic context">
            <Icon name="context" />
          </span>
          <div className="row-main">
            <div className="row-title">{short(h.title, 80)}</div>
            <div className="row-sub">{h.sub || 'Contextlaag'}</div>
          </div>
          <span className="row-meta">{h.date ? dayLabel(pd(h.date), now) : ''}</span>
        </div>,
      );
    } else {
      rows.push(
        <div key={i} className={`pal-item${a}`} {...common}>
          <span className="ic">
            <Icon name={en.c.icon} />
          </span>
          <div className="row-main">
            <div className="row-title">{en.c.label}</div>
          </div>
          <span className="row-meta">{en.c.hint}</span>
        </div>,
      );
    }
  });

  return (
    <div className="scrim" data-action="close-pal" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Zoeken">
        <div className="pal-input">
          <Icon name="search" />
          <input
            ref={input}
            id="pal-q"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Zoek in agenda, mail, Slack, taken en de contextlaag…  (> voor commando’s)"
            autoComplete="off"
            spellCheck={false}
            role="combobox"
            aria-expanded="true"
            aria-controls="pal-res"
            aria-label="Zoeken"
          />
          <span className="kbd">esc</span>
        </div>
        <div className="pal-chips" aria-live="polite">
          {search?.parsed.entities.map((slug) => (
            <span className="sq-chip org" key={slug}>
              <Icon name="users" />
              {d?.context.partners[slug]?.naam ?? slug}
            </span>
          ))}
          {search?.parsed.keywords.map((k) => (
            <span className="sq-chip kw" key={'k' + k}>
              {k}
            </span>
          ))}
          {search && search.parsed.mode !== 'list' && (
            <span className="sq-chip mode">{search.parsed.mode === 'gantt' ? 'gantt' : 'tijdlijn'}</span>
          )}
          {search && search.parsed.entities.length > 0 && !q.includes(',') && (
            <span className="pal-tip">
              Typ een komma om te verfijnen, bijv.{' '}
              <b>{d?.context.partners[search.parsed.entities[0]!]?.naam ?? ''}, berekening, timeline</b>
            </span>
          )}
        </div>
        <div className="pal-results" id="pal-res" ref={res} role="listbox" aria-label="Resultaten">
          {q.trim() && !q.trim().startsWith('>') && entries.length === 1 && (
            <div className="empty">Niets gevonden voor “{q.trim()}”.</div>
          )}
          {rows}
        </div>
        <div className="pal-foot">
          <span>
            <span className="kbd">↑↓</span>navigeer
          </span>
          <span>
            <span className="kbd">↵</span>open
          </span>
          <span>
            <span className="kbd">&gt;</span>commando’s
          </span>
          {search && (
            <button type="button" className="save" onClick={pin}>
              <Icon name="bookmark" /> Vastzetten in zijbalk <span className="kbd">⌘↵</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
