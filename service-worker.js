// service-worker.js
// アプリの見た目部分（HTML/アイコン/manifest）だけをキャッシュする。
// Supabase等への通信には一切関与しない（会話・写真データが古いキャッシュで
// 返されることを防ぐため、意図的にAPIリクエストはキャッシュ対象から除外）。

const CACHE_NAME = "ailove-shell-v8";
const SHELL_FILES = ["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const isShellFile =
    url.origin === self.location.origin &&
    SHELL_FILES.some((f) => url.pathname.endsWith(f.replace("./", "")) || f === "./");

  if (isShellFile) {
    event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
  }
  // シェルファイル以外(Supabase API呼び出し等)はそのまま素通りさせ、キャッシュしない
});

self.addEventListener('push', (event) => {
  let payload = { title: 'お知らせ', body: '新着があります', url: './' };
  try {
    if (event.data) payload = event.data.json();
  } catch (e) {}

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: './icon-192.png',
      badge: './icon-192.png',
      data: { url: payload.url || './' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || './';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(targetUrl) && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
