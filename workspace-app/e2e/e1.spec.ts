/**
 * Stuk E1 end-to-end tegen de echte app met nep-OIDC en nep-OAuth (packages/fake-oauth), nooit echte Google/Slack:
 *  - HZW-010: @homezero.nl mag, @gmail.com, ongeverifieerd en niet-uitgenodigd worden geweigerd (weigerpagina);
 *  - HZW-011: cookie-vlaggen, uitloggen op alle apparaten;
 *  - HZW-012: admin ziet het team en blokkeert; een collega ziet geen Team;
 *  - HZW-013: de wizard met nep-koppelingen, overslaan, later afmaken en hervatten;
 *  - HZW-014: koppelen, rechten bekijken, intrekken (token weg bij de bron, data weg) en opnieuw verbinden;
 *  - huisstijl: axe zonder ernstige fouten (licht en donker), geen horizontale scroll op 400 px, ⌘K en g i / g w.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { E1_BASE, E1_FAKE_URL } from './e1-env';

test.use({ baseURL: E1_BASE });

const PHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';

async function googleLogin(page: Page, account: RegExp) {
  await page.goto('/login');
  await page.getByRole('button', { name: /Inloggen met Google|Ander account kiezen/ }).click();
  await page.waitForURL(new RegExp(`^${E1_FAKE_URL}`));
  await expect(page.getByRole('heading', { name: 'Kies een account' })).toBeVisible();
  await page.getByRole('button', { name: account }).click();
  await page.waitForURL(new RegExp(`^${E1_BASE}`));
}

/** Toestemming geven (of weigeren) op het scherm van de nep-bron. */
async function consent(page: Page, decision: 'Toestaan' | 'Weigeren' = 'Toestaan') {
  await page.waitForURL(new RegExp(`^${E1_FAKE_URL}`));
  await expect(page.getByRole('heading', { name: /HomeZero Workspace wil toegang/ })).toBeVisible();
  await page.getByRole('button', { name: decision }).click();
  await page.waitForURL(new RegExp(`^${E1_BASE}`));
}

const card = (page: Page, provider: string) => page.locator(`.conn[data-provider="${provider}"]`);

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).analyze();
  return r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map(
      (v) =>
        `${v.id}: ${v.nodes
          .map((n) => n.target.join(' '))
          .slice(0, 3)
          .join(', ')}`,
    );
}

async function noHorizontalScroll(page: Page) {
  const w = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    document.getElementById('main')?.scrollWidth ?? 0,
  ]);
  expect(w[0]).toBeLessThanOrEqual(400);
  expect(w[1]).toBeLessThanOrEqual(400);
}

test.describe('HZW-010 inloggen met Google (nep-OIDC)', () => {
  test('@homezero.nl mag: sessiecookie HttpOnly en SameSite=Lax, daarna de app', async ({ page, context }) => {
    await googleLogin(page, /Lisanne de Vries/);
    await expect(page.locator('.sidebar')).toBeVisible();
    const c = (await context.cookies()).find((x) => x.name === 'hz_session')!;
    expect(c.httpOnly).toBe(true);
    expect(c.sameSite).toBe('Lax');
    const s = await page.evaluate(async () => (await fetch('/api/session')).json());
    expect(s.user).toMatchObject({ email: 'lisanne@homezero.nl', role: 'member' });
  });

  for (const [account, title] of [
    [/Robert Privé/, 'Dit account hoort niet bij HomeZero'],
    [/Nieuw Account/, 'Dit e-mailadres is niet geverifieerd'],
    [/Gast Zonder Uitnodiging/, 'Je staat nog niet op de teamlijst'],
    [/Mike \(verkeerde hd\)/, 'Dit account hoort niet bij HomeZero'],
  ] as const) {
    test(`geweigerd met een nette weigerpagina: ${title} (${account.source})`, async ({ page, context }) => {
      await googleLogin(page, account);
      await expect(page).toHaveURL(/\/login\?fout=/);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
      await expect(page.getByRole('alert')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Ander account kiezen' })).toBeVisible();
      expect((await context.cookies()).some((x) => x.name === 'hz_session')).toBe(false);
      expect(await page.evaluate(async () => (await fetch('/api/session')).status)).toBe(401);
    });
  }

  for (const scheme of ['light', 'dark'] as const) {
    test(`inlogscherm en weigerpagina: axe (${scheme}) en 400 px`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto('/login');
      await expect(page.locator('.login-card')).toBeVisible();
      expect(await axe(page)).toEqual([]);
      await page.goto('/login?fout=domein');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Dit account hoort niet bij HomeZero');
      expect(await axe(page)).toEqual([]);
      await page.setViewportSize({ width: 400, height: 860 });
      await noHorizontalScroll(page);
    });
  }
});

