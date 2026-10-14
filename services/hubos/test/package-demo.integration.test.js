import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createMetabaseClient } from '../src/metabase/client.js';
import { Kuma256Session } from '../src/kuma/adapter-2.5.6.js';

const project = process.env.HUBOS_TEST_DEMO_PACKAGE_PROJECT;
const suite = project ? describe : describe.skip;
const root = resolve(import.meta.dir, '../../..');
const layers = ['compose.yaml', 'compose/mel.compose.yaml', 'compose/monitoring.compose.yaml', 'compose/development.compose.yaml'];
const base = 'http://127.0.0.1:19380', meta = 'http://127.0.0.1:19381', origin = 'https://127.0.0.1:19495';
const passwords = { operator: 'Fixture-Demo-Operator-2026!', metabase: 'Fixture-Demo-Metabase-2026!', kuma: 'Fixture-Demo-Kuma-2026!' };
const inventory = (value) => Array.isArray(value) ? value : value.data;

suite('Fresh and repeat sealed demonstration package (owned fixture)', () => {
  let workspace, directory, certificate, server, checksum, version, client, account, dashboards, cards, monitors, sites;
  const environment = () => ({ PATH: process.env.PATH, LC_ALL: 'C',
    ...Object.fromEntries(['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']
      .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])),
    COMPOSE_PROJECT_NAME: project, HUBOS_BIND_ADDRESS: '127.0.0.1', HUBOS_HTTP_PORT: '19380', METABASE_PORT: '19381',
    KUMA_PORT: '19382', MAILPIT_WEB_PORT: '19385', HUBOS_OPERATOR_USERNAME: 'demo-operator',
    HUBOS_OPERATOR_PASSWORD: passwords.operator, METABASE_ADMIN_EMAIL: 'demo-package-fixture@local.test',
    METABASE_ADMIN_PASSWORD: passwords.metabase, KUMA_ADMIN_USER: 'demo-kuma', KUMA_ADMIN_PASSWORD: passwords.kuma,
    ...(certificate ? { CURL_CA_BUNDLE: certificate } : {}),
  });
  const run = async (args, { cwd = workspace ?? root, stdin, timeout = 120000 } = {}) => {
    const process = Bun.spawn(args, { cwd, env: environment(), stdin: stdin ?? 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => process.kill('SIGTERM'), timeout);
    try {
      const [stdout, stderr, status] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
      return { stdout, stderr, status };
    } finally { clearTimeout(timer); }
  };
  const command = async (args, options, label) => {
    const result = await run(args, options);
    if (result.status !== 0) throw new Error(label);
    return result;
  };
  const operator = async (path) => {
    const response = await fetch(`${base}${path}`, { headers: {
      authorization: `Basic ${Buffer.from(`demo-operator:${passwords.operator}`).toString('base64')}` }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Owned demonstration API unavailable');
    return response.json();
  };
  const login = async () => {
    const response = await fetch(`${meta}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'demo-package-fixture@local.test', password: passwords.metabase }), signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Owned demonstration Metabase login failed');
    client = createMetabaseClient({ url: meta, sessionId: (await response.json()).id });
  };
  const kumaInventory = async () => {
    const session = new Kuma256Session({ url: 'http://127.0.0.1:19382', username: 'demo-kuma', password: passwords.kuma });
    try { await session.open(); return Object.values(session.monitors); } finally { session.close(); }
  };
  const install = async () => {
    const curl = Bun.spawn(['curl', '--fail', '--silent', '--show-error', '--proto', '=https', `${origin}/install.sh`],
      { env: environment(), stdout: 'pipe', stderr: 'ignore' });
    const result = await run(['bash', '-s', '--', '--install-dir', directory, '--mode', 'demo', '--non-interactive', '--yes'],
      { stdin: curl.stdout, timeout: 900000 });
    if (await curl.exited !== 0 || result.status !== 0) throw new Error('Sealed demonstration installation failed; inspect only owned fixture state');
    expect(result.stdout).toContain('Application health and provisioning completed.');
  };

  beforeAll(async () => {
    if (!['hubos-v02-demo-package-test', 'hubos-ci-demo-package-test'].includes(project)) throw new Error('Owned demonstration package project required');
    for (const args of [['docker', 'ps', '-a', '--quiet'], ['docker', 'volume', 'ls', '--quiet']]) {
      const result = await run([...args, '--filter', `label=com.docker.compose.project=${project}`]);
      if (result.status !== 0 || result.stdout.trim()) throw new Error('Fresh demo package test requires an unused namespace and fresh volumes');
    }
    workspace = await mkdtemp(join(tmpdir(), 'hubos-demo-package-native-'));
    directory = join(workspace, 'installation');
    if (process.env.HUBOS_TEST_DEMO_PACKAGE_RESULT_FILE) {
      const path = resolve(process.env.HUBOS_TEST_DEMO_PACKAGE_RESULT_FILE);
      if (project !== 'hubos-ci-demo-package-test' || path !== join(tmpdir(), 'hubos-ci-demo-package-directory.txt')) {
        throw new Error('Demo fixture output is reserved for isolated CI');
      }
      await writeFile(path, directory + '\n', { flag: 'wx', mode: 0o600 });
    }
    console.log('Owned fresh demo fixture directory:', directory);
    version = JSON.parse(await readFile(join(root, 'services/hubos/package.json'), 'utf8')).version;
    const source = join(workspace, 'source'), tree = join(source, `hubos-v${version}`), initial = join(workspace, 'source.tar');
    await mkdir(source);
    await command(['git', 'archive', '--format=tar', `--prefix=hubos-v${version}/`, `--output=${initial}`, 'HEAD'], { cwd: root }, 'Cannot create tracked demo package');
    await command(['tar', '-xf', initial, '-C', source], {}, 'Cannot unpack demo package source');
    // Namespace the built image as well as persistent storage; never replace an
    // image tag belonging to another local deployment during a rehearsal.
    for (const file of layers) {
      const path = join(tree, file);
      await writeFile(path, (await readFile(path, 'utf8')).replaceAll('hubos/core:local', 'hubos/core:demo-package-fixture'));
    }
    const archive = join(workspace, 'candidate.tar.gz');
    await command(['tar', '-czf', archive, '-C', source, `hubos-v${version}`], {}, 'Cannot seal demo archive');
    checksum = createHash('sha256').update(await readFile(archive)).digest('hex');
    certificate = join(workspace, 'package-ca.pem');
    const key = join(workspace, 'package-key.pem');
    await command(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-keyout', key, '-out', certificate], {}, 'Cannot create isolated demo HTTPS certificate');
    const installer = (await readFile(join(root, 'install.sh'), 'utf8'))
      .replace(/^DEFAULT_RELEASE_URL="[^"]+"/m, `DEFAULT_RELEASE_URL="${origin}/candidate.tar.gz"`)
      .replace(/^DEFAULT_RELEASE_SHA256="[^"]+"/m, `DEFAULT_RELEASE_SHA256="${checksum}"`);
    server = Bun.serve({ hostname: '127.0.0.1', port: 19495, tls: { cert: Bun.file(certificate), key: Bun.file(key) }, fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/install.sh') return new Response(installer, { headers: { 'content-type': 'text/x-shellscript' } });
      if (path === '/candidate.tar.gz') return new Response(Bun.file(archive));
      return new Response('Not found', { status: 404 });
    } });
  }, 120000);
  afterAll(async () => {
    server?.stop(true);
    if (directory && await Bun.file(join(directory, 'compose.yaml')).exists()) {
      await run(['docker', 'compose', '-p', project, ...layers.flatMap((file) => ['-f', file]), 'stop'], { cwd: directory });
    }
  }, 150000);

  test('the fresh piped package creates mixed synthetic sites, four dashboards and explicitly scoped monitors', async () => {
    console.log('Installing the fresh sealed demonstration package…');
    await install();
    expect(await readFile(join(directory, '.hubos-release'), 'utf8')).toBe(`version=${version}\nsha256=${checksum}\n`);
    const overview = await operator('/api/v1/overview');
    sites = overview.sites;
    expect(overview.installation.mode).toBe('demo');
    expect(sites).toHaveLength(10);
    expect(sites.filter((site) => site.country_code === 'UG')).toHaveLength(5);
    expect(sites.filter((site) => site.country_code === 'AO')).toHaveLength(5);
    expect([...new Set(sites.map((site) => site.site_type))].sort()).toEqual(['community_centre', 'library', 'school']);
    expect(sites.every((site) => site.is_demo)).toBe(true);
    expect((await fetch(`${base}/api/v1/overview`)).status).toBe(401);
    await login();
    account = await client('/api/user/current');
    dashboards = inventory(await client('/api/dashboard')); cards = inventory(await client('/api/card'));
    expect(dashboards.map((dashboard) => dashboard.name).sort()).toEqual(['Availability & Connectivity', 'Collection & Support', 'Community Operations', 'Devices & Field Evidence']);
    for (const item of dashboards) {
      const dashboard = await client(`/api/dashboard/${item.id}`);
      expect(dashboard.parameters.map((parameter) => parameter.id)).toEqual(['hubos-site', 'hubos-country', 'hubos-date']);
      for (const card of dashboard.dashcards) {
        const names = card.card.name === 'Monitoring infrastructure — current reachability' ? ['date'] : ['site', 'country', 'date'];
        expect(card.parameter_mappings).toEqual(names.map((name) => ({ parameter_id: `hubos-${name}`,
          card_id: card.card.id, target: ['dimension', ['template-tag', name]] })));
      }
    }
    const databases = inventory(await client('/api/database'));
    expect(databases).toHaveLength(1);
    expect((await client(`/api/database/${databases[0].id}`)).details.user).toBe('hubos_analytics');
    monitors = await kumaInventory();
    expect(monitors).toHaveLength(12);
    expect(monitors.filter((monitor) => monitor.name.startsWith('[DEMO]'))).toHaveLength(10);
    expect(monitors.filter((monitor) => monitor.name.includes('infrastructure'))).toHaveLength(2);
  }, 960000);

  test('repeat piped startup preserves accounts, canonical identities and operator-customized dashboards without duplicates', async () => {
    if (!dashboards || !monitors || !account) throw new Error('Fresh demonstration provisioning must succeed first');
    const configuration = await readFile(join(directory, '.env'), 'utf8');
    const customised = dashboards.find((dashboard) => dashboard.name === 'Community Operations');
    await client(`/api/dashboard/${customised.id}`, { method: 'PUT', body: { name: 'Fixture customised community overview' } });
    await install(); await login();
    expect(await readFile(join(directory, '.env'), 'utf8')).toBe(configuration);
    expect((await client('/api/user/current')).id).toBe(account.id);
    const retained = inventory(await client('/api/dashboard'));
    expect(retained.map((dashboard) => dashboard.id).sort()).toEqual(dashboards.map((dashboard) => dashboard.id).sort());
    expect(retained.map((dashboard) => dashboard.name)).toContain('Fixture customised community overview');
    expect(inventory(await client('/api/card')).map((card) => card.id).sort()).toEqual(cards.map((card) => card.id).sort());
    expect((await operator('/api/v1/sites')).sites.map((site) => site.id).sort()).toEqual(sites.map((site) => site.id).sort());
    expect((await kumaInventory()).map((monitor) => monitor.id).sort()).toEqual(monitors.map((monitor) => monitor.id).sort());
  }, 960000);
});
