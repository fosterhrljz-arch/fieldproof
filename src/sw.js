const cache = 'fieldproof-offline-' + self.registration.scope + 'BUILD_ID';
const scope = self.registration.scope;
const shell = new URL('index.html',scope).href;
self.addEventListener('install',event => {
  event.waitUntil(caches.open(cache).then(store=>store.addAll([shell,new URL('icon.svg',scope),new URL('manifest.webmanifest',scope)])));
});
self.addEventListener('activate',event => {
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('fieldproof-offline-'+scope) && key!==cache).map(key=>caches.delete(key))))
    .then(()=>self.clients.claim()));
});
self.addEventListener('fetch',event => {
  const request = event.request;
  if (request.method!=='GET' || !request.url.startsWith(scope)) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(()=>caches.open(cache).then(store=>store.match(shell))));
  } else if (['icon.svg','manifest.webmanifest'].some(path=>request.url===new URL(path,scope).href)) {
    event.respondWith(caches.open(cache).then(store=>store.match(request)).then(response=>response||fetch(request)));
  }
});
