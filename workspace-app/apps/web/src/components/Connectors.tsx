/**
 * Koppelingen zoals connectors in Claude (HZW-013, HZW-014): per bron een kaart met eigen knop, eigen toestemming
 * en uitleg wat de app ermee doet. Gebruikt in de onboarding en in Instellingen → Koppelingen.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PROVIDER_CATALOG, type CalendarInfo, type ConnectionDetail, type ProviderName } from '@hz/shared';
import { CAL_GROUPS, GCAL } from '@hz/shared/logic';
import { api, ApiError } from '../lib/api';
import {
  useConnect,
  useConnectionDetails,
  useDisconnect,
  useOwnGoogleClient,
  usePersRepo,
  useUpdateOnboarding,
  useWipeData,
} from '../lib/e1';
import { Icon, type IconName } from '../lib/icons';
import { useUi } from '../lib/ui';

/**
 * Terug van een bron (OAuth): ?gekoppeld=… of ?fout=… één keer melden en uit de URL halen. Eén keer per adres,
 * ook als de melding zelf opnieuw rendert (anders verdringt hij latere navigatie).
 */
export function useReturnNotice(
  sp: URLSearchParams,
  setSp: (next: URLSearchParams, opts: { replace: boolean }) => void,
  toast: (msg: string) => void,
  text: (ok: string | null, fout: string | null) => string,
) {
  const seen = useRef('');
  const ok = sp.get('gekoppeld');
  const fout = sp.get('fout');
  const key = ok || fout ? sp.toString() : '';
  useEffect(() => {
    if (!key || seen.current === key) return;
    seen.current = key;
    toast(text(ok, fout));
    const next = new URLSearchParams(key);
    next.delete('gekoppeld');
    next.delete('fout');
    setSp(next, { replace: true });
    // Alleen het adres telt; toast en text zijn stabiel genoeg en mogen geen herhaling veroorzaken.
  }, [key]);
}

const ICON: Record<ProviderName, IconName> = {
  google_tasks: 'task',
  calendar: 'meeting',
  gmail: 'mail',
  slack: 'slack',
  jira: 'commit',
  github: 'git',
  wispr: 'mic',
};

export function StatusChip({ c }: { c: ConnectionDetail }) {
  if (PROVIDER_CATALOG[c.provider].viaContext) return <span className="chip">via de contextlaag</span>;
  switch (c.status) {
    case 'connected':
      return <span className="chip ok">Gekoppeld</span>;
    case 'needs_reauth':
      return <span className="chip warn">Opnieuw verbinden</span>;
    case 'error':
      return <span className="chip warn">Fout</span>;
    default:
      return <span className="chip">Niet gekoppeld</span>;
  }
}

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Er ging iets mis. Probeer het opnieuw.');

