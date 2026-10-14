import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cp, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { Kuma256Session } from '../src/kuma/adapter-2.5.6.js';

const sourceDirectory = process.env.HUBOS_TEST_BACKUP_SOURCE_DIR;
const suite = sourceDirectory ? describe : describe.skip;
const root = resolve(import.meta.dir, '../../..');
const project = process.env.HUBOS_TEST_BACKUP_PROJECT ?? 'hubos-v02-installer-live-test';
const restoreProject = process.env.HUBOS_TEST_RECOVERY_PROJECT ?? 'hubos-v02-recovery-test';
const files = ['-f', 'compose.yaml', '-f', 'compose/mel.compose.yaml', '-f', 'compose/monitoring.compose.yaml'];
const auth = `Basic ${Buffer.from('fixture-operator:Fixture-Operator-Password-2026!').toString('base64')}`;

suite('Core backup and recovery (owned native installer fixture)', () => {
  let directory, output, restored, originalSites, originalAccount, originalDashboards, originalMonitors;
  const run = async (args, timeout = 120000, cwd = directory) => {
    const child = Bun.spawn(args, { cwd, env: { ...process.env, COMPOSE_PROJECT_NAME: project }, stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => child.kill(), timeout);
    try {
      const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { stdout, stderr, status };
    } finally { clearTimeout(timer); }
  };
  const sites = async () => {
    const response = await fetch('http://127.0.0.1:19080/api/v1/sites', { headers: { authorization: auth }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Owned backup fixture unavailable');
    return (await response.json()).sites;
  };
  beforeAll(async () => {
    if (!['hubos-v02-installer-live-test', 'hubos-ci-installer-test'].includes(project)
      || !['hubos-v02-recovery-test', 'hubos-ci-recovery-test'].includes(restoreProject)) {
      throw new Error('Only explicitly owned installer and recovery projects may be used');
    }
    directory = await realpath(sourceDirectory);
    if (!basename(directory).startsWith('hubos-installer-native-') || !(await readFile(join(directory, '.env'), 'utf8')).includes(project)) {
      throw new Error('Only the owned native installer fixture may be backed up by this test');
    }
    output = join(await mkdtemp(join(tmpdir(), 'hubos-recovery-native-')), 'snapshot');
    const started = await run(['docker', 'compose', '-p', project, ...files, 'start', 'db', 'metabase-db', 'api', 'worker', 'metabase', 'kuma', 'caddy', 'mailpit']);
    if (started.status !== 0) throw new Error('Cannot start owned recovery fixture');
    const deadline = performance.now() + 120000;
    while (performance.now() < deadline) {
      try { await sites(); return; } catch { await new Promise((resolve) => setTimeout(resolve, 1000)); }
    }
    throw new Error('Owned recovery fixture did not become available');
  }, 150000);
  afterAll(async () => {
    if (directory) await run(['docker', 'compose', '-p', project, ...files, 'stop']);
    if (restored) await run(['docker', 'compose', '-p', restoreProject, ...files, 'stop'], 120000, restored);
  }, 150000);

  test('a consistent backup retains private configuration, databases and tool storage and resumes the original deployment', async () => {
    originalSites = await sites();
    expect(originalSites).toHaveLength(1);
    const result = await run([process.execPath, join(root, 'scripts/backup.js'), 'create', '--directory', directory,
      '--output', output, '--confirm-pause'], 300000);
    if (result.status !== 0) throw new Error(`Backup command failed: ${result.stderr}`);
    const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
    expect(manifest.format).toBe('hubos-backup-v1');
    expect(manifest.project).toBe(project);
    expect(manifest.consistency).toBe('writers-paused');
    expect(manifest.artifacts.map((artifact) => artifact.path)).toContain('database/core.dump');
    expect(manifest.artifacts.map((artifact) => artifact.path)).toContain('database/metabase.dump');
    for (const name of ['kuma-data', 'hubos-secrets', 'caddy-data', 'caddy-config']) {
      expect(manifest.artifacts.map((artifact) => artifact.path)).toContain(`volumes/${name}.tar.gz`);
    }
    expect((await stat(output)).mode & 0o777).toBe(0o700);
    expect(await readFile(join(output, 'configuration/.env'), 'utf8')).toBe(await readFile(join(directory, '.env'), 'utf8'));
    expect((await sites()).map((site) => site.id)).toEqual(originalSites.map((site) => site.id));
    const login = await fetch('http://127.0.0.1:19081/api/session', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'installer-fixture@local.test', password: 'Fixture-Metabase-Password-2026!' }) });
    expect(login.status).toBe(200);
    const session = (await login.json()).id;
    const read = async (path) => (await fetch(`http://127.0.0.1:19081${path}`, { headers: { 'x-metabase-session': session } })).json();
    originalAccount = await read('/api/user/current');
    originalDashboards = await read('/api/dashboard');
    const kuma = new Kuma256Session({ url: 'http://127.0.0.1:19082', username: 'fixture-kuma', password: 'Fixture-Kuma-Password-2026!' });
    try { await kuma.open(); originalMonitors = Object.keys(kuma.monitors).sort(); } finally { kuma.close(); }
    console.log('Owned recovery snapshot:', output);
  }, 330000);

  test('an isolated restore retains canonical sites, accounts, dashboards and Kuma secret storage without starting collectors', async () => {
    for (const args of [ ['docker', 'ps', '--all', '--quiet'], ['docker', 'volume', 'ls', '--quiet'] ]) {
      const existing = await run([...args, '--filter', `label=com.docker.compose.project=${restoreProject}`]);
      if (existing.status !== 0 || existing.stdout.trim()) throw new Error('Recovery test requires a new isolated target without retained storage');
    }
    restored = await mkdtemp(join(tmpdir(), 'hubos-restored-native-'));
    console.log('Owned restore fixture directory:', restored);
    for (const name of ['compose.yaml', 'compose', 'db', 'services']) {
      await cp(join(directory, name), join(restored, name), { recursive: true });
    }
    const result = await run([process.execPath, join(root, 'scripts/backup.js'), 'restore', '--backup', output,
      '--directory', restored, '--project', restoreProject, '--confirm-isolated'], 300000);
    if (result.status !== 0) throw new Error(`Restore command failed: ${result.stderr}`);
    expect(JSON.parse(await readFile(join(restored, '.hubos-restore.json'), 'utf8')).state).toBe('restored-not-started');
    const running = await run(['docker', 'ps', '--quiet', '--filter', `label=com.docker.compose.project=${restoreProject}`]);
    expect(running.stdout.trim()).toBe('');
    const configuration = await readFile(join(restored, '.env'), 'utf8');
    expect(configuration).toContain('HUBOS_NOTIFICATION_MODE=disabled');
    expect(await readFile(join(restored, '.hubos-credentials'), 'utf8')).toBe(await readFile(join(directory, '.hubos-credentials'), 'utf8'));
    // Only this isolated fixture receives alternate loopback ports before startup.
    await writeFile(join(restored, '.env'), configuration + '\nHUBOS_HTTP_PORT=19180\nMETABASE_PORT=19181\nKUMA_PORT=19182\nMAILPIT_WEB_PORT=19185\n', { mode: 0o600 });
    const start = await run(['docker', 'compose', '-p', restoreProject, ...files, 'up', '--detach', '--no-build', '--wait', '--wait-timeout', '180'], 240000, restored);
    if (start.status !== 0) throw new Error('Isolated restored fixture did not provision successfully');
    const response = await fetch('http://127.0.0.1:19180/api/v1/sites', { headers: { authorization: auth } });
    expect(response.status).toBe(200);
    expect((await response.json()).sites.map((site) => site.id)).toEqual(originalSites.map((site) => site.id));
    const login = await fetch('http://127.0.0.1:19181/api/session', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'installer-fixture@local.test', password: 'Fixture-Metabase-Password-2026!' }) });
    expect(login.status).toBe(200);
    const session = (await login.json()).id;
    const dashboards = await (await fetch('http://127.0.0.1:19181/api/dashboard', { headers: { 'x-metabase-session': session } })).json();
    const account = await (await fetch('http://127.0.0.1:19181/api/user/current', { headers: { 'x-metabase-session': session } })).json();
    expect(account.id).toBe(originalAccount.id);
    expect(dashboards.map((dashboard) => dashboard.id).sort()).toEqual(originalDashboards.map((dashboard) => dashboard.id).sort());
    expect(dashboards.map((dashboard) => dashboard.name)).toContain('Operator community overview');
    expect(dashboards).toHaveLength(4);
    const kuma = new Kuma256Session({ url: 'http://127.0.0.1:19182', username: 'fixture-kuma', password: 'Fixture-Kuma-Password-2026!' });
    try { await kuma.open(); expect(kuma.createdAdmin).toBe(false); expect(Object.values(kuma.monitors)).toHaveLength(2);
      expect(Object.keys(kuma.monitors).sort()).toEqual(originalMonitors); }
    finally { kuma.close(); }
    expect((await sites()).map((site) => site.id)).toEqual(originalSites.map((site) => site.id));
  }, 600000);

  test('a cancelled backup resumes the original deployment and never seals an incomplete snapshot', async () => {
    const expectedSites = await sites();
    const cancelled = join(await mkdtemp(join(tmpdir(), 'hubos-recovery-cancelled-')), 'snapshot');
    const child = Bun.spawn([process.execPath, join(root, 'scripts/backup.js'), 'create', '--directory', directory,
      '--output', cancelled, '--confirm-pause'], { cwd: directory, env: process.env, stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 300000);
    try {
      const deadline = performance.now() + 60000;
      let ready = false;
      while (performance.now() < deadline) {
        try { await stat(join(cancelled, 'configuration')); ready = true; break; }
        catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
      }
      if (!ready) throw new Error('Backup did not reach its cancellable maintenance stage');
      child.kill('SIGTERM');
      const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(status).not.toBe(0);
      expect(stderr).toContain('RECOVERY_INTERRUPTED');
      expect(stdout).not.toContain('Complete private backup');
      expect(await Bun.file(join(cancelled, 'manifest.json')).exists()).toBe(false);
      expect((await sites()).map((site) => site.id)).toEqual(expectedSites.map((site) => site.id));
      expect(await Bun.file(join(directory, '.hubos-recovery.lock/owner.json')).exists()).toBe(false);
    } finally { clearTimeout(timer); }
  }, 330000);
});
