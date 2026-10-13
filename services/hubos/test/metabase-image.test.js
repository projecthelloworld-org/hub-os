import { expect, test } from 'bun:test';

test('deployable Metabase matches the pinned compatibility baseline and retained encryption configuration', async () => {
  const deployment = await Bun.file(new URL('../../../compose/mel.compose.yaml', import.meta.url)).text();
  const fixture = await Bun.file(new URL('../../../compose/metabase-test.compose.yaml', import.meta.url)).text();
  const image = (source) => source.match(/\n  metabase:\n    image: (.+)\n/)?.[1];
  expect(image(deployment)).toBe(image(fixture));
  expect(image(deployment)).toMatch(/^metabase\/metabase:v0\.64\.1\.7@sha256:[a-f0-9]{64}$/);
  expect(deployment).toContain('MB_HTTP_CHANNEL_ALLOWED_NETWORKS: allow-private');
  expect(deployment).not.toContain('MB_HTTP_CHANNEL_HOST_STRATEGY:');
  // A dependency upgrade must not change the configured decryption key.
  expect(deployment).toContain('MB_ENCRYPTION_SECRET_KEY: ${METABASE_ENCRYPTION_SECRET_KEY:-aHViT3MtbG9jYWwtb25seS1lbmNyeXB0aW9uLWtleQ==}');
});
