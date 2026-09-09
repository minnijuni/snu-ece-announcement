import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile('js/core.js', 'utf8');
const helpers = source.slice(
    source.indexOf('const noticeImageRequests ='),
    source.indexOf('function updateDetailImage()')
);

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function setup() {
    const nodes = new Map();
    const candidates = [];
    const timers = new Map();
    let timerId = 0;
    function node(id) {
        if (!nodes.has(id)) {
            nodes.set(id, {
                dataset: {}, style: {}, hidden: false,
                children: new Map(),
                setAttribute(name, value) { this[name] = value; },
                removeAttribute(name) { delete this[name]; },
                querySelector(selector) {
                    if (!this.children.has(selector)) this.children.set(selector, {});
                    return this.children.get(selector);
                }
            });
        }
        return nodes.get(id);
    }
    function image(id) {
        return {
            id, src: 'previous.jpg', naturalWidth: 800,
            removeAttribute(name) { delete this[name]; },
            cloneNode() {
                const clone = image(id);
                candidates.push(clone);
                return clone;
            },
            replaceWith(next) { nodes.set(id, next); },
            decode() { return Promise.resolve(); }
        };
    }
    nodes.set('detail-hero-img', image('detail-hero-img'));
    nodes.set('viewer-img', image('viewer-img'));
    const context = {
        document: { getElementById: node },
        window: {
            setTimeout(callback, delay) {
                const id = ++timerId;
                timers.set(id, { callback, delay });
                return id;
            },
            clearTimeout(id) { timers.delete(id); }
        }
    };
    runInNewContext(`${helpers}
        globalThis.load = loadNoticeImage;
        globalThis.reset = resetNoticeImage;
    `, context);
    return { ...context, node, candidates, timers };
}

for (const scope of ['detail', 'viewer']) {
    const imageId = scope === 'detail' ? 'detail-hero-img' : 'viewer-img';
    const stageId = scope === 'detail' ? 'detail-hero' : 'viewer-image-stage';

    test(`${scope}: clears old image immediately and waits for decoding`, async () => {
        const h = setup();
        h.load(scope, 'next.jpg');
        assert.equal(h.node(imageId).src, undefined);
        assert.equal(h.node(stageId).dataset.imageState, 'loading');
        assert.equal(h.node(stageId)['aria-busy'], 'true');
        assert.equal(h.node(`${scope}-image-status`).hidden, false);
        const candidate = h.candidates.at(-1);
        const decode = deferred();
        candidate.decode = () => decode.promise;
        const loaded = candidate.onload();
        assert.equal(h.node(stageId).dataset.imageState, 'loading');
        decode.resolve();
        await loaded;
        assert.equal(h.node(imageId), candidate);
        assert.equal(h.node(imageId).src, 'next.jpg');
        assert.equal(h.node(stageId).dataset.imageState, 'ready');
        assert.equal(h.node(stageId)['aria-busy'], 'false');
        assert.equal(h.node(`${scope}-image-status`).hidden, true);
        assert.equal(h.timers.size, 0);
    });

    test(`${scope}: stale decode and error cannot overwrite a newer image`, async () => {
        const h = setup();
        h.load(scope, 'slow.jpg');
        const old = h.candidates.at(-1);
        const lateError = old.onerror;
        const decode = deferred();
        old.decode = () => decode.promise;
        const loaded = old.onload();
        h.load(scope, 'latest.jpg');
        await h.candidates.at(-1).onload();
        decode.resolve();
        await loaded;
        lateError();
        assert.equal(h.node(imageId).src, 'latest.jpg');
        assert.equal(h.node(stageId).dataset.imageState, 'ready');
        assert.equal(h.timers.size, 0);
    });

    test(`${scope}: error and timeout expose retry, which can succeed`, async () => {
        const h = setup();
        h.load(scope, 'broken.jpg');
        h.candidates.at(-1).onerror();
        assert.equal(h.node(stageId).dataset.imageState, 'error');
        const status = h.node(`${scope}-image-status`);
        assert.equal(status.querySelector('.notice-image-retry').hidden, false);
        assert.equal(status.querySelector('.notice-loading-spinner').hidden, true);
        h.load(scope, 'broken.jpg');
        const timer = [...h.timers.values()][0];
        assert.equal(timer.delay, 30000);
        timer.callback();
        assert.equal(h.node(stageId).dataset.imageState, 'error');
        h.load(scope, 'broken.jpg');
        await h.candidates.at(-1).onload();
        assert.equal(h.node(stageId).dataset.imageState, 'ready');
    });

    test(`${scope}: closing during decoding cancels callbacks and timers`, async () => {
        const h = setup();
        h.load(scope, 'slow.jpg');
        const candidate = h.candidates.at(-1);
        const decode = deferred();
        candidate.decode = () => decode.promise;
        const loaded = candidate.onload();
        h.reset(scope);
        decode.resolve();
        await loaded;
        assert.equal(h.node(stageId).dataset.imageState, 'idle');
        assert.equal(h.node(imageId).src, undefined);
        assert.equal(h.timers.size, 0);
    });

    test(`${scope}: decode failure offers retry without showing broken image`, async () => {
        const h = setup();
        h.load(scope, 'invalid.jpg');
        h.candidates.at(-1).decode = () => Promise.reject(new Error('decode'));
        await h.candidates.at(-1).onload();
        assert.equal(h.node(stageId).dataset.imageState, 'error');
        assert.equal(h.node(imageId).src, undefined);
    });
}

test('obsolete detail responses do not render or hide the current loading indicator', async () => {
    const pending = new Map();
    let hidden = 0;
    let renders = 0;
    const context = {
        cancelNoticeHoverPreview() {},
        closeModal() {},
        showNoticeLoading() {},
        hideNoticeLoading() { hidden += 1; },
        getNoticeDetail(id) {
            const result = deferred();
            pending.set(id, result);
            return result.promise;
        },
        getNoticeDatePresentation() { return {}; },
        renderNoticeCards() { renders += 1; },
        // A current request can fail without any DOM rendering.
        console: { error() {} },
        alert() {}
    };
    const detail = source.slice(source.indexOf('async function openDetail('),
        source.indexOf('function runNoticeSurfaceTransition('));
    runInNewContext(`let currentViewId = null;
        let noticeDetailRequestVersion = 0;
        ${detail}
        globalThis.open = openDetail;
    `, context);
    const old = context.open('old');
    const latest = context.open('latest');
    pending.get('old').resolve({ id: 'old' });
    await old;
    assert.equal(renders, 0);
    assert.equal(hidden, 0);
    pending.get('latest').reject(new Error('network'));
    await latest;
    assert.equal(hidden, 1);
});

test('image status markup and cleanup hooks are wired into the public page', async () => {
    const html = await readFile('index.html', 'utf8');
    for (const scope of ['detail', 'viewer']) {
        assert.match(html, new RegExp(`id="${scope}-image-status" hidden`));
        assert.match(html, new RegExp(`id="${scope}-image-message" role="status"`));
    }
    assert.match(source, /function closeModal\(id\) \{\s*if \(id === 'image-viewer-modal'\) resetNoticeImage\('viewer'\)/);
    assert.match(source, /function showBoardView\(\) \{\s*noticeDetailRequestVersion \+= 1;\s*hideNoticeLoading\(\);\s*resetNoticeImage\('detail'\)/);
});