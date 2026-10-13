let status = 200;
Bun.serve({
  hostname: '0.0.0.0', port: 3900,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method === 'POST' && path === '/__test/state' && request.headers.get('x-fixture-key') === 'fixture-only') {
      const body = await request.json();
      if (![200, 503].includes(body.status)) return new Response('Invalid fixture state', { status: 400 });
      status = body.status;
      return Response.json({ status });
    }
    return Response.json({ synthetic: true, status }, { status: path === '/controlled' ? status : 200 });
  },
});
