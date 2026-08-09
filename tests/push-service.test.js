import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { createAutomationStore } from '../server/storage/automation-store.js';
import {
    createPushService,
    matchesSubscription
} from '../server/services/push-service.js';

function browserSubscription(suffix = '') {
    return {
        endpoint: `https://push.example.test/subscription/${suffix || 'one'}`,
        keys: {
            p256dh: `public-key-${suffix || 'one'}`,
            auth: `auth-key-${suffix || 'one'}`
        }
    };
}

async function fixture() {
    const directory = await mkdtemp(path.join(tmpdir(), 'ece-push-'));
    const store = createAutomationStore({
        useSupabase: false,
        filePath: path.join(directory, 'automation.json')
    });
    const vapidCalls = [];
    const webPushClient = {
        setVapidDetails(...args) {
            vapidCalls.push(args);
        }
    };
    const service = createPushService({
        store,
        webPushClient,
        config: {
            enabled: true,
            subject: 'mailto:ece@example.com',
            publicKey: 'public',
            privateKey: 'private'
        }
    });
    return { store, service, vapidCalls };
}

async function publishedNotice(store, externalId = 'push-notice') {
    const pending = await store.createPendingNotice({
        sourceType: 'ece_academics',
        sourceExternalId: externalId,
        title: '수강신청 안내',
        content: '공지 본문',
        targets: ['25학번'],
        categoryIds: [2]
    });
    return store.publishReviewNotice(pending.id, {}, { notify: true });
}

// 게시 알림 잡이 섞이지 않도록 notify:false로 마감 있는 공지만 게시한다.
async function publishedDeadlineNotice(store, externalId, deadline) {
    const pending = await store.createPendingNotice({
        sourceType: 'ece_academics',
        sourceExternalId: externalId,
        title: '장학금 신청 안내',
        content: '마감 전에 신청하세요',
        targets: ['전체'],
        categoryIds: [2]
    });
    return store.publishReviewNotice(pending.id, { deadline }, { notify: false });
}

test('matches whole-audience or matching year and category preferences', () => {
    assert.equal(matchesSubscription(
        { targets: ['25학번'], categoryIds: [2] },
        { admissionYear: '25학번', allNotices: false, categoryIds: [2] }
    ), true);
    assert.equal(matchesSubscription(
        { targets: ['26학번'], categoryIds: [2] },
        { admissionYear: '25학번', allNotices: true, categoryIds: [] }
    ), false);
    assert.equal(matchesSubscription(
        { targets: ['전체'], categoryIds: [3] },
        { admissionYear: '25학번', allNotices: false, categoryIds: [3] }
    ), true);
});

test('urgent-enabled subscriptions bypass the category filter for imminent deadlines', () => {
    // KST 2026-08-09 12:00. 마감 2026-08-11은 D-2다.
    const now = new Date('2026-08-09T03:00:00.000Z');
    const imminent = { targets: ['전체'], categoryIds: [2], deadline: '2026-08-11' };

    assert.equal(matchesSubscription(
        imminent,
        { admissionYear: null, allNotices: false, categoryIds: [], urgentEnabled: true },
        now
    ), true);
    // 마감 임박이어도 학번 필터는 그대로 적용된다.
    assert.equal(matchesSubscription(
        { targets: ['26학번'], categoryIds: [2], deadline: '2026-08-11' },
        { admissionYear: '25학번', allNotices: false, categoryIds: [], urgentEnabled: true },
        now
    ), false);
    // 마감이 3일 넘게 남았으면 카테고리 필터가 그대로 적용된다.
    assert.equal(matchesSubscription(
        { targets: ['전체'], categoryIds: [2], deadline: '2026-08-20' },
        { admissionYear: null, allNotices: false, categoryIds: [], urgentEnabled: true },
        now
    ), false);
    // 옵션을 끈 구독은 우회하지 않는다.
    assert.equal(matchesSubscription(
        imminent,
        { admissionYear: null, allNotices: false, categoryIds: [], urgentEnabled: false },
        now
    ), false);
    // 상시 모집 공지는 마감 임박으로 치지 않는다.
    assert.equal(matchesSubscription(
        { ...imminent, isAlwaysOpen: true },
        { admissionYear: null, allNotices: false, categoryIds: [], urgentEnabled: true },
        now
    ), false);
});

