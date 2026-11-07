/**
 * ⌘K-palet (zoals de lat): organisatie herkennen met chip en komma-hint, groepen Gesprekken, Mail, Slack
 * en Contextlaag, tellers per bron. Op de demodata van het prototype.
 */
import { describe, expect, it } from 'vitest';
import { createProviders } from '@hz/providers';
import type { Item } from '@hz/shared';
import { parseQuery, searchEntries } from '../src/lib/palette';

const bundle = createProviders({});
const ds = bundle.dataset;
const partners = Object.values(ds.context.partners);
const plural = {
  commit: 'Tracker',
  task: 'Taken',
  context: 'Contextlaag',
  meeting: 'Meetings',
  rec: 'Opnames',
  mail: 'Mail',
  slack: 'Slack',
  jira: 'Sprint',
} as Record<Item['type'], string>;

async function data() {
  const items = [...ds.meetings, ...ds.mails, ...ds.slack, ...ds.tasks, ...ds.recs, ...ds.legacyCommits] as Item[];
  const conversations = [
    ...(await bundle.providers.slack.listConversations()),
    ...(await bundle.providers.gmail.listConversations()),
  ];
  return { items, partners, conversations, context: ds.context, srcPlural: plural };
}

describe('palet: zoeken', () => {
  it('"feen" herkent Feenstra (uniek begin) en geeft de komma-verfijning', () => {
    expect(parseQuery('feen', partners)).toMatchObject({ entities: ['feenstra'], keywords: [] });
    expect(parseQuery('feenstra, berekening, timeline', partners)).toMatchObject({
      entities: ['feenstra'],
      keywords: ['berekening'],
      mode: 'timeline',
    });
  });

  it('toont Gesprekken, Zoeken, Organisatie en de groepen Mail, Slack en Contextlaag die de teller noemt', async () => {
    const r = searchEntries('feen', await data());
    const kinds = r.entries.map((e) => (e.kind === 'item' ? e.it.type : e.kind));
    expect(kinds[0]).toBe('conv');
    expect(kinds).toContain('live');
    const ent = r.entries.find((e) => e.kind === 'entity');
    expect(ent && ent.kind === 'entity' && ent.counts).toMatch(/1 mail/);
    expect(ent && ent.kind === 'entity' && ent.counts).toMatch(/1 slack/);
    expect(ent && ent.kind === 'entity' && ent.counts).toMatch(/contextlaag/);
    // Elke bron uit de teller staat ook in de resultaten.
    for (const t of ['mail', 'slack', 'commit', 'meeting'] as const) expect(kinds, t).toContain(t);
    expect(kinds).toContain('ctx');
    const brief = r.entries.find((e) => e.kind === 'ctx');
    expect(brief && brief.kind === 'ctx' && brief.h.title).toBe('partners/feenstra/brief.md');
    expect(r.counts.mail).toBe(1);
    expect(r.counts.slack).toBe(1);
  });

  it('nooit admin.md of iets van een andere organisatie bij een organisatiezoekopdracht', async () => {
    const r = searchEntries('feenstra', await data());
    expect(JSON.stringify(r.entries)).not.toMatch(/admin\.md/);
    for (const e of r.entries) if (e.kind === 'item') expect(e.it.entities).toContain('feenstra');
  });

  it('losse woorden zoeken in titel en tekst; geen organisatie = geen chip', async () => {
    const r = searchEntries('rekenvoorbeeld', await data());
    expect(r.parsed.entities).toEqual([]);
    expect(r.entries.some((e) => e.kind === 'item' && /Rekenvoorbeeld/.test(e.it.title))).toBe(true);
  });
});
