/** ?-hulp: alle sneltoetsen (renderHelp() in het prototype). Gemarkeerd wat in dit stuk al werkt. */
import { DAY_CAP } from '@hz/shared/logic';
import { Icon } from '../lib/icons';
import { useUi } from '../lib/ui';

type Row = [string, string];

const GROUPS: Array<[string, Row[]]> = [
  [
    'Overal',
    [
      ['⌘K /', 'zoeken en commando’s'],
      ['?', 'dit overzicht'],
      ['g d', 'Dagstart'],
      ['g p', 'Planning'],
      ['g a', 'Agenda'],
      ['g t', 'Tracker'],
      ['g c', 'Chat'],
      ['g i', 'Instellingen en koppelingen'],
      ['g w', 'inrichten (onboarding)'],
      ['Esc', 'sluiten'],
    ],
  ],
  [
    'Agenda',
    [
      ['l', 'lagen aan/uit, kleuren'],
      ['n', "inplannen met collega's"],
      ['1–6', 'voorgestelde tijd kiezen'],
      ['⌘↵', 'uitnodiging versturen'],
      ['[ ]', 'vorige / volgende week'],
    ],
  ],
  [
    'Bewegen',
    [
      ['j ↓', 'volgende'],
      ['k ↑', 'vorige'],
      ['↵', 'details rechts'],
      ['o', 'openen in Slack, Gmail, Tasks, Agenda'],
      ['n', 'nieuw item (Tracker)'],
      ['⇧1–6', 'tab (Tracker)'],
    ],
  ],
  [
    'Plannen',
    [
      ['s', 'plansessie: kaart voor kaart'],
      ['1', 'vandaag'],
      ['2', 'morgen'],
      ['3', 'later deze week'],
      ['4', 'volgende week'],
      ['5', 'backlog'],
      ['x', 'klaar / binnen'],
    ],
  ],
  [
    'Verwerken',
    [
      ['e', 'gelezen (mail ook in Gmail)'],
      ['⇧E', 'gelezen + ✅ in Slack'],
      ['w', 'wachten op'],
      ['b', 'bespreken bij contact'],
      ['r', 'recap met Claude (/klant-recap)'],
      ['y m n', 'uitnodiging: ja, misschien, nee'],
    ],
  ],
];

export function Help() {
  const ui = useUi();
  const close = () => ui.setHelp(false);
  return (
    <div className="scrim" data-action="close-help" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette sheet" role="dialog" aria-modal="true" aria-label="Sneltoetsen" style={{ maxWidth: 820 }}>
        <div className="pal-input" style={{ justifyContent: 'space-between' }}>
          <b>Sneltoetsen</b>
          <button type="button" className="iconbtn" aria-label="Sluiten" onClick={close} autoFocus>
            <Icon name="x" />
          </button>
        </div>
        <div className="pal-results help-grid">
          {GROUPS.map(([t, rows]) => (
            <div key={t}>
              <h3 style={{ margin: '0 0 6px', fontSize: 13 }}>{t}</h3>
              {rows.map(([k, l]) => (
                <div className="hk" key={k + l}>
                  <span className="kbd">{k}</span>
                  <span>{l}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="pal-foot">
          <span>
            Max {DAY_CAP} items per dag. Plannen schrijft de datum in Google Taken; wachten op en bespreken gaan naar
            wachten-op.md.
          </span>
        </div>
      </div>
    </div>
  );
}
