// service-worker.js
// アプリの見た目部分（HTML/アイコン/manifest）だけをキャッシュする。
// Supabase等への通信には一切関与しない（会話・写真データが古いキャッシュで
// 返されることを防ぐため、意図的にAPIリクエストはキャッシュ対象から除外）。

const CACHE_NAME = "ailove-shell-v7";
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
