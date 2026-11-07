/**
 * Toetsenbordmodel van het prototype als pure functie: g-sneltoetsen (g d/p/a/t/c), ⌘K en / voor het
 * palet, ? voor hulp, j/k en pijltjes om te bewegen, Enter voor details, Esc om te sluiten.
 * De component (useKeyboard) koppelt dit aan document-events; hier zit alleen de beslislogica.
 */

export const GO_KEYS: Record<string, string> = {
  d: '/dagstart',
  p: '/planning',
  a: '/agenda',
  t: '/tracker',
  c: '/chat',
};

export type KeyAction =
  | { type: 'none' }
  | { type: 'go'; to: string }
  | { type: 'palette' }
  | { type: 'help' }
  | { type: 'escape' }
  | { type: 'move'; delta: 1 | -1 }
  | { type: 'open' }
  | { type: 'plansessie' }
  | { type: 'pending' };

export interface KeyState {
  /** Tijdstip waarop `g` werd ingedrukt (ms), of null. */
  gAt: number | null;
}

export interface KeyInput {
  key: string;
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  /** Focus staat in een invoerveld. */
  typing?: boolean;
  /** Huidige route (voor scherm-specifieke toetsen). */
  path?: string;
  now?: number;
}

const CHORD_MS = 1200;

export function decide(state: KeyState, k: KeyInput): { action: KeyAction; state: KeyState } {
  const now = k.now ?? Date.now();
  const none = { action: { type: 'none' } as KeyAction, state: { gAt: null } };
  if ((k.meta || k.ctrl) && k.key.toLowerCase() === 'k') return { action: { type: 'palette' }, state: { gAt: null } };
  if (k.key === 'Escape') return { action: { type: 'escape' }, state: { gAt: null } };
  if (k.typing || k.meta || k.ctrl || k.alt) return { action: { type: 'none' }, state };
  if (state.gAt !== null && now - state.gAt <= CHORD_MS) {
    const to = GO_KEYS[k.key.toLowerCase()];
    return to ? { action: { type: 'go', to }, state: { gAt: null } } : none;
  }
  switch (k.key) {
    case 'g':
      return { action: { type: 'pending' }, state: { gAt: now } };
    case '?':
      return { action: { type: 'help' }, state: { gAt: null } };
    case '/':
      return { action: { type: 'palette' }, state: { gAt: null } };
    case 'j':
    case 'ArrowDown':
      return { action: { type: 'move', delta: 1 }, state: { gAt: null } };
    case 'k':
    case 'ArrowUp':
      return { action: { type: 'move', delta: -1 }, state: { gAt: null } };
    case 'Enter':
      return { action: { type: 'open' }, state: { gAt: null } };
    case 's':
      return ['/dagstart', '/planning', '/tracker', '/'].includes(k.path ?? '')
        ? { action: { type: 'plansessie' }, state: { gAt: null } }
        : none;
    default:
      return none;
  }
}

/** Toetsen die "toetsenbordmodus" aanzetten (hintbalk, focusrand); muisbeweging zet hem uit. */
export const KBD_MODE_KEYS = /^(j|k|ArrowUp|ArrowDown|[1-5]|x|e|w|b)$/;

export const isTyping = (el: Element | null) =>
  !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || !!(el as HTMLElement).isContentEditable);
