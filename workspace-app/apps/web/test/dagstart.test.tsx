/**
 * Dagstart en de schil renderen met echte API-antwoorden (de API draait in hetzelfde proces op de
 * fixture-providers; fetch gaat via app.request, dus zonder netwerk).
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '@hz/api';
import { loadConfig } from '@hz/api/config';
import { MemoryStore } from '@hz/api/store';
import { createProviders } from '@hz/providers';
import { App } from '../src/App';
import { createQueryClient } from '../src/lib/queries';
import { matchPartners } from '../src/components/Palette';

function mountApiAsFetch() {
  const bundle = createProviders({});
  const { app } = createApp({
    config: loadConfig({ NODE_ENV: 'test' }),
    bundle,
    store: new MemoryStore(bundle.dataset),
  });
  let cookie = '';
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers = new Headers(init?.headers);
    if (cookie) headers.set('cookie', cookie);
    const res = await app.request(url, { ...init, headers });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!;
    return res;
  });
}

beforeEach(() => {
  localStorage.clear();
  window.history.pushState({}, '', '/dagstart');
  window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  })) as never;
  Element.prototype.scrollIntoView = () => {};
  mountApiAsFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Dagstart (HZW-041) op fixture-data', () => {
  it('logt in via de dev-stub en toont de dag', async () => {
    render(<App client={createQueryClient()} />);
    expect(await screen.findByText('Vrijdag 30 oktober')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/Welkom terug, Robert/);
    const sum = document.querySelector('.calm-sum')!.textContent!;
    expect(sum).toContain('10 om te beslissen');
    expect(sum).toContain('3/10 gepland voor vandaag');
    const today = document.querySelector('section[aria-labelledby="ds-today"] > .list')!;
    expect(
      within(today as HTMLElement)
        .getAllByRole('button')
        .map((b) => b.querySelector('.row-title')!.textContent),
    ).toEqual([
      '🛠 Prep: TonZon x HomeZero (30 min)',
      'Release notes sprint 64 versturen',
      '🎯 Isolatieflow TonZon live op acceptatie',
    ]);
    expect(document.querySelectorAll('.mini-agenda .ma-row')).toHaveLength(3);
    expect(document.querySelector('.ctx-day')!.textContent).toContain('Uit de contextlaag');
  });

  it('zijbalk telt mee, ? opent de hulp, g t gaat naar de Tracker', async () => {
    render(<App client={createQueryClient()} />);
    await screen.findByText('Vrijdag 30 oktober');
    const nav = [...document.querySelectorAll('.sidebar .nav-item')].map((a) => a.textContent);
    expect(nav[0]).toMatch(/Dagstart10/);
    act(() => {
      fireEvent.keyDown(document, { key: '?' });
    });
    expect(screen.getByRole('dialog', { name: 'Sneltoetsen' })).toBeTruthy();
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    act(() => {
      fireEvent.keyDown(document, { key: 'g' });
      fireEvent.keyDown(document, { key: 't' });
    });
    expect(await screen.findByRole('heading', { name: 'Tracker' })).toBeTruthy();
    expect(window.location.pathname).toBe('/tracker');
  });

  it('klik op een rij opent de inspector', async () => {
    render(<App client={createQueryClient()} />);
    await screen.findByText('Vrijdag 30 oktober');
    fireEvent.click(screen.getByText('Release notes sprint 64 versturen'));
    const insp = document.getElementById('inspector')!;
    expect(insp.hidden).toBe(false);
    expect(insp.textContent).toContain('Release notes sprint 64 versturen');
  });
});

describe('palet: organisaties herkennen', () => {
  const p = (slug: string, naam: string, aliassen: string[] = []) =>
    ({
      slug,
      naam,
      aliassen,
      soort: 'partner',
      domeinen: [],
      slack: '',
      fase: '',
      accountmanager: '',
      geheim_voor: [],
      bijgewerkt: '',
      kern: '',
      stand: [],
      contacten: [],
      meetings: [],
      log: [],
      open_acties: 0,
    }) as const;
  it('op slug, naam en alias; exact eerst', () => {
    const list = [p('feenstra', 'Feenstra', ['Fleur']), p('tonzon', 'TonZon'), p('fenix', 'Fenix Energie')];
    expect(matchPartners(list as never, 'fe').map((x) => x.slug)).toEqual(['feenstra', 'fenix']);
    expect(matchPartners(list as never, 'fleur').map((x) => x.slug)).toEqual(['feenstra']);
    expect(matchPartners(list as never, 'x')).toEqual([]);
  });
});