test('push subscriptions receive unique opaque management tokens', async () => {
    const { service, vapidCalls } = await fixture();

    const first = await service.createSubscription(browserSubscription('one'), {
        admissionYear: '25학번',
        categoryIds: [2]
    });
    const second = await service.createSubscription(browserSubscription('two'), {
        admissionYear: '26학번',
        allNotices: true
    });

    assert.equal(vapidCalls.length, 1);
    assert.match(first.managementToken, /^[A-Za-z0-9_-]{40,}$/);
    assert.match(second.managementToken, /^[A-Za-z0-9_-]{40,}$/);
    assert.notEqual(first.managementToken, second.managementToken);
    assert.equal(Object.hasOwn(first.subscription, 'managementTokenHash'), false);
});

test('push subscription validates endpoints and requires its token for deletion', async () => {
    const { service, store } = await fixture();
    await assert.rejects(
        () => service.createSubscription({
            endpoint: 'javascript:alert(1)',
            keys: { p256dh: 'key', auth: 'auth' }
        }, {}),
        error => error.code === 'INVALID_PUSH_SUBSCRIPTION'
    );
    const created = await service.createSubscription(browserSubscription('delete'), {
        admissionYear: '25학번'
    });

    await assert.rejects(
        () => service.deleteSubscription(created.subscription.id, 'wrong-token'),
        error => error.code === 'INVALID_SUBSCRIPTION_TOKEN'
    );
    await service.deleteSubscription(created.subscription.id, created.managementToken);

    assert.equal((await store.listPushSubscriptions()).length, 0);
});

// 종이 노란색으로 바뀌려면 ecePushSubscriptionId가 남아야 한다. 클라이언트가 읽는
// 필드 이름이 서버 응답과 어긋나면 저장은 성공한 척하면서 종만 꺼져 있게 된다.
test('the client stores the subscription id that the server actually returns', async () => {
    const { service } = await fixture();
    const created = await service.createSubscription(browserSubscription('bell'), {
        admissionYear: '25학번'
    });

    // 원본에서 실제 저장 두 줄을 그대로 가져와 서버 응답에 적용한다.
    const source = await readFile('js/core.js', 'utf8');
    const persistence = source
        .split('\n')
        .filter(line => line.includes("localStorage.setItem('ecePush"))
        .join('\n');
    assert.equal(persistence.split('\n').length, 2, '저장 코드는 두 줄이어야 한다');

    const saved = new Map();
    runInNewContext(persistence, {
        result: created,
        localStorage: {
            getItem: key => (saved.has(key) ? saved.get(key) : null),
            setItem: (key, value) => saved.set(key, String(value))
        }
    });

    assert.equal(saved.get('ecePushSubscriptionId'), String(created.subscription.id));
    assert.equal(saved.get('ecePushManagementToken'), created.managementToken);

    // isPushSubscribed()가 참이어야 updateBellState()가 종을 켠다.
    assert.equal(Boolean(saved.get('ecePushSubscriptionId')), true);
});

test('notification worker sends each matching delivery only once', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ece-push-worker-'));
    const store = createAutomationStore({
        useSupabase: false,
        filePath: path.join(directory, 'automation.json')
    });
    await publishedNotice(store, 'worker-idempotent');
    const sends = [];
    const webPushClient = {
        setVapidDetails() {},
        async sendNotification(subscription, payload) {
            sends.push({ subscription, payload });
        }
    };
    const service = createPushService({
        store,
        webPushClient,
        config: {
            enabled: true,
            subject: 'mailto:ece@example.com',
            publicKey: 'public',
            privateKey: 'private'
        }
    });
    await service.createSubscription(browserSubscription('worker-one'), {
        admissionYear: '25학번',
        allNotices: true
    });
    await service.createSubscription(browserSubscription('worker-two'), {
        admissionYear: '25학번',
        allNotices: true
    });

    await service.processPendingJobs();
    await service.processPendingJobs();

    assert.equal(sends.length, 2);
    assert.ok((await store.listNotificationDeliveries()).every(item =>
        item.status === 'sent'
    ));
});

