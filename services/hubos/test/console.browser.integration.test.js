import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const base = process.env.HUBOS_TEST_CONSOLE_URL;
const suite = base ? describe : describe.skip;
const output = resolve(import.meta.dir, '../../../output/playwright');
suite('Community operator console through authenticated Caddy (owned fixture)', () => {
  let browser, context;
  const loaded = async (page, count = '10') => page.waitForFunction((count) => document.querySelector('#site-count')?.textContent === count, count);
  beforeAll(async () => {
    if (base !== 'http://127.0.0.1:13041/') throw new Error('Only the owned access fixture may be used for browser tests');
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ httpCredentials: { username: 'fixture-operator', password: 'Fixture-Operator-2026!' } });
    await mkdir(output, { recursive: true });
  }, 30000);
  afterAll(async () => { await context?.close(); await browser?.close(); });

  test('mixed community sites, keyboard country filtering and desktop/mobile layouts use the Hello World dashboard identity', async () => {
    const page = await context.newPage();
    try {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(base); await loaded(page);
      expect(await page.locator('#installation-mode').textContent()).toBe('Synthetic demonstration');
      expect(await page.locator('#site-list').textContent()).toContain('Community centre');
      expect(await page.locator('#site-list').textContent()).toContain('Library');
      expect(await page.locator('#site-list').textContent()).toContain('School');
      expect(await page.locator('#site-list').textContent()).toContain('Synthetic');
      expect(await page.locator('.wordmark').evaluate((element) => getComputedStyle(element).color)).toBe('rgb(231, 96, 49)');
      expect(await page.locator('.summary-card').first().evaluate((element) => getComputedStyle(element).backgroundColor)).toBe('rgb(255, 255, 255)');
      expect(await page.getByRole('navigation', { name: 'Console sections' }).getByRole('link').count()).toBe(3);
      await page.screenshot({ path: `${output}/console-overview.png` });
      await page.screenshot({ path: `${output}/console-desktop.png`, fullPage: true });
      await page.getByRole('button', { name: 'Uganda', exact: true }).focus();
      await page.keyboard.press('Enter'); await loaded(page, '5');
      expect(await page.getByRole('button', { name: 'Uganda', exact: true }).getAttribute('aria-pressed')).toBe('true');
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Uganda');
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `${output}/console-mobile.png`, fullPage: true });
    } finally { await page.close(); }
  }, 30000);

  test('missing domains remain unknown and untrusted long labels are rendered as text', async () => {
    const page = await context.newPage();
    try {
      await page.route('**/api/v1/overview', (route) => route.fulfill({ json: { installation: { mode: 'live', version: 'fixture' }, incidents: [],
        sites: [{ id: 'presentation-fixture', site_code: 'SAFE-01', country_code: 'CA', site_type: 'library', is_demo: false,
          name: 'Biblioteca comunitária 图书馆 <img src=x onerror=alert(1)> ' + 'long-community-name-'.repeat(10),
          statuses: ['connectivity', 'power', 'usage'].map((domain) => ({ domain, status: 'healthy', reason: 'Fixture evidence' })) }] } }));
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(base); await loaded(page, '1');
      expect(await page.locator('#healthy-count').textContent()).toBe('0');
      expect(await page.locator('#unknown-count').textContent()).toBe('1');
      expect(await page.locator('#site-list img').count()).toBe(0);
      expect(await page.getByRole('button', { name: 'Canada', exact: true }).count()).toBe(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { await page.close(); }
  });

  test('failed refresh removes old health claims and a retry restores the overview', async () => {
    const page = await context.newPage();
    try {
      await page.goto(base); await loaded(page);
      await page.route('**/api/v1/overview', (route) => route.fulfill({ status: 503, json: { error: 'fixture-only failure' } }));
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await page.locator('#error-banner').waitFor({ state: 'visible' });
      expect(await page.locator('#site-count').textContent()).toBe('—');
      expect(await page.locator('#healthy-count').textContent()).toBe('—');
      expect(await page.locator('.site-row').count()).toBe(0);
      await page.unroute('**/api/v1/overview');
      await page.getByRole('button', { name: 'Try again', exact: true }).click(); await loaded(page);
      expect(await page.locator('#error-banner').isVisible()).toBe(false);
    } finally { await page.close(); }
  });

  test('live empty installations are not labelled synthetic and provide a setup path', async () => {
    const page = await context.newPage();
    try {
      await page.route('**/api/v1/overview', (route) => route.fulfill({ json: { installation: { mode: 'live', version: 'fixture' }, sites: [], incidents: [] } }));
      await page.route('**/api/v1/source-connections', (route) => route.fulfill({ json: { source_connections: [] } }));
      await page.goto(base); await loaded(page, '0');
      expect(await page.locator('#installation-mode').textContent()).toBe('Live installation');
      expect(await page.locator('#site-list').textContent()).toContain('No community sites configured');
      expect(await page.getByRole('link', { name: 'Site and connector setup guide', exact: true }).count()).toBe(1);
      expect(await page.locator('#installation-note').textContent()).not.toContain('Fictional');
    } finally { await page.close(); }
  });

  test('operators keep input on error, assign ownership and resolve incidents without machine keys in browser requests', async () => {
    const page = await context.newPage(), machineHeaders = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/api/v1/incidents/')) {
        const headers = request.headers();
        machineHeaders.push(['x-hubos-admin-key', 'x-hubos-ingest-key', 'x-hubos-webhook-key'].some((key) => key in headers));
      }
    });
    try {
      await page.goto(base); await loaded(page);
      const card = page.locator('.incident').first();
      await card.getByText('Respond to incident', { exact: true }).click();
      await card.getByLabel('Responsible team', { exact: true }).fill('Fixture browser support');
      await page.route('**/api/v1/incidents/*/acknowledge', (route) => route.fulfill({ status: 403, json: { error: 'fixture rejection' } }));
      await card.getByRole('button', { name: /Acknowledge|Update owner/ }).click();
      await card.getByText('This request was not permitted.', { exact: false }).waitFor();
      expect(await card.getByLabel('Responsible team', { exact: true }).inputValue()).toBe('Fixture browser support');
      await page.unroute('**/api/v1/incidents/*/acknowledge');
      await card.getByRole('button', { name: /Acknowledge|Update owner/ }).click();
      await page.getByText('Owner: Fixture browser support', { exact: true }).waitFor();
      await page.getByLabel('Resolution and evidence', { exact: true }).fill('Fixture service checked; manual support record, not a telemetry claim.');
      await page.getByRole('button', { name: 'Resolve manually', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#incident-count')?.textContent === '0');
      expect(machineHeaders).toEqual([false, false, false]);
      expect(await page.locator('#action-feedback').textContent()).toBe('Incident manually resolved.');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('attention-title');
    } finally { await page.close(); }
  }, 30000);
});
