import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomId } from '../src/ids.js';

const project = process.env.HUBOS_TEST_TLS_PROJECT;
const suite = project ? describe : describe.skip;
const root = resolve(import.meta.dir, '../../..');
const files = ['-f', 'compose/access-test.compose.yaml', '-f', 'compose/tls.compose.yaml', '-f', 'compose/tls-test.compose.yaml'];
suite('Verified HTTPS operator transport (owned local-CA fixture)', () => {
  let directory, certificate;
  const run = async (args, timeout = 15000) => {
    const child = Bun.spawn(args, { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => child.kill(), timeout);
    try {
      const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { stdout, stderr, status };
    } finally { clearTimeout(timer); }
  };
  const request = async (path, { http = false, auth = false, origin, body, trusted = true, hostname = 'hubos.test' } = {}) => {
    const port = http ? 19440 : 19443;
    const result = await run(['curl', '--silent', '--show-error', '--max-time', '10', '--noproxy', '*',
      '--resolve', `${hostname}:${port}:127.0.0.1`, ...(trusted && !http ? ['--cacert', certificate] : []),
      ...(auth ? ['--user', 'fixture-operator:Fixture-Operator-2026!'] : []),
      ...(origin ? ['--header', `Origin: ${origin}`] : []),
      ...(body ? ['--header', 'Content-Type: application/json', '--data', JSON.stringify(body)] : []),
      '--dump-header', '-', '--write-out', '\n__HUBOS_STATUS__%{http_code}', `${http ? 'http' : 'https'}://${hostname}:${port}${path}`]);
    const separator = result.stdout.indexOf('\r\n\r\n');
    return { ...result, code: Number(result.stdout.match(/__HUBOS_STATUS__(\d+)$/)?.[1]),
      headers: result.stdout.slice(0, separator), body: result.stdout.slice(separator + 4).replace(/\n__HUBOS_STATUS__\d+$/, '') };
  };
  beforeAll(async () => {
    if (!['hubos-v02-tls-test', 'hubos-ci-tls-test'].includes(project)) throw new Error('Owned TLS fixture project required');
    directory = await mkdtemp(join(tmpdir(), 'hubos-tls-public-ca-'));
    certificate = join(directory, 'root.crt');
    const started = await run(['docker', 'compose', '-p', project, ...files, 'up', '-d', '--wait'], 90000);
    if (started.status !== 0) throw new Error('Cannot start isolated TLS fixture');
    const publicCertificate = await run(['docker', 'compose', '-p', project, ...files, 'exec', '-T', 'caddy',
      'cat', '/data/caddy/pki/authorities/local/root.crt']);
    if (publicCertificate.status !== 0 || !publicCertificate.stdout.includes('BEGIN CERTIFICATE')) throw new Error('Fixture public CA unavailable');
    await writeFile(certificate, publicCertificate.stdout, { mode: 0o600 });
  }, 120000);
  afterAll(async () => {
    if (directory) {
      await run(['docker', 'compose', '-p', project, ...files, 'stop'], 60000);
      await rm(directory, { recursive: true, force: true });
    }
  }, 90000);
  test('HTTP redirects to a hostname-verified HTTPS listener before operator authentication', async () => {
    const redirected = await request('/', { http: true });
    expect(redirected.status).toBe(0);
    expect(redirected.code).toBe(308);
    expect(redirected.headers).toContain('Location: https://hubos.test:19443/');
    const healthy = await request('/readyz');
    expect(healthy.status).toBe(0);
    expect(healthy.code).toBe(200);
    expect(JSON.parse(healthy.body).status).toBe('ready');
    expect((await request('/api/v1/sites')).code).toBe(401);
    expect((await request('/api/v1/sites', { auth: true })).code).toBe(200);
  });
  test('certificate trust and hostname checks are not bypassed', async () => {
    expect((await request('/readyz', { trusted: false })).status).not.toBe(0);
    expect((await request('/readyz', { hostname: 'unconfigured.example.invalid' })).status).not.toBe(0);
  });
  test('operator writes use the configured HTTPS origin, rejecting cross-origin requests', async () => {
    const organisations = JSON.parse((await request('/api/v1/organisations', { auth: true })).body).organisations;
    const body = { organisation_id: organisations[0].id, site_code: `TLS-${randomId()}`,
      name: 'TLS fixture community centre', country_code: 'UG', site_type: 'community_centre' };
    expect((await request('/api/v1/sites', { auth: true, origin: 'https://untrusted.example.invalid', body })).code).toBe(403);
    const accepted = await request('/api/v1/sites', { auth: true, origin: 'https://hubos.test:19443', body });
    expect(accepted.code).toBe(201);
    expect(JSON.parse(accepted.body).site_type).toBe('community_centre');
  });
});
