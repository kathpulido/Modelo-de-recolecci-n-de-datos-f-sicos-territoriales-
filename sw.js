// sw.js — Service Worker para funcionamiento offline
const CACHE_NAME = 'rtc-v1'
const ASSETS = [
  '/formulario',
  '/manifest.json',
]

// Instalación: cachear archivos esenciales
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  )
  self.skipWaiting()
})

// Activación: limpiar caches viejos
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  )
  self.clients.claim()
})

// Fetch: cache-first para assets, network-first para API
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)

  // API de envío → siempre red, nunca cache
  if (url.pathname.includes('/v1/formulario-submit')) {
    return  // dejar que el browser maneje (fallará sin conexión, el JS lo captura)
  }

  // Formulario y assets → cache first, luego red
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached
      return fetch(event.request).then(res => {
        // Cachear respuestas exitosas del formulario
        if (res.ok && (url.pathname === '/formulario' || url.pathname === '/manifest.json')) {
          const clone = res.clone()
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone))
        }
        return res
      }).catch(() => {
        // Sin red y sin cache: respuesta de emergencia
        return new Response(
          '<h1>Sin conexión</h1><p>Abra primero el formulario con internet para guardarlo en caché.</p>',
          { headers: { 'Content-Type': 'text/html' } }
        )
      })
    })
  )
})
