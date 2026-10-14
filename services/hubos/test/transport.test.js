import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');
const native = process.env.HUBOS_TEST_INSTALLER_CONFIG ? describe : describe.skip;
native('Deployment transport and private tool bindings', () => {
  test('a remote operator binding does not publish tool administration over plaintext HTTP', async () => {
    const child = Bun.spawn(['docker', 'compose', '-f', 'compose.yaml', '-f', 'compose/mel.compose.yaml',
      '-f', 'compose/monitoring.compose.yaml', '-f', 'compose/development.compose.yaml', 'config', '--format', 'json'], {
      cwd: root, env: { PATH: process.env.PATH, HUBOS_BIND_ADDRESS: '0.0.0.0', HUBOS_SITE_ADDRESS: 'https://monitoring.example.invalid' },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [output, status] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(status).toBe(0);
    const services = JSON.parse(output).services;
    for (const name of ['metabase', 'kuma', 'mailpit']) {
      expect(services[name].ports.every((port) => port.host_ip === '127.0.0.1')).toBe(true);
    }
    expect(services.api).not.toHaveProperty('ports');
    expect(services.db).not.toHaveProperty('ports');
    expect(services['metabase-db']).not.toHaveProperty('ports');
  });
  test('the TLS layer replaces plaintext-only publication with explicit HTTP redirect and HTTPS listeners', async () => {
    const child = Bun.spawn(['docker', 'compose', '-f', 'compose.yaml', '-f', 'compose/mel.compose.yaml',
      '-f', 'compose/monitoring.compose.yaml', '-f', 'compose/tls.compose.yaml', 'config', '--format', 'json'], {
      cwd: root, env: { PATH: process.env.PATH, HUBOS_BIND_ADDRESS: '0.0.0.0',
        HUBOS_SITE_ADDRESS: 'https://monitoring.example.invalid:19443', HUBOS_HTTP_PORT: '19440', HUBOS_HTTPS_PORT: '19443' },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [output, status] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(status).toBe(0);
    const services = JSON.parse(output).services;
    expect(services.caddy.ports.map((port) => [port.published, port.target]).sort()).toEqual([['19440', 80], ['19443', 19443]]);
    expect(services.caddy.ports.every((port) => port.host_ip === '0.0.0.0')).toBe(true);
    expect(services.metabase.ports[0].host_ip).toBe('127.0.0.1');
  });
  test.skipIf(!process.env.HUBOS_TEST_ECOSYSTEM_CONFIG)('optional source applications also default to private host bindings', async () => {
    const child = Bun.spawn(['docker', 'compose', '--env-file', '/dev/null', '-f', 'compose.yaml', '-f', 'compose/mel.compose.yaml',
      '-f', 'compose/monitoring.compose.yaml', '-f', 'compose/ecosystem.compose.yaml', 'config', '--format', 'json'], {
      cwd: root, env: { PATH: process.env.PATH }, stdout: 'pipe', stderr: 'pipe',
    });
    const [output, status] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(status).toBe(0);
    const services = JSON.parse(output).services;
    for (const name of ['hmdm', 'nginx']) expect(services[name].ports.every((port) => port.host_ip === '127.0.0.1')).toBe(true);
  });
});
