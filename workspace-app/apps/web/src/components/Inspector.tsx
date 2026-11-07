/** Inspector (skelet): details van het gekozen item rechts. Het inspector-stuk voegt de volledige context toe. */
import { Link } from 'react-router';
import { pd } from '@hz/shared/logic';
import { Icon } from '../lib/icons';
import { useDagstart } from '../lib/queries';
import { useUi } from '../lib/ui';
import { itemSub, relTime, SrcLabel } from './Row';

export function Inspector() {
  const ui = useUi();
  const d = useDagstart().data;
  const it = ui.selected ? d?.items.find((i) => i.id === ui.selected) : undefined;
  if (!ui.selected || !it || !d) return <aside className="inspector" id="inspector" hidden />;
  const now = pd(d.now);
  const body = 'body' in it ? it.body : it.type === 'task' ? it.notes : undefined;
  return (
    <aside className="inspector" id="inspector" aria-label="Details">
      <div className="insp-head">
        <SrcLabel type={it.type} />
        <button type="button" className="iconbtn" aria-label="Sluiten" onClick={() => ui.select(null)}>
          <Icon name="x" />
        </button>
      </div>
      <h2 className="insp-title">{it.title}</h2>
      <div className="sub">
        {itemSub(it, (s) => d.context.partners[s]?.naam)}
        {relTime(it, now) ? ` · ${relTime(it, now)}` : ''}
      </div>
      {it.entities.length > 0 && (
        <div className="actions">
          {it.entities.map((e) => (
            <Link key={e} className="chip entity" to={`/o/${e}`}>
              {d.context.partners[e]?.naam ?? e}
            </Link>
          ))}
        </div>
      )}
      {body && <div className="insp-body">{body}</div>}
      <div className="actions">
        {it.url && (
          <a className="btn sm" href={it.url} target="_blank" rel="noopener noreferrer">
            Openen <Icon name="out" />
          </a>
        )}
      </div>
    </aside>
  );
}