test.describe('HZW-013 onboarding-wizard met nep-koppelingen', () => {
  test('nieuwe collega: koppelen, overslaan, later afmaken, hervatten, agenda-lagen, weekritme, toetsenbord', async ({
    page,
  }) => {
    await googleLogin(page, /Collega 1/);
    // Eerste login: meteen de wizard.
    await expect(page).toHaveURL(/\/welkom/);
    await expect(page.locator('.ob-head h1')).toHaveText('Welkom, Collega');
    await page.locator('body').click({ position: { x: 5, y: 500 } });
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.ob-head h1')).toHaveText('Google');

    // Google Taken koppelen via de nep-autorisatieserver.
    await card(page, 'google_tasks').getByRole('button', { name: 'Verbinden' }).click();
    await consent(page);
    await expect(page).toHaveURL(/\/welkom\?stap=google$/);
    await expect(page.locator('.toast')).toContainText('Google Taken gekoppeld');
    await expect(card(page, 'google_tasks').locator('.chip.ok')).toHaveText('Gekoppeld');
    // Agenda koppelen; Gmail (optioneel) niet.
    await card(page, 'calendar').getByRole('button', { name: 'Verbinden' }).click();
    await consent(page);
    await expect(card(page, 'calendar').locator('.chip.ok')).toHaveText('Gekoppeld');
    await expect(card(page, 'gmail').locator('.chip')).toContainText(['optioneel', 'Niet gekoppeld']);
    await page.getByRole('button', { name: /^Verder/ }).click();
    await expect(page.locator('.ob-head h1')).toHaveText('Slack');

    // Slack overslaan met de toets o.
    await page.locator('body').click({ position: { x: 5, y: 500 } });
    await page.keyboard.press('o');
    await expect(page.locator('.ob-head h1')).toHaveText('Jira');
    await expect(page.locator('.ob-steps .tab', { hasText: 'Slack' })).toHaveClass(/skipped/);
    await expect(page.locator('.ob-steps .tab', { hasText: 'Google' })).toHaveClass(/done/);

    // Later afmaken: terug naar Dagstart, de zijbalk wijst de weg terug.
    await page.getByRole('button', { name: /Later afmaken/ }).click();
    await expect(page).toHaveURL(/\/dagstart$/);
    await expect(page.locator('.ob-nudge')).toContainText('Inrichten');
    await expect(page.locator('.ob-nudge .count')).toHaveText('3/8');
    // Hervatten na herladen: zelfde stap.
    await page.reload();
    await page.locator('.ob-nudge').click();
    await expect(page.locator('.ob-head h1')).toHaveText('Jira');

    // Jira koppelen en weigeren bij de bron: niets gekoppeld.
    await card(page, 'jira').getByRole('button', { name: 'Verbinden' }).click();
    await consent(page, 'Weigeren');
    await expect(page.locator('.toast')).toContainText('geen toestemming');
    await expect(card(page, 'jira').locator('.chip').last()).toHaveText('Niet gekoppeld');
    await page.getByRole('button', { name: 'Overslaan' }).click();

    // GitHub: koppelen en de Persoonlijk-repo controleren (bestaat niet: aansporing met opdracht voor Claude).
    await expect(page.locator('.ob-head h1')).toHaveText('GitHub');
    await card(page, 'github').getByRole('button', { name: 'Verbinden' }).click();
    await consent(page);
    await expect(card(page, 'github').locator('.chip.ok')).toHaveText('Gekoppeld');
    await page.getByLabel('Je Persoonlijk-repo (eigenaar/naam)').fill('HomeZeroTech/persoonlijk-collega1');
    await page.getByRole('button', { name: 'Controleren' }).click();
    await expect(page.locator('.nudge-repo h2')).toHaveText('Nog geen Persoonlijk-repo');
    await expect(page.locator('.prompt-box')).toContainText('HomeZeroTech/persoonlijk-collega1');
    await page.getByRole('button', { name: /^Verder/ }).click();

    // Agenda-lagen: kleur en "alleen in Agenda" per agenda, bewaard in de voorkeuren.
    await expect(page.locator('.ob-head h1')).toHaveText('Agenda-lagen');
    const fam = page.locator('.cp-row', { hasText: 'Familie' });
    await fam.getByLabel('Kleur van Familie').selectOption({ label: 'Druif' });
    await fam.getByRole('radio', { name: 'Alleen in Agenda' }).click();
    await expect(fam.getByRole('radio', { name: 'Alleen in Agenda' })).toHaveAttribute('aria-checked', 'true');
    const prefs = await page.evaluate(async () => (await fetch('/api/preferences')).json());
    expect(prefs.calendars['demo-familie@group.calendar.google.com']).toMatchObject({
      color: '#8e24aa',
      scope: 'agenda',
    });
    await page.getByRole('button', { name: /^Verder/ }).click();

    // Weekritme.
    await expect(page.locator('.ob-head h1')).toHaveText('Weekritme');
    await page.getByRole('radio', { name: 'di' }).click();
    await page.getByRole('radio', { name: '4' }).click();
    await page.getByRole('button', { name: /^Verder/ }).click();

    // Toetsenbord-tour: toetsen lichten op en doen hier niets.
    await expect(page.locator('.ob-head h1')).toHaveText('Toetsenbord');
    await page.locator('body').click({ position: { x: 5, y: 500 } });
    await page.keyboard.press('g');
    await page.keyboard.press('d');
    await page.keyboard.press('?');
    await expect(page).toHaveURL(/\/welkom/);
    await expect(page.locator('.sw-key.hit')).toHaveCount(2);
    await expect(page.locator('.sw-key.hit').first()).toContainText('Dagstart');
    await page.getByRole('button', { name: /^Klaar/ }).click();
    await expect(page).toHaveURL(/\/dagstart$/);
    await expect(page.locator('.ob-nudge')).toHaveCount(0);

    const ob = await page.evaluate(async () => (await fetch('/api/onboarding')).json());
    expect(ob).toMatchObject({
      status: 'done',
      steps: {
        welkom: 'done',
        google: 'done',
        slack: 'skipped',
        jira: 'skipped',
        github: 'done',
        agenda: 'done',
        weekritme: 'done',
        toetsenbord: 'done',
      },
      weekritme: { plansessieDag: 'di', weekdoelen: 4 },
      persRepo: 'HomeZeroTech/persoonlijk-collega1',
    });
  });

  test('alles overslaan en later via g w terugkomen', async ({ page }) => {
    await googleLogin(page, /Collega 2/);
    await expect(page).toHaveURL(/\/welkom/);
    for (let i = 0; i < 3; i++) await page.getByRole('button', { name: /^Overslaan/ }).click();
    await expect(page.locator('.ob-head h1')).toHaveText('Jira');
    await page.locator('body').click({ position: { x: 5, y: 500 } });
    await page.keyboard.press('l');
    await expect(page).toHaveURL(/\/dagstart$/);
    await page.keyboard.press('g');
    await page.keyboard.press('w');
    await expect(page).toHaveURL(/\/welkom/);
    await expect(page.locator('.ob-head h1')).toHaveText('Jira');
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`wizard: axe (${scheme}) op elke stap en 400 px zonder horizontale scroll`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await googleLogin(page, scheme === 'light' ? /Collega 3/ : /Collega 4/);
      for (const stap of ['welkom', 'google', 'github', 'agenda', 'weekritme', 'toetsenbord']) {
        await page.goto(`/welkom?stap=${stap}`);
        await expect(page.locator('.ob-page')).toBeVisible();
        expect(await axe(page), stap).toEqual([]);
      }
      await page.setViewportSize({ width: 400, height: 860 });
      for (const stap of ['welkom', 'google', 'weekritme']) {
        await page.goto(`/welkom?stap=${stap}`);
        await expect(page.locator('.ob-page')).toBeVisible();
        await noHorizontalScroll(page);
      }
    });
  }
});

