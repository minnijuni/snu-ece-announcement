// ========================================
// SNU ECE 공지방 — core.js
// 뷰 모드와 무관한 공통 레이어.
//   · 서버 통신, 공지 저장소, 필터/정렬, 카드 렌더, 상세 보기, 비교, 알림 구독
//   · 뷰 모듈(desktop.js / mobile.js) 등록 및 전환
// 관리자 기능은 admin.js로 완전히 분리되어 이 파일에 없다.
// ========================================

// D-Day 기준일. 페이지를 열어둔 채 자정을 넘겨도 맞도록 호출 시점마다 계산한다.
function getCurrentDate() {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    return now;
}

// config.js가 빈 문자열(동일 출처)을 지정했을 수 있으므로 || 대신 타입으로 판별한다.
const API_BASE_URL = (
    typeof window.API_BASE_URL === 'string'
        ? window.API_BASE_URL
        : (localStorage.getItem('eceApiBaseUrl') || '')
).trim().replace(/\/$/, '');

let currentViewId = null;
let currentImageArray = [];
let currentImageIndex = 0;
let detailImageArray = [];
let detailImageIndex = 0;
let imageSwipeStartX = null;
let boardScrollPosition = 0;
let detailHistoryPushed = false;

let notices = [];
let bannerSlides = [];
let activeBannerSlideIndex = 0;
let initialBannerRandomized = false;
let bannerRotationInterval = null;
let bannerSwipePointerId = null;
let bannerSwipeStartX = 0;
let bannerSwipeStartY = 0;
let bannerSwipeDeltaX = 0;
// 튕기듯 짧게 넘기는 손짓을 알아보려고 시작 시각을 재 둔다.
let bannerSwipeStartedAt = 0;
let suppressBannerLinkUntil = 0;
/* 트랙 캐러셀 상태.
   trackPosition은 앞뒤 복제 슬라이드를 포함한 트랙 위의 칸 번호다.
   실제 슬라이드 i는 trackPosition i+1에 놓이고, 0번과 n+1번은 각각
   마지막·첫 슬라이드의 복제본이라 끝에서 끝으로 끊김 없이 이어진다. */
let bannerTrackPosition = 1;
let bannerRenderedCount = 0;
let bannerSettleTimer = null;
const BANNER_SLIDE_DURATION = 460;
const BANNER_ROTATION_DELAY = 6500;
let compareBlocks = [];   // 독립 비교 공간에 담긴 공지 id들 (데스크톱 전용, 최대 4)
let compareWorkspaceOpen = false;
let compareDockSide = 'left';
let compareLayoutMode = 'stack';
let expandedCompareBlocks = new Set();
let activeNoticeSplitDragId = '';
let noticeSplitDragOverlay = null;
let noticeSplitOverlayTimer = null;
let noticeDragInProgress = false;
let suppressNoticeClickUntil = 0;
let pointerNoticeDrag = null;
let pointerDraggedCompareId = '';
// 놓인 블록을 다시 잡아 끌 때 지금 가리키고 있는 위쪽 표적('left'/'right').
let pointerCompareSplitSide = '';
let pointerDraggedComparePointerId = null;
let pointerDragHandle = null;
let compareDragOverlay = null;
let activeCompareDropTargetId = '';
let activeCompareDropPosition = 'after';
let activeFeedbackCategory = 'general';
let noticeHoverPreviewTimer = null;
let activeHoverPreviewNoticeId = '';

let adminInfo = { name: "ECE 학생회장 (이름 : 박지호)", phone: "010-1234-5678", kakao: "snu_ece_pres" };
let bannerAdminInfo = { name: "학생회 대외협력국 (국장 : 이배너)", phone: "010-8888-9999", kakao: "snu_ece_ads" };
let noticeAdminAuthToken = '';
let superAdminAuthToken = '';
let bannerManageAuthToken = '';
let activeCategories = [];
let selectedCategoryFilters = new Set();
let archiveTabActive = false;
const quickNoticeFilters = {
    urgent: false,
    reward: false,
    action: false,
    past: false
};

const NOTICE_CATEGORY_ORDER = Object.freeze([
    'academic',
    'opportunity',
    'survey',
    'community'
]);

/* '관련' 공지는 학부 홈페이지에서 자동으로 모아 온 원문 공지다.
   주제가 아니라 출처로 가른 것이라 카테고리 탭에 함께 세우면 축이 어긋난다.
   같은 공지가 학사와 관련에 둘 다 나오니 탭을 고르는 손이 헷갈린다.
   그래서 상세 필터의 스위치로 옮겼다. 평소에는 켜 두어 다 보이고,
   직접 등록한 소식만 훑고 싶을 때 끈다. */
let includeRelatedNotices = true;

function orderedNoticeCategories(categories = activeCategories) {
    const order = new Map(NOTICE_CATEGORY_ORDER.map((slug, index) => [slug, index]));
    return categories
        .filter(category => order.has(category.slug))
        .sort((a, b) => order.get(a.slug) - order.get(b.slug));
}

const filterState = {
    'deadline-status': '전체', 'host': '전체', 'views': '전체', 'sort': '최신순'
};
const FILTER_DEFAULTS = Object.freeze({
    'deadline-status': '전체', 'host': '전체', 'views': '전체', 'sort': '최신순'
});

// 컨베이어로 흐르는 리워드 문구 사이의 간격. CSS의 값과 반드시 같아야
// 트랙을 절반 미는 계산이 이음매 없이 맞아떨어진다.
const CARD_REWARD_MARQUEE_GAP = 28;

function buildApiUrl(path) {
    return API_BASE_URL ? `${API_BASE_URL}${path}` : path;
}

// 베타 측정은 브라우저 난수 식별자만 쓰며, 서버에는 그 해시만 저장된다.
function betaAnalyticsSessionId() {
    let id = localStorage.getItem('eceBetaAnalyticsId');
    if (!id) {
        id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).replace(/-/g, '');
        localStorage.setItem('eceBetaAnalyticsId', id);
    }
    return id;
}

function trackBetaEvent(type, rating = null) {
    const payload = JSON.stringify({
        type,
        rating,
        sessionId: betaAnalyticsSessionId(),
        pagePath: location.pathname
    });
    fetch(buildApiUrl('/api/analytics/events'), {
        method: 'POST', keepalive: true,
        headers: { 'Content-Type': 'application/json' }, body: payload
    }).catch(() => {});
}

function initializeBetaAnalytics() {
    const visitedKey = 'eceBetaAnalyticsVisited';
    const hasVisited = localStorage.getItem(visitedKey) === '1';
    trackBetaEvent('page_view');
    if (hasVisited) trackBetaEvent('return_visit');
    localStorage.setItem(visitedKey, '1');
}

const BETA_NOTICE_OPEN_COUNT_KEY = 'eceBetaNoticeOpenCount';
const BETA_RATING_PROMPTS_KEY = 'eceBetaRatingPrompts';
const BETA_RATING_MILESTONES = [3, 13];

function storedBetaRatingPrompts() {
    try {
        const values = JSON.parse(localStorage.getItem(BETA_RATING_PROMPTS_KEY) || '[]');
        return Array.isArray(values) ? values.map(Number).filter(Number.isFinite) : [];
    } catch {
        return [];
    }
}

function closeBetaRatingPrompt() {
    closeModal('beta-rating-modal');
}

function submitBetaRating(score) {
    const rating = Number(score);
    if (rating >= 1 && rating <= 5) trackBetaEvent('rating', rating);
    closeBetaRatingPrompt();
}

function recordBetaNoticeOpen() {
    let count = Number(localStorage.getItem(BETA_NOTICE_OPEN_COUNT_KEY) || 0);
    count = Number.isFinite(count) ? count + 1 : 1;
    localStorage.setItem(BETA_NOTICE_OPEN_COUNT_KEY, String(count));
    if (!BETA_RATING_MILESTONES.includes(count)) return;

    const prompted = storedBetaRatingPrompts();
    if (prompted.includes(count)) return;
    prompted.push(count);
    localStorage.setItem(BETA_RATING_PROMPTS_KEY, JSON.stringify(prompted));

    const help = document.getElementById('beta-rating-help');
    if (help) help.textContent = count === 3
        ? '공지 3개를 열어본 시점의 평가를 남겨주세요. 익명으로 집계됩니다.'
        : '공지를 13회 열어본 후의 평가를 남겨주세요. 이후에는 다시 묻지 않습니다.';
    window.setTimeout(() => openModal('beta-rating-modal'), 450);
}

// ========================================
// 🖥 뷰 모드 (데스크탑 / 모바일)
// 레이아웃은 CSS가 data-view로 가르고, 동작 차이는 등록된 뷰 모듈이 맡는다.
// ========================================

const viewModules = new Map();
let activeViewModule = null;

function getLayoutMode() {
    return document.documentElement.getAttribute('data-view') === 'mobile' ? 'mobile' : 'desktop';
}

function applyViewModule(mode) {
    const next = viewModules.get(mode) || null;
    if (activeViewModule && activeViewModule !== next) activeViewModule.deactivate?.();
    activeViewModule = next;
    activeViewModule?.activate?.();
}

// desktop.js / mobile.js가 자기 자신을 등록한다. 로드 순서에 의존하지 않도록
// 등록 시점이 이미 활성 모드라면 곧바로 활성화한다.
function registerViewModule(name, viewModule) {
    viewModules.set(name, viewModule);
    if (getLayoutMode() === name) applyViewModule(name);
}

function handleNoticeCardArrowKey(event) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    if (document.getElementById('board-view')?.hidden) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (document.querySelector('.overlay[style*="flex"]')) return;

    const cards = Array.from(document.querySelectorAll('#notice-grid .card'));
    if (cards.length === 0) return;
    const current = cards.indexOf(document.activeElement);
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const nextIndex = current === -1
        ? (step === 1 ? 0 : cards.length - 1)
        : (current + step + cards.length) % cards.length;
    const next = cards[nextIndex];
    next.setAttribute('tabindex', '-1');
    next.focus();
    event.preventDefault();
}

let responsiveLayoutMedia = null;

function setLayoutMode(mode) {
    const next = mode === 'mobile' ? 'mobile' : 'desktop';
    if (getLayoutMode() === next) return;
    document.documentElement.setAttribute('data-view', next);

    const viewport = document.getElementById('viewport-meta');
    if (viewport) viewport.setAttribute('content', 'width=device-width, initial-scale=1.0');

    updateLayoutToggleLabel();
    applyViewModule(next);
    renderRightRailAd();
    // 푸터는 뷰마다 관리자 버튼 노출과 동기화 문구가 다르다.
    syncFooterAdminLink();
    refreshFooterSyncStatus();
    // 뷰가 바뀌면 정렬 버튼 폭도 바뀌므로 활성 알약을 다시 맞춘다.
    syncNoticeSortChips();
    syncMobileStickySearch();
    if (document.body?.dataset.page === 'public' && document.getElementById('notice-grid')) {
        renderNoticeCards();
    }
}

function toggleLayoutMode() {
    setLayoutMode(getLayoutMode() === 'desktop' ? 'mobile' : 'desktop');
}

function initializeResponsiveLayout() {
    const forced = new URLSearchParams(location.search).get('view');
    if (forced === 'mobile' || forced === 'desktop') return;
    responsiveLayoutMedia = window.matchMedia('(max-width: 820px)');
    const apply = event => setLayoutMode(event.matches ? 'mobile' : 'desktop');
    if (typeof responsiveLayoutMedia.addEventListener === 'function') {
        responsiveLayoutMedia.addEventListener('change', apply);
    } else {
        responsiveLayoutMedia.addListener?.(apply);
    }
}

function updateLayoutToggleLabel() {
    const button = document.getElementById('view-mode-toggle');
    if (!button) return;
    button.textContent = '모바일 모드';
    button.setAttribute('aria-label', '모바일 화면 미리보기 열기');
}

// ========================================
// 📱 폰 미리보기
// "모바일 모드"는 데스크탑 화면을 모바일로 바꾸는 게 아니라, 데스크탑은 그대로 두고
// 실제 폰 크기 프레임 안에 모바일 화면을 iframe으로 띄운다. 뒤 배경은 흐려진다.
// ========================================

function openDevicePreview() {
    const preview = document.getElementById('device-preview');
    const iframe = document.getElementById('device-iframe');
    if (!preview || !iframe) return;

    // 먼저 보이게 한 뒤 src를 넣는다. hidden(display:none) 상태에서 넣으면
    // 브라우저가 iframe 로드를 미뤄 흰 화면으로 남을 수 있다.
    // 인라인 style은 어떤 스타일시트보다 세므로, 캐시된 옛 CSS가 있어도 확실히 열고 닫힌다.
    preview.hidden = false;
    preview.style.display = 'flex';
    document.body.style.overflow = 'hidden';

    // ?view=mobile 로 iframe 안을 모바일로 강제하고, ?preview=1 로 그 안에서
    // 다시 미리보기 버튼이 뜨지 않게 한다. t 파라미터로 캐시·재사용을 막는다.
    const url = new URL('./index.html', location.href);
    url.searchParams.set('view', 'mobile');
    url.searchParams.set('preview', '1');
    url.searchParams.set('t', String(Date.now()));
    iframe.src = url.toString();

    preview.querySelector('.device-close')?.focus();
}

function closeDevicePreview() {
    const preview = document.getElementById('device-preview');
    const iframe = document.getElementById('device-iframe');
    if (!preview) return;
    preview.hidden = true;
    preview.style.display = 'none';
    document.body.style.overflow = '';
    // iframe을 완전히 멈춰 리소스·소리·타이머가 뒤에서 계속 돌지 않게 한다.
    if (iframe) iframe.src = 'about:blank';
}

function createNoticeViewportLoader(options) {
    const {
        IntersectionObserverCtor,
        resolveUrl,
        defaultUrl
    } = options;
    let thumbnailObserver = null;

    function loadThumbnail(image) {
        const pendingUrl = image?.dataset?.thumbnailSrc;
        if (!pendingUrl) return;
        image.addEventListener('error', () => {
            if (image.dataset.defaultFallbackApplied === 'true') return;
            image.dataset.defaultFallbackApplied = 'true';
            image.closest?.('.card')?.classList.add('is-thumbnail-fallback');
            image.src = defaultUrl;
        });
        image.src = resolveUrl(pendingUrl);
        delete image.dataset.thumbnailSrc;
        thumbnailObserver?.unobserve(image);
    }

    if (IntersectionObserverCtor) {
        thumbnailObserver = new IntersectionObserverCtor(entries => {
            entries.forEach(entry => {
                if (entry.isIntersecting) loadThumbnail(entry.target);
            });
        }, { rootMargin: '0px', threshold: 0.01 });
    }

    function observeThumbnail(image) {
        if (!image?.dataset?.thumbnailSrc) return;
        if (thumbnailObserver) {
            thumbnailObserver.observe(image);
        } else {
            loadThumbnail(image);
        }
    }

    return {
        observeThumbnail
    };
}

const noticeViewportLoader = createNoticeViewportLoader({
    IntersectionObserverCtor: window.IntersectionObserver,
    resolveUrl: value => value.startsWith('/api/') ? buildApiUrl(value) : value,
    defaultUrl: '/icons/default-notice-thumbnail.png'
});

function getNoticeAdminHeaders(tokenOverride = '') {
    const token = (tokenOverride || noticeAdminAuthToken || '').trim();
    return token ? { 'x-admin-token': token } : {};
}

function getSuperAdminHeaders(tokenOverride = '') {
    const token = (tokenOverride || superAdminAuthToken || '').trim();
    return token ? { 'x-super-admin-token': token } : {};
}

function getBannerManageHeaders(tokenOverride = '') {
    const token = (tokenOverride || bannerManageAuthToken || '').trim();
    return token ? { 'x-banner-token': token } : {};
}

async function apiRequest(path, options = {}) {
    const response = await fetch(buildApiUrl(path), {
        ...options,
        // 관리자 세션 쿠키는 API가 다른 사이트에 있어도 따라가야 한다.
        credentials: 'include',
        headers: {
            'Content-Type': 'application/json',
            ...(options.headers || {})
        }
    });

    if (response.status === 204) {
        return null;
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const requestError = new Error(data?.error || `요청 실패 (${response.status})`);
        requestError.status = response.status;
        requestError.code = data?.code || '';
        requestError.retryAfterSeconds = Number(
            data?.retryAfterSeconds || response.headers.get('retry-after') || 0
        );
        throw requestError;
    }
    return data;
}

function createNoticeRepository(request) {
    const pageSize = 16;
    let items = [];
    let pageState = { page: 0, limit: pageSize, total: 0, totalPages: 0 };
    let facetState = { hosts: [] };
    const detailRequests = new Map();

    async function loadPage(page, { replace = false, filters = {} } = {}) {
        const params = new URLSearchParams({
            page: String(page),
            limit: String(pageSize)
        });
        Object.entries(filters).forEach(([key, value]) => {
            if (value !== '' && value !== null && value !== undefined) {
                params.set(key, String(value));
            }
        });
        const result = await request(`/api/notices?${params.toString()}`, { method: 'GET' });
        const incoming = Array.isArray(result?.notices) ? result.notices : [];
        if (replace) {
            items = [...incoming];
        } else {
            const knownIds = new Set(items.map(notice => String(notice.id)));
            items = [
                ...items,
                ...incoming.filter(notice => !knownIds.has(String(notice.id)))
            ];
        }
        pageState = {
            page: Number(result?.pagination?.page) || page,
            limit: Number(result?.pagination?.limit) || pageSize,
            total: Number(result?.pagination?.total) || 0,
            totalPages: Number(result?.pagination?.totalPages) || 0
        };
        facetState = {
            hosts: Array.isArray(result?.facets?.hosts)
                ? result.facets.hosts.map(value => String(value || '').trim()).filter(Boolean)
                : facetState.hosts
        };
        return { notices: items, pagination: pageState, facets: facetState };
    }

    async function getDetail(id) {
        const noticeId = String(id);
        const existing = items.find(notice => String(notice.id) === noticeId);
        if (existing && Object.hasOwn(existing, 'content')) return existing;
        if (detailRequests.has(noticeId)) return detailRequests.get(noticeId);

        const pending = request(`/api/notices/${encodeURIComponent(noticeId)}`, { method: 'GET' })
            .then(result => {
                if (!result?.notice) throw new Error('공지 상세를 불러오지 못했습니다.');
                const index = items.findIndex(notice => String(notice.id) === noticeId);
                if (index === -1) {
                    items.push(result.notice);
                    return result.notice;
                }
                items[index] = { ...items[index], ...result.notice };
                return items[index];
            })
            .finally(() => detailRequests.delete(noticeId));
        detailRequests.set(noticeId, pending);
        return pending;
    }

    return {
        loadPage,
        getDetail,
        get notices() { return items; },
        get pagination() { return pageState; },
        get facets() { return facetState; }
    };
}

const noticeRepository = createNoticeRepository(apiRequest);
let noticePageLoading = false;
let noticeListRequestVersion = 0;
let noticeSearchTimer = null;

function updateNoticePaginationUI(
    pagination = noticeRepository.pagination,
    isLoading = noticePageLoading
) {
    const previous = document.getElementById('notice-page-prev');
    const next = document.getElementById('notice-page-next');
    const numbers = document.getElementById('notice-page-numbers');
    const status = document.getElementById('notice-page-status');
    const container = document.getElementById('notice-pagination');
    if (!previous || !next || !numbers || !status || !container) return;

    const page = Math.max(1, Number(pagination?.page) || 1);
    const totalPages = Number(pagination?.totalPages) || 0;
    const total = Number(pagination?.total) || 0;
    container.hidden = total === 0;
    if (total === 0) {
        previous.hidden = true;
        numbers.hidden = true;
        next.hidden = true;
        numbers.innerHTML = '';
        status.textContent = '';
        return;
    }
    const hasMultiplePages = totalPages > 1;
    const visibleTotalPages = Math.max(1, totalPages);
    const windowSize = 5;
    let start = Math.max(1, page - Math.floor(windowSize / 2));
    const end = Math.min(visibleTotalPages, start + windowSize - 1);
    start = Math.max(1, end - windowSize + 1);

    numbers.innerHTML = Array.from(
        { length: end - start + 1 },
        (_, index) => start + index
    ).map(pageNumber => `
        <button type="button" class="${pageNumber === page ? 'active' : ''}"
                aria-label="${pageNumber}페이지" aria-current="${pageNumber === page ? 'page' : 'false'}"
                onclick="goToNoticePage(${pageNumber})"
                ${isLoading ? 'disabled' : ''}>${pageNumber}</button>
    `).join('');
    previous.hidden = !hasMultiplePages;
    numbers.hidden = !hasMultiplePages;
    next.hidden = !hasMultiplePages;
    previous.disabled = Boolean(isLoading) || page <= 1 || totalPages === 0;
    next.disabled = Boolean(isLoading) || totalPages === 0 || page >= totalPages;
    status.textContent = totalPages > 0
        ? `${page} / ${totalPages} 페이지 · 전체 ${total}건`
        : '';
}

