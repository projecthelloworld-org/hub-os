import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createMetabaseClient } from '../src/metabase/client.js';
import { Kuma256Session } from '../src/kuma/adapter-2.5.6.js';

const project = process.env.HUBOS_TEST_PACKAGE_PROJECT;
const suite = project ? describe : describe.skip;
const root = resolve(import.meta.dir, '../../..');
const oldInstallerSha = 'f4c63799dab326cb9f8934523b59569d519557f60f8d95a9e90ae84c60051a9c';
const oldArchiveSha = 'b1db6a4760fd06b1cea14b2fce6452eeaad311035b1d87661ca4444f2fdb3af7';
const oldInstallerUrl = 'https://hubos.myhellohub.org/releases/v0.1.0/install.sh';
const oldArchiveUrl = 'https://github.com/projecthelloworld-org/hub-os/releases/download/v0.1.0/hubos-v0.1.0.tar.gz';
const oldLayers = ['compose.yaml', 'compose/mel.compose.yaml', 'compose/development.compose.yaml'];
const newLayers = ['compose.yaml', 'compose/mel.compose.yaml', 'compose/monitoring.compose.yaml', 'compose/development.compose.yaml'];
const base = 'http://127.0.0.1:19280', meta = 'http://127.0.0.1:19281';
const packageOrigin = 'https://127.0.0.1:19494';
const passwords = { operator: 'Fixture-Package-Operator-2026!', metabase: 'Fixture-Package-Metabase-2026!', kuma: 'Fixture-Package-Kuma-2026!' };
const image = { old: 'hubos/core:package-fixture-v01', candidate: 'hubos/core:package-fixture-candidate' };
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const inventory = (value) => Array.isArray(value) ? value : value.data;