test('concurrent notification workers claim a job only once', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ece-push-claim-'));
    const store = createAutomationStore({
        useSupabase: false,
        filePath: path.join(directory, 'automation.json')
    });
    await publishedNotice(store, 'worker-claim');
    let sends = 0;
    const service = createPushService({
        store,
        webPushClient: {
            setVapidDetails() {},
            async sendNotification() {
                sends += 1;
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        },
        config: {
            enabled: true,
            subject: 'mailto:ece@example.com',
            publicKey: 'public',
            privateKey: 'private'
        }
    });
    await service.createSubscription(browserSubscription('claim'), {
        admissionYear: '25학번',
        allNotices: true
    });

    await Promise.all([
        service.processPendingJobs(),
        service.processPendingJobs()
    ]);

    assert.equal(sends, 1);
});

test('manual notices are delivered from their queued snapshot', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ece-push-manual-'));
    const store = createAutomationStore({
        useSupabase: false,
        filePath: path.join(directory, 'automation.json')
    });
    let sends = 0;
    const service = createPushService({
        store,
        webPushClient: {
            setVapidDetails() {},
            async sendNotification() {
                sends += 1;
            }
        },
        config: {
            enabled: true,
            subject: 'mailto:ece@example.com',
            publicKey: 'public',
            privateKey: 'private'
        }
    });
    await service.createSubscription(browserSubscription('manual'), {
        admissionYear: '25학번',
        allNotices: true
    });
    await store.createManualNotice({
        title: '관리자 직접 등록 공지',
        content: '본문',
        target: '25학번'
    });

    await service.processPendingJobs();

    assert.equal(sends, 1);
    assert.equal((await store.listNotificationJobs())[0].status, 'completed');
});

test('deadline reminders enqueue once per notice on the KST day boundary', async () => {
    const { store, service } = await fixture();
    await service.createSubscription(browserSubscription('reminder'), {
        admissionYear: '25학번',
        allNotices: true,
        deadlineReminderDays: 3
    });
    await publishedDeadlineNotice(store, 'reminder-d3', '2026-08-12');
    // D-1이지만 1일 전 알림 구독자가 없어 잡이 생기면 안 된다.
    await publishedDeadlineNotice(store, 'reminder-d1', '2026-08-10');
    // 마감일이 있어도 상시 모집이면 리마인더 대상이 아니다.
    const alwaysOpen = await store.createPendingNotice({
        sourceType: 'ece_academics',
        sourceExternalId: 'reminder-always-open',
        title: '상시 모집',
        content: '본문',
        targets: ['전체'],
        categoryIds: [2]
    });
    await store.publishReviewNotice(
        alwaysOpen.id,
        { deadline: '2026-08-12', isAlwaysOpen: true },
        { notify: false }
    );

    // UTC 8일 14:59 = KST 8일 23:59 → 마감 8월 12일은 아직 D-4라 잡이 없다.
    const beforeMidnight = await service.enqueueDeadlineReminders({
        notices: await store.listPublishedNotices(),
        now: new Date('2026-08-08T14:59:00.000Z')
    });
    assert.equal(beforeMidnight.created, 0);

    // UTC 8일 15:30 = KST 9일 00:30 → 한국 날짜가 바뀌어 D-3이 된다.
    const afterMidnight = await service.enqueueDeadlineReminders({
        notices: await store.listPublishedNotices(),
        now: new Date('2026-08-08T15:30:00.000Z')
    });
    assert.equal(afterMidnight.created, 1);

    // 같은 날 다시 돌아도 dedupeKey 덕분에 잡이 늘지 않는다.
    const repeated = await service.enqueueDeadlineReminders({
        notices: await store.listPublishedNotices(),
        now: new Date('2026-08-08T20:00:00.000Z')
    });
    assert.equal(repeated.created, 0);

    const jobs = await store.listNotificationJobs();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].kind, 'deadline_reminder');
    assert.equal(jobs[0].reminderDays, 3);
    assert.equal(jobs[0].dedupeKey, `reminder-${jobs[0].noticeId}-3`);
});

