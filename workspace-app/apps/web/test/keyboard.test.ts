import { describe, expect, it } from 'vitest';
import { decide, GO_KEYS, isTyping } from '../src/lib/keyboard';

const press = (keys: string[], path = '/dagstart', step = 100) => {
  let state = { gAt: null as number | null };
  const out = [];
  let t = 1000;
  for (const key of keys) {
    const r = decide(state, { key, path, now: (t += step) });
    state = r.state;
    out.push(r.action);
  }
  return out;
};

describe('toetsenbordmodel', () => {
  it('g gevolgd door d/p/a/t/c navigeert', () => {
    for (const [k, to] of Object.entries(GO_KEYS)) expect(press(['g', k]).at(-1)).toEqual({ type: 'go', to });
  });

  it('g verloopt na 1,2 seconde', () => {
    expect(press(['g', 'p'], '/dagstart', 1300).at(-1)).toEqual({ type: 'none' });
  });

  it('⌘K en / openen het palet, ? de hulp, Esc sluit', () => {
    expect(decide({ gAt: null }, { key: 'k', meta: true }).action).toEqual({ type: 'palette' });
    expect(decide({ gAt: null }, { key: 'K', ctrl: true }).action).toEqual({ type: 'palette' });
    expect(press(['/']).at(-1)).toEqual({ type: 'palette' });
    expect(press(['?']).at(-1)).toEqual({ type: 'help' });
    expect(press(['Escape']).at(-1)).toEqual({ type: 'escape' });
  });

  it('j/k en pijltjes bewegen, Enter opent', () => {
    expect(press(['j', 'ArrowDown', 'k', 'ArrowUp', 'Enter'])).toEqual([
      { type: 'move', delta: 1 },
      { type: 'move', delta: 1 },
      { type: 'move', delta: -1 },
      { type: 'move', delta: -1 },
      { type: 'open' },
    ]);
  });

  it('typen in een veld negeert sneltoetsen, behalve ⌘K en Esc', () => {
    expect(decide({ gAt: null }, { key: 'g', typing: true }).action).toEqual({ type: 'none' });
    expect(decide({ gAt: null }, { key: 'k', typing: true, meta: true }).action).toEqual({ type: 'palette' });
    expect(decide({ gAt: null }, { key: 'Escape', typing: true }).action).toEqual({ type: 'escape' });
  });

  it('s start de plansessie alleen op Dagstart, Planning en Tracker', () => {
    expect(press(['s'], '/dagstart').at(-1)).toEqual({ type: 'plansessie' });
    expect(press(['s'], '/agenda').at(-1)).toEqual({ type: 'none' });
  });

  it('isTyping herkent invoervelden', () => {
    expect(isTyping(document.createElement('input'))).toBe(true);
    expect(isTyping(document.createElement('button'))).toBe(false);
    expect(isTyping(null)).toBe(false);
  });
});
