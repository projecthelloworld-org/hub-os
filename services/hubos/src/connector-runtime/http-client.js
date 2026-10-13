export class CollectionError extends Error {
  constructor(code, { retryAfterSeconds = null } = {}) {
    super(code);
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function createHttpClient({ fetchImpl = fetch, timeoutMs = 15000, maximumBytes = 8 * 1024 * 1024, responseType = 'json' } = {}) {
  return async function requestJson(url, options = {}) {
    let parsed;
    try { parsed = new URL(url); }
    catch { throw new CollectionError('INVALID_SOURCE_URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
      throw new CollectionError('INVALID_SOURCE_URL');
    }
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(parsed, { ...options, redirect: 'error', signal });
      if (!response.ok) {
        if ([401, 403].includes(response.status)) throw new CollectionError('SOURCE_AUTHENTICATION_FAILED');
        if (response.status === 429) {
          const raw = response.headers.get('retry-after');
          const seconds = /^\d+$/.test(raw ?? '') ? Number(raw) : Math.ceil((Date.parse(raw) - Date.now()) / 1000);
          throw new CollectionError('SOURCE_RATE_LIMITED', {
            retryAfterSeconds: Number.isFinite(seconds) ? Math.min(86400, Math.max(1, seconds)) : 30,
          });
        }
        throw new CollectionError('SOURCE_HTTP_ERROR');
      }
      if ([204, 205].includes(response.status)) return null;
      const reader = response.body?.getReader();
      if (!reader) throw new CollectionError('SOURCE_MALFORMED_RESPONSE');
      let size = 0;
      const chunks = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maximumBytes) {
          await reader.cancel();
          throw new CollectionError('SOURCE_RESPONSE_TOO_LARGE');
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const body = new TextDecoder().decode(bytes);
      if (responseType === 'text') return body;
      try { return JSON.parse(body); }
      catch { throw new CollectionError('SOURCE_MALFORMED_RESPONSE'); }
    } catch (error) {
      if (error instanceof CollectionError) throw error;
      throw new CollectionError(controller.signal.aborted ? 'SOURCE_TIMEOUT'
        : signal.aborted ? 'COLLECTION_CANCELLED' : 'SOURCE_UNREACHABLE');
    } finally { clearTimeout(timeout); }
  };
}
