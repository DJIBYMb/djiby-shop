self.addEventListener("install", function(event){
  console.log("Service Worker installé");
});

self.addEventListener("fetch", function(event){
  event.respondWith(fetch(event.request));
});