suite('Published v0.1.0 package → checksum-sealed monitoring candidate (owned fixture)', () => {
  let workspace, directory, server, certificate, installer, candidateArchive, candidateSha, version;
  let settings, client, accountId, databaseId, customCard, customDashboard, sitesBefore, mappingsBefore, observationBefore;
  const environment = () => ({ PATH: process.env.PATH, LC_ALL: 'C',
    ...Object.fromEntries(['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']
      .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])),
    COMPOSE_PROJECT_NAME: project, HUBOS_BIND_ADDRESS: '127.0.0.1', HUBOS_HTTP_PORT: '19280', METABASE_PORT: '19281',
    KUMA_PORT: '19282', MAILPIT_WEB_PORT: '19285', HUBOS_OPERATOR_USERNAME: 'package-operator',
    HUBOS_OPERATOR_PASSWORD: passwords.operator, METABASE_ADMIN_EMAIL: 'package-fixture@local.test',
    METABASE_ADMIN_PASSWORD: passwords.metabase, KUMA_ADMIN_USER: 'package-kuma', KUMA_ADMIN_PASSWORD: passwords.kuma,
    ...(certificate ? { CURL_CA_BUNDLE: certificate } : {}),
  });
  const run = async (args, { cwd = directory ?? root, env = environment(), stdin, timeout = 120000 } = {}) => {
    const child = Bun.spawn(args, { cwd, env, stdin: stdin ?? 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    try {
      const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { stdout, stderr, status };
    } finally { clearTimeout(timer); }
  };
  const requireSuccess = async (args, options, label) => {
    const result = await run(args, options);
    if (result.status !== 0) {
      let diagnostic = result.stderr;
      let privateSettings = {};
      try { privateSettings = await readSettings(); } catch { /* Configuration may not exist yet. */ }
      for (const secret of [...Object.values(privateSettings), ...Object.values(passwords)]) {
        if (typeof secret === 'string' && secret.length >= 3) diagnostic = diagnostic.replaceAll(secret, '<REDACTED>');
      }
      throw new Error(`${label} (${result.status}): ${diagnostic.trim().slice(-3000)}`);
    }
    return result;
  };
  const compose = (args, layers = newLayers) => run(['docker', 'compose', '-p', project,
    ...layers.flatMap((file) => ['-f', file]), ...args]);
  const readSettings = async () => Object.fromEntries((await readFile(join(directory, '.env'), 'utf8')).split('\n')
    .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line)).map((line) => {
      const index = line.indexOf('='), raw = line.slice(index + 1);
      return [line.slice(0, index), raw.startsWith('"') ? JSON.parse(raw) : raw.replace(/^'|'$/g, '')];
    }));
  const operator = async (path, options = {}, authenticated = true) => {
    const response = await fetch(`${base}${path}`, { ...options, headers: {
      ...(authenticated ? { authorization: `Basic ${Buffer.from(`package-operator:${passwords.operator}`).toString('base64')}` } : {}),
      'content-type': 'application/json', ...options.headers }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Package fixture operator request failed (${response.status})`);
    return response.json();
  };
  const login = async () => {
    const response = await fetch(`${meta}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'package-fixture@local.test', password: passwords.metabase }), signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Package fixture Metabase login failed');
    client = createMetabaseClient({ url: meta, sessionId: (await response.json()).id });
  };
  const sql = async (query, layers = newLayers) => {
    const result = await compose(['exec', '-T', 'db', 'psql', '-U', 'hubos', '-d', 'hubos', '-Atc', query], layers);
    if (result.status !== 0) throw new Error('Owned package fixture SQL verification failed');
    return result.stdout.trim();
  };

  beforeAll(async () => {
    if (!['hubos-v02-package-test', 'hubos-ci-package-test'].includes(project)) throw new Error('Only the owned package fixture is accepted');
    for (const args of [['docker', 'ps', '-a', '--quiet'], ['docker', 'volume', 'ls', '--quiet']]) {
      const result = await run([...args, '--filter', `label=com.docker.compose.project=${project}`]);
      if (result.status !== 0 || result.stdout.trim()) throw new Error('Package test requires fresh isolated storage');
    }
    workspace = await mkdtemp(join(tmpdir(), 'hubos-package-native-'));
    directory = join(workspace, 'installation');
    installer = join(workspace, 'legacy-install.sh');
    const legacyArchive = join(workspace, 'legacy.tar.gz');
    for (const [url, path, expected] of [[oldInstallerUrl, installer, oldInstallerSha], [oldArchiveUrl, legacyArchive, oldArchiveSha]]) {
      await requireSuccess(['curl', '--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https',
        '--connect-timeout', '15', '--max-time', '180', url, '--output', path], { cwd: workspace, timeout: 200000 }, 'Cannot download published v0.1.0 fixture');
      if (digest(await readFile(path)) !== expected) throw new Error('Published v0.1.0 artifact differs from its immutable checksum');
    }
    console.log('Owned package fixture directory:', directory);
    // The original installer verifies the published archive; only Docker CLI/image
    // namespaces and loopback fixture settings change, not legacy runtime code.
    await requireSuccess(['bash', installer, '--install-dir', directory, '--non-interactive', '--yes', '--no-start'],
      { cwd: workspace, timeout: 240000 }, 'Published v0.1.0 installer configuration failed');
    // v0.1.0's private umask also affects public extracted files. Restore the
    // archive's advertised source modes before building its unchanged runtime.
    // This fixture repair does not alter any published tag or release asset.
    const publicTree = join(workspace, 'legacy-public-source');
    await mkdir(publicTree);
    await requireSuccess(['tar', '-xzpf', legacyArchive, '--no-same-owner', '-C', publicTree],
      { cwd: workspace }, 'Cannot preserve original legacy archive source modes');
    await requireSuccess(['cp', '-RPp', join(publicTree, 'hubos-v0.1.0') + '/.', directory + '/'],
      { cwd: workspace }, 'Cannot restore readable legacy public source');
    for (const file of oldLayers) {
      const path = join(directory, file);
      await writeFile(path, (await readFile(path, 'utf8')).replaceAll('hubos/core:local', image.old));
    }
    await writeFile(join(directory, '.env'), (await readFile(join(directory, '.env'), 'utf8'))
      + `\nCOMPOSE_PROJECT_NAME=${project}\n`, { mode: 0o600 });
    await cp(installer, join(directory, 'install.sh'));
    console.log('Starting actual published legacy application code on private fixture ports…');
    await requireSuccess(['bash', 'install.sh', '--non-interactive', '--yes'], { timeout: 900000 }, 'Legacy package applications failed to become healthy');
    // The old installer waits for application health, not bootstrap completion.
    // Establish an actually provisioned legacy account before testing retention.
    const deadline = performance.now() + 120000;
    let provisioned = false;
    while (performance.now() < deadline) {
      const ids = await compose(['ps', '--all', '-q', 'metabase-bootstrap'], oldLayers);
      if (ids.status !== 0 || !ids.stdout.trim()) throw new Error('Legacy bootstrap container missing');
      const status = await run(['docker', 'inspect', '--format', '{{.State.Status}}|{{.State.ExitCode}}', ids.stdout.trim()]);
      if (status.status !== 0) throw new Error('Cannot inspect legacy bootstrap');
      if (status.stdout.trim() === 'exited|0') { provisioned = true; break; }
      if (status.stdout.startsWith('exited|')) throw new Error('Legacy account provisioning failed');
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!provisioned) throw new Error('Legacy account provisioning did not complete');
    settings = await readSettings();
    sitesBefore = (await operator('/api/v1/sites', {}, false)).sites;
    if (sitesBefore.length !== 10) throw new Error('Published package did not seed its ten fictional sites');
    // Choose a source with an actual legacy mapping to the selected canonical site.
    const sourceId = await sql(`SELECT source_connection_id FROM external_identifiers WHERE entity_type='site' AND entity_id='${sitesBefore[0].id}' ORDER BY source_connection_id LIMIT 1`, oldLayers);
    await operator('/api/v1/ingest/observations:batch', { method: 'POST', headers: { 'x-hubos-ingest-key': settings.HUBOS_INGEST_KEY },
      body: JSON.stringify({ observations: [{ site_id: sitesBefore[0].id, source_connection_id: sourceId,
        external_record_id: 'fixture:package-upgrade:preserve', metric: 'connectivity.latency.ms', value: 77, unit: 'ms',
        quality: 'valid', observed_at: new Date().toISOString(), attributes: { synthetic: true } }] }) }, false);
    observationBefore = await sql("SELECT id||'|'||site_id||'|'||source_connection_id||'|'||value FROM observations WHERE external_record_id='fixture:package-upgrade:preserve'", oldLayers);
    mappingsBefore = (await sql("SELECT id||'|'||entity_id||'|'||external_id FROM external_identifiers ORDER BY id", oldLayers)).split('\n');
    await login();
    accountId = (await client('/api/user/current')).id;
    const database = inventory(await client('/api/database')).find((item) => item.details?.dbname === 'hubos');
    if (!database) throw new Error('Legacy reporting connection is not provisioned');
    databaseId = database.id;
    customCard = await client('/api/card', { method: 'POST', body: { name: 'Fixture operator site register', display: 'table', visualization_settings: {},
      dataset_query: { database: databaseId, type: 'native', native: { query: 'SELECT DISTINCT site_code FROM analytics.site_status_current ORDER BY site_code', 'template-tags': {} } } } });
    customDashboard = await client('/api/dashboard', { method: 'POST', body: { name: 'Fixture operator dashboard', description: 'Synthetic operator-owned resource', parameters: [] } });
    await client(`/api/dashboard/${customDashboard.id}`, { method: 'PUT', body: { dashcards: [{ id: -1, card_id: customCard.id, row: 0, col: 0,
      size_x: 12, size_y: 6, series: [], parameter_mappings: [] }] } });
    version = JSON.parse(await readFile(join(root, 'services/hubos/package.json'), 'utf8')).version;
    const staging = join(workspace, 'candidate-source'), tree = join(staging, `hubos-v${version}`);
    await mkdir(staging);
    const initialTar = join(workspace, 'candidate-source.tar');
    await requireSuccess(['git', 'archive', '--format=tar', `--prefix=hubos-v${version}/`, `--output=${initialTar}`, 'HEAD'], { cwd: root }, 'Cannot build tracked candidate source');
    await requireSuccess(['tar', '-xf', initialTar, '-C', staging], { cwd: workspace }, 'Cannot unpack candidate source');
    for (const file of newLayers) {
      const path = join(tree, file);
      await writeFile(path, (await readFile(path, 'utf8')).replaceAll('hubos/core:local', image.candidate));
    }
    candidateArchive = join(workspace, 'candidate.tar.gz');
    await requireSuccess(['tar', '-czf', candidateArchive, '-C', staging, `hubos-v${version}`], { cwd: workspace }, 'Cannot seal candidate package');
    candidateSha = digest(await readFile(candidateArchive));
    certificate = join(workspace, 'package-ca.pem');
    const key = join(workspace, 'package-key.pem');
    await requireSuccess(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-keyout', key, '-out', certificate], { cwd: workspace }, 'Cannot create isolated package HTTPS certificate');
    const sealed = (await readFile(join(root, 'install.sh'), 'utf8'))
      .replace(/^DEFAULT_RELEASE_URL="[^"]+"/m, `DEFAULT_RELEASE_URL="${packageOrigin}/candidate.tar.gz"`)
      .replace(/^DEFAULT_RELEASE_SHA256="[^"]+"/m, `DEFAULT_RELEASE_SHA256="${candidateSha}"`);
    server = Bun.serve({ hostname: '127.0.0.1', port: 19494, tls: { cert: Bun.file(certificate), key: Bun.file(key) },
      fetch(request) { const path = new URL(request.url).pathname;
        if (path === '/candidate.tar.gz') return new Response(Bun.file(candidateArchive));
        if (path === '/install.sh') return new Response(sealed, { headers: { 'content-type': 'text/x-shellscript' } });
        return new Response('Not found', { status: 404 }); } });
  }, 1200000);

  afterAll(async () => {
    server?.stop(true);
    if (directory && await Bun.file(join(directory, 'compose.yaml')).exists()) {
      const layers = [];
      for (const file of newLayers) if (await Bun.file(join(directory, file)).exists()) layers.push(file);
      await compose(['stop'], layers);
    }
  }, 150000);

  test('the actual piped installer upgrades the sealed package without changing canonical data or existing tool resources', async () => {
    const configuration = await readFile(join(directory, '.env'), 'utf8');
    const curl = Bun.spawn(['curl', '--fail', '--silent', '--show-error', '--proto', '=https', `${packageOrigin}/install.sh`],
      { env: environment(), stdout: 'pipe', stderr: 'ignore' });
    console.log('Upgrading the owned legacy package through its checksum-sealed HTTPS installer…');
    const result = await run(['bash', '-s', '--', '--install-dir', directory, '--non-interactive', '--yes'],
      { stdin: curl.stdout, timeout: 900000, cwd: workspace });
    expect(await curl.exited).toBe(0);
    if (result.status !== 0) throw new Error('Sealed package upgrade failed; inspect only the owned fixture service state');
    expect(result.stdout).toContain('Application health and provisioning completed.');
    expect((await readFile(join(directory, '.env'), 'utf8')).startsWith(configuration)).toBe(true);
    expect(await readFile(join(directory, '.hubos-release'), 'utf8')).toBe(`version=${version}\nsha256=${candidateSha}\n`);
    expect((await fetch(`${base}/api/v1/sites`)).status).toBe(401);
    const sites = (await operator('/api/v1/sites')).sites;
    expect(sites.map((site) => site.id).sort()).toEqual(sitesBefore.map((site) => site.id).sort());
    expect(await sql("SELECT id||'|'||site_id||'|'||source_connection_id||'|'||value FROM observations WHERE external_record_id='fixture:package-upgrade:preserve'")).toBe(observationBefore);
    const mappings = (await sql("SELECT id||'|'||entity_id||'|'||external_id FROM external_identifiers ORDER BY id")).split('\n');
    expect(mappingsBefore.every((mapping) => mappings.includes(mapping))).toBe(true);
    await login();
    expect((await client('/api/user/current')).id).toBe(accountId);
    expect((await client(`/api/database/${databaseId}`)).details.user).toBe('hubos_analytics');
    expect((await client(`/api/dashboard/${customDashboard.id}`)).dashcards[0].card_id).toBe(customCard.id);
    const query = await client(`/api/card/${customCard.id}/query`, { method: 'POST', body: { parameters: [] } });
    expect(query.status).toBe('completed');
    expect(query.data.rows.map((row) => row[0])).toEqual(sitesBefore.map((site) => site.site_code).sort());
    const names = inventory(await client('/api/dashboard')).map((item) => item.name);
    for (const name of ['Community Operations', 'Availability & Connectivity', 'Devices & Field Evidence', 'Collection & Support']) {
      expect(names.filter((value) => value === name)).toHaveLength(1);
    }
    const kuma = new Kuma256Session({ url: 'http://127.0.0.1:19282', username: 'package-kuma', password: passwords.kuma });
    try {
      await kuma.open();
      expect(Object.values(kuma.monitors)).toHaveLength(12);
      expect(Object.values(kuma.monitors).filter((monitor) => monitor.name.includes('infrastructure'))).toHaveLength(2);
    } finally { kuma.close(); }
  }, 960000);
});
