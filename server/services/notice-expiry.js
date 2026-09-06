const SEOUL_OFFSET = '+09:00';
const DAY_MS = 24 * 60 * 60 * 1000;

const CATEGORY_EXPIRY_PRIORITY = Object.freeze([
    'academic',
    'opportunity',
    'survey',
    'community'
]);

function isDateOnly(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim());
}

export function normalizeDeadlineAt(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const normalized = isDateOnly(raw)
        ? `${raw}T23:59:59${SEOUL_OFFSET}`
        : raw;
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) {
        throw new TypeError('마감 시각이 올바른 날짜가 아닙니다.');
    }
    return date.toISOString();
}

function addDays(value, days) {
    return new Date(new Date(value).getTime() + (days * DAY_MS)).toISOString();
}

function endOfSeoulDay(value) {
    const date = new Date(value);
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Seoul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(date);
    const part = type => parts.find(item => item.type === type)?.value;
    return new Date(`${part('year')}-${part('month')}-${part('day')}T23:59:59${SEOUL_OFFSET}`).toISOString();
}

function getAcademicTermEnd(createdAt) {
    const date = new Date(createdAt);
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Seoul',
        year: 'numeric',
        month: 'numeric'
    }).formatToParts(date);
    const year = Number(parts.find(item => item.type === 'year')?.value);
    const month = Number(parts.find(item => item.type === 'month')?.value);
    const endMonthDay = month <= 6 ? '06-30' : '12-31';
    return new Date(`${year}-${endMonthDay}T23:59:59${SEOUL_OFFSET}`).toISOString();
}

export function selectExpiryCategory(categorySlugs = []) {
    const slugs = new Set(categorySlugs.map(value => String(value || '').trim()));
    return CATEGORY_EXPIRY_PRIORITY.find(slug => slugs.has(slug)) || null;
}

export function calculateNoticeLifecycle({
    deadlineAt = null,
    isAlwaysOpen = false,
    categorySlugs = [],
    createdAt = new Date().toISOString()
} = {}) {
    const normalizedDeadlineAt = normalizeDeadlineAt(deadlineAt);
    const normalizedCreatedAt = new Date(createdAt);
    if (Number.isNaN(normalizedCreatedAt.getTime())) {
        throw new TypeError('공지 생성 시각이 올바르지 않습니다.');
    }
    if (isAlwaysOpen) {
        return {
            deadlineAt: normalizedDeadlineAt,
            expiresAt: null,
            isAlwaysOpen: true,
            expiryCategory: selectExpiryCategory(categorySlugs)
        };
    }

    const expiryCategory = selectExpiryCategory(categorySlugs);
    // 상태는 별도 저장하지 않고 deadline 하나로만 파생한다.
    // 마감이 없는 공지는 상시/정보성으로 남고, 마감 시각이 지나면 곧바로 지난 공지가 된다.
    const expiresAt = normalizedDeadlineAt;

    return {
        deadlineAt: normalizedDeadlineAt,
        expiresAt,
        isAlwaysOpen: false,
        expiryCategory
    };
}

export function getNoticeLifecycleState({
    deadlineAt = null,
    expiresAt = null,
    isAlwaysOpen = false
} = {}, now = new Date()) {
    const nowTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
    const deadlineTime = deadlineAt ? new Date(deadlineAt).getTime() : null;
    const expiryTime = expiresAt ? new Date(expiresAt).getTime() : null;
    const deadlinePassed = Number.isFinite(deadlineTime) && deadlineTime < nowTime;
    const isExpired = !isAlwaysOpen && Number.isFinite(expiryTime) && expiryTime <= nowTime;
    return {
        deadlinePassed,
        isExpired,
        isInGracePeriod: deadlinePassed && !isExpired && Number.isFinite(expiryTime)
    };
}

/* 고정에는 두 갈래가 있다. isPinned는 관리자가 편집 폼에서 켠 무기한 고정이고,
   pinnedUntil은 카드 메뉴로 건 기한부 고정이다. 둘 중 하나만 참이어도 고정이다.
   기한이 지난 값을 지우는 배치는 두지 않는다. 읽을 때마다 시각으로 판정하므로
   저절로 풀린다. 마감·유예를 다루는 방식과 같다. */
export function isNoticePinnedNow({ isPinned = false, pinnedUntil = null } = {}, now = new Date()) {
    if (isPinned === true) return true;
    if (!pinnedUntil) return false;
    const until = new Date(pinnedUntil).getTime();
    const nowTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
    return Number.isFinite(until) && until > nowTime;
}

const PIN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/* 기한부 고정이 풀리는 시각. 7일 뒤와 마감 시각 중 빠른 쪽이다.
   마감이 이미 지났으면 null을 돌려주고, 부르는 쪽이 거절한다.

   날짜만 있는 deadline은 normalizeDeadlineAt에 맡긴다. 직접 문자열을 이어 붙이면
   타임존이 빠져 서버 로컬 시간으로 읽히고, Render는 UTC라 마감이 9시간 밀린다. */
export function computePinnedUntil({ deadlineAt = null, deadline = null } = {}, now = new Date()) {
    const nowTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
    const window = nowTime + PIN_WINDOW_MS;

    let deadlineTime = null;
    try {
        const normalized = normalizeDeadlineAt(deadlineAt || deadline);
        if (normalized) deadlineTime = new Date(normalized).getTime();
    } catch {
        // 읽을 수 없는 마감이라면 기간만 보고 정한다. 고정을 막을 이유는 아니다.
        deadlineTime = null;
    }

    if (!Number.isFinite(deadlineTime)) return new Date(window).toISOString();
    if (deadlineTime <= nowTime) return null;
    return new Date(Math.min(deadlineTime, window)).toISOString();
}
