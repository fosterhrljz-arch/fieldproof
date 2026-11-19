const cacheName='fieldproof-team-69c39ae1d52515bd';
const shell=['/index.html','/app.js','/style.css','/icon.svg','/manifest.webmanifest','/fonts/NotoSansSC-Regular.ttf'];
self.addEventListener('install',event=>{
  event.waitUntil(caches.open(cacheName).then(cache=>cache.addAll(shell)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('fieldproof-team-')&&key!==cacheName).map(key=>caches.delete(key))))
    .then(()=>self.clients.claim()));
});
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if (url.origin!==self.location.origin||event.request.method!=='GET') return;
  const navigation=event.request.mode==='navigate'&&['/','/index.html'].includes(url.pathname);
  if (url.pathname==='/fonts/NotoSansSC-Regular.ttf') {
    event.respondWith(caches.open(cacheName).then(async cache=>(await cache.match(url.pathname))||fetch(event.request)));
    return;
  }
  if (navigation||shell.includes(url.pathname)) {
    event.respondWith(fetch(event.request).catch(()=>caches.open(cacheName).then(cache=>cache.match(navigation?'/index.html':url.pathname))));
  }
});
