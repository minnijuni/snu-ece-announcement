import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app, resetAdminLoginAttempts, toNoticeSummary } from '../server/server.js';

test('notice summaries expose card metadata without heavy detail fields', () => {
    const summary = toNoticeSummary({
        id: 42,
        title: 'Lean notice',
        content: 'full body',
        rawContent: 'crawler body',
        ocrText: 'search-only private text',
        target: '전체',
        targets: ['전체'],
        host: '전기정보공학부',
        deadline: '2026-08-01',
        deadlineAt: '2026-08-01T14:59:59.000Z',
        startDate: null,
        expiresAt: '2026-08-04T14:59:59.000Z',
        isAlwaysOpen: false,
        isPinned: false,
        aiSummary: ['summary'],
        keywords: ['keyword'],
        attachments: [{ name: 'file', url: 'https://example.test/file' }],
        images: ['data:image/png;base64,large'],
        crawlMetadata: { html: 'large' },
        categoryIds: [3],
        views: 7,
        sourcePublishedAt: '2026-07-27T00:00:00.000Z',
        createdAt: '2026-07-27T00:00:00.000Z',
        updatedAt: '2026-07-27T00:00:00.000Z'
    });

    assert.deepEqual(summary, {
        id: 42,
        title: 'Lean notice',
        target: '전체',
        targets: ['전체'],
        host: '전기정보공학부',
        deadline: '2026-08-01',
        deadlineAt: '2026-08-01T14:59:59.000Z',
        startDate: null,
        expiresAt: '2026-08-04T14:59:59.000Z',
        isAlwaysOpen: false,
        isPinned: false,
        pinnedUntil: null,
        isHidden: false,
        category: null,
        hasReward: false,
        rewardNote: null,
        requiresAction: false,
        surveyReward: '',
        isArchived: false,
        isInGracePeriod: false,
        aiSummary: ['summary'],
        keywords: ['keyword'],
        categoryIds: [3],
        views: 7,
        sourcePublishedAt: '2026-07-27T00:00:00.000Z',
        createdAt: '2026-07-27T00:00:00.000Z',
        updatedAt: '2026-07-27T00:00:00.000Z',
        hasImages: true,
        thumbnailUrl: '/api/notices/42/thumbnail?v=2026-07-27T00%3A00%3A00.000Z'
    });
    assert.equal(
        toNoticeSummary({ id: 43, images: [], hasImages: false }).thumbnailUrl,
        '/icons/default-notice-thumbnail.png'
    );
    assert.doesNotMatch(JSON.stringify(summary), /data:image/);
    assert.doesNotMatch(JSON.stringify(summary), /search-only private text|ocrText/);
});

