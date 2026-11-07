/** Dagstart: rustig, alleen wat vandaag telt (viewDagstart() in het prototype, met echte API-data). */
import { useState } from 'react';
import { Link } from 'react-router';
import type { ActieMetPartner } from '@hz/shared/logic';
import {
  bucketDate,
  cap,
  ctxAge,
  ctxDagstart,
  ctxLoaded,
  dayDiff,
  dayLabel,
  DAY_CAP,
  fmtDate,
  focusDay,
  greeting,
  hashStr,
  aangKey,
  HEALTH,
  hm,
  inbox,
  isOverdue,
  isPast,
  longDay,
  openCommits,
  pd,
  plannedOn,
  relShort,
  sprintInfo,
  stripLeadingEmoji,
  ymd,
  addWorkdays,
} from '@hz/shared/logic';
import type { DagstartResponse, WachtenOp } from '@hz/shared';
import { Icon } from '../lib/icons';
import { useDagstart, useSession, useSetItemState } from '../lib/queries';
import { local, useUi } from '../lib/ui';
import { Row } from '../components/Row';
import { PayoffShapes } from '../components/Shapes';

const lastSeenAtLoad = local.get<number | null>('lastSeen', null);
local.set('lastSeen', Date.now());

export function CapBar({ n }: { n: number }) {
  const pct = Math.min(100, (n / DAY_CAP) * 100);
  return (
    <span className={`capbar${n > DAY_CAP ? ' over' : ''}`} title={`${n} van ${DAY_CAP}`}>
      <span style={{ width: `${pct}%` }} />
    </span>
  );
}

export function Dagstart() {
  const q = useDagstart();
  if (q.isPending) return <DagstartSkeleton />;
  if (q.isError) return <ErrorPage error={q.error} onRetry={() => void q.refetch()} />;
  return <DagstartView d={q.data} />;
}

function DagstartSkeleton() {
  return (
    <div className="page calm" aria-busy="true">
      <header className="calm-head felt plane-yellow-light">
        <PayoffShapes />
        <div className="eyebrow">&nbsp;</div>
        <h1>Dagstart</h1>
        <p className="calm-sum">Je bronnen worden geladen…</p>
      </header>
    </div>
  );
}

export function ErrorPage({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <div className="page">
      <div className="note err" role="alert">
        {error.message}
        <br />
        <button type="button" className="btn sm" onClick={onRetry}>
          Opnieuw proberen
        </button>
      </div>
    </div>
  );
}

