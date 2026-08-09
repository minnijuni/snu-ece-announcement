import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getAutomationConfig } from '../server/config/runtime-config.js';
import { CANONICAL_NOTICE_CATEGORIES } from '../server/config/notice-categories.js';
import { createAutomationStore } from '../server/storage/automation-store.js';

test('automation configuration disables protected jobs when secrets are absent', () => {
    const config = getAutomationConfig({});

    assert.equal(config.crawl.enabled, false);
    assert.equal(config.push.enabled, false);
});

test('automation configuration accepts complete crawl and push settings', () => {
    const config = getAutomationConfig({
        CRAWL_TRIGGER_SECRET: 'a'.repeat(32),
        // web-push 규격대로 공개키 65바이트·비밀키 32바이트여야 푸시가 켜진다.
        VAPID_PUBLIC_KEY: Buffer.alloc(65, 4).toString('base64url'),
        VAPID_PRIVATE_KEY: Buffer.alloc(32, 7).toString('base64url'),
        VAPID_SUBJECT: 'mailto:ece@example.com'
    });

    assert.equal(config.crawl.enabled, true);
    assert.equal(config.push.enabled, true);
    assert.equal(config.crawl.pages, 3);
    assert.equal(config.crawl.maxDetails, 20);
    assert.equal(config.categories.windowDays, 60);
    assert.equal(config.categories.minimumNotices, 5);
    assert.equal(config.categories.minimumConfidence, 0.75);
});

test('JSON automation store supplies the four topic-only notice categories in order', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ece-category-store-'));
    const store = createAutomationStore({
        useSupabase: false,
        filePath: path.join(directory, 'automation.json'),
        canonicalCategories: CANONICAL_NOTICE_CATEGORIES
    });

    const categories = await store.listCategories();

    assert.deepEqual(
        categories.map(category => category.name),
        ['학사', '기회', '설문', '행사']
    );
    assert.ok(categories.every(category => category.definition));

    const created = await store.createManualNotice({
        title: '신청 공지',
        content: '폼 제출',
        target: '전체',
        categoryIds: [categories[0].id]
    });
    assert.deepEqual(created.categoryIds, [categories[0].id]);
    assert.deepEqual(
        (await store.listPublishedNotices())[0].categoryIds,
        [categories[0].id]
    );
});

test('Supabase schema contains automation tables, constraints, and RLS', async () => {
    const schema = await readFile('server/sql/supabase-schema.sql', 'utf8');
    const requiredTables = [
        'crawl_runs',
        'crawl_items',
        'categories',
        'category_aliases',
        'notice_categories',
        'category_candidates',
        'category_candidate_notices',
        'push_subscriptions',
        'notification_jobs',
        'notification_deliveries'
    ];

    for (const table of requiredTables) {
        assert.match(schema, new RegExp(`create table if not exists public\\.${table}`));
        assert.match(schema, new RegExp(`alter table public\\.${table} enable row level security`));
    }

    assert.match(schema, /notices_source_external_unique/);
    assert.match(schema, /unique\s*\(job_id,\s*subscription_id\)/);
    assert.match(schema, /pending_review/);
    assert.match(schema, /analysis_status/);
    assert.match(schema, /crawl_runs_one_running_per_source/);
    assert.match(schema, /publish_review_notice/);
    assert.match(schema, /create_manual_notice/);
    assert.match(schema, /decide_category_candidate/);
    assert.match(schema, /claimed_at/);
    assert.match(schema, /claim_token/);
});

test('JSON automation store creates one pending notice per external source', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ece-store-'));
    const store = createAutomationStore({
        useSupabase: false,
        filePath: path.join(directory, 'automation.json')
    });
    const input = {
        sourceType: 'ece_academics',
        sourceExternalId: '57854',
        title: '교과목 중복인정',
        content: '본문',
        status: 'pending_review'
    };

    const created = await store.createPendingNotice(input);

    assert.equal(created.status, 'pending_review');
    assert.equal(created.sourceExternalId, '57854');
    assert.equal(
        (await store.findNoticeBySource('ece_academics', '57854')).id,
        created.id
    );
    await assert.rejects(
        () => store.createPendingNotice(input),
        error => error.code === 'DUPLICATE_SOURCE_NOTICE'
    );
});

test('JSON automation store records crawl completion', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ece-store-run-'));
    const store = createAutomationStore({
        useSupabase: false,
        filePath: path.join(directory, 'automation.json')
    });

    const run = await store.beginCrawlRun('ece_academics');
    const completed = await store.finishCrawlRun(run.id, {
        status: 'partial',
        discoveredCount: 3,
        createdCount: 2,
        failedCount: 1,
        errorMessage: 'one detail failed'
    });

    assert.equal(completed.status, 'partial');
    assert.equal(completed.createdCount, 2);
    assert.ok(completed.finishedAt);
});

test('JSON automation store allows only one running crawl per source', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ece-store-lock-'));
    const store = createAutomationStore({
        useSupabase: false,
        filePath: path.join(directory, 'automation.json')
    });
    const running = await store.beginCrawlRun('ece_academics');

    await assert.rejects(
        () => store.beginCrawlRun('ece_academics'),
        error => error.code === 'CRAWL_ALREADY_RUNNING'
    );
    await store.finishCrawlRun(running.id, {
        status: 'succeeded',
        discoveredCount: 0,
        createdCount: 0,
        failedCount: 0
    });
    assert.equal((await store.beginCrawlRun('ece_academics')).status, 'running');
});

