import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAutomationStore } from '../server/storage/automation-store.js';
import { createPushService } from '../server/services/push-service.js';

async function fixture() {
    const directory = await mkdtemp(path.join(tmpdir(), 'ece-reminder-'));
    const store = createAutomationStore({
        useSupabase: false,
        filePath: path.join(directory, 'automation.json')
    });
    const sent = [];
    const service = createPushService({
        store,
        webPushClient: {
            setVapidDetails() {},
            async sendNotification(subscription, payload) {
                sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) });
            }
        },
        config: {
            enabled: true,
            subject: 'mailto:ece@example.com',
            publicKey: 'public',
            privateKey: 'private'
        }
    });
    return { store, service, sent };
}

async function publishedNotice(store, externalId = 'reminder-notice') {
    const pending = await store.createPendingNotice({
        sourceType: 'ece_academics',
        sourceExternalId: externalId,
        title: '수강신청 안내',
        content: '공지 본문',
        targets: ['전체'],
        categoryIds: [1]
    });
    return store.publishReviewNotice(pending.id, {}, { notify: true });
}

// ========================================
// 작업 생성
// ========================================

// 공지를 올릴 때 만드는 알림 작업에 kind가 빠져 있으면, 리마인드인지 아닌지
// 가릴 수가 없어 push-service의 분기가 통째로 죽는다.
test('publishing a notice records its notification job as a new_notice', async () => {
    const { store } = await fixture();
    const notice = await publishedNotice(store);

    const jobs = await store.listNotificationJobsForNotice(notice.id);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].kind, 'new_notice');
});

test('a notice can carry many reminders but only ever one new_notice job', async () => {
    const { store } = await fixture();
    const notice = await publishedNotice(store);

    assert.equal(await store.createNotificationJob({ noticeId: notice.id, kind: 'new_notice' }), null);

    const first = await store.createNotificationJob({ noticeId: notice.id, kind: 'reminder' });
    const second = await store.createNotificationJob({ noticeId: notice.id, kind: 'reminder' });
    assert.ok(first.id);
    assert.ok(second.id);
    assert.notEqual(first.id, second.id);

    const reminders = await store.listNotificationJobsForNotice(notice.id, 'reminder');
    assert.equal(reminders.length, 2);
});

test('jobs for a notice come back newest first so the cooldown can read the last one', async () => {
    const { store } = await fixture();
    const notice = await publishedNotice(store);

    await store.createNotificationJob({ noticeId: notice.id, kind: 'reminder' });
    await new Promise(resolve => setTimeout(resolve, 5));
    const latest = await store.createNotificationJob({ noticeId: notice.id, kind: 'reminder' });

    const reminders = await store.listNotificationJobsForNotice(notice.id, 'reminder');
    assert.equal(reminders[0].id, latest.id);
});

test('listing jobs for one notice does not pick up another notice', async () => {
    const { store } = await fixture();
    const first = await publishedNotice(store, 'one');
    const second = await publishedNotice(store, 'two');

    await store.createNotificationJob({ noticeId: first.id, kind: 'reminder' });

    assert.equal((await store.listNotificationJobsForNotice(second.id, 'reminder')).length, 0);
});

// ========================================
// 발송
// ========================================

async function subscribe(service, suffix) {
    return service.createSubscription({
        endpoint: `https://push.example.test/subscription/${suffix}`,
        keys: { p256dh: `public-${suffix}`, auth: `auth-${suffix}` }
    }, { allNotices: true });
}

test('a reminder goes out marked as one, and does not overwrite the original alert', async () => {
    const { store, service, sent } = await fixture();
    const notice = await publishedNotice(store);

    await subscribe(service, 'reminder');
    await service.processPendingJobs();

    const job = await store.createNotificationJob({ noticeId: notice.id, kind: 'reminder' });
    await service.processPendingJobs();

    assert.equal(sent.length, 2);
    const [original, reminder] = sent;

    assert.equal(original.payload.title, '수강신청 안내');
    assert.equal(original.payload.tag, `notice-${notice.id}`);

    assert.equal(reminder.payload.title, '[마감 임박] 수강신청 안내');
    // 태그가 같으면 브라우저가 원래 알림을 조용히 갈아치운다.
    assert.equal(reminder.payload.tag, `notice-${notice.id}-r${job.id}`);
    assert.notEqual(reminder.payload.tag, original.payload.tag);
});

test('two reminders on one notice keep distinct tags', async () => {
    const { store, service, sent } = await fixture();
    const notice = await publishedNotice(store);

    await subscribe(service, 'twice');
    await service.processPendingJobs();
    sent.length = 0;

    await store.createNotificationJob({ noticeId: notice.id, kind: 'reminder' });
    await service.processPendingJobs();
    await store.createNotificationJob({ noticeId: notice.id, kind: 'reminder' });
    await service.processPendingJobs();

    assert.equal(sent.length, 2);
    assert.notEqual(sent[0].payload.tag, sent[1].payload.tag);
});

// 리마인드라고 해서 대상을 넓히지 않는다. 처음 알림과 같은 사람들에게 간다.
test('a reminder still goes only to subscribers the notice actually matches', async () => {
    const { store, service, sent } = await fixture();

    const pending = await store.createPendingNotice({
        sourceType: 'ece_academics',
        sourceExternalId: 'targeted',
        title: '25학번 전용 공지',
        content: '본문',
        targets: ['25학번'],
        categoryIds: [1]
    });
    const targeted = await store.publishReviewNotice(pending.id, {}, { notify: false });

    await service.createSubscription({
        endpoint: 'https://push.example.test/subscription/26',
        keys: { p256dh: 'public-26', auth: 'auth-26' }
    }, { admissionYear: '26학번', allNotices: true });

    await store.createNotificationJob({ noticeId: targeted.id, kind: 'reminder' });
    await service.processPendingJobs();

    assert.equal(sent.length, 0);
});

test('a reminder for a notice that is no longer published sends nothing', async () => {
    const { store, service, sent } = await fixture();
    const notice = await publishedNotice(store);

    await subscribe(service, 'gone');
    await service.processPendingJobs();
    sent.length = 0;

    await store.createNotificationJob({ noticeId: 9999, kind: 'reminder' });
    await service.processPendingJobs();

    assert.equal(sent.length, 0);
    assert.ok(notice.id);
});

// ========================================
// 감사 로그
// ========================================

test('the audit log keeps who reminded which notice', async () => {
    const { store } = await fixture();
    const notice = await publishedNotice(store);

    await store.recordAuditLog({
        action: 'notice.reminder_sent',
        entityType: 'notice',
        entityId: String(notice.id),
        metadata: { jobId: 7, recipients: 12 }
    });

    const entry = await store.recordAuditLog({
        action: 'notice.reminder_sent',
        entityType: 'notice',
        entityId: String(notice.id),
        metadata: { jobId: 8, recipients: 3 }
    });

    assert.equal(entry.action, 'notice.reminder_sent');
    assert.equal(entry.entityId, String(notice.id));
    assert.equal(entry.metadata.recipients, 3);
});