test('public notice API is paginated, has detail lookup, and hides Express signature', async t => {
    const server = await new Promise(resolve => {
        const listening = app.listen(0, () => resolve(listening));
    });
    t.after(() => server.close());
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const defaultListResponse = await fetch(`${baseUrl}/api/notices`);
    assert.equal(defaultListResponse.status, 200);
    const defaultListText = await defaultListResponse.text();
    assert.ok(Buffer.byteLength(defaultListText) < 100_000);
    const defaultList = JSON.parse(defaultListText);
    assert.equal(defaultList.pagination.limit, 20);
    for (const notice of defaultList.notices) {
        assert.equal(typeof notice.hasImages, 'boolean');
        assert.equal(typeof notice.thumbnailUrl, 'string');
        assert.doesNotMatch(notice.thumbnailUrl, /^data:image/);
        for (const heavyKey of [
            'content', 'rawContent', 'images', 'attachments', 'crawlMetadata'
        ]) {
            assert.equal(Object.hasOwn(notice, heavyKey), false);
        }
    }

    const listResponse = await fetch(`${baseUrl}/api/notices?page=1&limit=1`);
    assert.equal(listResponse.status, 200);
    assert.equal(listResponse.headers.get('x-powered-by'), null);
    const list = await listResponse.json();
    assert.ok(Array.isArray(list.notices));
    assert.deepEqual(
        Object.keys(list.pagination).sort(),
        ['limit', 'page', 'total', 'totalPages'].sort()
    );
    assert.equal(list.pagination.limit, 1);

    const missing = await fetch(`${baseUrl}/api/notices/9007199254740991`);
    assert.equal(missing.status, 404);

    const deadlinesResponse = await fetch(`${baseUrl}/api/notices/deadlines/imminent?days=7`);
    assert.equal(deadlinesResponse.status, 200);
    const deadlines = await deadlinesResponse.json();
    assert.deepEqual(Object.keys(deadlines.counts).sort(), ['today', 'upcoming']);
    assert.ok(Array.isArray(deadlines.notices));
    assert.equal(deadlines.range.days, 7);

    const longPromotion = await fetch(`${baseUrl}/api/banner-inquiries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/vnd.ece-banner+json' },
        body: JSON.stringify({
            name: '홍길동',
            organization: '테스트 학생회',
            type: 'council',
            email: 'test@example.test',
            title: '학내 행사 안내',
            description: '학생을 위한 학내 행사 안내 내용입니다.',
            startDate: '2026-08-01',
            endDate: '2026-08-20'
        })
    });
    assert.equal(longPromotion.status, 400);
    assert.match((await longPromotion.json()).error, /최대 14일/);
});

test('summary mismatch reports are anonymous and enter the admin feedback inbox', async t => {
    const feedbackPath = path.join(process.cwd(), 'server', 'data', 'feedback.json');
    const originalFeedback = await readFile(feedbackPath, 'utf8').catch(() => '[]');
    t.after(() => writeFile(feedbackPath, originalFeedback, 'utf8'));

    const server = await new Promise(resolve => {
        const listening = app.listen(0, () => resolve(listening));
    });
    t.after(() => server.close());
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const listResponse = await fetch(`${baseUrl}/api/notices?limit=1`);
    const list = await listResponse.json();
    const notice = list.notices[0];
    assert.ok(notice?.id);

    const report = await fetch(`${baseUrl}/api/notices/${encodeURIComponent(notice.id)}/summary-report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
    });
    assert.equal(report.status, 201);
    assert.deepEqual(await report.json(), { ok: true });

    const stored = JSON.parse(await readFile(feedbackPath, 'utf8'));
    assert.equal(stored[0].category, 'summary_mismatch');
    assert.equal(String(stored[0].noticeId), String(notice.id));
    assert.equal(Object.hasOwn(stored[0], 'ip'), false);
    assert.equal(Object.hasOwn(stored[0], 'userAgent'), false);
});

