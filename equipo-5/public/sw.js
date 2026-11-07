/**
 * Service Worker PWA para Ellie Life Enterprise — Android & Web
 * Soporta:
 * - Instalación PWA standalone en Android
 * - Modo Offline con caché de recursos y croquis
 * - Notificaciones Push del sistema (Web Push / Supabase Broadcast)
 * - Manejo de clics en notificaciones
 */

const CACHE_NAME = 'ellie-piura-v4';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.svg',
  '/favicon.ico',
  '/assets/apple-touch-icon.png',
  '/assets/croquis-piura.png',
  '/assets/logo.png',
  '/assets/icon-192.png',
  '/assets/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE).catch(() => {});
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(event.request).then((networkResponse) => {
        if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
          return networkResponse;
        }
        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });
        return networkResponse;
      }).catch(() => {
        return caches.match('/index.html');
      });
    })
  );
});

// ====================================================
// EVENTO PUSH: Notificaciones Push de Supabase / Backend
// ====================================================
self.addEventListener('push', (event) => {
  let data = {
    title: 'Ellie Life — Alerta Comunitaria Piura',
    body: 'Aviso preventivo en revisión. Consulta fuentes oficiales y el croquis seguro.',
    icon: '/assets/icon-192.png',
    badge: '/assets/icon-192.png',
    tag: 'ellie-alert',
    data: { url: '/#notificaciones' }
  };

  if (event.data) {
    try {
      const parsed = event.data.json();
      data.title = parsed.title || data.title;
      data.body = parsed.body || data.body;
      if (parsed.tag) data.tag = parsed.tag;
      if (parsed.url) data.data.url = parsed.url;
    } catch (_) {
      data.body = event.data.text() || data.body;
    }
  }

  const options = {
    body: data.body,
    icon: data.icon,
    badge: data.badge,
    vibrate: [200, 100, 200],
    tag: data.tag,
    renotify: true,
    requireInteraction: true,
    data: data.data,
    actions: [
      { action: 'open_croquis', title: 'Ver Croquis 🗺️' },
      { action: 'close', title: 'Cerrar' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// ====================================================
// EVENTO NOTIFICATION CLICK: Interacción del usuario
// ====================================================
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'close') return;

  const targetUrl = event.action === 'open_croquis' ? '/#croquis' : (event.notification.data?.url || '/');

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
