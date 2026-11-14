#!/usr/bin/env node
/**
 * Device-only gateway for testing on real glasses through a public tunnel.
 *
 * The dev API trusts `Bearer dev:<name>` (AUTH_MODE=dev), which must never be
 * reachable from the internet. This gateway forwards ONLY:
 *   - GET/HEAD /glasses/...           the glasses web app (API must run with WEB_ROOT)
 *   - POST /v1/devices/pair           pairing (code is the credential), rate-limited per IP
 *   - /v1/... with `Bearer j26d_...`  paired-device requests (the API enforces device scope)
 *   - GET /healthz
 * Everything else gets 404. Authoring stays local.
 *
 * usage: node scripts/glasses-gateway.mjs [listenPort=8095] [upstream=http://127.0.0.1:8080]
 *        then e.g. `cloudflared tunnel --url http://127.0.0.1:8095`
 */
import http from 'node:http';

const port = Number(process.argv[2] ?? 8095);
const upstream = new URL(process.argv[3] ?? 'http://127.0.0.1:8080');
const PAIR_LIMIT = 10; // attempts per IP per window
const WINDOW_MS = 10 * 60 * 1000;
const attempts = new Map();

function allowed(req) {
  const path = new URL(req.url, 'http://x').pathname;
  const auth = req.headers.authorization ?? '';
  if ((req.method === 'GET' || req.method === 'HEAD') && (path === '/glasses' || path.startsWith('/glasses/') || path === '/healthz')) return 'ok';
  if (req.method === 'POST' && path === '/v1/devices/pair') return 'pair';
  if (path.startsWith('/v1/') && /^Bearer j26d_[A-Za-z0-9_-]{20,}$/.test(auth)) return 'ok';
  return null;
}

function rateLimited(req) {
  const ip = String(req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress);
  const now = Date.now();
  const list = (attempts.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  attempts.set(ip, list);
  return list.length > PAIR_LIMIT;
}

http
  .createServer((req, res) => {
    const verdict = allowed(req);
    const log = (status) => console.log(JSON.stringify({ t: new Date().toISOString(), m: req.method, p: req.url.split('?')[0], status }));
    if (!verdict) {
      log(404);
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"code":"not_found","message":"Not available here"}}');
      return;
    }
    if (verdict === 'pair' && rateLimited(req)) {
      log(429);
      res.writeHead(429, { 'content-type': 'application/json' }).end('{"error":{"code":"rate_limited","message":"Too many attempts"}}');
      return;
    }
    const headers = { ...req.headers, host: upstream.host };
    const up = http.request({ host: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers }, (r) => {
      log(r.statusCode);
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => {
      log(502);
      if (!res.headersSent) res.writeHead(502).end();
    });
    req.pipe(up);
  })
  .listen(port, '127.0.0.1', () => console.log(`glasses gateway on 127.0.0.1:${port} -> ${upstream.origin}`));
