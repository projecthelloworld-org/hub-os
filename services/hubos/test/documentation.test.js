import { describe, expect, test } from 'bun:test';
import { resolve, dirname } from 'node:path';
import { stat } from 'node:fs/promises';

const root = resolve(import.meta.dir, '../../..');
const files = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CONTEXT.md', 'CHANGELOG.md', 'plugins/README.md', '.github/RELEASE_CHECKLIST.md'];
for (const pattern of ['docs/**/*.md', 'runbooks/**/*.md']) {
  for await (const file of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true })) files.push(file);
}
const documents = await Promise.all(files.map(async (file) => ({ file, content: await Bun.file(resolve(root, file)).text() })));

describe('Public project documentation', () => {
  test('relative links resolve after guide reorganisation', async () => {
    const missing = [];
    for (const { file, content } of documents) {
      for (const match of content.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
        const destination = match[1].replace(/^<|>$/g, '');
        if (/^[a-z][a-z0-9+.-]*:/i.test(destination) || destination.startsWith('#')) continue;
        const path = decodeURIComponent(destination.split('#')[0].split('?')[0]);
        try { await stat(resolve(dirname(resolve(root, file)), path)); }
        catch { missing.push(`${file}: ${path}`); }
      }
    }
    expect(missing).toEqual([]);
  });
  test('guides exclude machine-specific paths and implementation-session records', () => {
    const markers = /\/Users\/|codex\/community-monitoring|OrbStack|dep-odk-test|Research checked|Foundation checkpoint|Implementation in progress|not executed by|original Downloads|project conversation|actions\/runs\/\d+/i;
    expect(documents.filter(({ content }) => markers.test(content)).map(({ file }) => file)).toEqual([]);
    expect(documents.find(({ file }) => file === 'README.md').content).toContain('community');
  });
  test('release boundaries and private security reporting remain explicit', () => {
    const roadmap = documents.find(({ file }) => file === 'docs/Roadmap.md').content;
    expect(roadmap).toContain('v0.1.0 — released');
    expect(roadmap).toContain('v0.2.0');
    expect(roadmap).toContain('v0.3.0');
    expect(documents.find(({ file }) => file === 'SECURITY.md').content).toContain('mailto:data@projecthelloworld.org');
    expect(documents.find(({ file }) => file === 'docs/Metabase_Compatibility.md').content).toContain('GHSA-vwf4-m7j8-wcjf');
  });
  test('setup requirements and outage guidance do not imply unavailable integrations', () => {
    for (const file of ['docs/Installation.md', 'docs/Local_Development.md', 'docs/Connector_Plugins.md']) {
      expect(documents.find((document) => document.file === file).content).toContain('2.24.4 or later');
    }
    const runbook = documents.find(({ file }) => file === 'runbooks/connectivity-outage.md').content;
    expect(runbook).toContain('ISP imports are not part of v0.2.0');
    expect(runbook).toContain('where evidence is missing');
  });
});