function getNoticeListFilters() {
    return {
        category: [...selectedCategoryFilters].join(','),
        search: document.getElementById('searchInput')?.value.trim() || '',
        target: document.getElementById('targetFilter')?.value || '전체',
        deadlineStatus: filterState['deadline-status'],
        host: filterState.host,
        views: filterState.views,
        sort: filterState.sort,
        dateFrom: document.getElementById('filter-date-from')?.value || '',
        dateTo: document.getElementById('filter-date-to')?.value || '',
        source: includeRelatedNotices ? '전체' : 'manual',
        urgent: quickNoticeFilters.urgent,
        reward: quickNoticeFilters.reward,
        action: quickNoticeFilters.action,
        past: quickNoticeFilters.past
    };
}

async function loadNoticePage(page, { replace = true } = {}) {
    const result = await noticeRepository.loadPage(page, {
        replace,
        filters: getNoticeListFilters()
    });
    notices = result.notices;
    updateNoticePaginationUI(result.pagination, noticePageLoading);
    return result;
}

async function goToNoticePage(page) {
    const targetPage = Number(page);
    const totalPages = Number(noticeRepository.pagination.totalPages) || 0;
    if (noticePageLoading || !Number.isInteger(targetPage)
        || targetPage < 1 || targetPage > totalPages
        || targetPage === noticeRepository.pagination.page) return;

    noticePageLoading = true;
    updateNoticePaginationUI(noticeRepository.pagination, true);
    try {
        if (compareBlocks.length > 0) {
            compareBlocks = [];
            compareWorkspaceOpen = false;
            compareLayoutMode = 'stack';
        }
        await loadNoticePage(targetPage);
        buildHostButtons();
        renderNoticeCards();
        syncNoticeListUrl(targetPage);
        document.getElementById('spatial-workspace')
            ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
        console.error('공지 페이지 이동 실패:', error);
        alert('공지 페이지를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.');
    } finally {
        noticePageLoading = false;
        updateNoticePaginationUI(noticeRepository.pagination, false);
    }
}

function goToPreviousNoticePage() {
    return goToNoticePage((Number(noticeRepository.pagination.page) || 1) - 1);
}

function goToNextNoticePage() {
    return goToNoticePage((Number(noticeRepository.pagination.page) || 1) + 1);
}

async function getNoticeDetail(id) {
    const notice = await noticeRepository.getDetail(id);
    notices = noticeRepository.notices;
    return notice;
}

// ========================================
// 💾 초기 데이터 로드
// ========================================

async function loadData() {
    noticeAdminAuthToken = sessionStorage.getItem('eceNoticeAdminToken') || sessionStorage.getItem('eceAdminToken') || '';
    superAdminAuthToken = sessionStorage.getItem('eceSuperAdminToken') || '';
    bannerManageAuthToken = sessionStorage.getItem('eceBannerManageToken') || '';

    const settingsTask = apiRequest('/api/settings', { method: 'GET' })
        .then(settings => {
            if (settings?.adminInfo) {
                adminInfo = {
                    name: settings.adminInfo.name || adminInfo.name,
                    phone: settings.adminInfo.phone || adminInfo.phone,
                    kakao: settings.adminInfo.kakao || adminInfo.kakao
                };
            }
            if (settings?.bannerInfo) {
                bannerAdminInfo = {
                    name: settings.bannerInfo.name || bannerAdminInfo.name,
                    phone: settings.bannerInfo.phone || bannerAdminInfo.phone,
                    kakao: settings.bannerInfo.kakao || bannerAdminInfo.kakao
                };
            }
        })
        .catch(error => console.error('관리자 설정 불러오기 실패:', error));

    await Promise.all([settingsTask, loadBannerSlides()]);
    startBannerPolling();
}

// 엠블럼은 어디서 눌러도 쿼리·해시·상세 상태가 없는 홈을 새 문서로 다시 연다.
function goHomeAndReload() {
    window.location.assign(window.location.pathname);
}

async function loadBannerSlides(includeUnpublished = false) {
    try {
        const result = await apiRequest(includeUnpublished ? '/api/banner-slides/manage' : '/api/banner-slides', {
            method: 'GET',
            headers: includeUnpublished ? getBannerManageHeaders() : {}
        });
        if (Array.isArray(result?.slides)) {
            bannerSlides = result.slides;
            randomizeInitialBanner();
            renderRightRailAd();
        }
    } catch (error) {
        console.error('배너 슬라이드 로드 실패:', error);
        // 배너 로드 실패 시 기본 안내 문구 유지
    }
}

let bannerPollingInterval = null;

function startBannerPolling() {
    // 30초마다 배너 업데이트 확인
    bannerPollingInterval = setInterval(async () => {
        try {
            const result = await apiRequest('/api/banner-slides', { method: 'GET' });
            if (Array.isArray(result?.slides)) {
                const newSlides = result.slides;
                if (JSON.stringify(bannerSlides) !== JSON.stringify(newSlides)) {
                    bannerSlides = newSlides;
                    randomizeInitialBanner();
                    renderRightRailAd();
                }
            }
        } catch (error) {
            console.error('배너 폴링 오류:', error);
        }
    }, 30000);
}

function stopBannerPolling() {
    if (bannerPollingInterval) {
        clearInterval(bannerPollingInterval);
        bannerPollingInterval = null;
    }
}

function getBannerSlidesByPlacement(placement) {
    return bannerSlides
        .filter(slide => (slide.placement || 'header') === placement)
        .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
}

function randomizeInitialBanner() {
    if (initialBannerRandomized) return;
    const slides = getBannerSlidesByPlacement('right_rail').slice(0, 5);
    if (!slides.length) return;
    activeBannerSlideIndex = Math.floor(Math.random() * slides.length);
    initialBannerRandomized = true;
}

function stopBannerRotation() {
    if (!bannerRotationInterval) return;
    clearInterval(bannerRotationInterval);
    bannerRotationInterval = null;
}

function startBannerRotation() {
    stopBannerRotation();
    if (getBannerSlidesByPlacement('right_rail').slice(0, 5).length < 2) return;
    bannerRotationInterval = window.setInterval(() => {
        stepRightRailBanner(1);
    }, BANNER_ROTATION_DELAY);
}

function prefersReducedMotion() {
    return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

function getBannerTrack() {
    return document.querySelector('#right-rail-ad-content .rail-ad-track');
}

/* 트랙을 특정 칸으로 옮긴다. animate=false면 전환 없이 즉시 붙여 놓는데,
   복제 슬라이드에서 진짜 슬라이드로 되돌아갈 때 이 경로를 쓴다. */
function setBannerTrackPosition(position, { animate = true, dragOffset = 0 } = {}) {
    const track = getBannerTrack();
    if (!track) return;
    const shouldAnimate = animate && !prefersReducedMotion();
    track.style.transitionDuration = shouldAnimate ? `${BANNER_SLIDE_DURATION}ms` : '0ms';
    track.style.transform = dragOffset
        ? `translate3d(calc(${-position * 100}% + ${dragOffset}px), 0, 0)`
        : `translate3d(${-position * 100}%, 0, 0)`;
}

function syncBannerIndicator() {
    const container = document.getElementById('right-rail-ad-content');
    if (!container) return;
    const counter = container.querySelector('.rail-ad-count');
    if (counter) counter.textContent = `${activeBannerSlideIndex + 1} / ${bannerRenderedCount}`;
    container.querySelectorAll('.rail-ad-dot').forEach((dot, index) => {
        const active = index === activeBannerSlideIndex;
        dot.classList.toggle('is-active', active);
        dot.setAttribute('aria-current', active ? 'true' : 'false');
    });
    // 복제 슬라이드가 화면에 보이는 순간에도 보조기기에는 진짜 슬라이드만 읽힌다.
    container.querySelectorAll('.rail-ad-slide').forEach(slide => {
        const isClone = slide.dataset.clone === 'true';
        const isCurrent = Number(slide.dataset.index) === activeBannerSlideIndex;
        slide.setAttribute('aria-hidden', isClone || !isCurrent ? 'true' : 'false');
    });
}

/* 이웃한 칸으로 한 칸 민다. 복제 칸에 도착하면 전환이 끝난 직후
   같은 그림의 진짜 칸으로 소리 없이 되돌려, 무한히 이어지는 것처럼 보인다.
   쉬는 자리는 언제나 1..total이므로 한 칸 이동은 트랙을 벗어나지 않는다. */
function stepRightRailBanner(direction, event) {
    event?.preventDefault();
    event?.stopPropagation();
    const step = Number(direction || 0) < 0 ? -1 : 1;
    const total = bannerRenderedCount;
    if (!Number(direction) || total < 2 || !getBannerTrack()) return;

    window.clearTimeout(bannerSettleTimer);
    bannerSettleTimer = null;
    bannerTrackPosition += step;
    activeBannerSlideIndex = (activeBannerSlideIndex + step + total) % total;
    setBannerTrackPosition(bannerTrackPosition);
    syncBannerIndicator();

    const landedOnClone = bannerTrackPosition === 0 || bannerTrackPosition === total + 1;
    if (landedOnClone) {
        bannerSettleTimer = window.setTimeout(() => {
            bannerTrackPosition = activeBannerSlideIndex + 1;
            setBannerTrackPosition(bannerTrackPosition, { animate: false });
            bannerSettleTimer = null;
        }, prefersReducedMotion() ? 0 : BANNER_SLIDE_DURATION);
    }
}

/* 점을 눌러 멀리 있는 배너로 건너뛴다. 여러 칸을 한 번에 지나가므로
   복제 칸을 거치지 않고 진짜 칸으로 곧장 미끄러진다. */
function selectRightRailBanner(index) {
    const total = bannerRenderedCount;
    if (total < 2 || !getBannerTrack()) return;
    const target = ((Number(index) || 0) % total + total) % total;
    if (target === activeBannerSlideIndex) return;

    window.clearTimeout(bannerSettleTimer);
    bannerSettleTimer = null;
    activeBannerSlideIndex = target;
    bannerTrackPosition = target + 1;
    setBannerTrackPosition(bannerTrackPosition);
    syncBannerIndicator();
    restartBannerRotationIfIdle();
}

function restartBannerRotationIfIdle() {
    if (bannerSwipePointerId !== null) return;
    startBannerRotation();
}

function startBannerSwipe(event) {
    if (event.isPrimary === false || event.button > 0) return;
    if (bannerRenderedCount < 2) return;
    // 화살표나 점을 누른 것이라면 끌기를 시작하지 않는다. 여기서 포인터를
    // 붙잡으면 이어지는 pointerup이 무대로 끌려가 버튼의 click이 사라진다.
    if (event.target.closest?.('.rail-ad-controls, .rail-ad-status')) return;
    const stage = event.currentTarget;
    bannerSwipePointerId = event.pointerId;
    bannerSwipeStartX = event.clientX;
    bannerSwipeStartY = event.clientY;
    bannerSwipeDeltaX = 0;
    bannerSwipeStartedAt = Date.now();
    // 복제 칸으로 되돌리는 예약이 남아 있으면 먼저 확정해 놓고 잡는다.
    if (bannerSettleTimer) {
        window.clearTimeout(bannerSettleTimer);
        bannerSettleTimer = null;
        bannerTrackPosition = activeBannerSlideIndex + 1;
        setBannerTrackPosition(bannerTrackPosition, { animate: false });
    }
    try {
        stage.setPointerCapture?.(event.pointerId);
    } catch {
        // 합성 이벤트나 이미 취소된 포인터에서는 캡처가 거절될 수 있다.
    }
    stopBannerRotation();
}

function moveBannerSwipe(event) {
    if (event.pointerId !== bannerSwipePointerId) return;
    const deltaX = event.clientX - bannerSwipeStartX;
    const deltaY = event.clientY - bannerSwipeStartY;
    // 세로로 먼저 움직였으면 페이지 스크롤이므로 가로 끌기를 포기한다.
    // 손가락은 마우스보다 비스듬히 움직이므로 세로가 가로보다 확실히 클 때만
    // 놓아준다. 조금만 흔들려도 포기하면 잘 안 넘어간다는 느낌을 준다.
    if (!bannerSwipeDeltaX && Math.abs(deltaY) > Math.abs(deltaX) * 1.5 && Math.abs(deltaY) > 14) {
        bannerSwipePointerId = null;
        setBannerTrackPosition(bannerTrackPosition);
        event.currentTarget.classList.remove('is-swiping');
        restartBannerRotationIfIdle();
        return;
    }
    bannerSwipeDeltaX = deltaX;
    if (Math.abs(deltaX) < 3) return;
    if (event.cancelable) event.preventDefault();
    event.currentTarget.classList.add('is-swiping');

    // 양 끝이 없는 무한 트랙이므로 손가락을 1:1로 따라간다.
    setBannerTrackPosition(bannerTrackPosition, { animate: false, dragOffset: deltaX });
}

function finishBannerSwipe(event, cancelled = false) {
    if (event.pointerId !== bannerSwipePointerId) return;
    const stage = event.currentTarget;
    const width = stage.getBoundingClientRect().width || 1;
    const deltaY = event.clientY - bannerSwipeStartY;
    // 폭의 12%나 32px만 끌어도 넘어간다. 예전 값(18%·44px)은 폰에서 한 번에
    // 넘기기 어려웠다.
    const distance = Math.abs(bannerSwipeDeltaX);
    const passedThreshold = distance >= Math.min(32, width * 0.12);
    // 짧게 튕겨도 넘어가야 한다. 빠른 손짓은 거리가 짧아도 넘길 뜻이 분명하다.
    const elapsed = Math.max(1, Date.now() - bannerSwipeStartedAt);
    const flicked = distance >= 12 && distance / elapsed > 0.45;
    const shouldMove = !cancelled
        && (passedThreshold || flicked)
        && distance > Math.abs(deltaY);
    try {
        if (stage.hasPointerCapture?.(event.pointerId)) {
            stage.releasePointerCapture(event.pointerId);
        }
    } catch {
        // 포인터가 브라우저에서 먼저 취소된 경우에도 정리 흐름은 계속한다.
    }
    stage.classList.remove('is-swiping');
    bannerSwipePointerId = null;

    if (shouldMove) {
        // 끌어서 넘긴 직후의 클릭은 링크 이동이 아니라 제스처의 잔상이다.
        suppressBannerLinkUntil = Date.now() + 400;
        stepRightRailBanner(bannerSwipeDeltaX < 0 ? 1 : -1, event);
    } else {
        if (Math.abs(bannerSwipeDeltaX) > 6) suppressBannerLinkUntil = Date.now() + 250;
        setBannerTrackPosition(bannerTrackPosition);
    }
    bannerSwipeDeltaX = 0;
    restartBannerRotationIfIdle();
}

function allowBannerLinkClick(event) {
    if (Date.now() >= suppressBannerLinkUntil) return true;
    event.preventDefault();
    event.stopPropagation();
    return false;
}

function renderRightRailInquiryFallback() {
    const container = document.getElementById('right-rail-ad-content');
    if (!container) return;
    stopBannerRotation();
    window.clearTimeout(bannerSettleTimer);
    bannerSettleTimer = null;
    bannerRenderedCount = 0;
    container.onmouseenter = null;
    container.onmouseleave = null;

    container.innerHTML = `<button class="rail-cta rail-ad-fallback" type="button"
        onclick="openBannerInquiryFromRail()">홍보 신청하기</button>`;
}

/* 슬라이드 한 장의 마크업. isClone은 앞뒤로 덧대는 복제본 표시로,
   보조기기에서는 감추고 지표 계산에서도 제외한다. */
function renderBannerSlide(slide, index, { isClone = false } = {}) {
    const useMobileBanner = document.documentElement.dataset.view === 'mobile';
    const src = useMobileBanner ? slide.mobileSrc : slide.src;
    if (!src) return '';
    const alt = isClone ? '' : escapeHtml(slide.altText || slide.name || '학내 홍보 이미지');
    /* 배너는 자리를 남김없이 채운다. 예전에는 원본이 4:5라 레일보다 훨씬
       짧아 흐린 배경을 뒤에 깔아 메웠는데, 그 경계가 테두리처럼 보였다.
       권장 비율을 레일과 같은 3:10으로 정했으므로 이제는 잘라 채워도
       잘려 나가는 부분이 거의 없다. 비율이 어긋난 그림은 등록할 때 경고한다. */
    // 트랙 밖 슬라이드는 lazy로 두면 처음 넘길 때 한 프레임 비므로 모두 즉시 받는다.
    // 배너는 최대 5장이라 부담이 크지 않다.
    const image = `<img class="rail-ad-image" src="${escapeHtml(src)}" alt="${alt}"
            draggable="false" onerror="handleBannerImageError(event)">`;
    const body = slide.linkUrl
        ? `<a class="rail-ad-link rail-ad-image-link" href="${escapeHtml(slide.linkUrl)}" target="_blank"
                rel="noopener noreferrer" draggable="false"
                tabindex="${isClone ? '-1' : '0'}"
                onclick="return allowBannerLinkClick(event)">${image}</a>`
        : image;
    return `<div class="rail-ad-slide" data-index="${index}" data-clone="${isClone}">${body}</div>`;
}

function handleBannerImageError(event) {
    // 이미지 하나가 깨졌다고 캐러셀 전체를 버리지 않는다. 남은 배너가
    // 하나도 없을 때만 홍보 신청 안내로 떨어진다.
    const slide = event?.target?.closest('.rail-ad-slide');
    if (!slide) return renderRightRailInquiryFallback();
    slide.classList.add('is-broken');
    const alive = document.querySelectorAll('#right-rail-ad-content .rail-ad-slide:not(.is-broken)');
    if (alive.length === 0) renderRightRailInquiryFallback();
}

function renderRightRailAd({ restartRotation = true } = {}) {
    const container = document.getElementById('right-rail-ad-content');
    if (!container) return;
    const slides = getBannerSlidesByPlacement('right_rail').slice(0, 5);
    const useMobileBanner = document.documentElement.dataset.view === 'mobile';
    const usable = slides.filter(slide => (useMobileBanner ? slide.mobileSrc : slide.src));

    if (!usable.length) {
        renderRightRailInquiryFallback();
        return;
    }

    window.clearTimeout(bannerSettleTimer);
    bannerSettleTimer = null;
    bannerRenderedCount = usable.length;
    if (activeBannerSlideIndex >= usable.length) activeBannerSlideIndex = 0;

    const many = usable.length > 1;
    // 무한 루프를 위해 앞에는 마지막 장, 뒤에는 첫 장의 복제본을 덧댄다.
    const trackSlides = many
        ? [
            renderBannerSlide(usable[usable.length - 1], usable.length - 1, { isClone: true }),
            ...usable.map((slide, index) => renderBannerSlide(slide, index)),
            renderBannerSlide(usable[0], 0, { isClone: true })
        ].join('')
        : renderBannerSlide(usable[0], 0);

    const controls = many ? `
        <div class="rail-ad-controls" role="group" aria-label="배너 넘기기">
            <button class="rail-ad-arrow is-prev" type="button" aria-label="이전 배너" title="이전 배너"
                    onclick="stepRightRailBanner(-1, event); restartBannerRotationIfIdle()">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M15 5l-7 7 7 7"/></svg>
            </button>
            <button class="rail-ad-arrow is-next" type="button" aria-label="다음 배너" title="다음 배너"
                    onclick="stepRightRailBanner(1, event); restartBannerRotationIfIdle()">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
            </button>
        </div>
        <div class="rail-ad-status">
            <div class="rail-ad-dots" role="tablist" aria-label="배너 선택">
                ${usable.map((slide, index) => `
                    <button class="rail-ad-dot" type="button" role="tab" data-index="${index}"
                            aria-label="${index + 1}번째 배너 보기"
                            onclick="selectRightRailBanner(${index})"></button>
                `).join('')}
            </div>
            <span class="rail-ad-count" aria-live="off"></span>
        </div>
    ` : '';

    container.innerHTML = `
        <div class="rail-ad-viewport">
            <div class="rail-ad-stage"${many ? `
                 onpointerdown="startBannerSwipe(event)"
                 onpointermove="moveBannerSwipe(event)"
                 onpointerup="finishBannerSwipe(event)"
                 onpointercancel="finishBannerSwipe(event, true)"` : ''}>
                <div class="rail-ad-track">${trackSlides}</div>
                ${controls}
            </div>
        </div>
    `;

    if (many) {
        bannerTrackPosition = activeBannerSlideIndex + 1;
        setBannerTrackPosition(bannerTrackPosition, { animate: false });
        syncBannerIndicator();
        container.onmouseenter = stopBannerRotation;
        container.onmouseleave = restartBannerRotationIfIdle;
        if (restartRotation) startBannerRotation();
    } else {
        stopBannerRotation();
        container.onmouseenter = null;
        container.onmouseleave = null;
    }
}

// ========================================
// 🧾 사이트 푸터 (링크 그리드 · 수집 신선도 · 법적 고지)
// ========================================

// 마지막 수집이 이 시간을 넘기면 "동기화 지연"으로 본다.
const FOOTER_SYNC_STALE_HOURS = 6;
let footerAdminLinkNode = null;

function formatSyncTimestamp(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const pad = number => String(number).padStart(2, '0');
    return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`
        + ` ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/* 색만으로 상태를 구분하지 않는다. 문구와 아이콘이 함께 바뀐다. */
function applyFooterSyncState({ state, label, detail }) {
    const box = document.getElementById('footer-sync');
    const labelEl = document.getElementById('footer-sync-label');
    const detailEl = document.getElementById('footer-sync-detail');
    if (!box || !labelEl || !detailEl) return;
    box.dataset.state = state;
    labelEl.textContent = label;
    detailEl.textContent = detail;

    const icon = box.querySelector('.footer-sync-icon path');
    if (!icon) return;
    const paths = {
        ok: 'M20 11a8 8 0 0 0-14-4.9L4 8m0-4v4h4m-4 5a8 8 0 0 0 14 4.9l2-1.9m0 4v-4h-4',
        stale: 'M12 7v5l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
        failed: 'M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z'
    };
    icon.setAttribute('d', paths[state] || paths.ok);
}

async function refreshFooterSyncStatus() {
    if (!document.getElementById('footer-sync')) return;
    try {
        const result = await apiRequest('/api/sync-status', { method: 'GET' });
        const count = Number(result?.noticeCount) || 0;
        const stamp = result?.lastSyncedAt ? new Date(result.lastSyncedAt) : null;

        if (!stamp || Number.isNaN(stamp.getTime())) {
            applyFooterSyncState({
                state: 'failed',
                label: '동기화 실패',
                detail: '최근 수집 기록을 찾지 못했습니다'
            });
            return;
        }

        const hoursSince = (Date.now() - stamp.getTime()) / 3600000;
        const stale = hoursSince > FOOTER_SYNC_STALE_HOURS;
        applyFooterSyncState({
            state: stale ? 'stale' : 'ok',
            label: stale ? '동기화 지연' : '최신 상태',
            detail: getLayoutMode() === 'mobile'
                ? `${formatSyncTimestamp(stamp)} 동기화`
                : `마지막 동기화 ${formatSyncTimestamp(stamp)} · 수집 공지 ${count}건`
        });
    } catch {
        applyFooterSyncState({
            state: 'failed',
            label: '동기화 실패',
            detail: '수집 상태를 불러오지 못했습니다'
        });
    }
}

/* 관리자 진입점은 모바일에서 숨기는 게 아니라 DOM에서 아예 뺀다.
   데스크톱으로 돌아오면 보관해 둔 노드를 그대로 다시 붙인다. */
function syncFooterAdminLink() {
    const legal = document.querySelector('.site-footer-legal');
    if (!legal) return;
    const existing = document.getElementById('footer-admin-link');

    if (getLayoutMode() === 'mobile') {
        if (existing) {
            footerAdminLinkNode = existing;
            existing.remove();
        }
        return;
    }
    if (!existing && footerAdminLinkNode) legal.appendChild(footerAdminLinkNode);
}

function initializeFooter() {
    const year = document.getElementById('footer-year');
    if (year) year.textContent = String(new Date().getFullYear());
    syncFooterAdminLink();
    refreshFooterSyncStatus();
}

// ========================================
// 🎯 유틸 함수
// ========================================

function copyToClipboard(text) { navigator.clipboard.writeText(text).then(() => { alert("전화번호가 복사되었습니다: " + text); }).catch(err => { alert("복사에 실패했습니다. 브라우저 설정을 확인해주세요."); }); }
function copyAdminPhone() { copyToClipboard(adminInfo.phone); }
function copyBannerPhone() { copyToClipboard(bannerAdminInfo.phone); }
function getBase64(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.readAsDataURL(file); reader.onload = () => resolve(reader.result); reader.onerror = e => reject(e); }); }

