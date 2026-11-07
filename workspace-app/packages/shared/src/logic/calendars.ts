/** Agendalagen: groepen, Google-kleuren en bereik, zoals in het prototype. */
import type { CalendarInfo } from '../domain';

export const GCAL = {
  HomeZero_geel: '#e2c25a',
  Gmail_blauw: '#4a99e0',
  Vrij_groen: '#3f9484',
  Lou_paars: '#b39ddb',
  Tomaat: '#d50000',
  Flamingo: '#e67c73',
  Mandarijn: '#f4511e',
  Banaan: '#f6bf26',
  Salie: '#33b679',
  Basilicum: '#0b8043',
  Pauw: '#039be5',
  Bosbes: '#3f51b5',
  Lavendel: '#7986cb',
  Druif: '#8e24aa',
  Grafiet: '#616161',
  Kersenbloesem: '#d81b60',
  Radicchio: '#ad1457',
  Pompoen: '#ef6c00',
  Mango: '#f09300',
  Citroen: '#e4c441',
  Avocado: '#c0ca33',
  Pistache: '#7cb342',
  Eucalyptus: '#009688',
  Kobalt: '#4285f4',
  Blauwe_regen: '#b39ddb',
  Amethist: '#9e69af',
  Cacao: '#795548',
  Berk: '#a79b8e',
} as const;
type GcalName = keyof typeof GCAL;

export const CAL_GROUPS = [
  ['werk', 'Werk'],
  ['prive', 'Privé'],
  ['lou', 'Lou'],
  ['collegas', "Collega's"],
  ['overig', 'Overig'],
] as const;
export type CalGroup = (typeof CAL_GROUPS)[number][0];

const GROUP_DEFAULTS: Record<CalGroup, { on: boolean; scope: 'overal' | 'agenda' }> = {
  werk: { on: true, scope: 'overal' },
  prive: { on: true, scope: 'overal' },
  lou: { on: true, scope: 'agenda' },
  collegas: { on: false, scope: 'agenda' },
  overig: { on: false, scope: 'agenda' },
};
const GROUP_COLORS: Record<CalGroup, GcalName[]> = {
  werk: ['Pauw', 'Cacao', 'Basilicum'],
  prive: ['Mandarijn', 'Flamingo', 'Mango'],
  lou: ['Druif', 'Lavendel', 'Amethist', 'Blauwe_regen', 'Kersenbloesem', 'Salie', 'Citroen', 'Radicchio'],
  collegas: ['Bosbes', 'Kobalt', 'Eucalyptus', 'Pistache', 'Pompoen', 'Avocado', 'Grafiet', 'Berk'],
  overig: ['Berk', 'Grafiet'],
};

interface RawCal {
  id: string;
  summary?: string;
  primary?: boolean;
  backgroundColor?: string;
}

export function calGroup(c: RawCal, selfEmail: string): CalGroup {
  const id = c.id.toLowerCase();
  if (c.primary || id === selfEmail) return 'werk';
  if (/import\.calendar\.google\.com$/.test(id)) return 'lou';
  if (/@homezero\.nl$/.test(id)) return 'collegas';
  if (/#holiday@group/.test(id) || /homezero/i.test(c.summary || '')) return 'werk';
  if (/robertverveen/.test(id) || /@group\.calendar\.google\.com$/.test(id)) return 'prive';
  return 'overig';
}

/** Standaardinstelling per agenda (aan/uit, kleur, "overal" of "alleen in Agenda"). */
export function calDefaults(all: RawCal[], selfEmail: string): CalendarInfo[] {
  return all.map((c) => {
    const g = calGroup(c, selfEmail);
    const id = c.id.toLowerCase();
    const name = (c.summary || '').toLowerCase();
    const same = all.filter((x) => calGroup(x, selfEmail) === g);
    const palette = GROUP_COLORS[g];
    let color: string = GCAL[palette[Math.max(0, same.indexOf(c)) % palette.length]!];
    if (c.primary || id === selfEmail) color = GCAL.HomeZero_geel;
    else if (/robertverveen@gmail\.com/.test(id)) color = GCAL.Gmail_blauw;
    else if (/vakantie|vrij/.test(name) && g === 'werk') color = GCAL.Vrij_groen;
    else if (/#holiday@group/.test(id)) color = GCAL.Basilicum;
    else if (g === 'lou') color = GCAL.Lou_paars;
    else if (/familie/.test(name)) color = GCAL.Flamingo;
    const d = GROUP_DEFAULTS[g];
    return {
      id: c.id,
      summary: c.summary || c.id,
      primary: c.primary,
      color: c.backgroundColor || color,
      group: g,
      scope: d.scope,
      on: d.on,
    };
  });
}
