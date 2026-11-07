/** Een rij zoals rowHTML() in het prototype: icoon, titel, reden of samenvatting, tijd. */
import type { Item } from '@hz/shared';
import { dayLabel, fmtDate, hm, KIND, kindOf, pd, short, STATUS, STROOM, when, type Kind } from '@hz/shared/logic';
import { Icon, type IconName } from '../lib/icons';
import { useUi } from '../lib/ui';

export const SRC: Record<Item['type'], { label: string; plural: string; icon: IconName }> = {
  jira: { label: 'Jira', plural: 'Sprint', icon: 'git' },
  meeting: { label: 'Agenda', plural: 'Meetings', icon: 'meeting' },
  rec: { label: 'Wispr', plural: 'Opnames', icon: 'mic' },
  mail: { label: 'Mail', plural: 'Mail', icon: 'mail' },
  slack: { label: 'Slack', plural: 'Slack', icon: 'slack' },
  commit: { label: 'Tracker', plural: 'Tracker', icon: 'commit' },
  context: { label: 'Contextlaag', plural: 'Contextlaag', icon: 'context' },
  task: { label: 'Google Tasks', plural: 'Taken', icon: 'task' },
};

export function SrcLabel({ type }: { type: Item['type'] }) {
  return (
    <span className={`src src-${type}`}>
      <Icon name={SRC[type].icon} />
      {SRC[type].label}
    </span>
  );
}

export function relTime(it: Item, now: Date): string {
  if (it.type === 'task')
    return it.backlog ? 'Backlog' : it.due ? (it.overdue ? 'Te laat · ' : '') + dayLabel(pd(it.due), now) : '';
  if (it.type === 'commit') {
    const d = it.stroom === 'aan_mij' ? it.reminder : it.plan || it.deadline;
    return it.backlog ? 'Backlog' : d ? dayLabel(pd(d), now) : '';
  }
  if (it.type === 'jira') return '';
  const t = when(it, now);
  const dl = dayLabel(t, now);
  if (it.type === 'meeting' || it.type === 'rec')
    return (dl === 'Vandaag' ? '' : dl + ' ') + (it.type === 'meeting' && it.allDay ? 'hele dag' : hm(t));
  return dl === 'Vandaag' ? hm(t) : dl;
}

export function itemSub(it: Item, orgName?: (slug: string) => string | undefined): string {
  const org = it.entities[0] && orgName ? orgName(it.entities[0]) : undefined;
  switch (it.type) {
    case 'mail':
      return `${it.fromName}${org ? ' · ' + org : ''}${it.direct ? '' : ' · cc'}${(it.count ?? 0) > 1 ? ' · ' + it.count + ' berichten' : ''}${it.body ? ' · ' + short(it.body, 80) : ''}`;
    case 'slack':
      return `${it.channel} · ${it.fromMe ? 'jij' : it.fromName}${it.answered ? ' · beantwoord' : ''}${it.read ? ' · gelezen' : ''}`;
    case 'meeting':
      return it.allDay
        ? 'Hele dag'
        : `${hm(pd(it.start))}–${hm(pd(it.end))}${it.where ? ' · ' + short(it.where, 30) : ''}${it.attendeeNames.length ? ' · ' + it.attendeeNames.length + ' deelnemers' : ''}`;
    case 'rec':
      return `Wispr · ${it.attendeeNames.slice(0, 3).join(', ')}${it.recapDone ? ' · recap gedeeld' : ''}`;
    case 'task':
      return `${it.backlog ? 'Backlog' : it.due ? (it.overdue ? 'Over tijd · ' : '') + 'gepland ' + fmtDate(it.due) : 'Geen datum'}${(it.moved ?? 0) >= 2 ? ' · ' + it.moved + 'e keer doorgeschoven' : ''}`;
    case 'commit':
      return `${STATUS[it.status]} · ${STROOM[it.stroom] ?? ''}${it.aan ? ' · ' + it.aan : ''}${it.linkedTask ? ' · Google Tasks' : ''}`;
    case 'jira':
      return `${it.key} · ${it.status}${it.assignee ? ' · ' + it.assignee : ''}`;
    case 'context':
      return 'Contextlaag';
  }
}

interface RowProps {
  it: Item;
  now: Date;
  kind?: Kind;
  why?: string;
  kindChip?: boolean;
  chip?: boolean;
  orgName?: (slug: string) => string | undefined;
}

export function Row({ it, now, kind, why, kindChip, chip = true, orgName }: RowProps) {
  const ui = useUi();
  const k = kind ?? kindOf(it);
  const kc = KIND[k];
  const unread = (it.type === 'mail' && it.unread && !it.read) || false;
  let chipEl = null;
  if (chip) {
    if (it.type === 'meeting' && it.needsAction) chipEl = <span className="chip warn">Uitnodiging</span>;
    else if (it.type === 'commit') chipEl = <span className={`st st-${it.status}`}>{STATUS[it.status]}</span>;
    else if ((it.moved ?? 0) >= 2) chipEl = <span className="chip warn">{it.moved}× doorgeschoven</span>;
  }
  return (
    <button
      type="button"
      className={`row${ui.selected === it.id ? ' sel' : ''}`}
      data-open={it.id}
      data-k={it.id}
      data-kind={k}
      onClick={() => ui.select(it.id)}
    >
      <span className={`ic ${it.type}`}>
        <Icon name={SRC[it.type].icon} />
      </span>
      <span className="row-main">
        <span className={`row-title${unread ? ' unread' : ''}`} style={{ display: 'block' }}>
          {kindChip && kc[1] ? <span className={`kind ${kc[0]}`}>{kc[1]}</span> : null}
          {short(it.title, 120)}
        </span>
        <span className="row-sub" style={{ display: 'block' }}>
          {why ?? itemSub(it, orgName)}
        </span>
      </span>
      {chipEl}
      <span className="row-meta">{relTime(it, now)}</span>
    </button>
  );
}