test('deadline reminder jobs deliver only to same-day reminder subscriptions', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ece-push-reminder-'));
    const store = createAutomationStore({
        useSupabase: false,
        filePath: path.join(directory, 'automation.json')
    });
    const currentTime = new Date('2026-08-08T15:30:00.000Z');
    const sends = [];
    const service = createPushService({
        store,
        webPushClient: {
            setVapidDetails() {},
            async sendNotification(subscription, payload) {
                sends.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) });
            }
        },
        config: {
            enabled: true,
            subject: 'mailto:ece@example.com',
            publicKey: 'public',
            privateKey: 'private'
        },
        now: () => currentTime
    });
    await service.createSubscription(browserSubscription('remind-three'), {
        allNotices: true,
        deadlineReminderDays: 3
    });
    await service.createSubscription(browserSubscription('remind-seven'), {
        allNotices: true,
        deadlineReminderDays: 7
    });
    const notice = await publishedDeadlineNotice(store, 'reminder-send', '2026-08-12');

    await service.enqueueDeadlineReminders({
        notices: await store.listPublishedNotices(),
        now: currentTime
    });
    await service.processPendingJobs();
    await service.processPendingJobs();

    assert.equal(sends.length, 1);
    assert.match(sends[0].endpoint, /remind-three$/);
    assert.equal(sends[0].payload.title, `[마감 D-3] ${notice.title}`);
    assert.equal(sends[0].payload.tag, `notice-${notice.id}-d3`);
    assert.ok((await store.listNotificationJobs()).every(job =>
        job.status === 'completed'
    ));
});

test('notification worker permanently drops subscriptions rejected with 401/403', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ece-push-vapid-mismatch-'));
    const store = createAutomationStore({
        useSupabase: false,
        filePath: path.join(directory, 'automation.json')
    });
    const responses = [403, 401];
    const service = createPushService({
        store,
        webPushClient: {
            setVapidDetails() {},
            async sendNotification() {
                const error = new Error('push rejected');
                error.statusCode = responses.shift();
                throw error;
            }
        },
        config: {
            enabled: true,
            subject: 'mailto:ece@example.com',
            publicKey: 'public',
            privateKey: 'private'
        }
    });
    await publishedNotice(store, 'worker-forbidden');
    await service.createSubscription(browserSubscription('forbidden'), {
        admissionYear: '25학번',
        allNotices: true
    });
    await service.processPendingJobs();
    assert.equal((await store.listPushSubscriptions())[0].status, 'inactive');
    let deliveries = await store.listNotificationDeliveries();
    assert.equal(deliveries[0].status, 'permanent_failure');
    assert.equal(deliveries[0].attempts, 1);

    await publishedNotice(store, 'worker-unauthorized');
    await service.createSubscription(browserSubscription('unauthorized'), {
        admissionYear: '25학번',
        allNotices: true
    });
    await service.processPendingJobs();
    assert.equal((await store.listPushSubscriptions())[1].status, 'inactive');
    deliveries = await store.listNotificationDeliveries();
    assert.ok(deliveries.every(delivery => delivery.status === 'permanent_failure'));
});

test('notification worker deactivates gone subscriptions and schedules transient retries', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ece-push-retry-'));
    const store = createAutomationStore({
        useSupabase: false,
        filePath: path.join(directory, 'automation.json')
    });
    let currentTime = new Date('2026-07-27T00:00:00.000Z');
    const responses = [410, 503, 503, 503];
    const webPushClient = {
        setVapidDetails() {},
        async sendNotification() {
            const error = new Error('push failed');
            error.statusCode = responses.shift();
            throw error;
        }
    };
    const service = createPushService({
        store,
        webPushClient,
        config: {
            enabled: true,
            subject: 'mailto:ece@example.com',
            publicKey: 'public',
            privateKey: 'private'
        },
        now: () => currentTime
    });
    await publishedNotice(store, 'worker-gone');
    await service.createSubscription(browserSubscription('gone'), {
        admissionYear: '25학번',
        allNotices: true
    });
    await service.processPendingJobs();
    assert.equal((await store.listPushSubscriptions())[0].status, 'inactive');

    await publishedNotice(store, 'worker-retry');
    await service.createSubscription(browserSubscription('retry'), {
        admissionYear: '25학번',
        allNotices: true
    });
    await service.processPendingJobs();
    let retry = (await store.listNotificationDeliveries())
        .find(item => item.status === 'retry');
    assert.equal(
        new Date(retry.nextAttemptAt).getTime() - currentTime.getTime(),
        60_000
    );

    currentTime = new Date(retry.nextAttemptAt);
    await service.processPendingJobs();
    retry = (await store.listNotificationDeliveries())
        .find(item => item.status === 'retry');
    assert.equal(
        new Date(retry.nextAttemptAt).getTime() - currentTime.getTime(),
        5 * 60_000
    );
});
