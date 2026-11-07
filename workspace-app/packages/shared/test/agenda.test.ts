import { describe, expect, it } from 'vitest';
import { NewEvent, NewPin, Preferences, RepoWrite } from '../src';
import { addWorkdaysYmd, freeSlots } from '../src/logic';

describe('freeSlots (vrije tijden met collega’s, HZW-030)', () => {
  const busy = [
    { start: '2026-10-30T10:00', end: '2026-10-30T11:00' },
    { start: '2026-10-30T13:00', end: '2026-10-30T13:45' },
  ];
  it('werktijd 09:00–17:30, niet over bezette blokken, raster van 30 minuten', () => {
    const f = freeSlots(busy, '2026-10-30', '2026-10-31', { duration: 60 });
    expect(f.map((x) => x.start.slice(11))).toEqual([
      '09:00',
      '11:00',
      '11:30',
      '12:00',
      '14:00',
      '14:30',
      '15:00',
      '15:30',
      '16:00',
      '16:30',
    ]);
  });
  it('slaat het weekend over en respecteert notBefore', () => {
    const f = freeSlots([], '2026-10-30', '2026-11-03', { duration: 30, notBefore: '2026-10-30T16:40' });
    expect(f[0]!.start).toBe('2026-10-30T17:00');
    expect(f.some((x) => x.start.startsWith('2026-10-31') || x.start.startsWith('2026-11-01'))).toBe(false);
    expect(f.some((x) => x.start.startsWith('2026-11-02'))).toBe(true);
  });
  it('een hele-dag-afspraak (vakantie) blokkeert de hele dag; zomertijd speelt geen rol (wandklok)', () => {
    const f = freeSlots([{ start: '2026-10-26', end: '2026-10-26' }], '2026-10-23', '2026-10-27', { duration: 30 });
    expect(f.some((x) => x.start.startsWith('2026-10-26'))).toBe(false);
    // 25 oktober 2026 is de wissel naar wintertijd (zondag); vrijdag ervoor en dinsdag erna gewoon vanaf 09:00.
    expect(f[0]!.start).toBe('2026-10-23T09:00');
  });
  it('werkdagen tellen', () => {
    expect(addWorkdaysYmd('2026-11-06', 3)).toBe('2026-11-11');
  });
});

describe('schema’s voor de nieuwe routes', () => {
  it('NewEvent: einde na begin', () => {
    expect(NewEvent.safeParse({ title: 'x', start: '2026-11-02T10:00', end: '2026-11-02T10:00' }).success).toBe(false);
    expect(NewEvent.parse({ title: 'x', start: '2026-11-02T10:00', end: '2026-11-02T10:30' }).attendees).toEqual([]);
  });
  it('NewPin: zoekopdracht vraagt q, view vraagt een route binnen de app', () => {
    expect(NewPin.safeParse({ kind: 'search', label: 'x' }).success).toBe(false);
    expect(NewPin.safeParse({ kind: 'view', label: 'x', view: 'javascript:alert(1)' }).success).toBe(false);
    expect(NewPin.safeParse({ kind: 'view', label: 'x', view: '/tracker?tab=wachten' }).success).toBe(true);
  });
  it('Preferences: standaard systeemthema, agenda scope overal of alleen in Agenda', () => {
    expect(Preferences.parse({})).toEqual({ theme: 'system', calendars: {} });
    expect(Preferences.safeParse({ calendars: { a: { scope: 'ergens' } } }).success).toBe(false);
  });
  it('RepoWrite: alleen de vier soorten', () => {
    expect(RepoWrite.safeParse({ kind: 'admin', tekst: 'x' }).success).toBe(false);
  });
});
