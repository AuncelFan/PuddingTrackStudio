// Exercise the production build behind a reverse proxy which strips a nested
// mount prefix. Root requests fail, exposing accidentally absolute app URLs.
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';

const upstream = new URL(process.env.TRACE_URL || 'http://127.0.0.1:8000');
const prefix = '/tools/trace/';
const rootRequests = [];
const server = createServer((incoming, outgoing) => {
  if (incoming.url === prefix.slice(0, -1)) {
    outgoing.writeHead(308, { Location: prefix }); outgoing.end(); return;
  }
  if (!incoming.url.startsWith(prefix)) {
    rootRequests.push(incoming.url);
    outgoing.writeHead(404); outgoing.end('Outside application prefix'); return;
  }
  const target = new URL(incoming.url.slice(prefix.length), upstream.href.replace(/\/$/, '') + '/');
  const proxied = request(target, { method: incoming.method, headers: { ...incoming.headers, host: upstream.host } }, response => {
    outgoing.writeHead(response.statusCode, response.headers);
    response.pipe(outgoing);
  });
  proxied.on('error', error => { outgoing.writeHead(502); outgoing.end(error.message); });
  incoming.pipe(proxied);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}${prefix}`;
process.env.TRACE_URL = url.slice(0, -1);
process.env.TRACE_WEB_URL = url;
try {
  await import('./smoke.mjs');
  assert.deepEqual(rootRequests, [], 'Every resource must stay below the deployment prefix');
  console.log('Subpath: assets, API, tiles and download verified below /tools/trace/');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