function DagstartView({ d }: { d: DagstartResponse }) {
  const ui = useUi();
  const now = pd(d.now);
  const [showInbox, setShowInbox] = useState(() => local.get('showInbox', false));
  const [briefOpen, setBriefOpen] = useState(false);
  const setState = useSetItemState();
  const orgName = (slug: string) => d.context.partners[slug]?.naam;

  const session = useSession().data;
  const first = session?.user.name.split(/\s+/)[0] || 'Robert';
  const box = inbox(d.items, now);
  const T1 = bucketDate(d.items, 1, now);
  const todayList = plannedOn(d.items, T1, now).sort(
    (a, b) => (a.type === 'task' ? 0 : 1) - (b.type === 'task' ? 0 : 1),
  );
  const fd = focusDay(d.items, now);
  const next = fd.list.find((m) => pd(m.end) > now);
  const goals = openCommits(d.items).filter((c) => c.stroom === 'weekdoel');
  const dayWord = dayDiff(pd(T1), now) === 0 ? 'vandaag' : dayLabel(pd(T1), now).toLowerCase();
  const sp = sprintInfo(d.sprint.issues, now);
  const decided = (k: string) => k in d.decided;
  const ctx = ctxDagstart(d.context, now, first, decided);
  const age = ctxAge(d.context, now);
  const fixture = session?.mode === 'fixture' && session.fixtureSet === 'demo';
  const nudgeUntil = (d.decided['_nudge-repo'] as { until?: string } | undefined)?.until ?? '';
  const showNudge = ctxLoaded(d.context) && !d.context.pers && nudgeUntil <= ymd(now);

  const decide = (key: string, extra: Record<string, unknown>, msg: string) => {
    setState.mutate({ key, patch: { extra } });
    ui.toast(msg);
  };

  return (
    <div className="page calm">
      {fixture && d.sourceErrors.length === 0 && (
        <div className="mode-banner">
          <Icon name="spark" />
          <span>
            <b>Voorbeelddata.</b> De echte koppelingen met agenda, mail, Slack, taken en Wispr komen in de volgende
            stukken.
          </span>
        </div>
      )}
      <header className="calm-head felt plane-yellow-light">
        <PayoffShapes />
        <div className="eyebrow">{cap(longDay(now))}</div>
        <h1>{greeting(now, lastSeenAtLoad, Date.now(), first)}</h1>
        <p className="calm-sum">
          {box.length ? (
            <>
              <b>{box.length}</b> om te beslissen
            </>
          ) : (
            'Niets om te beslissen'
          )}{' '}
          · <b>{todayList.length}</b>/{DAY_CAP} gepland voor {dayWord}
          {next ? ` · volgende: ${next.title} ${hm(pd(next.start))}` : ''}
        </p>
        {box.length > 0 && (
          <button
            type="button"
            className="btn primary big"
            data-action="swipe"
            onClick={() => ui.toast('De plansessie komt in een volgend stuk')}
          >
            Start plansessie <Icon name="arrow" />
            <span className="kbd inv">s</span>
          </button>
        )}
      </header>

      {d.sourceErrors.length > 0 && (
        <div className="note err" style={{ marginBottom: 16 }} role="status">
          {d.sourceErrors.map((e) => (
            <div key={e.provider + e.message}>{e.message}</div>
          ))}
        </div>
      )}

      {age && (age.staleLayer || age.staleExport) && (
        <div className="note warn ctx-note" role="status">
          <Icon name="context" />
          <span>
            {age.staleLayer
              ? `De contextlaag is sinds ${age.statusDate} niet bijgewerkt (nachtdienst gemist?). Feiten kunnen achterlopen.`
              : `De workspace-kopie van de contextlaag is ouder dan 36 uur (${age.exported ? relShort(age.exported.toISOString(), now) : ''}).`}
          </span>
        </div>
      )}

      {d.briefing && d.briefing.date === ymd(now) && (
        <details
          className="briefing-line"
          open={briefOpen}
          onToggle={(e) => setBriefOpen((e.target as HTMLDetailsElement).open)}
        >
          <summary>
            <Icon name="sun" /> {stripLeadingEmoji(d.briefing.title || 'Ochtendbriefing')}
            {d.briefing.createdAt && <span className="sub"> · {hm(pd(d.briefing.createdAt))}</span>}
          </summary>
          <div className="brief-grid">
            {d.briefing.sections.map((sec) => (
              <div key={sec.title}>
                <div className="eyebrow" style={{ marginBottom: 4 }}>
                  {sec.title}
                </div>
                <ul className="brief">
                  {sec.items.map((i) => (
                    <li key={i.text}>
                      {i.url ? (
                        <a href={i.url} target="_blank" rel="noopener noreferrer" className="ext-link">
                          {i.text}
                        </a>
                      ) : (
                        i.text
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </details>
      )}

      <div className="calm-grid">
        <section aria-labelledby="ds-today">
          <div className="calm-title">
            <h2 id="ds-today">{cap(dayWord)}</h2>
            <CapBar n={todayList.length} />
            <span className="count-badge">
              {todayList.length}/{DAY_CAP}
            </span>
          </div>
          {todayList.length ? (
            <div className="list">
              {todayList.map((it) => (
                <Row key={it.id} it={it} now={now} chip={false} orgName={orgName} />
              ))}
            </div>
          ) : (
            <div className="empty">Nog niets gepland.{box.length ? ' Start de plansessie.' : ''}</div>
          )}
          {box.length > 0 && (
            <details
              className="calm-more"
              open={showInbox}
              onToggle={(e) => {
                const open = (e.target as HTMLDetailsElement).open;
                setShowInbox(open);
                local.set('showInbox', open);
              }}
            >
              <summary data-action="toggle-inbox">Om te beslissen ({box.length})</summary>
              <div className="list">
                {box.map((b) => (
                  <Row key={b.it.id} it={b.it} now={now} kind={b.kind} why={b.why} kindChip orgName={orgName} />
                ))}
              </div>
            </details>
          )}
        </section>
        <section aria-labelledby="ds-agenda">
          <div className="calm-title">
            <h2 id="ds-agenda">Agenda {fd.k === 0 ? 'vandaag' : dayLabel(pd(fd.day), now).toLowerCase()}</h2>
          </div>
          <div className="mini-agenda">
            {fd.list.length ? (
              fd.list.map((m) => {
                const prepWarn = m.external && !m.prepTask && !m.skipPrep && !isPast(m, now);
                return (
                  <button
                    type="button"
                    key={m.id}
                    className={`ma-row${isPast(m, now) ? ' past' : ''}${m.needsAction ? ' inv' : ''}${ui.selected === m.id ? ' sel' : ''}`}
                    data-open={m.id}
                    data-k={m.id}
                    data-kind={m.needsAction ? 'invite' : 'meeting'}
                    style={{ width: '100%', textAlign: 'left' }}
                    onClick={() => ui.select(m.id)}
                  >
                    <span className="t">{hm(pd(m.start))}</span>
                    <span style={{ minWidth: 0 }}>
                      <span className="row-title" style={{ display: 'block' }}>
                        <i className="cal-dot" style={{ background: m.evColor ?? 'var(--c-meeting)' }} />
                        {m.title}
                      </span>
                      {m.needsAction ? (
                        <span className="row-sub" style={{ display: 'block' }}>
                          nog niet geaccepteerd
                        </span>
                      ) : prepWarn ? (
                        <span className="row-sub" style={{ display: 'block' }}>
                          geen prep gepland
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })
            ) : (
              <div className="empty">Geen afspraken.</div>
            )}
          </div>
        </section>
      </div>

      {showNudge && (
        <div className="nudge-repo compact">
          <div>
            <b>Zet je Persoonlijk-repo op</b>
            <div className="sub">
              Zonder repo blijven Wachten op en Bespreken leeg en blijft wat je aanmaakt in de wachtrij hangen. Kost een
              kwartier.
            </div>
          </div>
          <span className="ctx-btns">
            <Link className="btn sm primary" to="/tracker">
              Hoe?
            </Link>
            <button
              type="button"
              className="btn sm"
              onClick={() =>
                decide(
                  '_nudge-repo',
                  { until: ymd(addWorkdays(now, 3)) },
                  'Ik herinner je er over 3 werkdagen weer aan',
                )
              }
            >
              Over 3 dagen
            </button>
          </span>
        </div>
      )}

      {ctx && (
        <section className="ctx-day" aria-labelledby="ds-ctx">
          <div className="calm-title">
            <h2 id="ds-ctx">Uit de contextlaag</h2>
            <span className="sub" style={{ fontSize: 12 }}>
              {ctxSourceLine(d)}
            </span>
          </div>
          {ctx.confirmed.length > 0 && (
            <div className="ctx-block">
              <div className="ctx-h">
                Jouw acties vandaag of over datum <span className="count-badge">{ctx.confirmed.length}</span>
              </div>
              {ctx.confirmed.slice(0, 5).map((a) => (
                <ActRow key={a.id ?? a.tekst} a={a} now={now} partner />
              ))}
              {ctx.confirmed.length > 5 && (
                <Link className="cv-more" to="/tracker">
                  Alle {ctx.confirmed.length} in de Tracker
                </Link>
              )}
            </div>
          )}
          {ctx.proposed.length > 0 && (
            <details className="ctx-block">
              <summary className="ctx-h">
                Met een voorgestelde datum (nog niet bevestigd){' '}
                <span className="count-badge">{ctx.proposed.length}</span>
              </summary>
              {ctx.proposed.slice(0, 12).map((a) => (
                <ActRow key={a.id ?? a.tekst} a={a} now={now} partner />
              ))}
            </details>
          )}
          {ctx.nudges.length > 0 && (
            <div className="ctx-block">
              <div className="ctx-h">
                Nog geen reactie, nudge? <span className="count-badge">{ctx.nudges.length}</span>
              </div>
              {ctx.nudges.map((w) => (
                <ActRow key={w.tekst} a={w} now={now} />
              ))}
            </div>
          )}
          {ctx.taken.length > 0 && (
            <details className="ctx-block">
              <summary className="ctx-h">
                Taken uit je nachtdienst (taken.md) <span className="count-badge">{ctx.taken.length}</span>
              </summary>
              {ctx.taken.map((t) => (
                <div className="ctx-act" key={t.tekst}>
                  <span className="ctx-dot ons" />
                  <div className="ctx-act-main">
                    <div>{t.tekst}</div>
                    <div className="sub">
                      {t.klant && (
                        <>
                          <Link className="linklike" to={`/o/${t.klant}`}>
                            {orgName(t.klant) ?? t.klant}
                          </Link>{' '}
                          ·{' '}
                        </>
                      )}
                      {t.due ? 'due ' + fmtDate(t.due) : 'geen datum'}
                    </div>
                  </div>
                  <span className="ctx-btns">
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() =>
                        decide('_taak-' + hashStr(t.tekst), { done: 'gtask' }, 'Komt als Google Taak (stuk planning)')
                      }
                    >
                      Google Taak
                    </button>
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => decide('_taak-' + hashStr(t.tekst), { done: 'genegeerd' }, 'Genegeerd')}
                    >
                      Negeer
                    </button>
                  </span>
                </div>
              ))}
            </details>
          )}
          {ctx.aangehouden.length > 0 && (
            <details className="ctx-block">
              <summary className="ctx-h">
                Aangehouden meetings: deel of privé? <span className="count-badge">{ctx.aangehouden.length}</span>
              </summary>
              <div className="sub" style={{ margin: '4px 0 6px' }}>
                Je keuze wordt bewaard; de ochtendroutine zet hem achter de regel in aangehouden.md en de nachtdienst
                verwerkt het.
              </div>
              {ctx.aangehouden.slice(0, 8).map((r) => (
                <div className="ctx-act" key={aangKey(r)}>
                  <span className="ctx-dot" />
                  <div className="ctx-act-main">
                    <div>{r.tekst}</div>
                    <div className="sub">
                      {fmtDate(r.datum)}
                      {/^https?:/.test(r.bron) && (
                        <>
                          {' · '}
                          <a href={r.bron} target="_blank" rel="noopener noreferrer">
                            Wispr
                          </a>
                        </>
                      )}
                    </div>
                  </div>
                  <span className="ctx-btns">
                    {(['deel', 'privé'] as const).map((v) => (
                      <button
                        key={v}
                        type="button"
                        className="btn sm"
                        onClick={() =>
                          decide(
                            '_aang-' + aangKey(r),
                            { keuze: v, datum: r.datum, overgezet: false },
                            `Bewaard als ${v}; de ochtendroutine zet het in aangehouden.md`,
                          )
                        }
                      >
                        {v === 'deel' ? 'Deel' : 'Privé'}
                      </button>
                    ))}
                  </span>
                </div>
              ))}
              {ctx.aangehouden.length > 8 && (
                <div className="sub" style={{ marginTop: 6 }}>
                  En nog {ctx.aangehouden.length - 8}.
                </div>
              )}
            </details>
          )}
        </section>
      )}

      <div className="calm-foot">
        {d.catchCount > 0 && (
          <Link className="calm-chip" to="/chat">
            <Icon name="chat" />
            {d.catchCount} gesprekken om in te halen
          </Link>
        )}
        {sp && (
          <Link className="calm-chip" to="/planning?tab=sprint">
            <Icon name="git" />
            {sp.name} · nog {sp.daysLeft} {sp.daysLeft === 1 ? 'dag' : 'dagen'} · {sp.donePts}/{sp.totalPts} pt
            {sp.mine ? (
              <>
                {' · '}
                <b>{sp.mine} voor jou om te testen</b>
              </>
            ) : null}
          </Link>
        )}
        {goals.length > 0 && (
          <Link className="calm-chip" to="/tracker?tab=weekdoel">
            🎯 {goals.map((g) => (g.health ? HEALTH[g.health]![0] : '⚪')).join('')} weekdoelen
          </Link>
        )}
      </div>
    </div>
  );
}

function ActRow({ a, now, partner }: { a: ActieMetPartner | WachtenOp; now: Date; partner?: boolean }) {
  const od = 'datum' in a && isOverdue(a as ActieMetPartner, now);
  const hen = ('ligt' in a && a.ligt === 'bij-hen') || ('wie' in a && !!a.wie);
  const slug = 'slug' in a ? a.slug : undefined;
  const naam = 'naam' in a ? a.naam : undefined;
  const who = ('eigenaar' in a && a.eigenaar) || ('wie' in a && a.wie) || '';
  const datum = 'datum' in a ? a.datum : undefined;
  const reminder = 'reminder' in a ? a.reminder : undefined;
  return (
    <div className={`ctx-act${od ? ' od' : ''}`}>
      <span className={`ctx-dot ${hen ? 'hen' : 'ons'}`} title={hen ? 'wacht op hen' : 'ligt bij ons'} />
      <div className="ctx-act-main">
        <div>{a.tekst}</div>
        <div className="sub">
          {partner && slug && (
            <>
              <Link className="linklike" to={`/o/${slug}`}>
                {naam || slug}
              </Link>
              {' · '}
            </>
          )}
          {who}
          {datum ? (
            <>
              {' · '}
              {od ? <b className="od-t">{fmtDate(datum)}</b> : fmtDate(datum)}
            </>
          ) : reminder ? (
            ` · reminder ${fmtDate(reminder)}`
          ) : null}
          {a.voorstel && (
            <>
              {' '}
              <span className="chip voorstel" title="Datum nog niet bevestigd">
                voorstel
              </span>
            </>
          )}
          {a.bron && /^https?:/.test(a.bron) && (
            <>
              {' · '}
              <a href={a.bron} target="_blank" rel="noopener noreferrer">
                bron
              </a>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ctxSourceLine(d: DagstartResponse) {
  const st = d.context.status;
  if (!st) return '';
  const sd = (String(st.status || '').match(/^(\d{4}-\d{2}-\d{2})/) || [])[1];
  const color = (String(st.status).split('|')[1] || '').trim();
  return `Contextlaag${st.commit_context ? ' · ' + st.commit_context : ''}${sd ? ' · ' + sd : ''}${color ? ' · status ' + color : ''}`;
}