test('admin pages require a short-lived HttpOnly server session', async t => {
    const settingsPath = path.join(process.cwd(), 'server', 'data', 'settings.json');
    const originalSettings = await readFile(settingsPath, 'utf8');
    const settings = JSON.parse(originalSettings);
    const password = 'test-admin-session-password';
    settings.adminTokenHash = crypto.createHash('sha256').update(password).digest('hex');
    await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    t.after(() => writeFile(settingsPath, originalSettings, 'utf8'));

    const server = await new Promise(resolve => {
        const listening = app.listen(0, () => resolve(listening));
    });
    t.after(() => server.close());
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const loginPage = await fetch(`${baseUrl}/admin`);
    assert.equal(loginPage.status, 200);
    assert.match(await loginPage.text(), /id="admin-login-form"/);

    const blockedWorkspace = await fetch(`${baseUrl}/admin.html`, { redirect: 'manual' });
    assert.equal(blockedWorkspace.status, 302);
    assert.equal(blockedWorkspace.headers.get('location'), '/admin');

    const login = await fetch(`${baseUrl}/api/admin/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
    });
    assert.equal(login.status, 201);
    const setCookie = login.headers.get('set-cookie') || '';
    assert.match(setCookie, /ece_admin_session=/);
    assert.match(setCookie, /HttpOnly/i);
    // 로컬은 API가 프런트를 함께 서빙하는 동일 출처라 Lax로 충분하다.
    // 배포(NODE_ENV=production)에서만 교차 사이트용 None으로 바뀐다.
    assert.match(setCookie, /SameSite=Lax/i);
    const cookie = setCookie.split(';')[0];

    const workspace = await fetch(`${baseUrl}/admin/workspace`, {
        headers: { Cookie: cookie },
        redirect: 'manual'
    });
    assert.equal(workspace.status, 200);
    assert.match(await workspace.text(), /data-page="admin"/);

    const session = await fetch(`${baseUrl}/api/admin/session`, {
        headers: { Cookie: cookie }
    });
    assert.equal(session.status, 200);
    // 세션은 어떤 역할로 들어왔는지도 함께 알려준다.
    assert.deepEqual(await session.json(), { authenticated: true, role: 'notice' });

    const protectedApi = await fetch(`${baseUrl}/api/admin/feedback`, {
        headers: { Cookie: cookie }
    });
    assert.equal(protectedApi.status, 200);

    const backfillSample = [
        '--------------- 2025년 3월 9일 일요일 ---------------',
        '[전기정보 학생회] [오전 9:46] [졸업 학점 안내]\n필수 이수 학점을 확인하세요.'
    ].join('\r\n');
    const blockedBackfill = await fetch(`${baseUrl}/api/admin/backfill/kakao/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: backfillSample
    });
    assert.equal(blockedBackfill.status, 401);
    const preview = await fetch(`${baseUrl}/api/admin/backfill/kakao/preview`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'text/plain' },
        body: backfillSample
    });
    assert.equal(preview.status, 201);
    const previewResult = await preview.json();
    assert.equal(previewResult.stats.draftCount, 1);
    assert.equal(previewResult.drafts[0].categorySlug, 'academic');

    const logout = await fetch(`${baseUrl}/api/admin/session`, {
        method: 'DELETE',
        headers: { Cookie: cookie }
    });
    assert.equal(logout.status, 204);
});