async function fakeTokens(page: Page) {
  const r = await page.request.get(`${E1_FAKE_URL}/_state`);
  return (
    (await r.json()) as {
      tokens: Array<{ family: string; token: string; revoked: boolean; email: string; kind: string }>;
    }
  ).tokens;
}

test.describe('HZW-014 Instellingen → Koppelingen', () => {
  test('Slack koppelen, rechten bekijken, intrekken (token ingetrokken bij Slack) en opnieuw verbinden', async ({
    page,
  }) => {
    await googleLogin(page, /Robert Verveen/);
    await page.goto('/dagstart');
    await page.locator('body').click({ position: { x: 700, y: 5 } });
    await page.keyboard.press('g');
    await page.keyboard.press('i');
    await expect(page).toHaveURL(/\/instellingen$/);
    await expect(page.locator('.hz-head h1')).toHaveText('Koppelingen');

    const slack = card(page, 'slack');
    await slack.getByRole('button', { name: 'Verbinden' }).click();
    await consent(page);
    await expect(page).toHaveURL(/\/instellingen\/koppelingen$/);
    await expect(slack.locator('.chip.ok')).toHaveText('Gekoppeld');
    await expect(slack).toContainText('Account: HomeZero (test)');
    const issued = (await fakeTokens(page))
      .filter((t) => t.family === 'slack' && t.kind === 'access' && !t.revoked)
      .at(-1)!;
    // Het token staat nergens in de pagina of in antwoorden aan de browser.
    expect(await page.content()).not.toContain(issued.token);
    expect(await page.evaluate(async () => (await fetch('/api/connections/details')).text())).not.toContain(
      issued.token,
    );

    // Rechten bekijken met het toetsenbord: j naar de kaart, ↵ klapt de rechten open.
    await slack.getByRole('button', { name: 'Rechten bekijken' }).click();
    await expect(slack.locator('.conn-rights')).toContainText('Wat de app nooit doet');
    await expect(slack.locator('.scope-list')).toContainText('channels:write');

    // Intrekken met bevestiging.
    await slack.getByRole('button', { name: 'Intrekken' }).click();
    await slack.getByRole('button', { name: 'Ja, intrekken' }).click();
    await expect(page.locator('.toast')).toContainText('ingetrokken bij de bron');
    await expect(slack.locator('.chip').last()).toHaveText('Niet gekoppeld');
    expect((await fakeTokens(page)).find((t) => t.token === issued.token)!.revoked).toBe(true);
    const d = await page.evaluate(async () => (await fetch('/api/dagstart')).json());
    expect(d.items.some((i: { type: string }) => i.type === 'slack')).toBe(false);

    // Opnieuw verbinden.
    await slack.getByRole('button', { name: 'Verbinden' }).click();
    await consent(page);
    await expect(slack.locator('.chip.ok')).toHaveText('Gekoppeld');
    const d2 = await page.evaluate(async () => (await fetch('/api/dagstart')).json());
    expect(d2.items.some((i: { type: string }) => i.type === 'slack')).toBe(true);
  });

  test('toetsen: j/k over de bronnen, ↵ rechten, ⇧2 Apparaten; ⌘K-commando Koppelingen', async ({ page }) => {
    await googleLogin(page, /Robert Verveen/);
    await page.goto('/instellingen/koppelingen');
    await expect(page.locator('.conn')).toHaveCount(7);
    await page.locator('body').click({ position: { x: 700, y: 5 } });
    await page.keyboard.press('j');
    await expect(page.locator('.conn.kf')).toHaveAttribute('data-provider', 'google_tasks');
    await page.keyboard.press('j');
    await expect(page.locator('.conn.kf')).toHaveAttribute('data-provider', 'calendar');
    await page.keyboard.press('Enter');
    await expect(card(page, 'calendar').locator('.conn-rights')).toBeVisible();
    await expect(page.locator('#inspector')).toBeHidden();
    await page.keyboard.press('Shift+Digit2');
    await expect(page).toHaveURL(/\/instellingen\/apparaten$/);
    await page.keyboard.press('ControlOrMeta+k');
    await page.locator('#pal-q').fill('>koppel');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/instellingen\/koppelingen$/);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`instellingen: axe (${scheme}) en 400 px`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await googleLogin(page, /Robert Verveen/);
      for (const tab of ['koppelingen', 'apparaten', 'team']) {
        await page.goto(`/instellingen/${tab}`);
        await expect(page.locator('.set-page')).toBeVisible();
        if (tab === 'koppelingen') await card(page, 'gmail').getByRole('button', { name: 'Rechten bekijken' }).click();
        expect(await axe(page), tab).toEqual([]);
      }
      await page.setViewportSize({ width: 400, height: 860 });
      for (const tab of ['koppelingen', 'apparaten', 'team']) {
        await page.goto(`/instellingen/${tab}`);
        await expect(page.locator('.set-page')).toBeVisible();
        await noHorizontalScroll(page);
      }
    });
  }
});