function getCalendarDayDifference(firstDate, secondDate) {
    const firstDay = Date.UTC(firstDate.getFullYear(), firstDate.getMonth(), firstDate.getDate());
    const secondDay = Date.UTC(secondDate.getFullYear(), secondDate.getMonth(), secondDate.getDate());
    return (firstDay - secondDay) / 86400000;
}

function calcDDay(deadlineStr) {
    if (!deadlineStr) return { text: "상시", isUrgent: false, isD1: false, isExpired: false };
    const diffDays = getCalendarDayDifference(new Date(deadlineStr + "T00:00:00"), getCurrentDate());
    if (diffDays < 0) return { text: "마감됨", isUrgent: false, isD1: false, isExpired: true };
    if (diffDays === 0) return { text: "오늘 마감", isUrgent: true, isD1: false, isExpired: false };
    if (diffDays === 1) return { text: "D-1", isUrgent: true, isD1: true, isExpired: false };
    if (diffDays <= 3) return { text: `D-${diffDays}`, isUrgent: true, isD1: false, isExpired: false };
    return { text: `D-${diffDays}`, isUrgent: false, isD1: false, isExpired: false };
}

/* 상세 화면 윗줄. 날짜가 없는 공지에서 구분자만 덩그러니 남지 않도록 조립한다.
   목록에는 열려 있는 기간만 적지만, 상세에서는 이 공지가 언제 올라온 것인지도
   알 수 있어야 한다. 오래된 공지를 보고 있는지 판단하는 근거가 된다. */
function formatDetailMeta(dateLabel, views, registeredOn = '') {
    const parts = [];
    if (dateLabel) parts.push(escapeHtml(dateLabel));
    if (registeredOn) parts.push(`등록 ${escapeHtml(formatDateWithWeekday(registeredOn))}`);
    parts.push(`조회: ${Number(views) || 0}`);
    return parts.join(' &nbsp;|&nbsp; ');
}

function renderDetailDates(notice) {
    const target = document.getElementById('detail-dates');
    if (!target) return;
    const registered = noticeRegisteredOn(notice);
    const start = String(notice.startDate || '').slice(0, 10);
    const deadline = String(notice.deadlineAt || notice.deadline || '').slice(0, 10);
    const rows = [
        registered && ['등록일', registered],
        start && ['시행·접수 시작일', start],
        deadline && ['마감일', deadline]
    ].filter(Boolean);
    target.hidden = rows.length === 0;
    target.innerHTML = rows.map(([label, date]) => `<div><dt>${label}</dt><dd>${escapeHtml(formatDateWithWeekday(date))}</dd></div>`).join('');
}

/* 공지에 붙는 날짜.

   학생이 알고 싶은 것은 '언제 열려 있는가'다. 그래서 마감일이 있으면
   시작과 끝을 함께 적어 기간으로 보여준다. 시작일이 따로 없는 공지가 많은데,
   그런 때는 공지가 올라온 날부터 열려 있었다고 보는 것이 사실에 가까우므로
   등록일을 시작 자리에 세운다. 마감이 없고 날짜 하나만 있는 행사는 그 하루만
   적는다.

   시작과 끝이 같은 날이면 물결표로 잇지 않는다. 같은 날짜를 두 번 적는 셈이라
   읽는 사람이 기간으로 오해한다. */
function noticeRegisteredOn(notice) {
    return String(notice.sourcePublishedAt || notice.createdAt || '').slice(0, 10);
}

function getNoticeDatePresentation(notice) {
    const deadline = String(notice.deadlineAt || notice.deadline || '').slice(0, 10);
    const start = String(notice.startDate || '').slice(0, 10);
    const registered = noticeRegisteredOn(notice);

    if (notice.isAlwaysOpen) {
        return { badgeText: '상시', badgeClass: '', dateLabel: '' };
    }

    if (!deadline) {
        // 마감이 없으면 행사가 열리는 날 하나만 알린다.
        return {
            badgeText: '',
            badgeClass: '',
            dateLabel: start ? formatDateWithWeekday(start) : ''
        };
    }

    const from = start || registered;
    const dDay = calcDDay(deadline);
    const badge = {
        badgeText: dDay.text,
        badgeClass: dDay.isExpired ? 'expired' : (dDay.isUrgent ? 'd-day' : '')
    };

    // 시작이 마감보다 뒤면 잘못 들어온 값이다. 그럴 때는 마감만 적는다.
    if (!from || from >= deadline) {
        return { ...badge, dateLabel: formatDateWithWeekday(deadline) };
    }
    return {
        ...badge,
        dateLabel: `${formatDateWithWeekday(from)} ~ ${formatDateWithWeekday(deadline)}`
    };
}

function matchesDeadlineStatus(deadlineStatus, dDay, hasDeadline) {
    if (deadlineStatus === '전체') return true;
    if (deadlineStatus === '진행중') return !dDay.isExpired;
    if (deadlineStatus === '마감임박') return dDay.isUrgent && !dDay.isExpired;
    if (deadlineStatus === '상시') return !hasDeadline;
    if (deadlineStatus === '마감됨') return dDay.isExpired;
    return true;
}

// 서울대 소식처럼 요일까지 붙인 날짜. "2026.07.27(월)" 형태.
const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];
let railClockTimer = null;

function updateRailClock(now = new Date()) {
    const time = document.getElementById('rail-clock-time');
    const date = document.getElementById('rail-clock-date');
    if (!time || !date) return;
    time.textContent = new Intl.DateTimeFormat('ko-KR', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).format(now);
    date.textContent = new Intl.DateTimeFormat('ko-KR', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        weekday: 'long'
    }).format(now);
}

function startRailClock() {
    updateRailClock();
    if (railClockTimer) clearInterval(railClockTimer);
    railClockTimer = setInterval(updateRailClock, 1000);
}

