/** Kleine gedeelde UI-staat: palet, hulp, inspector, toast, focus. Bewust zonder extra bibliotheek. */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

export interface UiState {
  palette: boolean;
  help: boolean;
  selected: string | null;
  navOpen: boolean;
  toastMsg: string | null;
}

interface UiApi extends UiState {
  setPalette(v: boolean): void;
  setHelp(v: boolean): void;
  select(id: string | null): void;
  setNavOpen(v: boolean): void;
  toast(msg: string): void;
}

const Ctx = createContext<UiApi | null>(null);

export function UiProvider({ children }: { children: ReactNode }) {
  const [s, set] = useState<UiState>({ palette: false, help: false, selected: null, navOpen: false, toastMsg: null });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toast = useCallback((msg: string) => {
    set((x) => ({ ...x, toastMsg: msg }));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => set((x) => ({ ...x, toastMsg: null })), 3600);
  }, []);
  const api = useMemo<UiApi>(
    () => ({
      ...s,
      setPalette: (v) => set((x) => ({ ...x, palette: v, help: v ? false : x.help })),
      setHelp: (v) => set((x) => ({ ...x, help: v })),
      select: (id) => set((x) => ({ ...x, selected: id })),
      setNavOpen: (v) => set((x) => ({ ...x, navOpen: v })),
      toast,
    }),
    [s, toast],
  );
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useUi(): UiApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useUi buiten UiProvider');
  return v;
}

/* ---------- Thema ---------- */
export type Theme = 'light' | 'dark';

export function currentTheme(): Theme {
  const t = document.documentElement.dataset.theme;
  if (t === 'light' || t === 'dark') return t;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('hz:theme', next);
  } catch {
    /* privévenster: dan alleen voor deze sessie */
  }
  return next;
}

/* ---------- Kleine opslag per kijker (alleen gemak, nooit belangrijke data) ---------- */
export const local = {
  get<T>(k: string, d: T): T {
    try {
      const v = localStorage.getItem('hz:' + k);
      return v ? (JSON.parse(v) as T) : d;
    } catch {
      return d;
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem('hz:' + k, JSON.stringify(v));
    } catch {
      /* negeren */
    }
  },
};