async function loggedIn(browser: Browser, account: RegExp, userAgent?: string) {
  const ctx = await browser.newContext({ baseURL: E1_BASE, ...(userAgent ? { userAgent } : {}) });
  const page = await ctx.newPage();
  await googleLogin(page, account);
  return { ctx, page };
}

test.describe('HZW-011 en HZW-012 apparaten en team', () => {
  test('uitloggen op alle apparaten: laptop en telefoon allebei uitgelogd', async ({ browser }) => {
    const laptop = await loggedIn(browser, /Robert Verveen/);
    const phone = await loggedIn(browser, /Robert Verveen/, PHONE_UA);
    await laptop.page.goto('/instellingen/apparaten');
    await expect(laptop.page.locator('.set-row', { hasText: 'Safari op iOS' })).toBeVisible();
    await expect(laptop.page.locator('.set-row', { hasText: 'dit apparaat' })).toHaveCount(1);
    await laptop.page.getByRole('button', { name: 'Overal uitloggen' }).click();
    await laptop.page.getByRole('button', { name: 'Ja, overal uitloggen' }).click();
    await expect(laptop.page).toHaveURL(/\/login\?uit=1$/);
    await expect(laptop.page.getByRole('status')).toHaveText('Je bent uitgelogd.');
    await phone.page.goto('/dagstart');
    await expect(phone.page.locator('.login-card')).toBeVisible();
    await laptop.ctx.close();
    await phone.ctx.close();
  });

  test('admin ziet het team en blokkeert een collega (direct uitgelogd, inloggen geweigerd); collega ziet geen Team', async ({
    browser,
  }) => {
    const lisanne = await loggedIn(browser, /Lisanne de Vries/);
    await lisanne.page.goto('/instellingen');
    await expect(lisanne.page.getByRole('tab')).toHaveText([/^Koppelingen/, /^Apparaten/]);
    expect(await lisanne.page.evaluate(async () => (await fetch('/api/admin/members')).status)).toBe(403);

    const robert = await loggedIn(browser, /Robert Verveen/);
    await robert.page.goto('/instellingen/team');
    const row = robert.page.locator('.set-row', { hasText: 'lisanne@homezero.nl' });
    await expect(row).toBeVisible();
    await expect(robert.page.locator('.set-row', { hasText: 'robert@homezero.nl' })).toContainText('beheerder');
    await row.getByRole('button', { name: 'Blokkeren' }).click();
    await expect(row).toContainText('geblokkeerd');
    await lisanne.page.goto('/dagstart');
    await expect(lisanne.page.locator('.login-card')).toBeVisible();
    await googleLogin(lisanne.page, /Lisanne de Vries/);
    await expect(lisanne.page.getByRole('heading', { level: 1 })).toHaveText('Je toegang is geblokkeerd');
    await row.getByRole('button', { name: 'Toegang terug' }).click();
    await expect(row).not.toContainText('geblokkeerd');
    await lisanne.ctx.close();
    await robert.ctx.close();
  });
});
