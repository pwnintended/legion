import { expect, type Page } from '@playwright/test';

/**
 * Open the focused conversation's agents (⌘E) once the demo's runs are loaded. The app always opens on the
 * board, and ⌘E does nothing until the focused conversation has a plan, so it is pressed until the map shows.
 */
export async function openAgents(window: Page): Promise<void> {
  const map = window.getByTestId('route-map');
  await expect(async () => {
    if (!(await map.isVisible())) await window.keyboard.press('ControlOrMeta+e');
    await expect(map).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
}

/** Open the run composer (base branch, planner, clarifying questions) from the palette: ⌘⇧N is a direct session. */
export async function openRunComposer(window: Page): Promise<void> {
  await window.keyboard.press('ControlOrMeta+k');
  await expect(window.getByTestId('palette')).toBeVisible();
  await window.keyboard.type('New run with a plan');
  await window.keyboard.press('Enter');
  await expect(window.getByTestId('composer')).toBeVisible();
  await expect.poll(() => window.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');
}
