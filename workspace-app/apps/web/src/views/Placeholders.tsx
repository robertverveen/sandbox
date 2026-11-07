/**
 * Lege schermen per onderdeel, in de huisstijl van het prototype. Elk scherm wordt in zijn eigen
 * stuk gebouwd; de route, de kop en het toetsenbordmodel staan al.
 */
import type { ReactNode } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { cap, isoWeek, baseDay, longDay } from '@hz/shared/logic';
import { useNow } from '../lib/queries';

function Todo({ stuk, children }: { stuk: string; children?: ReactNode }) {
  return (
    <div className="card todo-card" role="note">
      <div className="card-body">
        <div className="eyebrow">Volgt in het stuk {stuk}</div>
        <p className="sub" style={{ margin: '6px 0 0' }}>
          {children}
        </p>
      </div>
    </div>
  );
}

export function Planning() {
  const now = useNow();
  const [sp] = useSearchParams();
  const tab = sp.get('tab') === 'sprint' ? 'sprint' : 'mijn';
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">{now ? `${cap(longDay(now))} · week ${isoWeek(baseDay(now)).slice(6)}` : ' '}</div>
          <h1>Planning</h1>
        </div>
        <div className="seg big-seg" role="tablist" aria-label="Planning">
          <button type="button" role="tab" aria-selected={tab === 'mijn'} className={tab === 'mijn' ? 'on' : ''}>
            Mijn planning
          </button>
          <button type="button" role="tab" aria-selected={tab === 'sprint'} className={tab === 'sprint' ? 'on' : ''}>
            Sprint
          </button>
        </div>
      </div>
      <Todo stuk="Planning">
        Kolommen 1–5 met maximaal 10 per dag, snel toevoegen bij Vandaag en Morgen naar Google Taken, en de Sprint-tab.
      </Todo>
    </div>
  );
}

export function Agenda() {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Week</div>
          <h1>Agenda</h1>
        </div>
      </div>
      <Todo stuk="Agenda">
        Alle agenda’s in één week, kleuren en lagen, Lou en collega’s alleen hier, plannen met collega’s.
      </Todo>
    </div>
  );
}

const TRACKER_TABS = ['Taken', 'Wachten op', 'Bespreken', 'Partneracties', 'Weekdoelen', 'Afgerond'];

export function Tracker() {
  return (
    <div className="page toez-page">
      <header className="hz-head felt plane-blue-light">
        <div className="shapes" aria-hidden="true">
          <svg viewBox="0 0 300 300" style={{ right: 0, bottom: 0, width: 230, height: 230 }}>
            <path
              d="M258 128 334 196V336H182V196Z"
              strokeWidth="16"
              strokeLinejoin="round"
              fill="#b8c6ff"
              stroke="#b8c6ff"
            />
          </svg>
        </div>
        <div>
          <div className="eyebrow">Tracker</div>
          <h1>Tracker</h1>
        </div>
        <div className="hz-lead">
          <p>
            Eén plek voor wat je moet doen en waar je op wacht. Taken komen uit Google Taken en <code>taken.md</code>,
            wachten op en bespreken uit <code>wachten-op.md</code>, partneracties uit <code>acties.md</code>. De
            workspace bewaart zelf alleen je weekdoelen.
          </p>
        </div>
      </header>
      <div className="tabs" role="tablist" aria-label="Tracker">
        {TRACKER_TABS.map((t, i) => (
          <button key={t} type="button" role="tab" aria-selected={i === 0} className={`tab${i === 0 ? ' on' : ''}`}>
            {t}
            <span className="tab-kbd">⇧{i + 1}</span>
          </button>
        ))}
      </div>
      <Todo stuk="Tracker">
        Leest acties.md van alle partners (filter op eigenaar), taken.md en wachten-op.md; de database bewaart alleen
        leesstatus en weekdoelen.
      </Todo>
    </div>
  );
}

export function Chat() {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Slack en mail</div>
          <h1>Gesprekken</h1>
        </div>
      </div>
      <Todo stuk="Gesprekken">
        Alle mail, DM’s en kanalen volledig, threads, antwoorden, @-tags en emoji; Inhalen met ← en →.
      </Todo>
    </div>
  );
}

export function Zoeken() {
  const [sp] = useSearchParams();
  return (
    <div className="page search-page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Zoeken in Slack, mail en je workspace</div>
          <h1>{sp.get('q') || 'Zoeken'}</h1>
        </div>
      </div>
      <Todo stuk="Zoeken">
        Organisaties herkennen, komma-verfijning, lijst, tijdlijn en Gantt, kanalen en DM’s, vastzetten.
      </Todo>
    </div>
  );
}

export function PartnerPage() {
  const { slug } = useParams();
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Organisatie</div>
          <h1>{slug}</h1>
        </div>
      </div>
      <Todo stuk="Context">Partnerpagina met Kern, Stand, contacten, acties en meetings uit de contextlaag.</Todo>
    </div>
  );
}
