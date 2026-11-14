/* Offline shell for the glasses app. Never caches the API (/v1): packages and
   state live in IndexedDB, and sync must see fresh manifests.

   Install precaches the shell AND everything it references (hashed JS/CSS and
   files those stylesheets load, e.g. fonts). Runtime caching alone isn't
   enough: the first load fetches its assets before the worker controls the
   page, so they would never reach the cache and an offline launch would get
   HTML without code. */
const CACHE = 'j26-glasses-v2';
const SCOPE = self.registration.scope; // .../glasses/

async function precache() {
  const cache = await caches.open(CACHE);
  const shell = await fetch(SCOPE, { cache: 'no-store' });
  if (!shell.ok) throw new Error(`shell ${shell.status}`);
  const html = await shell.clone().text();
  const refs = new Set([`${SCOPE}icon.png`]);
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const u = new URL(m[1], SCOPE);
    if (u.origin === location.origin && u.href.startsWith(SCOPE)) refs.add(u.href);
  }
  // Stylesheets can pull in fonts and images.
  for (const href of [...refs].filter((u) => u.endsWith('.css'))) {
    const css = await fetch(href).then((r) => (r.ok ? r.text() : ''));
    for (const m of css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
      if (m[1].startsWith('data:')) continue;
      const u = new URL(m[1], href);
      if (u.origin === location.origin && u.href.startsWith(SCOPE)) refs.add(u.href);
    }
  }
  // Assets first, shell last: a cached shell always has its assets cached.
  await cache.addAll([...refs]);
  await cache.put(SCOPE, shell);
}

self.addEventListener('install', (e) => {
  e.waitUntil(precache().then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const put = (req, res) => {
  if (res.ok) {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(req, copy));
  }
  return res;
};

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/v1/') || !e.request.url.startsWith(SCOPE)) return;
  // Pages (any client route): cached shell immediately for a zero-network warm
  // launch; refresh shell and assets in the background for next time.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      caches.match(SCOPE).then((hit) => {
        if (hit) {
          // Picks up a new deploy (shell + its assets) for the next launch.
          e.waitUntil(precache().catch(() => {}));
          return hit;
        }
        return fetch(SCOPE).then((res) => put(SCOPE, res));
      }),
    );
    return;
  }
  // Hashed assets never change; everything else in scope: cache first, then network.
  e.respondWith(caches.match(e.request).then((hit) => hit ?? fetch(e.request).then((res) => put(e.request, res))));
});
