/* Increment VERSION whenever app shell files change. Documents live in IndexedDB. */
const VERSION = 'v2.1-scanner';
const SHELL_CACHE = 'gomaa-scan-shell-' + VERSION;
const LIBRARY_CACHE = 'gomaa-scan-libraries-' + VERSION;
const BASE = self.registration.scope;
const SHELL = [
  './', './index.html', './style.css', './app.js', './manifest.json',
  './scan-core.js', './scan-engine.js', './scan-worker.js',
  './icons/logo.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'
].map(path => new URL(path, BASE).href);
const RESOURCES = [
  'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.12.0-release.1/dist/opencv.js',
  'https://cdn.jsdelivr.net/npm/jspdf@4.2.1/dist/jspdf.umd.min.js',
  'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.min.js',
  'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/worker.min.js',
  ...['', '-simd', '-lstm', '-simd-lstm'].flatMap(variant => [
    `https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0/tesseract-core${variant}.wasm.js`,
    `https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0/tesseract-core${variant}.wasm`
  ]),
  'https://tessdata.projectnaptha.com/4.0.0/ara.traineddata.gz',
  'https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz',
  ...['arabic', 'latin'].flatMap(subset => [400,700].map(weight =>
    `https://cdn.jsdelivr.net/npm/@fontsource/cairo@5.3.0/files/cairo-${subset}-${weight}-normal.woff2`
  ))
];
const RESOURCE_SET = new Set(RESOURCES);
const SHELL_SET = new Set(SHELL);
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(SHELL);
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('gomaa-scan-shell-') && key !== SHELL_CACHE).map(key => caches.delete(key)));
    const current = await caches.open(LIBRARY_CACHE);
    // Keep fixed-version library data across shell upgrades, then remove old caches.
    for (const key of keys.filter(key => key.startsWith('gomaa-scan-libraries-') && key !== LIBRARY_CACHE)) {
      const old = await caches.open(key);
      for (const url of RESOURCES) {
        if (!await current.match(url)) { const response = await old.match(url); if (response) await current.put(url,response); }
      }
      await caches.delete(key);
    }
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (RESOURCE_SET.has(url.href)) {
    event.respondWith((async () => {
      const cache = await caches.open(LIBRARY_CACHE), cached = await cache.match(request.url);
      if (cached) return cached;
      // importScripts may request a CDN script in no-cors mode. Fetch explicitly
      // with CORS so the complete OpenCV response can be cached for offline scans.
      const response = await fetch(request.url,{mode:'cors',credentials:'omit'});
      if (response.ok && response.type !== 'opaque') { try { await cache.put(request.url,response.clone()); } catch {} }
      return response;
    })());
    return;
  }
  if (url.origin !== self.location.origin || !url.href.startsWith(BASE)) return;
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const controller = new AbortController(),timer = setTimeout(() => controller.abort(),4000);
        try { const response = await fetch(request,{signal:controller.signal}); if(response.ok)return response; }
        finally { clearTimeout(timer); }
      } catch {}
      return (await caches.open(SHELL_CACHE)).match(new URL('./index.html',BASE).href);
    })());
  } else if (SHELL_SET.has(url.href)) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      return await cache.match(url.href) || fetch(request);
    })());
  }
});
async function status() {
  const cache = await caches.open(LIBRARY_CACHE);let cached = 0;
  for (const url of RESOURCES) if (await cache.match(url)) cached++;
  return {ok:true,ready:cached===RESOURCES.length,cached,total:RESOURCES.length};
}
let preparation = null;
const progressPorts = new Set();
async function prepare() {
  const cache = await caches.open(LIBRARY_CACHE);let completed=0;
  for (const url of RESOURCES) {
    if (!await cache.match(url)) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(),90000);
      try {
        const response = await fetch(url,{mode:'cors',credentials:'omit',signal:controller.signal});
        if (!response.ok || response.type === 'opaque') throw new Error('download');
        // Read the whole response before caching so incomplete downloads cannot be reported ready.
        const body = await response.arrayBuffer();
        const headers=new Headers(response.headers);headers.delete('content-encoding');headers.delete('content-length');
        await cache.put(url,new Response(body,{status:response.status,statusText:response.statusText,headers}));
      } finally { clearTimeout(timer); }
    }
    completed++;for(const port of progressPorts)port.postMessage({type:'progress',completed,total:RESOURCES.length});
  }
  return status();
}
self.addEventListener('message', event => {
  const port = event.ports[0];if (!port) return;
  if (event.data?.type === 'STATUS') { event.waitUntil(status().then(result=>port.postMessage(result)).catch(()=>port.postMessage({ok:false,error:'swUnavailable'}))); }
  if (event.data?.type === 'PREPARE') {
    progressPorts.add(port);
    if (!preparation) preparation=prepare().finally(()=>{preparation=null;});
    event.waitUntil(preparation.then(result=>port.postMessage(result)).catch(error=>port.postMessage({ok:false,error:error.name==='QuotaExceededError'?'quota':'offlineNeedOnline'})).finally(()=>progressPorts.delete(port)));
  }
});
