/**
 * Is the renderer in demo mode (fixture data, no engine)? Kept apart from the demo client so the normal app can
 * decide without loading the fixture world (and everything it pulls in): main.tsx imports `./demo/client`
 * dynamically, only when this says so.
 */

/** Demo mode: `?demo=1` (or `#demo`), `localStorage['legion.demo'] = '1'`, or `LEGION_DEMO=1` via the bridge. */
export function isDemoMode(): boolean {
  try {
    const params = new URLSearchParams(location.search);
    if (params.get('demo') === '1' || location.hash.includes('demo')) return true;
  } catch {
    // ignore
  }
  try {
    const bridge = (window as unknown as { legion?: { env?: Record<string, string | undefined> } }).legion;
    if (bridge?.env?.LEGION_DEMO === '1') return true;
  } catch {
    // ignore
  }
  try {
    return localStorage.getItem('legion.demo') === '1';
  } catch {
    return false;
  }
}

/** `?live=0` freezes the demo agents (stable screenshots). */
export function demoLive(): boolean {
  try {
    return new URLSearchParams(location.search).get('live') !== '0' && localStorage.getItem('legion.demo.live') !== '0';
  } catch {
    return true;
  }
}
