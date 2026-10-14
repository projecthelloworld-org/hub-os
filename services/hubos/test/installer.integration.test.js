import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Kuma256Session } from '../src/kuma/adapter-2.5.6.js';

const project = process.env.HUBOS_TEST_INSTALLER_PROJECT;
const suite = project ? describe : describe.skip;
const root = resolve(import.meta.dir, '../../..');
const compose = ['-f', 'compose.yaml', '-f', 'compose/mel.compose.yaml', '-f', 'compose/monitoring.compose.yaml'];
const operatorPassword = 'Fixture-Operator-Password-2026!';
const metabasePassword = 'Fixture-Metabase-Password-2026!';
const kumaPassword = 'Fixture-Kuma-Password-2026!';
const base = 'http://127.0.0.1:19080';
const metabase = 'http://127.0.0.1:19081';
const operatorHeaders = { authorization: `Basic ${Buffer.from(`fixture-operator:${operatorPassword}`).toString('base64')}` };

suite('Fresh full installer with real applications (owned isolated fixture)', () => {
  let directory, client, sessionId, kuma;
  const environment = () => ({ PATH: process.env.PATH, LC_ALL: 'C',
    ...Object.fromEntries(['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']
      .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])),
    COMPOSE_PROJECT_NAME: project, HUBOS_BIND_ADDRESS: '127.0.0.1', HUBOS_HTTP_PORT: '19080',
    METABASE_PORT: '19081', KUMA_PORT: '19082', MAILPIT_WEB_PORT: '19085',
    HUBOS_OPERATOR_USERNAME: 'fixture-operator', HUBOS_OPERATOR_PASSWORD: operatorPassword,
    METABASE_ADMIN_EMAIL: 'installer-fixture@local.test', METABASE_ADMIN_PASSWORD: metabasePassword,
    KUMA_ADMIN_USER: 'fixture-kuma', KUMA_ADMIN_PASSWORD: kumaPassword,
  });
  const run = async (args, { cwd = directory, env = environment(), stdin, timeout = 30000 } = {}) => {
    const child = Bun.spawn(args, { cwd, env, stdin: stdin ?? 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => child.kill(), timeout);
    try {
      const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { stdout, stderr, status };
    } finally { clearTimeout(timer); }
  };
  const operator = async (path, options = {}) => fetch(`${base}${path}`, {
    ...options, headers: { ...operatorHeaders, 'content-type': 'application/json', ...options.headers }, signal: AbortSignal.timeout(10000),
  });
  const inventory = (value) => Array.isArray(value) ? value : value.data;

  beforeAll(async () => {
    if (!['hubos-v02-installer-live-test', 'hubos-ci-installer-test'].includes(project)) throw new Error('Owned installer fixture project required');
    const containers = await run(['docker', 'ps', '-a', '--filter', `label=com.docker.compose.project=${project}`, '--quiet'], { cwd: root });
    const volumes = await run(['docker', 'volume', 'ls', '--filter', `label=com.docker.compose.project=${project}`, '--quiet'], { cwd: root });
    if (containers.status !== 0 || volumes.status !== 0 || containers.stdout.trim() || volumes.stdout.trim()) {
      throw new Error('Full installer test requires a fresh isolated project with no retained volumes');
    }
    directory = await mkdtemp(join(tmpdir(), 'hubos-installer-native-'));
    console.log('Owned installer fixture directory:', directory);
    // Only tracked public files are copied. Never copy a user's private .env/plugins.
    const archive = Bun.spawn(['git', 'archive', 'HEAD'], { cwd: root, stdout: 'pipe', stderr: 'ignore' });
    const extracted = await run(['tar', '-xf', '-', '-C', directory], { stdin: archive.stdout });
    if (extracted.status !== 0 || await archive.exited !== 0) throw new Error('Cannot prepare installer fixture source');
    // The installer is deliberately excluded from release archives and is a separate asset.
    await cp(join(root, 'install.sh'), join(directory, 'install.sh'));
    for (const file of ['compose.yaml', 'compose/mel.compose.yaml', 'compose/monitoring.compose.yaml']) {
      const path = join(directory, file);
      await writeFile(path, (await readFile(join(root, file), 'utf8')).replaceAll('hubos/core:local', 'hubos/core:installer-fixture'));
    }
  }, 60000);

  afterAll(async () => {
    kuma?.close();
    if (directory) {
      // Keep this fixture's data/configuration for explicit diagnostics or restore testing.
      await run(['docker', 'compose', '-p', project, ...compose, 'stop'], { timeout: 60000 });
    }
  }, 90000);

  test('the actual installer provisions a protected empty live deployment, four dashboards and two infrastructure monitors', async () => {
    const installed = await run(['bash', 'install.sh', '--mode', 'live', '--non-interactive', '--yes'], { timeout: 900000 });
    if (installed.status !== 0) {
      console.error('Installer fixture did not complete:', installed.stderr);
      throw new Error('Native installer failed; inspect the owned fixture applications and provisioning tasks');
    }
    expect(installed.stdout).toContain('Application health and provisioning completed.');
    expect((await fetch(`${base}/api/v1/sites`)).status).toBe(401);
    expect((await operator('/')).status).toBe(200);
    expect((await (await operator('/api/v1/sites')).json()).sites).toEqual([]);
    const sources = (await (await operator('/api/v1/source-connections')).json()).source_connections;
    expect(sources.map((source) => source.plugin_id).sort()).toEqual(['metabase-alerts', 'uptime-kuma']);
    expect(sources.every((source) => !source.is_demo)).toBe(true);
    const login = await fetch(`${metabase}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'installer-fixture@local.test', password: metabasePassword }) });
    expect(login.status).toBe(200);
    sessionId = (await login.json()).id;
    client = async (path, options = {}) => {
      const response = await fetch(`${metabase}${path}`, { ...options,
        headers: { 'content-type': 'application/json', 'x-metabase-session': sessionId },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}), signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`Native Metabase fixture request failed (${response.status})`);
      return response.json();
    };
    expect(inventory(await client('/api/dashboard')).map((dashboard) => dashboard.name).sort()).toEqual([
      'Availability & Connectivity', 'Collection & Support', 'Community Operations', 'Devices & Field Evidence',
    ]);
    const databases = inventory(await client('/api/database'));
    expect(databases).toHaveLength(1);
    expect((await client(`/api/database/${databases[0].id}`)).details.user).toBe('hubos_analytics');
    kuma = new Kuma256Session({ url: 'http://127.0.0.1:19082', username: 'fixture-kuma', password: kumaPassword });
    await kuma.open();
    expect(kuma.createdAdmin).toBe(false);
    expect(Object.values(kuma.monitors).map((monitor) => monitor.name).sort()).toEqual([
      'HubOS API (infrastructure)', 'Metabase (infrastructure)',
    ]);
  }, 960000);

  test('repeat installation retains accounts, live sites, credentials and operator-customized dashboards without duplication', async () => {
    const configuration = await readFile(join(directory, '.env'), 'utf8');
    const account = await client('/api/user/current');
    const dashboards = inventory(await client('/api/dashboard'));
    const questions = inventory(await client('/api/card'));
    const database = inventory(await client('/api/database'));
    const monitorIds = Object.keys(kuma.monitors).sort();
    const customised = dashboards.find((dashboard) => dashboard.name === 'Community Operations');
    await client(`/api/dashboard/${customised.id}`, { method: 'PUT', body: { name: 'Operator community overview' } });
    const organisations = (await (await operator('/api/v1/organisations')).json()).organisations;
    expect(organisations).toHaveLength(1);
    const created = await operator('/api/v1/sites', { method: 'POST', body: JSON.stringify({
      organisation_id: organisations[0].id, site_code: 'INSTALLER-FIXTURE-01', name: 'Installer fixture community centre',
      country_code: 'UG', site_type: 'community_centre',
    }) });
    expect(created.status).toBe(201);
    const site = await created.json();
    kuma.close();
    const repeated = await run(['bash', 'install.sh', '--mode', 'live', '--non-interactive', '--yes'], { timeout: 900000 });
    if (repeated.status !== 0) throw new Error('Native repeat installer did not complete; inspect owned fixture provisioning tasks');
    expect(repeated.stdout).toContain('Application health and provisioning completed.');
    expect(await readFile(join(directory, '.env'), 'utf8')).toBe(configuration);
    expect((await client('/api/user/current')).id).toBe(account.id);
    expect(inventory(await client('/api/dashboard')).map((dashboard) => dashboard.id).sort()).toEqual(dashboards.map((dashboard) => dashboard.id).sort());
    expect((await client(`/api/dashboard/${customised.id}`)).name).toBe('Operator community overview');
    expect(inventory(await client('/api/card')).map((question) => question.id).sort()).toEqual(questions.map((question) => question.id).sort());
    expect(inventory(await client('/api/database')).map((item) => item.id)).toEqual(database.map((item) => item.id));
    const sites = (await (await operator('/api/v1/sites')).json()).sites;
    expect(sites).toHaveLength(1);
    expect(sites[0].id).toBe(site.id);
    expect(sites[0].is_demo).toBe(false);
    kuma = new Kuma256Session({ url: 'http://127.0.0.1:19082', username: 'fixture-kuma', password: kumaPassword });
    await kuma.open();
    expect(kuma.createdAdmin).toBe(false);
    expect(Object.keys(kuma.monitors).sort()).toEqual(monitorIds);
  }, 960000);
});
