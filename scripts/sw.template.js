// Generated at build time from scripts/sw.template.js. The placeholders are filled by vite.config.ts.
const VERSION = '__VERSION__';
const REQUIRED = __REQUIRED__;
const OPTIONAL = __OPTIONAL__;
const CACHE = `drawar-${VERSION}`;
const PAGE_TIMEOUT_MS = 3000;

// No skipWaiting: a new version waits until the old one is closed. Replacing it while a page
// runs would delete the files that page still asks for, leaving it blank.
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(REQUIRED)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
  // Large and only needed by some tools, so it is fetched in the background without blocking.
  caches.open(CACHE).then((cache) => cache.addAll(OPTIONAL)).catch(() => undefined);
});

// The page comes from the network when it can, so it never points at files of an old build.
// A dead tunnel answers with an error page or not at all, and then the saved copy is used.
function freshPage(request) {
  const timeout = new Promise((_, reject) => setTimeout(reject, PAGE_TIMEOUT_MS));
  return Promise.race([fetch(request), timeout])
    .then((response) => (response.ok ? response : Promise.reject()))
    .catch(() => caches.match('/'));
}

function savedFile(request) {
  // ignoreVary: files are stored by plain requests, but module scripts ask with an Origin header.
  return caches.match(request, { ignoreVary: true }).then(
    (hit) =>
      hit ??
      fetch(request).then((response) => {
        if (response.ok && OPTIONAL.includes(new URL(request.url).pathname)) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      }),
  );
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return;
  event.respondWith(request.mode === 'navigate' ? freshPage(request) : savedFile(request));
});
