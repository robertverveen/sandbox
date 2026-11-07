/**
 * Jobs van de worker. In het fundament één voorbeeldjob; de sync-motor (HZW-036), de contextindex
 * (HZW-060) en skills als job (HZW-051) komen in hun eigen stukken.
 */
import type { ContextProvider } from '@hz/providers';

export const QUEUES = {
  /** Voorbeeld: tel open partneracties per eigenaar uit de contextlaag. */
  telActies: 'context.tel-acties',
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
