import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { CAPABILITIES, LIMITATIONS } from '@junction26/applet-format';
import { parseModelSpec, type ModelRegistry } from '@junction26/model';
import type { AppEnv, Deps } from '../context.ts';

/** Model picker and capability catalog for authoring clients (ours or bring-your-own). */
export function authoringMetaRoutes(deps: Deps, models: ModelRegistry) {
  const app = new Hono<AppEnv>();
  app.get('/models', (c) =>
    c.json({
      default: deps.config.model.model,
      models: deps.config.model.allowed.map((spec) => ({ id: spec, ...describeModel(spec, models), default: spec === deps.config.model.model })),
    }),
  );
  app.get('/capabilities', (c) => c.json({ capabilities: CAPABILITIES, limitations: LIMITATIONS }));
  return app;
}

export function describeModel(spec: string, models: ModelRegistry) {
  const s = parseModelSpec(spec);
  let available = false;
  let capabilities;
  try { const resolved = models.resolve(spec); available = resolved.provider.configured !== false; capabilities = resolved.provider.capabilities(resolved.spec.model); } catch { /* unknown provider */ }
  const status = { available, capabilities, unavailableReason: available ? null : 'Provider is not configured on this server' };
  if (s.provider === 'fake') return { ...status, label: 'Demo (canned examples, free)', provider: 'fake', free: true };
  const name = s.model.split('/').at(-1)!.replace(/[-_]/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()).replace(/\bGpt\b/g, 'GPT');
  const via = s.provider === 'openrouter' ? 'OpenRouter' : s.provider === 'openai' ? 'OpenAI-compatible' : s.provider;
  return { ...status, label: `${name} (${via})`, provider: s.provider, free: false };
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Serves the built web apps from one origin with the API: /glasses/ and
 * /author/. Unknown paths fall back to the app's index.html (client routing).
 * Hashed build assets are immutable; HTML and the service worker are not cached.
 */
export function webRoutes(webRoot: string) {
  const app = new Hono<AppEnv>();
  for (const name of ['glasses', 'author'] as const) {
    const root = normalize(join(webRoot, name));
    app.get(`/${name}`, (c) => c.redirect(`/${name}/`, 301));
    app.get(`/${name}/*`, async (c) => {
      const rel = decodeURIComponent(c.req.path.slice(name.length + 2)) || 'index.html';
      let file = normalize(join(root, rel));
      if (!file.startsWith(root + sep) && file !== root) return c.notFound();
      let info = await stat(file).catch(() => null);
      if (!info?.isFile()) {
        // Missing asset files are real 404s; everything else is a client route.
        if (/\.[a-z0-9]+$/i.test(rel) && !rel.endsWith('.html')) return c.notFound();
        file = join(root, rel.endsWith('.html') ? rel : 'index.html');
        info = await stat(file).catch(() => null);
        if (!info?.isFile()) return c.notFound();
      }
      const ext = extname(file);
      const immutable = rel.startsWith('assets/');
      return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
        headers: {
          'content-type': TYPES[ext] ?? 'application/octet-stream',
          'content-length': String(info.size),
          'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
          'x-content-type-options': 'nosniff',
        },
      });
    });
  }
  app.get('/', (c) => c.redirect('/author/', 302));
  return app;
}
