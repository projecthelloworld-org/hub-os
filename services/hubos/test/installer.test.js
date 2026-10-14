import { describe, expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');
const dockerFixture = new URL('fixtures/installer-docker.js', import.meta.url).pathname;

async function installation(run) {
  const directory = await mkdtemp(join(tmpdir(), 'hubos-installer-contract-'));
  try {
    for (const file of ['install.sh', '.env.example', 'compose.yaml', 'compose/mel.compose.yaml',
      'compose/monitoring.compose.yaml', 'compose/development.compose.yaml']) {
      const target = join(directory, file);
      await mkdir(dirname(target), { recursive: true });
      await cp(join(root, file), target);
    }
    const bin = join(directory, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'docker'), `#!${process.execPath}\nimport ${JSON.stringify(dockerFixture)};\n`, { mode: 0o755 });
    await writeFile(join(bin, 'lsof'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await writeFile(join(bin, 'curl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const execute = async (options = [], extraEnvironment = {}, start = false) => {
      const process = Bun.spawn(['bash', join(directory, 'install.sh'), '--non-interactive', '--yes', ...(start ? [] : ['--no-start']), ...options], {
        cwd: directory, env: { PATH: `${bin}:${globalThis.process.env.PATH}`, LC_ALL: 'C',
          METABASE_ADMIN_EMAIL: 'fixture@example.invalid', ...extraEnvironment }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      });
      const [stdout, stderr, status] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
      return { status, stdout, stderr };
    };
    await run({ directory, execute, configuration: () => readFile(join(directory, '.env'), 'utf8') });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

describe('Interactive installer command-line contract', () => {
  test('a new live installation explicitly disables fictional data collection', async () => {
    await installation(async ({ execute, configuration }) => {
      const result = await execute(['--mode', 'live']);
      expect(result.status).toBe(0);
      expect(await configuration()).toContain('HUBOS_DEMO_MODE=false');
      expect(result.stdout).toContain('services were not started');
    });
  });
  test('new deployments get operator authentication and independent monitoring secrets without printing passwords', async () => {
    await installation(async ({ execute, configuration, directory }) => {
      const password = 'fixture-operator-password';
      const result = await execute(['--mode', 'demo'], { HUBOS_OPERATOR_PASSWORD: password,
        KUMA_ADMIN_PASSWORD: 'fixture-kuma-password', METABASE_ADMIN_PASSWORD: 'fixture-metabase-password' });
      expect(result.status).toBe(0);
      const settings = await configuration();
      expect(settings).toMatch(/^HUBOS_OPERATOR_USERNAME=/m);
      expect(settings).toMatch(/^HUBOS_OPERATOR_PASSWORD_HASH=['"]\$2[aby]\$/m);
      expect(settings).toMatch(/^KUMA_ADMIN_PASSWORD=/m);
      expect(settings).toMatch(/^KUMA_WEBHOOK_KEY=/m);
      expect(settings).toMatch(/^METABASE_WEBHOOK_KEY=/m);
      expect(settings).toMatch(/^METABASE_HUBOS_DB_PASSWORD=/m);
      expect(settings).toMatch(/^METABASE_HUBOS_SCHEMAS=analytics$/m);
      for (const secret of [password, 'fixture-kuma-password', 'fixture-metabase-password']) {
        expect(result.stdout + result.stderr).not.toContain(secret);
      }
      expect(settings).not.toContain(password);
      const { stat } = await import('node:fs/promises');
      expect((await stat(join(directory, '.env'))).mode & 0o777).toBe(0o600);
    });
  });
  test('unsafe secret input and reused machine credentials are rejected before configuration is written', async () => {
    for (const input of [
      { POSTGRES_PASSWORD: 'bad\nconfiguration' }, { METABASE_DB_PASSWORD: 'bad\nconfiguration' },
      { KUMA_WEBHOOK_KEY: 'bad\nconfiguration' },
      { HUBOS_ADMIN_KEY: 'fixture-identical-key-01234567890123456789', HUBOS_INGEST_KEY: 'fixture-identical-key-01234567890123456789' },
    ]) {
      await installation(async ({ directory, execute }) => {
        const result = await execute(['--mode', 'live'], input);
        expect(result.status).not.toBe(0);
        expect(await Bun.file(join(directory, '.env')).exists()).toBe(false);
        expect(result.stdout + result.stderr).not.toContain('bad\nconfiguration');
      });
    }
  }, 30000);
  test('a credential-file symbolic link cannot redirect newly generated secrets into another file', async () => {
    await installation(async ({ directory, execute }) => {
      const target = join(directory, 'unrelated-file');
      await writeFile(target, 'must remain unchanged');
      await symlink(target, join(directory, '.hubos-credentials'));
      expect((await execute(['--mode', 'live'])).status).not.toBe(0);
      expect(await readFile(target, 'utf8')).toBe('must remain unchanged');
    });
  });
  test('upgrades retain existing credentials and mode, add missing monitoring settings once and preserve repeated setup', async () => {
    await installation(async ({ directory, execute, configuration }) => {
      const legacy = `HUBOS_DEMO_MODE=true\nPOSTGRES_PASSWORD='legacy-database-secret'\nHUBOS_DATABASE_URL='postgresql://hubos:legacy-database-secret@db:5432/hubos'\nMETABASE_ADMIN_EMAIL='legacy@example.invalid'\nMETABASE_ADMIN_PASSWORD='legacy-metabase-secret'\nMETABASE_ENCRYPTION_SECRET_KEY='legacy-encryption-key=='\n`;
      await writeFile(join(directory, '.env'), legacy, { mode: 0o600 });
      const result = await execute([], { POSTGRES_PASSWORD: 'do-not-replace-existing-credentials' });
      expect(result.status).toBe(0);
      const upgraded = await configuration();
      expect(upgraded.startsWith(legacy)).toBe(true);
      expect(upgraded).not.toContain('do-not-replace-existing-credentials');
      expect(upgraded).toMatch(/^HUBOS_OPERATOR_PASSWORD_HASH=['"]\$2[aby]\$/m);
      expect(upgraded).toMatch(/^KUMA_ADMIN_PASSWORD=/m);
      expect(upgraded).toMatch(/^METABASE_HUBOS_DB_PASSWORD=/m);
      expect((await execute()).status).toBe(0);
      expect(await configuration()).toBe(upgraded);
      expect((await execute(['--mode', 'live'])).status).not.toBe(0);
      expect(await configuration()).toBe(upgraded);
    });
  });
  test('healthy applications do not mask a failed provisioning task', async () => {
    await installation(async ({ execute }) => {
      const result = await execute(['--mode', 'live'], { INSTALLER_FIXTURE_BOOTSTRAP_STATE: 'failed' }, true);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('metabase-bootstrap');
      expect(result.stdout).not.toContain('HubOS is configured.');
    });
  });
  test('installation reports completion only after all required provisioning tasks succeed', async () => {
    await installation(async ({ execute }) => {
      const result = await execute(['--mode', 'demo'], {}, true);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Application health and provisioning completed.');
      expect(result.stdout).toContain('HubOS is configured.');
    });
  });
  test.skipIf(!process.env.HUBOS_TEST_INSTALLER_CONFIG)('prepared live configuration renders a non-synthetic stack with authenticated provisioning', async () => {
    await installation(async ({ directory, execute }) => {
      expect((await execute(['--mode', 'live'])).status).toBe(0);
      const child = Bun.spawn(['docker', 'compose', '-f', 'compose.yaml', '-f', 'compose/mel.compose.yaml',
        '-f', 'compose/monitoring.compose.yaml', 'config', '--format', 'json'], {
        cwd: directory, env: process.env, stdout: 'pipe', stderr: 'pipe',
      });
      const [output, error, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (status !== 0) throw new Error(`Compose configuration failed: ${error}`);
      const deployment = JSON.parse(output).services;
      expect(deployment).not.toHaveProperty('seed');
      expect(deployment.api.environment.HUBOS_DEMO_MODE).toBe('false');
      expect(deployment.api.environment.HUBOS_ENV).toBe('production');
      const bootstrap = deployment['metabase-bootstrap'].environment;
      expect(bootstrap.HUBOS_ADMIN_KEY?.length ?? 0).toBeGreaterThanOrEqual(32);
      expect(bootstrap.HUBOS_INGEST_KEY?.length ?? 0).toBeGreaterThanOrEqual(32);
      expect(bootstrap.HUBOS_ADMIN_KEY).toBe(deployment.api.environment.HUBOS_ADMIN_KEY);
      expect(bootstrap.HUBOS_INGEST_KEY).toBe(deployment.api.environment.HUBOS_INGEST_KEY);
      expect(deployment['kuma-bootstrap'].environment.HUBOS_DEMO_MODE).toBe('false');
    });
  });
  test.skipIf(!process.env.HUBOS_TEST_INSTALLER_CONFIG)('prepared configuration preserves special database password characters and encodes its connection URL', async () => {
    await installation(async ({ directory, execute }) => {
      const password = 'fixture-db:p@ss/with#%+$dollars';
      expect((await execute(['--mode', 'live'], { POSTGRES_PASSWORD: password })).status).toBe(0);
      const child = Bun.spawn(['docker', 'compose', '-f', 'compose.yaml', '-f', 'compose/mel.compose.yaml',
        '-f', 'compose/monitoring.compose.yaml', 'config', '--environment'], {
        cwd: directory, env: { PATH: process.env.PATH }, stdout: 'pipe', stderr: 'pipe',
      });
      const [output, error, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (status !== 0) throw new Error(`Compose configuration failed: ${error}`);
      const environment = Object.fromEntries(output.trim().split('\n').map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1)];
      }));
      expect(environment.POSTGRES_PASSWORD).toBe(password);
      const url = new URL(environment.HUBOS_DATABASE_URL);
      expect(url.hostname).toBe('db');
      expect(decodeURIComponent(url.password)).toBe(password);
    });
  });
});