function formatDateWithWeekday(value) {
    if (!value) return '';
    // 'YYYY-MM-DD'는 로컬 자정으로 파싱해 시간대에 따라 하루가 밀리지 않게 한다.
    const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? new Date(value + 'T00:00:00')
        : new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}.${m}.${d}(${WEEKDAY_KO[date.getDay()]})`;
}

// 공지 제목·기관·배너 문구는 관리자가 자유롭게 입력하므로, HTML로 조립하기 전에 반드시 이스케이프한다.
// 따옴표까지 처리해야 value="..." 같은 속성 안에 넣어도 빠져나가지 못한다.
function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/* 사진 없는 공지는 포스터 자리에 제목을 크게 싣는다. 제목 길이는 천차만별인데
   글자 크기를 고정해 두면 긴 제목이 상자를 넘쳐 카드가 깨진다.
   길이에 맞춰 크기·줄 수·한 줄 글자 수를 함께 정해, 어떤 제목이 와도
   상자 안에 들어오게 한다. 아래 값들은 포스터 안쪽 높이(약 172px)를
   넘지 않도록 잡은 것이다. */
/* perLine은 한 줄에 들어가는 한글 글자 수다. 포스터 안쪽 폭을 좁게 잡아
   200px으로 보고 floor(200 / 글자크기)로 정했다. 이 값이 한 칸이라도
   크면 줄이 브라우저에서 한 번 더 접혀 높이가 두 배가 된다.
   maxLines는 가로줄과 등록일이 자리를 차지한 뒤 남는 높이(약 143px)에서
   maxLines x 글자크기 x 1.34가 넘지 않도록 잡았다. */
function posterTitleFit(length) {
    if (length <= 22) return { size: 25, maxLines: 4, perLine: 8 };
    if (length <= 36) return { size: 21, maxLines: 5, perLine: 9 };
    if (length <= 52) return { size: 18, maxLines: 5, perLine: 11 };
    return { size: 16, maxLines: 6, perLine: 12 };
}

/* 한 줄에 몇 글자가 들어가는지는 글자 폭에 달렸다. 한글·한자는 글자 크기와
   폭이 거의 같지만 알파벳과 숫자는 그 절반쯤이다. 글자 수를 그대로 세면
   영문 제목이 실제보다 길다고 잘못 판단해 불필요하게 줄이 쪼개진다. */
function posterTextWidth(value) {
    let width = 0;
    for (const char of String(value || '')) {
        width += /[ᄀ-ᇿ㄰-㆏가-힯　-〿一-鿿＀-￯]/.test(char)
            ? 1
            : 0.55;
    }
    return width;
}

function posterTitleLines(value, maxLines = 4, perLine = 0) {
    const normalized = String(value || '제목 없음').replace(/\s+/g, ' ').trim();
    const lines = [];
    const hostMatch = normalized.match(/^(\[[^\]]+\])\s*(.*)$/);
    let remainder = normalized;
    if (hostMatch) {
        lines.push(hostMatch[1]);
        remainder = hostMatch[2];
    }

    let words = remainder.split(' ').filter(Boolean)
        .filter((word, index, all) => index === 0 || word !== all[index - 1]);
    // 띄어쓰기 없이 아주 긴 낱말은 낱말 단위로는 쪼갤 수 없어 한 줄에 몰린다.
    // 그대로 두면 브라우저가 제멋대로 접어 상자를 넘치므로 미리 끊어 둔다.
    const wordCeiling = perLine || 18;
    words = words.flatMap(word => {
        if (posterTextWidth(word) <= wordCeiling) return [word];
        const chunks = [];
        let chunk = '';
        for (const char of word) {
            if (posterTextWidth(chunk + char) > wordCeiling && chunk) {
                chunks.push(chunk);
                chunk = char;
            } else {
                chunk += char;
            }
        }
        if (chunk) chunks.push(chunk);
        return chunks;
    });
    const titleEndings = new Set(['모집', '안내', '신청', '접수', '공지', '행사', '발표', '연장']);
    let endingLine = '';
    if (words.length >= 3 && titleEndings.has(words.at(-1))) {
        endingLine = words.slice(-2).join(' ');
        words = words.slice(0, -2);
    }
    const availableLines = Math.max(1, maxLines - lines.length - (endingLine ? 1 : 0));
    // 한 줄에 실을 폭은 글자 크기에서 나온다. 넘겨받지 않았을 때만
    // 예전처럼 내용 길이로 어림한다.
    const ceiling = perLine || 18;
    // 8.5는 한글 8자 반쯤의 폭이다. 이보다 짧게 끊으면 낱말 하나가
    // 한 줄을 차지해 오히려 어색해진다.
    const targetLength = Math.max(
        Math.min(8.5, ceiling),
        Math.min(ceiling, Math.ceil(
            words.reduce((sum, word) => sum + posterTextWidth(word) + 0.55, 0) / availableLines
        ))
    );
    let current = '';

    words.forEach((word, index) => {
        const candidate = current ? `${current} ${word}` : word;
        // 남은 줄이 없다고 해서 나머지를 한 줄에 몰아넣으면 그 줄이 끝없이
        // 길어져 상자를 넘친다. 폭을 넘으면 언제나 줄을 바꾸고,
        // 넘치는 줄은 아래에서 잘라낸다.
        if (current && posterTextWidth(candidate) > targetLength) {
            lines.push(current);
            current = word;
        } else {
            current = candidate;
        }
        if (index === words.length - 1 && current) lines.push(current);
    });
    if (endingLine) lines.push(endingLine);

    if (lines.length <= maxLines) return lines;
    // 다 담지 못했으면 잘렸다는 걸 말줄임으로 알린다. 이때 말줄임표도 폭을
    // 차지하므로, 붙이고 나서 한 줄 한도를 넘지 않도록 뒤를 먼저 덜어낸다.
    // 그냥 붙이면 그 줄이 한 번 더 접혀 포스터를 넘친다.
    const kept = lines.slice(0, maxLines);
    const budget = (perLine || 18) - posterTextWidth('…');
    let last = kept.at(-1);
    while (last.length > 1 && posterTextWidth(last) > budget) last = last.slice(0, -1);
    kept[kept.length - 1] = `${last.trimEnd()}…`;
    return kept;
}

function renderPosterTitle(value) {
    const normalized = String(value || '제목 없음').replace(/\s+/g, ' ').trim();
    const fit = posterTitleFit(normalized.length);
    const lines = posterTitleLines(normalized, fit.maxLines, fit.perLine)
        .map(line => `<span class="card-poster-title-line${/^\[[^\]]+\]$/.test(line) ? ' is-host' : ''}">${escapeHtml(line)}</span>`)
        .join('');
    // 크기는 인라인 변수로 넘기고 실제 적용은 CSS가 한다.
    // 모바일은 같은 변수에 배율만 곱해 쓴다.
    return `<p class="card-poster-title" style="--poster-title-size:${fit.size}px">${lines}</p>`;
}

/* 미리보기는 position: fixed라 한 번 자리를 잡으면 화면에 붙어 버린다.
   그 상태로 페이지를 스크롤하면 카드만 움직여 둘 사이 간격이 계속 벌어진다.
   그래서 스크롤 중에는 붙잡아 둔 카드를 기준으로 자리를 다시 잡는다. */
let hoverPreviewAnchorCard = null;
let hoverPreviewFollowFrame = 0;

function followNoticeHoverPreview() {
    if (hoverPreviewFollowFrame) return;
    hoverPreviewFollowFrame = requestAnimationFrame(() => {
        hoverPreviewFollowFrame = 0;
        const preview = document.getElementById('notice-hover-preview');
        if (!preview || preview.hidden || !hoverPreviewAnchorCard?.isConnected) return;
        // 기준 카드가 화면 밖으로 나가면 미리보기도 따라 사라진다.
        const rect = hoverPreviewAnchorCard.getBoundingClientRect();
        if (rect.bottom < 0 || rect.top > window.innerHeight) {
            suspendNoticeHoverPreview();
            return;
        }
        positionNoticeHoverPreview(hoverPreviewAnchorCard);
    });
}

/* 모바일에서 목록을 내리면 검색창이 화면 밖으로 나가 다시 찾기 어렵다.
   실제 검색창이 위로 사라진 뒤부터 같은 자리에 고정 줄을 띄우고,
   누르면 맨 위로 되돌려 검색창에 바로 손이 가게 한다. */
let stickySearchFrame = 0;

function syncMobileStickySearch() {
    if (stickySearchFrame) return;
    stickySearchFrame = requestAnimationFrame(() => {
        stickySearchFrame = 0;
        const bar = document.getElementById('mobile-sticky-search');
        if (!bar) return;
        const field = document.querySelector('.search-container .search-field');
        const boardVisible = !document.getElementById('board-view')?.hidden;
        // 상세 화면이나 데스크탑에서는 띄우지 않는다.
        if (!field || !boardVisible || getLayoutMode() !== 'mobile') {
            bar.hidden = true;
            bar.classList.remove('visible');
            return;
        }
        // 검색창 아랫변이 화면 위로 넘어가면 그때부터 대신 선다.
        const shouldShow = field.getBoundingClientRect().bottom <= 4;
        if (shouldShow === bar.classList.contains('visible')) {
            syncMobileMenuHandlePosition();
            return;
        }
        if (shouldShow) {
            bar.hidden = false;
            requestAnimationFrame(() => {
                bar.classList.add('visible');
                syncMobileMenuHandlePosition();
            });
        } else {
            bar.classList.remove('visible');
            syncMobileMenuHandlePosition();
            window.setTimeout(() => {
                if (!bar.classList.contains('visible')) bar.hidden = true;
            }, 180);
        }
    });
}

/* 사용 설명서.
   돋보기는 검색을 확인하는 버튼이 아니다. 검색은 입력하는 대로 이미 걸리므로
   그 자리를 설명서 입구로 쓴다. 처음 온 사람에게는 그 사실을 한 번만 알린다. */
const GUIDE_HINT_KEY = 'eceGuideHintSeen';

function openUserGuide(event) {
    event?.preventDefault();
    dismissGuideHint();
    /* 문서로 보내는 대신 이 화면 위에서 바로 짚어준다. 읽고 나서 다시 돌아와
       찾아야 하는 수고가 없어야 설명서가 실제로 쓰인다. 튜토리얼을 아직
       못 불러온 상황에서만 글로 된 설명서로 넘긴다. */
    if (typeof window.startTutorial === 'function') {
        window.startTutorial();
        return;
    }
    location.href = './guide.html';
}

function dismissGuideHint() {
    const hint = document.getElementById('guide-hint');
    if (hint) hint.hidden = true;
    try {
        localStorage.setItem(GUIDE_HINT_KEY, '1');
    } catch {
        // 저장이 막힌 브라우저에서는 다음에 다시 뜨더라도 동작에는 지장이 없다.
    }
}

function initializeGuideHint() {
    const hint = document.getElementById('guide-hint');
    if (!hint) return;
    let seen = false;
    try {
        seen = localStorage.getItem(GUIDE_HINT_KEY) === '1';
    } catch {
        // 저장소를 못 읽으면 안내를 띄우지 않는다. 반복해서 뜨는 것보다 낫다.
        seen = true;
    }
    hint.hidden = seen;
}

function jumpToNoticeSearch() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    const input = document.getElementById('searchInput');
    if (!input) return;
    // 스크롤이 끝난 뒤 초점을 준다. 먼저 주면 브라우저가 즉시 끌어올려
    // 부드럽게 올라가던 움직임이 끊긴다.
    window.setTimeout(() => input.focus({ preventScroll: true }), 420);
}

/* 왼쪽 위 메뉴 손잡이.
   늘 떠 있으면 제목과 본문을 가리므로 평소에는 숨겨 둔다. 목록을 조금이라도
   내리면 나타나고, 손을 떼고 잠시 두면 스스로 사라진다. 검색 줄이 함께 떠
   있을 때는 그 줄 왼쪽에 나란히 서도록 자리를 옮긴다. */
const MENU_HANDLE_IDLE_MS = 2600;
let menuHandleHideTimer = null;

function revealMobileMenuHandle() {
    const handle = document.querySelector('.mobile-menu-btn');
    if (!handle || getLayoutMode() !== 'mobile') return;
    handle.classList.add('is-visible');
    window.clearTimeout(menuHandleHideTimer);
    menuHandleHideTimer = window.setTimeout(() => {
        // 서랍이 열려 있는 동안에는 손잡이를 거두지 않는다.
        if (isMobileDrawerOpen()) return;
        handle.classList.remove('is-visible');
    }, MENU_HANDLE_IDLE_MS);
}

function syncMobileMenuHandlePosition() {
    const handle = document.querySelector('.mobile-menu-btn');
    const bar = document.getElementById('mobile-sticky-search');
    if (!handle) return;
    // 검색 줄이 떠 있으면 그 줄 안에 나란히 선 것처럼 맞춘다.
    handle.classList.toggle('is-with-search', Boolean(bar && bar.classList.contains('visible')));
}

function watchMobileStickySearch() {
    if (!document.getElementById('mobile-sticky-search')) return;
    const onScroll = () => {
        syncMobileStickySearch();
        revealMobileMenuHandle();
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', syncMobileStickySearch, { passive: true });
    // 손잡이를 만지는 동안에는 사라지지 않게 시계를 다시 돌린다.
    document.querySelector('.mobile-menu-btn')
        ?.addEventListener('pointerenter', revealMobileMenuHandle);
    // 맨 위에서는 스크롤이 없어 아무 신호도 오지 않는다. 처음 한 번 보여 줘
    // 메뉴가 있다는 것만 알리고 곧 거둔다.
    revealMobileMenuHandle();
    syncMobileStickySearch();
}

function watchNoticeHoverPreviewScroll() {
    window.addEventListener('scroll', followNoticeHoverPreview, { passive: true });
    window.addEventListener('resize', followNoticeHoverPreview, { passive: true });
}

function positionNoticeHoverPreview(card) {
    const preview = document.getElementById('notice-hover-preview');
    if (!preview || !card) return;
    const cardRect = card.getBoundingClientRect();
    const leftRail = document.getElementById('left-brand-rail')?.getBoundingClientRect();
    const rightRail = document.getElementById('right-ad-rail')?.getBoundingClientRect();
    const contentLeft = leftRail?.right ? leftRail.right + 12 : 16;
    const contentRight = rightRail?.left ? rightRail.left - 12 : window.innerWidth - 16;
    const previewWidth = Math.min(360, contentRight - contentLeft);
    const previewHeight = Math.min(preview.offsetHeight || 150, window.innerHeight - 32);
    let left = cardRect.right + 14;
    if (left + previewWidth > contentRight) left = cardRect.left - previewWidth - 14;
    left = Math.max(contentLeft, Math.min(left, contentRight - previewWidth));
    const top = Math.max(16, Math.min(cardRect.top, window.innerHeight - previewHeight - 16));
    preview.style.left = `${left}px`;
    preview.style.top = `${top}px`;
    preview.style.width = `${previewWidth}px`;
}

function noticeHoverPreviewLines(notice) {
    const summary = (Array.isArray(notice?.aiSummary) ? notice.aiSummary : [])
        .flatMap(item => String(item || '').split(/\r?\n/))
        .map(item => item.replace(/^\s*[-•·]\s*/, '').trim())
        .filter(Boolean)
        .slice(0, 3);
    if (summary.length >= 3) return summary;

    const sourceLabel = notice?.sourceUrl
        ? '출처: 전기·정보공학부 홈페이지'
        : `출처: ${String(notice?.host || '직접 등록 공지').trim()}`;
    const attachmentLabel = Array.isArray(notice?.attachments) && notice.attachments.length > 0
        ? '첨부파일이 있습니다.'
        : '첨부파일이 없습니다.';

    if (summary.length === 2) return [...summary, `${sourceLabel} · ${attachmentLabel}`];
    if (summary.length === 1) return [...summary, sourceLabel, attachmentLabel];
    return ['AI 요약이 아직 없습니다.', sourceLabel, attachmentLabel];
}

function renderNoticeHoverPreview(notice, card) {
    const preview = document.getElementById('notice-hover-preview');
    if (!preview || !notice || !card) return;
    if (noticeDragInProgress || activeNoticeSplitDragId) {
        suspendNoticeHoverPreview();
        return;
    }
    const previewLines = noticeHoverPreviewLines(notice);
    preview.innerHTML = `
        <div class="notice-hover-preview-body">
            <span class="notice-hover-preview-label">AI 3줄 미리보기</span>
            <ul class="notice-hover-preview-summary-list">
                ${previewLines.map(line => `<li>${escapeHtml(line)}</li>`).join('')}
            </ul>
        </div>
    `;
    hoverPreviewAnchorCard = card;
    preview.hidden = false;
    requestAnimationFrame(() => {
        positionNoticeHoverPreview(card);
        preview.classList.add('visible');
    });
}

function queueNoticeHoverPreview(noticeId, card) {
    if (noticeDragInProgress || activeNoticeSplitDragId) return;
    if (getLayoutMode() !== 'desktop' || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    clearTimeout(noticeHoverPreviewTimer);
    activeHoverPreviewNoticeId = String(noticeId);
    noticeHoverPreviewTimer = setTimeout(async () => {
        if (noticeDragInProgress || activeNoticeSplitDragId) return;
        if (activeHoverPreviewNoticeId !== String(noticeId) || !card?.isConnected) return;
        const summary = notices.find(item => String(item.id) === String(noticeId));
        if (summary) renderNoticeHoverPreview(summary, card);
        try {
            const detail = await getNoticeDetail(noticeId);
            if (activeHoverPreviewNoticeId === String(noticeId) && card.matches(':hover')) {
                renderNoticeHoverPreview(detail, card);
            }
        } catch {
            // 요약 미리보기는 유지하고 상세 조회 실패만 조용히 무시한다.
        }
    }, 620);
}

function cancelNoticeHoverPreview(noticeId) {
    if (noticeId && activeHoverPreviewNoticeId !== String(noticeId)) return;
    clearTimeout(noticeHoverPreviewTimer);
    noticeHoverPreviewTimer = null;
    activeHoverPreviewNoticeId = '';
    hoverPreviewAnchorCard = null;
    const preview = document.getElementById('notice-hover-preview');
    if (!preview) return;
    preview.classList.remove('visible');
    window.setTimeout(() => {
        if (!preview.classList.contains('visible')) preview.hidden = true;
    }, 120);
}

function suspendNoticeHoverPreview() {
    clearTimeout(noticeHoverPreviewTimer);
    noticeHoverPreviewTimer = null;
    activeHoverPreviewNoticeId = '';
    hoverPreviewAnchorCard = null;
    const preview = document.getElementById('notice-hover-preview');
    if (!preview) return;
    preview.classList.remove('visible');
    preview.hidden = true;
}

function linkify(text) {
    if(!text) return "";
    // 한국어 조사는 URL 문자가 아니다. 괄호 안의 링크라면 닫는 괄호도 링크에서 분리한다.
    const rawText = String(text);
    const urlPattern = /https?:\/\/[^\s<>"'\u3131-\u318e\uac00-\ud7a3]+/gi;
    let html = '';
    let cursor = 0;

    for (const match of rawText.matchAll(urlPattern)) {
        const matched = match[0];
        let url = matched;
        let suffix = '';

        while (/[.,;:!?]$/.test(url)) {
            suffix = url.slice(-1) + suffix;
            url = url.slice(0, -1);
        }

        const bracketPairs = { ')': '(', ']': '[', '}': '{' };
        while (bracketPairs[url.slice(-1)]) {
            const closing = url.slice(-1);
            const opening = bracketPairs[closing];
            const openingCount = url.split(opening).length - 1;
            const closingCount = url.split(closing).length - 1;
            if (closingCount <= openingCount) break;
            suffix = closing + suffix;
            url = url.slice(0, -1);
        }

        html += escapeHtml(rawText.slice(cursor, match.index));
        const safeUrl = escapeHtml(url);
        html += `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl}</a>${escapeHtml(suffix)}`;
        cursor = match.index + matched.length;
    }

    return html + escapeHtml(rawText.slice(cursor));
}

function safeHttpUrl(value) {
    try {
        const url = new URL(String(value || ''), window.location.origin);
        return ['http:', 'https:'].includes(url.protocol) ? url.href : '#';
    } catch {
        return '#';
    }
}

function noticeTargetLabels(notice) {
    return [...new Set([
        ...(Array.isArray(notice?.targets) ? notice.targets : []),
        notice?.target
    ].map(value => String(value || '').trim()).filter(Boolean))];
}

function formatNoticeTargetBadge(notice) {
    const label = String(notice?.target || noticeTargetLabels(notice)[0] || '전체');
    return label.replace(/(\d{2})학번\s*이상/g, '$1학번↑');
}

// ========================================
// 🎨 모달
// ========================================

function openModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.style.display = 'flex';
}

function closeModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.style.display = 'none';
}

function openContactFromRail() {
    if (typeof closeMobileDrawer === 'function') closeMobileDrawer();
    setFeedbackCategory('general');
    const status = document.getElementById('feedback-status');
    if (status) status.textContent = '';
    const title = document.getElementById('feedback-title');
    const help = document.getElementById('feedback-help');
    const message = document.getElementById('feedback-message');
    if (title) title.textContent = '익명 피드백';
    if (help) help.textContent = '이름·연락처·IP를 저장하지 않습니다.\n개선 의견이나 오류를 편하게 남겨주세요.';
    if (message) message.placeholder = '개선 의견이나 오류 제보를 적어주세요. (5자 이상)';
    openModal('contact-modal');
    message?.focus();
}

function openBannerInquiryFromRail() {
    if (typeof closeMobileDrawer === 'function') closeMobileDrawer();
    window.location.href = './banner-inquiry.html';
}

function setFeedbackCategory(category) {
    activeFeedbackCategory = category === 'banner' ? 'banner' : 'general';
    document.querySelectorAll('[data-feedback-category]').forEach(button => {
        const active = button.dataset.feedbackCategory === activeFeedbackCategory;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
    });
    const title = document.getElementById('feedback-title');
    const help = document.getElementById('feedback-help');
    const message = document.getElementById('feedback-message');
    if (activeFeedbackCategory === 'banner') {
        if (title) title.textContent = '배너 문의';
        if (help) help.textContent = '학내 홍보 등록과 제휴에 관한 문의로 분류해 전달합니다.';
        if (message) message.placeholder = '배너 게재 기간, 내용, 연락 방법을 적어주세요. (5자 이상)';
    } else {
        if (title) title.textContent = '익명 피드백';
        if (help) help.textContent = '이름·연락처·IP를 저장하지 않습니다.\n개선 의견이나 오류를 편하게 남겨주세요.';
        if (message) message.placeholder = '개선 의견이나 오류 제보를 적어주세요. (5자 이상)';
    }
}

// 익명 피드백 전송. 서버는 메시지와 시각만 저장하고 신원은 남기지 않는다.
/* 첨부할 화면 사진.

   원본을 그대로 보내면 요즘 휴대폰 사진 한 장이 몇 MB라 익명 문의 하나가
   서버 저장소를 크게 잡아먹는다. 긴 변을 1600px로 줄이고 JPEG으로 다시
   그려 보낸다. 글씨를 읽을 수 있을 만큼은 남으면서 크기는 크게 준다. */
const FEEDBACK_MAX_SHOTS = 3;
const FEEDBACK_SHOT_MAX_EDGE = 1600;
let feedbackShots = [];

function readImageFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error('이미지를 읽지 못했습니다.'));
            image.src = reader.result;
        };
        reader.onerror = () => reject(new Error('파일을 읽지 못했습니다.'));
        reader.readAsDataURL(file);
    });
}

async function shrinkToJpeg(file) {
    const image = await readImageFile(file);
    const scale = Math.min(1, FEEDBACK_SHOT_MAX_EDGE / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext('2d');
    // 투명한 부분이 검게 나오지 않도록 흰 바탕을 먼저 깐다.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.82);
}

async function addFeedbackScreenshots(input) {
    const files = Array.from(input?.files || []);
    input.value = '';
    if (!files.length) return;

    const status = document.getElementById('feedback-status');
    const room = FEEDBACK_MAX_SHOTS - feedbackShots.length;
    if (room <= 0) {
        if (status) status.textContent = `사진은 ${FEEDBACK_MAX_SHOTS}장까지 붙일 수 있습니다.`;
        return;
    }
    for (const file of files.slice(0, room)) {
        if (!/^image\//.test(file.type)) continue;
        try {
            feedbackShots.push(await shrinkToJpeg(file));
        } catch {
            if (status) status.textContent = '읽지 못한 사진이 있어 건너뛰었습니다.';
        }
    }
    renderFeedbackShots();
}

function removeFeedbackScreenshot(index) {
    feedbackShots.splice(index, 1);
    renderFeedbackShots();
}

function renderFeedbackShots() {
    const list = document.getElementById('feedback-shot-list');
    if (!list) return;
    list.innerHTML = feedbackShots.map((dataUrl, index) => `
        <figure class="feedback-shot">
            <img src="${escapeHtml(dataUrl)}" alt="첨부한 화면 사진 ${index + 1}">
            <button type="button" class="feedback-shot-remove" aria-label="${index + 1}번째 사진 빼기"
                    onclick="removeFeedbackScreenshot(${index})">×</button>
        </figure>
    `).join('');
    const add = document.getElementById('feedback-shot-input')?.closest('.feedback-shot-add');
    if (add) add.classList.toggle('is-full', feedbackShots.length >= FEEDBACK_MAX_SHOTS);
}

async function submitFeedback() {
    const input = document.getElementById('feedback-message');
    const status = document.getElementById('feedback-status');
    const button = document.getElementById('feedback-submit');
    const message = (input?.value || '').trim();

    const setStatus = (text, isError = false) => {
        if (!status) return;
        status.textContent = text;
        status.style.color = isError ? 'var(--danger)' : 'var(--text-sub)';
    };

    if (message.length < 5) {
        setStatus('5자 이상 입력해주세요.', true);
        input?.focus();
        return;
    }

    button.disabled = true;
    setStatus('보내는 중입니다...');
    try {
        await apiRequest('/api/feedback', {
            method: 'POST',
            body: JSON.stringify({
                message,
                category: activeFeedbackCategory,
                screenshots: feedbackShots
            })
        });
        input.value = '';
        feedbackShots = [];
        renderFeedbackShots();
        setStatus('보내주셔서 감사합니다. 익명으로 전달되었습니다.');
    } catch (error) {
        setStatus(error.message || '전송에 실패했습니다. 잠시 후 다시 시도해주세요.', true);
    } finally {
        button.disabled = false;
    }
}

async function reportSummaryMismatch(id, button) {
    const noticeId = String(id || '').trim();
    if (!noticeId || button?.disabled) return;
    const originalLabel = button?.textContent || '요약 오류 신고';
    if (button) {
        button.disabled = true;
        button.textContent = '전달 중…';
    }
    try {
        await apiRequest(`/api/notices/${encodeURIComponent(noticeId)}/summary-report`, {
            method: 'POST',
            body: JSON.stringify({})
        });
        if (button) button.textContent = '검수함에 전달했습니다';
    } catch (error) {
        if (button) {
            button.disabled = false;
            button.textContent = originalLabel;
        }
        alert(error.message || '전달하지 못했습니다. 잠시 후 다시 시도해주세요.');
    }
}

window.onclick = function(event) {
    if (event.target.classList?.contains('overlay')) {
        event.target.style.display = 'none';
    }
}

// ========================================
// 🔗 공지 딥링크
// 카톡 공지방에 링크를 올리면 학생이 눌렀을 때 해당 공지가 바로 열려야 한다.
// ========================================

const NOTICE_URL_PARAM = 'id';

function getNoticeShareUrl(id) {
    const url = new URL(location.href);
    url.hash = '';
    url.search = '';
    url.searchParams.set(NOTICE_URL_PARAM, String(id));
    return url.toString();
}

// 상세를 열면 주소창을 그 공지의 공유 링크로 바꾼다. 히스토리에 쌓아 뒤로가기로 닫히게 한다.
function syncUrlToNotice(id) {
    if (!window.history?.pushState) return false;
    const target = getNoticeShareUrl(id);
    if (location.href === target) return Boolean(history.state?.noticeId);
    history.pushState({ noticeId: String(id) }, '', target);
    return true;
}

function clearNoticeUrl() {
    if (!window.history?.replaceState) return;
    const params = new URLSearchParams(location.search);
    if (!params.has(NOTICE_URL_PARAM)) return;
    params.delete(NOTICE_URL_PARAM);
    const query = params.toString();
    history.replaceState({}, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
}

// 최초 진입 시 ?id=... 가 있으면 그 공지를 연다.
async function openNoticeFromUrl() {
    const requestedId = new URLSearchParams(location.search).get(NOTICE_URL_PARAM);
    if (!requestedId) return;

    let exists = notices.some(n => String(n.id) === String(requestedId));
    if (!exists) {
        try {
            await getNoticeDetail(requestedId);
            exists = true;
        } catch {
            // 아래의 사용자 안내로 통합한다.
        }
        if (!exists) {
            alert('링크에 해당하는 공지를 찾을 수 없습니다.\n삭제되었거나 주소가 잘못되었습니다.');
            clearNoticeUrl();
            return;
        }
    }

    await openDetail(requestedId);
}

async function copyNoticeLink() {
    if (!currentViewId) return;
    const url = getNoticeShareUrl(currentViewId);

    try {
        await navigator.clipboard.writeText(url);
        alert('공지 링크가 복사되었습니다.\n카톡 공지방에 붙여넣으세요.\n\n' + url);
    } catch (error) {
        // 클립보드 권한이 없는 브라우저(카톡 인앱 등) 대비 수동 복사 경로
        prompt('아래 링크를 복사하세요.', url);
    }
}

window.addEventListener('popstate', function () {
    const requestedId = new URLSearchParams(location.search).get(NOTICE_URL_PARAM);

    // ?id= 가 사라졌으면(뒤로가기) 목록으로 돌아가고, 있으면 그 공지를 연다.
    if (!requestedId) {
        detailHistoryPushed = false;
        showBoardView();
        return;
    }

    if (String(currentViewId) !== String(requestedId)) openDetail(requestedId);
});

// ========================================
// 👤 연락처 표시 (관리자 편집은 admin.html)
// ========================================

function renderAdminInfo() {
    const nameEl = document.getElementById('admin-name-display');
    const phoneEl = document.getElementById('admin-phone-display');
    const kakaoEl = document.getElementById('admin-kakao-display');
    if (nameEl) nameEl.innerText = adminInfo.name;
    if (phoneEl) phoneEl.innerText = adminInfo.phone;
    if (kakaoEl) kakaoEl.innerText = adminInfo.kakao;
}

function renderBannerAdminInfo() {
    const nameEl = document.getElementById('banner-admin-name-display');
    const phoneEl = document.getElementById('banner-admin-phone-display');
    const kakaoEl = document.getElementById('banner-admin-kakao-display');
    if (nameEl) nameEl.innerText = bannerAdminInfo.name;
    if (phoneEl) phoneEl.innerText = bannerAdminInfo.phone;
    if (kakaoEl) kakaoEl.innerText = bannerAdminInfo.kakao;
}

// ========================================
// 🔍 필터링
// ========================================

/* 필터 여닫기는 '상세 필터' 바 하나로 통일한다. 모바일에서는 이 바가
   빠른 필터 줄까지 함께 펼친다. 손잡이가 둘로 나뉘어 있으면 무엇이 무엇을
   여는지 알기 어렵고 검색창 아래에 정체불명의 탭이 남는다. */
function setFilterPanelOpen(open) {
    const panel = document.getElementById('filter-panel');
    const bar = document.getElementById('filter-toggle-bar');
    const chevron = document.getElementById('filter-chevron');
    const quickFilters = document.getElementById('notice-quick-filters');
    if (!panel) return;

    panel.classList.toggle('open', open);
    bar?.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (chevron) chevron.style.transform = open ? 'rotate(180deg)' : '';
    quickFilters?.classList.toggle('is-mobile-open', open);
    if (open) buildHostButtons();
}

function toggleFilterPanel(event) {
    // 칩의 x는 바 안에 있다. 손가락이 조금만 빗나가도 바가 눌린 것으로 잡혀
    // 패널이 닫혀 버리므로, 칩 영역에서 시작한 누름은 여닫기로 보지 않는다.
    if (event?.target?.closest?.('.filter-active-chips')) return;
    const open = !document.getElementById('filter-panel')?.classList.contains('open');
    setFilterPanelOpen(open);
}

function closeFilterPanel() {
    setFilterPanelOpen(false);
    document.getElementById('filter-toggle-bar')
        ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function buildHostButtons() {
    const select = document.getElementById('hostFilter');
    if (!select) return;
    const hosts = [...new Set(
        (noticeRepository.facets.hosts.length
            ? noticeRepository.facets.hosts
            : notices.map(n => n.host || '기타'))
            .filter(Boolean)
    )].sort((a, b) => a.localeCompare(b, 'ko'));
    const current = filterState.host;
    select.innerHTML = [
        '<option value="전체">전체 기관</option>',
        ...hosts.map(host => `<option value="${escapeHtml(host)}">${escapeHtml(host)}</option>`)
    ].join('');
    select.value = hosts.includes(current) ? current : '전체';
    if (select.value !== current) filterState.host = select.value;
}

function setHostFilter(value) {
    filterState.host = String(value || '전체');
    filterCards();
    updateFilterChips();
}

async function loadCategories() {
    try {
        const result = await apiRequest('/api/categories', { method: 'GET' });
        activeCategories = orderedNoticeCategories(
            Array.isArray(result?.categories) ? result.categories : []
        );
    } catch (error) {
        console.error('카테고리 불러오기 실패:', error);
        activeCategories = [];
    }
    buildCategoryTabs();
}

const LEGACY_CATEGORY_REDIRECTS = Object.freeze({
    application: 'opportunity',
    academics: 'academic',
    'benefits-partnerships': 'community',
    campus: 'community',
    governance: 'community',
    // 옛 '혜택' 칸은 없앴다. 그 자리에 설문이 들어왔고, 제휴·할인은 행사로 갔다.
    benefit: 'community',
    expired: 'all'
});

function categoryFromTabValue(value) {
    const normalized = LEGACY_CATEGORY_REDIRECTS[value] || value;
    if (normalized === 'all') return null;
    return activeCategories.find(category =>
        category.slug === normalized || Number(category.id) === Number(normalized)
    ) || null;
}

// 주제 축만 남긴 5개 탭. 상태와 행동 여부는 아래 빠른 필터가 맡는다.
function buildCategoryTabs() {
    const inner = document.getElementById('category-tabs-inner');
    if (!inner) return;
    const current = selectedCategoryFilters.size === 0
        ? 'all'
        : (selectedCategoryFilters.size === 1 ? [...selectedCategoryFilters][0] : 'multi');
    let html = `<button type="button" class="category-tab ${current === 'all' ? 'active' : ''}" data-category="all" onclick="selectCategoryTab('all')">전체</button>`;
    html += orderedNoticeCategories().map(category => {
        const id = Number(category.id);
        return `<button type="button" class="category-tab ${current === id ? 'active' : ''}" data-category="${escapeHtml(category.slug)}" onclick="selectCategoryTab('${escapeHtml(category.slug)}')">${escapeHtml(category.name)}</button>`;
    }).join('');
    inner.innerHTML = html;
}

function selectCategoryTab(value) {
    const category = categoryFromTabValue(value);
    selectedCategoryFilters.clear();
    archiveTabActive = false;
    if (category) selectedCategoryFilters.add(Number(category.id));
    const activeSlug = category ? category.slug : 'all';
    document.querySelectorAll('#category-tabs-inner .category-tab').forEach(tab => {
        const selected = tab.dataset.category === activeSlug;
        tab.classList.toggle('active', selected);
        tab.setAttribute('aria-current', selected ? 'true' : 'false');
    });
    filterState.sort = getDefaultSortForCategory(activeSlug);
    syncNoticeSortChips();
    updateFilterChips();
    filterCards(true);
}

/* 기본 정렬.
   마감이 있어야 뜻이 있는 칸만 마감임박순으로 연다. 기회와 설문이
   그렇다. 학사·행사는 언제 올라왔는지가 중요하고, '관련'은 학부 홈페이지에
   실린 차례 그대로 보는 편이 자연스러워 최신순으로 둔다. */
function getDefaultSortForCategory(value = 'all') {
    if (value === 'all') return '최신순';
    const category = categoryFromTabValue(value);
    return ['opportunity', 'survey'].includes(category?.slug)
        ? '마감임박순'
        : '최신순';
}

function syncQuickNoticeFilterButtons() {
    document.querySelectorAll('[data-quick-filter]').forEach(button => {
        const active = Boolean(quickNoticeFilters[button.dataset.quickFilter]);
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
}

function toggleQuickNoticeFilter(name) {
    if (!Object.hasOwn(quickNoticeFilters, name)) return;
    quickNoticeFilters[name] = !quickNoticeFilters[name];
    syncQuickNoticeFilterButtons();
    updateFilterChips();
    filterCards(true);
}

function restoreNoticeListStateFromUrl() {
    const params = new URLSearchParams(location.search);
    const rawTab = params.get('tab') || params.get('category') || 'all';
    const mappedTab = LEGACY_CATEGORY_REDIRECTS[rawTab] || rawTab;
    const category = categoryFromTabValue(mappedTab);
    selectedCategoryFilters.clear();
    if (category) selectedCategoryFilters.add(Number(category.id));
    quickNoticeFilters.urgent = params.get('urgent') === '1';
    quickNoticeFilters.reward = params.get('reward') === '1' || rawTab === 'survey';
    quickNoticeFilters.action = params.get('action') === '1' || rawTab === 'survey';
    quickNoticeFilters.past = params.get('past') === '1'
        || rawTab === 'expired'
        || params.get('archive') === 'expired';
    const search = document.getElementById('searchInput');
    if (search && params.get('q')) search.value = params.get('q').slice(0, 200);
    const requestedSort = params.get('sort');
    filterState.sort = ['마감임박순', '최신순', '조회순'].includes(requestedSort)
        ? requestedSort
        : getDefaultSortForCategory(category?.slug || 'all');
    syncQuickNoticeFilterButtons();
    const page = Number.parseInt(params.get('page'), 10);
    return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

function syncNoticeListUrl(page = 1) {
    if (!document.getElementById('notice-detail-view')?.hidden) return;
    const params = new URLSearchParams(location.search);
    params.delete('category');
    params.delete('archive');
    const categoryId = [...selectedCategoryFilters][0];
    const category = activeCategories.find(item => Number(item.id) === Number(categoryId));
    category ? params.set('tab', category.slug) : params.delete('tab');
    for (const key of Object.keys(quickNoticeFilters)) {
        quickNoticeFilters[key] ? params.set(key, '1') : params.delete(key);
    }
    const search = document.getElementById('searchInput')?.value.trim() || '';
    search ? params.set('q', search) : params.delete('q');
    filterState.sort !== getDefaultSortForCategory(category?.slug || 'all')
        ? params.set('sort', filterState.sort)
        : params.delete('sort');
    Number(page) > 1 ? params.set('page', String(page)) : params.delete('page');
    const query = params.toString();
    history.replaceState(history.state, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
}

function syncNoticeSortChips() {
    let activeButton = null;
    document.querySelectorAll('#notice-sort-chips [data-sort]').forEach(button => {
        const active = button.dataset.sort === filterState.sort;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
        if (active) activeButton = button;
    });
    moveNoticeSortThumb(activeButton);
}

/* 활성 알약을 고른 버튼 위로 옮긴다. 폭과 위치만 인라인으로 주고 실제
   움직임은 CSS transition이 맡으므로 매 프레임 계산이 없다. */
function moveNoticeSortThumb(activeButton) {
    const thumb = document.getElementById('notice-sort-thumb');
    const group = document.getElementById('notice-sort-chips');
    if (!thumb || !group || !activeButton) return;
    // 화면에 없으면 폭이 0이라 엉뚱한 자리에 붙는다. 보일 때 다시 맞춘다.
    if (!activeButton.offsetWidth) {
        thumb.classList.remove('is-ready');
        return;
    }
    thumb.style.width = `${activeButton.offsetWidth}px`;
    thumb.style.transform = `translateX(${activeButton.offsetLeft - group.clientLeft}px)`;
    // 첫 배치는 미끄러지지 않게 한 프레임 뒤에 전환을 켠다.
    if (!thumb.classList.contains('is-ready')) {
        requestAnimationFrame(() => thumb.classList.add('is-ready'));
    }
}

// 글꼴이 늦게 오거나 창 크기가 바뀌면 버튼 폭이 달라지므로 알약을 다시 맞춘다.
function watchNoticeSortThumb() {
    if (!document.getElementById('notice-sort-chips')) return;
    const resync = () => syncNoticeSortChips();
    window.addEventListener('resize', resync);
    document.fonts?.ready?.then(resync);
}

function setNoticeSort(sort) {
    if (!['마감임박순', '최신순', '조회순'].includes(sort)) return;
    filterState.sort = sort;
    syncNoticeSortChips();
    filterCards(true);
}

function toggleFilterBtn(btn) {
    const group = btn.dataset.group;
    const val = btn.dataset.val;
    document.querySelectorAll(`[data-group="${group}"]`).forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    filterState[group] = val;
    filterCards();
    updateFilterChips();
}

function updateFilterChips() {
    const chipsArea = document.getElementById('filter-active-chips');
    const bar = document.getElementById('filter-toggle-bar');
    const labelEl = document.getElementById('filter-toggle-label');
    if (!chipsArea || !bar || !labelEl) return;
    chipsArea.innerHTML = '';

    const labelMap = { 'deadline-status': '마감', 'host': '기관', 'views': '조회수' };
    let hasActive = false;

    const dateFrom = document.getElementById('filter-date-from')?.value;
    const dateTo = document.getElementById('filter-date-to')?.value;
    const target = document.getElementById('targetFilter')?.value || '전체';

    Object.entries(filterState).forEach(([group, val]) => {
        if (group === 'sort') return;
        if (val !== FILTER_DEFAULTS[group]) {
            hasActive = true;
            const chip = document.createElement('div');
            chip.className = 'filter-chip';
            chip.innerHTML = `<span>${labelMap[group]}: ${val}</span><button onclick="event.stopPropagation(); resetFilterGroup('${group}')">×</button>`;
            chipsArea.appendChild(chip);
        }
    });

    if (!includeRelatedNotices) {
        hasActive = true;
        const chip = document.createElement('div');
        chip.className = 'filter-chip';
        chip.innerHTML = '<span>관련 공지 제외</span>'
            + '<button onclick="event.stopPropagation(); resetRelatedNoticeFilter()">×</button>';
        chipsArea.appendChild(chip);
    }

    if (target !== '전체') {
        hasActive = true;
        const chip = document.createElement('div');
        chip.className = 'filter-chip';
        chip.innerHTML = `<span>학번: ${escapeHtml(target)}</span><button onclick="event.stopPropagation(); resetTargetFilter()">×</button>`;
        chipsArea.appendChild(chip);
    }

    if (dateFrom || dateTo) {
        hasActive = true;
        const chip = document.createElement('div');
        chip.className = 'filter-chip';
        chip.innerHTML = `<span>기간: ${dateFrom || '?'} ~ ${dateTo || '?'}</span><button onclick="event.stopPropagation(); clearDateRange()">×</button>`;
        chipsArea.appendChild(chip);
    }

    Object.entries(quickNoticeFilters).forEach(([key, active]) => {
        if (!active) return;
        hasActive = true;
        const names = {
            urgent: '마감 임박',
            reward: '리워드 있음',
            action: '신청 필요',
            past: '마감'
        };
        const chip = document.createElement('div');
        chip.className = 'filter-chip';
        chip.innerHTML = `<span>${names[key]}</span><button onclick="event.stopPropagation(); toggleQuickNoticeFilter('${key}')">×</button>`;
        chipsArea.appendChild(chip);
    });

    bar.classList.toggle('has-active', hasActive);
    const count = chipsArea.children.length;
    const svg = `<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3 4h18M7 8h10M11 12h2M9 16h6"/></svg>`;
    labelEl.innerHTML = `${svg} 상세 필터${hasActive ? ` <span style="background:var(--primary);color:white;font-size:11px;padding:2px 7px;border-radius:10px;">${count}</span>` : ''}`;
}

