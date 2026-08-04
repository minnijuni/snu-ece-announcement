// ========================================
// SNU ECE 공지방 — admin.js
// 관리자 페이지(admin.html) 전용. 공개 화면(index.html)에는 로드되지 않으므로
// 학생이 보는 번들에 관리자 UI가 섞이지 않는다.
// core.js의 apiRequest / escapeHtml / 토큰 헤더 헬퍼를 그대로 빌려 쓴다.
// ========================================

// gemini-2.5-flash 는 신규 키에서 막혀 있어 상시 최신 별칭을 쓴다.
const GEMINI_MODEL = "gemini-flash-latest";

let reviewNotices = [];
let selectedReviewNoticeId = null;
let reviewMutationInFlight = false;
let editingNoticeId = null;
let pendingEditNoticeId = null;
// 클립보드에서 붙여넣은 이미지들(base64 data URL). 파일 첨부와 함께 저장된다.
let pastedImages = [];
const MAX_NOTICE_IMAGES = 20;
let composeAiCategoryIds = [];
let composeSurveyReward = '';
let composeHasReward = false;
let composeRequiresAction = false;
let aiDeadlineCandidate = '';
let aiProgressTimer = null;
let aiProgressValue = 0;
let aiProgressCeiling = 0;
let aiProgressActiveStep = 'prepare';
let crawlProgressTimer = null;
let crawlProgressValue = 0;
let reviewInboxPollTimer = null;
let reviewInboxPollInFlight = false;
let adminFeedbackItems = [];
let adminFeedbackFilter = 'all';
let adminNoticePagination = { page: 0, total: 0, totalPages: 0 };
let kakaoBackfillBatchId = '';
let kakaoBackfillDrafts = [];

// 제목 양식에서 쓰는 유형 목록. 편집할 때 기존 제목을 되돌려 읽는 데에도 쓴다.
const TITLE_KINDS = ['모집', '안내', '신청', '접수', '공지', '행사', '변경 안내', '결과 발표', '기간 연장', '설문', '제휴'];
const AI_PROGRESS_STEPS = ['prepare', 'analyze', 'process'];

function setAiProgress(value, status, activeStep = null, ceiling = value) {
    aiProgressValue = Math.max(aiProgressValue, Math.min(100, Math.round(value)));
    aiProgressCeiling = Math.max(aiProgressValue, Math.min(98, Math.round(ceiling)));
    if (AI_PROGRESS_STEPS.includes(activeStep)) aiProgressActiveStep = activeStep;
    const bar = document.getElementById('ai-progress-bar');
    const percent = document.getElementById('ai-progress-percent');
    const message = document.getElementById('ai-progress-status');
    if (bar) bar.value = aiProgressValue;
    if (percent) percent.textContent = `${aiProgressValue}%`;
    if (message && status) message.textContent = status;

    const activeIndex = AI_PROGRESS_STEPS.indexOf(aiProgressActiveStep);
    document.querySelectorAll('[data-ai-step]').forEach(item => {
        const index = AI_PROGRESS_STEPS.indexOf(item.dataset.aiStep);
        item.classList.toggle('done', activeIndex >= 0 && index < activeIndex);
        item.classList.toggle('active', index === activeIndex && aiProgressValue < 100);
    });
}

function beginAiProgress(status = '원문을 준비하고 있습니다.') {
    if (aiProgressTimer) clearInterval(aiProgressTimer);
    aiProgressValue = 0;
    aiProgressCeiling = 15;
    aiProgressActiveStep = 'prepare';
    const overlay = document.getElementById('ai-loading');
    overlay.classList.remove('rate-limited');
    overlay.style.display = 'flex';
    document.getElementById('ai-progress-heading').innerHTML = '<strong>Gemini AI</strong> 작업 중';
    setAiProgress(5, status, 'prepare', 15);
    aiProgressTimer = setInterval(() => {
        if (aiProgressValue < aiProgressCeiling) {
            setAiProgress(aiProgressValue + 1, null, null, aiProgressCeiling);
        }
    }, 450);
}

function updateAiProgress(value, status, activeStep, ceiling = value + 12) {
    setAiProgress(value, status, activeStep, ceiling);
}

function finishAiProgress(status = '작업이 완료되었습니다.') {
    if (aiProgressTimer) clearInterval(aiProgressTimer);
    aiProgressTimer = null;
    setAiProgress(100, status, 'process', 100);
    document.querySelectorAll('[data-ai-step]').forEach(item => {
        item.classList.remove('active');
        item.classList.add('done');
    });
}

function hideAiProgress() {
    if (aiProgressTimer) clearInterval(aiProgressTimer);
    aiProgressTimer = null;
    const overlay = document.getElementById('ai-loading');
    overlay.style.display = 'none';
    overlay.classList.remove('rate-limited');
}

function isGeminiRateLimitError(error) {
    return error?.code === 'GEMINI_RATE_LIMIT' || Number(error?.status) === 429;
}

async function showGeminiRetryCountdown(error) {
    if (aiProgressTimer) clearInterval(aiProgressTimer);
    aiProgressTimer = null;
    const overlay = document.getElementById('ai-loading');
    const heading = document.getElementById('ai-progress-heading');
    const status = document.getElementById('ai-progress-status');
    const timer = document.getElementById('ai-progress-percent');
    let remaining = Math.max(1, Math.ceil(Number(error?.retryAfterSeconds) || 60));

    overlay.classList.add('rate-limited');
    overlay.style.display = 'flex';
    heading.textContent = 'Gemini 호출 대기';
    while (remaining > 0) {
        status.textContent = `분당 호출 초과로 ${remaining}초 뒤에 다시 실행 부탁드립니다.`;
        timer.textContent = `${remaining}초`;
        await new Promise(resolve => setTimeout(resolve, 1000));
        remaining -= 1;
    }
    status.textContent = '다시 실행할 수 있습니다.';
    timer.textContent = '0초';
    await new Promise(resolve => setTimeout(resolve, 700));
}

/* 역할별로 열리는 탭.
   마스터는 전부, 공지 관리자는 공지 관련 셋, 배너 관리자는 배너만 본다. */
const ADMIN_TABS_BY_ROLE = Object.freeze({
    master: ['review', 'backfill', 'compose', 'notices', 'banner', 'banner-inquiry', 'feedback', 'analytics', 'settings'],
    notice: ['review', 'backfill', 'compose', 'notices'],
    banner: ['banner', 'banner-inquiry']
});

const ADMIN_ROLE_LABELS = Object.freeze({
    master: '마스터 관리자',
    notice: '공지 관리자',
    banner: '배너 관리자'
});

let currentAdminRole = 'notice';

function allowedAdminTabs() {
    return ADMIN_TABS_BY_ROLE[currentAdminRole] || ADMIN_TABS_BY_ROLE.notice;
}

function canUseAdminTab(name) {
    return allowedAdminTabs().includes(name);
}

/* 쓸 수 없는 탭은 감추는 게 아니라 아예 지운다. 화면에 남겨 두면
   눌러지지 않는 버튼이 무엇을 뜻하는지 알 수 없어 더 헷갈린다. */
function applyAdminRoleToChrome() {
    const allowed = allowedAdminTabs();
    document.querySelectorAll('.admin-tab').forEach(tab => {
        if (!allowed.includes(tab.dataset.tab)) tab.remove();
    });
    document.querySelectorAll('.admin-panel').forEach(panel => {
        const name = panel.id.replace(/^panel-/, '');
        if (!allowed.includes(name)) panel.remove();
    });

    const reportButton = document.getElementById('staff-report-open');
    if (reportButton && currentAdminRole === 'master') reportButton.remove();

    const badge = document.querySelector('.admin-badge');
    if (badge) badge.textContent = ADMIN_ROLE_LABELS[currentAdminRole] || 'ADMIN';
    document.body.dataset.adminRole = currentAdminRole;
}

async function enterAdminWorkspace() {
    const workspace = document.getElementById('admin-workspace');
    if (workspace) workspace.hidden = false;
    document.getElementById('admin-mode-exit').textContent = '관리자 모드 나가기';

    applyAdminRoleToChrome();
    restoreAiModeChoice();
    // 첫 화면은 그 역할이 실제로 쓸 수 있는 탭이어야 한다.
    selectAdminTab(allowedAdminTabs()[0]);

    if (canUseAdminTab('review')) {
        await loadCategories();
        await loadReviewNotices();
        startReviewInboxPolling();
    }
    // 탭 배지에 문의 수를 채운다(백그라운드). 배너 관리자는 배너 문의만 받는다.
    if (canUseAdminTab('feedback') || canUseAdminTab('banner')) loadAdminFeedback();

    // 공개 화면의 "관리자 페이지에서 수정" 링크로 들어온 경우 바로 편집 폼을 연다.
    if (pendingEditNoticeId && canUseAdminTab('notices')) {
        const target = pendingEditNoticeId;
        pendingEditNoticeId = null;
        selectAdminTab('notices');
        await loadAdminNoticeList();
        await editAdminNotice(target);
    }
}

async function exitAdminMode() {
    noticeAdminAuthToken = '';
    superAdminAuthToken = '';
    bannerManageAuthToken = '';
    sessionStorage.removeItem('eceNoticeAdminToken');
    sessionStorage.removeItem('eceAdminToken');
    sessionStorage.removeItem('eceSuperAdminToken');
    sessionStorage.removeItem('eceBannerManageToken');
    try {
        // core.js와 같은 규칙으로 API 주소를 만들고 쿠키를 함께 보낸다.
        // 상대 경로로 부르면 정적 호스트로 가서 세션이 남는다.
        await fetch(buildApiUrl('/api/admin/session'), {
            method: 'DELETE',
            credentials: 'include'
        });
    } finally {
        // 나가면 공개 화면이 아니라 들어왔던 로그인 화면으로 돌아간다.
        // 정적 호스트에서 /admin은 이 워크스페이스 자신이라 파일 이름을 쓴다.
        location.replace('/admin-login.html');
    }
}

// ========================================
// 🗂 탭
// ========================================

function selectAdminTab(name) {
    if (!canUseAdminTab(name)) return;
    document.querySelectorAll('.admin-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.tab === name);
    });
    document.querySelectorAll('.admin-panel').forEach(panel => {
        panel.classList.toggle('active', panel.id === `panel-${name}`);
    });

    if (name === 'notices') loadAdminNoticeList();
    if (name === 'feedback') loadAdminFeedback();
    if (name === 'banner-inquiry') loadAdminFeedback();
    if (name === 'analytics') loadBetaAnalytics();
    // 로그인할 때 이미 신분을 확인했으므로 배너·설정에서 비밀번호를 다시 묻지 않는다.
    if (name === 'banner') unlockBannerPanel();
    if (name === 'settings') unlockSettingsPanel();
}

function setKakaoBackfillStatus(message, isError = false) {
    const status = document.getElementById('kakao-backfill-status');
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('error', isError);
}

function formatBackfillDateTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('ko-KR', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    }).format(date);
}

function renderKakaoBackfillPreview(stats) {
    const summary = document.getElementById('kakao-backfill-summary');
    const wrap = document.getElementById('kakao-backfill-table-wrap');
    const rows = document.getElementById('kakao-backfill-rows');
    if (!summary || !wrap || !rows) return;
    const unclassifiedPercent = ((Number(stats?.unclassifiedRate) || 0) * 100).toFixed(1);
    summary.hidden = false;
    summary.innerHTML = `
        메시지 <strong>${Number(stats?.messageCount) || 0}건</strong> →
        검토 초안 <strong>${Number(stats?.draftCount) || 0}건</strong> ·
        30일 내 재공지 묶음 <strong>${Number(stats?.groupedDuplicateCount) || 0}건</strong> ·
        미분류 <strong>${Number(stats?.unclassifiedCount) || 0}건 (${unclassifiedPercent}%)</strong>
    `;
    const categoryOptions = orderedNoticeCategories().map(category =>
        `<option value="${escapeHtml(category.slug)}">${escapeHtml(category.name)}</option>`
    ).join('');
    rows.innerHTML = kakaoBackfillDrafts.map((draft, index) => `
        <tr data-backfill-index="${index}">
            <td><input class="backfill-include" type="checkbox" checked aria-label="${escapeHtml(draft.title)} 포함"></td>
            <td>
                <span class="backfill-meta">
                    <strong>${escapeHtml(draft.sourceGroup || '미확인')}</strong>
                    <span>${escapeHtml(draft.sender || '')}</span>
                    <time>${escapeHtml(formatBackfillDateTime(draft.sourcePublishedAt))}</time>
                </span>
            </td>
            <td>
                <input class="backfill-title" type="text" maxlength="200" value="${escapeHtml(draft.title || '')}">
                <small>${escapeHtml(draft.contentPreview || '')}</small>
            </td>
            <td><input class="backfill-host" type="text" maxlength="80" value="${escapeHtml(draft.host || '')}"></td>
            <td>
                <select class="backfill-category" aria-label="분류 초안">
                    <option value="">분류 선택</option>
                    ${categoryOptions}
                </select>
            </td>
            <td>
                <span class="backfill-thread-count">재공지 ${Number(draft.reminderCount) || 0}건</span>
                <small>사진 ${Number(draft.imageAttachmentCount) || 0} · 파일 ${Number(draft.attachmentCount) || 0}</small>
            </td>
        </tr>
    `).join('');
    rows.querySelectorAll('tr').forEach((row, index) => {
        row.querySelector('.backfill-category').value = kakaoBackfillDrafts[index]?.categorySlug || '';
    });
    wrap.hidden = kakaoBackfillDrafts.length === 0;
}

async function previewKakaoBackfill() {
    const input = document.getElementById('kakao-backfill-file');
    const button = document.getElementById('kakao-backfill-preview-button');
    const file = input?.files?.[0];
    if (!file) {
        setKakaoBackfillStatus('카카오톡 대화 내보내기 .txt 파일을 선택해주세요.', true);
        return;
    }
    button.disabled = true;
    setKakaoBackfillStatus('원본 개행을 유지한 채 메시지와 재공지 묶음을 분석하고 있습니다.');
    try {
        const result = await apiRequest('/api/admin/backfill/kakao/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            body: await file.arrayBuffer()
        });
        kakaoBackfillBatchId = result.batchId;
        kakaoBackfillDrafts = Array.isArray(result.drafts) ? result.drafts : [];
        renderKakaoBackfillPreview(result.stats || {});
        setKakaoBackfillStatus('자동 분류는 초안입니다. 제목·발신 주체·카테고리를 확인한 뒤 검수함으로 보내세요.');
    } catch (error) {
        kakaoBackfillBatchId = '';
        kakaoBackfillDrafts = [];
        setKakaoBackfillStatus(error.message || '백필 원본을 분석하지 못했습니다.', true);
    } finally {
        button.disabled = false;
    }
}

async function importKakaoBackfill() {
    if (!kakaoBackfillBatchId) {
        setKakaoBackfillStatus('먼저 원본 파일을 분석해주세요.', true);
        return;
    }
    const button = document.getElementById('kakao-backfill-import-button');
    const edits = Array.from(document.querySelectorAll('#kakao-backfill-rows tr')).map(row => {
        const draft = kakaoBackfillDrafts[Number(row.dataset.backfillIndex)];
        return {
            sourceExternalId: draft.sourceExternalId,
            include: row.querySelector('.backfill-include').checked,
            title: row.querySelector('.backfill-title').value.trim(),
            host: row.querySelector('.backfill-host').value.trim(),
            categorySlug: row.querySelector('.backfill-category').value
        };
    });
    const missingCategory = edits.find(edit => edit.include && !edit.categorySlug);
    if (missingCategory) {
        setKakaoBackfillStatus('포함할 모든 항목의 카테고리를 선택해주세요.', true);
        return;
    }
    button.disabled = true;
    setKakaoBackfillStatus('선택 항목을 검수함에 저장하고 있습니다.');
    try {
        const result = await apiRequest('/api/admin/backfill/kakao/import', {
            method: 'POST',
            headers: getNoticeAdminHeaders(),
            body: JSON.stringify({ batchId: kakaoBackfillBatchId, edits })
        });
        kakaoBackfillBatchId = '';
        setKakaoBackfillStatus(
            `검수함 ${result.createdCount}건 저장 · 제외 ${result.skippedCount}건 · 중복 ${result.duplicateCount}건 · 실패 ${result.failedCount}건`
        );
        await loadReviewNotices();
    } catch (error) {
        setKakaoBackfillStatus(error.message || '백필 초안을 저장하지 못했습니다.', true);
    } finally {
        button.disabled = false;
    }
}

// ========================================
// ✍️ 제목 양식 빌더
// 자유 입력을 없애고 [주관] 핵심내용 유형 형태로 제목을 통일한다.
// ========================================

function getSelectedTitleHost() {
    const select = document.getElementById('title-host');
    if (select.value !== '__custom__') return select.value;
    return document.getElementById('title-host-custom').value.trim();
}

function isTitleManual() {
    return document.getElementById('title-manual').checked;
}

// 조합 규칙은 한 곳에만 둔다. 미리보기와 저장이 어긋나지 않도록.
function composeNoticeTitle() {
    if (isTitleManual()) {
        return document.getElementById('post-title-manual').value.trim();
    }
    const host = getSelectedTitleHost();
    let subject = document.getElementById('title-subject').value.trim();
    const kind = document.getElementById('title-kind').value;
    if (!subject) return '';
    // 핵심 내용이 이미 유형 단어로 끝나면(예: "공연진 모집") 유형을 또 붙이지 않는다.
    // → "공연진 모집 모집" 같은 중복 방지.
    const needsKind = kind && !subject.endsWith(kind);
    return `${host ? `[${host}] ` : ''}${subject}${needsKind ? ` ${kind}` : ''}`.trim();
}

