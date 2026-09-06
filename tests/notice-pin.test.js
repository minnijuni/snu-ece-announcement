import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    computePinnedUntil,
    isNoticePinnedNow
} from '../server/services/notice-expiry.js';
import {
    applyNoticeListFilters,
    normalizeNoticeListFilters
} from '../server/server.js';
import { createAutomationStore } from '../server/storage/automation-store.js';

const NOW = new Date('2026-09-06T00:00:00.000Z');

function baseRow(overrides = {}) {
    return {
        id: 1,
        title: '공지',
        content: '본문',
        target: '전체',
        host: '전기정보공학부',
        deadline: '',
        categoryIds: [1],
        views: 0,
        images: [],
        createdAt: '2026-09-01T00:00:00.000Z',
        ...overrides
    };
}

// ========================================
// 만료 시각 계산
// ========================================

test('a pin with no deadline in sight lasts seven days', () => {
    assert.equal(
        computePinnedUntil({}, NOW),
        new Date('2026-09-13T00:00:00.000Z').toISOString()
    );
});

// 마감보다 오래 붙잡아 둘 이유가 없다. 마감이 지난 공지는 목록 아래 그룹으로
// 내려가므로 고정해 봐야 위로 올라오지도 않는다.
test('a pin ends at the deadline when the deadline comes first', () => {
    assert.equal(
        computePinnedUntil({ deadlineAt: '2026-09-09T05:00:00.000Z' }, NOW),
        new Date('2026-09-09T05:00:00.000Z').toISOString()
    );
});

test('a deadline further out than a week still caps the pin at seven days', () => {
    assert.equal(
        computePinnedUntil({ deadlineAt: '2026-10-01T00:00:00.000Z' }, NOW),
        new Date('2026-09-13T00:00:00.000Z').toISOString()
    );
});

// 날짜만 있는 deadline을 자정으로 읽으면 마감일 당일 아침에 고정이 풀린다.
// 타임존을 빼먹으면 서버 로컬 시간으로 읽혀 Render(UTC)에서 9시간 밀린다.
test('a date-only deadline holds the pin through the end of that day in Seoul', () => {
    assert.equal(
        computePinnedUntil({ deadline: '2026-09-08' }, NOW),
        new Date('2026-09-08T23:59:59+09:00').toISOString()
    );
});

test('a deadline already past refuses the pin instead of setting one in the past', () => {
    assert.equal(computePinnedUntil({ deadlineAt: '2026-09-01T00:00:00.000Z' }, NOW), null);
});

test('an unparseable deadline falls back to seven days rather than throwing', () => {
    assert.equal(
        computePinnedUntil({ deadlineAt: 'not-a-date' }, NOW),
        new Date('2026-09-13T00:00:00.000Z').toISOString()
    );
});

// ========================================
// 고정 판정
// ========================================

test('either the open-ended flag or a live expiry counts as pinned', () => {
    assert.equal(isNoticePinnedNow({ isPinned: true }, NOW), true);
    assert.equal(isNoticePinnedNow({ pinnedUntil: '2026-09-10T00:00:00.000Z' }, NOW), true);
    assert.equal(isNoticePinnedNow({}, NOW), false);
});

test('an expired pin stops counting without anything having to clean it up', () => {
    assert.equal(isNoticePinnedNow({ pinnedUntil: '2026-09-05T23:59:59.000Z' }, NOW), false);
});

// ========================================
// 목록 정렬
// ========================================

test('a timed pin lifts a notice above the selected sort order', () => {
    const result = applyNoticeListFilters([
        baseRow({ id: 30, views: 10, pinnedUntil: '2026-09-10T00:00:00.000Z' }),
        baseRow({ id: 31, views: 999 })
    ], normalizeNoticeListFilters({ sort: '조회순' }), { now: NOW });

    assert.deepEqual(result.map(notice => notice.id), [30, 31]);
});

test('a pin whose time has passed drops back into the normal order', () => {
    const result = applyNoticeListFilters([
        baseRow({ id: 30, views: 10, pinnedUntil: '2026-09-05T00:00:00.000Z' }),
        baseRow({ id: 31, views: 999 })
    ], normalizeNoticeListFilters({ sort: '조회순' }), { now: NOW });

    assert.deepEqual(result.map(notice => notice.id), [31, 30]);
});

test('the open-ended pin keeps working next to the timed one', () => {
    const result = applyNoticeListFilters([
        baseRow({ id: 30, views: 1 }),
        baseRow({ id: 31, views: 999, isPinned: true }),
        baseRow({ id: 32, views: 500, pinnedUntil: '2026-09-10T00:00:00.000Z' })
    ], normalizeNoticeListFilters({ sort: '조회순' }), { now: NOW });

    // 고정된 둘이 먼저 오고, 그 안에서는 원래 정렬 기준을 따른다.
    assert.deepEqual(result.map(notice => notice.id), [31, 32, 30]);
});

// ========================================
// 저장
// ========================================

async function storeFixture() {
    const directory = await mkdtemp(path.join(tmpdir(), 'ece-pin-'));
    const store = createAutomationStore({
        useSupabase: false,
        filePath: path.join(directory, 'automation.json')
    });
    const pending = await store.createPendingNotice({
        sourceType: 'ece_academics',
        sourceExternalId: 'pin-notice',
        title: '고정 대상 공지',
        content: '본문',
        targets: ['전체'],
        categoryIds: [1]
    });
    const notice = await store.publishReviewNotice(pending.id, { isPinned: true }, { notify: false });
    return { store, notice };
}

// 어느 경로로 고정됐든 화면에는 똑같이 「고정」으로 보인다. 해제를 눌렀는데
// 무기한 쪽이 남아 안 풀리면 관리자는 버그로 읽는다.
test('unpinning clears the open-ended flag too, not just the expiry', async () => {
    const { store, notice } = await storeFixture();

    const unpinned = await store.setPublishedNoticePin(notice.id, {
        pinnedUntil: null,
        isPinned: false
    });

    assert.equal(unpinned.isPinned, false);
    assert.equal(unpinned.pinnedUntil, null);
    assert.equal(isNoticePinnedNow(unpinned, NOW), false);
});

test('pinning stores the expiry and leaves the open-ended flag alone', async () => {
    const { store, notice } = await storeFixture();

    const pinned = await store.setPublishedNoticePin(notice.id, {
        pinnedUntil: '2026-09-13T00:00:00.000Z',
        isPinned: null
    });

    assert.equal(pinned.pinnedUntil, '2026-09-13T00:00:00.000Z');
    assert.equal(pinned.isPinned, true);
});

test('pinning a notice that is not published finds nothing to change', async () => {
    const { store } = await storeFixture();
    assert.equal(await store.setPublishedNoticePin(9999, { pinnedUntil: null }), null);
});
