/**
 * The OS this window runs on, and what the UI says or lays out differently per OS. Keyboard differences live in
 * keys.ts (it takes `IS_MAC`); everything else that varies by OS reads this module rather than `navigator`.
 */
import { type Os, osOf, type TitleBarSpec, titleBarFor } from '@shared/platform';

function detectOs(): Os {
  // The preload's `process.platform` is authoritative; demo mode in a plain browser (and unit tests) has none.
  const bridged = typeof window === 'undefined' ? undefined : window.legion?.platform.platform;
  if (bridged) return osOf(bridged);
  const hint = typeof navigator === 'undefined' ? 'Mac' : (navigator.platform ?? '');
  if (/Mac|iPhone|iPad/.test(hint)) return 'mac';
  if (/Win/.test(hint)) return 'windows';
  return 'linux';
}

export const OS: Os = detectOs();
export const IS_MAC = OS === 'mac';

/** How main drew the window's title bar; the title bar component keeps clear of the native controls. */
export const TITLE_BAR: TitleBarSpec = titleBarFor(OS);

/** The system file manager, as UI copy names it ("Reveal in Finder"). */
export const FILE_MANAGER: string = { mac: 'Finder', linux: 'the file manager', windows: 'File Explorer' }[OS];

/**
 * Keep the native window controls (Linux, Windows) the colour of the title bar they sit on: report the theme's
 * `--mantle` / `--text` to main now and after every change of `<html>`'s theme attributes. Returns a disposer.
 */
export function syncWindowControls(root: HTMLElement = document.documentElement): () => void {
  if (TITLE_BAR.style !== 'overlay' || typeof window.legion?.setTitleBarColors !== 'function') return () => {};
  let last = '';
  const report = (): void => {
    const style = getComputedStyle(root);
    const colors = {
      background: style.getPropertyValue('--mantle').trim(),
      symbols: style.getPropertyValue('--text').trim(),
    };
    const key = `${colors.background} ${colors.symbols}`;
    if (key === last || !colors.background || !colors.symbols) return;
    last = key;
    window.legion.setTitleBarColors(colors);
  };
  report();
  const observer = new MutationObserver(report);
  observer.observe(root, { attributes: true, attributeFilter: ['data-flavour', 'style', 'class'] });
  return () => observer.disconnect();
}
