// Versión de cache — incrementa este valor cuando actualices archivos
const CACHE_VERSION = 'v1.6';
const PRECACHE = `organizador-static-${CACHE_VERSION}`;
const RUNTIME = `organizador-runtime-${CACHE_VERSION}`;

// Assets que queremos guardar en install (ajusta nombres si los tienes en subcarpeta)
const PRECACHE_URLS = [
  './',
  './index.html',
  './style.app.css',
  './app.app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];
// Normaliza rutas de precache al scope del SW (soporta GitHub Pages subcarpetas)
const PRECACHE_PATHS = PRECACHE_URLS.map(u => new URL(u, self.registration.scope).pathname);

// Página fallback si estás offline y el recurso no está en cache
const OFFLINE_FALLBACK_HTML = `
  <!doctype html>
  <html><head><meta charset="utf-8"><title>Offline</title></head>
  <body>
    <h1>Sin conexión</h1>
    <p>Parece que estás sin conexión y la página solicitada no está en cache.</p>
  </body></html>
`;

/* ===== Instalación: precache ===== */
self.addEventListener('install', event => {
  // Instalación: guardar en cache los recursos esenciales
  event.waitUntil(
    caches.open(PRECACHE).then(cache => {
      const scopedRequests = PRECACHE_URLS.map(u => new Request(new URL(u, self.registration.scope), {cache: 'reload'}));
      return cache.addAll(scopedRequests);
    }).then(() => {
      // Activar inmediatamente la nueva versión
      return self.skipWaiting();
    })
  );
});

/* ===== Activación: limpieza de caches antiguos ===== */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(k => (k !== PRECACHE && k !== RUNTIME)).map(k => caches.delete(k))
      );
    }).then(() => {
      return self.clients.claim();
    })
  );
});

/* ===== Fetch: manejo de peticiones ===== */
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // No interceptamos requests a otros dominios (CDN/external)
  if (url.origin !== location.origin) {
    return; // dejar pasar (o podrías implementar cache para APIs específicos)
  }

  // Estrategia para documentos HTML (navegación) -> network-first, con fallback a cache o página offline
  if (req.mode === 'navigate' || (req.headers.get('accept') && req.headers.get('accept').includes('text/html'))) {
    event.respondWith((async () => {
      try {
        // Intentar primero la red
        const networkResponse = await fetch(req);
        // Actualizar cache runtime con la respuesta de red
        const cache = await caches.open(RUNTIME);
        cache.put(req, networkResponse.clone());
        return networkResponse;
      } catch (err) {
        // Si falla la red, intentar cache
        const cacheResp = await caches.match(req);
        if (cacheResp) return cacheResp;
        // Si tampoco hay, devolver fallback HTML
        return new Response(OFFLINE_FALLBACK_HTML, {headers: {'Content-Type':'text/html'}});
      }
    })());
    return;
  }

  // Para assets estáticos definidos en precache -> cache-first
  // Usa rutas absolutas normalizadas al scope
  if (PRECACHE_PATHS.includes(url.pathname) || url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(req).then(cached => {
        if (cached) return cached;
        return caches.open(RUNTIME).then(cache => {
          return fetch(req).then(resp => {
            // Guardar en runtime cache para futuras solicitudes
            if (resp && resp.status === 200) cache.put(req, resp.clone());
            return resp;
          }).catch(()=>{ return cached || new Response('',{status:404}); });
        });
      })
    );
    return;
  }

  // Para peticiones REST/JSON (por ejemplo export o fetch dinámicos) -> network-first con cache runtime
  if (req.headers.get('accept') && req.headers.get('accept').includes('application/json')) {
    event.respondWith((async () => {
      try {
        const r = await fetch(req);
        const cache = await caches.open(RUNTIME);
        cache.put(req, r.clone());
        return r;
      } catch (err) {
        const cached = await caches.match(req);
        if (cached) return cached;
        return new Response(JSON.stringify({error: 'offline'}), {headers: {'Content-Type':'application/json'}});
      }
    })());
    return;
  }

  // Default: intentar cache, si no ir a la red (cache-first fallback-to-network)
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(resp => {
        // guardar en runtime para recursos GET exitosos
        if (resp && resp.status === 200 && req.method === 'GET') {
          caches.open(RUNTIME).then(cache => cache.put(req, resp.clone()));
        }
        return resp;
      }).catch(()=> {
        // si falla y es un request para imagen, devolver un 1x1 transparente o data url simple
        if (req.destination === 'image') {
          return new Response(
            'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
            {headers: {'Content-Type':'image/gif'}}
          );
        }
        // fallback genérico
        return new Response(OFFLINE_FALLBACK_HTML, {headers: {'Content-Type':'text/html'}});
      });
    })
  );
});

/* ===== Comunicación desde la página (para forzar update) ===== */
self.addEventListener('message', (event) => {
  if (!event.data) return;
  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/* ===== Helper: limpiar caches antiguos si se pide ===== */
async function cleanOldCaches(keepPrefix) {
  const keys = await caches.keys();
  await Promise.all(keys.filter(k => !k.startsWith(keepPrefix)).map(k => caches.delete(k)));
}