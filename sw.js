// Service Worker: offline app-shell cache + streaming downloads.
//
// Streaming downloads (StreamSaver technique):
// The page registers a download via postMessage, then navigates a hidden
// iframe to /sw-download/<id>/<name>. We answer that fetch with a
// ReadableStream + Content-Disposition: attachment, so the browser shows a
// native download and streams chunks straight to disk — no in-memory Blob,
// no file-size limit.

const CACHE_NAME = 'local-file-share-v2';
const APP_ASSETS = [
    '/',
    '/index.html',
    '/style.css',
    '/script.js',
    '/manifest.json',
    '/qrcode.min.js',
    '/jsqr.js',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(APP_ASSETS))
            .catch(() => {}) // offline cache is best-effort
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)));
        await self.clients.claim();
    })());
});

// ── Streaming downloads ────────────────────────────────────────────────────

const downloads = new Map(); // id -> {name, size, port, controller, ackPending}

self.addEventListener('message', (event) => {
    const msg = event.data || {};

    if (msg.type === 'download-init') {
        const port = event.ports[0];
        if (!port) return;

        const entry = {
            name: msg.name || 'download',
            size: msg.size || 0,
            port,
            controller: null,
            ackPending: false,
        };
        downloads.set(msg.id, entry);
        port.onmessage = (ev) => handlePortMessage(msg.id, entry, ev.data || {});
        port.postMessage({
            type: 'ready',
            url: new URL(`sw-download/${msg.id}/${encodeURIComponent(entry.name)}`, self.registration.scope).href,
        });

        // Drop the entry if the browser never fetches it (download blocked/failed)
        setTimeout(() => {
            if (downloads.get(msg.id) === entry && !entry.controller) downloads.delete(msg.id);
        }, 30000);
    }
    // msg.type === 'keepalive' needs no handling — receiving it keeps the SW alive
});

function handlePortMessage(id, entry, msg) {
    const c = entry.controller;
    if (msg.type === 'chunk') {
        if (!c) return;
        try {
            c.enqueue(new Uint8Array(msg.data));
        } catch (e) {
            return; // stream already errored/canceled — 'canceled' was sent to the page
        }
        // Backpressure: only ack immediately if the stream wants more data;
        // otherwise wait for pull() so page → SW pacing follows disk speed.
        if (c.desiredSize !== null && c.desiredSize > 0) {
            entry.port.postMessage({ type: 'ack' });
        } else {
            entry.ackPending = true;
        }
    } else if (msg.type === 'end') {
        try { if (c) c.close(); } catch (e) {}
        downloads.delete(id);
    } else if (msg.type === 'abort') {
        try { if (c) c.error(new Error('Transfer aborted')); } catch (e) {}
        downloads.delete(id);
    }
}

function makeDownloadStream(id, entry) {
    return new ReadableStream({
        start(controller) {
            entry.controller = controller;
            entry.port.postMessage({ type: 'started' });
        },
        pull() {
            if (entry.ackPending) {
                entry.ackPending = false;
                entry.port.postMessage({ type: 'ack' });
            }
        },
        cancel() {
            // User canceled the download in the browser UI
            entry.port.postMessage({ type: 'canceled' });
            downloads.delete(id);
        },
    });
}

// ── Fetch handling ─────────────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    const dl = url.pathname.match(/\/sw-download\/([^/]+)\//);
    if (dl) {
        const entry = downloads.get(dl[1]);
        if (!entry) {
            event.respondWith(new Response('Download expired', { status: 410 }));
            return;
        }
        const headers = new Headers({
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(entry.name)}`,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
        });
        if (entry.size > 0) headers.set('Content-Length', String(entry.size));
        event.respondWith(new Response(makeDownloadStream(dl[1], entry), { headers }));
        return;
    }

    // App shell: network-first (avoid stale code), cache fallback for offline
    if (event.request.method !== 'GET') return;
    if (url.origin !== self.location.origin) return;
    if (url.pathname.startsWith('/api/')) return;

    event.respondWith(
        fetch(event.request)
            .then((resp) => {
                if (resp.ok) {
                    const copy = resp.clone();
                    caches.open(CACHE_NAME).then((c) => c.put(event.request, copy)).catch(() => {});
                }
                return resp;
            })
            .catch(() => caches.match(event.request, { ignoreSearch: true }))
    );
});