test('JSON automation store publishes only reviewed notices and queues notification once', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ece-store-publish-'));
    const store = createAutomationStore({
        useSupabase: false,
        filePath: path.join(directory, 'automation.json')
    });
    const pending = await store.createPendingNotice({
        sourceType: 'ece_academics',
        sourceExternalId: '60001',
        title: '원본 제목',
        content: '원본 본문',
        targets: ['24학번'],
        keywords: ['수강신청']
    });

    const published = await store.publishReviewNotice(pending.id, {
        title: '검수한 제목',
        targets: ['24학번', '25학번']
    }, { notify: true });

    assert.equal(published.status, 'published');
    assert.equal(published.title, '검수한 제목');
    assert.deepEqual(published.targets, ['24학번', '25학번']);
    assert.equal((await store.listReviewNotices()).length, 0);
    assert.equal((await store.listPublishedNotices()).length, 1);
    assert.equal((await store.listNotificationJobs()).length, 1);
    await assert.rejects(
        () => store.publishReviewNotice(pending.id, {}, { notify: true }),
        error => error.code === 'NOTICE_NOT_PENDING'
    );
    assert.equal((await store.listNotificationJobs()).length, 1);
});

test('JSON automation store rejects a pending notice without a notification job', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ece-store-reject-'));
    const store = createAutomationStore({
        useSupabase: false,
        filePath: path.join(directory, 'automation.json')
    });
    const pending = await store.createPendingNotice({
        sourceType: 'ece_academics',
        sourceExternalId: '60002',
        title: '반려 대상',
        content: '본문'
    });

    const rejected = await store.rejectReviewNotice(pending.id, '대상이 아님');

    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.rejectionReason, '대상이 아님');
    assert.equal((await store.listPublishedNotices()).length, 0);
    assert.equal((await store.listNotificationJobs()).length, 0);
});

test('JSON automation store atomically creates and manages manual notices with outbox jobs', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ece-store-manual-'));
    const store = createAutomationStore({
        useSupabase: false,
        filePath: path.join(directory, 'automation.json')
    });

    const created = await store.createManualNotice({
        title: '직접 등록',
        content: '본문',
        target: '전체'
    });

    assert.equal((await store.listPublishedNotices()).length, 1);
    assert.equal((await store.listNotificationJobs()).length, 1);
    const updated = await store.updateManualNotice(created.id, {
        title: '수정된 직접 등록',
        content: '수정 본문',
        target: '25학번'
    });
    assert.equal(updated.title, '수정된 직접 등록');
    assert.deepEqual(updated.targets, ['25학번']);
    assert.equal(await store.deleteManualNotice(created.id), true);
    assert.equal((await store.listPublishedNotices()).length, 0);
});

test('JSON automation store hides and restores published crawled notices without deleting them', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ece-hidden-store-'));
    const store = createAutomationStore({
        useSupabase: false,
        filePath: path.join(directory, 'automation.json'),
        canonicalCategories: CANONICAL_NOTICE_CATEGORIES
    });
    const pending = await store.createPendingNotice({
        sourceType: 'ece_academics',
        sourceExternalId: 'hidden-1',
        title: '숨김 테스트',
        content: '원문',
        targets: ['전체']
    });
    await store.publishReviewNotice(pending.id, {}, { notify: false });

    const hidden = await store.setPublishedNoticeHidden(pending.id, true);
    assert.equal(hidden.isHidden, true);
    assert.equal((await store.listPublishedNotices())[0].isHidden, true);

    const restored = await store.setPublishedNoticeHidden(pending.id, false);
    assert.equal(restored.isHidden, false);
});

test('JSON automation store deduplicates notification jobs by dedupe key', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ece-store-dedupe-'));
    const store = createAutomationStore({
        useSupabase: false,
        filePath: path.join(directory, 'automation.json')
    });

    const first = await store.createNotificationJobIfAbsent({
        kind: 'deadline_reminder',
        reminderDays: 3,
        noticeId: 11,
        dedupeKey: 'reminder-11-3'
    });
    const duplicate = await store.createNotificationJobIfAbsent({
        kind: 'deadline_reminder',
        reminderDays: 3,
        noticeId: 11,
        dedupeKey: 'reminder-11-3'
    });
    const other = await store.createNotificationJobIfAbsent({
        kind: 'deadline_reminder',
        reminderDays: 1,
        noticeId: 11,
        dedupeKey: 'reminder-11-1'
    });

    assert.equal(first.status, 'pending');
    assert.equal(first.kind, 'deadline_reminder');
    assert.equal(first.reminderDays, 3);
    assert.equal(duplicate, null);
    assert.equal(other.dedupeKey, 'reminder-11-1');
    assert.equal((await store.listNotificationJobs()).length, 2);
});

test('JSON notification job renewals are fenced by a unique claim token', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ece-store-claim-token-'));
    const store = createAutomationStore({
        useSupabase: false,
        filePath: path.join(directory, 'automation.json')
    });
    await store.createManualNotice({
        title: '알림 임대',
        content: '본문',
        target: '전체'
    });
    const [pending] = await store.listPendingNotificationJobs();
    const claimed = await store.claimNotificationJob(pending.id);

    assert.match(claimed.claimToken, /^[0-9a-f-]{36}$/);
    assert.equal(await store.renewNotificationJobClaim(claimed.id, 'wrong-token'), false);
    assert.equal(
        await store.renewNotificationJobClaim(claimed.id, claimed.claimToken),
        true
    );
});