export function ConnectorCard({
  c,
  returnTo,
  children,
}: {
  c: ConnectionDetail;
  returnTo: string;
  children?: ReactNode;
}) {
  const cat = PROVIDER_CATALOG[c.provider];
  const ui = useUi();
  const connect = useConnect();
  const disconnect = useDisconnect();
  const wipe = useWipeData();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const connected = c.status === 'connected';
  const reauth = c.status === 'needs_reauth' || c.status === 'error';
  const detailsId = `conn-rechten-${c.provider}`;
  const doConnect = () =>
    connect.mutate(
      { provider: c.provider, returnTo },
      {
        onSuccess: (r) => {
          if (!r.redirect) ui.toast(`${cat.label} gekoppeld (voorbeelddata)`);
        },
        onError: (e) => ui.toast(errText(e)),
      },
    );
  const doRevoke = () =>
    disconnect.mutate(c.provider, {
      onSuccess: (r) => {
        setConfirm(false);
        // Google trekt per app in: andere Google-bronnen die al niet werkten, vragen nu opnieuw verbinden.
        const lost = r.needsReauth?.length
          ? ` ${r.needsReauth.map((p) => PROVIDER_CATALOG[p].label).join(' en ')} vraagt nu opnieuw verbinden.`
          : '';
        ui.toast(
          r.revokedAtProvider
            ? `${cat.label} ingetrokken bij de bron; token en eigen gegevens gewist.${lost}`
            : (r.note ?? `${cat.label} ontkoppeld.`),
        );
      },
      onError: (e) => ui.toast(errText(e)),
    });
  return (
    <article
      className={`conn card${connected ? ' on' : ''}`}
      data-k={`conn:${c.provider}`}
      data-kind="conn"
      data-provider={c.provider}
      aria-labelledby={`conn-${c.provider}`}
    >
      <div className="conn-main">
        <span className={`conn-ic fam-${cat.family}`} aria-hidden="true">
          <Icon name={ICON[c.provider]} />
        </span>
        <div className="conn-text">
          <div className="conn-title">
            <h3 id={`conn-${c.provider}`} className="row-title">
              {cat.label}
            </h3>
            {cat.recommended && <span className="chip warn">aanbevolen</span>}
            {cat.optional && <span className="chip plan">optioneel</span>}
            <StatusChip c={c} />
            {c.mode === 'fixture' && !c.oauth && !cat.viaContext && <span className="scope-tag">voorbeelddata</span>}
          </div>
          <p className="conn-tag sub">{cat.tagline}</p>
          {connected && c.account && <p className="conn-acc">Account: {c.account}</p>}
          {c.error && <p className="conn-err">{c.error}</p>}
        </div>
      </div>
      {!cat.viaContext && (
        <div className="conn-acts">
          {!connected && (
            <button
              type="button"
              className="btn sm primary"
              data-action="connect"
              onClick={doConnect}
              disabled={connect.isPending}
            >
              {reauth ? 'Opnieuw verbinden' : 'Verbinden'}
            </button>
          )}
          {connected && (
            <button
              type="button"
              className="btn sm"
              data-action="reconnect"
              onClick={doConnect}
              disabled={connect.isPending}
            >
              <Icon name="refresh" />
              Opnieuw verbinden
            </button>
          )}
          <button
            type="button"
            className="btn sm"
            aria-expanded={open}
            aria-controls={detailsId}
            data-action="rights"
            onClick={() => setOpen(!open)}
          >
            Rechten bekijken
          </button>
          {connected && (
            <button
              type="button"
              className="btn sm"
              data-action="wipe"
              onClick={() =>
                wipe.mutate(c.provider, {
                  onSuccess: (r) => ui.toast(`Eigen gegevens van ${cat.label} gewist (${r.wiped}).`),
                  onError: (e) => ui.toast(errText(e)),
                })
              }
            >
              Gegevens wissen
            </button>
          )}
          {(connected || reauth) &&
            (confirm ? (
              <span className="conn-confirm" role="group" aria-label={`${cat.label} intrekken bevestigen`}>
                <button type="button" className="btn sm danger" data-action="revoke-confirm" onClick={doRevoke}>
                  Ja, intrekken
                </button>
                <button type="button" className="btn sm" onClick={() => setConfirm(false)}>
                  Annuleren
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="btn sm ghost-danger"
                data-action="revoke"
                onClick={() => setConfirm(true)}
              >
                <Icon name="trash" />
                Intrekken
              </button>
            ))}
        </div>
      )}
      {open && (
        <div className="conn-rights" id={detailsId}>
          <div>
            <h4>Wat de app ermee doet</h4>
            <ul>
              {cat.does.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          </div>
          <div>
            <h4>Wat de app nooit doet</h4>
            <ul>
              {cat.never.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          </div>
          {cat.scopes.length > 0 && (
            <div className="conn-scopes">
              <h4>Toestemming bij {cat.family === 'google' ? 'Google' : cat.label}</h4>
              <ul className="scope-list">
                {(c.scopes.length ? c.scopes : cat.scopes).map((s) => (
                  <li key={s}>
                    <code>{s.replace('https://www.googleapis.com/auth/', '')}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="sub conn-revoke">Intrekken: {cat.revoke}</p>
        </div>
      )}
      {children}
    </article>
  );
}

/** Rij koppelingen; `only` beperkt tot bepaalde bronnen (stappen van de wizard). */
export function ConnectorList({
  only,
  returnTo,
  extra,
}: {
  only?: ProviderName[];
  returnTo: string;
  extra?: Partial<Record<ProviderName, ReactNode>>;
}) {
  const q = useConnectionDetails();
  if (q.isLoading) return <p className="sub">Koppelingen laden…</p>;
  if (q.error) return <div className="note err">{errText(q.error)}</div>;
  const list = (q.data?.connections ?? []).filter((c) => !only || only.includes(c.provider));
  return (
    <div className="conn-list">
      {list.map((c) => (
        <ConnectorCard key={c.provider} c={c} returnTo={returnTo}>
          {extra?.[c.provider]}
        </ConnectorCard>
      ))}
    </div>
  );
}

/** Google Taken: eigen Google Cloud-project (keuze 06) en Claude koppelen (workspace-MCP, volgt met HZW-052). */
export function TasksExtras({ c }: { c: ConnectionDetail | undefined }) {
  const ui = useUi();
  const own = useOwnGoogleClient();
  const redirect = useConnectionDetails().data?.redirectUri ?? '';
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  return (
    <div className="conn-extra">
      <details>
        <summary>Eigen Google-project gebruiken (gevorderd)</summary>
        <p className="sub">
          Heb je al een eigen Google Cloud-project met de Tasks-API (zoals Robert)? Dan kan de workspace die client
          gebruiken in plaats van het HomeZero-project. Zet als redirect-URI in je project: <code>{redirect}</code>
        </p>
        {c?.ownClient ? (
          <p>
            Eigen project actief.{' '}
            <button
              type="button"
              className="btn sm"
              onClick={() =>
                own.remove.mutate(undefined, { onSuccess: () => ui.toast('Terug naar het HomeZero-project') })
              }
            >
              Weghalen
            </button>
          </p>
        ) : (
          <form
            className="own-client"
            onSubmit={(e) => {
              e.preventDefault();
              own.save.mutate(
                { clientId: clientId.trim(), clientSecret: secret.trim() },
                {
                  onSuccess: () => {
                    setSecret('');
                    ui.toast('Eigen Google-project opgeslagen (versleuteld). Verbind Google Taken opnieuw.');
                  },
                  onError: (er) => ui.toast(errText(er)),
                },
              );
            }}
          >
            <label>
              <span>Client-ID</span>
              <input
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder="…apps.googleusercontent.com"
                autoComplete="off"
              />
            </label>
            <label>
              <span>Client-geheim</span>
              <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" />
            </label>
            <button type="submit" className="btn sm" disabled={!clientId || !secret || own.save.isPending}>
              Opslaan
            </button>
          </form>
        )}
      </details>
      <p className="sub conn-mcp">
        <Icon name="spark" /> Claude koppelen: straks voeg je de workspace één keer toe als connector in Claude, zodat
        je routines taken kunnen aanmaken die hier meteen staan (komt met de MCP-server, HZW-052).
      </p>
    </div>
  );
}

/** Persoonlijk-repo: bestaat hij? Zo niet, een aansporing met een kant-en-klare opdracht voor Claude. */
export function PersRepoBlock() {
  const ui = useUi();
  const pr = usePersRepo();
  const save = useUpdateOnboarding();
  const qc = useQueryClient();
  const [repo, setRepo] = useState<string | null>(null);
  const value = repo ?? pr.data?.repo ?? '';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pr.data?.prompt ?? '');
      ui.toast('Opdracht gekopieerd. Plak hem in Claude.');
    } catch {
      ui.toast('Kopiëren lukte niet; selecteer de tekst handmatig.');
    }
  };
  return (
    <div className="conn-extra">
      <form
        className="pers-form"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(
            { persRepo: value.trim() || null },
            {
              onSuccess: () => {
                void qc.invalidateQueries({ queryKey: ['persRepo'] });
                ui.toast('Persoonlijk-repo opgeslagen');
              },
              onError: (er) => ui.toast(errText(er)),
            },
          );
        }}
      >
        <label>
          <span>Je Persoonlijk-repo (eigenaar/naam)</span>
          <input
            value={value}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="HomeZeroTech/persoonlijk-naam"
            autoComplete="off"
          />
        </label>
        <button type="submit" className="btn sm">
          Controleren
        </button>
      </form>
      {pr.data?.status === 'exists' && <p className="conn-ok">Gevonden: je taken en wachten op komen uit deze repo.</p>}
      {pr.data && pr.data.status !== 'exists' && (
        <div className="nudge-repo">
          <h2>{pr.data.status === 'missing' ? 'Nog geen Persoonlijk-repo' : 'Persoonlijk-repo sterk aangeraden'}</h2>
          <p>
            Zonder Persoonlijk-repo werkt de Tracker maar half: taken.md en wachten-op.md staan daar. Laat Claude hem
            opzetten met deze opdracht:
          </p>
          <pre className="prompt-box" tabIndex={0}>
            {pr.data.prompt}
          </pre>
          <div>
            <button type="button" className="btn sm yellow" onClick={copy}>
              Kopieer opdracht voor Claude
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Agenda-lagen: per agenda kleur, zichtbaar, en "overal" of "alleen in Agenda" (zoals het lagenpaneel van de lat). */
export function CalendarLayers({ onConnect }: { onConnect?: () => void }) {
  const ui = useUi();
  const qc = useQueryClient();
  const conns = useConnectionDetails().data?.connections;
  const cal = conns?.find((c) => c.provider === 'calendar');
  const connected = cal?.status === 'connected';
  const q = useQuery({ queryKey: ['agenda'], queryFn: () => api('agenda'), enabled: connected });
  const [local, setLocal] = useState<Record<string, { color?: string; scope?: 'overal' | 'agenda'; hidden?: boolean }>>(
    {},
  );
  const save = useMutation({
    mutationFn: (calendars: Record<string, { color?: string; scope?: 'overal' | 'agenda'; hidden?: boolean }>) =>
      api('updatePreferences', { body: { calendars } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agenda'] });
      void qc.invalidateQueries({ queryKey: ['dagstart'] });
    },
    onError: (e) => ui.toast(errText(e)),
  });
  if (!cal) return null;
  if (!connected)
    return (
      <div className="note">
        Koppel eerst Agenda; dan zie je hier al je agenda’s.{' '}
        {onConnect && (
          <button type="button" className="btn sm" onClick={onConnect}>
            Naar Google
          </button>
        )}
      </div>
    );
  // Lokale stand per agenda, zodat snelle wijzigingen (kleur en daarna bereik) elkaar niet overschrijven:
  // de server vervangt per agenda het hele voorkeursobject.
  const cals = (q.data?.calendars ?? []).map((c) => {
    const o = local[c.id];
    return o
      ? { ...c, color: o.color ?? c.color, scope: o.scope ?? c.scope, on: o.hidden === undefined ? c.on : !o.hidden }
      : c;
  });
  const groups = CAL_GROUPS.map(
    ([g, label]) => [g, label, cals.filter((c) => (c.group ?? 'overig') === g)] as const,
  ).filter(([, , cs]) => cs.length);
  const set = (c: CalendarInfo, patch: { color?: string; scope?: 'overal' | 'agenda'; hidden?: boolean }) => {
    const full = { color: c.color, scope: c.scope, hidden: !c.on, ...patch };
    setLocal((l) => ({ ...l, [c.id]: full }));
    save.mutate({ [c.id]: full });
  };
  /** Hele groep in één keer (zoals de lat): alles aan/uit, of alleen in Agenda / ook overal. */
  const setMany = (cs: CalendarInfo[], patch: { scope?: 'overal' | 'agenda'; hidden?: boolean }) => {
    const all = Object.fromEntries(cs.map((c) => [c.id, { color: c.color, scope: c.scope, hidden: !c.on, ...patch }]));
    setLocal((l) => ({ ...l, ...all }));
    save.mutate(all);
  };
  return (
    <div className="card calpanel layers">
      {groups.map(([g, label, cs]) => (
        <div className="cp-group" key={g}>
          <div className="cp-head">
            <b>{label}</b>
            <button type="button" className="btn sm" onClick={() => setMany(cs, { hidden: cs.some((c) => c.on) })}>
              {cs.some((c) => c.on) ? 'Alles uit' : 'Alles aan'}
            </button>
            <button
              type="button"
              className="btn sm"
              onClick={() => setMany(cs, { scope: cs.every((c) => c.scope === 'agenda') ? 'overal' : 'agenda' })}
            >
              {cs.every((c) => c.scope === 'agenda') ? 'Ook overal tonen' : 'Alleen in Agenda'}
            </button>
          </div>
          {cs.map((c) => (
            <div className="cp-row" key={c.id}>
              <label className="cp-check">
                <input type="checkbox" checked={c.on} onChange={(e) => set(c, { hidden: !e.target.checked })} />
                <span className="sw" style={{ background: c.color }} />
                <span className="cp-name" title={c.id}>
                  {c.summary}
                </span>
              </label>
              <select
                className="cp-color"
                aria-label={`Kleur van ${c.summary}`}
                value={Object.values(GCAL).find((h) => h.toLowerCase() === (c.color ?? '').toLowerCase()) ?? c.color}
                onChange={(e) => set(c, { color: e.target.value })}
              >
                {Object.entries(GCAL).map(([n, hex]) => (
                  <option key={n} value={hex}>
                    {n.replace('_', ' ')}
                  </option>
                ))}
              </select>
              <div className="seg cp-scope-seg" role="radiogroup" aria-label={`Waar ${c.summary} verschijnt`}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={c.scope !== 'agenda'}
                  className={c.scope !== 'agenda' ? 'on' : ''}
                  onClick={() => set(c, { scope: 'overal' })}
                >
                  Overal
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={c.scope === 'agenda'}
                  className={c.scope === 'agenda' ? 'on' : ''}
                  onClick={() => set(c, { scope: 'agenda' })}
                >
                  Alleen in Agenda
                </button>
              </div>
            </div>
          ))}
        </div>
      ))}
      <div className="sub" style={{ fontSize: 12 }}>
        Een privé-agenda (bijv. van je gmail-adres of je gezin) deel je met je werkaccount, met alle details. Alleen
        beschikbaarheid gedeeld? Dan zie je blokken met ‘bezet’ zonder titel. Privé-afspraken gaan nooit naar teksten
        voor partners of de contextlaag.
      </div>
    </div>
  );
}