test('admin roles gate their own screens and master needs no second password', async t => {
    const settingsPath = path.join(process.cwd(), 'server', 'data', 'settings.json');
    const originalSettings = await readFile(settingsPath, 'utf8');
    const settings = JSON.parse(originalSettings);
    const sha = value => crypto.createHash('sha256').update(value).digest('hex');
    settings.adminTokenHash = sha('notice-role-password');
    settings.bannerTokenHash = sha('banner-role-password');
    settings.masterTokenHash = sha('master-role-password');
    await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    t.after(() => writeFile(settingsPath, originalSettings, 'utf8'));

    const server = await new Promise(resolve => {
        const listening = app.listen(0, () => resolve(listening));
    });
    t.after(() => server.close());
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    async function loginAs(password) {
        const response = await fetch(`${baseUrl}/api/admin/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        });
        assert.equal(response.status, 201);
        const body = await response.json();
        return { role: body.role, cookie: (response.headers.get('set-cookie') || '').split(';')[0] };
    }

    // 비밀번호만으로 역할이 정해진다.
    const notice = await loginAs('notice-role-password');
    const banner = await loginAs('banner-role-password');
    const master = await loginAs('master-role-password');
    assert.equal(notice.role, 'notice');
    assert.equal(banner.role, 'banner');
    assert.equal(master.role, 'master');

    const call = (path, cookie) => fetch(`${baseUrl}${path}`, { headers: { Cookie: cookie } });

    // 배너 관리자는 공지 화면에 들어가지 못한다.
    assert.equal((await call('/api/admin/notices', banner.cookie)).status, 401);
    // 공지 관리자는 배너 화면에 들어가지 못한다.
    assert.equal((await call('/api/banner-slides/manage', notice.cookie)).status, 401);
    // 마스터는 배너 비밀번호를 따로 넣지 않고도 배너를 연다.
    assert.equal((await call('/api/banner-slides/manage', master.cookie)).status, 200);
    assert.equal((await call('/api/admin/notices', master.cookie)).status, 200);

    // 문의함은 마스터만 전부 본다. 배너 관리자에게는 배너 문의만 보인다.
    const masterInbox = await (await call('/api/admin/feedback', master.cookie)).json();
    const bannerInbox = await (await call('/api/admin/feedback', banner.cookie)).json();
    const noticeInbox = await (await call('/api/admin/feedback', notice.cookie)).json();
    assert.equal(masterInbox.role, 'master');
    assert.ok(bannerInbox.feedback.every(item => item.category === 'banner'));
    assert.equal(noticeInbox.feedback.length, 0);

    // 마스터 전용 설정은 다른 역할이 건드리지 못한다.
    assert.equal((await call('/api/admin/feedback', notice.cookie)).status, 200);
    const blockedSettings = await fetch(`${baseUrl}/api/settings/passwords`, {
        method: 'PUT',
        headers: { Cookie: notice.cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ newNoticeAdminToken: 'nope' })
    });
    assert.equal(blockedSettings.status, 401);
});

test('the admin session works when the frontend is on another site', async t => {
    // Pages(정적)와 Render(API)는 서로 다른 사이트다. 브라우저가 세션 쿠키를
    // 저장하고 다시 보내려면 세 가지가 모두 필요하다:
    // 자격증명 허용 헤더, 구체적인 허용 출처, 그리고 SameSite=None.
    const settingsPath = path.join(process.cwd(), 'server', 'data', 'settings.json');
    const originalSettings = await readFile(settingsPath, 'utf8');
    const settings = JSON.parse(originalSettings);
    const password = 'cross-site-session-password';
    settings.adminTokenHash = crypto.createHash('sha256').update(password).digest('hex');
    await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    t.after(() => writeFile(settingsPath, originalSettings, 'utf8'));

    const frontendOrigin = 'https://frontend.example';
    const previousOrigin = process.env.FRONTEND_ORIGIN;
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.FRONTEND_ORIGIN = frontendOrigin;
    process.env.NODE_ENV = 'production';
    t.after(() => {
        if (previousOrigin === undefined) delete process.env.FRONTEND_ORIGIN;
        else process.env.FRONTEND_ORIGIN = previousOrigin;
        if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousNodeEnv;
    });

    const server = await new Promise(resolve => {
        const listening = app.listen(0, () => resolve(listening));
    });
    t.after(() => server.close());
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const response = await fetch(`${baseUrl}/api/admin/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: frontendOrigin },
        body: JSON.stringify({ password })
    });
    assert.equal(response.status, 201);

    // 자격증명을 실은 요청은 와일드카드 출처로는 통과하지 못한다.
    assert.equal(response.headers.get('access-control-allow-origin'), frontendOrigin);
    assert.equal(response.headers.get('access-control-allow-credentials'), 'true');

    // SameSite=Strict면 교차 사이트 요청에 쿠키가 실리지 않는다.
    const cookie = response.headers.get('set-cookie') || '';
    assert.match(cookie, /SameSite=None/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /HttpOnly/);
});

test('credentials stay off while any origin is allowed', async t => {
    // FRONTEND_ORIGIN이 없으면 서버는 모든 출처를 허용한다. 그 상태에서
    // 자격증명까지 허용하면 브라우저가 응답을 통째로 버린다.
    const previousOrigin = process.env.FRONTEND_ORIGIN;
    delete process.env.FRONTEND_ORIGIN;
    t.after(() => {
        if (previousOrigin === undefined) delete process.env.FRONTEND_ORIGIN;
        else process.env.FRONTEND_ORIGIN = previousOrigin;
    });

    const server = await new Promise(resolve => {
        const listening = app.listen(0, () => resolve(listening));
    });
    t.after(() => server.close());

    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/health`, {
        headers: { Origin: 'https://anywhere.example' }
    });
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.equal(response.headers.get('access-control-allow-credentials'), null);
});

test('the preflight allows every method the API actually serves', async t => {
    // 프리플라이트가 메서드를 빼먹으면 브라우저가 본 요청을 보내지도 않고 막는다.
    // 서버 로그에는 아무것도 남지 않고 화면에는 'Failed to fetch'만 뜬다.
    const server = await new Promise(resolve => {
        const listening = app.listen(0, () => resolve(listening));
    });
    t.after(() => server.close());

    const response = await fetch(
        `http://127.0.0.1:${server.address().port}/api/notices/1/visibility`,
        {
            method: 'OPTIONS',
            headers: {
                Origin: 'https://snu-ece-announcement.pages.dev',
                'Access-Control-Request-Method': 'PATCH'
            }
        }
    );

    assert.equal(response.status, 204);
    const allowed = String(response.headers.get('access-control-allow-methods') || '')
        .split(',')
        .map(method => method.trim());
    // 공지 숨김은 PATCH다. 이게 빠지면 숨김 버튼이 통째로 죽는다.
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        assert.ok(allowed.includes(method), `${method}가 허용 목록에 있어야 한다`);
    }
});

