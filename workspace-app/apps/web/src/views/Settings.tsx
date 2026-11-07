/**
 * Instellingen (g i): Koppelingen (HZW-014), Apparaten en uitloggen overal (HZW-011), Team voor beheerders (HZW-012).
 * Pill-tabs met ⇧1–3; in Koppelingen bewegen j/k over de bronnen, ↵ toont de rechten en v verbindt.
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { PROVIDER_CATALOG, type ProviderName } from '@hz/shared';
import { ConnectorList, TasksExtras, PersRepoBlock, useReturnNotice } from '../components/Connectors';
import { ApiError } from '../lib/api';
import {
  logout,
  useAdmin,
  useConnectionDetails,
  useMembers,
  useOnboarding,
  useRevokeSession,
  useSessions,
} from '../lib/e1';
import { Icon } from '../lib/icons';
import { isTyping } from '../lib/keyboard';
import { useSession } from '../lib/queries';
import { useUi } from '../lib/ui';

type Tab = 'koppelingen' | 'apparaten' | 'team';
const TITLE: Record<Tab, string> = { koppelingen: 'Koppelingen', apparaten: 'Apparaten', team: 'Team' };

const rel = (iso: string | null) => {
  if (!iso) return 'nog nooit';
  const m = Math.round((Date.now() - +new Date(iso)) / 60_000);
  if (m < 2) return 'net nog';
  if (m < 60) return `${m} min geleden`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} uur geleden`;
  return new Date(iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
};
const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Er ging iets mis.');

function Koppelingen() {
  const ui = useUi();
  const [sp, setSp] = useSearchParams();
  const conns = useConnectionDetails().data?.connections;
  const ob = useOnboarding().data;
  useReturnNotice(sp, setSp, ui.toast, (ok, fout) =>
    ok
      ? `${PROVIDER_CATALOG[ok as ProviderName]?.label ?? ok} gekoppeld`
      : fout === 'geweigerd'
        ? 'Geen toestemming gegeven; er is niets gekoppeld.'
        : 'Koppelen lukte niet. Probeer het opnieuw.',
  );
  const connected = (conns ?? []).filter(
    (c) => c.status === 'connected' && !PROVIDER_CATALOG[c.provider].viaContext,
  ).length;
  return (
    <>
      <div className="set-summary">
        <span>
          <b>{connected}</b> van {Object.values(PROVIDER_CATALOG).filter((c) => !c.viaContext).length} bronnen gekoppeld
        </span>
        {ob && ob.status !== 'done' && ob.status !== 'none' && (
          <Link className="linklike" to="/welkom">
            Inrichten afmaken
          </Link>
        )}
      </div>
      <ConnectorList
        returnTo="/instellingen/koppelingen"
        extra={{
          google_tasks: <TasksExtras c={conns?.find((c) => c.provider === 'google_tasks')} />,
          github: <PersRepoBlock />,
        }}
      />
    </>
  );
}

function Apparaten() {
  const ui = useUi();
  const s = useSessions();
  const revoke = useRevokeSession();
  const [confirmAll, setConfirmAll] = useState(false);
  return (
    <>
      <div className="card set-card">
        <div className="card-head">
          <h2>Ingelogd op</h2>
          <span className="sub">sessies blijven 30 dagen geldig en verlengen als je de app gebruikt</span>
        </div>
        <div className="list">
          {(s.data?.sessions ?? []).map((x) => (
            <div className="row set-row" key={x.id} data-k={`sess:${x.id}`} data-kind="other">
              <span className="ic" aria-hidden="true">
                <Icon name="users" />
              </span>
              <div className="row-main">
                <div className="row-title">
                  {x.device} {x.current && <span className="chip ok">dit apparaat</span>}
                </div>
                <div className="row-sub">
                  laatst actief {rel(x.lastSeenAt)} · verloopt{' '}
                  {new Date(x.expiresAt).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long' })}
                </div>
              </div>
              <button
                type="button"
                className="btn sm"
                onClick={() =>
                  x.current
                    ? void logout(false)
                    : revoke.mutate(x.id, { onSuccess: () => ui.toast(`${x.device} uitgelogd`) })
                }
              >
                Uitloggen
              </button>
            </div>
          ))}
          {s.data && !s.data.sessions.length && <p className="sub">Geen actieve sessies.</p>}
        </div>
      </div>
      <div className="set-danger">
        <div>
          <h2>Uitloggen op alle apparaten</h2>
          <p className="sub">
            Bijvoorbeeld als je een laptop of telefoon kwijt bent. Je logt daarna opnieuw in met Google.
          </p>
        </div>
        {confirmAll ? (
          <span className="conn-confirm">
            <button type="button" className="btn danger" data-action="logout-all" onClick={() => void logout(true)}>
              Ja, overal uitloggen
            </button>
            <button type="button" className="btn" onClick={() => setConfirmAll(false)}>
              Annuleren
            </button>
          </span>
        ) : (
          <button type="button" className="btn ghost-danger" onClick={() => setConfirmAll(true)}>
            Overal uitloggen
          </button>
        )}
      </div>
    </>
  );
}

function Team() {
  const ui = useUi();
  const me = useSession().data?.user;
  const m = useMembers(me?.role === 'admin');
  const admin = useAdmin();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  if (me?.role !== 'admin') return <div className="note">Alleen beheerders zien het team.</div>;
  return (
    <>
      <div className="card set-card">
        <div className="card-head">
          <h2>Teamleden</h2>
          <span className="sub">{m.data?.members.length ?? 0} in de workspace</span>
        </div>
        <div className="list">
          {(m.data?.members ?? []).map((u) => (
            <div
              className={`row set-row${u.blocked ? ' blocked' : ''}`}
              key={u.id}
              data-k={`lid:${u.id}`}
              data-kind="other"
            >
              <span className="avatar" aria-hidden="true">
                {(u.name || u.email)[0]!.toUpperCase()}
              </span>
              <div className="row-main">
                <div className="row-title">
                  {u.name || u.email} {u.role === 'admin' && <span className="chip ok">beheerder</span>}{' '}
                  {u.blocked && <span className="chip warn">geblokkeerd</span>}
                </div>
                <div className="row-sub">
                  {u.email} · laatst actief {rel(u.lastSeenAt)} · {u.activeSessions}{' '}
                  {u.activeSessions === 1 ? 'sessie' : 'sessies'}
                </div>
              </div>
              {u.id !== me.id && (
                <button
                  type="button"
                  className={`btn sm${u.blocked ? '' : ' ghost-danger'}`}
                  onClick={() =>
                    admin.block.mutate(
                      { id: u.id, blocked: !u.blocked },
                      {
                        onSuccess: () =>
                          ui.toast(
                            u.blocked
                              ? `${u.name || u.email} heeft weer toegang`
                              : `${u.name || u.email} geblokkeerd en overal uitgelogd`,
                          ),
                        onError: (e) => ui.toast(errText(e)),
                      },
                    )
                  }
                >
                  {u.blocked ? 'Toegang terug' : 'Blokkeren'}
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="card set-card">
        <div className="card-head">
          <h2>Uitnodigingslijst</h2>
          <span className="sub">alleen deze @homezero.nl-adressen kunnen inloggen</span>
        </div>
        <div className="card-body">
          <form
            className="set-add"
            onSubmit={(e) => {
              e.preventDefault();
              admin.add.mutate(
                { email: email.trim(), role },
                {
                  onSuccess: (r) => {
                    setEmail('');
                    ui.toast(`${r.email} kan nu inloggen`);
                  },
                  onError: (er) => ui.toast(errText(er)),
                },
              );
            }}
          >
            <label className="visually-hidden" htmlFor="al-email">
              E-mailadres
            </label>
            <input
              id="al-email"
              type="email"
              required
              placeholder="naam@homezero.nl"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <label className="visually-hidden" htmlFor="al-role">
              Rol
            </label>
            <select id="al-role" value={role} onChange={(e) => setRole(e.target.value as 'member' | 'admin')}>
              <option value="member">teamlid</option>
              <option value="admin">beheerder</option>
            </select>
            <button type="submit" className="btn sm primary">
              Toevoegen
            </button>
          </form>
          <ul className="set-allow">
            {(m.data?.allowlist ?? []).map((a) => (
              <li key={a.email}>
                <span>{a.email}</span>
                {a.role === 'admin' && <span className="chip ok">beheerder</span>}
                <button
                  type="button"
                  className="iconbtn"
                  aria-label={`${a.email} van de lijst halen`}
                  onClick={() => admin.remove.mutate(a.email, { onError: (e) => ui.toast(errText(e)) })}
                >
                  <Icon name="x" />
                </button>
              </li>
            ))}
            {m.data && !m.data.allowlist.length && (
              <li className="sub">Nog leeg. Vaste beheerders en de lijst uit de serverinstellingen mogen altijd.</li>
            )}
          </ul>
        </div>
      </div>
    </>
  );
}

export function Settings() {
  const nav = useNavigate();
  const { tab: raw } = useParams();
  const me = useSession().data?.user;
  const tabs: Tab[] = me?.role === 'admin' ? ['koppelingen', 'apparaten', 'team'] : ['koppelingen', 'apparaten'];
  const tab: Tab = tabs.includes(raw as Tab) ? (raw as Tab) : 'koppelingen';
  const connect = useConnectionDetails().data;

  // ⇧1–3 wisselt tab; in Koppelingen: ↵ rechten bekijken, v verbinden (op de gefocuste bron).
  useEffect(() => {
    const on = (ev: KeyboardEvent) => {
      if (ev.metaKey || ev.ctrlKey || ev.altKey || isTyping(document.activeElement)) return;
      if (document.querySelector('.palette, [role="dialog"]')) return;
      const m = /^Digit([1-3])$/.exec(ev.code);
      if (ev.shiftKey && m) {
        const t = tabs[Number(m[1]) - 1];
        if (t) {
          ev.preventDefault();
          nav(`/instellingen/${t}`);
        }
        return;
      }
      const card = document.querySelector<HTMLElement>('#main .conn.kf');
      if (!card) return;
      if (ev.key === 'Enter') {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        card.querySelector<HTMLButtonElement>('[data-action="rights"]')?.click();
      } else if (ev.key === 'v') {
        ev.preventDefault();
        card.querySelector<HTMLButtonElement>('[data-action="connect"], [data-action="reconnect"]')?.click();
      }
    };
    window.addEventListener('keydown', on, true);
    return () => window.removeEventListener('keydown', on, true);
  }, [nav, tabs]);

  return (
    <div className="page set-page">
      <header className="hz-head felt plane-blue-light">
        <div className="shapes" aria-hidden="true">
          <svg viewBox="0 0 300 300" style={{ right: 0, bottom: 0, width: 230, height: 230 }}>
            <circle cx="300" cy="300" r="170" fill="#b8c6ff" />
          </svg>
          <svg viewBox="0 0 300 300" style={{ right: 150, top: 0, width: 90, height: 90 }}>
            <circle cx="150" cy="0" r="100" fill="none" stroke="#f9b20b" strokeWidth="30" />
          </svg>
        </div>
        <div>
          <div className="eyebrow">Instellingen</div>
          <h1>{TITLE[tab]}</h1>
        </div>
        <div className="hz-lead">
          <p>
            {tab === 'koppelingen'
              ? 'Elke bron koppel je los, met een eigen toestemming, zoals een connector in Claude. Tokens staan versleuteld op de server; je browser ziet ze nooit. Intrekken wist je gegevens van die bron en haalt de app bij de bron weg (bij Google met de laatste Google-bron).'
              : tab === 'apparaten'
                ? 'Waar je bent ingelogd. Een sessie die op een ander apparaat of in een andere browser opduikt, trekken we meteen in.'
                : 'Wie in de workspace kan. Eerste login maakt het profiel; blokkeren logt iemand overal uit.'}
          </p>
          {tab === 'koppelingen' && connect && (
            <p className="hz-sub">
              <button type="button" className="tlink" onClick={() => nav('/welkom')}>
                Inrichten opnieuw doorlopen <Icon name="arrow" className="i" />
              </button>
            </p>
          )}
        </div>
      </header>
      <div className="set-tabs">
        <div className="tabs" role="tablist" aria-label="Instellingen">
          {tabs.map((t, i) => (
            <Link
              key={t}
              to={`/instellingen/${t}`}
              role="tab"
              aria-selected={t === tab}
              className={`tab${t === tab ? ' on' : ''}`}
            >
              {TITLE[t]}
              <span className="tab-kbd">⇧{i + 1}</span>
            </Link>
          ))}
        </div>
        <button type="button" className="tab set-logout" onClick={() => void logout(false)}>
          Uitloggen
        </button>
      </div>
      <div role="tabpanel" aria-label={TITLE[tab]}>
        {tab === 'koppelingen' && <Koppelingen />}
        {tab === 'apparaten' && <Apparaten />}
        {tab === 'team' && <Team />}
      </div>
    </div>
  );
}