function resetFilterGroup(group) {
    filterState[group] = FILTER_DEFAULTS[group];
    document.querySelectorAll(`[data-group="${group}"]`).forEach(b => { b.classList.toggle('active', b.dataset.val === FILTER_DEFAULTS[group]); });
    if (group === 'host') {
        const hostFilter = document.getElementById('hostFilter');
        if (hostFilter) hostFilter.value = FILTER_DEFAULTS.host;
    }
    filterCards();
    updateFilterChips();
}

function clearDateRange() {
    const f = document.getElementById('filter-date-from');
    const t = document.getElementById('filter-date-to');
    if (f) f.value = '';
    if (t) t.value = '';
    filterCards();
    updateFilterChips();
}

function resetTargetFilter() {
    const target = document.getElementById('targetFilter');
    if (target) target.value = '전체';
    filterCards();
    updateFilterChips();
}

function clearCategoryFilters() {
    selectedCategoryFilters.clear();
    archiveTabActive = false;
    buildCategoryTabs();
    filterState.sort = getDefaultSortForCategory('all');
    syncNoticeSortChips();
    filterCards();
    updateFilterChips();
}

function resetAllFilters() {
    Object.keys(filterState).forEach(g => { filterState[g] = FILTER_DEFAULTS[g]; });
    document.querySelectorAll('.filter-btn').forEach(b => { b.classList.toggle('active', b.dataset.val === FILTER_DEFAULTS[b.dataset.group]); });
    selectedCategoryFilters.clear();
    archiveTabActive = false;
    Object.keys(quickNoticeFilters).forEach(key => { quickNoticeFilters[key] = false; });
    syncQuickNoticeFilterButtons();
    buildCategoryTabs();
    filterState.sort = getDefaultSortForCategory('all');
    syncNoticeSortChips();
    const dateFrom = document.getElementById('filter-date-from');
    const dateTo = document.getElementById('filter-date-to');
    if (dateFrom) dateFrom.value = '';
    if (dateTo) dateTo.value = '';
    const target = document.getElementById('targetFilter');
    if (target) target.value = '전체';
    const hostFilter = document.getElementById('hostFilter');
    if (hostFilter) hostFilter.value = FILTER_DEFAULTS.host;
    includeRelatedNotices = true;
    const relatedBox = document.getElementById('filter-include-related');
    if (relatedBox) relatedBox.checked = true;
    updateFilterChips();
    filterCards();
}

function hasDetailedNoticeFilters() {
    const target = document.getElementById('targetFilter')?.value || '전체';
    const dateFrom = document.getElementById('filter-date-from')?.value || '';
    const dateTo = document.getElementById('filter-date-to')?.value || '';
    return target !== '전체'
        || selectedCategoryFilters.size > 0
        || !includeRelatedNotices
        || Object.values(quickNoticeFilters).some(Boolean)
        || dateFrom
        || dateTo
        || Object.entries(filterState).some(([group, value]) =>
            group !== 'sort' && value !== FILTER_DEFAULTS[group]
        );
}

function clearSearchFilter() {
    const input = document.getElementById('searchInput');
    if (input) input.value = '';
    filterCards(true);
}

function renderNoticeEmptyState() {
    const rawSearch = document.getElementById('searchInput')?.value.trim() || '';
    if (rawSearch) {
        return `
            <div class="notice-empty-state">
                <strong>“${escapeHtml(rawSearch)}” 검색 결과가 없습니다.</strong>
                <p>검색어를 줄이거나 다른 표현으로 다시 찾아보세요.</p>
                <button class="btn btn-outline btn-small" type="button" onclick="clearSearchFilter()">검색어 지우기</button>
            </div>
        `;
    }
    if (hasDetailedNoticeFilters()) {
        return `
            <div class="notice-empty-state">
                <strong>해당하는 공지가 없습니다.</strong>
                <p>다른 카테고리나 조건으로 다시 확인해 주세요.</p>
            </div>
        `;
    }
    return `
        <div class="notice-empty-state">
            <strong>아직 등록된 공지가 없습니다.</strong>
            <p>새 공지가 검수되면 이곳에 표시됩니다.</p>
        </div>
    `;
}

function renderNoticeCards(animate = false) {
    const inputVal = document.getElementById('searchInput');
    if(!inputVal) return;

    const grid = document.getElementById('notice-grid');
    grid.innerHTML = "";

    const comparisonEnabled = getLayoutMode() === 'desktop';
    if (!comparisonEnabled && (compareWorkspaceOpen || compareBlocks.length > 0)) {
        compareBlocks = [];
        compareWorkspaceOpen = false;
        compareLayoutMode = 'stack';
        expandedCompareBlocks.clear();
    }

    // 비교 공간은 공지 그리드와 독립적으로 렌더한다. 공간에 담긴 공지는
    // 아래 일반 목록에서는 빼서 같은 공지가 두 곳에 동시에 보이지 않게 한다.
    const blockIds = comparisonEnabled
        ? compareBlocks.filter(id => notices.some(n => String(n.id) === String(id)))
        : [];
    const blockSet = new Set(blockIds);
    renderCompareSpace(blockIds);

    const filtered = notices;

    const baseNotices = filtered.filter(notice => !blockSet.has(String(notice.id)));
    baseNotices.forEach(notice => {
        const datePresentation = getNoticeDatePresentation(notice);
        const rawTitle = notice.title || "제목 없음";
        const safeTitle = escapeHtml(rawTitle);
        const hasImg = Object.hasOwn(notice, 'hasImages')
            ? notice.hasImages
            : Boolean(notice.images && notice.images.length > 0);

        // 사진이 있으면 포스터를 지연 로드한다. 없으면 포스터 자리에 제목을 크게 보여준다.
        const posterHtml = hasImg
            ? `<div class="card-poster">
                   <img class="card-img-preview" alt="" data-thumbnail-src="${escapeHtml(notice.thumbnailUrl || '/icons/default-notice-thumbnail.png')}">
               </div>`
            : `<div class="card-poster is-text">
                   <span class="card-poster-rule" aria-hidden="true"></span>
                   ${renderPosterTitle(rawTitle)}
                   ${datePresentation.dateLabel
                       ? `<span class="card-poster-date">${escapeHtml(datePresentation.dateLabel)}</span>`
                       : ''}
               </div>`;

        const cardClass = [
            'card',
            datePresentation.badgeClass === 'd-day' ? 'card-urgent' : '',
            datePresentation.badgeClass === 'expired' ? 'card-expired' : '',
            notice.isArchived ? 'is-archived' : '',
            notice.isInGracePeriod ? 'is-grace-period' : ''
        ].filter(Boolean).join(' ');
        const dateTagHtml = datePresentation.badgeText
            ? `<span class="tag ${datePresentation.badgeClass}">${escapeHtml(datePresentation.badgeText)}</span>`
            : '';
        // 본문 발췌: 목록 응답은 원문을 담지 않으므로 AI 3줄 요약을 발췌로 쓴다.
        const excerpt = Array.isArray(notice.aiSummary) ? notice.aiSummary.join(' ') : '';
        // 사진이 없어 포스터 안에 제목을 크게 쓴 카드도, 목록을 아래로 훑을 때
        // 태그 다음에 제목을 놓쳐 버리지 않도록 본문 첫 줄에 한 번 더 적는다.
        const titleHtml = `<h3 class="card-title">${safeTitle}</h3>`;
        const rewardText = notice.rewardNote || notice.surveyReward || '';
        // 리워드는 조회수와 같은 줄, 바로 왼쪽에 놓는다. 자리보다 길면
        // 렌더 후 measureCardRewardMarquee가 컨베이어처럼 흘려보낸다.
        const rewardHtml = rewardText
            ? `<span class="card-reward" aria-label="리워드 ${escapeHtml(rewardText)}">
                   <span class="card-reward-icon" aria-hidden="true">🎁</span>
                   <span class="card-reward-viewport">
                       <span class="card-reward-track"><span class="card-reward-text">${escapeHtml(rewardText)}</span></span>
                   </span>
               </span>`
            : '';

        const card = document.createElement('div');
        card.className = cardClass;
        if (animate) {
            card.classList.add('is-filter-entering');
            card.style.setProperty('--notice-enter-delay', `${Math.min(grid.childElementCount, 4) * 22}ms`);
        }
        card.dataset ||= {};
        card.dataset.noticeId = String(notice.id);
        card.onclick = () => {
            if (noticeDragInProgress || Date.now() < suppressNoticeClickUntil) return;
            openDetail(notice.id);
        };
        card.addEventListener('mouseenter', () => queueNoticeHoverPreview(notice.id, card));
        card.addEventListener('mouseleave', () => cancelNoticeHoverPreview(notice.id));
        // 노션처럼: 6점 핸들만 드래그하고, 카드는 평소처럼 눌러 상세를 연다.
        const blockControlsHtml = comparisonEnabled ? `
            <div class="card-block-controls" onclick="event.stopPropagation()">
                <button class="card-drag-handle" type="button" draggable="false"
                        aria-label="공지 들어서 화면 분할" title="끌어서 왼쪽 또는 오른쪽에 놓기">
                    <svg width="10" height="16" viewBox="0 0 10 16" aria-hidden="true"><g fill="currentColor"><circle cx="2.5" cy="3" r="1.3"/><circle cx="7.5" cy="3" r="1.3"/><circle cx="2.5" cy="8" r="1.3"/><circle cx="7.5" cy="8" r="1.3"/><circle cx="2.5" cy="13" r="1.3"/><circle cx="7.5" cy="13" r="1.3"/></g></svg>
                </button>
            </div>
        ` : '';
        card.innerHTML = `
            ${blockControlsHtml}
            ${posterHtml}
            <div class="card-body">
                <div class="tags">
                    ${dateTagHtml}
                    ${notice.isPinned ? '<span class="tag pinned">고정</span>' : ''}
                    <span class="tag target">${escapeHtml(formatNoticeTargetBadge(notice))}</span>
                    ${notice.host ? `<span class="tag">${escapeHtml(notice.host)}</span>` : ''}
                </div>
                ${titleHtml}
                ${datePresentation.dateLabel
                    ? `<div class="card-date">${escapeHtml(datePresentation.dateLabel)}</div>`
                    : ''}
                ${excerpt ? `<p class="card-excerpt">${escapeHtml(excerpt)}</p>` : ''}
                <div class="card-meta">
                    ${rewardHtml}
                    <span class="view-count">조회 ${Number(notice.views) || 0}</span>
                </div>
            </div>
        `;
        const splitHandle = card.querySelector('.card-drag-handle');
        splitHandle?.addEventListener('pointerdown', event => onNoticeHandlePointerDown(event, notice.id));
        grid.appendChild(card);
    });

    if (Number(noticeRepository.pagination.total) === 0) {
        grid.innerHTML = renderNoticeEmptyState();
    }

    grid.querySelectorAll?.('img[data-thumbnail-src]')
        ?.forEach(image => noticeViewportLoader.observeThumbnail(image));

    measureCardRewardMarquee(grid);

    if (animate && grid.childElementCount > 0) {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                grid.querySelectorAll('.card.is-filter-entering').forEach(card => {
                    card.classList.remove('is-filter-entering');
                    window.setTimeout(() => card.style.removeProperty('--notice-enter-delay'), 260);
                });
            });
        });
    }

    updateNoticeResultCount();
}

