/**
 * Onboarding-wizard (HZW-013): welkom, Google-rechten, Slack, Jira, GitHub, agenda-lagen, weekritme,
 * toetsenbord-tour. Elke stap kan overgeslagen worden; "Later afmaken" bewaart de stap en je gaat verder waar je was.
 * Toetsen: → of ↵ verder, ← terug, o overslaan, l later afmaken.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import {
  ONBOARDING_STEPS,
  PROVIDER_CATALOG,
  STEP_LABEL,
  Weekritme as WeekritmeSchema,
  type OnboardingStep,
  type ProviderName,
  type Weekritme,
} from '@hz/shared';
import { CalendarLayers, ConnectorList, PersRepoBlock, TasksExtras, useReturnNotice } from '../components/Connectors';
import { PayoffShapes } from '../components/Shapes';
import { useConnectionDetails, useOnboarding, useUpdateOnboarding } from '../lib/e1';
import { Icon } from '../lib/icons';
import { isTyping } from '../lib/keyboard';
import { useSession } from '../lib/queries';
import { useUi } from '../lib/ui';

const LEAD: Record<OnboardingStep, string> = {
  welkom:
    'In acht korte stappen richt je de workspace in. Elke koppeling is optioneel en heeft een eigen toestemming, zoals een connector in Claude. Overslaan en later afmaken kan altijd.',
  google:
    'Kies per Google-bron of de workspace erbij mag. Google Taken is aanbevolen: de Tracker draait erop. Gmail is optioneel; zonder mailbox werkt alles behalve mail in Inhalen en zoeken.',
  slack:
    'De interne HomeZero-app met je eigen token: echt gelezen zetten in Slack, reageren en zoeken. Versturen gebeurt alleen na jouw klik.',
  jira: 'Alleen lezen. Alles tot de nachtrun komt uit de contextlaag; live haalt de app alleen op wat sindsdien veranderde.',
  github:
    'De contextlaag lezen en je eigen Persoonlijk-repo met taken.md en wachten-op.md. Zonder die repo werkt de Tracker maar half.',
  agenda:
    'Alle agenda’s uit je werkaccount, ook gedeelde privé-agenda’s. Kies per agenda een kleur en of hij overal verschijnt of alleen in Agenda.',
  weekritme:
    'Wanneer plan je je week en wanneer sluit je de dag af? Dagstart, de plansessie en je routines houden zich eraan.',
  toetsenbord: 'Alles kan met toetsen. Probeer ze hier: druk op een toets en hij licht op, zonder dat er iets gebeurt.',
};

const STEP_PROVIDERS: Partial<Record<OnboardingStep, ProviderName[]>> = {
  google: ['google_tasks', 'calendar', 'gmail'],
  slack: ['slack'],
  jira: ['jira'],
  github: ['github'],
};

const TOUR: Array<[string, string]> = [
  ['g d', 'Dagstart'],
  ['g p', 'Planning'],
  ['g a', 'Agenda'],
  ['g t', 'Tracker'],
  ['g c', 'Chat'],
  ['⌘K', 'zoeken en commando’s'],
  ['?', 'alle sneltoetsen'],
  ['s', 'plansessie'],
  ['j k', 'bewegen in een lijst'],
  ['↵', 'details rechts'],
  ['g i', 'Instellingen en koppelingen'],
  ['g w', 'deze wizard'],
];

const DAGEN: Array<[Weekritme['plansessieDag'], string]> = [
  ['ma', 'ma'],
  ['di', 'di'],
  ['wo', 'wo'],
  ['do', 'do'],
  ['vr', 'vr'],
];

function KeyTour() {
  const [hit, setHit] = useState<Set<string>>(new Set());
  const gAt = useRef(0);
  useEffect(() => {
    const on = (ev: KeyboardEvent) => {
      if (isTyping(document.activeElement)) return;
      let id: string | null = null;
      const k = ev.key;
      if ((ev.metaKey || ev.ctrlKey) && k.toLowerCase() === 'k') id = '⌘K';
      else if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      else if (Date.now() - gAt.current < 1200 && /^[dpatciw]$/.test(k)) id = `g ${k}`;
      else if (k === 'g') {
        gAt.current = Date.now();
        ev.preventDefault();
        ev.stopImmediatePropagation();
        return;
      } else if (k === '?') id = '?';
      else if (k === 's') id = 's';
      else if (k === 'j' || k === 'k') id = 'j k';
      else if (k === 'Enter') id = '↵';
      if (!id) return;
      gAt.current = 0;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      setHit((h) => new Set(h).add(id!));
    };
    window.addEventListener('keydown', on, true);
    return () => window.removeEventListener('keydown', on, true);
  }, []);
  return (
    <div>
      <p className="sub" aria-live="polite">
        {hit.size} van {TOUR.length} geprobeerd
      </p>
      <div className="sw-keys ob-keys">
        {TOUR.map(([k, label]) => (
          <div key={k} className={`sw-key${hit.has(k) ? ' hit' : ''}`} data-key={k}>
            <span className="kbd">{k}</span>
            {label}
            {hit.has(k) && <Icon name="check" className="ob-hit" />}
          </div>
        ))}
      </div>
      <p className="sub">
        Hier en overal: <span className="kbd">?</span> toont alle sneltoetsen, <span className="kbd">Esc</span> sluit.
      </p>
    </div>
  );
}

function WeekritmeForm({ value, onChange }: { value: Weekritme; onChange: (w: Weekritme) => void }) {
  const set = (p: Partial<Weekritme>) => onChange({ ...value, ...p });
  return (
    <div className="card ob-form">
      <div className="ob-field">
        <span id="wr-dag">Plansessie</span>
        <div className="seg big-seg" role="radiogroup" aria-labelledby="wr-dag">
          {DAGEN.map(([d, l]) => (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={value.plansessieDag === d}
              className={value.plansessieDag === d ? 'on' : ''}
              onClick={() => set({ plansessieDag: d })}
            >
              {l}
            </button>
          ))}
        </div>
        <label className="ob-inline">
          om
          <input
            type="time"
            value={value.plansessieTijd}
            onChange={(e) => set({ plansessieTijd: e.target.value || '08:30' })}
            aria-label="Tijd van de plansessie"
          />
        </label>
      </div>
      <label className="ob-field ob-check">
        <input type="checkbox" checked={value.weekprep} onChange={(e) => set({ weekprep: e.target.checked })} />
        <span>
          Weekprep op zondagavond <span className="sub">(routine in Claude: terugblik, weekdoelen, meetingprep)</span>
        </span>
      </label>
      <div className="ob-field">
        <label className="ob-check">
          <input
            type="checkbox"
            checked={value.dagafsluiting !== null}
            onChange={(e) => set({ dagafsluiting: e.target.checked ? '17:00' : null })}
          />
          <span>Dagafsluiting</span>
        </label>
        {value.dagafsluiting !== null && (
          <label className="ob-inline">
            om
            <input
              type="time"
              value={value.dagafsluiting}
              onChange={(e) => set({ dagafsluiting: e.target.value || '17:00' })}
              aria-label="Tijd van de dagafsluiting"
            />
          </label>
        )}
      </div>
      <div className="ob-field">
        <span id="wr-doelen">Weekdoelen per week</span>
        <div className="seg big-seg" role="radiogroup" aria-labelledby="wr-doelen">
          {[3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={value.weekdoelen === n}
              className={value.weekdoelen === n ? 'on' : ''}
              onClick={() => set({ weekdoelen: n })}
            >
              {n}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

const STEP_WHY: Partial<Record<OnboardingStep, string>> = {
  google: 'Taken, Agenda en (als je wilt) Gmail, elk met een eigen toestemming',
  slack: 'gelezen zetten en reageren met je eigen account',
  jira: 'alleen lezen: sprint en wat je moet testen',
  github: 'contextlaag en je Persoonlijk-repo',
  agenda: 'kleuren en welke agenda’s overal verschijnen',
  weekritme: 'plansessie, weekprep en dagafsluiting',
  toetsenbord: 'de toetsen die je elke dag gebruikt',
};

function Welcome({ name }: { name: string }) {
  return (
    <div className="ob-welcome">
      <ol className="ob-plan card">
        {ONBOARDING_STEPS.slice(1).map((s, i) => (
          <li key={s}>
            <span className="ob-n">{i + 1}</span>
            <span>
              <b>{STEP_LABEL[s]}</b>
              <span className="sub"> · {STEP_WHY[s]}</span>
            </span>
          </li>
        ))}
      </ol>
      <div className="card ob-promise">
        <div className="card-body">
          <h2>Wat je van ons mag verwachten, {name}</h2>
          <ul>
            <li>Tokens staan versleuteld op de server. Je browser ziet ze nooit.</li>
            <li>De app verstuurt nooit zelf iets: Claude maakt concepten, jij drukt op Versturen.</li>
            <li>
              Intrekken kan altijd, per bron. Dan is het token weg, ook bij de bron, en wissen we je gegevens daarvan.
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}

export function Onboarding() {
  const ui = useUi();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const session = useSession().data;
  const ob = useOnboarding();
  const save = useUpdateOnboarding();
  const conns = useConnectionDetails().data?.connections;
  const state = ob.data;
  const paramStep = sp.get('stap') as OnboardingStep | null;
  const step: OnboardingStep =
    paramStep && (ONBOARDING_STEPS as readonly string[]).includes(paramStep)
      ? paramStep
      : ((state?.step as OnboardingStep | undefined) ?? 'welkom');
  const idx = ONBOARDING_STEPS.indexOf(step);
  const last = idx === ONBOARDING_STEPS.length - 1;
  const [ritme, setRitme] = useState<Weekritme | null>(null);
  const weekritme = ritme ?? state?.weekritme ?? WeekritmeSchema.parse({});
  const name = (session?.user.name || session?.user.email || '').split(/[\s@]/)[0] ?? '';

  // Terug van een bron (OAuth): één keer een melding tonen en de query opschonen.
  useReturnNotice(sp, setSp, ui.toast, (ok, fout) =>
    ok
      ? `${PROVIDER_CATALOG[ok as ProviderName]?.label ?? ok} gekoppeld`
      : fout === 'geweigerd'
        ? 'Je gaf geen toestemming; er is niets gekoppeld.'
        : 'Koppelen lukte niet. Probeer het opnieuw.',
  );

  const connectedIn = useMemo(() => {
    const ps = STEP_PROVIDERS[step];
    return ps ? (conns ?? []).filter((c) => ps.includes(c.provider) && c.status === 'connected').length : 0;
  }, [conns, step]);

  const go = (s: OnboardingStep) => {
    setSp({ stap: s });
    save.mutate({ step: s });
  };
  const finish = () =>
    save.mutate(
      { status: 'done', mark: { step, as: 'done' } },
      {
        onSuccess: () => {
          ui.toast('Klaar. Aanpassen kan altijd via Instellingen (g i).');
          nav('/dagstart');
        },
      },
    );
  const next = () => {
    if (last) return finish();
    const to = ONBOARDING_STEPS[idx + 1]!;
    // Een koppelstap zonder koppeling telt als overgeslagen.
    const as = STEP_PROVIDERS[step] && !connectedIn ? 'skipped' : 'done';
    save.mutate({ mark: { step, as }, step: to, ...(step === 'weekritme' ? { weekritme } : {}) });
    setSp({ stap: to });
  };
  const skip = () => {
    if (last) return finish();
    const to = ONBOARDING_STEPS[idx + 1]!;
    save.mutate({ mark: { step, as: 'skipped' }, step: to });
    setSp({ stap: to });
  };
  const back = () => idx > 0 && go(ONBOARDING_STEPS[idx - 1]!);
  const later = () =>
    save.mutate(
      { status: 'later', step },
      {
        onSuccess: () => {
          ui.toast('Bewaard. Verder waar je was via ⌘K → Inrichten, of g w.');
          nav('/dagstart');
        },
      },
    );

  const keys = useRef({ next, back, skip, later });
  keys.current = { next, back, skip, later };
  useEffect(() => {
    const on = (ev: KeyboardEvent) => {
      if (ev.metaKey || ev.ctrlKey || ev.altKey || isTyping(document.activeElement)) return;
      if (document.querySelector('.palette, [role="dialog"]')) return;
      const k = keys.current;
      const onButton =
        document.activeElement instanceof HTMLButtonElement || document.activeElement instanceof HTMLAnchorElement;
      if (ev.key === 'ArrowRight' || (ev.key === 'Enter' && !onButton && step !== 'toetsenbord')) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        k.next();
      } else if (ev.key === 'ArrowLeft') {
        ev.preventDefault();
        k.back();
      } else if (ev.key === 'o' && step !== 'toetsenbord') {
        ev.preventDefault();
        k.skip();
      } else if (ev.key === 'l' && step !== 'toetsenbord') {
        ev.preventDefault();
        k.later();
      }
    };
    window.addEventListener('keydown', on, true);
    return () => window.removeEventListener('keydown', on, true);
  }, [step]);

  if (ob.isLoading) return <div className="page">Laden…</div>;
  const returnTo = `/welkom?stap=${step}`;
  const yellow = step === 'welkom' || last;

  return (
    <div className="page ob-page">
      <header className={`hz-head felt ${yellow ? 'plane-yellow-light' : 'plane-blue-light'} ob-head`}>
        <PayoffShapes />
        <div>
          <div className="eyebrow">
            Inrichten · stap {idx + 1} van {ONBOARDING_STEPS.length}
          </div>
          <h1>{step === 'welkom' ? `Welkom${name ? `, ${name}` : ''}` : STEP_LABEL[step]}</h1>
        </div>
        <div className="hz-lead">
          <p>{LEAD[step]}</p>
        </div>
      </header>

      <nav className="tabs ob-steps" aria-label="Stappen van de onboarding">
        {ONBOARDING_STEPS.map((s, i) => {
          const st = state?.steps[s];
          return (
            <button
              key={s}
              type="button"
              className={`tab${s === step ? ' on' : ''}${st ? ` ${st}` : ''}`}
              aria-current={s === step ? 'step' : undefined}
              onClick={() => go(s)}
              title={st === 'skipped' ? `${STEP_LABEL[s]}: overgeslagen` : STEP_LABEL[s]}
            >
              {st === 'done' ? <Icon name="check" /> : <span className="ob-n">{i + 1}</span>}
              {STEP_LABEL[s]}
              {st === 'skipped' && <span className="visually-hidden"> (overgeslagen)</span>}
            </button>
          );
        })}
      </nav>

      <section className="ob-body" aria-label={STEP_LABEL[step]}>
        {step === 'welkom' && <Welcome name={name} />}
        {STEP_PROVIDERS[step] && (
          <ConnectorList
            only={STEP_PROVIDERS[step]}
            returnTo={returnTo}
            extra={{
              google_tasks: <TasksExtras c={conns?.find((c) => c.provider === 'google_tasks')} />,
              github: <PersRepoBlock />,
            }}
          />
        )}
        {step === 'agenda' && <CalendarLayers onConnect={() => go('google')} />}
        {step === 'weekritme' && <WeekritmeForm value={weekritme} onChange={setRitme} />}
        {step === 'toetsenbord' && <KeyTour />}
      </section>

      <footer className="ob-foot">
        <button type="button" className="btn" onClick={back} disabled={idx === 0} aria-label="Terug">
          <Icon name="chevL" />
          <span className="ob-long">Terug</span>
        </button>
        <span className="ob-spacer" />
        <button type="button" className="linklike ob-later" onClick={later}>
          Later<span className="ob-long"> afmaken</span> <span className="kbd">l</span>
        </button>
        {!last && (
          <button type="button" className="btn" onClick={skip} data-action="skip">
            Overslaan <span className="kbd">o</span>
          </button>
        )}
        <button type="button" className="btn primary" onClick={next} data-action="next">
          {last
            ? 'Klaar'
            : step === 'welkom'
              ? 'Beginnen'
              : connectedIn
                ? 'Verder'
                : STEP_PROVIDERS[step]
                  ? 'Verder zonder koppelen'
                  : 'Verder'}
          <span className="kbd kbd-on-blue">→</span>
        </button>
      </footer>
    </div>
  );
}
