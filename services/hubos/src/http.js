const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

export function json(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers: { ...jsonHeaders, ...headers } });
}

export function text(body, contentType, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": contentType, ...headers },
  });
}

export async function readJson(request, { allowEmpty = false } = {}) {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw Object.assign(new Error("Content-Type must be application/json"), { status: 415 });
  }
  const maxBytes = 1024 * 1024;
  const tooLarge = Object.assign(new Error('Request body exceeds the 1 MiB limit'), { status: 413 });
  if (Number(request.headers.get('content-length')) > maxBytes) throw tooLarge;
  try {
    const chunks = [], decoder = new TextDecoder('utf-8', { fatal: true });
    const reader = request.body?.getReader();
    let size = 0;
    if (reader) {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          void reader.cancel().catch(() => {});
          throw tooLarge;
        }
        chunks.push(decoder.decode(value, { stream: true }));
      }
    }
    chunks.push(decoder.decode());
    const body = chunks.join('');
    return allowEmpty && !body.trim() ? {} : JSON.parse(body);
  } catch (error) {
    if (error === tooLarge) throw error;
    throw Object.assign(new Error("Request body must contain valid JSON"), { status: 400 });
  }
}

export function requestHasKey(request, expectedKey, headerName) {
  const supplied = request.headers.get(headerName) ?? "";
  if (!supplied || !expectedKey || supplied.length !== expectedKey.length) return false;
  let mismatch = 0;
  for (let index = 0; index < supplied.length; index += 1) {
    mismatch |= supplied.charCodeAt(index) ^ expectedKey.charCodeAt(index);
  }
  return mismatch === 0;
}

export function noContent() {
  return new Response(null, { status: 204 });
}
