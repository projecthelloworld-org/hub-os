import { createHash } from 'node:crypto';
import { CollectionError } from '../connector-runtime/http-client.js';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
export function definitionHash(value) { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }

export function resourceRegistry(db) {
  return {
    async get(kind, key) {
      return (await db`SELECT * FROM managed_tool_resources WHERE tool = 'metabase' AND kind = ${kind} AND resource_key = ${key}`)[0] ?? null;
    },
    async put(kind, key, id, provisioned = true, hash = null) {
      await db`INSERT INTO managed_tool_resources (tool, kind, resource_key, external_id, provisioned, definition_hash)
        VALUES ('metabase', ${kind}, ${key}, ${id}, ${provisioned}, ${hash})
        ON CONFLICT (tool, kind, resource_key) DO UPDATE SET provisioned = EXCLUDED.provisioned,
          definition_hash = coalesce(EXCLUDED.definition_hash, managed_tool_resources.definition_hash)`;
    },
  };
}

export async function ensureResource({ client, registry, kind, key, path, payload, provisioned = true, create = () => client(path, { method: 'POST', body: payload }) }) {
  const existing = await registry.get(kind, key);
  if (existing) {
    // User edits are deliberately preserved, not overwritten by repeat startup.
    const resource = await client(`${path}/${existing.external_id}`);
    return { resource, existing: true, provisioned: existing.provisioned, id: Number(existing.external_id) };
  }
  const resource = await create();
  if (!Number.isInteger(resource?.id)) throw new CollectionError('METABASE_RESOURCE_ID_MISSING');
  await registry.put(kind, key, resource.id, provisioned, definitionHash({ key, kind }));
  return { resource, existing: false, provisioned, id: resource.id };
}
