/**
 * Jobs van de worker. In het fundament één voorbeeldjob; de sync-motor (HZW-036), de contextindex
 * (HZW-060) en skills als job (HZW-051) komen in hun eigen stukken.
 */
import { sql } from 'drizzle-orm';
import { activeUserIds, weekdoelen, withUser, type Db } from '@hz/db';
import type { ContextProvider } from '@hz/providers';

export const QUEUES = {
  /** Voorbeeld: tel open partneracties per eigenaar uit de contextlaag. */
  telActies: 'context.tel-acties',
  /** Voorbeeld van een job op app-tabellen: per collega (withUser, RLS) de open weekdoelen tellen. */
  telWeekdoelen: 'app.tel-weekdoelen',
} as const;

export interface TelActiesInput {
  /** Alleen acties met een datum tot en met deze dag (JJJJ-MM-DD); leeg = alle open acties. */
  tot?: string;
}

export interface TelActiesOutput {
  open: number;
  overDatum: number;
  perEigenaar: Record<string, number>;
}

export async function telActies(context: ContextProvider, input: TelActiesInput): Promise<TelActiesOutput> {
  const snap = await context.snapshot();
  const out: TelActiesOutput = { open: 0, overDatum: 0, perEigenaar: {} };
  for (const doc of Object.values(snap.acties)) {
    for (const a of doc.acties) {
      if (a.state !== 'open') continue;
      out.open++;
      if (input.tot && a.datum && a.datum < input.tot) out.overDatum++;
      const who = (a.eigenaar || 'onbekend').split(/\s+/)[0]!;
      out.perEigenaar[who] = (out.perEigenaar[who] ?? 0) + 1;
    }
  }
  return out;
}

export interface TelWeekdoelenOutput {
  gebruikers: number;
  open: number;
  /** current_user en session_user in de job: hz_app en de worker-login, nooit de eigenaar van de tabellen. */
  rol: string;
  login: string;
}

/**
 * Job op app-tabellen: de worker kent alleen de id's van actieve collega's (SECURITY DEFINER-functie) en leest per
 * collega met withUser, dus onder RLS en als hz_app. Zo werkt elke job die per collega iets doet.
 */
export async function telWeekdoelen(db: Db): Promise<TelWeekdoelenOutput> {
  const ids = await activeUserIds(db);
  let open = 0;
  let who = { rol: '', login: '' };
  for (const id of ids) {
    const r = await withUser(db, id, async (tx) => {
      const [c] = (await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(weekdoelen)
        .where(sql`${weekdoelen.status} = 'open'`)) as [{ n: number }];
      const w = (
        await tx.execute<{ rol: string; login: string }>(sql`select current_user as rol, session_user as login`)
      ).rows[0]!;
      return { n: c.n, ...w };
    });
    open += r.n;
    who = { rol: r.rol, login: r.login };
  }
  if (!ids.length) {
    who = (await db.execute<{ rol: string; login: string }>(sql`select current_user as rol, session_user as login`))
      .rows[0]!;
  }
  return { gebruikers: ids.length, open, ...who };
}
