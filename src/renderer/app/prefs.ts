/**
 * Renderer-only preferences (not engine settings): Catppuccin flavour, a reduced-motion override, whether the rail
 * lists archived runs and whether the code editor uses vim keys. Persisted in localStorage per device; applied to <html> as
 * `data-flavour` / `data-motion` so CSS (theme tokens, the global reduced-motion rules) follows them.
 */
import { useReducedMotion } from 'motion/react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

export type Flavour = 'mocha' | 'latte';
/** system = follow macOS "Reduce motion"; reduce / full override it. */
export type MotionPref = 'system' | 'reduce' | 'full';

export interface Prefs {
  flavour: Flavour;
  motion: MotionPref;
  showArchived: boolean;
  /** The code editor's keys: vim (normal/insert modes) instead of the standard ones. */
  editorVim: boolean;
}

const KEY = 'legion.prefs';
const DEFAULTS: Prefs = { flavour: 'mocha', motion: 'system', showArchived: false, editorVim: false };

function load(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>;
    return {
      flavour: raw.flavour === 'latte' ? 'latte' : 'mocha',
      motion: raw.motion === 'reduce' || raw.motion === 'full' ? raw.motion : 'system',
      showArchived: raw.showArchived === true,
      editorVim: raw.editorVim === true,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export const prefsStore = createStore<Prefs>(() => load());

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  prefsStore.setState({ [key]: value } as Pick<Prefs, K>);
  try {
    localStorage.setItem(KEY, JSON.stringify(prefsStore.getState()));
  } catch {
    // best effort
  }
}

export function usePrefs<T>(selector: (prefs: Prefs) => T): T {
  return useStore(prefsStore, selector);
}

/** Mirror the preferences on <html> now and whenever they change. */
export function applyAppearance(root: HTMLElement = document.documentElement): () => void {
  const apply = ({ flavour, motion }: Prefs) => {
    root.dataset.flavour = flavour;
    root.dataset.motion = motion;
    root.style.colorScheme = flavour === 'latte' ? 'light' : 'dark';
  };
  apply(prefsStore.getState());
  return prefsStore.subscribe(apply);
}

/** `MotionConfig.reducedMotion` for the current preference. */
export function useMotionConfig(): 'user' | 'always' | 'never' {
  const motion = usePrefs((p) => p.motion);
  return motion === 'reduce' ? 'always' : motion === 'full' ? 'never' : 'user';
}

/**
 * Should animations be reduced? The preference wins over the OS setting. Use this instead of Motion's
 * `useReducedMotion`, which only knows the OS.
 */
export function useReducedMotionPref(): boolean {
  const os = useReducedMotion() ?? false;
  const motion = usePrefs((p) => p.motion);
  return motion === 'reduce' ? true : motion === 'full' ? false : os;
}

/** Non-hook variant (event handlers, imperative scrolling). */
export function prefersReducedMotion(): boolean {
  const motion = prefsStore.getState().motion;
  if (motion !== 'system') return motion === 'reduce';
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
