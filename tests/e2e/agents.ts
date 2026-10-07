import { expect, type Page } from '@playwright/test';

/**
 * Open the focused conversation's agents (⌘E) once the demo's runs are loaded. The app always opens on the
 * board, and ⌘E does nothing until the focused conversation has a plan, so it is pressed until the map shows.
 */
export async function openAgents(window: Page): Promise<void> {
  const map = window.getByTestId('route-map');
  await expect(async () => {
    if (!(await map.isVisible())) await window.keyboard.press('Meta+e');
    await expect(map).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
}
