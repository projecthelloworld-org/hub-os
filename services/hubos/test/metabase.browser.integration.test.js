import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const base = process.env.HUBOS_TEST_METABASE_BROWSER_URL;
const suite = base ? describe : describe.skip;
const output = resolve(import.meta.dir, '../../../output/playwright');
const layouts = [
  { name: 'Fixture customised community overview', key: 'operations', cards: [
    ['Community site evidence', 'table'], ['Connectivity evidence by country', 'chart'], ['Open support queue — opened in selected period', 'table'],
  ] },
  { name: 'Availability & Connectivity', key: 'availability', cards: [
    ['Observed uptime and coverage — UTC days', 'chart'], ['Monitoring infrastructure — current reachability', 'table'],
    ['Community targets — observed uptime and coverage', 'table'], ['Community target response time — UTC days', 'chart'], ['Network controller aggregates', 'empty'],
  ] },
  { name: 'Devices & Field Evidence', key: 'devices', cards: [
    ['Managed-device inventory and check-ins', 'table'], ['Recent device check-ins — evidence over time', 'chart'], ['Operational inspections — latest approved evidence', 'table'],
  ] },
  { name: 'Collection & Support', key: 'collection', cards: [
    ['Collection freshness and source coverage', 'table'], ['Incident history', 'table'], ['Notification delivery queue', 'table'], ['Additional plugin telemetry', 'table'],
  ] },
];