function refreshTitlePreview() {
    const title = composeNoticeTitle();
    const box = document.getElementById('post-title-manual');
    const hidden = document.getElementById('post-title');

    hidden.value = title;
    // 직접 수정 중에는 사용자가 치고 있는 글자를 덮어쓰지 않는다.
    if (!isTitleManual()) box.value = title;
    box.classList.toggle('is-empty', !title);
}

function onTitleHostChange() {
    const select = document.getElementById('title-host');
    const custom = document.getElementById('title-host-custom');
    custom.hidden = select.value !== '__custom__';
    if (!custom.hidden) custom.focus();
    refreshTitlePreview();
}

function onTitleManualToggle() {
    const manual = isTitleManual();
    const box = document.getElementById('post-title-manual');
    // 상자는 늘 같은 자리에 있고 잠금만 풀린다.
    box.readOnly = !manual;
    box.classList.toggle('is-editable', manual);

    if (manual) {
        // 지금까지 만들어진 제목을 그대로 물려받아 이어서 고친다.
        if (!box.value) box.value = document.getElementById('post-title').value;
        box.focus();
        box.setSelectionRange(box.value.length, box.value.length);
    }
    refreshTitlePreview();
}

// 기존 제목을 양식으로 되돌려 읽는다. 규칙에 맞지 않으면 직접 수정 모드로 연다.
function applyTitleToBuilder(rawTitle) {
    const title = String(rawTitle || '').trim();
    const hostSelect = document.getElementById('title-host');
    const hostCustom = document.getElementById('title-host-custom');
    const subject = document.getElementById('title-subject');
    const kindSelect = document.getElementById('title-kind');
    const manualCheck = document.getElementById('title-manual');
    const manualInput = document.getElementById('post-title-manual');

    const match = title.match(/^\[([^\]]+)\]\s*(.+)$/);
    const kind = match ? TITLE_KINDS.find(item => match[2].endsWith(` ${item}`)) : null;

    if (match && kind) {
        const host = match[1].trim();
        const knownHost = Array.from(hostSelect.options).some(option => option.value === host);
        hostSelect.value = knownHost ? host : '__custom__';
        hostCustom.hidden = knownHost;
        hostCustom.value = knownHost ? '' : host;
        subject.value = match[2].slice(0, match[2].length - kind.length - 1).trim();
        kindSelect.value = kind;
        manualCheck.checked = false;
        manualInput.readOnly = true;
        manualInput.classList.remove('is-editable');
        manualInput.value = '';
    } else {
        manualCheck.checked = true;
        manualInput.hidden = false;
        manualInput.value = title;
    }

    refreshTitlePreview();
}

function resetComposeForm() {
    editingNoticeId = null;
    pastedImages = [];
    writeSummaryField([]);
    composeAiCategoryIds = [];
    composeSurveyReward = '';
    composeHasReward = false;
    composeRequiresAction = false;
    aiDeadlineCandidate = '';
    renderAiDeadlineCandidate();
    renderPastePreview();
    const analyzeStatus = document.getElementById('analyze-status');
    if (analyzeStatus) analyzeStatus.textContent = '';
    document.getElementById('title-host').value = '학생회';
    document.getElementById('title-host-custom').value = '';
    document.getElementById('title-host-custom').hidden = true;
    document.getElementById('title-subject').value = '';
    document.getElementById('title-kind').value = '모집';
    document.getElementById('title-manual').checked = false;
    const titleBox = document.getElementById('post-title-manual');
    titleBox.value = '';
    titleBox.readOnly = true;
    titleBox.classList.remove('is-editable');
    document.getElementById('post-target').value = '전체';
    document.getElementById('post-deadline').value = '';
    document.getElementById('post-start-date').value = '';
    document.getElementById('post-always-open').checked = false;
    document.getElementById('post-pinned').checked = false;
    toggleAlwaysOpenState();
    renderAiDeadlineCandidate();
    document.getElementById('post-content').value = '';
    document.getElementById('post-images').value = '';
    document.getElementById('panel-compose-title').textContent = '새 공지 등록';
    document.getElementById('submit-btn-text').textContent = '공지 업로드';
    document.getElementById('compose-cancel').hidden = true;
    refreshTitlePreview();
}

function renderAiDeadlineCandidate() {
    const button = document.getElementById('ai-deadline-candidate');
    if (!button) return;
    button.hidden = !aiDeadlineCandidate;
    button.textContent = aiDeadlineCandidate
        ? `AI 후보 ${aiDeadlineCandidate} 적용`
        : '';
}

function applyAiDeadlineCandidate() {
    if (!aiDeadlineCandidate) return;
    const alwaysOpen = document.getElementById('post-always-open');
    const deadline = document.getElementById('post-deadline');
    alwaysOpen.checked = false;
    deadline.value = aiDeadlineCandidate;
    toggleAlwaysOpenState();
}

function toggleAlwaysOpenState() {
    const alwaysOpen = document.getElementById('post-always-open');
    const deadline = document.getElementById('post-deadline');
    if (!alwaysOpen || !deadline) return;
    deadline.disabled = alwaysOpen.checked;
    if (alwaysOpen.checked) deadline.value = '';
}

// ========================================
// 📋 이미지 붙여넣기 (Ctrl+V)
// ========================================

function renderPastePreview() {
    const preview = document.getElementById('paste-preview');
    if (!preview) return;
    preview.innerHTML = pastedImages.map((src, idx) => `
        <div class="paste-thumb">
            <img src="${escapeHtml(src)}" alt="붙여넣은 이미지 ${idx + 1}">
            <button type="button" class="paste-remove" aria-label="이미지 제거"
                    onclick="removePastedImage(${idx})">×</button>
        </div>
    `).join('');
}

function removePastedImage(idx) {
    pastedImages.splice(idx, 1);
    renderPastePreview();
}

// 붙여넣은 캡처와 첨부 사진은 원본 그대로면 Base64로 수십 MB가 되어 Postgres가
// statement timeout으로 저장을 끊는다. DB에 넣기 전에 긴 변을 상한까지만 줄이고
// WebP로 다시 인코딩한다. 잘라내는 것이 아니라 축소이므로 그림은 전부 남는다.
const NOTICE_IMAGE_MAX_EDGE = 2000;
const NOTICE_IMAGE_QUALITY = 0.85;

// 긴 변을 상한에 맞춘다. 상한보다 작은 그림은 억지로 키우지 않는다.
function noticeImageTargetSize(width, height, maxEdge = NOTICE_IMAGE_MAX_EDGE) {
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    return {
        width: Math.round(width * scale),
        height: Math.round(height * scale)
    };
}

async function compressNoticeImage(file) {
    // GIF는 캔버스로 다시 그리면 첫 프레임만 남아 애니메이션이 죽는다.
    if (file.type === 'image/gif') return getBase64(file);

    let bitmap;
    try {
        bitmap = await createImageBitmap(file);
        const { width, height } = noticeImageTargetSize(bitmap.width, bitmap.height);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
        const encoded = canvas.toDataURL('image/webp', NOTICE_IMAGE_QUALITY);
        // 이미 잘 압축된 작은 그림은 되레 커질 수 있다. 그럴 땐 원본이 낫다.
        if (encoded.length * 0.75 < file.size) return encoded;
    } catch (error) {
        // 압축에 실패해도 첨부 자체를 포기하지는 않는다.
        console.error('이미지 압축 실패, 원본을 사용합니다:', error);
    } finally {
        bitmap?.close();
    }
    return getBase64(file);
}

// 클립보드에 이미지가 있으면 base64로 담는다. 여러 장이면 모두 받는다.
async function handleImagePaste(event) {
    const items = Array.from(event.clipboardData?.items || []);
    const imageItems = items.filter(item => item.type && item.type.startsWith('image/'));
    if (imageItems.length === 0) return;

    // 텍스트가 아니라 이미지 붙여넣기이므로 기본 동작(본문에 파일명 삽입 등)을 막는다.
    event.preventDefault();

    for (const item of imageItems) {
        if (pastedImages.length >= MAX_NOTICE_IMAGES) {
            alert(`이미지는 최대 ${MAX_NOTICE_IMAGES}장까지 첨부할 수 있습니다.`);
            break;
        }
        const file = item.getAsFile();
        if (!file) continue;
        try {
            pastedImages.push(await compressNoticeImage(file));
        } catch (error) {
            console.error('붙여넣은 이미지 처리 실패:', error);
        }
    }
    renderPastePreview();

    const zone = document.getElementById('paste-dropzone');
    if (zone) {
        zone.classList.add('is-active');
        setTimeout(() => zone.classList.remove('is-active'), 600);
    }
}

function initImagePaste() {
    const panel = document.getElementById('panel-compose');
    const zone = document.getElementById('paste-dropzone');
    if (!panel) return;
    // 공지 등록 패널 어디에서 붙여넣어도(제목·본문·전용 영역) 이미지를 받는다.
    panel.addEventListener('paste', handleImagePaste);
    zone?.addEventListener('click', () => zone.focus());
}

// ========================================
// 🤖 AI 분석 (마감일·핵심내용·유형·요약)
// 원문을 한 번 LLM에 넣어 정해진 보기 안에서 값을 채운다. 결과는 항상 수정 가능.
// ========================================

function parseAnalysisJson(text) {
    const cleaned = String(text || '').replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) return {};
    try {
        return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
        return {};
    }
}

const NOTICE_ANALYSIS_CATEGORY_SLUGS = new Set([
    'academic', 'opportunity', 'survey', 'community'
]);

// Gemini가 명시된 기간의 앞 날짜를 빠뜨리는 경우를 막는 교차 확인 장치.
// 한 날짜만 등장하는 공지는 시작/마감 의미를 단정하지 않고, '~' 또는 '부터'로
// 연결된 두 날짜가 있을 때만 사용한다. 연도가 생략되면 공지의 '학년도/년도'를
// 우선하고, 그것도 없을 때만 현재 연도를 쓴다.
function extractExplicitNoticeDateRange(content, referenceDate = new Date()) {
    const text = String(content || '').replace(/\s+/g, ' ');
    const statedYear = Number(text.match(/\b(20\d{2})\s*(?:학년도|년도|년)/)?.[1]);
    const fallbackYear = statedYear || referenceDate.getFullYear();
    const datePart = '(?:(20\\d{2})\\s*(?:년|[.\\/-])\\s*)?(\\d{1,2})\\s*(?:월|[.\\/-])\\s*(\\d{1,2})\\s*일?';
    const timePart = '(?:\\s*(?:\\([^)]*\\)\\s*)?(?:오전|오후)?\\s*\\d{1,2}(?::\\d{2})?\\s*(?:시|분)?)?';
    const match = text.match(new RegExp(`${datePart}${timePart}\\s*(?:~|∼|～|–|—|부터)\\s*${datePart}`, 'i'));
    if (!match) return { startDate: '', deadline: '' };

    const startMonth = Number(match[2]);
    const startDay = Number(match[3]);
    const endMonth = Number(match[5]);
    const endDay = Number(match[6]);
    const startYear = Number(match[1]) || fallbackYear;
    const endYear = Number(match[4]) || (endMonth < startMonth ? startYear + 1 : startYear);
    const toIsoDate = (year, month, day) => {
        const date = new Date(Date.UTC(year, month - 1, day));
        if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
        return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    };
    const startDate = toIsoDate(startYear, startMonth, startDay);
    const deadline = toIsoDate(endYear, endMonth, endDay);
    return startDate && deadline ? { startDate, deadline } : { startDate: '', deadline: '' };
}

function normalizeNoticeAnalysisResult(parsed = {}) {
    const categorySlugs = Array.isArray(parsed.categorySlugs)
        ? Array.from(new Set(parsed.categorySlugs
            .map(value => String(value || '').trim())
            .filter(value => NOTICE_ANALYSIS_CATEGORY_SLUGS.has(value))))
        : [];
    return {
        deadline: (parsed.deadline && /^\d{4}-\d{2}-\d{2}$/.test(parsed.deadline)) ? parsed.deadline : '',
        startDate: (parsed.startDate && /^\d{4}-\d{2}-\d{2}$/.test(parsed.startDate)) ? parsed.startDate : '',
        subject: parsed.subject ? String(parsed.subject).trim().slice(0, 60) : '',
        type: (parsed.type && TITLE_KINDS.includes(parsed.type)) ? parsed.type : '',
        summary: Array.isArray(parsed.summary)
            ? parsed.summary.map(item => String(item).trim()).filter(Boolean).slice(0, 3)
            : [],
        surveyReward: String(parsed.rewardNote || parsed.surveyReward || '').trim().slice(0, 120),
        hasReward: parsed.hasReward === true || Boolean(String(parsed.rewardNote || parsed.surveyReward || '').trim()),
        requiresAction: parsed.requiresAction === true,
        categorySlugs,
        verifiedNumbers: Array.isArray(parsed.verifiedNumbers)
            ? parsed.verifiedNumbers.map(item => String(item).trim()).filter(Boolean).slice(0, 12)
            : [],
        verificationWarnings: Array.isArray(parsed.verificationWarnings)
            ? parsed.verificationWarnings.map(item => String(item).trim()).filter(Boolean).slice(0, 8)
            : []
    };
}