test('five wrong passwords lock admin login for ten minutes', async t => {
    const settingsPath = path.join(process.cwd(), 'server', 'data', 'settings.json');
    const originalSettings = await readFile(settingsPath, 'utf8');
    const settings = JSON.parse(originalSettings);
    const password = 'lockout-probe-password';
    settings.adminTokenHash = crypto.createHash('sha256').update(password).digest('hex');
    await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    t.after(() => writeFile(settingsPath, originalSettings, 'utf8'));
    // 잠금은 IP 단위라 남겨 두면 뒤따르는 테스트가 로그인하지 못한다.
    resetAdminLoginAttempts();
    t.after(() => resetAdminLoginAttempts());

    const server = await new Promise(resolve => {
        const listening = app.listen(0, () => resolve(listening));
    });
    t.after(() => server.close());
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const attempt = body => fetch(`${baseUrl}/api/admin/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    // 네 번까지는 그냥 실패하고, 남은 횟수를 알려준다.
    for (let index = 1; index <= 4; index += 1) {
        const response = await attempt({ password: `wrong-${index}` });
        assert.equal(response.status, 401);
        const body = await response.json();
        assert.equal(body.attemptsLeft, 5 - index);
    }

    // 다섯 번째에 잠긴다.
    const locked = await attempt({ password: 'wrong-5' });
    assert.equal(locked.status, 429);
    const lockedBody = await locked.json();
    assert.ok(lockedBody.lockedForSeconds > 0);
    assert.ok(lockedBody.lockedForSeconds <= 600);
    assert.match(locked.headers.get('retry-after') || '', /^\d+$/);

    // 잠긴 동안에는 맞는 비밀번호도 통하지 않는다.
    const blocked = await attempt({ password });
    assert.equal(blocked.status, 429);
});

test('approved banners wait in staging until an admin picks the slot they replace', async t => {
    const bannerPath = path.join(process.cwd(), 'server', 'data', 'banner-slides.json');
    const originalBanners = await readFile(bannerPath, 'utf8');
    t.after(() => writeFile(bannerPath, originalBanners, 'utf8'));

    const settingsPath = path.join(process.cwd(), 'server', 'data', 'settings.json');
    const originalSettings = await readFile(settingsPath, 'utf8');
    const settings = JSON.parse(originalSettings);
    const password = 'staging-flow-password';
    settings.bannerTokenHash = crypto.createHash('sha256').update(password).digest('hex');
    await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    t.after(() => writeFile(settingsPath, originalSettings, 'utf8'));
    resetAdminLoginAttempts();
    t.after(() => resetAdminLoginAttempts());

    const server = await new Promise(resolve => {
        const listening = app.listen(0, () => resolve(listening));
    });
    t.after(() => server.close());
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const login = await fetch(`${baseUrl}/api/admin/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, role: 'banner' })
    });
    assert.equal(login.status, 201, `배너 관리자 로그인 실패: ${await login.clone().text()}`);
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];

    // 승인된 신청은 곧바로 레일에 오르지 않고 임시 자리에서 기다린다.
    const created = await fetch(`${baseUrl}/api/banner-slides`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name: '대기 배너', text: '대기', owner: '테스트', type: 'club',
            placement: 'staging', status: 'approved',
            src: '/icons/banner-recruit.svg', mobileSrc: '/icons/banner-recruit-mobile.svg'
        })
    });
    assert.equal(created.status, 201);
    const stagedId = (await created.json()).slide.id;

    // 공개 화면에는 나오지 않는다.
    const publicSlides = (await (await fetch(`${baseUrl}/api/banner-slides`)).json()).slides;
    assert.ok(publicSlides.every(slide => slide.placement !== 'staging'));
    assert.ok(publicSlides.every(slide => Number(slide.id) !== Number(stagedId)));

    const manageSlides = async () => (await (await fetch(`${baseUrl}/api/banner-slides/manage`, {
        headers: { Cookie: cookie }
    })).json()).slides;

    const before = await manageSlides();
    const displaced = before.find(slide => slide.placement === 'right_rail' && Number(slide.order) === 1);
    assert.ok(displaced, '2번 자리에 배너가 있어야 시험이 성립한다');

    // 자리를 골라 확정하면 그때 레일에 오른다.
    const promote = await fetch(`${baseUrl}/api/banner-slides/${stagedId}/promote`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: 1 })
    });
    assert.equal(promote.status, 200);
    assert.equal((await promote.json()).replacedId, Number(displaced.id));

    const after = await manageSlides();
    const promoted = after.find(slide => Number(slide.id) === Number(stagedId));
    assert.equal(promoted.placement, 'right_rail');
    assert.equal(promoted.order, 1);

    // 밀려난 배너는 지워지지 않고 임시 자리로 물러난다. 내용도 그대로다.
    const pushedBack = after.find(slide => Number(slide.id) === Number(displaced.id));
    assert.equal(pushedBack.placement, 'staging');
    assert.equal(pushedBack.src, displaced.src);
    assert.equal(pushedBack.name, displaced.name);

    // 자리 번호가 범위를 벗어나면 받지 않는다.
    const bad = await fetch(`${baseUrl}/api/banner-slides/${stagedId}/promote`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: 9 })
    });
    assert.equal(bad.status, 400);
});