/* "결과 N건"은 사용자가 검색하거나 필터를 걸었을 때만 의미가 있다.
   아무 조건도 걸지 않은 기본 목록에서는 전체 건수를 다시 알려줄 필요가 없다. */
function updateNoticeResultCount() {
    const countEl = document.getElementById('filter-result-count');
    if (!countEl) return;
    const total = Number(noticeRepository.pagination.total) || 0;
    const show = total > 0 && hasActiveNoticeQuery();
    countEl.hidden = !show;
    countEl.innerHTML = show ? `결과 <strong>${total}</strong>건` : '';
    // 모바일에서 왼쪽 열을 정렬 버튼 줄까지 끌어올리는데, 결과 건수가
    // 바로 그 자리에 들어서므로 보일 때는 끌어올리지 않는다.
    document.getElementById('notice-grid')?.classList.toggle('has-result-count', show);
}

/* 관련 공지 스위치. 평소에는 켜져 있으므로 끈 것만 조건을 건 것으로 센다. */
function resetRelatedNoticeFilter() {
    const box = document.getElementById('filter-include-related');
    if (box) box.checked = true;
    setRelatedNoticeFilter(true);
}

function setRelatedNoticeFilter(include) {
    includeRelatedNotices = include !== false;
    updateFilterChips();
    filterCards(true);
}

// 검색어나 상세·빠른 필터 중 하나라도 기본값에서 벗어났는지.
// 카테고리 탭은 목록을 고르는 이동이지 조건 걸기가 아니라 여기서 세지 않는다.
function hasActiveNoticeQuery() {
    if (document.getElementById('searchInput')?.value.trim()) return true;
    if (Object.values(quickNoticeFilters).some(Boolean)) return true;
    if (!includeRelatedNotices) return true;
    if ((document.getElementById('targetFilter')?.value || '전체') !== '전체') return true;
    if (document.getElementById('filter-date-from')?.value) return true;
    if (document.getElementById('filter-date-to')?.value) return true;
    return Object.entries(filterState)
        .some(([group, value]) => group !== 'sort' && value !== FILTER_DEFAULTS[group]);
}

/* 리워드 문구가 제 칸보다 길면 컨베이어처럼 한 방향으로 계속 흘린다.
   같은 글을 하나 더 이어 붙이고 트랙을 절반만큼 밀면 이음매 없이 반복된다.
   길이에 비례해 속도를 정해야 짧은 문구가 지나치게 빨리 지나가지 않는다. */
function measureCardRewardMarquee(root) {
    const rewards = root?.querySelectorAll?.('.card-reward');
    if (!rewards?.length) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    requestAnimationFrame(() => {
        rewards.forEach(reward => {
            const viewport = reward.querySelector('.card-reward-viewport');
            const track = reward.querySelector('.card-reward-track');
            const text = reward.querySelector('.card-reward-text');
            if (!viewport || !track || !text || reward.classList.contains('is-marquee')) return;

            const overflow = text.scrollWidth - viewport.clientWidth;
            if (overflow <= 1) return;

            const clone = text.cloneNode(true);
            clone.setAttribute('aria-hidden', 'true');
            track.appendChild(clone);
            // 초당 26px 정도가 눈으로 따라 읽기 편한 속도다.
            const duration = Math.max(6, (text.scrollWidth + CARD_REWARD_MARQUEE_GAP) / 26);
            reward.style.setProperty('--marquee-duration', `${duration.toFixed(2)}s`);
            reward.classList.add('is-marquee');
        });
    });
}

async function filterCards() {
    const animate = arguments[0] === true;
    const requestedPage = Number.isSafeInteger(Number(arguments[1]))
        ? Math.max(1, Number(arguments[1]))
        : 1;
    const requestVersion = ++noticeListRequestVersion;
    noticePageLoading = true;
    updateNoticePaginationUI(noticeRepository.pagination, true);
    try {
        const result = await loadNoticePage(requestedPage);
        if (requestVersion !== noticeListRequestVersion) return;
        notices = result.notices;
        buildHostButtons();
        renderNoticeCards(animate);
        syncNoticeListUrl(result.pagination.page);
    } catch (error) {
        if (requestVersion !== noticeListRequestVersion) return;
        console.error('공지 필터 적용 실패:', error);
        const grid = document.getElementById('notice-grid');
        if (grid) {
            grid.innerHTML = `
                <div class="notice-empty-state is-error">
                    <strong>공지 목록을 불러오지 못했습니다.</strong>
                    <p>잠시 후 다시 시도해주세요.</p>
                    <button class="btn btn-outline btn-small" type="button" onclick="filterCards()">다시 시도</button>
                </div>
            `;
        }
    } finally {
        if (requestVersion === noticeListRequestVersion) {
            noticePageLoading = false;
            updateNoticePaginationUI(noticeRepository.pagination, false);
        }
    }
}

function scheduleNoticeSearch() {
    if (noticeSearchTimer) clearTimeout(noticeSearchTimer);
    noticeSearchTimer = setTimeout(() => filterCards(true), 220);
}

// ========================================
// 📄 상세 공지 & 이미지 & 비교
// ========================================

function navImage(dir, event) {
    if(event) event.stopPropagation();
    currentImageIndex += dir;
    if (currentImageIndex < 0) currentImageIndex = currentImageArray.length - 1;
    if (currentImageIndex >= currentImageArray.length) currentImageIndex = 0;
    updateImageViewer();
}

function navDetailImage(dir, event) {
    event?.stopPropagation();
    if (detailImageArray.length <= 1) return;
    detailImageIndex = (detailImageIndex + dir + detailImageArray.length) % detailImageArray.length;
    updateDetailImage();
}

function startImageSwipe(event) {
    imageSwipeStartX = event.touches?.[0]?.clientX ?? null;
}

function endImageSwipe(event, scope) {
    if (imageSwipeStartX === null) return;
    const endX = event.changedTouches?.[0]?.clientX ?? imageSwipeStartX;
    const delta = endX - imageSwipeStartX;
    imageSwipeStartX = null;
    if (Math.abs(delta) < 44) return;
    const direction = delta < 0 ? 1 : -1;
    if (scope === 'viewer') navImage(direction);
    else navDetailImage(direction);
}

function updateDetailImage() {
    const heroImg = document.getElementById('detail-hero-img');
    const previous = document.getElementById('detail-image-prev');
    const next = document.getElementById('detail-image-next');
    const counter = document.getElementById('detail-image-counter');
    const src = detailImageArray[detailImageIndex];
    if (!heroImg || !src) return;
    heroImg.src = src;
    const hasMultiple = detailImageArray.length > 1;
    if (previous) previous.hidden = !hasMultiple;
    if (next) next.hidden = !hasMultiple;
    if (counter) {
        counter.hidden = !hasMultiple;
        counter.textContent = `${detailImageIndex + 1} / ${detailImageArray.length}`;
    }
    document.querySelectorAll('#detail-gallery .gallery-img').forEach((image, index) => {
        image.classList.toggle('active', index === detailImageIndex);
    });
}

// 상세 화면의 "크게 보기" 버튼 전용 진입점. 버튼을 눌렀다는 뜻이 분명할 때만 연다.
function openDetailImageViewer(event) {
    event?.preventDefault();
    event?.stopPropagation();
    openImageViewer(detailImageIndex);
}

function openImageViewer(index) {
    const notice = notices.find(n => String(n.id) === currentViewId);
    if (!notice || !notice.images) return;
    currentImageArray = notice.images;
    currentImageIndex = index;

    if(currentImageArray.length <= 1) {
        document.getElementById('nav-left').style.display = 'none';
        document.getElementById('nav-right').style.display = 'none';
    } else {
        document.getElementById('nav-left').style.display = 'flex';
        document.getElementById('nav-right').style.display = 'flex';
    }

    updateImageViewer();
    openModal('image-viewer-modal');
}

function updateImageViewer() {
    const src = currentImageArray[currentImageIndex];
    document.getElementById('viewer-img').src = src;
    document.getElementById('viewer-download-btn').href = src;
    document.getElementById('img-counter').innerText = `${currentImageIndex + 1} / ${currentImageArray.length}`;
}

async function imageBlobAsPng(blob) {
    if (blob.type === 'image/png') return blob;
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close?.();
    return new Promise((resolve, reject) => {
        canvas.toBlob(
            png => png ? resolve(png) : reject(new Error('이미지 변환에 실패했습니다.')),
            'image/png'
        );
    });
}

async function copyCurrentViewerImage(event) {
    event?.stopPropagation();
    const src = currentImageArray[currentImageIndex];
    const button = document.getElementById('viewer-copy-btn');
    if (!src || !navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
        alert('이 브라우저에서는 이미지 복사를 지원하지 않습니다. 이미지에서 우클릭해 복사해주세요.');
        return;
    }

    const originalLabel = button?.textContent;
    if (button) {
        button.disabled = true;
        button.textContent = '복사 중…';
    }
    try {
        const response = await fetch(src);
        if (!response.ok) throw new Error(`이미지 응답 오류: ${response.status}`);
        const pngBlob = await imageBlobAsPng(await response.blob());
        await navigator.clipboard.write([
            new ClipboardItem({ 'image/png': pngBlob })
        ]);
        if (button) button.textContent = '복사됨';
        window.setTimeout(() => {
            if (button) button.textContent = originalLabel;
        }, 1200);
    } catch (error) {
        console.error('이미지 복사 실패:', error);
        alert('이미지를 복사하지 못했습니다. 이미지에서 우클릭해 복사하거나 다운로드를 이용해주세요.');
        if (button) button.textContent = originalLabel;
    } finally {
        if (button) button.disabled = false;
    }
}

/* 공지를 여는 동안 띄우는 표시. 곧바로 띄우면 빠른 회선에서 깜빡이기만
   하므로, 조금 걸릴 때에만 나타나게 잠깐 미룬다. */
let noticeLoadingTimer = null;

function showNoticeLoading() {
    const overlay = document.getElementById('notice-loading');
    if (!overlay) return;
    window.clearTimeout(noticeLoadingTimer);
    noticeLoadingTimer = window.setTimeout(() => {
        overlay.hidden = false;
        requestAnimationFrame(() => overlay.classList.add('visible'));
    }, 220);
}

function hideNoticeLoading() {
    const overlay = document.getElementById('notice-loading');
    window.clearTimeout(noticeLoadingTimer);
    noticeLoadingTimer = null;
    if (!overlay) return;
    overlay.classList.remove('visible');
    window.setTimeout(() => {
        if (!overlay.classList.contains('visible')) overlay.hidden = true;
    }, 160);
}

async function openDetail(idStr) {
    cancelNoticeHoverPreview();
    currentViewId = String(idStr);
    let notice;
    // 느린 회선에서는 상세가 오기까지 몇 초씩 걸린다. 그동안 아무 반응이
    // 없으면 눌리지 않은 줄 알고 다시 누르게 되므로 불러오는 중임을 알린다.
    showNoticeLoading();
    try {
        notice = await getNoticeDetail(currentViewId);
    } catch (error) {
        console.error('공지 상세 불러오기 실패:', error);
        hideNoticeLoading();
        alert('공지 상세를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.');
        return;
    } finally {
        hideNoticeLoading();
    }

    notice.views = (notice.views || 0) + 1;
    const datePresentation = getNoticeDatePresentation(notice);
    renderNoticeCards();

    apiRequest(`/api/notices/${currentViewId}/view`, { method: 'POST' })
        .then(result => {
            if (!result?.notice) return;
            const freshIdx = notices.findIndex(n => String(n.id) === String(result.notice.id));
            if (freshIdx !== -1) {
                notices[freshIdx].views = result.notice.views;
                if (String(currentViewId) === String(result.notice.id)) {
                    document.getElementById('detail-meta').innerHTML = formatDetailMeta(
                        datePresentation.dateLabel,
                        result.notice.views,
                        noticeRegisteredOn(result.notice)
                    );
                }
                renderNoticeCards();
            }
        })
        .catch(error => {
            console.error('조회수 반영 실패:', error);
        });

    document.getElementById('detail-tags').innerHTML = `
        ${datePresentation.badgeText
            ? `<span class="tag ${datePresentation.badgeClass}">${escapeHtml(datePresentation.badgeText)}</span>`
            : ''}
        ${notice.isPinned ? '<span class="tag pinned">고정</span>' : ''}
        <span class="tag target">${escapeHtml(formatNoticeTargetBadge(notice))}</span>
        ${notice.host ? `<span class="tag">${escapeHtml(notice.host)}</span>` : ''}
    `;
    document.getElementById('detail-title').innerText = notice.title || "";
    document.getElementById('detail-meta').innerHTML = formatDetailMeta(
        datePresentation.dateLabel,
        notice.views,
        noticeRegisteredOn(notice)
    );
    renderDetailDates(notice);
    document.getElementById('detail-summary').innerHTML = (notice.aiSummary || []).map(item => `<li>${escapeHtml(item)}</li>`).join('');
    document.getElementById('detail-content').innerHTML = linkify(notice.content || "");

    const sourceArea = document.getElementById('detail-source-area');
    const source = document.getElementById('detail-source');
    const attachmentList = document.getElementById('detail-attachments');
    const attachments = Array.isArray(notice.attachments) ? notice.attachments : [];
    source.innerHTML = notice.sourceUrl
        ? `<a href="${escapeHtml(safeHttpUrl(notice.sourceUrl))}" target="_blank" rel="noopener noreferrer">ECE 원문 열기</a>`
        : '';
    // 첨부는 서버를 거쳐 받는다. ECE 홈페이지가 Referer를 보고 막기 때문에
    // 원문 주소를 그대로 걸면 브라우저에서 전부 404가 난다.
    attachmentList.innerHTML = attachments.map((file, index) =>
        `<li><a href="${escapeHtml(buildApiUrl(`/api/notices/${encodeURIComponent(notice.id)}/attachments/${index}`))}"
                rel="noopener">${escapeHtml(file.name || '첨부파일')}</a></li>`
    ).join('');
    sourceArea.hidden = !notice.sourceUrl && attachments.length === 0;

    // 상세 상단 자체가 사진 넘김이 가능한 갤러리이고, 아래 썸네일로도 바로 이동한다.
    const hero = document.getElementById('detail-hero');
    const heroImg = document.getElementById('detail-hero-img');
    const gallery = document.getElementById('detail-gallery');
    gallery.innerHTML = '';
    if (notice.images && notice.images.length > 0) {
        detailImageArray = [...notice.images];
        detailImageIndex = 0;
        heroImg.style.cursor = 'zoom-in';
        hero.hidden = false;
        if (notice.images.length > 1) {
            notice.images.forEach((src, idx) => {
                gallery.innerHTML += `<button class="gallery-thumb" type="button" aria-label="${idx + 1}번 사진 보기"
                    onclick="detailImageIndex=${idx}; updateDetailImage()"><img src="${escapeHtml(src)}" class="gallery-img" alt=""></button>`;
            });
            gallery.style.display = 'flex';
        } else {
            gallery.style.display = 'none';
        }
        updateDetailImage();
    } else {
        detailImageArray = [];
        detailImageIndex = 0;
        hero.hidden = true;
        gallery.style.display = 'none';
    }

    showDetailView();
    detailHistoryPushed = syncUrlToNotice(currentViewId);
    recordBetaNoticeOpen();
}

function runNoticeSurfaceTransition(update, target) {
    update();
    if (!target) return;
    target.classList.remove('surface-entering');
    requestAnimationFrame(() => target.classList.add('surface-entering'));
    window.setTimeout(() => target.classList.remove('surface-entering'), 170);
}

// 목록을 숨기고 상세 페이지를 보인다. 모달이 아니라 화면 전체가 바뀐다.
function showDetailView() {
    const board = document.getElementById('board-view');
    const detail = document.getElementById('notice-detail-view');
    if (board && !board.hidden) boardScrollPosition = window.scrollY;
    runNoticeSurfaceTransition(() => {
        if (board) board.hidden = true;
        if (detail) detail.hidden = false;
        window.scrollTo({ top: 0, behavior: 'auto' });
        syncMobileStickySearch();
    }, detail);
}

function showBoardView() {
    const board = document.getElementById('board-view');
    const detail = document.getElementById('notice-detail-view');
    runNoticeSurfaceTransition(() => {
        if (detail) detail.hidden = true;
        if (board) board.hidden = false;
        currentViewId = null;
        window.scrollTo({ top: boardScrollPosition, behavior: 'auto' });
        syncMobileStickySearch();
    }, board);
}

// 상세에서 목록으로 돌아온다. 주소창의 ?id= 도 지운다.
function closeDetail() {
    if (new URLSearchParams(location.search).has(NOTICE_URL_PARAM) && detailHistoryPushed) {
        history.back();
        return;
    }
    detailHistoryPushed = false;
    clearNoticeUrl();
    showBoardView();
}

// ========================================
// 🧩 문서형 공지 블록
// 블록 자체는 절대 draggable이 아니다. 왼쪽 여백의 6점 핸들만 drag source이며,
// 문서 안에서는 위/아래 삽입선으로만 순서를 바꾼다.
// ========================================

const NOTICE_SPLIT_DRAG_TYPE = 'application/x-ece-notice-split';
const COMPARE_BLOCK_DRAG_TYPE = 'application/x-ece-compare-block';
const DESKTOP_MAX_COMPARE_BLOCKS = 4;
const MOBILE_MAX_COMPARE_BLOCKS = 0;

// 비교/분할은 정밀한 포인터 조작이 가능한 데스크톱에서만 제공한다.
function maxCompareBlocks() {
    return getLayoutMode() === 'mobile'
        ? MOBILE_MAX_COMPARE_BLOCKS
        : DESKTOP_MAX_COMPARE_BLOCKS;
}

function showSplitDropOverlay({ ignoreLimit = false } = {}) {
    const overlay = document.getElementById('split-drop-overlay');
    if (!overlay || maxCompareBlocks() === 0) return;
    // 새로 담을 때만 개수를 따진다. 이미 담긴 블록을 옮기는 경우는 예외다.
    if (!ignoreLimit && compareBlocks.length >= maxCompareBlocks()) return;
    overlay.hidden = false;
    const trash = document.getElementById('split-trash-overlay');
    if (trash) trash.hidden = false;
    requestAnimationFrame(() => {
        overlay.classList.add('visible');
        trash?.classList.add('visible');
    });
}

