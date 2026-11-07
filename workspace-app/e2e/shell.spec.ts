/**
 * E2E voor de schil en Dagstart (HZW-040, HZW-041) op de demodata van het prototype.
 * Zelftests uit stories.json: screenshots licht/donker en desktop/mobiel (tools/shot), axe zonder ernstige fouten,
 * E2E met testdata, geen horizontale scroll op 400 px.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function openDagstart(page: Page) {
  await page.goto('/dagstart');
  await expect(page.locator('.calm-grid')).toBeVisible();
}

test.describe('Dagstart met fixture-data', () => {
  test('toont de dag zoals het prototype: begroeting, samenvatting, vandaag, agenda, contextlaag', async ({ page }) => {
    await openDagstart(page);
    await expect(page.locator('.calm-head .eyebrow')).toHaveText('Vrijdag 30 oktober');
    await expect(page.locator('.calm-head h1')).toHaveText(/Robert$/);
    await expect(page.locator('.calm-sum')).toContainText('10 om te beslissen');
    await expect(page.locator('.calm-sum')).toContainText('3/10 gepland voor vandaag');
    await expect(page.locator('.calm-sum')).toContainText('volgende: Feenstra · maandelijkse check-in 10:00');
    await expect(page.locator('section[aria-labelledby="ds-today"] > .list > .row')).toHaveCount(3);
    await expect(page.locator('.mini-agenda .ma-row')).toHaveText([
      /10:00.*Feenstra/,
      /13:00.*Sprint review Pico/,
      /15:00.*TonZon/,
    ]);
    await expect(page.locator('.mini-agenda .ma-row').first()).toContainText('geen prep gepland');
    await expect(page.locator('.ctx-day')).toContainText('Rekenvoorbeeld thuisbatterij naar Feenstra sturen');
    await expect(page.locator('.calm-foot')).toContainText('Sprint 73 · nog 6 dagen · 5/25 pt');
    await expect(page.locator('.calm-foot')).toContainText('2 voor jou om te testen');
    await expect(page.locator('.briefing-line summary')).toContainText('Briefing vr 30 okt');
  });

  test('om te beslissen: tien items met soort en reden, openklappen wordt onthouden', async ({ page }) => {
    await openDagstart(page);
    await page.getByText('Om te beslissen (10)').click();
    const rows = page.locator('details.calm-more .row');
    await expect(rows).toHaveCount(10);
    await expect(rows.first()).toContainText('Te laat');
    await expect(rows.first()).toContainText('deadline was 29 okt');
    await page.reload();
    await expect(page.locator('details.calm-more')).toHaveAttribute('open', '');
  });

  test('zijbalk met tellers en de vijf onderdelen', async ({ page }) => {
    await openDagstart(page);
    const nav = page.locator('.sidebar .nav-item');
    await expect(nav).toHaveText([/Dagstart\s*10/, /Planning\s*3\/10/, /Agenda/, /Tracker\s*2/, /Chat/]);
    await expect(page.locator('.sidebar .nav-item.active')).toContainText('Dagstart');
  });

  test('live update via SSE: gelezen zetten via de API werkt de teller bij zonder herladen', async ({ page }) => {
    await openDagstart(page);
    await expect(page.locator('.calm-sum')).toContainText('10 om te beslissen');
    const ok = await page.evaluate(async () => {
      const r = await fetch('/api/itemstate/s11', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ read: true }),
      });
      return r.ok;
    });
    expect(ok).toBe(true);
    await expect(page.locator('.calm-sum')).toContainText('9 om te beslissen');
    await page.evaluate(() =>
      fetch('/api/itemstate/s11', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ read: false }),
      }),
    );
    await expect(page.locator('.calm-sum')).toContainText('10 om te beslissen');
  });
});

test.describe('Toetsenbordmodel', () => {
  test('g d/p/a/t/c navigeren', async ({ page }) => {
    await openDagstart(page);
    for (const [k, path, h] of [
      ['p', '/planning', 'Planning'],
      ['a', '/agenda', 'Agenda'],
      ['t', '/tracker', 'Tracker'],
      ['c', '/chat', 'Gesprekken'],
      ['d', '/dagstart', 'Robert'],
    ] as const) {
      await page.keyboard.press('g');
      await page.keyboard.press(k);
      await expect(page).toHaveURL(new RegExp(path + '$'));
      await expect(page.locator('h1').first()).toContainText(h);
    }
  });

  test('⌘K-palet: organisatie-chip met komma-hint, groepen zoals de lat, vastzetten; Enter opent de partnerpagina', async ({
    page,
  }) => {
    await openDagstart(page);
    await page.keyboard.press('ControlOrMeta+k');
    const input = page.locator('#pal-q');
    await expect(input).toBeFocused();
    await input.fill('feen');
    await expect(page.locator('.pal-chips .sq-chip.org')).toHaveText('Feenstra');
    await expect(page.locator('.pal-chips .pal-tip')).toContainText('Typ een komma om te verfijnen');
    const labels = page.locator('.pal-results .group-label');
    for (const g of ['Gesprekken', 'Zoeken', 'Organisatie', 'Tracker', 'Contextlaag', 'Agenda', 'Mail', 'Slack'])
      await expect(labels.filter({ hasText: g }).first(), g).toBeVisible();
    await expect(page.locator('.pal-results')).toContainText('#feenstra-hz');
    await expect(page.locator('.pal-results')).toContainText('partners/feenstra/brief.md');
    await expect(page.locator('.pal-entity')).toContainText(/1 mail · 1 slack/);
    // Verfijnen met een komma: onderwerp-chip, de organisatie blijft.
    await input.fill('feenstra, rekenvoorbeeld');
    await expect(page.locator('.pal-chips .sq-chip.kw')).toHaveText('rekenvoorbeeld');
    await expect(page.locator('.pal-results')).toContainText('Rekenvoorbeeld thuisbatterij');
    // ⌘↵ zet de zoekopdracht vast (POST /api/pins).
    const saved = page.waitForResponse((r) => r.url().endsWith('/api/pins') && r.request().method() === 'POST');
    await page.keyboard.press('ControlOrMeta+Enter');
    expect((await saved).status()).toBe(200);
    await expect(page.locator('.palette')).toHaveCount(0);
    const pins = await page.request.get('/api/pins');
    expect(((await pins.json()) as { pins: Array<{ q: string }> }).pins.map((p) => p.q)).toContain(
      'feenstra, rekenvoorbeeld',
    );
    await page.keyboard.press('ControlOrMeta+k');
    await page.locator('#pal-q').fill('feen');
    await page.locator('.pal-entity').click();
    await expect(page).toHaveURL(/\/o\/feenstra$/);
    await page.keyboard.press('/');
    await page.locator('#pal-q').fill('>donker');
    await expect(page.locator('.pal-item')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('.palette')).toHaveCount(0);
  });

  test('? toont de hulp en Esc sluit hem', async ({ page }) => {
    await openDagstart(page);
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog', { name: 'Sneltoetsen' })).toBeVisible();
    await expect(page.locator('.help-grid')).toContainText('Dagstart');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Sneltoetsen' })).toHaveCount(0);
  });

  test('j/k bewegen de focus met hintbalk, Enter opent de inspector, Esc sluit', async ({ page }) => {
    await openDagstart(page);
    await page.locator('body').click({ position: { x: 700, y: 5 } });
    await page.keyboard.press('j');
    await expect(page.locator('#main .kf')).toHaveCount(1);
    await expect(page.locator('body')).toHaveClass(/kbd-mode/);
    await expect(page.locator('.hintbar')).toBeVisible();
    await page.keyboard.press('j');
    await expect(page.locator('#main .kf')).toContainText('Release notes sprint 64');
    await page.keyboard.press('k');
    await expect(page.locator('#main .kf')).toContainText('Prep: TonZon');
    await page.keyboard.press('Enter');
    await expect(page.locator('#inspector')).toBeVisible();
    await expect(page.locator('#inspector .insp-title')).toContainText('Prep: TonZon');
    await page.keyboard.press('Escape');
    await expect(page.locator('#inspector')).toBeHidden();
  });

  test('licht/donker wisselt en wordt onthouden', async ({ page }) => {
    await openDagstart(page);
    const before = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.getByRole('button', { name: 'Wissel licht en donker' }).click();
    const theme = await page.evaluate(() => document.documentElement.dataset.theme);
    expect(['light', 'dark']).toContain(theme);
    const after = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(after).not.toBe(before);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme!);
  });
});

test.describe('Mobiel en toegankelijkheid', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`axe: geen ernstige of kritieke fouten op Dagstart (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openDagstart(page);
      const r = await new AxeBuilder({ page }).analyze();
      const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      expect(
        bad.map(
          (v) =>
            `${v.id}: ${v.nodes
              .map((n) => n.target.join(' '))
              .slice(0, 3)
              .join(', ')}`,
        ),
      ).toEqual([]);
    });
  }

  for (const path of ['/dagstart', '/planning', '/agenda', '/tracker', '/chat']) {
    test(`geen horizontale scroll op 400 px: ${path}`, async ({ page }) => {
      await page.setViewportSize({ width: 400, height: 860 });
      await page.goto(path);
      await expect(page.locator('.page')).toBeVisible();
      const w = await page.evaluate(() => [
        document.documentElement.scrollWidth,
        document.getElementById('main')!.scrollWidth,
      ]);
      expect(w[0]).toBeLessThanOrEqual(400);
      expect(w[1]).toBeLessThanOrEqual(400);
    });
  }

  test('mobiel: menu opent de zijbalk', async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 860 });
    await openDagstart(page);
    await page.getByRole('button', { name: 'Menu' }).click();
    await expect(page.locator('#app')).toHaveClass(/nav-open/);
    await page.locator('.sidebar .nav-item', { hasText: 'Tracker' }).click();
    await expect(page).toHaveURL(/\/tracker$/);
    await expect(page.locator('#app')).not.toHaveClass(/nav-open/);
  });
});
