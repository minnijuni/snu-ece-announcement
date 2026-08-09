const CACHE_NAME = 'ece-notices-v4';
// 공개 화면의 껍데기만 캐시한다. admin.html은 항상 네트워크에서 받아야 하므로 넣지 않는다.
const APP_SHELL = [
    '/',
    '/css/core.css',
    '/css/desktop.css',
    '/css/mobile.css',
    '/css/tutorial.css',
    '/js/config.js',
    '/js/core.js',
    '/js/desktop.js',
    '/js/mobile.js',
    '/js/tutorial.js'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(APP_SHELL))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return;
    // 알림 클릭('/?id=…')·공유 링크처럼 쿼리가 붙은 화면 이동도 오프라인이면 캐시된 셸로 연다.
    // 홈('/')으로 가는 이동에만 적용한다. admin.html·guide.html까지 셸로 대신하면
    // 주소와 내용이 어긋난 화면이 뜬다.
    if (event.request.mode === 'navigate') {
        if (url.pathname !== '/' && url.pathname !== '/index.html') return;
        event.respondWith(
            fetch(event.request)
                .then(response => {
                    if (response.ok && response.type === 'basic') {
                        const copy = response.clone();
                        event.waitUntil(
                            caches.open(CACHE_NAME).then(cache => cache.put('/', copy))
                        );
                    }
                    return response;
                })
                .catch(() => caches.match('/'))
        );
        return;
    }
    if (!APP_SHELL.includes(url.pathname)) return;
    event.respondWith(
        fetch(event.request)
            .then(response => {
                if (response.ok && response.type === 'basic') {
                    const copy = response.clone();
                    event.waitUntil(
                        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy))
                    );
                }
                return response;
            })
            .catch(() => caches.match(event.request))
    );
});

self.addEventListener('push', event => {
    let data = {};
    try {
        data = event.data?.json() || {};
    } catch {
        data = { body: event.data?.text() || '' };
    }
    event.waitUntil(self.registration.showNotification(data.title || 'SNU ECE 공지', {
        body: data.body || '새 공지가 등록되었습니다.',
        icon: '/icons/app-icon-192.png',
        badge: '/icons/badge-icon-96.png',
        tag: data.tag || undefined,
        data: { url: data.url || '/' }
    }));
});

self.addEventListener('notificationclick', event => {
    event.notification.close();
    const targetUrl = event.notification.data?.url || '/';
    // 이미 열린 창이 있으면 탭을 늘리지 않고 그 창을 앞으로 가져와 이동시킨다.
    // 단, 관리자 화면은 이동시키면 작성 중인 작업을 잃으므로 공개 화면 탭만 재사용한다.
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true })
            .then(clientList => {
                const client = clientList.find(item => {
                    try {
                        const clientPath = new URL(item.url).pathname;
                        return clientPath !== '/admin.html' && clientPath !== '/operator.html'
                            && clientPath !== '/admin-login.html';
                    } catch {
                        return false;
                    }
                });
                if (!client) return self.clients.openWindow(targetUrl);
                return client.focus()
                    .then(() => client.navigate(targetUrl))
                    .catch(() => self.clients.openWindow(targetUrl));
            })
            .catch(() => self.clients.openWindow(targetUrl))
    );
});