function hideSplitDropOverlay() {
    const overlay = document.getElementById('split-drop-overlay');
    const trash = document.getElementById('split-trash-overlay');
    overlay?.classList.remove('visible');
    trash?.classList.remove('visible');
    document.querySelectorAll('.split-drop-zone.active').forEach(zone => zone.classList.remove('active'));
    document.querySelectorAll('.compare-empty-slot.active')
        .forEach(zone => zone.classList.remove('active'));
    document.getElementById('compare-space')?.classList.remove('is-notice-drop-active');
    document.getElementById('spatial-workspace')?.classList.remove('is-notice-drop-active');
    window.setTimeout(() => {
        if (overlay && !overlay.classList.contains('visible')) overlay.hidden = true;
        if (trash && !trash.classList.contains('visible')) trash.hidden = true;
    }, 120);
}

function onNoticeSplitDragStart(event, id) {
    suspendNoticeHoverPreview();
    clearTimeout(noticeSplitOverlayTimer);
    noticeDragInProgress = true;
    document.body.classList.add('notice-dragging');
    activeNoticeSplitDragId = String(id);
    event.stopPropagation();
    event.dataTransfer.setData(NOTICE_SPLIT_DRAG_TYPE, activeNoticeSplitDragId);
    event.dataTransfer.setData('text/plain', activeNoticeSplitDragId);
    event.dataTransfer.effectAllowed = 'copyMove';
    const notice = notices.find(item => String(item.id) === activeNoticeSplitDragId);
    noticeSplitDragOverlay?.remove();
    noticeSplitDragOverlay = document.createElement('div');
    noticeSplitDragOverlay.className = 'notice-split-drag-overlay';
    noticeSplitDragOverlay.textContent = notice?.title || '공지';
    document.body.appendChild(noticeSplitDragOverlay);
    event.dataTransfer.setDragImage?.(noticeSplitDragOverlay, 24, 18);
    // dragstart 중 원본 카드가 움직이면 Chromium이 드래그 자체를 취소할 수 있다.
    // 네이티브 드래그가 확정된 다음 프레임에 삽입 위치를 펼친다.
    noticeSplitOverlayTimer = window.setTimeout(() => {
        if (noticeDragInProgress && activeNoticeSplitDragId) showSplitDropOverlay();
    }, 110);
}

function onNoticeSplitDragEnd() {
    clearTimeout(noticeSplitOverlayTimer);
    noticeSplitOverlayTimer = null;
    noticeDragInProgress = false;
    document.body.classList.remove('notice-dragging');
    suppressNoticeClickUntil = Date.now() + 300;
    noticeSplitDragOverlay?.remove();
    noticeSplitDragOverlay = null;
    window.setTimeout(() => {
        hideSplitDropOverlay();
        activeNoticeSplitDragId = '';
    }, 80);
}

function onNoticeHandlePointerDown(event, id) {
    if (event.isPrimary === false || (event.button !== undefined && event.button !== 0)) return;
    event.preventDefault();
    event.stopPropagation();
    pointerNoticeDrag = {
        id: String(id),
        pointerId: event.pointerId,
        handle: event.currentTarget,
        startX: event.clientX,
        startY: event.clientY,
        active: false,
        placement: ''
    };
    try {
        event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
        // 캡처가 거절되어도 document 단계의 포인터 추적은 계속 동작한다.
    }
    document.addEventListener('pointermove', onNoticeHandlePointerMove, { passive: false });
    document.addEventListener('pointerup', onNoticeHandlePointerEnd);
    document.addEventListener('pointercancel', onNoticeHandlePointerEnd);
}

function activatePointerNoticeDrag(event) {
    if (!pointerNoticeDrag || pointerNoticeDrag.active) return;
    pointerNoticeDrag.active = true;
    suspendNoticeHoverPreview();
    noticeDragInProgress = true;
    activeNoticeSplitDragId = pointerNoticeDrag.id;
    document.body.classList.add('notice-dragging');
    noticeSplitDragOverlay?.remove();
    noticeSplitDragOverlay = createNoticeDragGhost(pointerNoticeDrag.id, pointerNoticeDrag.handle);
    noticeSplitDragOverlay.classList.add('is-pointer-overlay');
    document.body.appendChild(noticeSplitDragOverlay);
    showSplitDropOverlay();
    positionNoticePointerOverlay(event.clientX, event.clientY);
}

/* 끌고 다니는 분신. 제목만 떠다니면 무엇을 집었는지 알기 어려우므로
   포스터와 본문까지 그대로 복제해 카드를 든 느낌을 준다.
   복제는 집는 순간 한 번만 하고, 이후에는 transform만 바꾸므로
   매 프레임 레이아웃을 다시 계산하지 않는다. */
function createNoticeDragGhost(id, handle) {
    const ghost = document.createElement('div');
    ghost.className = 'notice-split-drag-overlay';

    const card = handle?.closest?.('.card')
        || document.querySelector(`#notice-grid .card[data-notice-id="${CSS.escape(String(id))}"]`);
    const poster = card?.querySelector('.card-poster')?.cloneNode(true);
    const body = card?.querySelector('.card-body')?.cloneNode(true);

    if (poster || body) {
        // 지연 로드가 끝나지 않은 포스터는 빈 칸으로 복제되므로 원본 주소를 옮겨 준다.
        poster?.querySelectorAll('img[data-thumbnail-src]').forEach(image => {
            if (!image.getAttribute('src')) image.src = image.dataset.thumbnailSrc;
        });
        if (poster) ghost.appendChild(poster);
        if (body) ghost.appendChild(body);
    } else {
        ghost.textContent = notices.find(item => String(item.id) === String(id))?.title || '공지';
    }
    return ghost;
}

function positionNoticePointerOverlay(clientX, clientY) {
    if (!noticeSplitDragOverlay) return;
    noticeSplitDragOverlay.style.transform = `translate3d(${clientX + 16}px, ${clientY + 16}px, 0)`;
}

function onNoticeHandlePointerMove(event) {
    if (!pointerNoticeDrag || event.pointerId !== pointerNoticeDrag.pointerId) return;
    const distance = Math.hypot(
        event.clientX - pointerNoticeDrag.startX,
        event.clientY - pointerNoticeDrag.startY
    );
    if (!pointerNoticeDrag.active && distance < 6) return;
    event.preventDefault();
    activatePointerNoticeDrag(event);
    positionNoticePointerOverlay(event.clientX, event.clientY);
    document.querySelectorAll('.split-drop-zone.active, .compare-empty-slot.active')
        .forEach(zone => zone.classList.remove('active'));
    const target = findDropZoneUnderDrag(event.clientX, event.clientY);
    pointerNoticeDrag.placement = target?.dataset?.splitSide || target?.dataset?.placement || '';
    // 왼쪽·오른쪽·휴지통 셋 다 표적이다.
    if (['left', 'right', 'trash'].includes(pointerNoticeDrag.placement)) target.classList.add('active');
}

/* 표적을 고를 때 커서 한 점만 보지 않는다. 끌고 있는 카드가 표적에
   조금이라도 겹치면 그 표적을 켠다. 겹치는 표적이 여럿이면 더 많이
   겹친 쪽을 고른다. 커서를 정확히 올려야만 반응하면 큰 카드를 들고
   작은 버튼을 맞추기가 어렵다. */
/* 표적을 고르는 규칙은 하는 일에 따라 다르다.

   놓기(왼쪽·오른쪽)는 커서가 표적 위에 있어야 한다. 카드 전체로 판정하면
   목록 위를 지나가기만 해도 표적이 켜져, 어디에 놓이는지 종잡을 수 없다.

   버리기는 카드가 겹치기만 해도 켜진다. 화면 아래 구석까지 커서를 정확히
   끌고 가는 것보다, 카드를 그쪽으로 던지는 편이 자연스럽다. */
function findDropZoneUnderDrag(clientX, clientY, ghostElement = noticeSplitDragOverlay) {
    const zones = Array.from(document.querySelectorAll('.split-drop-zone, .compare-empty-slot'))
        .filter(zone => zone.offsetParent !== null || zone.getClientRects().length);
    if (!zones.length) return null;

    // 놓기 표적은 커서가 직접 올라가 있을 때만 잡는다.
    const pointed = document.elementFromPoint?.(clientX, clientY)
        ?.closest?.('.split-drop-zone, .compare-empty-slot');
    if (pointed) return pointed;

    const ghost = ghostElement?.getBoundingClientRect();
    if (!ghost || !ghost.width) return null;

    // 남은 것은 버리기뿐이다. 카드가 겹친 넓이가 가장 큰 것을 고른다.
    let best = null;
    let bestArea = 0;
    for (const zone of zones) {
        if (zone.dataset?.splitSide !== 'trash') continue;
        const rect = zone.getBoundingClientRect();
        const overlapX = Math.min(ghost.right, rect.right) - Math.max(ghost.left, rect.left);
        const overlapY = Math.min(ghost.bottom, rect.bottom) - Math.max(ghost.top, rect.top);
        if (overlapX <= 0 || overlapY <= 0) continue;
        const area = overlapX * overlapY;
        if (area > bestArea) {
            bestArea = area;
            best = zone;
        }
    }
    return best;
}

function onNoticeHandlePointerEnd(event) {
    if (!pointerNoticeDrag || event.pointerId !== pointerNoticeDrag.pointerId) return;
    const drag = pointerNoticeDrag;
    pointerNoticeDrag = null;
    document.removeEventListener('pointermove', onNoticeHandlePointerMove);
    document.removeEventListener('pointerup', onNoticeHandlePointerEnd);
    document.removeEventListener('pointercancel', onNoticeHandlePointerEnd);
    try {
        if (drag.handle?.hasPointerCapture?.(event.pointerId)) {
            drag.handle.releasePointerCapture(event.pointerId);
        }
    } catch {
        // 이미 취소된 포인터는 별도 해제가 필요 없다.
    }
    if (!drag.active) return;
    event.preventDefault();
    suppressNoticeClickUntil = Date.now() + 300;
    noticeDragInProgress = false;
    document.body.classList.remove('notice-dragging');
    noticeSplitDragOverlay?.remove();
    noticeSplitDragOverlay = null;
    document.getElementById('compare-trash-zone')?.classList.remove('active');
    if (['left', 'right'].includes(drag.placement)) {
        activeNoticeSplitDragId = drag.id;
        applyPendingNoticeSplit(drag.placement);
    } else {
        // 휴지통에 버렸거나 빈 곳에 놓았으면 담지 않는다.
        // 이미 담겨 있던 공지를 휴지통에 버린 경우에는 빼 준다.
        if (drag.placement === 'trash' && compareBlocks.includes(String(drag.id))) {
            removeFromCompareBlock(String(drag.id));
        }
        hideSplitDropOverlay();
        activeNoticeSplitDragId = '';
    }
}

