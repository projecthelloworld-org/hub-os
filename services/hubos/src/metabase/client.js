import { CollectionError, createHttpClient } from '../connector-runtime/http-client.js';

export function createMetabaseClient({ url, sessionId, fetchImpl = fetch }) {
  const request = createHttpClient({ fetchImpl: (uri, options) => fetchImpl(String(uri), options), timeoutMs: 60000, maximumBytes: 16 * 1024 * 1024 });
  return async (path, { method = 'GET', body } = {}) => {
    try {
      return await request(`${url}${path}`, { method, headers: {
        accept: 'application/json', 'content-type': 'application/json', 'x-metabase-session': sessionId,
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch (error) {
      throw new CollectionError(error.code ?? 'METABASE_REQUEST_FAILED');
    }
  };
}
