import { describe, expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dir, '../../..');
const dockerFixture = new URL('fixtures/installer-docker.js', import.meta.url).pathname;

async function installation(run) {
  const parent = await mkdtemp(join(tmpdir(), 'hubos-installer-contract-'));
  const directory = join(parent, 'installation');
  await mkdir(directory);
  try {
    for (const file of ['install.sh', '.env.example', 'compose.yaml', 'compose/mel.compose.yaml',
      'compose/monitoring.compose.yaml', 'compose/development.compose.yaml', 'compose/tls.compose.yaml']) {
      const target = join(directory, file);
      await mkdir(dirname(target), { recursive: true });
      await cp(join(root, file), target);
    }
    const bin = join(directory, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'docker'), `#!${process.execPath}\nimport ${JSON.stringify(dockerFixture)};\n`, { mode: 0o755 });
    await writeFile(join(bin, 'lsof'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await writeFile(join(bin, 'curl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    // Resource checks are a system boundary too: command-contract tests must
    // not depend on how much disk space the contributor's computer has left.
    await writeFile(join(bin, 'df'), '#!/bin/sh\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted\\nfixture 41943040 10485760 %s 25%% /fixture\\n" "${INSTALLER_FIXTURE_AVAILABLE_KB:-31457280}"\n', { mode: 0o755 });
    const execute = async (options = [], extraEnvironment = {}, start = false) => {
      const process = Bun.spawn(['bash', join(directory, 'install.sh'), '--non-interactive', '--yes', ...(start ? [] : ['--no-start']), ...options], {
        cwd: directory, env: { PATH: `${bin}:${globalThis.process.env.PATH}`, LC_ALL: 'C',
          METABASE_ADMIN_EMAIL: 'fixture@example.invalid', ...extraEnvironment }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      });
      const [stdout, stderr, status] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
      return { status, stdout, stderr };
    };
    await run({ directory, bin, execute, configuration: () => readFile(join(directory, '.env'), 'utf8') });
  } finally { await rm(parent, { recursive: true, force: true }); }
}

async function pipedRelease({ directory, bin }, { packageVersion = '0.2.0' } = {}) {
  const releaseParent = join(directory, 'fixture-release'), release = join(releaseParent, 'hubos-v0.2.0');
  await mkdir(release, { recursive: true });
  for (const file of ['compose.yaml', '.env.example', 'compose']) await cp(join(directory, file), join(release, file), { recursive: true });
  await mkdir(join(release, 'services/hubos'), { recursive: true });
  await writeFile(join(release, 'services/hubos/package.json'), JSON.stringify({ name: 'hubos-core', version: packageVersion }) + '\n');
  await writeFile(join(release, 'release-marker.txt'), 'fixture v0.2.0 package');
  const archive = join(directory, 'fixture-release.tar.gz');
  const tar = Bun.spawn(['tar', '-czf', archive, '-C', releaseParent, 'hubos-v0.2.0']);
  if (await tar.exited !== 0) throw new Error('Cannot build fictional release archive');
  const checksum = createHash('sha256').update(await readFile(archive)).digest('hex');
  await rm(releaseParent, { recursive: true });
  await rm(join(directory, 'compose/monitoring.compose.yaml'));
  const legacy = 'HUBOS_DEMO_MODE=false\nCOMPOSE_PROJECT_NAME=legacy-fixture\nPOSTGRES_PASSWORD=legacy-fixture-secret\n';
  await writeFile(join(directory, '.env'), legacy, { mode: 0o600 });
  await writeFile(join(directory, '.hubos-credentials'), 'fixture-private-credentials', { mode: 0o600 });
  await writeFile(join(directory, 'operator-notes.txt'), 'retain this operator file');
  await writeFile(join(bin, 'curl'), '#!/bin/bash\nwhile (($#)); do if [[ "$1" == --output ]]; then cp "$INSTALLER_FIXTURE_ARCHIVE" "$2"; exit; fi; shift; done\nexit 0\n', { mode: 0o755 });
  const script = (await readFile(join(directory, 'install.sh'), 'utf8')).replace(/^VERSION="[^"]+"/m, 'VERSION="0.2.0"');
  const run = async (options = [], env = {}) => {
    const child = Bun.spawn(['bash', '-s', '--', '--install-dir', directory, '--non-interactive', '--yes', '--no-start', ...options], {
      cwd: tmpdir(), env: { PATH: `${bin}:${process.env.PATH}`, LC_ALL: 'C',
        INSTALLER_FIXTURE_ARCHIVE: archive, HUBOS_RELEASE_URL: 'https://release.example.invalid/hubos-v0.2.0.tar.gz',
        HUBOS_RELEASE_SHA256: checksum, ...env }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    child.stdin.write(script); child.stdin.end();
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, status };
  };
  return { run, legacy, archive, checksum };
}

describe('Interactive installer command-line contract', () => {
  test('the piped release installer upgrades a legacy tree while preserving private configuration and operator files', async () => {
    await installation(async ({ directory, bin }) => {
      const { run, legacy } = await pipedRelease({ directory, bin });
      const { stdout, stderr, status } = await run();
      expect({ status, stderr }).toEqual({ status: 0, stderr: expect.any(String) });
      expect(await readFile(join(directory, 'release-marker.txt'), 'utf8')).toBe('fixture v0.2.0 package');
      expect((await readFile(join(directory, '.env'), 'utf8')).startsWith(legacy)).toBe(true);
      expect(await readFile(join(directory, '.hubos-credentials'), 'utf8')).toContain('fixture-private-credentials');
      expect(await readFile(join(directory, 'operator-notes.txt'), 'utf8')).toBe('retain this operator file');
      expect(stdout).toContain('services were not started');
      const backups = (await readdir(dirname(directory))).filter((name) => name.startsWith('installation.pre-upgrade-'));
      expect(backups).toHaveLength(1);
      expect(await readFile(join(dirname(directory), backups[0], '.env'), 'utf8')).toBe(legacy);
      const upgraded = await readFile(join(directory, '.env'), 'utf8');
      expect((await run()).status).toBe(0);
      expect(await readFile(join(directory, '.env'), 'utf8')).toBe(upgraded);
      expect((await readdir(dirname(directory))).filter((name) => name.startsWith('installation.pre-upgrade-'))).toHaveLength(1);
    });
  }, 30000);
  test('a checksum failure leaves the legacy source tree, credentials and operator files unchanged', async () => {
    await installation(async ({ directory, bin }) => {
      const { run, legacy } = await pipedRelease({ directory, bin });
      const before = await readFile(join(directory, 'compose.yaml'), 'utf8');
      const result = await run([], { HUBOS_RELEASE_SHA256: '0'.repeat(64) });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('checksum verification failed');
      expect(await readFile(join(directory, '.env'), 'utf8')).toBe(legacy);
      expect(await readFile(join(directory, '.hubos-credentials'), 'utf8')).toBe('fixture-private-credentials');
      expect(await readFile(join(directory, 'compose.yaml'), 'utf8')).toBe(before);
      expect(await Bun.file(join(directory, 'release-marker.txt')).exists()).toBe(false);
      expect(await readdir(dirname(directory))).toEqual(['installation']);
    });
  });
  test('a fresh piped installation uses the verified package and records its release identity', async () => {
    await installation(async ({ directory, bin }) => {
      const { run, checksum } = await pipedRelease({ directory, bin });
      const fresh = join(dirname(directory), 'fresh-installation');
      const result = await run(['--install-dir', fresh, '--mode', 'live']);
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: expect.any(String) });
      expect(await readFile(join(fresh, '.hubos-release'), 'utf8')).toBe(`version=0.2.0\nsha256=${checksum}\n`);
      expect(await readFile(join(fresh, 'release-marker.txt'), 'utf8')).toBe('fixture v0.2.0 package');
      expect((await stat(join(fresh, 'services/hubos/package.json'))).mode & 0o444).toBe(0o444);
      expect((await stat(join(fresh, 'services/hubos'))).mode & 0o111).toBe(0o111);
      expect(await readFile(join(fresh, '.env'), 'utf8')).toContain('HUBOS_DEMO_MODE=false');
      expect(await Bun.file(`${fresh}.install-lock/owner`).exists()).toBe(false);
    });
  }, 15000);
  test('a checksum-valid package with a different version cannot replace the installation', async () => {
    await installation(async ({ directory, bin }) => {
      const { run, legacy } = await pipedRelease({ directory, bin }, { packageVersion: '0.1.0' });
      const result = await run();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('version does not agree');
      expect(await readFile(join(directory, '.env'), 'utf8')).toBe(legacy);
      expect(await Bun.file(join(directory, 'release-marker.txt')).exists()).toBe(false);
    });
  });
  test('concurrent installation is refused without removing another installer lock', async () => {
    await installation(async ({ directory, bin }) => {
      const { run, legacy } = await pipedRelease({ directory, bin });
      const lock = `${directory}.install-lock`;
      await mkdir(lock);
      await writeFile(join(lock, 'owner'), 'fictional-active-installer');
      const result = await run();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Another installer');
      expect(await readFile(join(lock, 'owner'), 'utf8')).toBe('fictional-active-installer');
      expect(await readFile(join(directory, '.env'), 'utf8')).toBe(legacy);
    });
  });
  test('configuration-only upgrades cannot replace a running installation', async () => {
    await installation(async ({ directory, bin }) => {
      const { run, legacy } = await pipedRelease({ directory, bin });
      const result = await run([], { INSTALLER_FIXTURE_RUNNING_PROJECT: 'true' });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Stop this installation');
      expect(await readFile(join(directory, '.env'), 'utf8')).toBe(legacy);
      expect(await Bun.file(join(directory, 'release-marker.txt')).exists()).toBe(false);
    });
  });
  test('managed path links and Git checkouts cannot be overwritten by a release upgrade', async () => {
    for (const kind of ['link', 'checkout']) {
      await installation(async ({ directory, bin }) => {
        const { run, legacy } = await pipedRelease({ directory, bin });
        if (kind === 'checkout') await mkdir(join(directory, '.git'));
        else {
          const original = join(directory, 'compose');
          const linked = join(dirname(directory), 'operator-compose');
          await cp(original, linked, { recursive: true }); await rm(original, { recursive: true });
          await symlink(linked, original);
        }
        const result = await run();
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(kind === 'checkout' ? 'Git checkout' : 'symbolic link');
        expect(await readFile(join(directory, '.env'), 'utf8')).toBe(legacy);
        expect(await Bun.file(join(directory, 'release-marker.txt')).exists()).toBe(false);
      });
    }
  }, 20000);
  test('insufficient disk space is rejected before deployment credentials are written', async () => {
    await installation(async ({ directory, execute }) => {
      const result = await execute(['--mode', 'live'], { INSTALLER_FIXTURE_AVAILABLE_KB: '1024' });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('at least 5 GB free');
      expect(await Bun.file(join(directory, '.env')).exists()).toBe(false);
    });
  });
  test('a new live installation explicitly disables fictional data collection', async () => {
    await installation(async ({ execute, configuration }) => {
      const result = await execute(['--mode', 'live']);
      expect(result.status).toBe(0);
      expect(await configuration()).toContain('HUBOS_DEMO_MODE=false');
      expect(result.stdout).toContain('services were not started');
    });
  });
  test('a public binding without an HTTPS origin is refused before configuration is written', async () => {
    await installation(async ({ directory, execute }) => {
      const result = await execute(['--mode', 'live'], { HUBOS_BIND_ADDRESS: '0.0.0.0' });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('HTTPS');
      expect(await Bun.file(join(directory, '.env')).exists()).toBe(false);
    });
  });
  test('an unsupported Compose version is rejected before preparing deployment credentials', async () => {
    await installation(async ({ execute, directory }) => {
      const result = await execute(['--mode', 'live'], { INSTALLER_FIXTURE_COMPOSE_VERSION: '2.24.3' });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('2.24.4');
      expect(await Bun.file(join(directory, '.env')).exists()).toBe(false);
    });
  });
  test('HTTPS installation preserves its secure origin and rejects malformed or mismatched listeners', async () => {
    await installation(async ({ execute, configuration }) => {
      const result = await execute(['--mode', 'live'], { HUBOS_BIND_ADDRESS: '0.0.0.0',
        HUBOS_SITE_ADDRESS: 'https://monitoring.example.invalid:19443', HUBOS_HTTP_PORT: '19440', HUBOS_HTTPS_PORT: '19443' });
      expect(result.status).toBe(0);
      expect(await configuration()).toContain('HUBOS_SITE_ADDRESS="https://monitoring.example.invalid:19443"');
      expect(await configuration()).toContain('HUBOS_HTTPS_PORT=19443');
      expect(result.stdout).toContain('https://monitoring.example.invalid:19443');
    });
    for (const address of ['http://monitoring.example.invalid', 'https://person:password@monitoring.example.invalid',
      'https://monitoring.example.invalid/path', 'https://monitoring.example.invalid/', 'https://monitoring.example.invalid/?secret=value',
      'https://monitoring.example.invalid:19443']) {
      await installation(async ({ execute, directory }) => {
        const result = await execute(['--mode', 'live'], { HUBOS_BIND_ADDRESS: '0.0.0.0', HUBOS_SITE_ADDRESS: address, HUBOS_HTTPS_PORT: '443' });
        expect(result.status).not.toBe(0);
        expect(await Bun.file(join(directory, '.env')).exists()).toBe(false);
      });
    }
  }, 30000);
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
      expect(upgraded).toMatch(/^COMPOSE_PROJECT_NAME=['"]hubos['"]$/m);
      expect((await execute()).status).toBe(0);
      expect(await configuration()).toBe(upgraded);
      expect((await execute(['--mode', 'live'])).status).not.toBe(0);
      expect(await configuration()).toBe(upgraded);
    });
  });
  test('separate fresh installations get distinct persistent-data namespaces', async () => {
    let firstProject;
    await installation(async ({ execute, configuration }) => {
      expect((await execute(['--mode', 'demo'])).status).toBe(0);
      firstProject = (await configuration()).match(/^COMPOSE_PROJECT_NAME=['"]([a-z0-9_-]+)['"]$/m)?.[1];
      expect(firstProject).toMatch(/^hubos-[a-f0-9]{8}$/);
    });
    await installation(async ({ execute, configuration }) => {
      expect((await execute(['--mode', 'live'])).status).toBe(0);
      const secondProject = (await configuration()).match(/^COMPOSE_PROJECT_NAME=['"]([a-z0-9_-]+)['"]$/m)?.[1];
      expect(secondProject).toMatch(/^hubos-[a-f0-9]{8}$/);
      expect(secondProject).not.toBe(firstProject);
    });
  });
  test('a new installation cannot reuse a data namespace with containers or retained volumes', async () => {
    for (const state of ['container', 'volume']) {
      await installation(async ({ directory, execute }) => {
        const result = await execute(['--mode', 'live'], { COMPOSE_PROJECT_NAME: 'existing-community-fixture', INSTALLER_FIXTURE_PROJECT_EXISTS: state });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('existing data');
        expect(await Bun.file(join(directory, '.env')).exists()).toBe(false);
      });
    }
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
