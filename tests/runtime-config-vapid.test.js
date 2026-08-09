import test from 'node:test';
import assert from 'node:assert/strict';
import webPush from 'web-push';
import { getAutomationConfig } from '../server/config/runtime-config.js';
import { createPushService } from '../server/services/push-service.js';

// .env.example이 배포하는 자리표시 값 그대로. 예전에는 이 값으로 npm start가 즉시 죽었다.
const PLACEHOLDER_ENV = {
    VAPID_PUBLIC_KEY: 'replace-with-vapid-public-key',
    VAPID_PRIVATE_KEY: 'replace-with-vapid-private-key',
    VAPID_SUBJECT: 'mailto:admin@example.com'
};

test('placeholder VAPID keys disable push instead of crashing boot', () => {
    const config = getAutomationConfig(PLACEHOLDER_ENV);

    assert.equal(config.push.enabled, false);

    // server.js 부팅 경로와 동일하게 실제 web-push 모듈로 서비스를 만들어도
    // enabled=false라 setVapidDetails가 호출되지 않고 예외가 없어야 한다.
    assert.doesNotThrow(() => createPushService({
        store: { placeholder: true },
        webPushClient: webPush,
        config: config.push
    }));
});

test('malformed VAPID key lengths disable push per variable', () => {
    const validPublic = Buffer.alloc(65, 4).toString('base64url');
    const validPrivate = Buffer.alloc(32, 7).toString('base64url');

    assert.equal(getAutomationConfig({
        VAPID_PUBLIC_KEY: Buffer.alloc(64, 4).toString('base64url'),
        VAPID_PRIVATE_KEY: validPrivate,
        VAPID_SUBJECT: 'mailto:ece@example.com'
    }).push.enabled, false);

    assert.equal(getAutomationConfig({
        VAPID_PUBLIC_KEY: validPublic,
        VAPID_PRIVATE_KEY: Buffer.alloc(31, 7).toString('base64url'),
        VAPID_SUBJECT: 'mailto:ece@example.com'
    }).push.enabled, false);
});

test('well-formed VAPID keys keep push enabled', () => {
    const config = getAutomationConfig({
        VAPID_PUBLIC_KEY: Buffer.alloc(65, 4).toString('base64url'),
        VAPID_PRIVATE_KEY: Buffer.alloc(32, 7).toString('base64url'),
        VAPID_SUBJECT: 'mailto:ece@example.com'
    });

    assert.equal(config.push.enabled, true);
});
