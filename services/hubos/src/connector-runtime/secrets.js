import { readFile } from 'node:fs/promises';

export async function resolveCredentials(refs = {}, { env = process.env, read = readFile } = {}) {
  if (!refs || typeof refs !== 'object' || Array.isArray(refs)) throw new Error('Credential references must be an object');
  const result = {};
  for (const [name, ref] of Object.entries(refs)) {
    if (!/^[a-z][a-zA-Z0-9_]{0,63}$/.test(name) || typeof ref !== 'string') throw new Error('Invalid credential reference');
    if (/^env:[A-Z][A-Z0-9_]*$/.test(ref)) result[name] = env[ref.slice(4)];
    else if (ref.startsWith('file:/') && !ref.includes('\0')) result[name] = (await read(ref.slice(5), 'utf8')).trim();
    else throw new Error('Credentials require an env:NAME or file:/absolute/path reference');
    if (typeof result[name] !== 'string' || !result[name]) {
      throw Object.assign(new Error('Required credential is unavailable'), { code: 'CREDENTIAL_UNAVAILABLE' });
    }
  }
  return Object.freeze(result);
}
