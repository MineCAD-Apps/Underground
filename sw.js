const CACHE = 'visor-mina-v5';

const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './zones.json',
  './route-playback.js',
  './utility-layers.js',
  'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js',
  'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/lines/LineSegmentsGeometry.js',
  'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/lines/LineMaterial.js',
  'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/lines/LineSegments2.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(PRECACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Cache STL files and models.json with cache-first strategy
  if (url.pathname.endsWith('.stl') || url.pathname.endsWith('models.json') || url.pathname.endsWith('zones.json')) {
    event.respondWith(
      caches.open(CACHE).then(cache =>
        cache.match(event.request).then(cached => {
          if (cached) return cached;
          return fetch(event.request).then(response => {
            if (response.ok) cache.put(event.request, response.clone());
            return response;
          });
        })
      )
    );
    return;
  }

  // Network-first for everything else
  event.respondWith(
    fetch(event.request).catch(() =>
      caches.match(event.request)
    )
  );
});
