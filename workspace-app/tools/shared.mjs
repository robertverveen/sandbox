/** Gedeeld door tools/bar en tools/shot: schermen, viewports, thema's en argumenten. */
export const SCREENS = ['dagstart', 'planning', 'sprint', 'agenda', 'tracker', 'chat', 'entity', 'palette', 'help'];
export const VIEWPORTS = { desktop: { width: 1440, height: 1000 }, mobile: { width: 400, height: 860 } };
export const THEMES = ['light', 'dark'];

export function parseArgs(argv, defaults = {}) {
  const get = (name, d) => {
    const i = argv.indexOf('--' + name);
    const v = i >= 0 ? argv[i + 1] : d;
    return String(v)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  };
  return {
    modes: get('modes', defaults.modes ?? 'demo'),
    screens: get('screens', defaults.screens ?? SCREENS.join(',')),
    viewports: get('viewports', defaults.viewports ?? Object.keys(VIEWPORTS).join(',')),
    themes: get('themes', defaults.themes ?? THEMES.join(',')),
  };
}

/**
 * Screenshot van het hele werkvlak: het werkvlak (#main) scrolt zelf, dus fullPage helpt niet.
 * Op desktop wordt de viewport tijdelijk zo hoog als de inhoud (max. 4000 px); mobiel blijft schermvullend.
 */
export async function shoot(page, file, vp, overlay = false) {
  const base = VIEWPORTS[vp];
  if (vp === 'desktop' && !overlay) {
    const h = await page.evaluate(() => Math.max(document.getElementById('main')?.scrollHeight ?? 0, 0));
    if (h > base.height) await page.setViewportSize({ width: base.width, height: Math.min(h, 4000) });
    await page.waitForTimeout(150);
  }
  await page.screenshot({ path: file });
  await page.setViewportSize(base);
}