test('saving a notice never stores a raw data URL when the bucket is available', async () => {
    const server = await readFile(path.join(process.cwd(), 'server', 'server.js'), 'utf8');

    // 저장 경로 두 곳 모두 업로드를 거쳐야 한다.
    assert.match(server, /createNoticeImageStore/);
    assert.match(server, /noticeImageStore\.persistImages/);
    const createRoute = server.slice(
        server.indexOf("app.post('/api/notices'"),
        server.indexOf("app.put('/api/notices/:id'")
    );
    assert.match(createRoute, /persistImages/);
    const updateRoute = server.slice(
        server.indexOf("app.put('/api/notices/:id'"),
        server.indexOf("app.delete('/api/notices/:id'")
    );
    assert.match(updateRoute, /persistImages/);
});

test('deleting a notice clears its bucket objects even when the notice is hidden', async () => {
    const server = await readFile(path.join(process.cwd(), 'server', 'server.js'), 'utf8');
    const deleteRoute = server.slice(
        server.indexOf("app.delete('/api/notices/:id'"),
        server.indexOf("app.post('/api/notices/:id/view'")
    );

    // 소프트 삭제라 행은 남는다. 그래도 파일은 지운다.
    assert.match(deleteRoute, /removeImages/);
    // 지우기 전에 주소를 읽어와야 한다.
    const readAt = deleteRoute.indexOf('getNoticeImagesById');
    assert.ok(readAt >= 0 && readAt < deleteRoute.indexOf('removeImages'),
        '이미지 목록을 먼저 읽어야 지울 수 있다');
    // 숨긴 공지도 지울 수 있다. published만 보는 조회를 쓰면 그 파일이 버킷에 남는다.
    assert.doesNotMatch(deleteRoute, /getPublishedNoticeById/);
    const helperAt = server.indexOf('async function getNoticeImagesById');
    const helper = server.slice(helperAt, server.indexOf('\n}', helperAt));
    assert.doesNotMatch(helper, /'status'/);
});
