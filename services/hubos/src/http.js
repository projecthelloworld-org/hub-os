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

export async function readJson(request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw Object.assign(new Error("Content-Type must be application/json"), { status: 415 });
  }
  try {
    return await request.json();
  } catch {
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
