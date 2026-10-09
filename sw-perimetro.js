// sw-perimetro.js — Service Worker para croquis.html y recorrido.html
// Sigue el mismo patrón que sw.js (offline-form.html): cache-first para
// las páginas y librerías de mapas, siempre red para el envío de datos.
const CACHE_NAME   = 'perimetro-v1'
const CORE_ASSETS  = ['/croquis', '/recorrido']

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CORE_ASSETS))
  )
  self.skipWaiting()
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  )
  self.clients.claim()
})

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)

  // El envío/consulta del perímetro siempre va a la red — nunca se cachea
  // ni se sirve desde cache (el JS de la página maneja el caso sin red).
  if (url.pathname.startsWith('/api/perimetro')) return

  // Páginas propias + librerías externas (Leaflet, Leaflet.draw vía CDN):
  // cache-first, para que funcionen sin conexión tras la primera visita.
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached
      return fetch(event.request).then(res => {
        if (res.ok) {
          const clone = res.clone()
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone))
        }
        return res
      }).catch(() => {
        if (event.request.mode === 'navigate') {
          return new Response(
            '<h1>Sin conexión</h1><p>Abra primero esta página con internet activo para guardarla en el dispositivo.</p>',
            { headers: { 'Content-Type': 'text/html' } }
          )
        }
        return Response.error()
      })
    })
  )
})