suite('Provisioned community dashboards in a browser (owned synthetic package)', () => {
  let browser, context, dashboardLinks;
  const openDashboard = async (page, name) => {
    const dashboard = dashboardLinks.find((link) => link.name.includes(name));
    expect(dashboard).toBeDefined();
    const url = new URL(dashboard.href, base);
    // Metabase remembers each user's last filter values across browser sessions.
    // Explicit URL values make every fixture scenario independent of that history.
    url.searchParams.set('site', ''); url.searchParams.set('country', ''); url.searchParams.set('date', 'past30days~');
    await page.goto(url.href);
    await page.getByRole('button', { name: 'Reporting date (UTC)', exact: true }).waitFor();
    for (const name of ['Community site', 'Country']) {
      const clear = page.getByRole('button', { name, exact: true }).getByRole('button', { name: 'Clear', exact: true });
      if (await clear.count()) await clear.click();
    }
  };
  beforeAll(async () => {
    if (base !== 'http://127.0.0.1:19381/') throw new Error('Only the owned synthetic package fixture may be used');
    const deadline = performance.now() + 180000;
    let healthy = false;
    while (performance.now() < deadline) {
      try {
        const response = await fetch(new URL('/api/health', base), { signal: AbortSignal.timeout(5000) });
        healthy = response.ok && (await response.json()).status === 'ok';
        if (healthy) break;
      } catch { /* Only the owned application is allowed time to finish startup. */ }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!healthy) throw new Error('Owned Metabase application did not become healthy');
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await mkdir(output, { recursive: true });
    const page = await context.newPage();
    try {
      await page.goto(base);
      await page.getByRole('textbox', { name: 'Email address', exact: true }).fill('demo-package-fixture@local.test');
      await page.getByLabel('Password', { exact: true }).fill('Fixture-Demo-Metabase-2026!');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.waitForURL((url) => !url.pathname.startsWith('/auth'));
      await page.getByRole('link', { name: /HubOS Operations/ }).click();
      await page.waitForURL(/\/collection\//);
      await page.getByText('Fixture customised community overview', { exact: true }).waitFor();
      dashboardLinks = await page.getByRole('link').evaluateAll((links) => links
        .filter((link) => link.getAttribute('href')?.startsWith('/dashboard/'))
        .map((link) => ({ name: link.textContent.replace(/\s+/g, ' ').trim(), href: link.getAttribute('href') })));
    } finally { await page.close(); }
  }, 240000);
  afterAll(async () => { await context?.close(); await browser?.close(); });

  test('community dashboard exposes connected site, country and reporting-date controls', async () => {
    const page = await context.newPage();
    try {
      await openDashboard(page, 'Fixture customised community overview');
      await page.getByRole('link', { name: 'Community site evidence', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Reporting date (UTC)', exact: true }).waitFor();
      for (const name of ['Community site', 'Country', 'Reporting date (UTC)']) {
        expect(await page.getByRole('button', { name, exact: true }).count()).toBe(1);
      }
    } finally { await page.close(); }
  }, 60000);

  test('keyboard country selection and community-site selection filter rendered evidence', async () => {
    const page = await context.newPage();
    try {
      await openDashboard(page, 'Fixture customised community overview');
      const evidence = page.getByTestId('dashcard').filter({ has: page.getByRole('link', { name: 'Community site evidence', exact: true }) });
      await evidence.getByText('10 rows', { exact: true }).waitFor();
      const country = page.getByRole('button', { name: 'Country', exact: true });
      await country.focus(); await page.keyboard.press('Enter');
      const selection = page.getByRole('dialog', { name: 'Country', exact: true });
      await selection.getByRole('checkbox', { name: 'UG', exact: true }).focus();
      await page.keyboard.press('Space');
      await selection.getByRole('button', { name: 'Add filter', exact: true }).click();
      await evidence.getByText('5 rows', { exact: true }).waitFor();
      expect(await evidence.getByRole('gridcell', { name: 'UG', exact: true }).count()).toBe(5);
      expect(await evidence.getByRole('gridcell', { name: 'AO', exact: true }).count()).toBe(0);
      await page.getByRole('button', { name: 'Community site', exact: true }).click();
      const sites = page.getByRole('dialog', { name: 'Community site', exact: true });
      await sites.getByRole('checkbox', { name: 'UG-DEMO-03', exact: true }).check();
      await sites.getByRole('button', { name: 'Add filter', exact: true }).click();
      await evidence.getByText('1 row', { exact: true }).waitFor();
      expect(await evidence.getByRole('gridcell', { name: 'UG-DEMO-03', exact: true }).count()).toBe(1);
      expect(await evidence.getByRole('gridcell', { name: 'Uganda Demo Library 03', exact: true }).count()).toBe(1);
    } finally { await page.close(); }
  }, 60000);

  test('date controls show no current evidence for a past period instead of inventing healthy sites', async () => {
    const page = await context.newPage();
    try {
      await openDashboard(page, 'Fixture customised community overview');
      const evidence = page.getByTestId('dashcard').filter({ has: page.getByRole('link', { name: 'Community site evidence', exact: true }) });
      await evidence.getByText('10 rows', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Reporting date (UTC)', exact: true }).click();
      const dates = page.getByRole('dialog', { name: 'Reporting date (UTC)', exact: true });
      await dates.getByRole('button', { name: 'Back', exact: true }).click();
      await dates.getByRole('button', { name: 'Previous month', exact: true }).click();
      await evidence.getByRole('img', { name: 'No results', exact: true }).waitFor();
      expect(await evidence.getByRole('gridcell').count()).toBe(0);
      expect(await evidence.innerText()).not.toContain('healthy');
      await page.getByRole('button', { name: 'Reporting date (UTC)', exact: true }).click();
      await dates.getByRole('button', { name: 'Back', exact: true }).click();
      await dates.getByRole('button', { name: 'Today', exact: true }).click();
      await evidence.getByText('10 rows', { exact: true }).waitFor();
      expect(await evidence.getByRole('gridcell', { name: 'AO-DEMO-05', exact: true }).count()).toBe(1);
    } finally { await page.close(); }
  }, 60000);

  for (const layout of layouts) {
    test(`${layout.name} renders complete desktop and narrow layouts without query errors`, async () => {
      const page = await context.newPage();
      try {
        await openDashboard(page, layout.name);
        expect(await page.getByTestId('dashcard').count()).toBe(layout.cards.length);
        for (const [title, display] of layout.cards) {
          const card = page.getByTestId('dashcard').filter({ has: page.getByRole('link', { name: title, exact: true }) });
          await card.scrollIntoViewIfNeeded();
          if (display === 'table') await card.getByRole('gridcell').first().waitFor();
          else if (display === 'empty') await card.getByRole('img', { name: 'No results', exact: true }).waitFor();
          else await card.getByRole('img', { name: '', exact: true }).waitFor();
          expect(await card.innerText()).not.toMatch(/problem displaying|error occurred|couldn't load|failed to fetch|choose a column|select a field/i);
        }
        if (layout.key === 'availability') {
          const coverage = page.getByTestId('dashcard').filter({ has: page.getByRole('link', { name: 'Community targets — observed uptime and coverage', exact: true }) });
          expect(await coverage.getByRole('columnheader', { name: 'Observed uptime (%)', exact: true }).count()).toBe(1);
          expect(await coverage.getByRole('columnheader', { name: 'Observation coverage (%)', exact: true }).count()).toBe(1);
          expect(await coverage.getByRole('gridcell', { name: /\[DEMO\]/ }).count()).toBeGreaterThan(0);
        }
        for (const [device, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
          await page.setViewportSize(viewport);
          await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth, undefined, { timeout: 5000 });
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          for (const name of ['Community site', 'Country', 'Reporting date (UTC)']) {
            expect(await page.getByRole('button', { name, exact: true }).isVisible()).toBe(true);
          }
          for (const [index, [title]] of layout.cards.entries()) {
            const card = page.getByTestId('dashcard').filter({ has: page.getByRole('link', { name: title, exact: true }) });
            await card.scrollIntoViewIfNeeded();
            await card.screenshot({ path: `${output}/metabase-${layout.key}-${device}-card-${index + 1}.png` });
          }
          await page.getByTestId('dashboard-name-heading').scrollIntoViewIfNeeded();
          await page.screenshot({ path: `${output}/metabase-${layout.key}-${device}.png`, fullPage: true });
        }
      } finally { await page.close(); }
    }, 90000);
  }
});
