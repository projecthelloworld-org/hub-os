import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = new URL('../../../scripts/backup.js', import.meta.url).pathname;
const run = async (args) => {
  const child = Bun.spawn([process.execPath, script, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, status };
};
describe('Recovery command-line safety', () => {
  test('maintenance requires an explicit pause confirmation before deployment access', async () => {
    const result = await run(['create', '--directory', '/not-a-deployment', '--output', '/not-an-output']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('RECOVERY_REQUIRES_CONFIRM_PAUSE');
  });
  test('restoration requires an explicit isolated target confirmation before Docker access', async () => {
    const result = await run(['restore', '--backup', '/not-a-backup', '--directory', '/not-a-deployment', '--project', 'restore-example']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('RECOVERY_REQUIRES_CONFIRM_ISOLATED');
  });
  test('a changed artifact or escaping path is rejected by public integrity verification', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hubos-backup-invalid-'));
    try {
      await mkdir(join(directory, 'configuration'));
      await writeFile(join(directory, 'configuration/.env'), 'fixture-private-configuration');
      for (const path of ['configuration/.env', '../outside']) {
        await writeFile(join(directory, 'manifest.json'), JSON.stringify({ format: 'hubos-backup-v1', project: 'fixture',
          consistency: 'writers-paused', artifacts: [{ path, sha256: '0'.repeat(64) }] }));
        const result = await run(['verify', '--backup', directory]);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('RECOVERY_BACKUP_');
        expect(result.stdout + result.stderr).not.toContain('fixture-private-configuration');
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  test('a complete snapshot verifies, but an undeclared file or missing required artifact does not', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hubos-backup-valid-'));
    try {
      const paths = ['configuration/.env', 'database/core.dump', 'database/metabase.dump',
        'volumes/kuma-data.tar.gz', 'volumes/hubos-secrets.tar.gz', 'volumes/caddy-data.tar.gz', 'volumes/caddy-config.tar.gz'];
      const artifacts = [];
      for (const path of paths) {
        const contents = `public-fixture-${path}`;
        await mkdir(join(directory, path.split('/')[0]), { recursive: true });
        await writeFile(join(directory, path), contents);
        artifacts.push({ path, sha256: new Bun.CryptoHasher('sha256').update(contents).digest('hex') });
      }
      const manifest = { format: 'hubos-backup-v1', project: 'fixture', consistency: 'writers-paused', artifacts };
      await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
      expect((await run(['verify', '--backup', directory])).status).toBe(0);
      const sameProject = await run(['restore', '--backup', directory, '--directory', '/not-a-target', '--project', 'fixture', '--confirm-isolated']);
      expect(sameProject.stderr).toContain('RECOVERY_DISTINCT_TARGET_PROJECT_REQUIRED');
      await writeFile(join(directory, 'unlisted.txt'), 'not-in-manifest');
      expect((await run(['verify', '--backup', directory])).stderr).toContain('RECOVERY_BACKUP_UNDECLARED_ARTIFACT');
      await rm(join(directory, 'unlisted.txt'));
      manifest.artifacts = artifacts.slice(1);
      await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
      expect((await run(['verify', '--backup', directory])).stderr).toContain('RECOVERY_BACKUP_REQUIRED_ARTIFACT_MISSING');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
