// public/sw.js — keeps the app shell available when the backend is down, so
// the installed app can open and offer to launch it. Network first: a running
// server always wins and refreshes the copy. /api/* is never touched.
const CACHE = 'deck-shell-v10';
const SHELL = ['/', '/app.js', '/events.js', '/classify.js', '/files.js', '/changes.js', '/activity.js', '/attach.js', '/pricing.js', '/narration.js', '/speech.js', '/procs.js', '/background.js', '/styles.css', '/manifest.webmanifest',
  '/vendor/highlight.min.js', '/vendor/github.min.css', '/vendor/github-dark.min.css',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  const key = req.mode === 'navigate' ? '/' : url.pathname;
  e.respondWith(fetch(req).then((res) => {
    if (res.ok && !res.redirected) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
    return res;
  }).catch(async () => (await caches.match(key)) || Response.error()));
});