// 3줄 요약은 이 입력칸이 유일한 진실 공급원이다. 한 줄이 요약 한 줄.
function readSummaryField() {
    return String(document.getElementById('post-ai-summary')?.value || '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .slice(0, 3);
}

function writeSummaryField(lines) {
    const box = document.getElementById('post-ai-summary');
    if (box) box.value = (Array.isArray(lines) ? lines : []).join('\n');
}

// 분석 결과의 categorySlugs를 실제 카테고리 id로 옮긴다. 1차·2차 어느 결과에도 쓴다.
function withResolvedCategoryIds(analysis) {
    return {
        ...analysis,
        categoryIds: analysis.categorySlugs
            .map(slug => activeCategories.find(category => category.slug === slug)?.id)
            .map(Number)
            .filter(Number.isSafeInteger)
    };
}

// AI 분석 범위. summary는 폼에 입력란이 없는 항목만 묻는 모드다(입력값 보존은 이후 단계에서 적용).
const AI_MODES = ['full-verified', 'full', 'summary'];

function currentAiMode() {
    const value = document.getElementById('ai-mode')?.value;
    // 선택기가 없거나 모르는 값이면 가장 정확한 모드로 떨어진다.
    return AI_MODES.includes(value) ? value : 'full-verified';
}

function onAiModeChange() {
    localStorage.setItem('eceAiMode', currentAiMode());
}

function restoreAiModeChoice() {
    const select = document.getElementById('ai-mode');
    if (!select) return;
    let stored = localStorage.getItem('eceAiMode');
    if (!AI_MODES.includes(stored)) {
        // 체크박스를 쓰던 브라우저의 설정을 한 번만 옮겨온다.
        stored = localStorage.getItem('eceAiSkipVerification') === '1' ? 'full' : 'full-verified';
        localStorage.setItem('eceAiMode', stored);
    }
    localStorage.removeItem('eceAiSkipVerification');
    select.value = stored;
}

// 폼에 입력란이 없는 항목만 요구하는 짧은 프롬프트. 핵심내용·유형·마감일은 묻지 않는다.
function buildSummaryOnlyPrompt(content) {
    return `다음 공지 원문을 읽고 JSON만 출력해. 코드블록·설명 없이 JSON 객체 하나만.
형식: {"summary":["요약1","요약2","요약3"],"categorySlugs":["academic|opportunity|survey|community 중 핵심 하나"],"hasReward":false,"rewardNote":null,"requiresAction":false}
- summary는 각 줄 명사형 종결의 3줄 요약.
- 사진 없는 카드에서 2~3줄로 자연스럽게 나뉘도록, 긴 한 덩어리 대신 의미가 분명한 짧은 어절 묶음으로 작성.
- 격식적인 보도자료 문체보다 학생이 빠르게 읽는 자연스럽고 캐주얼한 표현을 사용.
- 물음표 반복, 깨진 문자, 불완전한 조사, 같은 단어 반복을 절대 포함하지 말 것. 원문 글자가 깨졌다면 문맥상 확실한 내용만 한국어로 복원.
- academic: 수강·학점·졸업·성적·전공진입에 직접 영향.
- opportunity: 인턴·연구실·공모전·대회·장학·교환처럼 선발을 거쳐 자리나 자격을 얻는 것.
- survey: 설문·인터뷰·실험 피험자·사용자 조사처럼 선발 없이 참여해 응답하면 끝나는 모집. 사례비나 기프티콘이 걸려 있어도 참여가 목적이면 여기다.
- community: 학생 자치, 학내 행사, 시설·출입·교통, 제휴·할인 등 캠퍼스 생활.
- categorySlugs는 반드시 핵심 범주 하나만 선택.
- 신청·제출·응답이 필요하면 requiresAction=true.
- 상품·기프티콘·사례비·지원금·할인이 확인되면 hasReward=true와 rewardNote를 채움.

원문:
${content}`;
}

// 기본은 2단계다. 1차 편집 결과를 그대로 쓰지 않고 2차 독립 검수 에이전트가 원문을
// 다시 읽어 날짜·금액·인원·학점·기간과 카테고리를 교차 검증한 결과만 최종값으로 쓴다.
// 'full-verified'가 아닌 모드를 고르면 1차 결과로 끝내고 Gemini 호출을 1회로 줄인다.
async function runNoticeAnalysis(content, onVerificationStart = null) {
    const mode = currentAiMode();
    const today = new Date().toISOString().slice(0, 10);
    const prompt = `다음 공지 원문을 분석해서 JSON만 출력해. 코드블록·설명 없이 JSON 객체 하나만.
형식: {"deadline":"YYYY-MM-DD 또는 빈문자열","startDate":"YYYY-MM-DD 또는 빈문자열","subject":"포스터용 핵심 문구 10~28자","type":"${TITLE_KINDS.join('|')} 중 하나","summary":["요약1","요약2","요약3"],"categorySlugs":["academic|opportunity|survey|community 중 핵심 하나"],"hasReward":false,"rewardNote":null,"requiresAction":false}
- 오늘 날짜는 ${today}. 마감일이 원문에 없거나 불명확하면 deadline은 빈문자열.
- startDate는 접수·신청·수강신청·행사의 실제 시작일입니다. "8/12 18:00 ~ 9/17 24:00"처럼 기간이 명시되면 연도를 문맥과 오늘 날짜로 확정해 앞 날짜를 startDate, 뒤 날짜를 deadline에 반드시 넣습니다.
- 게시일·작성일을 startDate로 쓰지 않습니다. 시작일의 근거가 원문에 없을 때만 빈 문자열로 둡니다.
- type은 반드시 제시한 보기 중 하나.
- subject에는 유형 단어(${TITLE_KINDS.join(', ')})를 넣지 말고 핵심 명사구만. 예: "개강총회 참가자".
- 사진 없는 카드에서 2~3줄로 자연스럽게 나뉘도록, 긴 한 덩어리 대신 의미가 분명한 짧은 어절 묶음으로 작성.
- 격식적인 보도자료 문체보다 학생이 빠르게 읽는 자연스럽고 캐주얼한 표현을 사용.
- 물음표 반복, 깨진 문자, 불완전한 조사, 같은 단어 반복을 절대 포함하지 말 것. 원문 글자가 깨졌다면 문맥상 확실한 내용만 한국어로 복원.
- summary는 각 줄 명사형 종결의 3줄 요약.
- academic: 수강·학점·졸업·성적·전공진입에 직접 영향.
- opportunity: 인턴·연구실·공모전·대회·장학·교환처럼 선발을 거쳐 자리나 자격을 얻는 것.
- survey: 설문·인터뷰·실험 피험자·사용자 조사처럼 선발 없이 참여해 응답하면 끝나는 모집. 사례비나 기프티콘이 걸려 있어도 참여가 목적이면 여기다.
- community: 학생 자치, 학내 행사, 시설·출입·교통, 제휴·할인 등 캠퍼스 생활.
- categorySlugs는 반드시 핵심 범주 하나만 선택.
- 신청·제출·응답이 필요하면 requiresAction=true.
- 상품·기프티콘·사례비·지원금·할인이 확인되면 hasReward=true와 rewardNote를 채움.

원문:
${content}`;

    const result = await apiRequest('/api/summary', {
        method: 'POST',
        headers: getNoticeAdminHeaders(),
        body: JSON.stringify({
            prompt: mode === 'summary' ? buildSummaryOnlyPrompt(content) : prompt,
            model: GEMINI_MODEL
        })
    });
    const explicitRange = extractExplicitNoticeDateRange(content, new Date(`${today}T00:00:00`));
    const draft = normalizeNoticeAnalysisResult(parseAnalysisJson(result?.text || ''));
    if (!draft.startDate && explicitRange.startDate) draft.startDate = explicitRange.startDate;
    if (!draft.deadline && explicitRange.deadline) draft.deadline = explicitRange.deadline;
    // 2차 검수는 full-verified에서만 돈다. 나머지 모드는 여기서 끝난다.
    if (mode !== 'full-verified') return withResolvedCategoryIds(draft);
    if (typeof onVerificationStart === 'function') onVerificationStart();

    const verificationPrompt = `당신은 공지 편집 결과를 독립적으로 재검수하는 검증 에이전트입니다.
아래 원문과 1차 분석을 처음부터 다시 대조하고 JSON 객체 하나만 출력하세요.
1차 분석은 틀릴 수 있으므로 그대로 승인하지 마세요.

반드시 확인할 항목:
1. 날짜, 시각, 금액, 인원, 학점, 학기, 기간, 횟수, 비율, 연락처 등 주요 수치를 원문 그대로 대조합니다.
2. 원문에 없는 수치나 조건이 summary에 추가됐으면 삭제하거나 바로잡습니다.
3. startDate는 접수·신청·수강신청·행사의 시작일, deadline은 실제 신청·제출 마감일입니다. 원문에 기간이 있으면 앞 날짜와 뒤 날짜를 각각 YYYY-MM-DD로 반드시 대조합니다. 게시일은 startDate가 아닙니다.
4. categorySlugs는 academic/opportunity/survey/community 중 핵심 하나만 고릅니다.
   기회와 설문은 선발이 있느냐로 가릅니다. 붙고 떨어지는 일이 있으면 기회,
   조건만 맞으면 참여로 끝나면 설문입니다.
5. 신청·제출·응답은 requiresAction, 상품·지원·할인은 hasReward와 rewardNote로 다시 검증합니다.

출력 형식:
{"deadline":"YYYY-MM-DD 또는 빈 문자열","startDate":"YYYY-MM-DD 또는 빈 문자열","subject":"핵심 명사구","type":"${TITLE_KINDS.join('|')} 중 하나","summary":["정확한 요약1","정확한 요약2","정확한 요약3"],"categorySlugs":["핵심 slug 하나"],"hasReward":false,"rewardNote":null,"requiresAction":false,"verifiedNumbers":["원문에서 대조한 주요 수치"],"verificationWarnings":["불명확하거나 관리자 확인이 필요한 점"]}

원문:
${content}

1차 분석:
${JSON.stringify(draft)}`;

    const verificationResult = await apiRequest('/api/summary', {
        method: 'POST',
        headers: getNoticeAdminHeaders(),
        body: JSON.stringify({ prompt: verificationPrompt, model: GEMINI_MODEL })
    });
    const verified = normalizeNoticeAnalysisResult(parseAnalysisJson(verificationResult?.text || ''));
    if (!verified.startDate && explicitRange.startDate) verified.startDate = explicitRange.startDate;
    if (!verified.deadline && explicitRange.deadline) verified.deadline = explicitRange.deadline;
    if (!verified.subject && !verified.type && verified.summary.length === 0) {
        throw new Error('2차 검수 결과를 해석하지 못했습니다. 다시 분석해주세요.');
    }
    return withResolvedCategoryIds(verified);
}

async function analyzeNotice() {
    const content = document.getElementById('post-content').value.trim();
    const status = document.getElementById('analyze-status');
    const button = document.getElementById('ai-analyze-btn');
    const setStatus = (text, isError = false) => {
        if (!status) return;
        status.textContent = text;
        status.style.color = isError ? 'var(--danger)' : 'var(--text-sub)';
    };

    if (content.length < 10) {
        setStatus('먼저 공지 원문을 입력해주세요.', true);
        document.getElementById('post-content').focus();
        return;
    }

    button.disabled = true;
    beginAiProgress('공지 원문을 준비하고 있습니다.');
    try {
        updateAiProgress(18, 'Gemini가 원문을 분석하고 있습니다.', 'analyze', 76);
        const parsed = await runNoticeAnalysis(content, () => {
            updateAiProgress(52, '두 번째 AI가 주요 수치와 카테고리를 다시 확인하고 있습니다.', 'analyze', 78);
        });
        updateAiProgress(82, '분석 결과를 입력 항목에 정리하고 있습니다.', 'process', 94);

        // summary 모드는 내가 직접 넣은 값을 덮어쓰지 않는 것이 존재 이유다.
        const mode = currentAiMode();
        if (mode !== 'summary') {
            if (parsed.subject) document.getElementById('title-subject').value = parsed.subject;
            if (parsed.type) document.getElementById('title-kind').value = parsed.type;
            document.getElementById('post-start-date').value = parsed.startDate || '';
            aiDeadlineCandidate = parsed.deadline || '';
            renderAiDeadlineCandidate();
        }
        writeSummaryField(parsed.summary);
        composeAiCategoryIds = parsed.categoryIds;
        composeSurveyReward = parsed.surveyReward;
        composeHasReward = parsed.hasReward;
        composeRequiresAction = parsed.requiresAction;

        // 분석 결과는 양식 조합으로 흐르므로 직접수정 모드를 끈다.
        document.getElementById('title-manual').checked = false;
        document.getElementById('post-title-manual').readOnly = true;
        document.getElementById('post-title-manual').classList.remove('is-editable');
        refreshTitlePreview();

        // 모드마다 성공의 기준이 다르다. summary는 요약이 나왔으면 성공이다.
        const gotSomething = mode === 'summary'
            ? parsed.summary.length > 0
            : (parsed.subject || parsed.type || parsed.startDate || parsed.deadline);
        // 하지 않은 교차 검증을 했다고 말하지 않는다.
        const doneLabel = {
            'full-verified': `AI 2단계 분석 완료.${parsed.verifiedNumbers.length
                ? ` 주요 수치 ${parsed.verifiedNumbers.length}건을 교차 검증했습니다.`
                : ' 수치와 카테고리 교차 검증을 완료했습니다.'} 값을 확인하고 필요하면 직접 고치세요.`,
            full: 'AI 1단계 분석 완료. 2차 검수를 생략했으니 수치를 직접 확인하세요.',
            summary: '요약·카테고리·리워드만 채웠습니다. 핵심 내용과 유형은 입력하신 값 그대로입니다.'
        }[mode];
        setStatus(gotSomething
            ? doneLabel
            : 'AI가 값을 추출하지 못했습니다. 직접 입력해주세요.', !gotSomething);
        finishAiProgress('Gemini 분석이 완료되었습니다.');
        await new Promise(resolve => setTimeout(resolve, 250));
    } catch (error) {
        if (isGeminiRateLimitError(error)) {
            setStatus('Gemini 분당 호출 한도를 초과했습니다.', true);
            await showGeminiRetryCountdown(error);
        } else {
            // 로컬처럼 GEMINI_API_KEY가 없으면 여기로 온다. 수동 입력으로 계속 진행 가능.
            setStatus(`AI 분석을 쓸 수 없습니다(${error.message}). 아래에서 직접 입력해주세요.`, true);
        }
    } finally {
        hideAiProgress();
        button.disabled = false;
    }
}

// ========================================
// 💬 익명 피드백 (관리자 열람)
// ========================================

function analyticsMonthValue() {
    const input = document.getElementById('analytics-month');
    if (input && !input.value) input.value = new Date().toISOString().slice(0, 7);
    return input?.value || new Date().toISOString().slice(0, 7);
}

function renderBetaAnalytics(summary) {
    const metrics = document.getElementById('analytics-metrics');
    const daily = document.getElementById('analytics-daily');
    if (!metrics || !daily) return;
    const rate = summary.returnRate === null ? '-' : `${summary.returnRate}%`;
    const rating = summary.averageRating === null ? '-' : `${summary.averageRating} / 5`;
    metrics.innerHTML = [
        ['페이지 조회수', `${Number(summary.pageViews || 0).toLocaleString()}회`],
        ['순 방문자', `${Number(summary.uniqueVisitors || 0).toLocaleString()}명`],
        ['재방문자', `${Number(summary.returningVisitors || 0).toLocaleString()}명 (${rate})`],
        ['만족도 평점', `${rating} · ${Number(summary.ratingCount || 0)}건`]
    ].map(([label, value]) => `<article><span>${label}</span><strong>${value}</strong></article>`).join('');
    const rows = Array.isArray(summary.daily) ? summary.daily : [];
    daily.innerHTML = rows.length ? `<table><thead><tr><th>날짜</th><th>조회수</th><th>순 방문자</th><th>재방문자</th></tr></thead><tbody>${rows.map(row => `<tr><td>${escapeHtml(row.date)}</td><td>${Number(row.pageViews)}</td><td>${Number(row.uniqueVisitors)}</td><td>${Number(row.returningVisitors)}</td></tr>`).join('')}</tbody></table>` : '<div class="review-empty">선택한 달의 집계가 아직 없습니다.</div>';
}

async function loadBetaAnalytics() {
    const status = document.getElementById('analytics-status');
    if (status) status.textContent = '집계 정보를 불러오는 중입니다.';
    try {
        const summary = await apiRequest(`/api/admin/beta-analytics?month=${encodeURIComponent(analyticsMonthValue())}`, { headers: getSuperAdminHeaders() });
        renderBetaAnalytics(summary);
        if (status) { status.textContent = `${summary.month} 익명 베타 집계`; status.style.color = 'var(--text-sub)'; }
    } catch (error) {
        if (status) { status.textContent = error.message || '집계를 불러오지 못했습니다.'; status.style.color = 'var(--danger)'; }
    }
}

async function downloadBetaReport() {
    const status = document.getElementById('analytics-status');
    try {
        const report = await apiRequest(`/api/admin/beta-report?month=${encodeURIComponent(analyticsMonthValue())}`, { headers: getSuperAdminHeaders() });
        const url = URL.createObjectURL(new Blob([report.markdown], { type: 'text/markdown;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url; link.download = report.filename; link.click();
        URL.revokeObjectURL(url);
        if (status) { status.textContent = `${report.filename} 다운로드를 시작했습니다.`; status.style.color = 'var(--ok)'; }
    } catch (error) {
        if (status) { status.textContent = error.message || '보고서 생성에 실패했습니다.'; status.style.color = 'var(--danger)'; }
    }
}

async function loadAdminFeedback() {
    const list = document.getElementById('admin-feedback-list');
    const status = document.getElementById('feedback-admin-status');
    // 배너 관리자에게는 문의함 판이 아예 없다. 그래도 배너 문의는 받아와야
    // 하므로 여기서 멈추지 않는다.
    if (list) list.innerHTML = '<div class="review-empty">불러오는 중입니다.</div>';
    try {
        const result = await apiRequest('/api/admin/feedback', {
            method: 'GET',
            headers: getNoticeAdminHeaders()
        });
        const items = Array.isArray(result?.feedback) ? result.feedback : [];
        adminFeedbackItems = items.map(item => ({
            ...item,
            category: ['banner', 'summary_mismatch', 'staff'].includes(item.category) ? item.category : 'general'
        }));
        const badge = document.getElementById('feedback-count');
        const generalItems = adminFeedbackItems.filter(item => item.category !== 'banner');
        if (badge) {
            badge.hidden = generalItems.length === 0;
            badge.textContent = String(generalItems.length);
        }
        const bannerBadge = document.getElementById('banner-inquiry-count');
        const bannerItems = adminFeedbackItems.filter(item => item.category === 'banner');
        if (bannerBadge) {
            bannerBadge.hidden = bannerItems.length === 0;
            bannerBadge.textContent = String(bannerItems.length);
        }
        if (status) {
            status.textContent = generalItems.length ? `받은 문의 ${generalItems.length}건 (작성자 정보 없음)` : '아직 받은 일반 문의가 없습니다.';
            status.style.color = 'var(--text-sub)';
        }
        renderAdminFeedback();
        renderBannerInquiryAdmin();
        // 왼쪽 목록의 "N건 접수"도 같이 갱신한다.
        if (document.getElementById('banner-subnav')) renderBannerSubnav();
    } catch (error) {
        if (status) { status.textContent = error.message; status.style.color = 'var(--danger)'; }
        if (list) list.innerHTML = '<div class="review-empty">피드백을 불러오지 못했습니다.</div>';
    }
}

function setAdminFeedbackFilter(category) {
    adminFeedbackFilter = ['general', 'summary_mismatch'].includes(category) ? category : 'all';
    document.querySelectorAll('[data-feedback-filter]').forEach(button => {
        button.classList.toggle('active', button.dataset.feedbackFilter === adminFeedbackFilter);
    });
    renderAdminFeedback();
}

function renderAdminFeedback() {
    const list = document.getElementById('admin-feedback-list');
    if (!list) return;
    const feedbackOnly = adminFeedbackItems.filter(item => item.category !== 'banner');
    const visibleItems = adminFeedbackFilter === 'all'
        ? feedbackOnly
        : feedbackOnly.filter(item => item.category === adminFeedbackFilter);
    list.innerHTML = visibleItems.length
        ? visibleItems.map(item => {
            const isBanner = item.category === 'banner';
            const isSummaryMismatch = item.category === 'summary_mismatch';
            const isStaff = item.category === 'staff';
            const staffRoles = { notice: '공지 관리자', banner: '배너 관리자', master: '마스터' };
            const staffKinds = { bug: '오류 제보', question: '문의', request: '기능 요청' };
            const inquiry = isBanner && item.inquiry ? item.inquiry : null;
            const contact = inquiry
                ? [inquiry.phone, inquiry.email].filter(Boolean).map(value => escapeHtml(value)).join(' · ')
                : '';
            const safeLink = inquiry?.linkUrl && /^https?:\/\//i.test(inquiry.linkUrl)
                ? escapeHtml(inquiry.linkUrl)
                : '';
            return `
                <div class="admin-feedback-item ${isBanner ? 'is-banner' : ''}${isSummaryMismatch ? ' is-summary-mismatch' : ''}">
                    <label class="feedback-pick">
                        <input type="checkbox" class="feedback-pick-box" value="${escapeHtml(item.id)}"
                               ${selectedFeedbackIds.has(String(item.id)) ? 'checked' : ''}
                               onchange="toggleFeedbackSelection('${escapeHtml(item.id)}', this.checked)">
                        <span class="sr-only">이 문의 선택</span>
                    </label>
                    <span class="feedback-kind ${isBanner ? 'banner' : (isSummaryMismatch ? 'summary' : (isStaff ? 'staff' : 'general'))}">${
                        isBanner ? '배너 문의'
                        : isSummaryMismatch ? '요약 오류'
                        : isStaff ? `${staffRoles[item.staffRole] || '관리자'} · ${staffKinds[item.staffKind] || '문의'}`
                        : '일반 문의'}</span>
                    ${isSummaryMismatch ? `<p class="admin-feedback-notice"><strong>${escapeHtml(item.noticeTitle || '제목 없음')}</strong><br><span>공지 ID ${escapeHtml(item.noticeId || '')}</span></p>` : ''}
                    <p class="admin-feedback-msg">${escapeHtml(item.message)}</p>
                    ${Number(item.screenshotCount) > 0 ? `
                        <div class="admin-feedback-shots">
                            ${Array.from({ length: Number(item.screenshotCount) }, (unused, index) => `
                                <button class="btn btn-outline btn-small" type="button"
                                        onclick="openFeedbackScreenshot('${escapeHtml(item.id)}', ${index})">첨부 사진 ${index + 1}</button>
                            `).join('')}
                        </div>
                    ` : ''}
                    ${inquiry ? `
                        <dl class="banner-inquiry-details">
                            <div><dt>신청자</dt><dd>${escapeHtml(inquiry.name)} · ${escapeHtml(inquiry.organization)}</dd></div>
                            <div><dt>연락처</dt><dd>${contact}</dd></div>
                            <div><dt>희망 기간</dt><dd>${escapeHtml(inquiry.startDate)} ~ ${escapeHtml(inquiry.endDate)}</dd></div>
                            ${safeLink ? `<div><dt>연결 링크</dt><dd><a href="${safeLink}" target="_blank" rel="noopener noreferrer">${safeLink}</a></dd></div>` : ''}
                        </dl>
                        ${item.hasDesktopImage ? `<button class="btn btn-outline btn-small" type="button"
                            onclick="openBannerInquiryImage('${escapeHtml(item.id)}', 'desktop')">데스크탑 이미지</button>` : ''}
                        ${item.hasMobileImage ? `<button class="btn btn-outline btn-small" type="button"
                            onclick="openBannerInquiryImage('${escapeHtml(item.id)}', 'mobile')">모바일 이미지</button>` : ''}
                    ` : ''}
                    <div class="admin-feedback-foot">
                        <span>${escapeHtml(String(item.createdAt || '').slice(0, 16).replace('T', ' '))}</span>
                        <button class="btn btn-danger btn-small" type="button" onclick="deleteFeedback('${escapeHtml(item.id)}')">삭제</button>
                    </div>
                </div>`;
        }).join('')
        : '<div class="review-empty">이 종류의 피드백이 없습니다.</div>';

    syncFeedbackSelectionUi();
}

// ========================================
// 🛟 운영진 → 마스터 내부 제보
// ========================================

function openStaffReport() {
    const status = document.getElementById('staff-report-status');
    if (status) status.textContent = '';
    openModal('staff-report-modal');
    document.getElementById('staff-report-message')?.focus();
}

function closeStaffReport() {
    closeModal('staff-report-modal');
}

async function submitStaffReport() {
    const kind = document.getElementById('staff-report-kind')?.value || 'question';
    const box = document.getElementById('staff-report-message');
    const status = document.getElementById('staff-report-status');
    const button = document.getElementById('staff-report-submit');
    const message = (box?.value || '').trim();

    if (message.length < 5) {
        if (status) {
            status.textContent = '내용을 5자 이상 적어주세요.';
            status.style.color = 'var(--danger)';
        }
        box?.focus();
        return;
    }

    if (button) button.disabled = true;
    try {
        await apiRequest('/api/admin/staff-report', {
            method: 'POST',
            headers: getNoticeAdminHeaders(),
            body: JSON.stringify({ kind, message })
        });
        if (box) box.value = '';
        if (status) {
            status.textContent = '마스터 관리자에게 전달했습니다.';
            status.style.color = 'var(--ok)';
        }
        window.setTimeout(closeStaffReport, 900);
    } catch (error) {
        if (status) {
            status.textContent = `전달 실패: ${error.message}`;
            status.style.color = 'var(--danger)';
        }
    } finally {
        if (button) button.disabled = false;
    }
}

// ========================================
// 📤 문의함 → 노션 마크다운
// ========================================

const selectedFeedbackIds = new Set();

// 지금 필터에서 실제로 보이는 문의만 선택 대상으로 삼는다.
function visibleFeedbackIds() {
    return Array.from(document.querySelectorAll('.feedback-pick-box')).map(box => box.value);
}

function toggleFeedbackSelection(id, checked) {
    if (checked) selectedFeedbackIds.add(String(id));
    else selectedFeedbackIds.delete(String(id));
    syncFeedbackSelectionUi();
}

// 지금 보이는 것이 모두 선택되어 있으면 해제, 아니면 전부 선택한다.
function toggleAllFeedbackSelection() {
    const visible = visibleFeedbackIds();
    const allPicked = visible.length > 0 && visible.every(id => selectedFeedbackIds.has(id));
    visible.forEach(id => {
        if (allPicked) selectedFeedbackIds.delete(id);
        else selectedFeedbackIds.add(id);
    });
    document.querySelectorAll('.feedback-pick-box').forEach(box => { box.checked = !allPicked; });
    syncFeedbackSelectionUi();
}

function syncFeedbackSelectionUi() {
    const visible = visibleFeedbackIds();
    // 화면에서 사라진 항목이 선택된 채 남아 있으면 개수가 어긋난다.
    Array.from(selectedFeedbackIds).forEach(id => {
        if (!visible.includes(id)) selectedFeedbackIds.delete(id);
    });

    const count = selectedFeedbackIds.size;
    const countEl = document.getElementById('feedback-selection-count');
    const exportButton = document.getElementById('feedback-export-selected');
    const deleteButton = document.getElementById('feedback-delete-selected');
    const selectAll = document.getElementById('feedback-select-all');
    if (countEl) countEl.textContent = `${count}개 선택`;
    if (exportButton) exportButton.disabled = count === 0;
    if (deleteButton) deleteButton.disabled = count === 0;
    if (selectAll) {
        const allPicked = visible.length > 0 && count === visible.length;
        selectAll.textContent = allPicked ? '전체 해제' : '전체 선택';
        selectAll.setAttribute('aria-pressed', allPicked ? 'true' : 'false');
    }
}

// 고른 문의를 지운다. 되돌릴 수 없으므로 한 번 물어본다.
async function deleteSelectedFeedback() {
    const ids = Array.from(selectedFeedbackIds);
    if (!ids.length) return;
    if (!window.confirm(`선택한 문의 ${ids.length}건을 지울까요? 되돌릴 수 없습니다.`)) return;

    const status = document.getElementById('feedback-export-status');
    const button = document.getElementById('feedback-delete-selected');
    if (button) button.disabled = true;
    let removed = 0;
    const failures = [];
    for (const id of ids) {
        try {
            await apiRequest(`/api/admin/feedback/${encodeURIComponent(id)}`, {
                method: 'DELETE',
                headers: getNoticeAdminHeaders()
            });
            removed += 1;
        } catch (error) {
            failures.push(error.message);
        }
    }
    selectedFeedbackIds.clear();
    if (status) {
        status.textContent = failures.length
            ? `${removed}건 삭제, ${failures.length}건 실패: ${failures[0]}`
            : `${removed}건을 지웠습니다.`;
        status.style.color = failures.length ? 'var(--danger)' : 'var(--ok)';
    }
    await loadAdminFeedback();
}

// 브라우저에서 바로 .md 파일로 떨어뜨린다. 노션에 그대로 끌어다 놓으면 된다.
function downloadTextFile(filename, text) {
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

async function exportAdminFeedback() {
    const status = document.getElementById('feedback-export-status');
    const ids = Array.from(selectedFeedbackIds);
    if (!ids.length) return;

    if (status) {
        status.textContent = '내보내는 중입니다.';
        status.style.color = 'var(--text-sub)';
    }
    try {
        const result = await apiRequest('/api/admin/feedback/export', {
            method: 'POST',
            headers: getNoticeAdminHeaders(),
            body: JSON.stringify({ ids })
        });
        downloadTextFile(result.filename, result.markdown);
        if (status) {
            status.textContent = `${result.count}건을 ${result.filename} 파일로 내려받았습니다.`;
            status.style.color = 'var(--ok)';
        }
    } catch (error) {
        if (status) {
            status.textContent = `내보내기 실패: ${error.message}`;
            status.style.color = 'var(--danger)';
        }
    }
}

function renderBannerInquiryAdmin() {
    const list = document.getElementById('banner-inquiry-admin-list');
    if (!list) return;
    const inquiries = adminFeedbackItems.filter(item => item.category === 'banner');
    list.innerHTML = inquiries.length ? inquiries.map(item => {
        const inquiry = item.inquiry || {};
        const contact = [inquiry.phone, inquiry.email].filter(Boolean).join(' · ');
        const safeLink = inquiry.linkUrl && /^https?:\/\//i.test(inquiry.linkUrl)
            ? escapeHtml(inquiry.linkUrl)
            : '';
        return `
            <article class="admin-feedback-item is-banner">
                <span class="feedback-kind banner">승인 대기 문의</span>
                <p class="admin-feedback-msg"><strong>${escapeHtml(inquiry.title || '제목 없음')}</strong><br>${escapeHtml(inquiry.description || '')}</p>
                <dl class="banner-inquiry-details">
                    <div><dt>신청자</dt><dd>${escapeHtml(inquiry.name || '')} · ${escapeHtml(inquiry.organization || '')}</dd></div>
                    <div><dt>연락처</dt><dd>${escapeHtml(contact)}</dd></div>
                    <div><dt>희망 기간</dt><dd>${escapeHtml(inquiry.startDate || '')} ~ ${escapeHtml(inquiry.endDate || '')}</dd></div>
                    ${safeLink ? `<div><dt>연결 링크</dt><dd><a href="${safeLink}" target="_blank" rel="noopener noreferrer">${safeLink}</a></dd></div>` : ''}
                </dl>
                <div class="admin-feedback-foot">
                    <span>${escapeHtml(String(item.createdAt || '').slice(0, 16).replace('T', ' '))}</span>
                    <div>
                        ${item.hasDesktopImage ? `<button class="btn btn-outline btn-small" type="button" onclick="openBannerInquiryImage('${escapeHtml(item.id)}', 'desktop')">데스크탑 이미지</button>` : ''}
                        ${item.hasMobileImage ? `<button class="btn btn-outline btn-small" type="button" onclick="openBannerInquiryImage('${escapeHtml(item.id)}', 'mobile')">모바일 이미지</button>` : ''}
                        ${item.hasImage && !item.hasDesktopImage && !item.hasMobileImage ? `<button class="btn btn-outline btn-small" type="button" onclick="openBannerInquiryImage('${escapeHtml(item.id)}', 'desktop')">제출 이미지</button>` : ''}
                        ${item.bannerSlideId ? `<button class="btn btn-small" type="button" onclick="focusBannerSlide('${Number(item.bannerSlideId)}')">배너 검토</button>` : ''}
                        <button class="btn btn-danger btn-small" type="button" onclick="deleteFeedback('${escapeHtml(item.id)}')">접수 삭제</button>
                    </div>
                </div>
            </article>`;
    }).join('') : '<div class="review-empty">접수된 배너 문의가 없습니다.</div>';
}

function focusBannerSlide(id) {
    const element = document.getElementById(`banner-slide-${Number(id)}`);
    if (!element) {
        alert('연결된 배너 항목을 찾지 못했습니다. 위 목록에서 승인 대기 항목을 확인해주세요.');
        return;
    }
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    element.classList.add('is-highlighted');
    window.setTimeout(() => element.classList.remove('is-highlighted'), 1400);
}

/* 문의에 붙은 화면 사진 열기. 배너 이미지와 같은 창을 쓰되 주소만 다르다. */
function openFeedbackScreenshot(id, index) {
    return openInquiryImageWindow(
        `/api/admin/feedback/${encodeURIComponent(id)}/image?shot=${encodeURIComponent(index)}`,
        `첨부 사진 ${Number(index) + 1}`
    );
}

async function openBannerInquiryImage(id, variant = 'desktop') {
    return openInquiryImageWindow(
        `/api/admin/feedback/${encodeURIComponent(id)}/image?variant=${encodeURIComponent(variant)}`,
        variant === 'mobile' ? '모바일 배너 이미지' : '데스크탑 배너 이미지'
    );
}

async function openInquiryImageWindow(apiPath, title) {
    const previewWindow = window.open('', '_blank');
    if (previewWindow) previewWindow.opener = null;
    try {
        const response = await fetch(buildApiUrl(apiPath), {
            method: 'GET',
            headers: getNoticeAdminHeaders()
        });
        if (!response.ok) {
            const result = await response.json().catch(() => ({}));
            throw new Error(result.error || '이미지를 찾을 수 없습니다.');
        }
        const imageUrl = URL.createObjectURL(await response.blob());
        if (previewWindow) {
            previewWindow.document.title = title;
            previewWindow.document.body.style.cssText = 'margin:0;display:grid;min-height:100vh;place-items:center;background:#111827';
            const image = previewWindow.document.createElement('img');
            image.src = imageUrl;
            image.alt = `제출된 ${title}`;
            image.style.cssText = 'display:block;max-width:96vw;max-height:96vh;object-fit:contain';
            previewWindow.addEventListener('beforeunload', () => URL.revokeObjectURL(imageUrl), { once: true });
            previewWindow.document.body.appendChild(image);
        } else {
            URL.revokeObjectURL(imageUrl);
        }
    } catch (error) {
        previewWindow?.close();
        alert(error.message || '이미지를 열지 못했습니다.');
    }
}

async function deleteFeedback(id) {
    if (!confirm('이 피드백을 삭제할까요?')) return;
    try {
        await apiRequest(`/api/admin/feedback/${encodeURIComponent(id)}`, {
            method: 'DELETE',
            headers: getNoticeAdminHeaders()
        });
        await loadAdminFeedback();
    } catch (error) {
        alert(`삭제 실패: ${error.message}`);
    }
}

// ========================================
// 📝 공지 저장
// ========================================

async function generateAIAndSave() {
    refreshTitlePreview();
    const title = document.getElementById('post-title').value.trim();
    const target = document.getElementById('post-target').value;
    // 주관 기관은 제목 양식에서 고른 값을 그대로 쓴다. 따로 입력받지 않는다.
    const host = (isTitleManual() ? '' : getSelectedTitleHost()) || '기타';
    let deadline = document.getElementById('post-deadline').value;
    let startDate = document.getElementById('post-start-date').value;
    const isAlwaysOpen = document.getElementById('post-always-open').checked;
    const isPinned = document.getElementById('post-pinned').checked;
    const content = document.getElementById('post-content').value.trim();
    const fileInput = document.getElementById('post-images');

    if (!title) {
        alert('제목 양식의 핵심 내용을 입력해주세요.');
        document.getElementById(isTitleManual() ? 'post-title-manual' : 'title-subject').focus();
        return;
    }
    if (!content) {
        alert('공지 원문은 필수입니다.');
        document.getElementById('post-content').focus();
        return;
    }

    let aiSummary = [];
    let categoryIds = [];
    let surveyReward = '';
    let hasReward = false;
    let requiresAction = false;
    let finalImages = [];
    let existing = null;
    let analysisFailure = '';

    if (editingNoticeId) {
        existing = notices.find(n => String(n.id) === String(editingNoticeId)) || null;
    }

    beginAiProgress('공지 저장 준비를 시작합니다.');
    try {
        // 요약칸에 이미 내용이 있으면 그게 정답이다. AI가 채웠든 직접 썼든 다시 묻지 않는다.
        // 비어 있고 원문이 바뀌었을 때만 선택된 모드로 한 번 분석한다.
        const typedSummary = readSummaryField();
        if (typedSummary.length > 0) {
            updateAiProgress(42, '입력된 3줄 요약을 그대로 사용합니다.', 'analyze', 58);
            aiSummary = typedSummary;
            categoryIds = composeAiCategoryIds;
            surveyReward = composeSurveyReward;
            hasReward = composeHasReward;
            requiresAction = composeRequiresAction;
        } else if (!existing || existing.content !== content) {
            updateAiProgress(18, 'Gemini가 원문을 분석하고 있습니다.', 'analyze', 68);
            try {
                const analysis = await runNoticeAnalysis(content);
                aiSummary = analysis.summary;
                // 방금 만든 요약을 칸에도 채워, 저장된 값이 무엇인지 눈으로 확인되게 한다.
                writeSummaryField(analysis.summary);
                categoryIds = analysis.categoryIds;
                surveyReward = analysis.surveyReward;
                hasReward = analysis.hasReward;
                requiresAction = analysis.requiresAction;
                // 저장 버튼에서 처음 Gemini 편집이 실행된 경우에도 분석 날짜가
                // 폼과 저장 payload에서 유실되지 않게 한다. 관리자가 이미 입력한
                // 날짜는 보존하고 비어 있는 값만 AI 결과로 보충한다.
                if (!startDate && analysis.startDate) {
                    startDate = analysis.startDate;
                    document.getElementById('post-start-date').value = startDate;
                }
                if (!deadline && analysis.deadline) {
                    deadline = analysis.deadline;
                    document.getElementById('post-deadline').value = deadline;
                }
            } catch (error) {
                // 분석은 부가 정보일 뿐이므로 실패해도 공지 저장 자체는 막지 않는다.
                // 할당량 초과는 일시적인데 이걸로 작성한 내용을 통째로 잃으면 안 된다.
                console.error('저장 직전 분석 실패:', error);
                analysisFailure = isGeminiRateLimitError(error)
                    ? 'Gemini 분당 호출 한도를 초과해 AI 요약·카테고리를 채우지 못했습니다.'
                    : `AI 분석에 실패해 요약·카테고리를 채우지 못했습니다(${error.message}).`;
                aiSummary = existing?.aiSummary || [];
                categoryIds = existing?.categoryIds || [];
                surveyReward = existing?.surveyReward || '';
                hasReward = existing?.hasReward === true;
                requiresAction = existing?.requiresAction === true;
            }
        } else {
            updateAiProgress(42, '기존 분석 결과를 확인하고 있습니다.', 'analyze', 58);
            aiSummary = existing.aiSummary || [];
            categoryIds = existing.categoryIds || [];
            surveyReward = existing.surveyReward || '';
            hasReward = existing.hasReward === true;
            requiresAction = existing.requiresAction === true;
        }

        if (analysisFailure) {
            updateAiProgress(98, 'Gemini 편집을 완료하지 못했습니다. 기존 내용으로 저장을 계속합니다.', 'process', 98);
            document.getElementById('ai-progress-heading').textContent = 'Gemini 편집 미완료';
        } else {
            finishAiProgress('Gemini 편집 결과가 모두 반영되었습니다.');
            document.getElementById('ai-progress-heading').textContent = 'Gemini 편집 완료';
        }
        await new Promise(resolve => setTimeout(resolve, 250));
        document.getElementById('ai-progress-status').textContent = '첨부 이미지를 정리하고 있습니다.';
        // 붙여넣은 이미지 → 파일 첨부 순으로 합치고 최대 20장으로 자른다.
        for (const src of pastedImages) {
            if (finalImages.length >= MAX_NOTICE_IMAGES) break;
            finalImages.push(src);
        }
        for (let i = 0; i < fileInput.files.length; i++) {
            if (finalImages.length >= MAX_NOTICE_IMAGES) break;
            finalImages.push(await compressNoticeImage(fileInput.files[i]));
        }
        // 붙여넣기도 파일 첨부도 없으면, 수정 중인 공지의 기존 사진을 그대로 유지한다.
        if (finalImages.length === 0 && existing) {
            finalImages = existing.images || [];
        }

        const newNoticeData = {
            title,
            host,
            target,
            deadline,
            deadlineAt: deadline || null,
            startDate: startDate || null,
            isAlwaysOpen,
            isPinned,
            isHidden: existing?.isHidden === true,
            surveyReward,
            rewardNote: surveyReward || null,
            hasReward,
            requiresAction,
            content,
            aiSummary,
            categoryIds,
            images: finalImages
        };
        document.getElementById('ai-progress-status').textContent = '공지 내용을 서버에 저장하고 있습니다.';
        if (editingNoticeId) {
            await apiRequest(`/api/notices/${editingNoticeId}`, {
                method: 'PUT',
                headers: getNoticeAdminHeaders(),
                body: JSON.stringify(newNoticeData)
            });
        } else {
            await apiRequest('/api/notices', {
                method: 'POST',
                headers: getNoticeAdminHeaders(),
                body: JSON.stringify(newNoticeData)
            });
        }
        document.getElementById('ai-progress-status').textContent = '저장된 공지 목록을 새로 불러오고 있습니다.';
        await loadAdminNoticeList();
    } catch (error) {
        if (isGeminiRateLimitError(error)) {
            await showGeminiRetryCountdown(error);
        } else {
            alert(`공지 저장 실패: ${error.message}`);
        }
        return;
    } finally {
        hideAiProgress();
    }

    const savedMessage = editingNoticeId ? '공지가 수정되었습니다.' : '공지가 등록되었습니다.';
    // 분석이 빠진 채 저장됐다면 반드시 알린다. 조용히 성공한 척하면 안 된다.
    alert(analysisFailure
        ? `${savedMessage}\n\n${analysisFailure}\n목록에서 이 공지를 [수정]으로 연 뒤 'AI 자동 편집'을 눌러 다시 채워주세요.`
        : savedMessage);
    resetComposeForm();
    renderAdminNoticeList();
}

// ========================================
// 📋 등록된 공지 목록 (수정 / 삭제)
// ========================================

function setAdminNoticeStatus(message, isError = false) {
    const status = document.getElementById('admin-notice-status');
    if (!status) return;
    status.textContent = message || '';
    status.style.color = isError ? 'var(--danger)' : 'var(--text-sub)';
}

async function loadAdminNoticeList() {
    setAdminNoticeStatus('공지 목록을 불러오는 중입니다.');
    try {
        const result = await apiRequest('/api/admin/notices?page=1&limit=20', {
            method: 'GET',
            headers: getNoticeAdminHeaders()
        });
        notices = Array.isArray(result?.notices) ? result.notices : [];
        adminNoticePagination = result?.pagination || { page: 1, total: notices.length, totalPages: 1 };
        renderAdminNoticeList();
        setAdminNoticeStatus(`전체 ${adminNoticePagination.total}건 중 ${notices.length}건 표시`);
    } catch (error) {
        setAdminNoticeStatus(error.message, true);
    }
}

async function loadMoreAdminNotices() {
    const { page, totalPages } = adminNoticePagination;
    if (page >= totalPages) {
        setAdminNoticeStatus('마지막 공지까지 모두 불러왔습니다.');
        return;
    }
    try {
        const result = await apiRequest(`/api/admin/notices?page=${page + 1}&limit=20`, {
            method: 'GET',
            headers: getNoticeAdminHeaders()
        });
        const knownIds = new Set(notices.map(notice => String(notice.id)));
        notices.push(...(result.notices || []).filter(notice => !knownIds.has(String(notice.id))));
        adminNoticePagination = result.pagination || adminNoticePagination;
        renderAdminNoticeList();
        setAdminNoticeStatus(`전체 ${adminNoticePagination.total}건 중 ${notices.length}건 표시`);
    } catch (error) {
        setAdminNoticeStatus(error.message, true);
    }
}

function renderAdminNoticeList() {
    const list = document.getElementById('admin-notice-list');
    if (!list) return;

    const more = document.getElementById('admin-notice-more');
    if (more) {
        const { page, totalPages } = adminNoticePagination;
        more.hidden = totalPages === 0 || page >= totalPages;
    }

    if (notices.length === 0) {
        list.innerHTML = '<div class="review-empty">등록된 공지가 없습니다.</div>';
        return;
    }

    list.innerHTML = notices.map(notice => {
        const id = escapeHtml(String(notice.id));
        return `
            <div class="admin-notice-row ${String(notice.id) === String(editingNoticeId) ? 'is-editing' : ''} ${notice.isHidden ? 'is-hidden' : ''}">
                <div class="admin-notice-row-main">
                    <span class="admin-notice-row-title">${escapeHtml(notice.title || '제목 없음')}</span>
                    <span class="admin-notice-row-meta">
                        ${escapeHtml(notice.host || '기타')} · ${escapeHtml(notice.target || '전체')}
                        · 등록 ${escapeHtml(formatAdminDateTime(notice.createdAt))}
                        <span class="admin-notice-ago">${escapeHtml(formatRelativeFromNow(notice.createdAt))}</span>
                        · 조회 ${Number(notice.views) || 0}
                        ${notice.isHidden ? ' · 숨김' : ''}
                        ${(notice.aiSummary || []).length === 0 ? ' · <strong>AI 요약 없음</strong>' : ''}
                        ${(notice.categoryIds || []).length === 0 ? ' · <strong>카테고리 없음</strong>' : ''}
                    </span>
                </div>
                <div class="admin-notice-row-actions">
                    <button class="btn btn-outline btn-small" type="button" onclick="editAdminNotice('${id}')">수정</button>
                    <button class="btn btn-outline btn-small" type="button"
                            onclick="toggleAdminNoticeHidden('${id}', ${notice.isHidden ? 'false' : 'true'})">${notice.isHidden ? '공개' : '숨김'}</button>
                    <button class="btn btn-danger btn-small" type="button" onclick="deleteAdminNotice('${id}')">삭제</button>
                </div>
            </div>`;
    }).join('');
}

/* 등록된 공지는 마감일이 아니라 언제 올렸는지가 궁금하다.
   절대 시각과 "몇 분 전"을 함께 보여 준다. */
function formatAdminDateTime(value) {
    const date = new Date(value);
    if (!value || Number.isNaN(date.getTime())) return '기록 없음';
    const pad = number => String(number).padStart(2, '0');
    return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`
        + ` ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatRelativeFromNow(value) {
    const date = new Date(value);
    if (!value || Number.isNaN(date.getTime())) return '';
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 0) return '방금';
    if (seconds < 60) return '방금';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}분 전`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}시간 전`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}일 전`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}개월 전`;
    return `${Math.floor(months / 12)}년 전`;
}

async function toggleAdminNoticeHidden(id, hidden) {
    try {
        const result = await apiRequest(`/api/notices/${encodeURIComponent(id)}/visibility`, {
            method: 'PATCH',
            headers: getNoticeAdminHeaders(),
            body: JSON.stringify({ hidden })
        });
        const index = notices.findIndex(notice => String(notice.id) === String(id));
        if (index >= 0) notices[index] = { ...notices[index], ...result.notice };
        renderAdminNoticeList();
        setAdminNoticeStatus(hidden
            ? '공개 목록에서 숨겼습니다. 관리자 목록에서는 계속 확인할 수 있습니다.'
            : '공개 목록에 다시 노출했습니다.');
    } catch (error) {
        alert(`공개 상태 변경 실패: ${error.message}`);
    }
}

async function editAdminNotice(id) {
    let notice;
    try {
        notice = await getNoticeDetail(id);
    } catch (error) {
        alert(`공지를 불러오지 못했습니다: ${error.message}`);
        return;
    }

    editingNoticeId = notice.id;
    // 새 붙여넣기 이미지는 초기화하고, 저장돼 있던 요약은 칸에 되살려 고칠 수 있게 한다.
    pastedImages = [];
    writeSummaryField(notice.aiSummary || []);
    composeAiCategoryIds = [];
    composeSurveyReward = '';
    composeHasReward = false;
    composeRequiresAction = false;
    aiDeadlineCandidate = '';
    renderAiDeadlineCandidate();
    renderPastePreview();
    applyTitleToBuilder(notice.title);
    document.getElementById('post-target').value = notice.target || '전체';
    document.getElementById('post-deadline').value = notice.deadline || '';
    document.getElementById('post-start-date').value = notice.startDate || '';
    document.getElementById('post-always-open').checked = notice.isAlwaysOpen === true;
    document.getElementById('post-pinned').checked = notice.isPinned === true;
    toggleAlwaysOpenState();
    document.getElementById('post-content').value = notice.content || '';
    document.getElementById('post-images').value = '';
    document.getElementById('panel-compose-title').textContent = '공지 수정';
    document.getElementById('submit-btn-text').textContent = '수정 업로드';
    document.getElementById('compose-cancel').hidden = false;

    selectAdminTab('compose');
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function deleteAdminNotice(id) {
    const notice = notices.find(item => String(item.id) === String(id));
    if (!confirm(`"${notice?.title || id}" 공지를 삭제할까요?\n되돌릴 수 없습니다.`)) return;

    try {
        await apiRequest(`/api/notices/${encodeURIComponent(id)}`, {
            method: 'DELETE',
            headers: getNoticeAdminHeaders()
        });
    } catch (error) {
        alert(`삭제 실패: ${error.message}`);
        return;
    }

    if (String(editingNoticeId) === String(id)) resetComposeForm();
    await loadAdminNoticeList();
    alert('삭제되었습니다.');
}

// ========================================
// 🧐 공지 검수함
// ========================================

function setReviewStatus(message, isError = false) {
    const status = document.getElementById('review-status');
    if (!status) return;
    status.textContent = message || '';
    status.style.color = isError ? 'var(--danger)' : 'var(--text-sub)';
}

function splitReviewValues(value) {
    return String(value || '').split(',').map(item => item.trim())
        .filter((item, index, all) => item && all.indexOf(item) === index);
}

async function loadReviewNotices({ quiet = false } = {}) {
    const list = document.getElementById('review-notice-list');
    if (!list) return;
    if (!quiet) {
        list.innerHTML = '<div class="review-empty">검수 대기 공지를 불러오는 중입니다.</div>';
        setReviewStatus('목록을 갱신하고 있습니다.');
    }
    try {
        const result = await apiRequest('/api/admin/review-notices', {
            method: 'GET',
            headers: getNoticeAdminHeaders()
        });
        reviewNotices = Array.isArray(result?.notices) ? result.notices : [];
        document.getElementById('review-pending-count').textContent = String(reviewNotices.length);
        renderReviewNoticeList();
        setReviewStatus(reviewNotices.length > 0
            ? `검수 대기 공지 ${reviewNotices.length}건`
            : '현재 검수 대기 공지가 없습니다.');
        if (reviewNotices.length === 0) {
            selectedReviewNoticeId = null;
            document.getElementById('review-editor').innerHTML =
                '<div class="review-empty">현재 검수 대기 공지가 없습니다.</div>';
        } else if (!reviewNotices.some(item =>
            String(item.id) === String(selectedReviewNoticeId))) {
            await openReviewNotice(reviewNotices[0].id);
        }
    } catch (error) {
        if (!quiet) {
            list.innerHTML = '<div class="review-empty">검수 목록을 불러오지 못했습니다.</div>';
            setReviewStatus(error.message, true);
        }
    }
}

function startReviewInboxPolling() {
    if (reviewInboxPollTimer) clearInterval(reviewInboxPollTimer);
    reviewInboxPollTimer = setInterval(async () => {
        const reviewPanel = document.getElementById('panel-review');
        if (document.visibilityState !== 'visible' || !reviewPanel?.classList.contains('active')
            || reviewInboxPollInFlight || reviewMutationInFlight) return;
        reviewInboxPollInFlight = true;
        try {
            await loadReviewNotices({ quiet: true });
        } finally {
            reviewInboxPollInFlight = false;
        }
    }, 60_000);
}

function renderReviewNoticeList() {
    const list = document.getElementById('review-notice-list');
    list.innerHTML = '';
    for (const notice of reviewNotices) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `review-list-item ${
            String(notice.id) === String(selectedReviewNoticeId) ? 'active' : ''
        }`;
        button.innerHTML = `
            <span class="review-list-title">${escapeHtml(notice.title || '제목 없음')}</span>
            <span class="review-list-meta">
                ${escapeHtml(notice.sourcePublishedAt?.slice(0, 10) || '날짜 미상')}
                · 분석 ${escapeHtml(notice.analysisStatus || '대기')}
            </span>`;
        button.addEventListener('click', () => openReviewNotice(notice.id));
        list.appendChild(button);
    }
}

async function openReviewNotice(id) {
    selectedReviewNoticeId = String(id);
    renderReviewNoticeList();
    setReviewStatus('공지 상세를 불러오는 중입니다.');
    try {
        const result = await apiRequest(
            `/api/admin/review-notices/${encodeURIComponent(id)}`,
            { method: 'GET', headers: getNoticeAdminHeaders() }
        );
        renderReviewEditor(result.notice);
        setReviewStatus('원문과 AI 분석 결과를 확인한 뒤 승인 또는 반려하세요.');
    } catch (error) {
        setReviewStatus(error.message, true);
    }
}

function renderReviewEditor(notice) {
    const editor = document.getElementById('review-editor');
    const summaries = Array.isArray(notice.aiSummary) ? notice.aiSummary : [];
    const attachments = Array.isArray(notice.attachments) ? notice.attachments : [];
    const keywords = Array.isArray(notice.keywords) ? notice.keywords : [];
    const selectedCategoryIds = new Set((notice.categoryIds || []).map(Number));
    const isOcrEligible = String(notice.rawContent || notice.content || '').trim().length < 15;
    const indexedOcrCharacters = String(notice.ocrText || '').length;
    const rewardNote = String(notice.rewardNote || notice.surveyReward || '').trim();
    const hasReward = Boolean(notice.hasReward || rewardNote);
    const categoryCheckboxHtml = activeCategories.length > 0
        ? activeCategories.map(category => `
            <label class="notification-check">
                <input type="radio" name="review-category" value="${Number(category.id)}"
                    ${selectedCategoryIds.has(Number(category.id)) ? 'checked' : ''}>
                ${escapeHtml(category.name)}
            </label>`).join('')
        : '<span class="review-list-meta">등록된 카테고리가 없습니다.</span>';
    const attachmentHtml = attachments.length
        ? `<ul class="review-attachments">${attachments.map(file => `
            <li><a href="${escapeHtml(safeHttpUrl(file.url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(file.name || '첨부파일')}</a></li>
        `).join('')}</ul>`
        : '<p class="review-list-meta">첨부파일 없음</p>';
    editor.innerHTML = `
        <div class="review-source">
            <strong>출처</strong>
            <a href="${escapeHtml(safeHttpUrl(notice.sourceUrl))}" target="_blank" rel="noopener noreferrer">ECE 원문 열기</a>
            <span>분석 상태: ${escapeHtml(notice.analysisStatus || '대기')}</span>
            <span>신뢰도: ${notice.analysisConfidence == null ? '—' : escapeHtml(notice.analysisConfidence)}</span>
        </div>
        <div class="review-actions review-actions-top" role="toolbar" aria-label="공지 검수 작업">
            <button class="btn btn-outline btn-small review-action" type="button" onclick="reanalyzeReviewNotice()">AI 편집 적용</button>
            <button class="btn btn-danger btn-small review-action" type="button" onclick="rejectReviewNotice()">반려</button>
            <button class="btn btn-outline btn-small review-action" type="button" onclick="publishReviewNotice(false)">승인만</button>
            <button class="btn btn-small review-action" type="button" onclick="publishReviewNotice(true)">승인 및 알림</button>
        </div>
        <div class="review-editor-grid">
            <div class="form-group wide">
                <label for="review-title">공지 제목</label>
                <input id="review-title" type="text" value="${escapeHtml(notice.title || '')}">
            </div>
            <div class="form-group">
                <label for="review-targets">대상 학번 (쉼표로 구분)</label>
                <input id="review-targets" type="text" value="${escapeHtml((notice.targets || []).join(', '))}">
            </div>
            <div class="form-group">
                <label for="review-host">주관 기관</label>
                <input id="review-host" type="text" value="${escapeHtml(notice.host || '')}">
            </div>
            <div class="form-group">
                <label for="review-start-date">시작일 <span class="review-field-hint">(비우면 등록일)</span></label>
                <input id="review-start-date" type="date" value="${escapeHtml(notice.startDate || '')}">
                <label for="review-deadline">마감일</label>
                <input id="review-deadline" type="date" value="${escapeHtml(notice.deadline || '')}">
                <label class="title-manual-row">
                    <input id="review-always-open" type="checkbox" ${notice.isAlwaysOpen ? 'checked' : ''}>
                    상시 공지
                </label>
                <label class="title-manual-row">
                    <input id="review-pinned" type="checkbox" ${notice.isPinned ? 'checked' : ''}>
                    상단 고정
                </label>
            </div>
            <div class="form-group">
                <label for="review-keywords">키워드 (쉼표로 구분)</label>
                <input id="review-keywords" type="text" value="${escapeHtml(keywords.join(', '))}">
            </div>
            <div class="form-group review-reward-group">
                <label class="review-reward-toggle">
                    <input id="review-has-reward" type="checkbox" ${hasReward ? 'checked' : ''}
                           onchange="syncReviewRewardField(true)">
                    <span>
                        <strong>리워드 있음</strong>
                        <small>기프티콘·상품·간식·지원금 등 즉시 보상이 있을 때 선택</small>
                    </span>
                </label>
                <div id="review-reward-note-field" class="review-reward-note" ${hasReward ? '' : 'hidden'}>
                    <label for="review-survey-reward">리워드 표기</label>
                    <input id="review-survey-reward" type="text" maxlength="120"
                           value="${escapeHtml(rewardNote)}" ${hasReward ? '' : 'disabled'}
                           placeholder="예: 추첨 20명 스타벅스 기프티콘">
                </div>
                <label class="title-manual-row">
                    <input id="review-requires-action" type="checkbox" ${notice.requiresAction ? 'checked' : ''}>
                    신청·제출 필요
                </label>
            </div>
            <div class="form-group wide">
                <label for="review-summary">AI 요약 (한 줄에 하나)</label>
                <textarea id="review-summary">${escapeHtml(summaries.join('\n'))}</textarea>
            </div>
            <div class="form-group wide">
                <label for="review-content">공지 원문</label>
                <textarea id="review-content">${escapeHtml(notice.content || '')}</textarea>
            </div>
        </div>
        <div class="review-analysis">
            <strong>주제 카테고리 (하나만 선택)</strong>
            <div id="review-category-checkboxes" class="review-keywords">
                ${categoryCheckboxHtml}
            </div>
            <div class="review-keywords">${keywords.map(keyword =>
                `<span class="review-keyword">${escapeHtml(keyword)}</span>`
            ).join('')}</div>
        </div>
        <strong>첨부파일</strong>
        ${attachmentHtml}
        ${isOcrEligible ? `
            <div class="review-ocr-box">
                <strong>이미지 검색 텍스트</strong>
                <p>OCR 결과는 검색 인덱스에만 저장되며 공개 원문에는 표시되지 않습니다.
                   ${indexedOcrCharacters ? `현재 ${indexedOcrCharacters}자가 검색에 반영되어 있습니다.` : ''}</p>
                <input id="review-ocr-images" type="file" accept="image/png,image/jpeg,image/webp" multiple>
                <button class="btn btn-outline btn-small review-action" type="button" onclick="runReviewOcr()">이미지 OCR 실행</button>
            </div>
        ` : ''}
        `;
}

function syncReviewRewardField(clearWhenDisabled = false) {
    const checkbox = document.getElementById('review-has-reward');
    const field = document.getElementById('review-reward-note-field');
    const input = document.getElementById('review-survey-reward');
    if (!checkbox || !field || !input) return;
    const enabled = checkbox.checked;
    field.hidden = !enabled;
    input.disabled = !enabled;
    if (!enabled && clearWhenDisabled) input.value = '';
    if (enabled) requestAnimationFrame(() => input.focus());
}

async function runReviewOcr() {
    if (reviewMutationInFlight || !selectedReviewNoticeId) return;
    const input = document.getElementById('review-ocr-images');
    const files = Array.from(input?.files || []).slice(0, 5);
    if (files.length === 0) {
        setReviewStatus('OCR할 이미지를 선택해주세요.', true);
        return;
    }
    if (files.some(file => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))) {
        setReviewStatus('OCR 이미지는 JPG, PNG, WEBP 형식이어야 합니다.', true);
        return;
    }
    setReviewMutationBusy(true);
    setReviewStatus('이미지 글자를 추출해 검색 인덱스에 저장하고 있습니다.');
    try {
        const images = await Promise.all(files.map(getBase64));
        const result = await apiRequest(
            `/api/admin/review-notices/${encodeURIComponent(selectedReviewNoticeId)}/ocr`,
            {
                method: 'POST',
                headers: getNoticeAdminHeaders(),
                body: JSON.stringify({ images })
            }
        );
        const index = reviewNotices.findIndex(item =>
            String(item.id) === String(selectedReviewNoticeId));
        if (index >= 0) reviewNotices[index] = result.notice;
        renderReviewEditor(result.notice);
        setReviewStatus(`OCR ${Number(result?.ocr?.indexedCharacters) || 0}자가 검색 인덱스에 저장되었습니다.`);
    } catch (error) {
        setReviewStatus(error.message || 'OCR 처리에 실패했습니다.', true);
    } finally {
        setReviewMutationBusy(false);
    }
}

function setReviewMutationBusy(busy) {
    reviewMutationInFlight = busy;
    document.querySelectorAll('.review-action').forEach(button => {
        button.disabled = busy;
    });
}

function collectReviewEdits() {
    const hasReward = document.getElementById('review-has-reward').checked;
    const rewardNote = hasReward
        ? document.getElementById('review-survey-reward').value.trim()
        : '';
    return {
        title: document.getElementById('review-title').value.trim(),
        content: document.getElementById('review-content').value.trim(),
        host: document.getElementById('review-host').value.trim(),
        deadline: document.getElementById('review-deadline').value || null,
        deadlineAt: document.getElementById('review-deadline').value || null,
        startDate: document.getElementById('review-start-date').value || null,
        isAlwaysOpen: document.getElementById('review-always-open').checked,
        isPinned: document.getElementById('review-pinned').checked,
        targets: splitReviewValues(document.getElementById('review-targets').value),
        keywords: splitReviewValues(document.getElementById('review-keywords').value),
        surveyReward: rewardNote,
        rewardNote: rewardNote || null,
        hasReward,
        requiresAction: document.getElementById('review-requires-action').checked,
        categoryIds: Array.from(
            document.querySelectorAll('input[name="review-category"]:checked')
        ).map(input => Number(input.value)),
        aiSummary: document.getElementById('review-summary').value
            .split('\n').map(item => item.trim()).filter(Boolean)
    };
}

async function refreshPublishedNotices() {
    await loadAdminNoticeList();
}

async function publishReviewNotice(notify) {
    if (reviewMutationInFlight || !selectedReviewNoticeId) return;
    const edits = collectReviewEdits();
    if (!edits.title || !edits.content || edits.targets.length === 0) {
        setReviewStatus('제목, 원문, 대상 학번을 확인해주세요.', true);
        return;
    }
    if (edits.hasReward && !edits.rewardNote) {
        setReviewStatus('리워드가 있으면 카드에 표시할 리워드 내용을 입력해주세요.', true);
        document.getElementById('review-survey-reward')?.focus();
        return;
    }
    setReviewMutationBusy(true);
    setReviewStatus(notify ? '승인하고 알림 작업을 만들고 있습니다.' : '공지를 승인하고 있습니다.');
    try {
        await apiRequest(`/api/admin/review-notices/${encodeURIComponent(selectedReviewNoticeId)}/publish`, {
            method: 'POST',
            headers: getNoticeAdminHeaders(),
            body: JSON.stringify({ edits, notify })
        });
        selectedReviewNoticeId = null;
        await Promise.all([loadReviewNotices(), refreshPublishedNotices()]);
        setReviewStatus(notify ? '공지 승인과 알림 예약이 완료되었습니다.' : '공지가 승인되었습니다.');
    } catch (error) {
        setReviewStatus(error.message, true);
    } finally {
        setReviewMutationBusy(false);
    }
}

async function rejectReviewNotice() {
    if (reviewMutationInFlight || !selectedReviewNoticeId) return;
    const reason = window.prompt('반려 사유를 입력하세요. (선택)') ?? '';
    setReviewMutationBusy(true);
    setReviewStatus('공지를 반려하고 있습니다.');
    try {
        await apiRequest(`/api/admin/review-notices/${encodeURIComponent(selectedReviewNoticeId)}/reject`, {
            method: 'POST',
            headers: getNoticeAdminHeaders(),
            body: JSON.stringify({ reason })
        });
        selectedReviewNoticeId = null;
        await loadReviewNotices();
        setReviewStatus('공지가 반려되었습니다.');
    } catch (error) {
        setReviewStatus(error.message, true);
    } finally {
        setReviewMutationBusy(false);
    }
}

async function reanalyzeReviewNotice() {
    if (reviewMutationInFlight || !selectedReviewNoticeId) return;
    setReviewMutationBusy(true);
    setReviewStatus('AI가 원문을 다시 분석하고 있습니다.');
    try {
        const result = await apiRequest(
            `/api/admin/review-notices/${encodeURIComponent(selectedReviewNoticeId)}/reanalyze`,
            { method: 'POST', headers: getNoticeAdminHeaders() }
        );
        const index = reviewNotices.findIndex(item =>
            String(item.id) === String(selectedReviewNoticeId));
        if (index >= 0) reviewNotices[index] = result.notice;
        renderReviewEditor(result.notice);
        if (result.deadlineCandidate && !result.notice.deadline) {
            document.getElementById('review-deadline').value = result.deadlineCandidate;
        }
        renderReviewNoticeList();
        setReviewStatus('AI가 제목·본문 문단·요약·카테고리·설문 보상을 편집했습니다. 저장 전 내용을 확인해주세요.');
    } catch (error) {
        setReviewStatus(error.message, true);
    } finally {
        setReviewMutationBusy(false);
    }
}

function setCrawlProgress(value, message) {
    crawlProgressValue = Math.max(crawlProgressValue, Math.min(100, Math.round(value)));
    const container = document.getElementById('review-crawl-progress');
    const bar = document.getElementById('review-crawl-progress-bar');
    const percent = document.getElementById('review-crawl-progress-percent');
    if (container) container.hidden = false;
    if (bar) bar.value = crawlProgressValue;
    if (percent) percent.textContent = `${crawlProgressValue}%`;
    if (message) setReviewStatus(`${message} ${crawlProgressValue}%`);
}

function getCrawlProgressMessage(value) {
    if (value < 24) return 'ECE 사이트에 연결하고 있습니다.';
    if (value < 52) return '공지 목록과 기존 검수 항목을 비교하고 있습니다.';
    if (value < 82) return '새 공지의 원문과 리워드 여부를 확인하고 있습니다.';
    return '확인한 공지를 검수함에 정리하고 있습니다.';
}

function beginCrawlProgress() {
    if (crawlProgressTimer) clearInterval(crawlProgressTimer);
    crawlProgressValue = 0;
    setCrawlProgress(4, 'ECE 사이트에서 새 공지를 확인하고 있습니다.');
    crawlProgressTimer = setInterval(() => {
        if (crawlProgressValue >= 94) return;
        const step = crawlProgressValue < 45 ? 3 : crawlProgressValue < 75 ? 2 : 1;
        const next = Math.min(94, crawlProgressValue + step);
        setCrawlProgress(next, getCrawlProgressMessage(next));
    }, 700);
}

function finishCrawlProgress(message) {
    if (crawlProgressTimer) clearInterval(crawlProgressTimer);
    crawlProgressTimer = null;
    setCrawlProgress(100, message);
}

function failCrawlProgress(message) {
    if (crawlProgressTimer) clearInterval(crawlProgressTimer);
    crawlProgressTimer = null;
    const container = document.getElementById('review-crawl-progress');
    if (container) container.hidden = true;
    setReviewStatus(message, true);
}

async function runManualCrawl() {
    if (reviewMutationInFlight) return;
    setReviewMutationBusy(true);
    beginCrawlProgress();
    try {
        const result = await apiRequest('/api/admin/crawl/ece-academics', {
            method: 'POST',
            headers: getNoticeAdminHeaders()
        });
        await loadReviewNotices();
        finishCrawlProgress(`확인 완료 · 새 검수 공지 ${Number(result.createdCount) || 0}건 ·`);
    } catch (error) {
        failCrawlProgress(error.message);
    } finally {
        setReviewMutationBusy(false);
    }
}

// ========================================
// 🖼 배너 관리
// ========================================

async function unlockBannerPanel() {
    await Promise.all([loadBannerSlides(true), loadAdminFeedback()]);
    renderBannerList();
}

function toDateTimeLocalValue(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
}

function resolveUpdateExpiresAt(input) {
    const value = input?.value || '';
    const originalLocalValue = input?.dataset?.originalLocalValue || '';
    if (value === originalLocalValue) return '';
    return value ? new Date(value).toISOString() : '';
}

/* 왼쪽 목록에서 고른 항목. 배너 자리는 0부터 시작하는 번호,
   문의 접수는 'inquiry'로 둔다. */
let activeBannerSlot = 0;

function renderBannerList() {
    renderBannerSection('right_rail', '오른쪽 학내 홍보');
    renderLegacyBannerSection();
    renderBannerSubnav();
}

function renderBannerSubnav() {
    const nav = document.getElementById('banner-subnav');
    if (!nav) return;
    const slides = getBannerSlidesByPlacement('right_rail');
    const maxBanners = 5;

    const slotItems = Array.from({ length: maxBanners }, (_, index) => {
        const slide = slides[index];
        const name = slide ? (slide.name || slide.text || '이름 없는 배너') : '비어 있음';
        const active = activeBannerSlot === index;
        return `
            <button type="button" class="banner-subnav-item${active ? ' is-active' : ''}${slide ? '' : ' is-empty'}"
                    aria-current="${active ? 'true' : 'false'}"
                    onclick="selectBannerSlot(${index})">
                <span class="banner-subnav-label">배너 ${index + 1}</span>
                <span class="banner-subnav-sub">${escapeHtml(name)}</span>
            </button>`;
    }).join('');

    // 승인만 하고 아직 자리를 못 정한 배너들. 다섯 자리 아래에 모아 둔다.
    const staged = getBannerSlidesByPlacement('staging');
    const stagingActive = activeBannerSlot === 'staging';
    const stagingItem = `
        <p class="banner-subnav-heading">대기</p>
        <button type="button" class="banner-subnav-item${stagingActive ? ' is-active' : ''}${staged.length ? '' : ' is-empty'}"
                aria-current="${stagingActive ? 'true' : 'false'}"
                onclick="selectBannerSlot('staging')">
            <span class="banner-subnav-label">임시 배너</span>
            <span class="banner-subnav-sub">${staged.length ? `${staged.length}개 대기 중` : '없음'}</span>
        </button>`;

    // 배너 문의는 위 탭으로 옮겼으므로 여기에는 배너 자리와 대기함만 남는다.
    nav.innerHTML = `
        <p class="banner-subnav-heading">배너 자리</p>
        ${slotItems}
        ${stagingItem}`;

    applyBannerSlotVisibility();
    renderStagingBanners();
}

/* 임시 배너 목록. 여기서 "이 자리에 반영"을 누르면 고른 자리의 배너와 바뀐다.
   내려간 배너는 지워지지 않고 이 목록으로 물러나므로 되돌릴 수 있다. */
function renderStagingBanners() {
    const list = document.getElementById('staging-banner-list');
    if (!list) return;
    const staged = getBannerSlidesByPlacement('staging');
    const railSlides = getBannerSlidesByPlacement('right_rail');

    if (!staged.length) {
        list.innerHTML = `
            <p class="banner-empty-slot-note">
                대기 중인 배너가 없습니다. 배너 문의에서 신청을 승인하면 여기로 들어옵니다.
            </p>`;
        return;
    }

    const slotOptions = Array.from({ length: 5 }, (_, index) => {
        const taken = railSlides[index];
        const label = taken ? (taken.name || taken.text || '이름 없는 배너') : '비어 있음';
        return `<option value="${index}">배너 ${index + 1} — ${escapeHtml(label)}</option>`;
    }).join('');

    list.innerHTML = staged.map(slide => {
        const id = Number(slide.id);
        const ready = Boolean(slide.src && slide.mobileSrc);
        return `
            <div class="banner-item staging-item">
                <div class="banner-item-header">
                    <span class="banner-item-text">${escapeHtml(slide.name || slide.text || '이름 없는 배너')}</span>
                    <span class="staging-flag${ready ? '' : ' is-blocked'}">${ready ? '반영 가능' : '이미지 미비'}</span>
                </div>
                <div class="staging-preview">
                    ${slide.src ? `<img src="${escapeHtml(slide.src)}" alt="">` : '<span>데스크탑 이미지 없음</span>'}
                    ${slide.mobileSrc ? `<img src="${escapeHtml(slide.mobileSrc)}" alt="">` : '<span>모바일 이미지 없음</span>'}
                </div>
                ${slide.description ? `<p class="staging-desc">${escapeHtml(slide.description)}</p>` : ''}
                <div class="staging-actions">
                    <label for="staging-target-${id}">바꿀 자리</label>
                    <select id="staging-target-${id}">${slotOptions}</select>
                    <button class="btn btn-small" type="button" ${ready ? '' : 'disabled'}
                            onclick="promoteStagingBanner(${id})">확정해서 반영</button>
                    <button class="btn btn-danger btn-small" type="button"
                            onclick="deleteBannerSlide(${id})">삭제</button>
                </div>
            </div>`;
    }).join('');
}

async function promoteStagingBanner(id) {
    const select = document.getElementById(`staging-target-${id}`);
    const order = Number(select?.value);
    if (!Number.isInteger(order)) return;
    const slotLabel = select.options[select.selectedIndex]?.textContent || `배너 ${order + 1}`;
    if (!window.confirm(`${slotLabel}

이 자리에 반영할까요? 지금 그 자리에 있던 배너는 임시 배너로 물러납니다.`)) return;

    try {
        const result = await apiRequest(`/api/banner-slides/${encodeURIComponent(id)}/promote`, {
            method: 'POST',
            headers: getBannerManageHeaders(),
            body: JSON.stringify({ order })
        });
        await loadBannerSlides(true);
        renderBannerList();
        setBannerSaveState(result?.replacedId
            ? '배너를 바꿨습니다. 물러난 배너는 임시 배너에 있습니다.'
            : '빈 자리에 배너를 올렸습니다.');
    } catch (error) {
        setBannerSaveState(`반영 실패: ${error.message}`, true);
    }
}

function selectBannerSlot(slot) {
    activeBannerSlot = slot;
    renderBannerSubnav();
}

// 고른 항목만 남기고 나머지는 접는다. 편집 중 입력값이 날아가지 않도록
// 지우지 않고 감추기만 한다.
function applyBannerSlotVisibility() {
    const showStaging = activeBannerSlot === 'staging';
    const slotsSection = document.getElementById('banner-slots-section');
    const stagingSection = document.getElementById('banner-staging-section');
    if (slotsSection) slotsSection.hidden = showStaging;
    if (stagingSection) stagingSection.hidden = !showStaging;

    // 고른 자리 하나만 남기고 접는다. 편집 중 입력값이 날아가지 않도록
    // 지우지 않고 감추기만 한다.
    document.querySelectorAll('#right-rail-slides-list .banner-item')
        .forEach((item, index) => {
            item.hidden = showStaging || index !== activeBannerSlot;
        });

    // 아직 등록되지 않은 자리를 고르면 새로 만들라고 안내한다.
    const emptyNote = document.getElementById('banner-empty-slot-note');
    const slideCount = getBannerSlidesByPlacement('right_rail').length;
    if (emptyNote) emptyNote.hidden = showStaging || activeBannerSlot < slideCount;
}

/* 저장 상태 표시.
   배너 편집은 칸이 많아 어디까지 반영됐는지 알기 어렵다. 값을 건드리면
   "저장 안 됨"으로, 저장이 끝나면 시각과 함께 "저장됨"으로 바꾼다. */
function setBannerSaveState(message, isError = false) {
    const box = document.getElementById('banner-save-state');
    if (!box) return;
    box.hidden = false;
    box.dataset.state = isError ? 'error' : 'saved';
    box.textContent = message;
}

function markBannerDirty() {
    const box = document.getElementById('banner-save-state');
    if (!box) return;
    box.hidden = false;
    box.dataset.state = 'dirty';
    box.textContent = '저장하지 않은 변경이 있습니다.';
}

function formatBannerSavedAt() {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

// 상단 가로 배너가 사라져 갈 곳이 없어진 슬라이드들. 관리 화면에서 아예 안 보이면
// 지울 방법이 없으므로 삭제 버튼만 붙여 따로 모아 보여준다.
function renderLegacyBannerSection() {
    const section = document.getElementById('legacy-banner-section');
    const container = document.getElementById('legacy-banner-slides-list');
    if (!section || !container) return;

    const orphans = bannerSlides.filter(slide => (slide.placement || 'header') !== 'right_rail');
    section.hidden = orphans.length === 0;
    container.innerHTML = orphans.map(slide => `
        <div class="banner-item">
            <div class="banner-item-header">
                <span class="banner-item-text">${escapeHtml(slide.text || slide.name || '이름 없는 배너')}</span>
                <div class="banner-item-actions">
                    <button class="btn btn-small btn-danger" type="button"
                            onclick="deleteBannerSlide(${Number(slide.id)})">삭제</button>
                </div>
            </div>
        </div>
    `).join('');
}

function renderBannerSection(placement, title) {
    const container = document.getElementById('right-rail-slides-list');
    if (!container) return;

    const slides = getBannerSlidesByPlacement(placement);
    const maxBanners = 5;
    const isAtLimit = slides.length >= maxBanners;
    const limitStatus = document.getElementById('banner-limit-status');
    if (limitStatus) {
        limitStatus.textContent = `${slides.length} / ${maxBanners}`;
        limitStatus.classList.toggle('is-full', isAtLimit);
    }
    container.setAttribute('aria-label', title);
    container.innerHTML = '';

    slides.forEach((slide, idx) => {
        const safeId = Number(slide.id);
        const safeText = escapeHtml(slide.text || '');
        const localExpiresAt = toDateTimeLocalValue(slide.expiresAt);
        const localStartsAt = toDateTimeLocalValue(slide.startsAt);
        const safeImage = slide.src ? escapeHtml(slide.src) : '';
        const safeMobileImage = slide.mobileSrc ? escapeHtml(slide.mobileSrc) : '';
        const slideItem = document.createElement('div');
        slideItem.className = 'banner-item';
        slideItem.id = `banner-slide-${safeId}`;
        slideItem.innerHTML = `
            <div class="banner-item-header">
                <div>
                    <span class="banner-order-chip">${idx + 1}</span>
                    <span class="banner-item-text">${escapeHtml(slide.name || slide.text || '이름 없는 배너')}</span>
                </div>
                <div class="banner-item-actions">
                    <button class="btn btn-outline btn-small" type="button" aria-label="위로 이동" onclick="moveBanner('${placement}', ${idx}, -1)" ${idx === 0 ? 'disabled' : ''}>↑</button>
                    <button class="btn btn-outline btn-small" type="button" aria-label="아래로 이동" onclick="moveBanner('${placement}', ${idx}, 1)" ${idx === slides.length - 1 ? 'disabled' : ''}>↓</button>
                </div>
            </div>
            <div class="banner-editor-layout">
                <div class="banner-visual-column">
                    <section class="banner-format-editor">
                        <strong>데스크탑 · 3:10</strong>
                        <div class="banner-image-preview ${safeImage ? '' : 'is-empty'}" id="banner-preview-${safeId}">
                            ${safeImage
                                ? `<img src="${safeImage}" alt="">`
                                : '<span>이미지 미등록<br><small>권장 720×2400px</small></span>'}
                        </div>
                        <p class="banner-format-note" id="banner-preview-${safeId}-note" hidden></p>
                        <label class="banner-upload-button">
                            데스크탑 사진 교체
                            <input type="file" accept="image/png,image/jpeg,image/webp"
                                   class="banner-input-file-${safeId}"
                                   onchange="previewBannerUpload(this, 'banner-preview-${safeId}', 'desktop')">
                        </label>
                        ${safeImage ? `
                            <label class="banner-remove-image">
                                <input type="checkbox" class="banner-input-remove-${safeId}"> 데스크탑 사진 제거
                            </label>
                        ` : ''}
                    </section>
                    <section class="banner-format-editor">
                        <strong>모바일 · 16:9</strong>
                        <div class="banner-image-preview is-mobile ${safeMobileImage ? '' : 'is-empty'}" id="banner-mobile-preview-${safeId}">
                            ${safeMobileImage
                                ? `<img src="${safeMobileImage}" alt="">`
                                : '<span>이미지 미등록<br><small>권장 1200×675px</small></span>'}
                        </div>
                        <p class="banner-format-note" id="banner-mobile-preview-${safeId}-note" hidden></p>
                        <label class="banner-upload-button">
                            모바일 사진 교체
                            <input type="file" accept="image/png,image/jpeg,image/webp"
                                   class="banner-input-mobile-file-${safeId}"
                                   onchange="previewBannerUpload(this, 'banner-mobile-preview-${safeId}', 'mobile')">
                        </label>
                        ${safeMobileImage ? `
                            <label class="banner-remove-image">
                                <input type="checkbox" class="banner-input-mobile-remove-${safeId}"> 모바일 사진 제거
                            </label>
                        ` : ''}
                    </section>
                </div>
                <div class="banner-item-form">
                    <label class="banner-field">
                        <span>홍보 유형</span>
                        <select class="banner-input-type-${safeId}">
                            <option value="club" ${slide.type === 'club' ? 'selected' : ''}>동아리</option>
                            <option value="survey" ${slide.type === 'survey' ? 'selected' : ''}>설문</option>
                            <option value="etc" ${slide.type === 'etc' ? 'selected' : ''}>기타</option>
                            <option value="project" ${slide.type === 'project' ? 'selected' : ''}>프로젝트</option>
                            <option value="council" ${slide.type === 'council' ? 'selected' : ''}>학생회</option>
                        </select>
                    </label>
                    <label class="banner-field">
                        <span>승인 상태</span>
                        <select class="banner-input-status-${safeId}">
                            <option value="pending" ${slide.status === 'pending' ? 'selected' : ''}>승인 대기</option>
                            <option value="approved" ${slide.status === 'approved' ? 'selected' : ''}>승인</option>
                            <option value="rejected" ${slide.status === 'rejected' ? 'selected' : ''}>반려</option>
                        </select>
                    </label>
                    <label class="banner-field">
                        <span>관리용 이름</span>
                        <input type="text" maxlength="50" placeholder="예: 8월 학생회 행사" value="${escapeHtml(slide.name || '')}" class="banner-input-name-${safeId}">
                    </label>
                    <label class="banner-field">
                        <span>홍보 주체</span>
                        <input type="text" maxlength="80" placeholder="예: SNU ECE 학생회" value="${escapeHtml(slide.owner || '')}" class="banner-input-owner-${safeId}">
                    </label>
                    <label class="banner-field banner-field-wide">
                        <span>공개 제목</span>
                        <input type="text" maxlength="100" placeholder="학내 홍보 제목" value="${safeText}" class="banner-input-text-${safeId}">
                    </label>
                    <label class="banner-field banner-field-wide">
                        <span>짧은 설명</span>
                        <textarea class="banner-input-description-${safeId}" maxlength="240" placeholder="홍보의 핵심 내용을 한두 문장으로 적어주세요.">${escapeHtml(slide.description || '')}</textarea>
                    </label>
                    <label class="banner-field banner-field-wide">
                        <span>클릭 시 연결 링크</span>
                        <input type="url" class="banner-input-link-${safeId}" value="${escapeHtml(slide.linkUrl || '')}" placeholder="https://example.com/apply">
                    </label>
                    <label class="banner-field">
                        <span>이미지 대체 텍스트</span>
                        <input type="text" class="banner-input-alt-${safeId}" maxlength="160" value="${escapeHtml(slide.altText || '')}" placeholder="이미지 내용을 설명">
                    </label>
                    <label class="banner-field">
                        <span>노출 시작</span>
                        <input type="datetime-local" value="${localStartsAt}" data-original-local-value="${localStartsAt}" class="banner-input-starts-at-${safeId}">
                    </label>
                    <label class="banner-field">
                        <span>노출 종료</span>
                        <input type="datetime-local" value="${localExpiresAt}" data-original-local-value="${localExpiresAt}" class="banner-input-expires-at-${safeId}">
                    </label>
                    <input type="hidden" value="${escapeHtml(slide.textColor || '#000000')}" class="banner-input-color-${safeId}">
                    <div class="banner-form-actions banner-field-wide">
                        <button class="btn btn-small" type="button" onclick="updateBannerSlide(${safeId})">변경사항 저장</button>
                        <button class="btn btn-small btn-danger" type="button" onclick="deleteBannerSlide(${safeId})">홍보 삭제</button>
                    </div>
                </div>
            </div>
        `;
        container.appendChild(slideItem);
    });

    const addForm = document.createElement('div');
    addForm.className = 'banner-item banner-item-add';
    addForm.innerHTML = `
        <div class="banner-item-header">
            <div>
                <span class="banner-item-text">새 학내 홍보 추가하기</span>
                <small>${isAtLimit ? '최대 5개가 등록되어 있습니다. 기존 항목을 삭제하면 추가할 수 있습니다.' : '승인 상태와 노출 기간이 모두 맞을 때만 공개됩니다.'}</small>
            </div>
        </div>
        <div class="banner-editor-layout ${isAtLimit ? 'is-disabled' : ''}">
            <div class="banner-visual-column">
                <section class="banner-format-editor">
                    <strong>데스크탑 · 3:10</strong>
                    <div class="banner-image-preview is-empty" id="new-banner-preview">
                        <span>사진 미리보기<br><small>권장 720×2400px</small></span>
                    </div>
                    <p class="banner-format-note" id="new-banner-preview-note" hidden></p>
                    <label class="banner-upload-button ${isAtLimit ? 'is-disabled' : ''}">
                        데스크탑 사진 업로드
                        <input type="file" id="new-right_rail-image"
                               accept="image/png,image/jpeg,image/webp"
                               onchange="previewBannerUpload(this, 'new-banner-preview', 'desktop')" ${isAtLimit ? 'disabled' : ''}>
                    </label>
                </section>
                <section class="banner-format-editor">
                    <strong>모바일 · 16:9</strong>
                    <div class="banner-image-preview is-mobile is-empty" id="new-banner-mobile-preview">
                        <span>사진 미리보기<br><small>권장 1200×675px</small></span>
                    </div>
                    <p class="banner-format-note" id="new-banner-mobile-preview-note" hidden></p>
                    <label class="banner-upload-button ${isAtLimit ? 'is-disabled' : ''}">
                        모바일 사진 업로드
                        <input type="file" id="new-right_rail-mobile-image"
                               accept="image/png,image/jpeg,image/webp"
                               onchange="previewBannerUpload(this, 'new-banner-mobile-preview', 'mobile')" ${isAtLimit ? 'disabled' : ''}>
                    </label>
                </section>
            </div>
            <div class="banner-item-form">
                <label class="banner-field">
                    <span>홍보 유형</span>
                    <select id="new-right_rail-type" ${isAtLimit ? 'disabled' : ''}>
                        <option value="club">동아리</option>
                        <option value="survey">설문</option>
                        <option value="etc">기타</option>
                        <option value="project">프로젝트</option>
                        <option value="council">학생회</option>
                    </select>
                </label>
                <label class="banner-field">
                    <span>승인 상태</span>
                    <select id="new-right_rail-status" ${isAtLimit ? 'disabled' : ''}>
                        <option value="approved">승인</option>
                        <option value="pending">승인 대기</option>
                        <option value="rejected">반려</option>
                    </select>
                </label>
                <label class="banner-field">
                    <span>관리용 이름</span>
                    <input type="text" id="new-right_rail-name" maxlength="50" placeholder="관리자만 구분하는 이름" ${isAtLimit ? 'disabled' : ''}>
                </label>
                <label class="banner-field">
                    <span>홍보 주체</span>
                    <input type="text" id="new-right_rail-owner" maxlength="80" placeholder="예: SNU ECE 학생회" ${isAtLimit ? 'disabled' : ''}>
                </label>
                <label class="banner-field banner-field-wide">
                    <span>공개 제목</span>
                    <input type="text" id="new-right_rail-text" maxlength="100" placeholder="학내 홍보 제목" ${isAtLimit ? 'disabled' : ''}>
                </label>
                <label class="banner-field banner-field-wide">
                    <span>짧은 설명</span>
                    <textarea id="new-right_rail-description" maxlength="240" placeholder="홍보의 핵심 내용을 한두 문장으로 적어주세요." ${isAtLimit ? 'disabled' : ''}></textarea>
                </label>
                <label class="banner-field banner-field-wide">
                    <span>클릭 시 연결 링크</span>
                    <input type="url" id="new-right_rail-link-url" placeholder="https://example.com/apply" ${isAtLimit ? 'disabled' : ''}>
                </label>
                <label class="banner-field">
                    <span>이미지 대체 텍스트</span>
                    <input type="text" id="new-right_rail-alt-text" maxlength="160" placeholder="이미지 내용을 설명" ${isAtLimit ? 'disabled' : ''}>
                </label>
                <label class="banner-field">
                    <span>노출 시작</span>
                    <input type="datetime-local" id="new-right_rail-starts-at" ${isAtLimit ? 'disabled' : ''}>
                </label>
                <label class="banner-field">
                    <span>노출 종료</span>
                    <input type="datetime-local" id="new-right_rail-expires-at" ${isAtLimit ? 'disabled' : ''}>
                </label>
                <input type="hidden" id="new-right_rail-color" value="#000000">
                <input type="hidden" id="new-right_rail-bg" value="#ffffff">
                <div class="banner-form-actions banner-field-wide">
                    <button class="btn btn-small" type="button" onclick="addNewBannerSlide('${placement}')" ${isAtLimit ? 'disabled' : ''}>학내 홍보 등록하기</button>
                </div>
            </div>
        </div>
    `;
    container.appendChild(addForm);
}

/* 배너 사진의 규격.
   오른쪽 레일은 폭 240px에 화면 높이만큼 길어 3:10이라야 잘리지 않고 꽉 찬다.
   모바일은 가로로 눕는 자리라 16:9다. 어긋난 사진을 올리면 화면에서 잘리거나
   위아래가 비는데, 올리고 나서야 알게 되면 다시 만들어 오는 수고가 생긴다.
   그래서 고르는 순간 바로 알린다. */
const BANNER_FORMATS = Object.freeze({
    desktop: { ratio: 720 / 2400, label: '세로 3:10', recommend: '720×2400px' },
    mobile: { ratio: 1200 / 675, label: '가로 16:9', recommend: '1200×675px' }
});
// 10%까지는 눈에 띄지 않아 넘어간다. 그보다 벌어지면 화면에서 티가 난다.
const BANNER_RATIO_TOLERANCE = 0.1;
const BANNER_MAX_BYTES = 5 * 1024 * 1024;

function describeBannerRatio(width, height) {
    if (!width || !height) return '';
    const divisor = (a, b) => (b ? divisor(b, a % b) : a);
    const g = divisor(width, height) || 1;
    return `${Math.round(width / g)}:${Math.round(height / g)}`;
}

function setBannerFormatNote(previewId, state, message) {
    const note = document.getElementById(`${previewId}-note`);
    if (!note) return;
    note.textContent = message;
    note.dataset.state = state;
    note.hidden = !message;
}

function previewBannerUpload(input, previewId, format = 'desktop') {
    const file = input?.files?.[0];
    const preview = document.getElementById(previewId);
    if (!file || !preview) return;
    const spec = BANNER_FORMATS[format] || BANNER_FORMATS.desktop;

    if (file.size > BANNER_MAX_BYTES) {
        setBannerFormatNote(previewId, 'error',
            `파일이 ${(file.size / 1024 / 1024).toFixed(1)}MB입니다. 5MB 이하로 줄여주세요.`);
        input.value = '';
        return;
    }

    const reader = new FileReader();
    reader.onload = () => {
        preview.classList.remove('is-empty');
        preview.innerHTML = `<img src="${escapeHtml(reader.result)}" alt="선택한 배너 이미지 미리보기">`;

        // 비율은 그림이 실제로 읽힌 뒤에야 알 수 있다.
        const probe = new Image();
        probe.onload = () => {
            const width = probe.naturalWidth;
            const height = probe.naturalHeight;
            const actual = width / height;
            const gap = Math.abs(actual - spec.ratio) / spec.ratio;
            const size = `${width}×${height}px (${describeBannerRatio(width, height)})`;
            if (gap <= BANNER_RATIO_TOLERANCE) {
                setBannerFormatNote(previewId, 'ok', `${size} · 권장 비율에 맞습니다.`);
                return;
            }
            const tooTall = actual < spec.ratio;
            setBannerFormatNote(previewId, 'warn',
                `${size} · 권장은 ${spec.label} ${spec.recommend}입니다. `
                + `배너는 자리를 꽉 채워 걸리므로 이대로 올리면 ${tooTall ? '위아래' : '좌우'}가 잘립니다.`);
        };
        probe.onerror = () => setBannerFormatNote(previewId, 'error', '이미지를 읽지 못했습니다.');
        probe.src = reader.result;
    };
    reader.readAsDataURL(file);
}

function validateBannerImageFile(file) {
    if (!file) return true;
    if (!String(file.type || '').startsWith('image/')) {
        alert('배너에는 이미지 파일만 업로드할 수 있습니다.');
        return false;
    }
    if (file.size > 6 * 1024 * 1024) {
        alert('배너 이미지는 6MB 이하로 업로드해주세요.');
        return false;
    }
    return true;
}

async function addNewBannerSlide(placement) {
    if (getBannerSlidesByPlacement(placement).length >= 5) {
        alert('오른쪽 배너는 최대 5개까지 등록할 수 있습니다.');
        return;
    }
    const text = (document.getElementById(`new-${placement}-text`)?.value || '').trim();
    const name = (document.getElementById(`new-${placement}-name`)?.value || '').trim();
    const textColor = document.getElementById(`new-${placement}-color`)?.value || '#000000';
    const bgColor = document.getElementById(`new-${placement}-bg`)?.value || '#ffffff';
    const description = (document.getElementById(`new-${placement}-description`)?.value || '').trim();
    const linkUrl = (document.getElementById(`new-${placement}-link-url`)?.value || '').trim();
    const altText = (document.getElementById(`new-${placement}-alt-text`)?.value || '').trim();
    const expiresAt = document.getElementById(`new-${placement}-expires-at`)?.value || '';
    const startsAt = document.getElementById(`new-${placement}-starts-at`)?.value || '';
    const type = document.getElementById(`new-${placement}-type`)?.value || 'council';
    const owner = (document.getElementById(`new-${placement}-owner`)?.value || '').trim();
    const status = document.getElementById(`new-${placement}-status`)?.value || 'pending';
    const imageInput = document.getElementById(`new-${placement}-image`);
    const imageFile = imageInput?.files?.[0] || null;
    const mobileImageInput = document.getElementById(`new-${placement}-mobile-image`);
    const mobileImageFile = mobileImageInput?.files?.[0] || null;
    if (!validateBannerImageFile(imageFile) || !validateBannerImageFile(mobileImageFile)) return;

    if (!owner) {
        alert('홍보 주체를 입력해주세요.');
        return;
    }
    if (!imageFile || !mobileImageFile) {
        alert('데스크탑과 모바일 배너 이미지를 모두 등록해주세요.');
        return;
    }

    const imageSrc = imageFile ? await getBase64(imageFile) : null;
    const mobileImageSrc = mobileImageFile ? await getBase64(mobileImageFile) : null;
    const normalizedText = text || '이미지 배너';

    try {
        const result = await apiRequest('/api/banner-slides', {
            method: 'POST',
            headers: getBannerManageHeaders(),
            body: JSON.stringify({
                name: name || normalizedText.substring(0, 50),
                text: normalizedText,
                bgStyle: `background: ${bgColor};`,
                textColor,
                src: imageSrc,
                mobileSrc: mobileImageSrc,
                order: getBannerSlidesByPlacement(placement).length,
                placement,
                description,
                linkUrl,
                altText,
                type,
                owner,
                status,
                startsAt: startsAt ? new Date(startsAt).toISOString() : new Date().toISOString(),
                expiresAt: expiresAt ? new Date(expiresAt).toISOString() : ''
            })
        });

        bannerSlides.push(result.slide);
        renderBannerList();
        alert(status === 'approved' ? '학내 홍보가 공개 목록에 추가되었습니다.' : '학내 홍보가 저장되었습니다.');
    } catch (error) {
        alert(`배너 추가 실패: ${error.message}`);
    }
}

async function updateBannerSlide(slideId) {
    if (!Number.isFinite(Number(slideId))) {
        await loadBannerSlides();
        renderBannerList();
        alert('서버 배너와 동기화 중입니다. 잠시 후 다시 시도해주세요.');
        return;
    }

    const prevSlide = bannerSlides.find(slide => Number(slide.id) === Number(slideId));
    if (!prevSlide) return;

    const newText = (document.querySelector(`.banner-input-text-${slideId}`)?.value || '').trim();
    const newName = (document.querySelector(`.banner-input-name-${slideId}`)?.value || '').trim();
    const newColor = document.querySelector(`.banner-input-color-${slideId}`)?.value || prevSlide.textColor || '#000000';
    const descriptionInput = document.querySelector(`.banner-input-description-${slideId}`);
    const linkInput = document.querySelector(`.banner-input-link-${slideId}`);
    const altInput = document.querySelector(`.banner-input-alt-${slideId}`);
    const expiresInput = document.querySelector(`.banner-input-expires-at-${slideId}`);
    const expiresAt = resolveUpdateExpiresAt(expiresInput);
    const startsInput = document.querySelector(`.banner-input-starts-at-${slideId}`);
    const startsAt = resolveUpdateExpiresAt(startsInput);
    const type = document.querySelector(`.banner-input-type-${slideId}`)?.value || prevSlide.type || 'council';
    const owner = (document.querySelector(`.banner-input-owner-${slideId}`)?.value || '').trim();
    const status = document.querySelector(`.banner-input-status-${slideId}`)?.value || prevSlide.status || 'pending';
    const imageInput = document.querySelector(`.banner-input-file-${slideId}`);
    const imageFile = imageInput?.files?.[0] || null;
    const mobileImageInput = document.querySelector(`.banner-input-mobile-file-${slideId}`);
    const mobileImageFile = mobileImageInput?.files?.[0] || null;
    if (!validateBannerImageFile(imageFile) || !validateBannerImageFile(mobileImageFile)) return;
    const imageSrc = imageFile ? await getBase64(imageFile) : null;
    const mobileImageSrc = mobileImageFile ? await getBase64(mobileImageFile) : null;
    const removeExistingImage = Boolean(document.querySelector(`.banner-input-remove-${slideId}`)?.checked);
    const removeExistingMobileImage = Boolean(document.querySelector(`.banner-input-mobile-remove-${slideId}`)?.checked);

    if (!owner) {
        alert('홍보 주체를 입력해주세요.');
        return;
    }
    if (!newText && !imageSrc && (!prevSlide.src || removeExistingImage)) {
        alert('홍보 제목 또는 이미지를 입력해주세요.');
        return;
    }
    const nextDesktopImage = imageSrc || (removeExistingImage ? null : (prevSlide.src || null));
    const nextMobileImage = mobileImageSrc
        || (removeExistingMobileImage ? null : (prevSlide.mobileSrc || null));
    if (!nextDesktopImage || !nextMobileImage) {
        alert('데스크탑과 모바일 배너 이미지를 각각 등록해주세요.');
        return;
    }

    try {
        const result = await apiRequest(`/api/banner-slides/${slideId}`, {
            method: 'PUT',
            headers: getBannerManageHeaders(),
            body: JSON.stringify({
                name: (newName || prevSlide.name || newText || '이미지 배너').substring(0, 50),
                text: newText || prevSlide.text || '이미지 배너',
                textColor: newColor,
                bgStyle: prevSlide.bgStyle || 'background: #ffffff;',
                src: nextDesktopImage,
                mobileSrc: nextMobileImage,
                order: Number(prevSlide.order) || 0,
                placement: prevSlide.placement || 'header',
                description: descriptionInput ? descriptionInput.value.trim() : (prevSlide.description || ''),
                linkUrl: linkInput ? linkInput.value.trim() : (prevSlide.linkUrl || ''),
                altText: altInput ? altInput.value.trim() : (prevSlide.altText || ''),
                type,
                owner,
                status,
                startsAt,
                expiresAt
            })
        });

        const idx = bannerSlides.findIndex(slide => Number(slide.id) === Number(slideId));
        if (idx !== -1) bannerSlides[idx] = result.slide;
        renderBannerList();
        // 창을 띄우지 않고 위쪽 표시만 바꾼다. 어느 배너가 언제 저장됐는지 남는다.
        setBannerSaveState(`저장됨 · ${formatBannerSavedAt()}`);
    } catch (error) {
        alert(`배너 수정 실패: ${error.message}`);
    }
}

async function deleteBannerSlide(slideId) {
    if (!Number.isFinite(Number(slideId))) {
        await loadBannerSlides();
        renderBannerList();
        alert('서버 배너와 동기화 중입니다. 잠시 후 다시 시도해주세요.');
        return;
    }

    if (!confirm('이 학내 홍보를 삭제하시겠습니까?')) return;

    try {
        await apiRequest(`/api/banner-slides/${slideId}`, {
            method: 'DELETE',
            headers: getBannerManageHeaders()
        });

        bannerSlides = bannerSlides.filter(s => Number(s.id) !== Number(slideId));
        renderBannerList();
        alert('학내 홍보가 삭제되었습니다.');
    } catch (error) {
        alert(`배너 삭제 실패: ${error.message}`);
    }
}

async function moveBanner(placement, idx, dir) {
    const slides = getBannerSlidesByPlacement(placement);
    const nextIdx = idx + dir;
    if (nextIdx < 0 || nextIdx >= slides.length) return;

    const reordered = [...slides];
    const [moved] = reordered.splice(idx, 1);
    reordered.splice(nextIdx, 0, moved);
    const items = reordered
        .filter(slide => Number.isFinite(Number(slide.id)))
        .map((slide, order) => ({ id: Number(slide.id), order }));

    if (items.length === 0) return;

    try {
        const result = await apiRequest('/api/banner-slides/reorder', {
            method: 'PUT',
            headers: getBannerManageHeaders(),
            body: JSON.stringify({ items })
        });

        if (Array.isArray(result?.slides)) {
            bannerSlides = result.slides;
        } else {
            const nextById = new Map(reordered.map((slide, order) => [Number(slide.id), { ...slide, order }]));
            bannerSlides = bannerSlides.map(slide => nextById.get(Number(slide.id)) || slide);
        }
        renderBannerList();
    } catch (error) {
        alert(`배너 순서 변경 실패: ${error.message}`);
    }
}

// ========================================
// ⚙️ 관리자 설정 (마스터 관리자 전용)
// ========================================

function unlockSettingsPanel() {
    document.getElementById('edit-admin-name').value = adminInfo.name;
    document.getElementById('edit-admin-phone').value = adminInfo.phone;
    document.getElementById('edit-admin-kakao').value = adminInfo.kakao;
    document.getElementById('edit-banner-admin-name').value = bannerAdminInfo.name;
    document.getElementById('edit-banner-admin-phone').value = bannerAdminInfo.phone;
    document.getElementById('edit-banner-admin-kakao').value = bannerAdminInfo.kakao;
}

function saveAdminInfo() {
    const nextAdminInfo = {
        name: document.getElementById('edit-admin-name').value.trim(),
        phone: document.getElementById('edit-admin-phone').value.trim(),
        kakao: document.getElementById('edit-admin-kakao').value.trim()
    };
    const nextBannerInfo = {
        name: document.getElementById('edit-banner-admin-name').value.trim(),
        phone: document.getElementById('edit-banner-admin-phone').value.trim(),
        kakao: document.getElementById('edit-banner-admin-kakao').value.trim()
    };
    const newAdminPwd = document.getElementById('edit-admin-pwd').value.trim();
    const newBannerPwd = document.getElementById('edit-banner-pwd').value.trim();
    const newMasterPwd = document.getElementById('edit-master-pwd')?.value.trim() || '';

    apiRequest('/api/settings', {
        method: 'PUT',
        headers: getSuperAdminHeaders(),
        body: JSON.stringify({ adminInfo: nextAdminInfo, bannerInfo: nextBannerInfo })
    })
        .then(async result => {
            adminInfo = {
                name: result?.adminInfo?.name || nextAdminInfo.name || adminInfo.name,
                phone: result?.adminInfo?.phone || nextAdminInfo.phone || adminInfo.phone,
                kakao: result?.adminInfo?.kakao || nextAdminInfo.kakao || adminInfo.kakao
            };
            bannerAdminInfo = {
                name: result?.bannerInfo?.name || nextBannerInfo.name || bannerAdminInfo.name,
                phone: result?.bannerInfo?.phone || nextBannerInfo.phone || bannerAdminInfo.phone,
                kakao: result?.bannerInfo?.kakao || nextBannerInfo.kakao || bannerAdminInfo.kakao
            };

            const pwdChanged = [];
            if (newAdminPwd || newBannerPwd || newMasterPwd) {
                await apiRequest('/api/settings/passwords', {
                    method: 'PUT',
                    headers: getSuperAdminHeaders(),
                    body: JSON.stringify({
                        newNoticeAdminToken: newAdminPwd || undefined,
                        newBannerPassword: newBannerPwd || undefined,
                        newMasterPassword: newMasterPwd || undefined
                    })
                });

                if (newAdminPwd) {
                    noticeAdminAuthToken = newAdminPwd;
                    pwdChanged.push('공지 관리자 비밀번호');
                }
                if (newBannerPwd) pwdChanged.push('배너 관리자 비밀번호');
                if (newMasterPwd) pwdChanged.push('마스터 관리자 비밀번호');
            }

            document.getElementById('edit-admin-pwd').value = '';
            document.getElementById('edit-banner-pwd').value = '';
            const masterBox = document.getElementById('edit-master-pwd');
            if (masterBox) masterBox.value = '';
            // 마스터 비밀번호를 바꾸면 지금 세션의 자격 증명이 달라져 끊긴다.
            const needsRelogin = Boolean(newMasterPwd);
            const pwdMsg = pwdChanged.length > 0 ? `\n✅ ${pwdChanged.join(', ')} 변경 완료` : '';
            alert('관리자 설정이 업데이트되었습니다.' + pwdMsg);
        })
        .catch(error => {
            alert(`관리자 설정 업데이트 실패: ${error.message}`);
        });
}

// ========================================
// 🚀 초기화
// ========================================

document.addEventListener('DOMContentLoaded', async function () {
    // core.js가 공개 화면에서만 loadData()를 돌리므로 여기서 직접 채운다.
    noticeAdminAuthToken = '';
    superAdminAuthToken = '';
    bannerManageAuthToken = '';
    sessionStorage.removeItem('eceNoticeAdminToken');
    sessionStorage.removeItem('eceAdminToken');
    sessionStorage.removeItem('eceSuperAdminToken');
    sessionStorage.removeItem('eceBannerManageToken');

    pendingEditNoticeId = new URLSearchParams(location.search).get('edit');

    try {
        const session = await apiRequest('/api/admin/session', { method: 'GET' });
        currentAdminRole = ADMIN_TABS_BY_ROLE[session?.role] ? session.role : 'notice';
    } catch {
        const next = pendingEditNoticeId ? `?edit=${encodeURIComponent(pendingEditNoticeId)}` : '';
        // 정적 호스트에서 /admin은 이 화면 자신이라, 그리로 보내면 무한히 다시 뜬다.
        location.replace(`/admin-login.html${next}`);
        return;
    }

    resetComposeForm();
    initImagePaste();

    try {
        const settings = await apiRequest('/api/settings', { method: 'GET' });
        if (settings?.adminInfo) adminInfo = { ...adminInfo, ...settings.adminInfo };
        if (settings?.bannerInfo) bannerAdminInfo = { ...bannerAdminInfo, ...settings.bannerInfo };
    } catch (error) {
        console.error('관리자 설정 불러오기 실패:', error);
    }

    await enterAdminWorkspace();
});