function onSplitDropZoneDragOver(event) {
    if (!hasDragType(event, NOTICE_SPLIT_DRAG_TYPE)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    event.currentTarget.classList.add('active');
}

function onSplitDropZoneDragLeave(event) {
    if (!event.currentTarget.contains(event.relatedTarget)) {
        event.currentTarget.classList.remove('active');
    }
}

function onSplitDropZoneDrop(event, side) {
    if (!hasDragType(event, NOTICE_SPLIT_DRAG_TYPE)) return;
    event.preventDefault();
    event.stopPropagation();
    activeNoticeSplitDragId = event.dataTransfer.getData(NOTICE_SPLIT_DRAG_TYPE)
        || activeNoticeSplitDragId;
    applyPendingNoticeSplit(side);
}

function onCompareExternalNoticeDragOver(event) {
    if (!hasDragType(event, NOTICE_SPLIT_DRAG_TYPE)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    event.currentTarget.classList.add('active');
}

function onCompareExternalNoticeDragLeave(event) {
    if (!event.currentTarget.contains(event.relatedTarget)) {
        event.currentTarget.classList.remove('active');
    }
}

function onCompareExternalNoticeDrop(event, placement) {
    if (!hasDragType(event, NOTICE_SPLIT_DRAG_TYPE)) return;
    event.preventDefault();
    event.stopPropagation();
    activeNoticeSplitDragId = event.dataTransfer.getData(NOTICE_SPLIT_DRAG_TYPE)
        || activeNoticeSplitDragId;
    applyPendingNoticeSplit(placement);
}

async function finishNoticeBlockAddition(id) {
    renderCompareChange();
    try {
        await getNoticeDetail(id);
        renderCompareChange();
    } catch (error) {
        console.error('분할 공지 상세 불러오기 실패:', error);
    }
}

async function applyPendingNoticeSplit(placement) {
    const id = String(activeNoticeSplitDragId || '');
    if (!id) return;
    if (placement === 'trash') {
        hideSplitDropOverlay();
        activeNoticeSplitDragId = '';
        if (compareBlocks.includes(id)) removeFromCompareBlock(id);
        return;
    }
    if (!['left', 'right'].includes(placement)) return;
    const hadWorkspace = compareWorkspaceOpen && compareBlocks.length > 0;
    hideSplitDropOverlay();
    activeNoticeSplitDragId = '';
    if (compareBlocks.includes(id)) return;
    if (compareBlocks.length >= maxCompareBlocks()) {
        alert(`비교 블록은 최대 ${maxCompareBlocks()}개까지 묶을 수 있습니다.`);
        return;
    }
    if (!hadWorkspace) {
        // 첫 블록은 놓은 쪽에 붙는다. 오른쪽 표적에 놓았는데 왼쪽에 들어가면
        // 사용자가 방금 한 동작과 결과가 어긋난다.
        compareDockSide = placement;
        compareLayoutMode = 'stack';
        compareBlocks.push(id);
    } else if (placement === 'left') {
        compareBlocks.unshift(id);
        compareLayoutMode = 'columns';
    } else if (placement === 'right') {
        compareBlocks.push(id);
        compareLayoutMode = 'columns';
    }
    compareWorkspaceOpen = true;
    await finishNoticeBlockAddition(id);
}

function hasDragType(event, type) {
    return Array.from(event.dataTransfer?.types || []).includes(type);
}
function clearCompareDropIndicator() {
    document.querySelectorAll('.compare-col.is-drop-before, .compare-col.is-drop-after')
        .forEach(block => block.classList.remove('is-drop-before', 'is-drop-after'));
    activeCompareDropTargetId = '';
    activeCompareDropPosition = 'after';
}

function setCompareDropIndicator(block, clientY) {
    if (!block) return;
    const rect = block.getBoundingClientRect();
    const position = clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    clearCompareDropIndicator();
    block.classList.add(position === 'before' ? 'is-drop-before' : 'is-drop-after');
    activeCompareDropTargetId = String(block.dataset.compareId || '');
    activeCompareDropPosition = position;
}

function createCompareDragOverlay(block) {
    compareDragOverlay?.remove();
    compareDragOverlay = document.createElement('div');
    compareDragOverlay.className = 'compare-drag-overlay';
    const content = block?.querySelector('.compare-col-body')?.cloneNode(true);
    if (content) compareDragOverlay.appendChild(content);
    document.body.appendChild(compareDragOverlay);
    return compareDragOverlay;
}

function onCompareBlockDragStart(event, id) {
    event.stopPropagation();
    event.dataTransfer.setData(COMPARE_BLOCK_DRAG_TYPE, String(id));
    event.dataTransfer.effectAllowed = 'move';
    const block = event.currentTarget.closest('.compare-col');
    const overlay = createCompareDragOverlay(block);
    event.dataTransfer.setDragImage?.(overlay, 28, 22);
    requestAnimationFrame(() => block?.classList.add('is-dragging'));
    document.body.classList.add('reordering-compare-block');
}

function onCompareBlockDragEnd() {
    document.body.classList.remove('reordering-compare-block');
    document.querySelector('.compare-col.is-dragging')?.classList.remove('is-dragging');
    clearCompareDropIndicator();
    document.getElementById('compare-trash-zone')?.classList.remove('active');
    compareDragOverlay?.remove();
    compareDragOverlay = null;
}

function onCompareBlockDragOver(event, targetEl) {
    if (!hasDragType(event, COMPARE_BLOCK_DRAG_TYPE)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    setCompareDropIndicator(targetEl, event.clientY);
}

function onCompareBlockDrop(event, targetId) {
    if (!hasDragType(event, COMPARE_BLOCK_DRAG_TYPE)) return;
    event.preventDefault();
    event.stopPropagation();
    const sourceId = event.dataTransfer.getData(COMPARE_BLOCK_DRAG_TYPE);
    const position = activeCompareDropPosition;
    clearCompareDropIndicator();
    if (!sourceId || sourceId === String(targetId)) return;
    moveCompareBlock(sourceId, targetId, compareBlocks.length === 2 ? 'swap' : position);
}

function onCompareStageDragOver(event) {
    if (!hasDragType(event, COMPARE_BLOCK_DRAG_TYPE)) return;
    event.preventDefault();
    if (event.target === event.currentTarget) {
        clearCompareDropIndicator();
        activeCompareDropPosition = 'end';
    }
}

function onCompareStageDrop(event) {
    if (!hasDragType(event, COMPARE_BLOCK_DRAG_TYPE) || event.target !== event.currentTarget) return;
    event.preventDefault();
    const sourceId = event.dataTransfer.getData(COMPARE_BLOCK_DRAG_TYPE);
    clearCompareDropIndicator();
    moveCompareBlock(sourceId, '', 'end');
}

function positionComparePointerOverlay(clientX, clientY) {
    if (!compareDragOverlay) return;
    compareDragOverlay.style.transform = `translate3d(${clientX + 18}px, ${clientY + 18}px, 0)`;
}

function onCompareHandlePointerDown(event, id) {
    if (event.isPrimary === false || (event.button !== undefined && event.button !== 0)) return;
    event.preventDefault();
    event.stopPropagation();
    pointerDraggedCompareId = String(id);
    pointerDraggedComparePointerId = event.pointerId;
    pointerDragHandle = event.currentTarget;
    try {
        pointerDragHandle.setPointerCapture?.(event.pointerId);
    } catch {
        // 포인터 캡처 없이도 handle의 move/up 이벤트로 기본 조작은 유지한다.
    }
    const block = pointerDragHandle.closest('.compare-col');
    createCompareDragOverlay(block).classList.add('is-pointer-overlay');
    block?.classList.add('is-dragging');
    document.body.classList.add('reordering-compare-block');
    // 이미 놓은 블록도 다시 잡아 왼쪽·오른쪽으로 옮길 수 있어야 한다.
    // 자리를 새로 만드는 게 아니라 옮기는 것이므로 개수 제한은 보지 않는다.
    showSplitDropOverlay({ ignoreLimit: true });
    positionComparePointerOverlay(event.clientX, event.clientY);
    document.addEventListener('pointermove', onCompareHandlePointerMove, { passive: false });
    document.addEventListener('pointerup', onCompareHandlePointerEnd);
    document.addEventListener('pointercancel', cleanupComparePointerDrag);
}

function onCompareHandlePointerMove(event) {
    if (!pointerDraggedCompareId || event.pointerId !== pointerDraggedComparePointerId) return;
    event.preventDefault();
    positionComparePointerOverlay(event.clientX, event.clientY);
    const hoveredElement = document.elementFromPoint?.(event.clientX, event.clientY);
    const trash = hoveredElement?.closest?.('#compare-trash-zone');
    const trashZone = document.getElementById('compare-trash-zone');
    trashZone?.classList.toggle('active', Boolean(trash));

    // 위쪽 표적도 카드가 겹치기만 하면 켜진다. 커서를 정확히 맞출 필요가 없다.
    document.querySelectorAll('.split-drop-zone.active')
        .forEach(zone => zone.classList.remove('active'));
    const splitZone = trash
        ? null
        : findDropZoneUnderDrag(event.clientX, event.clientY, compareDragOverlay);
    pointerCompareSplitSide = splitZone?.dataset?.splitSide || '';
    if (splitZone) {
        splitZone.classList.add('active');
        clearCompareDropIndicator();
        return;
    }

    if (trash) {
        clearCompareDropIndicator();
        return;
    }
    const target = hoveredElement?.closest?.('.compare-col');
    if (target && String(target.dataset.compareId) !== pointerDraggedCompareId) {
        setCompareDropIndicator(target, event.clientY);
    } else {
        clearCompareDropIndicator();
    }
}

function onCompareHandlePointerEnd(event) {
    if (event.pointerId !== pointerDraggedComparePointerId) return;
    event.preventDefault();
    const sourceId = pointerDraggedCompareId;
    const targetId = activeCompareDropTargetId;
    const position = activeCompareDropPosition;
    const shouldRemove = document.getElementById('compare-trash-zone')?.classList.contains('active');
    const splitSide = pointerCompareSplitSide;
    cleanupComparePointerDrag();
    if (sourceId && (shouldRemove || splitSide === 'trash')) {
        removeFromCompareBlock(sourceId);
    } else if (sourceId && ['left', 'right'].includes(splitSide)) {
        redockCompareBlock(sourceId, splitSide);
    } else if (sourceId && targetId && sourceId !== targetId) {
        moveCompareBlock(sourceId, targetId, compareBlocks.length === 2 ? 'swap' : position);
    }
}

/* 이미 놓인 블록을 다시 잡아 왼쪽·오른쪽으로 옮긴다.
   블록이 하나면 화면에서 서는 쪽이 바뀌고, 여럿이면 순서의 맨 앞·맨 뒤로 간다. */
function redockCompareBlock(id, side) {
    const target = String(id);
    if (!compareBlocks.includes(target)) return;

    if (compareBlocks.length === 1) {
        if (compareDockSide === side) return;
        compareDockSide = side;
    } else {
        compareBlocks = compareBlocks.filter(blockId => blockId !== target);
        if (side === 'left') compareBlocks.unshift(target);
        else compareBlocks.push(target);
        compareLayoutMode = 'columns';
    }
    renderCompareChange();
}

function cleanupComparePointerDrag(event) {
    if (event?.pointerId !== undefined && event.pointerId !== pointerDraggedComparePointerId) return;
    document.removeEventListener('pointermove', onCompareHandlePointerMove);
    document.removeEventListener('pointerup', onCompareHandlePointerEnd);
    document.removeEventListener('pointercancel', cleanupComparePointerDrag);
    try {
        if (pointerDragHandle?.hasPointerCapture?.(pointerDraggedComparePointerId)) {
            pointerDragHandle.releasePointerCapture(pointerDraggedComparePointerId);
        }
    } catch {
        // 이미 사라진 포인터는 해제할 필요가 없다.
    }
    pointerDraggedCompareId = '';
    pointerDraggedComparePointerId = null;
    pointerDragHandle = null;
    pointerCompareSplitSide = '';
    document.body.classList.remove('reordering-compare-block');
    document.getElementById('compare-trash-zone')?.classList.remove('active');
    hideSplitDropOverlay();
    document.querySelector('.compare-col.is-dragging')?.classList.remove('is-dragging');
    clearCompareDropIndicator();
    compareDragOverlay?.remove();
    compareDragOverlay = null;
}

function moveCompareBlock(sourceId, targetId, position = 'after') {
    const source = String(sourceId);
    const target = String(targetId);
    if (position === 'swap' && compareBlocks.length === 2) {
        compareBlocks = [...compareBlocks].reverse();
        renderCompareChange();
        return;
    }
    const withoutSource = compareBlocks.filter(id => id !== source);
    if (!withoutSource.length || !compareBlocks.includes(source)) return;
    if (position === 'end') {
        withoutSource.push(source);
        compareBlocks = withoutSource;
        renderCompareChange();
        return;
    }
    const targetIndex = withoutSource.indexOf(target);
    if (targetIndex < 0) return;
    const insertAfter = position === 'after';
    withoutSource.splice(targetIndex + (insertAfter ? 1 : 0), 0, source);
    compareBlocks = withoutSource;
    renderCompareChange();
}

function onCompareTrashDragOver(event) {
    if (!hasDragType(event, COMPARE_BLOCK_DRAG_TYPE)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    event.currentTarget.classList.add('active');
    clearCompareDropIndicator();
}

function onCompareTrashDragLeave(event) {
    event.currentTarget.classList.remove('active');
}

function onCompareTrashDrop(event) {
    if (!hasDragType(event, COMPARE_BLOCK_DRAG_TYPE)) return;
    event.preventDefault();
    event.stopPropagation();
    const sourceId = event.dataTransfer.getData(COMPARE_BLOCK_DRAG_TYPE);
    event.currentTarget.classList.remove('active');
    if (sourceId) removeFromCompareBlock(sourceId);
}

async function addNoticeToCompareBlock(id) {
    const normalizedId = String(id);
    if (compareBlocks.includes(normalizedId)) return;
    if (compareBlocks.length >= maxCompareBlocks()) {
        alert(`비교 블록은 최대 ${maxCompareBlocks()}개까지 묶을 수 있습니다.`);
        return;
    }

    compareWorkspaceOpen = true;
    compareBlocks.push(normalizedId);
    renderCompareChange();
    try {
        await getNoticeDetail(normalizedId);
        renderCompareChange();
    } catch (error) {
        console.error('비교 블록 상세 불러오기 실패:', error);
    }
}

// 비교 블록 갱신은 즉시 반영한다. 브라우저 View Transition은 큰 영역을 캡처해
// 드래그 직후 프레임을 떨어뜨릴 수 있으므로 사용하지 않는다.
function renderCompareChange() {
    renderNoticeCards();
}

function removeFromCompareBlock(idStr) {
    expandedCompareBlocks.delete(String(idStr));
    compareBlocks = compareBlocks.filter(x => x !== String(idStr));
    // 두 블록 중 하나를 목록으로 돌려보내도 남은 한 블록의 공간은 그대로 유지한다.
    // 마지막 블록까지 제거했을 때만 일반 공지 목록으로 완전히 복귀한다.
    if (compareBlocks.length === 0) {
        compareWorkspaceOpen = false;
        compareLayoutMode = 'stack';
    }
    renderCompareChange();
}

function clearCompareBlock() {
    compareBlocks = [];
    expandedCompareBlocks.clear();
    compareWorkspaceOpen = false;
    compareLayoutMode = 'stack';
    renderCompareChange();
}

/* 더보기·접기.
   예전에는 누를 때마다 비교 공간을 통째로 다시 그렸다. 글이 길면 그리는 데
   시간이 걸려 툭 끊긴 느낌이 났고 스크롤 위치도 튀었다. 지금은 다시 그리지
   않고 해당 블록의 높이만 옮긴다. 높이는 한 번만 재고 나머지는 CSS가 맡는다. */
const COMPARE_BODY_COLLAPSED_HEIGHT = 440;

function toggleCompareBlockExpansion(idStr) {
    const id = String(idStr);
    const expanding = !expandedCompareBlocks.has(id);
    if (expanding) expandedCompareBlocks.add(id);
    else expandedCompareBlocks.delete(id);

    const block = document.querySelector(`.compare-col[data-compare-id="${CSS.escape(id)}"]`);
    const body = block?.querySelector('.compare-col-body');
    if (!block || !body) {
        // 화면에 없으면 예전처럼 다시 그린다.
        renderCompareSpace(compareBlocks);
        return;
    }

    const button = block.querySelector('.compare-col-more');
    if (button) {
        button.textContent = expanding ? '접기' : '더보기';
        button.setAttribute('aria-expanded', expanding ? 'true' : 'false');
    }
    animateCompareBodyHeight(block, body, expanding);
}

function animateCompareBodyHeight(block, body, expanding) {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        block.classList.toggle('is-expanded', expanding);
        body.style.removeProperty('max-height');
        return;
    }

    const startHeight = body.getBoundingClientRect().height;
    // 펼쳤을 때의 실제 높이를 재려면 잠시 제한을 풀어야 한다. 재는 동안에는
    // 전환을 꺼 두어 중간 상태가 화면에 비치지 않게 한다.
    body.style.transition = 'none';
    body.style.maxHeight = 'none';
    block.classList.toggle('is-expanded', expanding);
    const endHeight = expanding ? body.scrollHeight : COMPARE_BODY_COLLAPSED_HEIGHT;

    body.style.maxHeight = `${startHeight}px`;
    body.style.overflow = 'hidden';
    // 강제로 한 번 읽어 위 값이 시작점으로 굳게 만든다.
    void body.offsetHeight;
    body.style.removeProperty('transition');

    requestAnimationFrame(() => {
        body.style.maxHeight = `${endHeight}px`;
    });

    const settle = event => {
        if (event.propertyName !== 'max-height') return;
        body.removeEventListener('transitionend', settle);
        // 펼친 뒤에는 제한을 아예 풀어야 내용이 더 늘어나도 잘리지 않는다.
        body.style.removeProperty('max-height');
        body.style.removeProperty('overflow');
    };
    body.addEventListener('transitionend', settle);
}

function renderCompareSpace(blockIds = compareBlocks) {
    const workspace = document.getElementById('spatial-workspace');
    const space = document.getElementById('compare-space');
    const stage = document.getElementById('compare-space-stage');
    if (!space || !stage) return;
    if (!compareWorkspaceOpen) {
        workspace?.classList.remove('is-split');
        workspace?.removeAttribute('data-dock');
        workspace?.removeAttribute('data-blocks');
        space.hidden = true;
        stage.innerHTML = '';
        return;
    }

    workspace?.classList.add('is-split');
    if (workspace) {
        workspace.dataset.dock = compareDockSide;
        workspace.dataset.blocks = String(blockIds.length);
    }
    space.hidden = false;
    space.dataset.blocks = String(blockIds.length);
    stage.dataset.layout = compareLayoutMode;

    const blocks = blockIds.map((id, index) => {
        const notice = notices.find(n => String(n.id) === String(id));
        if (!notice) return '';
        const datePresentation = getNoticeDatePresentation(notice);
        const summary = (notice.aiSummary || []).map(item => `<li>${escapeHtml(item)}</li>`).join('')
            || '<li class="is-empty">요약 없음</li>';
        const thumb = (notice.images && notice.images.length > 0)
            ? `<img class="compare-col-thumb" src="${escapeHtml(notice.images[0])}" alt="">`
            : '';
        const dateText = datePresentation.dateLabel;
        const safeId = escapeHtml(String(id));
        const expanded = expandedCompareBlocks.has(String(id));
        const dockClass = blockIds.length === 1
            ? (compareDockSide === 'left' ? ' is-docked-left' : ' is-docked-right')
            : '';
        return `
            <article class="compare-col notion-block${expanded ? ' is-expanded' : ''}${dockClass}"
                     data-compare-id="${safeId}" tabindex="0">
                <div class="compare-col-controls" aria-label="${index + 1}번 블록 도구">
                    <button class="compare-col-drag-handle" type="button" draggable="false"
                            aria-label="${index + 1}번 블록 순서 변경" title="끌어서 블록 순서 변경">
                        <svg width="10" height="16" viewBox="0 0 10 16" aria-hidden="true"><g fill="currentColor"><circle cx="2.5" cy="3" r="1.3"/><circle cx="7.5" cy="3" r="1.3"/><circle cx="2.5" cy="8" r="1.3"/><circle cx="7.5" cy="8" r="1.3"/><circle cx="2.5" cy="13" r="1.3"/><circle cx="7.5" cy="13" r="1.3"/></g></svg>
                    </button>
                </div>
                <button class="compare-col-remove" type="button" aria-label="문서에서 블록 제거"
                        title="블록 제거" onclick="removeFromCompareBlock('${safeId}')">×</button>
                <div class="compare-col-body">
                    <p class="compare-col-kicker">${escapeHtml([
                        datePresentation.badgeText,
                        notice.isPinned ? '고정' : '',
                        formatNoticeTargetBadge(notice),
                        notice.host || '기타'
                    ].filter(Boolean).join(' · '))}</p>
                    <h3 class="compare-col-title">${escapeHtml(notice.title || '')}</h3>
                    <div class="compare-col-meta">${dateText ? `${escapeHtml(dateText)} · ` : ''}조회 ${Number(notice.views) || 0}</div>
                    ${thumb}
                    <div class="compare-summary-heading">
                        <h4 class="compare-col-label">AI 3줄 요약</h4>
                    </div>
                    <ul class="compare-col-summary">${summary}</ul>
                    <h4 class="compare-col-label">공지 원문</h4>
                    <div class="compare-col-content">${linkify(notice.content || '')}</div>
                    <button class="compare-col-open" type="button" onclick="openDetail('${safeId}')">전체 공지 열기 →</button>
                </div>
                <button class="compare-col-more" type="button"
                        aria-expanded="${expanded ? 'true' : 'false'}"
                        onclick="toggleCompareBlockExpansion('${safeId}')">
                    ${expanded ? '접기' : '더보기'}
                </button>
            </article>`;
    }).join('');

    const canAddBlock = blockIds.length < maxCompareBlocks();
    const emptyOnLeft = false;
    const emptyPlacement = 'right';
    const emptySlot = canAddBlock ? `
        <button class="compare-empty-slot ${emptyOnLeft ? 'is-left' : 'is-right'}" type="button"
                data-placement="${emptyPlacement}" aria-label="빈 반쪽에 공지 블록 추가"
                ondragover="onCompareExternalNoticeDragOver(event)"
                ondragleave="onCompareExternalNoticeDragLeave(event)"
                ondrop="onCompareExternalNoticeDrop(event, '${emptyPlacement}')">
            <span aria-hidden="true">+</span>
            <strong>이쪽에 공지 놓기</strong>
        </button>` : '';

    stage.innerHTML = emptyOnLeft ? `${emptySlot}${blocks}` : `${blocks}${emptySlot}`;

    stage.querySelectorAll('.compare-col').forEach(block => {
        const id = block.dataset.compareId;
        const handle = block.querySelector('.compare-col-drag-handle');
        handle.addEventListener('pointerdown', event => onCompareHandlePointerDown(event, id));
        block.addEventListener('dragover', event => onCompareBlockDragOver(event, block));
        block.addEventListener('drop', event => onCompareBlockDrop(event, id));
    });
}

// ========================================
// 🔔 알림 구독 (제목 옆 종 아이콘)
// ========================================

function pushSupported() {
    return 'serviceWorker' in navigator
        && 'PushManager' in window
        && 'Notification' in window;
}

function base64UrlToBytes(value) {
    const padding = '='.repeat((4 - value.length % 4) % 4);
    const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from(raw, character => character.charCodeAt(0));
}

function isPushSubscribed() {
    return Boolean(localStorage.getItem('ecePushSubscriptionId'));
}

// 종은 구독 상태를 그대로 비춘다. 꺼짐이면 흑백, 켜짐이면 노란색.
function updateBellState() {
    const bell = document.getElementById('bell-toggle');
    if (!bell) return;
    const subscribed = isPushSubscribed();
    bell.classList.toggle('active', subscribed);
    bell.setAttribute('aria-pressed', subscribed ? 'true' : 'false');
    bell.title = subscribed ? '알림 켜짐 — 눌러서 설정 변경' : '공지 알림 받기';
    bell.setAttribute('aria-label', subscribed ? '알림 설정 변경' : '공지 알림 받기');
}

function setNotificationStatus(message, isError = false) {
    const status = document.getElementById('notification-status');
    if (!status) return;
    status.textContent = message || '';
    status.style.color = isError ? 'var(--danger)' : 'var(--text-sub)';
}

async function loadNotificationCategories() {
    const list = document.getElementById('notification-category-list');
    if (!list) return;
    if (activeCategories.length === 0) await loadCategories();
    if (activeCategories.length === 0) {
        list.innerHTML = '<span class="review-list-meta">등록된 카테고리가 없습니다.</span>';
        return;
    }
    list.innerHTML = activeCategories.map(category => `
        <label><input type="checkbox" name="notification-category" value="${Number(category.id)}">
        ${escapeHtml(category.name)}</label>
    `).join('');
}

async function openNotificationPreferences() {
    if (typeof closeMobileDrawer === 'function') closeMobileDrawer();
    const modal = document.getElementById('notification-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');

    const unsupported = document.getElementById('notification-unsupported');
    const form = document.getElementById('notification-form');
    if (!pushSupported()) {
        unsupported.hidden = false;
        form.hidden = true;
        return;
    }
    unsupported.hidden = true;
    form.hidden = false;

    await loadNotificationCategories();
    document.getElementById('notification-delete').hidden = !isPushSubscribed();
    setNotificationStatus(isPushSubscribed()
        ? '이 브라우저는 이미 알림을 받고 있습니다. 설정을 바꾸고 저장하세요.'
        : '알림을 허용하면 새 공지를 바로 알려드립니다.');
    modal.querySelector('.close-btn')?.focus();
}

function closeNotificationPreferences() {
    const modal = document.getElementById('notification-modal');
    if (!modal) return;
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
}

function collectNotificationPreferences() {
    const categoryIds = Array.from(
        document.querySelectorAll('input[name="notification-category"]:checked')
    ).map(input => Number(input.value));
    return {
        year: document.getElementById('notification-year').value || null,
        allCategories: document.getElementById('notification-all').checked,
        categoryIds,
        includeUrgent: document.getElementById('notification-urgent').checked,
        reminderDaysBefore: Number(document.getElementById('notification-reminder').value) || null
    };
}

async function saveNotificationPreferences() {
    if (!pushSupported()) return;
    const button = document.getElementById('notification-save');
    button.disabled = true;
    setNotificationStatus('알림 권한을 확인하고 있습니다.');
    try {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
            setNotificationStatus('브라우저에서 알림이 차단되어 있습니다. 사이트 설정에서 허용해주세요.', true);
            return;
        }

        const config = await apiRequest('/api/push/public-key', { method: 'GET' });
        if (!config?.publicKey) throw new Error('서버에 알림 키가 설정되어 있지 않습니다.');

        const registration = await navigator.serviceWorker.ready;
        const existing = await registration.pushManager.getSubscription();
        const subscription = existing || await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: base64UrlToBytes(config.publicKey)
        });

        const result = await apiRequest('/api/push/subscriptions', {
            method: 'POST',
            body: JSON.stringify({
                subscription: subscription.toJSON(),
                preferences: collectNotificationPreferences()
            })
        });

        // 서버는 { subscription: { id, ... }, managementToken } 을 돌려준다.
        // 여기서 id를 놓치면 종은 계속 꺼진 채 저장만 성공한 것처럼 보인다.
        if (!result?.subscription?.id) {
            throw new Error('서버가 구독 정보를 돌려주지 않았습니다. 잠시 후 다시 시도해주세요.');
        }
        localStorage.setItem('ecePushSubscriptionId', String(result.subscription.id));
        if (result?.managementToken) localStorage.setItem('ecePushManagementToken', result.managementToken);

        document.getElementById('notification-delete').hidden = false;
        updateBellState();
        setNotificationStatus('알림 설정이 저장되었습니다.');
    } catch (error) {
        setNotificationStatus(error.message, true);
    } finally {
        button.disabled = false;
    }
}

async function unsubscribeNotifications() {
    const subscriptionId = localStorage.getItem('ecePushSubscriptionId');
    const managementToken = localStorage.getItem('ecePushManagementToken');
    if (!subscriptionId || !managementToken) return;
    const button = document.getElementById('notification-delete');
    button.disabled = true;
    setNotificationStatus('알림 구독을 해지하고 있습니다.');
    try {
        await apiRequest(`/api/push/subscriptions/${encodeURIComponent(subscriptionId)}`, {
            method: 'DELETE',
            headers: { 'x-subscription-token': managementToken },
            body: JSON.stringify({})
        });
        const registration = await navigator.serviceWorker.ready;
        const browserSubscription = await registration.pushManager.getSubscription();
        await browserSubscription?.unsubscribe();
        localStorage.removeItem('ecePushSubscriptionId');
        localStorage.removeItem('ecePushManagementToken');
        button.hidden = true;
        updateBellState();
        setNotificationStatus('알림 구독을 해지했습니다.');
    } catch (error) {
        setNotificationStatus(error.message, true);
    } finally {
        button.disabled = false;
    }
}

// ========================================
// 🔐 초기화 & 이벤트
// ========================================

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/service-worker.js').catch(error => {
            console.error('서비스 워커 등록 실패:', error);
        });
    });
}

document.addEventListener('keydown', function(e) {
    const viewer = document.getElementById('image-viewer-modal');
    if (viewer && viewer.style.display === 'flex') {
        if (e.key === 'ArrowLeft') navImage(-1);
        if (e.key === 'ArrowRight') navImage(1);
        if (e.key === 'Escape') closeModal('image-viewer-modal');
        return;
    }
    const detail = document.getElementById('notice-detail-view');
    if (detail && !detail.hidden && detailImageArray.length > 1) {
        if (e.key === 'ArrowLeft') {
            navDetailImage(-1);
            return;
        }
        if (e.key === 'ArrowRight') {
            navDetailImage(1);
            return;
        }
    }
    if (e.key !== 'Escape') return;

    // ESC 우선순위: 폰 미리보기 → 알림 설정 → 상세 페이지
    if (document.getElementById('device-preview') && !document.getElementById('device-preview').hidden) {
        closeDevicePreview();
    } else if (document.getElementById('notification-modal')?.style.display === 'flex') {
        closeNotificationPreferences();
    } else if (document.getElementById('notice-detail-view') && !document.getElementById('notice-detail-view').hidden) {
        closeDetail();
    }
});

// 공개 화면에서만 목록을 렌더한다. admin.html은 core.js의 유틸만 빌려 쓴다.
document.addEventListener('DOMContentLoaded', async function () {
    if (document.body.dataset.page !== 'public') return;

    initializeBetaAnalytics();
    updateLayoutToggleLabel();
    initializeResponsiveLayout();
    applyViewModule(getLayoutMode());
    updateBellState();
    startRailClock();
    initializeFooter();
    watchNoticeSortThumb();
    watchNoticeHoverPreviewScroll();
    watchMobileStickySearch();
    initializeGuideHint();

    await Promise.all([loadData(), loadCategories()]);
    const initialNoticePage = restoreNoticeListStateFromUrl();
    syncNoticeSortChips();
    updateFilterChips();
    await filterCards(false, initialNoticePage);
    openNoticeFromUrl();   // 카톡 링크로 들어온 경우 해당 공지를 바로 연다
});
