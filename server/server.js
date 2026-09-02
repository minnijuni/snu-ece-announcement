import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { promises as fs } from 'fs';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import cron from 'node-cron';
import {
    createCredentialHash,
    isLegacyCredentialHash,
    legacyHashToken,
    verifyCredential
} from './services/credential-hash.js';
import { buildKakaoBackfillDrafts } from './services/kakao-backfill.js';
import { createOcrService } from './services/ocr-service.js';
import {
    calculateNoticeLifecycle,
    computePinnedUntil,
    getNoticeLifecycleState,
    isNoticePinnedNow,
    normalizeDeadlineAt
} from './services/notice-expiry.js';
import { getAutomationConfig } from './config/runtime-config.js';
import { CANONICAL_NOTICE_CATEGORIES } from './config/notice-categories.js';
import { ensureNoticeCategory, normalizeCategoryKey } from './services/notice-classifier.js';
import { createAutomationStore } from './storage/automation-store.js';
import { createEceCrawler } from './services/ece-crawler.js';
import * as eceParser from './services/ece-parser.js';
import { createNoticeAnalyzer } from './services/notice-analyzer.js';
import { createAutomationRouter } from './routes/automation-routes.js';
import { createNoticeThumbnailRouter } from './routes/notice-thumbnail-route.js';
import { createNoticeThumbnailService } from './services/notice-thumbnail-service.js';
import { createNoticeImageStore } from './services/notice-image-store.js';
import webPush from 'web-push';
import { createPushService, matchesSubscription } from './services/push-service.js';
import {
    buildNoticePermalink,
    createKakaoBotWebhookService
} from './services/kakao-bot-webhook.js';
import { rateLimit } from 'express-rate-limit';
import compression from 'compression';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const noticesFilePath = path.join(__dirname, 'data', 'notices.json');
const settingsFilePath = path.join(__dirname, 'data', 'settings.json');
const bannerFilePath = path.join(__dirname, 'data', 'banner-slides.json');
const automationFilePath = path.join(__dirname, 'data', 'automation.json');
const feedbackFilePath = path.join(__dirname, 'data', 'feedback.json');
const bannerInquiryImageDir = path.join(__dirname, 'data', 'banner-inquiry-images');
const thumbnailCacheDir = path.join(__dirname, 'data', 'thumbnail-cache');
const SUPER_ADMIN_TOKEN = process.env.SUPER_ADMIN_TOKEN || process.env.ADMIN_TOKEN || '';
const NOTICE_ADMIN_TOKEN = process.env.NOTICE_ADMIN_TOKEN || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_NOTICES_TABLE = process.env.SUPABASE_NOTICES_TABLE || 'notices';
const SUPABASE_SETTINGS_TABLE = process.env.SUPABASE_SETTINGS_TABLE || 'app_settings';
const useSupabase = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
const supabase = useSupabase ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) : null;
const automationConfig = getAutomationConfig();
const automationStore = createAutomationStore({
    supabase,
    useSupabase,
    filePath: automationFilePath,
    canonicalCategories: CANONICAL_NOTICE_CATEGORIES
});
const publicSiteUrl = process.env.PUBLIC_SITE_URL || process.env.FRONTEND_ORIGIN || '';
const kakaoBotWebhookService = createKakaoBotWebhookService({
    webhookUrl: process.env.KAKAO_NOTICE_WEBHOOK_URL,
    publicBaseUrl: publicSiteUrl,
    categoryProvider: () => automationStore.listCategories()
});
const noticeImageStore = createNoticeImageStore({
    supabase,
    supabaseUrl: SUPABASE_URL
});
const noticeThumbnailService = createNoticeThumbnailService({
    cacheDir: thumbnailCacheDir,
    isOwnedUrl: url => noticeImageStore.isOwnedUrl(url),
    fetchImage: async url => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`thumbnail source ${response.status}`);
        return Buffer.from(await response.arrayBuffer());
    }
});
// 주 모델이 부하로 응답을 거부하는 순간에도 자동 수집·검수가 멈추지 않도록 폴백 사슬을 준비한다.
// 콤마로 여러 개를 넣을 수 있고, 지정이 없으면 lite 계열을 기본으로 시도한다.
const geminiFallbackModels = (process.env.GEMINI_FALLBACK_MODELS || 'gemini-2.5-flash-lite,gemini-2.0-flash')
    .split(',')
    .map(name => name.trim())
    .filter(Boolean);
const noticeAnalyzer = process.env.GEMINI_API_KEY
    ? createNoticeAnalyzer({
        apiKey: process.env.GEMINI_API_KEY,
        model: process.env.GEMINI_MODEL || 'gemini-flash-latest',
        fallbackModels: geminiFallbackModels,
        // 무료 등급의 분당 한도에 맞춘 간격. 한 번의 크롤이 한도를 다 쓰면
        // 그 창 동안 관리자의 수동 편집까지 429로 막힌다.
        // 유료 등급으로 올리면 줄여서 크롤 시간을 되돌릴 수 있다.
        minIntervalMs: Number(process.env.GEMINI_MIN_INTERVAL_MS) || 6000,
        // 무료 등급의 하루 한도가 빠듯하면 2차 검수를 접어 호출 수를 반으로 줄인다.
        verifyAnalysis: process.env.GEMINI_VERIFY_ANALYSIS !== 'false',
        categoryProvider: async () => {
            const categories = await automationStore.listCategories();
            const canonicalSlugs = new Set(
                CANONICAL_NOTICE_CATEGORIES.map(category => category.slug)
            );
            return categories.filter(category => canonicalSlugs.has(category.slug));
        }
    })
    : null;
const ocrService = process.env.GEMINI_API_KEY
    ? createOcrService({ apiKey: process.env.GEMINI_API_KEY })
    : null;
const eceCrawler = createEceCrawler({
    store: automationStore,
    parser: eceParser,
    analyzer: noticeAnalyzer,
    config: automationConfig.crawl
});
const pushService = createPushService({
    store: automationStore,
    webPushClient: webPush,
    config: automationConfig.push
});
let notificationWorkerRunning = false;
let notificationWorkerTimer = null;

function initializeNotificationWorker() {
    if (!automationConfig.push.enabled || notificationWorkerTimer) return;
    const tick = async () => {
        if (notificationWorkerRunning) return;
        notificationWorkerRunning = true;
        try {
            await pushService.processPendingJobs();
        } catch (error) {
            console.error('알림 작업 처리 실패:', error);
        } finally {
            notificationWorkerRunning = false;
        }
    };
    tick();
    notificationWorkerTimer = setInterval(tick, 30_000);
    notificationWorkerTimer.unref?.();
}
let bannerStorageMode = useSupabase ? 'supabase' : 'file';
const initialNoticeAdminToken = NOTICE_ADMIN_TOKEN;

// 실사용 서비스이므로 가짜 공지를 시드하지 않는다. 첫 공지는 관리자가 직접 등록한다.
const defaultNotices = [];

const MAX_RIGHT_RAIL_BANNERS = 5;
const PROMO_TYPES = new Set(['club', 'project', 'council', 'survey', 'etc']);
const PROMO_STATUSES = new Set(['pending', 'approved', 'rejected']);
const ADMIN_SESSION_COOKIE = 'ece_admin_session';
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const adminSessions = new Map();
const kakaoBackfillBatches = new Map();
const KAKAO_BACKFILL_BATCH_TTL_MS = 30 * 60 * 1000;
// 실제 학내 홍보가 등록되기 전 순환·관리 흐름을 확인할 수 있는 임시 항목이다.
// 관리 화면에서 언제든 수정하거나 삭제할 수 있으며, 오른쪽 레일에만 노출된다.
const defaultBannerSlides = [
    {
        name: '학생회 소식 임시 홍보',
        text: '학생회 소식을 빠르게 확인하세요',
        type: 'council',
        owner: 'SNU ECE 학생회',
        status: 'approved',
        bgStyle: 'background: #1f3f8f;',
        textColor: '#ffffff',
        src: '/icons/banner-campus.svg',
        mobileSrc: '/icons/banner-campus-mobile.svg',
        order: 0,
        placement: 'right_rail',
        linkUrl: '',
        altText: 'SNU ECE 학생회 소식 임시 홍보',
        description: '현재 학내 홍보 운영 화면을 확인하기 위한 임시 항목입니다.',
        startsAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2999-12-31T23:59:59.000Z'
    },
    {
        name: '동아리 모집 임시 홍보',
        text: '학생 모집 안내',
        type: 'club',
        owner: 'SNU ECE 학생 동아리',
        status: 'approved',
        bgStyle: 'background: #ffffff;',
        textColor: '#17337a',
        src: '/icons/banner-recruit.svg',
        mobileSrc: '/icons/banner-recruit-mobile.svg',
        order: 1,
        placement: 'right_rail',
        linkUrl: '',
        altText: '학생 모집 안내 임시 홍보',
        description: '동아리 모집 소식을 보여주는 임시 항목입니다.',
        startsAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2999-12-31T23:59:59.000Z'
    },
    {
        name: '프로젝트 모집 임시 홍보',
        text: '학내 프로젝트를 소개하세요',
        type: 'project',
        owner: 'SNU ECE 프로젝트 팀',
        status: 'approved',
        bgStyle: 'background: #132959;',
        textColor: '#ffffff',
        src: '/icons/banner-partnership.svg',
        mobileSrc: '/icons/banner-partnership-mobile.svg',
        order: 2,
        placement: 'right_rail',
        linkUrl: '',
        altText: '학내 프로젝트 모집 임시 홍보',
        description: '홍보 신청하기에서 프로젝트 소개를 접수할 수 있습니다.',
        startsAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2999-12-31T23:59:59.000Z'
    }
];

const defaultAdminInfo = {
    name: 'ECE 학생회장 (이름 : 박지호)',
    phone: '010-1234-5678',
    kakao: 'snu_ece_pres'
};

const defaultBannerInfo = {
    name: '학생회 대외협력국 (국장 : 이배너)',
    phone: '010-8888-9999',
    kakao: 'snu_ece_ads'
};

const defaultSecuritySettings = {
    adminInfo: { ...defaultAdminInfo },
    bannerInfo: { ...defaultBannerInfo },
    adminTokenHash: createCredentialHash(initialNoticeAdminToken),
    // 배너·마스터 관리자도 공지 관리자와 같은 방식으로 해시만 보관한다.
    bannerTokenHash: createCredentialHash(process.env.BANNER_ADMIN_PASSWORD || ''),
    masterTokenHash: createCredentialHash(process.env.SUPER_ADMIN_TOKEN || process.env.ADMIN_TOKEN || '')
};

/* 관리자 역할.
   master  — 모든 화면. 배너를 보려고 비밀번호를 또 넣지 않는다.
   notice  — 검수 대기 · 공지 추가하기 · 공지 목록.
   banner  — 배너 관리(배너 문의 포함). */
const ADMIN_ROLES = Object.freeze(['master', 'notice', 'banner']);

function roleCredentialHash(settings, role) {
    const safe = settings || defaultSecuritySettings;
    if (role === 'notice') return safe.adminTokenHash || defaultSecuritySettings.adminTokenHash;
    if (role === 'banner') return safe.bannerTokenHash || defaultSecuritySettings.bannerTokenHash;
    if (role === 'master') return safe.masterTokenHash || defaultSecuritySettings.masterTokenHash;
    return '';
}

const ROLE_HASH_FIELD = Object.freeze({
    notice: 'adminTokenHash',
    banner: 'bannerTokenHash',
    master: 'masterTokenHash'
});

/* 이미 저장된 비밀번호는 salt 없는 sha256이다. 그 평문을 알 수 있는 순간은
   로그인에 성공한 때뿐이므로, 그 자리에서 scrypt로 다시 적는다. 이렇게 하지
   않으면 관리자가 비밀번호를 직접 바꾸기 전까지 옛 해시가 그대로 남는다.

   저장에 실패해도 로그인은 그대로 진행한다 — 해시를 못 바꾼 것이 관리자를
   밖에 세워 둘 이유는 되지 않는다. 다음 로그인에 다시 시도한다. */
async function upgradeLegacyCredential(settings, role, password) {
    const field = ROLE_HASH_FIELD[role];
    if (!field || !isLegacyCredentialHash(roleCredentialHash(settings, role))) return settings;

    try {
        return await saveSecuritySettings({ ...settings, [field]: createCredentialHash(password) });
    } catch (error) {
        console.error('비밀번호 해시 형식 갱신 실패:', error?.message || error);
        return settings;
    }
}

// 마스터는 다른 두 역할의 권한을 모두 품는다.
function roleSatisfies(role, required) {
    if (!role) return false;
    if (role === 'master') return true;
    return role === required;
}

/* 로그인 실패 잠금.
   같은 곳에서 다섯 번 틀리면 10분 동안 더 시도할 수 없다. 초당 요청 수만
   재는 rate limit과 달리, 천천히 하나씩 찔러보는 시도까지 막는 게 목적이다.
   성공하면 기록을 지운다. */
const ADMIN_LOGIN_MAX_ATTEMPTS = 5;
const ADMIN_LOGIN_LOCK_MS = 10 * 60 * 1000;
const adminLoginAttempts = new Map();

function loginAttemptKey(req) {
    return String(req.ip || req.socket?.remoteAddress || 'unknown');
}

function getAdminLoginLock(req) {
    const key = loginAttemptKey(req);
    const record = adminLoginAttempts.get(key);
    if (!record) return null;
    if (record.lockedUntil && record.lockedUntil > Date.now()) {
        return { key, retryAfterMs: record.lockedUntil - Date.now() };
    }
    // 잠금이 풀렸으면 실패 기록도 함께 비운다.
    if (record.lockedUntil && record.lockedUntil <= Date.now()) {
        adminLoginAttempts.delete(key);
    }
    return null;
}

function recordAdminLoginFailure(req) {
    const key = loginAttemptKey(req);
    const record = adminLoginAttempts.get(key) || { count: 0, lockedUntil: 0 };
    record.count += 1;
    if (record.count >= ADMIN_LOGIN_MAX_ATTEMPTS) {
        record.lockedUntil = Date.now() + ADMIN_LOGIN_LOCK_MS;
        record.count = 0;
    }
    adminLoginAttempts.set(key, record);
    return record;
}

function clearAdminLoginFailures(req) {
    adminLoginAttempts.delete(loginAttemptKey(req));
}

/* 세션 쿠키는 저장된 해시와 문자열만 맞대보면 끝나지만, 헤더 토큰은 요청마다
   scrypt를 다시 돌린다. 그 계산이 일부러 비싸다는 점이 곧 공격 표면이라 —
   틀린 토큰을 계속 던지는 것만으로 CPU를 태울 수 있다 — 로그인 화면과 같은
   잠금을 함께 건다. 잠겨 있으면 해시를 계산하기 전에 돌려보낸다. */
function verifyHeaderToken(req, token, ...expectedHashes) {
    if (!token || getAdminLoginLock(req)) return false;

    if (expectedHashes.some(hash => verifyCredential(token, hash))) {
        clearAdminLoginFailures(req);
        return true;
    }

    recordAdminLoginFailure(req);
    return false;
}

// 오래된 기록이 메모리에 계속 쌓이지 않게 이따금 치운다.
setInterval(() => {
    const now = Date.now();
    for (const [key, record] of adminLoginAttempts) {
        if (!record.lockedUntil || record.lockedUntil <= now) adminLoginAttempts.delete(key);
    }
}, ADMIN_LOGIN_LOCK_MS).unref?.();

app.disable('x-powered-by');
app.set('trust proxy', 1);

const authenticationLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: '인증 시도가 너무 많습니다. 잠시 후 다시 시도해주세요.' }
});
const subscriptionLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: '알림 설정 요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' }
});
const crawlTriggerLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 4,
    standardHeaders: 'draft-8',
    legacyHeaders: false
});
const analysisLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'AI 분석 요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' }
});
// 익명 피드백. 신원을 저장하지 않으므로 스팸을 막는 건 이 rate limit 뿐이다.
const feedbackLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 8,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: '피드백 전송이 너무 많습니다. 잠시 후 다시 시도해주세요.' }
});

// 소비자 화면의 JS·CSS와 공지 JSON을 전송 단계에서 압축한다.
// 1KB 이하는 압축 비용이 이득보다 커서 그대로 보낸다.
app.use(compression({ threshold: 1024 }));
app.use(
    ['/api/notices', '/api/banner-slides', '/api/admin/review-notices'],
    express.json({ limit: '20mb' })
);
app.use('/api/push/subscriptions', express.json({ limit: '32kb' }));
app.use(express.json({ limit: '256kb' }));
app.use(['/api/admin/verify', '/api/super-admin/verify', '/api/banner/verify'], authenticationLimiter);
app.use('/api/push/subscriptions', subscriptionLimiter);
app.use('/api/internal/crawl', crawlTriggerLimiter);
app.use('/api/summary', analysisLimiter);
app.use('/api/feedback', feedbackLimiter);
app.use('/api/banner-inquiries', feedbackLimiter);

app.use((req, res, next) => {
    const allowedOrigin = process.env.FRONTEND_ORIGIN;
    if (allowedOrigin) {
        res.header('Access-Control-Allow-Origin', allowedOrigin);
        // 관리자 세션은 HttpOnly 쿠키로 오간다. 프런트가 다른 사이트에 있으면
        // 이 헤더가 없는 응답은 브라우저가 통째로 버린다.
        // 와일드카드 출처와는 함께 쓸 수 없으므로 이 분기에서만 켠다.
        res.header('Access-Control-Allow-Credentials', 'true');
        res.header('Vary', 'Origin');
    } else {
        res.header('Access-Control-Allow-Origin', '*');
    }
    res.header('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, x-super-admin-token, x-banner-token, x-crawl-secret, x-subscription-token');
    // 여기 빠진 메서드는 브라우저가 프리플라이트에서 막아 서버까지 오지도 않는다.
    // 공지 숨김이 PATCH다.
    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');

    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next();
});

function readCookie(req, name) {
    const cookieHeader = String(req.headers.cookie || '');
    for (const pair of cookieHeader.split(';')) {
        const [rawName, ...rawValue] = pair.trim().split('=');
        if (rawName === name) return decodeURIComponent(rawValue.join('='));
    }
    return '';
}

function getAdminSession(req) {
    const sessionId = readCookie(req, ADMIN_SESSION_COOKIE);
    if (!sessionId) return null;
    const session = adminSessions.get(sessionId);
    if (!session || session.expiresAt <= Date.now()) {
        adminSessions.delete(sessionId);
        return null;
    }
    return { id: sessionId, ...session };
}

/* 배포에서는 정적 프런트와 API가 서로 다른 사이트에 있어 SameSite=Strict
   쿠키가 요청에 실리지 않는다. 교차 사이트로 보내려면 None이어야 하고,
   None은 Secure를 함께 요구한다. 로컬은 API가 프런트를 같이 서빙하는
   동일 출처라 Lax로 충분하고, http에서도 동작한다. */
function adminSessionCookiePolicy() {
    return process.env.NODE_ENV === 'production'
        ? 'SameSite=None; Secure'
        : 'SameSite=Lax';
}

function setAdminSessionCookie(res, sessionId) {
    res.setHeader(
        'Set-Cookie',
        `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(sessionId)}; HttpOnly; ${adminSessionCookiePolicy()}; Path=/; Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1000)}`
    );
}

function clearAdminSessionCookie(res) {
    res.setHeader(
        'Set-Cookie',
        `${ADMIN_SESSION_COOKIE}=; HttpOnly; ${adminSessionCookiePolicy()}; Path=/; Max-Age=0`
    );
}

/* 세션이 살아 있고, 그 세션이 들고 있는 자격 증명이 지금 저장된 값과
   같은지 본다. 비밀번호를 바꾸면 이전 세션은 자동으로 끊긴다. */
async function resolveAdminSession(req) {
    const session = getAdminSession(req);
    if (!session) return null;
    const settings = await getSecuritySettings();
    const expectedHash = roleCredentialHash(settings, session.role);
    if (!expectedHash || session.credentialHash !== expectedHash) {
        adminSessions.delete(session.id);
        return null;
    }
    return session;
}

async function hasValidAdminSession(req) {
    return Boolean(await resolveAdminSession(req));
}

app.post('/api/admin/session', authenticationLimiter, async (req, res) => {
    try {
        // 잠겨 있으면 비밀번호가 맞아도 열어 주지 않는다.
        const lock = getAdminLoginLock(req);
        if (lock) {
            const seconds = Math.ceil(lock.retryAfterMs / 1000);
            res.setHeader('Retry-After', String(seconds));
            return res.status(429).json({
                error: `비밀번호를 ${ADMIN_LOGIN_MAX_ATTEMPTS}회 이상 틀렸습니다. ${Math.ceil(seconds / 60)}분 뒤에 다시 시도해주세요.`,
                lockedForSeconds: seconds
            });
        }

        const password = String(req.body?.password || '').trim();
        const requestedRole = String(req.body?.role || '').trim();
        const settings = await getSecuritySettings();

        // 역할을 지정하지 않으면 비밀번호가 맞는 역할을 찾아준다.
        // 마스터를 먼저 보므로 같은 비밀번호를 쓰면 가장 높은 권한을 받는다.
        const candidates = ADMIN_ROLES.includes(requestedRole) ? [requestedRole] : ADMIN_ROLES;
        const matched = password
            ? candidates.find(role => verifyCredential(password, roleCredentialHash(settings, role)))
            : null;

        if (!matched) {
            const record = recordAdminLoginFailure(req);
            if (record.lockedUntil > Date.now()) {
                const seconds = Math.ceil((record.lockedUntil - Date.now()) / 1000);
                res.setHeader('Retry-After', String(seconds));
                return res.status(429).json({
                    error: `비밀번호를 ${ADMIN_LOGIN_MAX_ATTEMPTS}회 틀렸습니다. ${Math.ceil(seconds / 60)}분 동안 로그인할 수 없습니다.`,
                    lockedForSeconds: seconds
                });
            }
            const left = ADMIN_LOGIN_MAX_ATTEMPTS - record.count;
            return res.status(401).json({
                error: `관리자 인증 실패 (${left}회 더 틀리면 ${ADMIN_LOGIN_LOCK_MS / 60000}분 동안 잠깁니다)`,
                attemptsLeft: left
            });
        }

        clearAdminLoginFailures(req);
        // 평문을 손에 쥐고 있는 순간은 여기뿐이다. 옛 해시라면 지금 새 형식으로
        // 옮긴다. 세션에는 옮긴 뒤의 해시를 담아야 방금 만든 세션이 곧바로
        // 끊기지 않는다.
        const current = await upgradeLegacyCredential(settings, matched, password);
        const sessionId = crypto.randomBytes(32).toString('base64url');
        adminSessions.set(sessionId, {
            role: matched,
            credentialHash: roleCredentialHash(current, matched),
            expiresAt: Date.now() + ADMIN_SESSION_TTL_MS
        });
        setAdminSessionCookie(res, sessionId);
        res.status(201).json({ ok: true, role: matched, expiresIn: ADMIN_SESSION_TTL_MS / 1000 });
    } catch (error) {
        res.status(500).json({ error: error.message || '관리자 세션 생성 실패' });
    }
});

app.get('/api/admin/session', async (req, res) => {
    try {
        const session = await resolveAdminSession(req);
        if (!session) {
            return res.status(401).json({ authenticated: false });
        }
        res.json({ authenticated: true, role: session.role });
    } catch (error) {
        res.status(500).json({ error: error.message || '관리자 세션 확인 실패' });
    }
});

app.delete('/api/admin/session', (req, res) => {
    const sessionId = readCookie(req, ADMIN_SESSION_COOKIE);
    if (sessionId) adminSessions.delete(sessionId);
    clearAdminSessionCookie(res);
    res.status(204).send();
});

app.get(['/admin', '/admin/'], async (req, res) => {
    try {
        if (await hasValidAdminSession(req)) {
            const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
            return res.redirect(302, `/admin/workspace${query}`);
        }
        res.setHeader('Cache-Control', 'no-store');
        return res.sendFile(path.join(__dirname, '..', 'public', 'admin-login.html'));
    } catch (error) {
        return res.status(500).send('관리자 로그인 화면을 불러오지 못했습니다.');
    }
});

app.get(['/admin/workspace', '/admin.html'], async (req, res) => {
    try {
        if (!await hasValidAdminSession(req)) {
            const edit = String(req.query?.edit || '').trim();
            const next = edit ? `?edit=${encodeURIComponent(edit)}` : '';
            return res.redirect(302, `/admin${next}`);
        }
        res.setHeader('Cache-Control', 'no-store');
        return res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
    } catch (error) {
        return res.status(500).send('관리자 화면을 불러오지 못했습니다.');
    }
});

app.use(express.static(path.join(__dirname, '..', 'public')));

async function ensureNoticesFile() {
    try {
        await fs.access(noticesFilePath);
    } catch {
        await fs.mkdir(path.dirname(noticesFilePath), { recursive: true });
        await fs.writeFile(noticesFilePath, JSON.stringify(defaultNotices, null, 2), 'utf-8');
    }
}

async function ensureSettingsFile() {
    try {
        await fs.access(settingsFilePath);
    } catch {
        await fs.mkdir(path.dirname(settingsFilePath), { recursive: true });
        await fs.writeFile(settingsFilePath, JSON.stringify(defaultSecuritySettings, null, 2), 'utf-8');
    }
}

async function readNotices() {
    await ensureNoticesFile();
    const text = await fs.readFile(noticesFilePath, 'utf-8');

    try {
        const parsed = JSON.parse(text);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

async function writeNotices(notices) {
    await fs.mkdir(path.dirname(noticesFilePath), { recursive: true });
    await fs.writeFile(noticesFilePath, JSON.stringify(notices, null, 2), 'utf-8');
}

async function readSettingsFile() {
    await ensureSettingsFile();
    const text = await fs.readFile(settingsFilePath, 'utf-8');

    try {
        const parsed = JSON.parse(text);
        return {
            adminInfo: {
                name: String(parsed?.adminInfo?.name || defaultAdminInfo.name),
                phone: String(parsed?.adminInfo?.phone || defaultAdminInfo.phone),
                kakao: String(parsed?.adminInfo?.kakao || defaultAdminInfo.kakao)
            },
            bannerInfo: {
                name: String(parsed?.bannerInfo?.name || defaultBannerInfo.name),
                phone: String(parsed?.bannerInfo?.phone || defaultBannerInfo.phone),
                kakao: String(parsed?.bannerInfo?.kakao || defaultBannerInfo.kakao)
            },
            adminTokenHash: String(parsed?.adminTokenHash || defaultSecuritySettings.adminTokenHash),
            // 예전 설정 파일에는 배너 비밀번호가 평문으로만 있다. 처음 읽을 때
            // 그 값을 해시로 옮겨 두 방식이 같은 결과를 내게 한다. 여기서는 옛
            // 형식으로 옮긴다 — 설정은 요청마다 다시 읽으므로 이 자리에서
            // scrypt를 돌리면 공개 엔드포인트까지 느려진다. 로그인에 성공하면
            // upgradeLegacyCredential이 새 형식으로 바꿔 준다.
            bannerTokenHash: String(
                parsed?.bannerTokenHash
                || (parsed?.bannerPassword ? legacyHashToken(parsed.bannerPassword) : '')
                || defaultSecuritySettings.bannerTokenHash
            ),
            masterTokenHash: String(parsed?.masterTokenHash || defaultSecuritySettings.masterTokenHash)
        };
    } catch {
        return { ...defaultSecuritySettings, adminInfo: { ...defaultAdminInfo } };
    }
}

async function writeSettingsFile(settings) {
    await fs.mkdir(path.dirname(settingsFilePath), { recursive: true });
    await fs.writeFile(settingsFilePath, JSON.stringify(settings, null, 2), 'utf-8');
}

function isMissingBannerTableError(error) {
    if (!error) return false;
    const message = String(error?.message || '');
    return error.code === 'PGRST205' || message.includes('promo_slots');
}

function createDefaultBannerFileRows() {
    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    return defaultBannerSlides.map((slide, index) => ({
        id: index + 1,
        name: slide.name,
        text: slide.text,
        bgStyle: slide.bgStyle,
        textColor: slide.textColor,
        src: slide.src,
        mobileSrc: slide.mobileSrc || null,
        order: Number.isFinite(Number(slide.order)) ? Number(slide.order) : index,
        placement: slide.placement || 'header',
        linkUrl: slide.linkUrl || '',
        altText: slide.altText || '',
        description: slide.description || '',
        type: slide.type || 'council',
        owner: slide.owner || 'SNU ECE 학생회',
        startsAt: slide.startsAt || new Date(now).toISOString(),
        status: slide.status || 'approved',
        createdAt: new Date(now + index).toISOString(),
        expiresAt: slide.expiresAt || new Date(now + sevenDaysMs).toISOString(),
        isDeleted: false
    }));
}

async function ensureBannerFile() {
    try {
        await fs.access(bannerFilePath);
    } catch {
        await fs.mkdir(path.dirname(bannerFilePath), { recursive: true });
        await fs.writeFile(bannerFilePath, JSON.stringify(createDefaultBannerFileRows(), null, 2), 'utf-8');
    }
}

async function readBannerFile() {
    await ensureBannerFile();
    const text = await fs.readFile(bannerFilePath, 'utf-8');

    try {
        const parsed = JSON.parse(text);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

async function writeBannerFile(slides) {
    await fs.mkdir(path.dirname(bannerFilePath), { recursive: true });
    await fs.writeFile(bannerFilePath, JSON.stringify(slides, null, 2), 'utf-8');
}

function normalizeBannerPayload(body = {}) {
    const placement = Object.hasOwn(body, 'placement')
        ? String(body.placement).trim()
        : 'header';
    if (!['header', 'right_rail', 'staging'].includes(placement)) {
        throw new TypeError('배너 표시 위치는 header, right_rail, staging 중 하나여야 합니다.');
    }

    const linkUrl = String(body.linkUrl || '').trim();
    if (linkUrl) {
        let parsed;
        try {
            parsed = new URL(linkUrl);
        } catch {
            throw new TypeError('홍보 링크는 유효한 http 또는 https URL이어야 합니다.');
        }
        if (!['http:', 'https:'].includes(parsed.protocol)) {
            throw new TypeError('홍보 링크는 http 또는 https URL이어야 합니다.');
        }
    }

    const payload = {
        name: String(body.name || '').trim(),
        text: String(body.text || '').trim(),
        bgStyle: String(body.bgStyle || '').trim(),
        textColor: String(body.textColor || '').trim(),
        src: body.src || null,
        mobileSrc: body.mobileSrc || null,
        order: Number(body.order) || 0,
        placement,
        linkUrl,
        altText: String(body.altText || '').trim(),
        description: String(body.description || '').trim(),
        type: String(body.type || 'council').trim(),
        owner: String(body.owner || '').trim(),
        status: String(body.status || 'pending').trim(),
        startsAt: '',
        expiresAt: ''
    };

    if (!PROMO_TYPES.has(payload.type)) {
        throw new TypeError('학내 홍보 유형은 동아리, 프로젝트, 학생회, 설문, 기타 중 하나여야 합니다.');
    }
    if (!PROMO_STATUSES.has(payload.status)) {
        throw new TypeError('학내 홍보 상태는 승인 대기, 승인, 반려 중 하나여야 합니다.');
    }
    if (!payload.owner) {
        throw new TypeError('학내 홍보 주체를 입력해주세요.');
    }

    const rawStartsAt = String(body.startsAt || '').trim();
    if (rawStartsAt) {
        const startsAt = new Date(rawStartsAt);
        if (Number.isNaN(startsAt.getTime())) {
            throw new TypeError('노출 시작일은 유효한 날짜여야 합니다.');
        }
        payload.startsAt = startsAt.toISOString();
    }

    const rawExpiresAt = String(body.expiresAt || '').trim();
    if (rawExpiresAt) {
        const expiresAt = new Date(rawExpiresAt);
        if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
            throw new TypeError('만료일은 유효한 미래 날짜여야 합니다.');
        }
        payload.expiresAt = expiresAt.toISOString();
    }

    const limits = [
        ['name', 50, '이름'],
        ['text', 100, '배너 텍스트'],
        ['description', 240, '홍보 설명'],
        ['owner', 80, '홍보 주체'],
        ['altText', 160, '대체 텍스트']
    ];
    for (const [field, max, label] of limits) {
        if (payload[field].length > max) {
            throw new TypeError(`${label}은 ${max}자 이하여야 합니다.`);
        }
    }
    if (!payload.text && !payload.src) {
        throw new TypeError('배너 텍스트 또는 이미지는 필수입니다.');
    }
    if (payload.placement === 'right_rail' && (!payload.src || !payload.mobileSrc)) {
        throw new TypeError('오른쪽 홍보에는 데스크탑과 모바일 이미지를 각각 등록해야 합니다.');
    }
    return payload;
}

async function switchBannerStorageToFile(error) {
    if (bannerStorageMode === 'file') return;
    bannerStorageMode = 'file';
    await ensureBannerFile();
    console.warn('promo_slots 테이블을 찾지 못해 파일 저장소로 전환:', error?.message || error);
}

function normalizeNoticeInput(body = {}) {
    const title = String(body.title || '').trim();
    const content = String(body.content || '').trim();
    const target = String(body.target || '전체').trim() || '전체';
    const host = String(body.host || '기타').trim() || '기타';
    const deadlineAt = normalizeDeadlineAt(body.deadlineAt || body.deadline || null);
    // 행사가 열리는 날 또는 신청을 받기 시작하는 날. 마감일과 짝을 이뤄
    // 기간으로 보여준다. 없으면 등록일이 그 자리를 대신한다.
    const startDate = normalizeDateOnly(body.startDate || body.startAt || null);
    const isAlwaysOpen = body.isAlwaysOpen === true || body.isAlwaysOpen === 'true';
    const isPinned = body.isPinned === true || body.isPinned === 'true';
    const isHidden = body.isHidden === true || body.isHidden === 'true';
    const rewardNote = String(body.rewardNote || body.surveyReward || '').trim().slice(0, 120) || null;
    const hasReward = body.hasReward === true || body.hasReward === 'true' || Boolean(rewardNote);
    const requiresAction = body.requiresAction === true || body.requiresAction === 'true';
    // 예전 키('BENEFIT')나 slug로 와도 현재 넷 중 하나로 맞춘다. 비어 있으면
    // 저장 직전에 규칙 분류기가 채운다 — 카테고리 없는 공지는 만들지 않는다.
    const category = normalizeCategoryKey(body.category);
    const aiSummary = Array.isArray(body.aiSummary)
        ? body.aiSummary.map(item => String(item || '').trim()).filter(Boolean).slice(0, 3)
        : [];
    const images = Array.isArray(body.images)
        ? body.images.map(item => String(item || '')).filter(Boolean).slice(0, 20)
        : [];
    const categoryIds = Array.from(new Set(
        (Array.isArray(body.categoryIds) ? body.categoryIds : [])
            .map(Number)
            .filter(id => Number.isSafeInteger(id) && id > 0)
    )).slice(0, 6);

    return {
        title,
        content,
        target,
        host,
        deadline: deadlineAt ? deadlineAt.slice(0, 10) : '',
        deadlineAt,
        startDate,
        isAlwaysOpen,
        isPinned,
        isHidden,
        category,
        hasReward,
        rewardNote,
        requiresAction,
        surveyReward: rewardNote || '',
        aiSummary,
        categoryIds,
        images
    };
}

function normalizeAdminInfo(input = {}) {
    return {
        name: String(input.name || '').trim() || defaultAdminInfo.name,
        phone: String(input.phone || '').trim() || defaultAdminInfo.phone,
        kakao: String(input.kakao || '').trim() || defaultAdminInfo.kakao
    };
}

function normalizeBannerInfo(input = {}) {
    return {
        name: String(input.name || '').trim() || defaultBannerInfo.name,
        phone: String(input.phone || '').trim() || defaultBannerInfo.phone,
        kakao: String(input.kakao || '').trim() || defaultBannerInfo.kakao
    };
}

function normalizeDeadline(deadline) {
    const value = String(deadline || '').trim();
    return value ? value : null;
}

// 시작일은 시각까지 따질 일이 없어 날짜만 받는다.
function normalizeDateOnly(value) {
    const text = String(value || '').trim().slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function toClientNotice(row) {
    if (!row) return null;
    const categoryIds = Array.isArray(row.categoryIds)
        ? row.categoryIds
        : (row.notice_categories || []).map(item => Number(item.category_id));
    return {
        id: Number(row.id),
        title: row.title || '',
        content: row.content || '',
        target: row.target || '전체',
        targets: Array.isArray(row.targets) ? row.targets : [],
        host: row.host || '기타',
        deadline: row.deadline || (row.deadlineAt || row.deadline_at || '').slice(0, 10),
        deadlineAt: row.deadlineAt || row.deadline_at || null,
        startDate: String(row.startDate || row.start_date || '').slice(0, 10) || null,
        expiresAt: row.expiresAt || row.expires_at || null,
        isAlwaysOpen: row.isAlwaysOpen === true || row.is_always_open === true,
        isPinned: row.isPinned === true || row.is_pinned === true,
        pinnedUntil: row.pinnedUntil || row.pinned_until || null,
        isHidden: row.isHidden === true || row.is_hidden === true,
        category: row.category || null,
        hasReward: row.hasReward === true || row.has_reward === true,
        rewardNote: String(row.rewardNote || row.reward_note || row.surveyReward || row.survey_reward || '') || null,
        requiresAction: row.requiresAction === true || row.requires_action === true,
        surveyReward: String(row.rewardNote || row.reward_note || row.surveyReward || row.survey_reward || ''),
        isArchived: row.isArchived === true,
        isInGracePeriod: row.isInGracePeriod === true,
        aiSummary: Array.isArray(row.aiSummary)
            ? row.aiSummary
            : (Array.isArray(row.ai_summary) ? row.ai_summary : []),
        keywords: Array.isArray(row.keywords) ? row.keywords : [],
        sourceUrl: row.sourceUrl || row.source_url || null,
        sourcePublishedAt: row.sourcePublishedAt || row.source_published_at || null,
        attachments: Array.isArray(row.attachments) ? row.attachments : [],
        images: Array.isArray(row.images) ? row.images : [],
        categoryIds: categoryIds.map(Number),
        views: Number(row.views) || 0,
        createdAt: row.createdAt || row.created_at || null,
        updatedAt: row.updatedAt || row.updated_at || null
    };
}

function toNoticeSummary(row) {
    const notice = toClientNotice(row);
    const hasImages = typeof row.hasImages === 'boolean'
        ? row.hasImages
        : (typeof row.has_images === 'boolean'
            ? row.has_images
            : notice.images.length > 0);
    const thumbnailVersion = notice.updatedAt || notice.createdAt || '0';
    return {
        id: notice.id,
        title: notice.title,
        target: notice.target,
        targets: notice.targets,
        host: notice.host,
        deadline: notice.deadline,
        deadlineAt: notice.deadlineAt,
        startDate: notice.startDate,
        expiresAt: notice.expiresAt,
        isAlwaysOpen: notice.isAlwaysOpen,
        isPinned: notice.isPinned,
        pinnedUntil: notice.pinnedUntil,
        isHidden: notice.isHidden,
        category: notice.category,
        hasReward: notice.hasReward,
        rewardNote: notice.rewardNote || extractSurveyReward(row.content || row.rawContent || '') || null,
        requiresAction: notice.requiresAction,
        surveyReward: notice.rewardNote || notice.surveyReward || extractSurveyReward(row.content || row.rawContent || ''),
        isArchived: notice.isArchived,
        isInGracePeriod: notice.isInGracePeriod,
        aiSummary: notice.aiSummary,
        keywords: notice.keywords,
        categoryIds: notice.categoryIds,
        views: notice.views,
        sourcePublishedAt: notice.sourcePublishedAt,
        createdAt: notice.createdAt,
        updatedAt: notice.updatedAt,
        hasImages,
        thumbnailUrl: hasImages
            ? `/api/notices/${notice.id}/thumbnail?v=${encodeURIComponent(thumbnailVersion)}`
            : '/icons/default-notice-thumbnail.png'
    };
}

function getHeaderToken(req, headerName) {
    return String(req.headers[headerName] || '').trim();
}

function toClientSettings(settings) {
    return {
        adminInfo: normalizeAdminInfo(settings?.adminInfo || {}),
        bannerInfo: normalizeBannerInfo(settings?.bannerInfo || {})
    };
}

/* Supabase 행과 설정 객체를 옮기는 자리. 역할별 해시를 한 곳에서 다뤄야
   저장할 때와 읽을 때가 어긋나지 않는다. 예전 행에는 해시 열이 없고 배너
   비밀번호가 평문으로만 있으므로, 파일 저장소와 똑같이 그 값을 해시로 옮겨
   읽어 기존 비밀번호가 계속 통하게 한다.

   평문은 여기서 읽기만 하고 다시 쓰지는 않는다. securitySettingsToRow가
   banner_password를 빈 문자열로 덮어써서, 다음 저장에 그 열이 비워진다. */
function securitySettingsFromRow(data = {}) {
    return {
        adminInfo: {
            name: String(data.admin_name || defaultAdminInfo.name),
            phone: String(data.admin_phone || defaultAdminInfo.phone),
            kakao: String(data.admin_kakao || defaultAdminInfo.kakao)
        },
        bannerInfo: {
            name: String(data.banner_admin_name || defaultBannerInfo.name),
            phone: String(data.banner_admin_phone || defaultBannerInfo.phone),
            kakao: String(data.banner_admin_kakao || defaultBannerInfo.kakao)
        },
        adminTokenHash: String(data.admin_token_hash || defaultSecuritySettings.adminTokenHash),
        bannerTokenHash: String(
            data.banner_token_hash
            || (data.banner_password ? legacyHashToken(data.banner_password) : '')
            || defaultSecuritySettings.bannerTokenHash
        ),
        masterTokenHash: String(data.master_token_hash || defaultSecuritySettings.masterTokenHash)
    };
}

/* 스키마 적용과 배포의 순서는 보장되지 않는다. 새 열이 아직 없는 DB에
   그대로 쓰면 upsert가 통째로 실패해, 비밀번호를 되돌릴 설정 화면까지 막힌다.
   그래서 있는 열만으로 한 번 더 시도한다. */
const SECURITY_SETTINGS_ADDED_COLUMNS = Object.freeze(['banner_token_hash', 'master_token_hash']);

function legacySecuritySettingsRow(row) {
    const legacy = { ...row };
    for (const column of SECURITY_SETTINGS_ADDED_COLUMNS) delete legacy[column];
    return legacy;
}

function isMissingColumnError(error) {
    if (!error) return false;
    if (error.code === 'PGRST204') return true;
    const message = String(error.message || '');
    return SECURITY_SETTINGS_ADDED_COLUMNS.some(column => message.includes(column));
}

function securitySettingsToRow(normalized) {
    return {
        id: 1,
        admin_name: normalized.adminInfo.name,
        admin_phone: normalized.adminInfo.phone,
        admin_kakao: normalized.adminInfo.kakao,
        banner_admin_name: normalized.bannerInfo.name,
        banner_admin_phone: normalized.bannerInfo.phone,
        banner_admin_kakao: normalized.bannerInfo.kakao,
        // 배너 비밀번호는 banner_token_hash로만 판단한다. 열 자체는 not null이라
        // 남겨 두되, 저장할 때마다 비워서 예전에 적힌 평문을 지운다.
        banner_password: '',
        admin_token_hash: normalized.adminTokenHash,
        banner_token_hash: normalized.bannerTokenHash,
        master_token_hash: normalized.masterTokenHash,
        updated_at: new Date().toISOString()
    };
}

async function getSecuritySettings() {
    if (!useSupabase) {
        return readSettingsFile();
    }

    const { data, error } = await supabase
        .from(SUPABASE_SETTINGS_TABLE)
        .select('*')
        .eq('id', 1)
        .single();

    if (error) {
        if (error.code === 'PGRST116') {
            const seeded = {
                adminInfo: { ...defaultAdminInfo },
                bannerInfo: { ...defaultBannerInfo },
                adminTokenHash: defaultSecuritySettings.adminTokenHash,
                bannerTokenHash: defaultSecuritySettings.bannerTokenHash,
                masterTokenHash: defaultSecuritySettings.masterTokenHash
            };
            await saveSecuritySettings(seeded);
            return seeded;
        }
        throw error;
    }

    return securitySettingsFromRow(data);
}

async function saveSecuritySettings(settings) {
    const normalized = {
        adminInfo: normalizeAdminInfo(settings?.adminInfo || {}),
        bannerInfo: normalizeBannerInfo(settings?.bannerInfo || {}),
        adminTokenHash: String(settings?.adminTokenHash || defaultSecuritySettings.adminTokenHash),
        bannerTokenHash: String(settings?.bannerTokenHash || defaultSecuritySettings.bannerTokenHash),
        masterTokenHash: String(settings?.masterTokenHash || defaultSecuritySettings.masterTokenHash)
    };

    if (!useSupabase) {
        await writeSettingsFile(normalized);
        return normalized;
    }

    const row = securitySettingsToRow(normalized);
    let { error } = await supabase.from(SUPABASE_SETTINGS_TABLE).upsert(row);

    if (isMissingColumnError(error)) {
        console.warn('app_settings에 역할별 해시 열이 없습니다. server/sql/supabase-schema.sql을 적용하세요.');
        ({ error } = await supabase
            .from(SUPABASE_SETTINGS_TABLE)
            .upsert(legacySecuritySettingsRow(row)));
    }

    if (error) {
        throw error;
    }

    return normalized;
}

/* 필요한 역할을 가진 사람만 통과시킨다. 판단 근거는 로그인 세션이고,
   헤더 토큰은 세션 없이 도는 스크립트를 위해 남겨 둔 보조 경로다.
   마스터 세션은 어떤 역할을 요구하든 통과하므로, 배너를 보려고
   비밀번호를 다시 넣을 일이 없다. */
function requireAdminRole(requiredRole, failureMessage) {
    return async function guard(req, res, next) {
        try {
            const settings = await getSecuritySettings();
            const session = getAdminSession(req);

            if (session) {
                const expected = roleCredentialHash(settings, session.role);
                if (expected && session.credentialHash === expected
                    && roleSatisfies(session.role, requiredRole)) {
                    req.adminRole = session.role;
                    return next();
                }
                if (!expected || session.credentialHash !== expected) {
                    adminSessions.delete(session.id);
                }
            }

            // 헤더 토큰은 자기 역할 또는 마스터 비밀번호만 인정한다.
            const headerName = requiredRole === 'banner'
                ? 'x-banner-token'
                : (requiredRole === 'master' ? 'x-super-admin-token' : 'x-admin-token');
            const token = getHeaderToken(req, headerName);
            if (verifyHeaderToken(
                req,
                token,
                roleCredentialHash(settings, requiredRole),
                roleCredentialHash(settings, 'master')
            )) {
                req.adminRole = requiredRole;
                return next();
            }

            return res.status(401).json({ error: failureMessage });
        } catch (error) {
            res.status(500).json({ error: error.message || '관리자 인증 처리 실패' });
        }
    };
}

const requireNoticeAdmin = requireAdminRole('notice', '관리자 인증 실패');
const requireBannerAdmin = requireAdminRole('banner', '배너 관리자 인증 실패');
const requireSuperAdmin = requireAdminRole('master', '마스터 관리자 인증 실패');

/* 로그인만 되어 있으면 통과시키고 역할은 req에 실어 보낸다.
   무엇을 보여줄지는 각 엔드포인트가 역할을 보고 다시 거른다. */
async function requireAnyAdmin(req, res, next) {
    try {
        const session = await resolveAdminSession(req);
        if (session) {
            req.adminRole = session.role;
            return next();
        }
        const settings = await getSecuritySettings();
        for (const role of ADMIN_ROLES) {
            const headerName = role === 'banner'
                ? 'x-banner-token'
                : (role === 'master' ? 'x-super-admin-token' : 'x-admin-token');
            const token = getHeaderToken(req, headerName);
            if (verifyHeaderToken(req, token, roleCredentialHash(settings, role))) {
                req.adminRole = role;
                return next();
            }
        }
        return res.status(401).json({ error: '관리자 인증 실패' });
    } catch (error) {
        res.status(500).json({ error: error.message || '관리자 인증 처리 실패' });
    }
}

// 문의함은 마스터만 전부 본다. 배너 관리자에게는 배너 문의만 보인다.
function visibleFeedbackForRole(items, role) {
    if (role === 'master') return items;
    if (role === 'banner') return items.filter(item => item.category === 'banner');
    return [];
}

function feedbackKindLabelForStaff(item) {
    const roles = { notice: '공지 관리자', banner: '배너 관리자', master: '마스터' };
    const kinds = { bug: '오류 제보', question: '문의', request: '요청' };
    return `${roles[item.staffRole] || '관리자'} ${kinds[item.staffKind] || '문의'}`;
}

/* 파일 모드가 읽는 기본 파일을 만들어 둔다. server/data는 커밋하지 않으므로
   새로 받은 저장소나 CI에는 이 파일들이 없고, 관리자 화면을 다루는 테스트가
   파일이 없다는 이유로 무더기로 실패한다. ensureDefaultData와 달리 Supabase는
   건드리지 않으니, 자격 증명 없이도 부를 수 있다. */
async function ensureFileStorageSeed() {
    await ensureNoticesFile();
    await ensureSettingsFile();
    await ensureBannerFile();
}

async function ensureDefaultData() {
    if (!useSupabase) {
        await ensureNoticesFile();
        await ensureSettingsFile();
        await ensureBannerFile();
        return;
    }

    const { count, error } = await supabase
        .from(SUPABASE_NOTICES_TABLE)
        .select('id', { count: 'exact', head: true })
        .eq('is_deleted', false);

    if (error) {
        throw error;
    }

    if ((count || 0) === 0 && defaultNotices.length > 0) {
        const seedRows = defaultNotices.map(notice => ({
            title: notice.title,
            content: notice.content,
            target: notice.target,
            host: notice.host,
            deadline: normalizeDeadline(notice.deadline),
            ai_summary: notice.aiSummary,
            images: notice.images,
            views: notice.views,
            is_deleted: false
        }));

        const { error: insertError } = await supabase.from(SUPABASE_NOTICES_TABLE).insert(seedRows);
        if (insertError) {
            throw insertError;
        }
    }

    const { count: bannerCount, error: bannerCountError } = await supabase
        .from('promo_slots')
        .select('id', { count: 'exact', head: true })
        .eq('is_deleted', false)
        .eq('placement', 'right_rail')
        .gt('ends_at', new Date().toISOString());

    if (bannerCountError) {
        if (isMissingBannerTableError(bannerCountError)) {
            await switchBannerStorageToFile(bannerCountError);
        } else {
            console.warn('기본 배너 시딩 스킵:', bannerCountError.message || bannerCountError);
        }
    }

    if (!bannerCountError && (bannerCount || 0) === 0) {
        const sevenDaysLater = new Date();
        sevenDaysLater.setDate(sevenDaysLater.getDate() + 7);

        const bannerSeedRows = defaultBannerSlides.map(slide => ({
            internal_name: slide.name,
            title: slide.text,
            bg_style: slide.bgStyle,
            text_color: slide.textColor,
            image_url: slide.src,
            mobile_image_url: slide.mobileSrc || null,
            order: slide.order,
            placement: slide.placement || 'header',
            link_url: slide.linkUrl || '',
            alt_text: slide.altText || '',
            description: slide.description || '',
            type: slide.type || 'council',
            owner: slide.owner || 'SNU ECE 학생회',
            status: slide.status || 'approved',
            starts_at: slide.startsAt || new Date().toISOString(),
            ends_at: slide.expiresAt || sevenDaysLater.toISOString(),
            is_deleted: false
        }));

        const { error: bannerInsertError } = await supabase.from('promo_slots').insert(bannerSeedRows);
        if (bannerInsertError) {
            throw bannerInsertError;
        }
    }

    await getSecuritySettings();
}

function initializeBannerCleanupCron() {
    if (!useSupabase) {
        console.log('배너 자동 정리 크론: Supabase 미사용 (파일 모드), 스킵됨');
        return;
    }

    // 매일 자정에 만료된 배너 정리
    cron.schedule('0 0 * * *', async () => {
        console.log('[배너 크론 작업] 만료된 배너 정리 시작...');
        await cleanupExpiredBanners();
    });

    console.log('[배너 크론 작업] 활성화됨 (매일 자정)');
}

async function listNotices() {
    if (!useSupabase) {
        const manualNotices = await readNotices();
        const automatedNotices = await automationStore.listPublishedNotices();
        return [...manualNotices, ...automatedNotices]
            .filter(notice => !notice.isDeleted && (!notice.status || notice.status === 'published'))
            .sort((a, b) => Number(b.id) - Number(a.id));
    }

    const { data, error } = await supabase
        .from(SUPABASE_NOTICES_TABLE)
        .select('*, notice_categories(category_id)')
        .eq('is_deleted', false)
        .eq('status', 'published')
        .order('created_at', { ascending: false })
        .order('id', { ascending: false });

    if (error) {
        throw error;
    }

    return (data || []).map(toClientNotice);
}

function getLocalDateKey(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Seoul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
}

function listImminentDeadlineNotices(rows, {
    now = new Date(),
    days = 7,
    publicBaseUrl = ''
} = {}) {
    const today = getLocalDateKey(now);
    const normalizedDays = Math.max(0, Number(days) || 0);
    const end = new Date(now.getTime() + normalizedDays * 86_400_000);
    const endDate = getLocalDateKey(end);
    const notices = rows
        .filter(notice => !notice.isAlwaysOpen)
        .filter(notice => {
            const deadline = String(notice.deadlineAt || notice.deadline || '').slice(0, 10);
            return deadline >= today && deadline <= endDate;
        })
        .map(notice => {
            const deadline = String(notice.deadlineAt || notice.deadline || '').slice(0, 10);
            return {
                ...toNoticeSummary(notice),
                deadline,
                permalink: buildNoticePermalink(publicBaseUrl, notice.id)
            };
        });
    return {
        generatedAt: now.toISOString(),
        range: { from: today, to: endDate, days: normalizedDays },
        counts: {
            today: notices.filter(notice => notice.deadline === today).length,
            upcoming: notices.length
        },
        notices
    };
}

function normalizeNoticeListFilters(input = {}) {
    const categoryIds = String(input.category || '')
        .split(',')
        .map(Number)
        .filter(id => Number.isSafeInteger(id) && id > 0);
    const allowedDeadlineStates = new Set(['전체', '진행중', '마감임박', '상시', '마감됨']);
    const allowedImageStates = new Set(['전체', '있음', '없음']);
    const allowedViewStates = new Set(['전체', '100이상', '50이상', '10미만']);
    // 출처: 학부 홈페이지에서 자동으로 모아 온 것과 손으로 올린 것을 가른다.
    const allowedSources = new Set(['전체', 'crawled', 'manual']);
    const allowedSorts = new Set(['최신순', '마감임박순', '조회순', '조회수순', '조회수낮은순']);
    const cleanDate = value => {
        const normalized = String(value || '').trim();
        return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : '';
    };
    const deadlineStatus = String(input.deadlineStatus || '전체').trim();
    const hasImage = String(input.hasImage || '전체').trim();
    const views = String(input.views || '전체').trim();
    const sort = String(input.sort || '최신순').trim();
    const source = String(input.source || '전체').trim();

    const archiveMode = input.archive === 'expired' ? 'expired' : '';
    const archive = input.archive === 'true' || input.archive === true || archiveMode === 'expired';
    const flag = value => value === true || String(value || '').toLowerCase() === 'true' || value === '1';
    return {
        categoryIds: Array.from(new Set(categoryIds)),
        search: String(input.search || '').trim().toLocaleLowerCase('ko-KR').slice(0, 200),
        target: String(input.target || '전체').trim().slice(0, 40) || '전체',
        deadlineStatus: allowedDeadlineStates.has(deadlineStatus) ? deadlineStatus : '전체',
        host: String(input.host || '전체').trim().slice(0, 100) || '전체',
        hasImage: allowedImageStates.has(hasImage) ? hasImage : '전체',
        views: allowedViewStates.has(views) ? views : '전체',
        source: allowedSources.has(source) ? source : '전체',
        sort: allowedSorts.has(sort) ? sort : '최신순',
        dateFrom: cleanDate(input.dateFrom),
        dateTo: cleanDate(input.dateTo),
        urgentOnly: flag(input.urgent),
        rewardOnly: flag(input.reward),
        actionOnly: flag(input.action),
        includePast: flag(input.past) || archive,
        archiveMode,
        includeExpired: flag(input.past) || archive || deadlineStatus === '마감됨'
    };
}

function getNoticeDeadlineState(deadline, todayKey) {
    const dateKey = String(deadline || '').slice(0, 10);
    if (!dateKey) return { hasDeadline: false, isExpired: false, isUrgent: false };
    const deadlineTime = new Date(`${dateKey}T00:00:00`).getTime();
    const todayTime = new Date(`${todayKey}T00:00:00`).getTime();
    const days = Math.round((deadlineTime - todayTime) / 86400000);
    return {
        hasDeadline: true,
        isExpired: days < 0,
        isUrgent: days >= 0 && days <= 3
    };
}

function applyNoticeListFilters(rows, filters, { now = new Date() } = {}) {
    const todayKey = getLocalDateKey(now);
    const keywords = filters.search ? filters.search.split(/\s+/).filter(Boolean) : [];
    const filtered = rows.filter(row => {
        const notice = toClientNotice(row);
        const lifecycleState = getNoticeLifecycleState(notice, now);
        if (notice.isHidden) return false;
        const deadlineState = notice.isAlwaysOpen
            ? { hasDeadline: false, isExpired: false, isUrgent: false }
            : getNoticeDeadlineState(notice.deadlineAt || notice.deadline, todayKey);
        const isClosed = lifecycleState.isExpired || deadlineState.isExpired;
        if (filters.archiveMode === 'expired' && !isClosed) return false;
        if (filters.archiveMode !== 'expired' && isClosed && !filters.includeExpired) return false;
        if (filters.target !== '전체'
            && notice.target !== '전체'
            && notice.target !== filters.target) return false;

        if (keywords.length > 0) {
            const ocrText = String(row.ocrText || row.ocr_text || '');
            const searchTarget = `${notice.title} ${notice.content} ${ocrText}`.toLocaleLowerCase('ko-KR');
            if (!keywords.every(keyword => searchTarget.includes(keyword))) return false;
        }

        if (filters.deadlineStatus === '진행중' && deadlineState.isExpired) return false;
        if (filters.deadlineStatus === '마감임박' && !deadlineState.isUrgent) return false;
        if (filters.deadlineStatus === '상시' && deadlineState.hasDeadline) return false;
        if (filters.deadlineStatus === '마감됨' && !deadlineState.isExpired) return false;
        if (filters.urgentOnly && !deadlineState.isUrgent) return false;
        if (filters.rewardOnly && !notice.hasReward) return false;
        if (filters.actionOnly && !notice.requiresAction) return false;

        if (filters.host !== '전체' && notice.host !== filters.host) return false;
        /* 출처. 손으로 올린 것은 sourceType이 manual이고, 학부 홈페이지에서
           긁어 온 것은 그 출처 이름이 붙는다. 값이 비어 있으면 손으로 올린
           옛 공지로 본다. */
        if (filters.source !== '전체') {
            const crawled = String(row.sourceType || row.source_type || 'manual') !== 'manual';
            if (filters.source === 'crawled' && !crawled) return false;
            if (filters.source === 'manual' && crawled) return false;
        }
        if (filters.categoryIds.length > 0
            && !filters.categoryIds.some(id => notice.categoryIds.includes(id))) return false;

        const hasImages = typeof row.hasImages === 'boolean'
            ? row.hasImages
            : (typeof row.has_images === 'boolean' ? row.has_images : notice.images.length > 0);
        if (filters.hasImage === '있음' && !hasImages) return false;
        if (filters.hasImage === '없음' && hasImages) return false;

        if (filters.views === '100이상' && notice.views < 100) return false;
        if (filters.views === '50이상' && notice.views < 50) return false;
        if (filters.views === '10미만' && notice.views >= 10) return false;

        const deadlineKey = String(notice.deadlineAt || notice.deadline || '').slice(0, 10);
        if (filters.dateFrom && (!deadlineKey || deadlineKey < filters.dateFrom)) return false;
        if (filters.dateTo && deadlineKey && deadlineKey > filters.dateTo) return false;
        return true;
    });

    return filtered.sort((left, right) => {
        const a = toClientNotice(left);
        const b = toClientNotice(right);
        const aState = getNoticeLifecycleState(a, now);
        const bState = getNoticeLifecycleState(b, now);
        const aPinned = isNoticePinnedNow(a, now);
        const bPinned = isNoticePinnedNow(b, now);
        if (aPinned !== bPinned) return aPinned ? -1 : 1;
        const lifecycleGroup = state => state.isExpired ? 2 : (state.isInGracePeriod ? 1 : 0);
        const lifecycleDifference = lifecycleGroup(aState) - lifecycleGroup(bState);
        if (lifecycleDifference !== 0) return lifecycleDifference;
        if (filters.sort === '마감임박순') {
            const leftDeadline = a.deadlineAt || a.deadline
                ? new Date(a.deadlineAt || `${String(a.deadline).slice(0, 10)}T00:00:00`).getTime()
                : Number.POSITIVE_INFINITY;
            const rightDeadline = b.deadlineAt || b.deadline
                ? new Date(b.deadlineAt || `${String(b.deadline).slice(0, 10)}T00:00:00`).getTime()
                : Number.POSITIVE_INFINITY;
            return leftDeadline - rightDeadline
                || new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
        }
        if (filters.sort === '조회순' || filters.sort === '조회수순') return b.views - a.views;
        if (filters.sort === '조회수낮은순') return a.views - b.views;
        return new Date(b.createdAt || b.sourcePublishedAt || 0).getTime()
            - new Date(a.createdAt || a.sourcePublishedAt || 0).getTime()
            || b.id - a.id;
    });
}

function extractSurveyReward(content) {
    const text = String(content || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    const rewardPattern = /(?:추첨|선착순|참여자|응답자|사례비|리워드|상품|경품|기프티콘|쿠폰)[^.!?\n]{0,80}(?:원|명|개|기프티콘|쿠폰|상품권|사례비|지급|증정|제공)/i;
    const match = text.match(rewardPattern);
    return match ? match[0].trim().slice(0, 120) : '';
}

async function addNoticeLifecycle(rows) {
    const categories = await automationStore.listCategories({ activeOnly: false });
    const categorySlugById = new Map(categories.map(category => [
        Number(category.id),
        category.slug
    ]));
    return rows.map(row => {
        const notice = toClientNotice(row);
        /* 저장값이 비었거나 예전 키('BENEFIT')인 공지도 읽을 때 넷 중 하나로
           채워 내보낸다. 백필 스크립트를 돌리기 전에도 모든 공지가 어느 탭엔가
           잡히고, 앱도 category를 항상 받는다. 이미 맞는 값은 그대로 둔다. */
        const resolvedCategory = ensureNoticeCategory(notice, categories);
        notice.category = resolvedCategory.category;
        notice.categoryIds = resolvedCategory.categoryIds;
        let lifecycle = {
            deadlineAt: notice.deadlineAt || notice.deadline || null,
            expiresAt: notice.expiresAt,
            isAlwaysOpen: notice.isAlwaysOpen
        };
        if (!notice.expiresAt && !notice.isAlwaysOpen) {
            const categorySlugs = notice.categoryIds
                .map(id => categorySlugById.get(Number(id)))
                .filter(Boolean);
            try {
                lifecycle = calculateNoticeLifecycle({
                    deadlineAt: notice.deadlineAt || notice.deadline || null,
                    isAlwaysOpen: notice.isAlwaysOpen,
                    categorySlugs,
                    createdAt: notice.createdAt || notice.sourcePublishedAt || new Date().toISOString()
                });
            } catch {
                lifecycle = {
                    deadlineAt: notice.deadlineAt || normalizeDeadline(notice.deadline),
                    expiresAt: null,
                    isAlwaysOpen: notice.isAlwaysOpen
                };
            }
        }
        const state = getNoticeLifecycleState(lifecycle);
        return {
            ...row,
            category: notice.category,
            categoryIds: notice.categoryIds,
            deadlineAt: lifecycle.deadlineAt,
            expiresAt: lifecycle.expiresAt,
            isAlwaysOpen: lifecycle.isAlwaysOpen,
            isArchived: state.isExpired,
            isInGracePeriod: state.isInGracePeriod
        };
    });
}

async function listNoticeFilterRows() {
    if (!useSupabase) return addNoticeLifecycle(await listNotices());

    const rows = [];
    const batchSize = 1000;
    for (let offset = 0; ; offset += batchSize) {
        const { data, error } = await supabase
            .from(SUPABASE_NOTICES_TABLE)
            .select(`
                id,title,content,target,targets,host,deadline,deadline_at,start_date,expires_at,is_always_open,is_pinned,pinned_until,is_hidden,
                category,has_reward,reward_note,requires_action,survey_reward,
                ai_summary,keywords,ocr_text,views,
                source_type,source_published_at,created_at,updated_at,last_crawled_at,has_images,notice_categories(category_id)
            `)
            .eq('is_deleted', false)
            .eq('status', 'published')
            .order('created_at', { ascending: false })
            .order('id', { ascending: false })
            .range(offset, offset + batchSize - 1);
        if (error) throw error;
        rows.push(...(data || []));
        if ((data || []).length < batchSize) break;
    }
    return addNoticeLifecycle(rows);
}

async function listNoticeSummaries({ page, limit, filters }) {
    const offset = (page - 1) * limit;
    const allRows = await listNoticeFilterRows();
    const matchingRows = applyNoticeListFilters(allRows, filters);
    const total = matchingRows.length;
    return {
        notices: matchingRows.slice(offset, offset + limit).map(toNoticeSummary),
        pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit)
        },
        facets: {
            hosts: Array.from(new Set(allRows
                .filter(row => !row?.isHidden && !row?.isArchived)
                .map(row => String(row?.host || '기타').trim())
                .filter(Boolean)))
                .sort((a, b) => a.localeCompare(b, 'ko'))
        }
    };
}

async function getPublishedNoticeById(id) {
    if (!useSupabase) {
        const manualNotices = await readNotices();
        const manualNotice = manualNotices.find(notice =>
            Number(notice.id) === id
            && !notice.isDeleted
            && (!notice.status || notice.status === 'published')
        );
        if (manualNotice) return toClientNotice(manualNotice);

        const automatedNotice = await automationStore.getAutomationNotice(id);
        if (!automatedNotice
            || automatedNotice.isDeleted
            || automatedNotice.status !== 'published') {
            return null;
        }
        return toClientNotice(automatedNotice);
    }

    const { data, error } = await supabase
        .from(SUPABASE_NOTICES_TABLE)
        .select('*, notice_categories(category_id)')
        .eq('id', id)
        .eq('is_deleted', false)
        .eq('status', 'published')
        .maybeSingle();

    if (error) throw error;
    return data ? toClientNotice(data) : null;
}

// 지울 공지의 사진 주소만 읽는다. 숨긴 공지도 지울 수 있으므로 status를 보지
// 않는다 — getPublishedNoticeById는 published만 돌려줘서 숨긴 공지의 파일이
// 공개 버킷에 그대로 남는다.
async function getNoticeImagesById(id) {
    if (!useSupabase) return [];

    const { data, error } = await supabase
        .from(SUPABASE_NOTICES_TABLE)
        .select('images')
        .eq('id', id)
        .maybeSingle();

    // 주소를 못 읽으면 파일은 남지만, 그것 때문에 공지 삭제까지 막지는 않는다.
    if (error) {
        console.warn('공지 이미지 주소 조회 실패:', error.message || error);
        return [];
    }
    return Array.isArray(data?.images) ? data.images : [];
}

async function loadPublishedNoticeThumbnailSource(id) {
    if (!useSupabase) {
        const notice = await getPublishedNoticeById(id);
        if (!notice) return null;
        return {
            id: notice.id,
            updatedAt: notice.updatedAt || notice.createdAt || '',
            image: notice.images[0] || ''
        };
    }

    const { data, error } = await supabase.rpc('get_notice_thumbnail_source', {
        target_notice_id: id
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return null;
    return {
        id: Number(row.id),
        updatedAt: row.updated_at || '',
        image: row.image || ''
    };
}

async function prepareNoticeStoragePayload(payload, { createdAt = new Date().toISOString() } = {}) {
    const categories = await automationStore.listCategories({ activeOnly: false });
    const categorySlugById = new Map(categories.map(category => [
        Number(category.id),
        category.slug
    ]));
    /* 저장되는 공지는 반드시 넷 중 하나를 단다. 관리자가 고른 키가 있으면
       그것, 없으면 고른 카테고리 id의 키, 그것도 없으면 제목·본문으로 정한다.
       categoryIds도 같은 곳을 가리키게 맞춘다 — 목록의 탭은 이것으로 거른다. */
    const resolved = ensureNoticeCategory({
        category: payload.category,
        categoryIds: Array.isArray(payload.categoryIds) ? payload.categoryIds : [],
        title: payload.title,
        content: payload.content,
        keywords: payload.keywords,
        host: payload.host
    }, categories);
    const categorySlugs = resolved.categoryIds
        .map(id => categorySlugById.get(Number(id)))
        .filter(Boolean);
    const lifecycle = calculateNoticeLifecycle({
        deadlineAt: payload.deadlineAt,
        isAlwaysOpen: payload.isAlwaysOpen,
        categorySlugs,
        createdAt
    });
    return {
        ...payload,
        category: resolved.category,
        categoryIds: resolved.categoryIds,
        deadline: lifecycle.deadlineAt ? lifecycle.deadlineAt.slice(0, 10) : '',
        deadlineAt: lifecycle.deadlineAt,
        expiresAt: lifecycle.expiresAt,
        isAlwaysOpen: lifecycle.isAlwaysOpen
    };
}

async function createNotice(payload) {
    const preparedPayload = await prepareNoticeStoragePayload(payload);
    if (!useSupabase) {
        return automationStore.createManualNotice(preparedPayload, { notify: true });
    }

    const { data, error } = await supabase.rpc('create_manual_notice', {
        notice_payload: {
            ...preparedPayload,
            deadline: normalizeDeadline(preparedPayload.deadline)
        },
        should_notify: true
    });

    if (error) {
        throw error;
    }

    return toClientNotice(Array.isArray(data) ? data[0] : data);
}

async function updateNotice(id, payload) {
    const existingNotice = await getPublishedNoticeById(id);
    if (!existingNotice) return null;
    const preparedPayload = await prepareNoticeStoragePayload(payload, {
        createdAt: existingNotice.createdAt || existingNotice.sourcePublishedAt || new Date().toISOString()
    });
    if (!useSupabase) {
        const notices = await readNotices();
        const idx = notices.findIndex(n => Number(n.id) === id);
        if (idx === -1) {
            return automationStore.updateManualNotice(id, preparedPayload);
        }

        const prev = notices[idx];
        const updated = {
            ...prev,
            ...preparedPayload,
            id: prev.id,
            views: Number(prev.views) || 0
        };
        notices[idx] = updated;
        await writeNotices(notices);
        return updated;
    }

    const { data, error } = await supabase
        .from(SUPABASE_NOTICES_TABLE)
        .update({
            title: preparedPayload.title,
            content: preparedPayload.content,
            target: preparedPayload.target,
            host: preparedPayload.host,
            deadline: normalizeDeadline(preparedPayload.deadline),
            deadline_at: preparedPayload.deadlineAt,
            start_date: preparedPayload.startDate || null,
            expires_at: preparedPayload.expiresAt,
            is_always_open: preparedPayload.isAlwaysOpen,
            is_pinned: preparedPayload.isPinned,
            is_hidden: preparedPayload.isHidden,
            category: preparedPayload.category,
            survey_reward: preparedPayload.surveyReward,
            ai_summary: preparedPayload.aiSummary,
            images: preparedPayload.images,
            updated_at: new Date().toISOString()
        })
        .eq('id', id)
        .eq('is_deleted', false)
        .select('*')
        .single();

    if (error && error.code !== 'PGRST116') {
        throw error;
    }

    if (data) {
        const { error: deleteCategoryError } = await supabase
            .from('notice_categories')
            .delete()
            .eq('notice_id', id);
        if (deleteCategoryError) throw deleteCategoryError;
        if (preparedPayload.categoryIds.length > 0) {
            const { error: insertCategoryError } = await supabase
                .from('notice_categories')
                .insert(preparedPayload.categoryIds.map(categoryId => ({
                    notice_id: id,
                    category_id: categoryId
                })));
            if (insertCategoryError) throw insertCategoryError;
        }
    }

    return data ? toClientNotice(data) : null;
}

async function softDeleteNotice(id) {
    if (!useSupabase) {
        const notices = await readNotices();
        const idx = notices.findIndex(n => Number(n.id) === id);
        if (idx === -1) {
            return automationStore.deleteManualNotice(id);
        }

        notices[idx] = {
            ...notices[idx],
            isDeleted: true,
            deletedAt: new Date().toISOString()
        };
        await writeNotices(notices);
        return true;
    }

    const { data, error } = await supabase
        .from(SUPABASE_NOTICES_TABLE)
        .update({
            is_deleted: true,
            deleted_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        })
        .eq('id', id)
        .eq('is_deleted', false)
        .select('id');

    if (error) {
        throw error;
    }

    return Array.isArray(data) && data.length > 0;
}

async function incrementViewCount(id) {
    if (!useSupabase) {
        const notices = await readNotices();
        const idx = notices.findIndex(n => Number(n.id) === id && !n.isDeleted);
        if (idx === -1) {
            return automationStore.incrementAutomationNoticeView(id);
        }

        notices[idx].views = (Number(notices[idx].views) || 0) + 1;
        await writeNotices(notices);
        return notices[idx];
    }

    const { data, error } = await supabase.rpc('increment_notice_views', {
        target_notice_id: id
    });

    if (error) {
        throw error;
    }

    if (!Array.isArray(data) || data.length === 0) {
        return null;
    }

    return toClientNotice(data[0]);
}

function isBannerExpiryActive(expiresAt, now = Date.now()) {
    const value = String(expiresAt || '').trim();
    if (!value) return true;

    const expiresAtMs = Date.parse(value);
    return Number.isFinite(expiresAtMs) && expiresAtMs > now;
}

async function setNoticeHidden(id, hidden) {
    if (!useSupabase) {
        const notices = await readNotices();
        const idx = notices.findIndex(notice => Number(notice.id) === id && !notice.isDeleted);
        if (idx >= 0) {
            notices[idx] = {
                ...notices[idx],
                isHidden: Boolean(hidden),
                updatedAt: new Date().toISOString()
            };
            await writeNotices(notices);
            return notices[idx];
        }
        return automationStore.setPublishedNoticeHidden(id, hidden);
    }

    const { data, error } = await supabase
        .from(SUPABASE_NOTICES_TABLE)
        .update({ is_hidden: Boolean(hidden), updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('is_deleted', false)
        .eq('status', 'published')
        .select('*, notice_categories(category_id)')
        .maybeSingle();
    if (error) throw error;
    return data ? toClientNotice(data) : null;
}

/* 고정을 걸고 푼다. setNoticeHidden과 같은 모양이다. 수동 공지는 notices.json에,
   자동 수집 공지는 automationStore에 있어서 파일 모드는 두 곳을 다 봐야 한다.

   푸는 쪽은 pinnedUntil만이 아니라 isPinned도 함께 끈다. 어느 경로로 고정됐든
   화면에는 똑같이 「고정」으로 보이므로, 해제를 눌렀는데 안 풀리면 버그로 읽힌다. */
async function setNoticePin(id, pinned, now = new Date()) {
    const pinnedUntil = pinned ? computePinnedUntil(await getNoticeForPin(id), now) : null;
    if (pinned && !pinnedUntil) return { error: 'DEADLINE_PASSED' };

    if (!useSupabase) {
        const notices = await readNotices();
        const idx = notices.findIndex(notice => Number(notice.id) === id && !notice.isDeleted);
        if (idx >= 0) {
            notices[idx] = {
                ...notices[idx],
                pinnedUntil,
                ...(pinned ? {} : { isPinned: false }),
                updatedAt: new Date().toISOString()
            };
            await writeNotices(notices);
            return { notice: notices[idx] };
        }
        const updated = await automationStore.setPublishedNoticePin(id, {
            pinnedUntil,
            isPinned: pinned ? null : false
        });
        return { notice: updated };
    }

    const changes = { pinned_until: pinnedUntil, updated_at: new Date().toISOString() };
    if (!pinned) changes.is_pinned = false;
    const { data, error } = await supabase
        .from(SUPABASE_NOTICES_TABLE)
        .update(changes)
        .eq('id', id)
        .eq('is_deleted', false)
        .eq('status', 'published')
        .select('*, notice_categories(category_id)')
        .maybeSingle();
    if (error) throw error;
    return { notice: data ? toClientNotice(data) : null };
}

/* 만료 시각을 계산하려면 마감 정보가 필요하다. 목록 전체를 훑지 않고 하나만 읽는다. */
async function getNoticeForPin(id) {
    if (!useSupabase) {
        const notices = await readNotices();
        const manual = notices.find(notice => Number(notice.id) === id && !notice.isDeleted);
        if (manual) return toClientNotice(manual);
        const automated = await automationStore.getAutomationNotice(id);
        return automated ? toClientNotice(automated) : {};
    }
    const { data, error } = await supabase
        .from(SUPABASE_NOTICES_TABLE)
        .select('id,deadline,deadline_at,is_always_open')
        .eq('id', id)
        .eq('is_deleted', false)
        .eq('status', 'published')
        .maybeSingle();
    if (error) throw error;
    return data ? toClientNotice(data) : {};
}

function isPromoSlotPublic(row, now = Date.now()) {
    const status = String(row?.status || 'approved').trim();
    if (status !== 'approved') return false;

    const startsAt = row?.starts_at || row?.startsAt;
    if (startsAt) {
        const startsAtMs = Date.parse(startsAt);
        if (!Number.isFinite(startsAtMs) || startsAtMs > now) return false;
    }

    return isBannerExpiryActive(row?.ends_at || row?.expires_at || row?.expiresAt, now);
}

async function listBannerSlides(now = Date.now(), { includeUnpublished = false } = {}) {
    if (!useSupabase || bannerStorageMode === 'file') {
        const rows = await readBannerFile();
        return rows
            .filter(row => !row?.isDeleted)
            .filter(row => includeUnpublished || isPromoSlotPublic(row, now))
            .sort((a, b) => {
                const orderDiff = (Number(a?.order) || 0) - (Number(b?.order) || 0);
                if (orderDiff !== 0) return orderDiff;
                return String(b?.createdAt || '').localeCompare(String(a?.createdAt || ''));
            })
            .map(toClientBannerSlide);
    }

    let query = supabase
        .from('promo_slots')
        .select('*')
        .eq('is_deleted', false)
        .order('order', { ascending: true })
        .order('created_at', { ascending: false });
    if (!includeUnpublished) {
        const nowIso = new Date(now).toISOString();
        query = query
            .eq('status', 'approved')
            .lte('starts_at', nowIso)
            .gt('ends_at', nowIso);
    }
    const { data, error } = await query;

    if (error) {
        if (isMissingBannerTableError(error)) {
            await switchBannerStorageToFile(error);
            return listBannerSlides(now, { includeUnpublished });
        }
        throw error;
    }

    return Array.isArray(data) ? data.map(toClientBannerSlide) : [];
}

async function createBannerSlide(payload) {
    if (payload.placement === 'right_rail' && payload.status === 'approved') {
        const activeRightRailCount = (await listBannerSlides(Date.now(), { includeUnpublished: true }))
            .filter(slide => slide.placement === 'right_rail' && slide.status === 'approved')
            .length;
        if (activeRightRailCount >= MAX_RIGHT_RAIL_BANNERS) {
            throw new RangeError(`승인된 학내 홍보는 최대 ${MAX_RIGHT_RAIL_BANNERS}개까지 등록할 수 있습니다.`);
        }
    }

    if (!useSupabase || bannerStorageMode === 'file') {
        const rows = await readBannerFile();
        const nextId = rows.reduce((max, row) => Math.max(max, Number(row?.id) || 0), 0) + 1;
        const sevenDaysLater = new Date();
        sevenDaysLater.setDate(sevenDaysLater.getDate() + 7);

        const row = {
            id: nextId,
            name: String(payload.name || '').trim(),
            text: String(payload.text || '').trim(),
            bgStyle: String(payload.bgStyle || '').trim(),
            textColor: String(payload.textColor || '').trim(),
            src: payload.src || null,
            mobileSrc: payload.mobileSrc || null,
            order: Number(payload.order) || 0,
            createdAt: new Date().toISOString(),
            expiresAt: payload.expiresAt || sevenDaysLater.toISOString(),
            placement: payload.placement || 'header',
            linkUrl: payload.linkUrl || '',
            altText: payload.altText || '',
            description: payload.description || '',
            type: payload.type,
            owner: payload.owner,
            status: payload.status,
            startsAt: payload.startsAt || new Date().toISOString(),
            isDeleted: false
        };

        rows.push(row);
        await writeBannerFile(rows);
        return toClientBannerSlide(row);
    }

    const sevenDaysLater = new Date();
    sevenDaysLater.setDate(sevenDaysLater.getDate() + 7);

    const { data, error } = await supabase
        .from('promo_slots')
        .insert({
            internal_name: String(payload.name || '').trim(),
            title: String(payload.text || '').trim(),
            bg_style: String(payload.bgStyle || '').trim(),
            text_color: String(payload.textColor || '').trim(),
            image_url: payload.src || null,
            mobile_image_url: payload.mobileSrc || null,
            order: Number(payload.order) || 0,
            ends_at: payload.expiresAt || sevenDaysLater.toISOString(),
            placement: 'right_rail',
            link_url: payload.linkUrl || '',
            alt_text: payload.altText || '',
            description: payload.description || '',
            type: payload.type,
            owner: payload.owner,
            status: payload.status,
            starts_at: payload.startsAt || new Date().toISOString(),
            is_deleted: false
        })
        .select('*')
        .single();

    if (error) {
        if (isMissingBannerTableError(error)) {
            await switchBannerStorageToFile(error);
            return createBannerSlide(payload);
        }
        throw error;
    }

    return toClientBannerSlide(data);
}

function buildBannerSlideUpdate(payload, expiresAtField) {
    const update = {
        name: String(payload.name || '').trim(),
        text: String(payload.text || '').trim(),
        bgStyle: String(payload.bgStyle || '').trim(),
        textColor: String(payload.textColor || '').trim(),
        src: payload.src || null,
        mobileSrc: payload.mobileSrc || null,
        order: Number(payload.order) || 0,
        placement: payload.placement || 'header',
        linkUrl: payload.linkUrl || '',
        altText: payload.altText || '',
        description: payload.description || '',
        type: payload.type || 'council',
        owner: String(payload.owner || '').trim(),
        status: payload.status || 'pending'
    };
    if (payload.startsAt) update.startsAt = payload.startsAt;
    if (payload.expiresAt) update[expiresAtField] = payload.expiresAt;
    return update;
}

async function updateBannerSlide(id, payload) {
    if (payload.status === 'approved') {
        const approvedCount = (await listBannerSlides(Date.now(), { includeUnpublished: true }))
            .filter(slide => Number(slide.id) !== id
                && slide.placement === 'right_rail'
                && slide.status === 'approved')
            .length;
        if (approvedCount >= MAX_RIGHT_RAIL_BANNERS) {
            throw new RangeError(`승인된 학내 홍보는 최대 ${MAX_RIGHT_RAIL_BANNERS}개까지 등록할 수 있습니다.`);
        }
    }

    if (!useSupabase || bannerStorageMode === 'file') {
        const rows = await readBannerFile();
        const idx = rows.findIndex(row => Number(row?.id) === id && !row?.isDeleted);
        if (idx === -1) return null;

        const update = buildBannerSlideUpdate(payload, 'expiresAt');
        rows[idx] = {
            ...rows[idx],
            ...update,
            bgStyle: update.bgStyle || rows[idx].bgStyle || ''
        };

        await writeBannerFile(rows);
        return toClientBannerSlide(rows[idx]);
    }

    const update = buildBannerSlideUpdate(payload, 'ends_at');

    const { data, error } = await supabase
        .from('promo_slots')
        .update({
            internal_name: update.name,
            title: update.text,
            bg_style: update.bgStyle,
            text_color: update.textColor,
            image_url: update.src,
            mobile_image_url: update.mobileSrc,
            order: update.order,
            placement: update.placement,
            link_url: update.linkUrl,
            alt_text: update.altText,
            description: update.description,
            type: update.type,
            owner: update.owner,
            status: update.status,
            ...(Object.hasOwn(update, 'startsAt') ? { starts_at: update.startsAt } : {}),
            ...(Object.hasOwn(update, 'ends_at') ? { ends_at: update.ends_at } : {})
        })
        .eq('id', id)
        .eq('is_deleted', false)
        .select('*')
        .single();

    if (error && error.code !== 'PGRST116') {
        if (isMissingBannerTableError(error)) {
            await switchBannerStorageToFile(error);
            return updateBannerSlide(id, payload);
        }
        throw error;
    }

    return data ? toClientBannerSlide(data) : null;
}

async function reorderBannerSlides(items) {
    if (!useSupabase || bannerStorageMode === 'file') {
        const rows = await readBannerFile();
        const normalized = Array.isArray(items)
            ? items
                .map(item => ({ id: Number(item?.id), order: Number(item?.order) }))
                .filter(item => Number.isFinite(item.id) && Number.isFinite(item.order))
            : [];

        if (normalized.length === 0) {
            return listBannerSlides();
        }

        const orderMap = new Map(normalized.map(item => [item.id, item.order]));
        const nextRows = rows.map(row => {
            const id = Number(row?.id);
            if (!orderMap.has(id)) return row;
            return { ...row, order: orderMap.get(id) };
        });

        await writeBannerFile(nextRows);
        return listBannerSlides();
    }

    const normalized = Array.isArray(items)
        ? items
            .map(item => ({ id: Number(item?.id), order: Number(item?.order) }))
            .filter(item => Number.isFinite(item.id) && Number.isFinite(item.order))
        : [];

    if (normalized.length === 0) {
        return [];
    }

    for (const item of normalized) {
        const { error } = await supabase
            .from('promo_slots')
            .update({ order: item.order })
            .eq('id', item.id)
            .eq('is_deleted', false);

        if (error) {
            if (isMissingBannerTableError(error)) {
                await switchBannerStorageToFile(error);
                return reorderBannerSlides(items);
            }
            throw error;
        }
    }

    return listBannerSlides();
}

async function softDeleteBannerSlide(id) {
    if (!useSupabase || bannerStorageMode === 'file') {
        const rows = await readBannerFile();
        const idx = rows.findIndex(row => Number(row?.id) === id && !row?.isDeleted);
        if (idx === -1) return false;
        rows[idx] = { ...rows[idx], isDeleted: true };
        await writeBannerFile(rows);
        return true;
    }

    const { data, error } = await supabase
        .from('promo_slots')
        .update({ is_deleted: true })
        .eq('id', id)
        .eq('is_deleted', false)
        .select('id');

    if (error) {
        if (isMissingBannerTableError(error)) {
            await switchBannerStorageToFile(error);
            return softDeleteBannerSlide(id);
        }
        throw error;
    }

    return Array.isArray(data) && data.length > 0;
}

async function cleanupExpiredBanners(now = Date.now()) {
    if (!useSupabase || bannerStorageMode === 'file') {
        const rows = await readBannerFile();
        const nextRows = rows.map(row => {
            if (row?.isDeleted) return row;
            if (isBannerExpiryActive(row?.expiresAt, now)) return row;
            return { ...row, isDeleted: true };
        });
        await writeBannerFile(nextRows);
        return;
    }

    try {
        const { error } = await supabase
            .from('promo_slots')
            .update({ is_deleted: true })
            .lt('ends_at', new Date().toISOString())
            .eq('is_deleted', false);

        if (error) {
            if (isMissingBannerTableError(error)) {
                await switchBannerStorageToFile(error);
                await cleanupExpiredBanners();
                return;
            }
            console.error('배너 자동 정리 오류:', error);
        } else {
            console.log('매료된 배너가 자동 정리되었습니다.');
        }
    } catch (error) {
        console.error('배너 자동 정리 중 오류 발생:', error);
    }
}

function toClientBannerSlide(row) {
    if (!row) return null;
    return {
        id: Number(row.id),
        name: row.internal_name || row.name || '',
        text: row.title || row.text || '',
        bgStyle: row.bg_style || row.bgStyle || '',
        textColor: row.text_color || row.textColor || '',
        src: row.image_url || row.src || null,
        mobileSrc: row.mobile_image_url || row.mobileSrc || null,
        order: Number(row.order) || 0,
        expiresAt: row.ends_at || row.expires_at || row.expiresAt || null,
        placement: row.placement || 'header',
        linkUrl: row.link_url || row.linkUrl || '',
        altText: row.alt_text || row.altText || '',
        description: row.description || '',
        type: row.type || 'council',
        owner: row.owner || 'SNU ECE 학생회',
        status: row.status || 'approved',
        startsAt: row.starts_at || row.startsAt || row.created_at || row.createdAt || null
    };
}

app.use(createAutomationRouter({
    store: automationStore,
    crawler: eceCrawler,
    analyzer: noticeAnalyzer,
    pushService,
    prepareNoticePublication: async (notice, edits) => {
        /* 관리자 화면은 category 키가 아니라 categoryIds만 보낸다. 검수에서
           탭을 바꿨는데 분석 때의 키가 남아 있으면 그쪽이 이기므로, ids가 오면
           옛 키는 비우고 ids로 다시 정한다. */
        const merged = {
            ...notice,
            ...edits,
            category: Object.hasOwn(edits, 'category')
                ? edits.category
                : (Array.isArray(edits.categoryIds) ? null : notice.category),
            categoryIds: Array.isArray(edits.categoryIds)
                ? edits.categoryIds
                : (notice.categoryIds || []),
            deadlineAt: Object.hasOwn(edits, 'deadlineAt')
                ? edits.deadlineAt
                : (Object.hasOwn(edits, 'deadline') ? edits.deadline : (notice.deadlineAt || notice.deadline)),
            isAlwaysOpen: Object.hasOwn(edits, 'isAlwaysOpen')
                ? edits.isAlwaysOpen
                : notice.isAlwaysOpen
        };
        const prepared = await prepareNoticeStoragePayload(merged, {
            createdAt: notice.createdAt || notice.sourcePublishedAt || new Date().toISOString()
        });
        return {
            ...edits,
            deadline: prepared.deadline,
            deadlineAt: prepared.deadlineAt,
            expiresAt: prepared.expiresAt,
            isAlwaysOpen: prepared.isAlwaysOpen,
            category: prepared.category,
            categoryIds: prepared.categoryIds
        };
    },
    onNoticePublished: async notice => {
        const result = await kakaoBotWebhookService.notifyPublishedNotice(notice);
        if (result.reason === 'webhook_error') {
            console.warn('카카오톡 봇 웹훅 전송 실패:', result.status || result.error);
        }
    },
    requireAdmin: requireNoticeAdmin,
    config: automationConfig,
    frontendOrigin: process.env.FRONTEND_ORIGIN || ''
}));

function pruneKakaoBackfillBatches(now = Date.now()) {
    for (const [id, batch] of kakaoBackfillBatches) {
        if (batch.expiresAt <= now) kakaoBackfillBatches.delete(id);
    }
    while (kakaoBackfillBatches.size > 20) {
        kakaoBackfillBatches.delete(kakaoBackfillBatches.keys().next().value);
    }
}

const kakaoBackfillRaw = express.raw({
    type: ['text/plain', 'application/octet-stream'],
    limit: '20mb'
});

app.post('/api/admin/backfill/kakao/preview', requireNoticeAdmin, kakaoBackfillRaw, (req, res) => {
    try {
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
            return res.status(400).json({ error: '카카오톡 내보내기 원본 파일을 선택해주세요.' });
        }
        pruneKakaoBackfillBatches();
        const parsed = buildKakaoBackfillDrafts(req.body);
        const batchId = crypto.randomUUID();
        kakaoBackfillBatches.set(batchId, {
            drafts: parsed.drafts,
            stats: parsed.stats,
            expiresAt: Date.now() + KAKAO_BACKFILL_BATCH_TTL_MS
        });
        res.status(201).json({
            batchId,
            stats: parsed.stats,
            drafts: parsed.drafts.map(draft => ({
                sourceExternalId: draft.sourceExternalId,
                sourcePublishedAt: draft.sourcePublishedAt,
                title: draft.title,
                contentPreview: draft.content.slice(0, 300),
                sender: draft.sender,
                host: draft.host,
                sourceGroup: draft.sourceGroup,
                categorySlug: draft.categorySlug,
                classificationStatus: draft.classificationStatus,
                imageAttachmentCount: draft.imageAttachmentCount,
                attachmentCount: draft.attachments.length,
                reminderCount: draft.reminderCount,
                deadlineExpressions: draft.deadlineExpressions
            }))
        });
    } catch (error) {
        if (error instanceof TypeError) {
            return res.status(400).json({ error: error.message });
        }
        res.status(500).json({ error: error.message || '카카오톡 백필 미리보기 실패' });
    }
});

app.post('/api/admin/backfill/kakao/import', requireNoticeAdmin, async (req, res) => {
    try {
        pruneKakaoBackfillBatches();
        const batchId = String(req.body?.batchId || '').trim();
        const batch = kakaoBackfillBatches.get(batchId);
        if (!batch) {
            return res.status(404).json({ error: '백필 미리보기가 만료되었습니다. 원본 파일을 다시 선택해주세요.' });
        }
        const editMap = new Map(
            (Array.isArray(req.body?.edits) ? req.body.edits : [])
                .map(edit => [String(edit?.sourceExternalId || ''), edit])
        );
        const categories = await automationStore.listCategories();
        const categoryIdBySlug = new Map(categories.map(category => [category.slug, Number(category.id)]));
        let createdCount = 0;
        let skippedCount = 0;
        let duplicateCount = 0;
        const failures = [];

        for (const draft of batch.drafts) {
            const edit = editMap.get(draft.sourceExternalId) || {};
            if (edit.include === false) {
                skippedCount += 1;
                continue;
            }
            const categorySlug = String(edit.categorySlug || draft.categorySlug || '').trim();
            const categoryId = categoryIdBySlug.get(categorySlug);
            if (!categoryId) {
                failures.push({
                    sourceExternalId: draft.sourceExternalId,
                    error: '카테고리를 선택해주세요.'
                });
                continue;
            }
            try {
                await automationStore.createPendingNotice({
                    sourceType: draft.sourceType,
                    sourceExternalId: draft.sourceExternalId,
                    sourcePublishedAt: draft.sourcePublishedAt,
                    lastCrawledAt: new Date().toISOString(),
                    title: String(edit.title || draft.title).trim().slice(0, 200),
                    content: draft.content,
                    rawTitle: draft.rawTitle,
                    rawContent: draft.rawContent,
                    target: draft.target,
                    targets: draft.targets,
                    host: String(edit.host || draft.host).trim().slice(0, 80),
                    sourceGroup: draft.sourceGroup,
                    threadKey: draft.threadKey,
                    deadline: null,
                    category: categories.find(category =>
                        Number(category.id) === Number(categoryId)
                    )?.key || null,
                    requiresAction: draft.requiresAction === true,
                    aiSummary: [],
                    keywords: draft.urls,
                    attachments: draft.attachments,
                    analysisStatus: 'backfill_draft',
                    analysisConfidence: null,
                    existingCategoryIds: [categoryId],
                    crawlMetadata: {
                        sender: draft.sender,
                        threadMessages: draft.threadMessages,
                        reminderCount: draft.reminderCount,
                        imageAttachmentCount: draft.imageAttachmentCount,
                        deadlineExpressions: draft.deadlineExpressions,
                        urls: draft.urls,
                        classification: {
                            source: 'rule',
                            categorySlug,
                            humanReviewedInBatch: true
                        }
                    }
                });
                createdCount += 1;
            } catch (error) {
                if (error?.code === 'DUPLICATE_SOURCE_NOTICE') {
                    duplicateCount += 1;
                } else {
                    failures.push({
                        sourceExternalId: draft.sourceExternalId,
                        error: error?.message || '저장 실패'
                    });
                }
            }
        }

        kakaoBackfillBatches.delete(batchId);
        res.json({
            createdCount,
            skippedCount,
            duplicateCount,
            failedCount: failures.length,
            failures
        });
    } catch (error) {
        res.status(500).json({ error: error.message || '카카오톡 백필 적재 실패' });
    }
});

app.post('/api/admin/review-notices/:id/ocr', requireNoticeAdmin, async (req, res) => {
    try {
        if (!ocrService) {
            return res.status(503).json({ error: 'OCR 서비스가 설정되지 않았습니다.' });
        }
        const id = Number(req.params.id);
        if (!Number.isSafeInteger(id) || id <= 0) {
            return res.status(400).json({ error: '유효하지 않은 공지 ID입니다.' });
        }
        const notice = await automationStore.getReviewNotice(id);
        if (!notice) {
            return res.status(404).json({ error: '검수 대기 공지를 찾지 못했습니다.' });
        }
        const visibleText = String(notice.rawContent || notice.content || '').trim();
        if (visibleText.length >= 15) {
            return res.status(409).json({
                error: 'OCR은 비용을 줄이기 위해 텍스트 본문이 없는 공지에만 실행합니다.'
            });
        }
        const ocrText = await ocrService.extractText(req.body?.images);
        const updated = await automationStore.updateReviewAnalysis(id, {
            ocrText,
            analysisStatus: notice.analysisStatus || 'backfill_draft'
        });
        res.json({
            notice: updated,
            ocr: { indexedCharacters: ocrText.length }
        });
    } catch (error) {
        const status = error instanceof TypeError
            ? 400
            : (Number(error?.status) === 429 ? 429 : 500);
        res.status(status).json({ error: error.message || 'OCR 처리 실패' });
    }
});

app.get('/api/health', (req, res) => {
    res.json({ ok: true, storage: useSupabase ? 'supabase' : 'file', bannerStorage: bannerStorageMode });
});

// 푸터의 "마지막 동기화" 표시용. 공개 목록에 실제로 보이는 공지만 세고,
// 시각은 크롤러가 남긴 lastCrawledAt을 우선 쓰되 없으면 갱신·생성 시각으로 떨어진다.
app.get('/api/sync-status', async (req, res) => {
    try {
        const rows = await listNoticeFilterRows();
        // 공개 목록의 기본 상태와 같은 필터를 태워, 푸터 건수와 목록 상단
        // "공지 N건"이 어긋나 보이지 않게 한다.
        const visible = applyNoticeListFilters(rows, normalizeNoticeListFilters({}));
        const latest = visible.reduce((newest, row) => {
            const stamp = row?.lastCrawledAt
                || row?.last_crawled_at
                || row?.updatedAt
                || row?.updated_at
                || row?.createdAt
                || row?.created_at
                || null;
            if (!stamp) return newest;
            const time = new Date(stamp).getTime();
            if (Number.isNaN(time)) return newest;
            return !newest || time > newest ? time : newest;
        }, null);

        res.json({
            lastSyncedAt: latest ? new Date(latest).toISOString() : null,
            noticeCount: visible.length
        });
    } catch (error) {
        res.status(500).json({ error: error.message || '동기화 상태 조회 실패' });
    }
});

app.get('/api/settings', async (req, res) => {
    try {
        const settings = await getSecuritySettings();
        res.json(toClientSettings(settings));
    } catch (error) {
        res.status(500).json({ error: error.message || '설정 조회 실패' });
    }
});

// ---------- 익명 피드백 ----------
// 신원(IP·이름·연락처)을 저장하지 않는다. 순수하게 메시지와 시각만 남긴다.
async function readFeedback() {
    try {
        const text = await fs.readFile(feedbackFilePath, 'utf-8');
        const parsed = JSON.parse(text);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

async function writeFeedback(items) {
    await fs.mkdir(path.dirname(feedbackFilePath), { recursive: true });
    await fs.writeFile(feedbackFilePath, JSON.stringify(items, null, 2), 'utf-8');
}

/* 첨부 사진.
   글로만 적으면 어느 화면의 무엇이 잘못됐는지 알기 어렵다. 화면을 찍어
   보내면 고치는 쪽에서 훨씬 빨리 알아본다. 사진은 JSON에 담지 않고 파일로
   따로 두는데, 문의 목록을 읽을 때마다 사진까지 통째로 읽으면 무거워지기
   때문이다. 배너 신청 이미지와 같은 자리에 같은 방식으로 쌓는다. */
const FEEDBACK_MAX_SHOTS = 3;
const FEEDBACK_SHOT_MAX_BYTES = 1_400_000;

function readFeedbackShots(input) {
    const list = Array.isArray(input) ? input.slice(0, FEEDBACK_MAX_SHOTS) : [];
    const buffers = [];
    for (const dataUrl of list) {
        const value = String(dataUrl || '');
        if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(value) || value.length > 1_900_000) {
            throw new TypeError('첨부한 사진을 다시 선택해주세요.');
        }
        const buffer = Buffer.from(value.slice(value.indexOf(',') + 1), 'base64');
        // JPEG는 늘 FF D8 FF로 시작한다. 확장자만 바꾼 파일을 걸러낸다.
        if (buffer.length === 0 || buffer.length > FEEDBACK_SHOT_MAX_BYTES
            || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) {
            throw new TypeError('첨부한 사진 형식을 확인해주세요.');
        }
        buffers.push(buffer);
    }
    return buffers;
}

app.post('/api/feedback', async (req, res) => {
    try {
        const message = String(req.body?.message || '').trim();
        const category = 'general';
        if (message.length < 5) {
            return res.status(400).json({ error: '피드백을 5자 이상 입력해주세요.' });
        }
        if (message.length > 2000) {
            return res.status(400).json({ error: '피드백은 2000자 이내로 입력해주세요.' });
        }

        let shots;
        try {
            shots = readFeedbackShots(req.body?.screenshots);
        } catch (error) {
            return res.status(400).json({ error: error.message });
        }

        const id = crypto.randomUUID();
        const screenshotFileNames = [];
        if (shots.length) {
            await fs.mkdir(bannerInquiryImageDir, { recursive: true });
            for (const [index, buffer] of shots.entries()) {
                const fileName = `${id}-shot${index}.jpg`;
                await fs.writeFile(path.join(bannerInquiryImageDir, fileName), buffer);
                screenshotFileNames.push(fileName);
            }
        }

        const items = await readFeedback();
        // 익명성 유지: 작성자를 특정할 수 있는 정보는 어떤 것도 저장하지 않는다.
        items.unshift({
            id,
            category,
            message,
            screenshotFileNames,
            createdAt: new Date().toISOString()
        });
        await writeFeedback(items.slice(0, 1000));
        res.status(201).json({ ok: true });
    } catch (error) {
        res.status(500).json({ error: error.message || '피드백 저장 실패' });
    }
});

app.post('/api/notices/:id/summary-report', feedbackLimiter, async (req, res) => {
    try {
        /* 다른 호출부와 달리 여기만 문자열을 그대로 넘겼다. 파일 모드의 수동
           공지는 Number(notice.id) === id로 찾으므로 문자열이면 절대 걸리지
           않고, 자동 수집 공지에서만 우연히 답이 나왔다. */
        const id = Number(req.params.id);
        if (!Number.isSafeInteger(id)) {
            return res.status(400).json({ error: '유효하지 않은 id입니다.' });
        }
        const notice = await getPublishedNoticeById(id);
        if (!notice) {
            return res.status(404).json({ error: '공지를 찾을 수 없습니다.' });
        }
        const items = await readFeedback();
        items.unshift({
            id: crypto.randomUUID(),
            category: 'summary_mismatch',
            noticeId: String(notice.id),
            noticeTitle: String(notice.title || '').slice(0, 160),
            message: 'AI 요약과 공지 원문이 다르다는 신고가 접수되었습니다.',
            createdAt: new Date().toISOString()
        });
        await writeFeedback(items.slice(0, 1000));
        res.status(201).json({ ok: true });
    } catch (error) {
        res.status(500).json({ error: error.message || '요약 신고 저장 실패' });
    }
});

const bannerInquiryJson = express.json({
    limit: '4mb',
    type: 'application/vnd.ece-banner+json'
});

function cleanBannerInquiryText(value, maxLength) {
    return String(value || '').trim().slice(0, maxLength);
}

app.post('/api/banner-inquiries', bannerInquiryJson, async (req, res) => {
    try {
        const inquiry = {
            name: cleanBannerInquiryText(req.body?.name, 40),
            organization: cleanBannerInquiryText(req.body?.organization, 80),
            type: cleanBannerInquiryText(req.body?.type, 20),
            phone: cleanBannerInquiryText(req.body?.phone, 30),
            email: cleanBannerInquiryText(req.body?.email, 120),
            title: cleanBannerInquiryText(req.body?.title, 80),
            description: cleanBannerInquiryText(req.body?.description, 600),
            linkUrl: cleanBannerInquiryText(req.body?.linkUrl, 500),
            startDate: cleanBannerInquiryText(req.body?.startDate, 10),
            endDate: cleanBannerInquiryText(req.body?.endDate, 10)
        };
        const desktopImageDataUrl = String(req.body?.desktopImageDataUrl || req.body?.imageDataUrl || '');
        const mobileImageDataUrl = String(req.body?.mobileImageDataUrl || '');

        if (inquiry.name.length < 2 || inquiry.organization.length < 2) {
            return res.status(400).json({ error: '실명과 소속/단체명을 확인해주세요.' });
        }
        if (!inquiry.phone && !inquiry.email) {
            return res.status(400).json({ error: '전화번호 또는 이메일 중 하나를 입력해주세요.' });
        }
        if (inquiry.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inquiry.email)) {
            return res.status(400).json({ error: '이메일 주소를 확인해주세요.' });
        }
        if (inquiry.title.length < 2 || inquiry.description.length < 10) {
            return res.status(400).json({ error: '홍보 제목과 설명을 확인해주세요.' });
        }
        if (!PROMO_TYPES.has(inquiry.type)) {
            return res.status(400).json({ error: '홍보 유형을 확인해주세요.' });
        }
        if (inquiry.linkUrl) {
            let parsedLink;
            try { parsedLink = new URL(inquiry.linkUrl); } catch { /* 아래에서 거절 */ }
            if (!parsedLink || !['http:', 'https:'].includes(parsedLink.protocol)) {
                return res.status(400).json({ error: '연결 링크는 올바른 웹 주소여야 합니다.' });
            }
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(inquiry.startDate)
            || !/^\d{4}-\d{2}-\d{2}$/.test(inquiry.endDate)
            || inquiry.endDate < inquiry.startDate) {
            return res.status(400).json({ error: '희망 게재 기간을 확인해주세요.' });
        }
        const exposureDays = Math.floor((
            Date.parse(`${inquiry.endDate}T00:00:00Z`)
            - Date.parse(`${inquiry.startDate}T00:00:00Z`)
        ) / 86_400_000) + 1;
        if (!Number.isFinite(exposureDays) || exposureDays > 14) {
            return res.status(400).json({
                error: '게재 기간은 시작일과 종료일을 포함해 최대 14일까지 신청할 수 있습니다.'
            });
        }
        if (req.body?.consent !== true) {
            return res.status(400).json({ error: '개인정보 수집 및 이용 동의가 필요합니다.' });
        }
        const submittedImages = [
            ['데스크탑', desktopImageDataUrl],
            ['모바일', mobileImageDataUrl]
        ];
        for (const [label, dataUrl] of submittedImages) {
            if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(dataUrl)
                || dataUrl.length > 1_900_000) {
                return res.status(400).json({ error: `${label} 홍보 이미지를 다시 선택해주세요.` });
            }
        }

        const id = crypto.randomUUID();
        const imageBuffers = submittedImages.map(([label, dataUrl]) => [
            label,
            Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
        ]);
        for (const [label, imageBuffer] of imageBuffers) {
            if (imageBuffer.length === 0 || imageBuffer.length > 1_400_000
                || imageBuffer[0] !== 0xff || imageBuffer[1] !== 0xd8 || imageBuffer[2] !== 0xff) {
                return res.status(400).json({ error: `${label} 홍보 이미지 형식을 확인해주세요.` });
            }
        }
        await fs.mkdir(bannerInquiryImageDir, { recursive: true });
        const desktopImageFileName = `${id}-desktop.jpg`;
        const mobileImageFileName = `${id}-mobile.jpg`;
        await Promise.all([
            fs.writeFile(path.join(bannerInquiryImageDir, desktopImageFileName), imageBuffers[0][1]),
            fs.writeFile(path.join(bannerInquiryImageDir, mobileImageFileName), imageBuffers[1][1])
        ]);

        const pendingSlide = await createBannerSlide(normalizeBannerPayload({
            name: `${inquiry.organization} · ${inquiry.title}`.slice(0, 50),
            text: inquiry.title,
            src: desktopImageDataUrl,
            mobileSrc: mobileImageDataUrl,
            placement: 'right_rail',
            linkUrl: inquiry.linkUrl,
            altText: `${inquiry.organization} ${inquiry.title}`,
            description: inquiry.description.slice(0, 240),
            type: inquiry.type,
            owner: inquiry.organization,
            status: 'pending',
            startsAt: `${inquiry.startDate}T00:00:00+09:00`,
            expiresAt: `${inquiry.endDate}T23:59:59+09:00`,
            order: 999
        }));

        const items = await readFeedback();
        items.unshift({
            id,
            category: 'banner',
            message: `${inquiry.title}\n${inquiry.description}`,
            inquiry,
            bannerSlideId: pendingSlide.id,
            desktopImageFileName,
            mobileImageFileName,
            createdAt: new Date().toISOString()
        });
        await writeFeedback(items.slice(0, 1000));
        res.status(201).json({ ok: true });
    } catch (error) {
        res.status(500).json({ error: error.message || '학내 홍보 신청 저장 실패' });
    }
});

app.get('/api/admin/feedback', requireAnyAdmin, async (req, res) => {
    try {
        const items = visibleFeedbackForRole(await readFeedback(), req.adminRole);
        res.json({
            role: req.adminRole,
            feedback: items.map(({ imageDataUrl, ...item }) => ({
                ...item,
                hasImage: Boolean(
                    item.desktopImageFileName
                    || item.mobileImageFileName
                    || item.imageFileName
                    || imageDataUrl
                ),
                hasDesktopImage: Boolean(item.desktopImageFileName || item.imageFileName || imageDataUrl),
                hasMobileImage: Boolean(item.mobileImageFileName),
                screenshotCount: Array.isArray(item.screenshotFileNames) ? item.screenshotFileNames.length : 0
            }))
        });
    } catch (error) {
        res.status(500).json({ error: error.message || '피드백 조회 실패' });
    }
});

app.get('/api/admin/feedback/:id/image', requireAnyAdmin, async (req, res) => {
    try {
        const items = visibleFeedbackForRole(await readFeedback(), req.adminRole);
        const item = items.find(candidate => String(candidate.id) === String(req.params.id));
        if (item?.imageDataUrl) {
            const legacyBuffer = Buffer.from(item.imageDataUrl.slice(item.imageDataUrl.indexOf(',') + 1), 'base64');
            return res.type('jpeg').send(legacyBuffer);
        }
        // 문의에 붙은 첨부 사진은 순번으로 고른다.
        const shotIndex = Number.parseInt(req.query?.shot, 10);
        const shots = Array.isArray(item?.screenshotFileNames) ? item.screenshotFileNames : [];
        const variant = req.query?.variant === 'mobile' ? 'mobile' : 'desktop';
        const imageFileName = Number.isInteger(shotIndex)
            ? shots[shotIndex]
            : (variant === 'mobile'
                ? item?.mobileImageFileName
                : (item?.desktopImageFileName || item?.imageFileName));
        if (!imageFileName || path.basename(imageFileName) !== imageFileName) {
            return res.status(404).json({ error: '배너 이미지를 찾을 수 없습니다.' });
        }
        const imagePath = path.join(bannerInquiryImageDir, imageFileName);
        try {
            await fs.access(imagePath);
        } catch {
            return res.status(404).json({ error: '배너 이미지를 찾을 수 없습니다.' });
        }
        res.type('jpeg').sendFile(path.resolve(imagePath));
    } catch (error) {
        res.status(500).json({ error: error.message || '배너 이미지 조회 실패' });
    }
});

app.delete('/api/admin/feedback/:id', requireAnyAdmin, async (req, res) => {
    try {
        const id = String(req.params.id || '');
        const items = await readFeedback();
        const removed = items.find(item => String(item.id) === id);
        // 자기 역할에 보이지 않는 문의는 지울 수도 없다.
        if (!removed || !visibleFeedbackForRole([removed], req.adminRole).length) {
            return res.status(404).json({ error: '문의를 찾을 수 없습니다.' });
        }
        const next = items.filter(item => String(item.id) !== id);
        await writeFeedback(next);
        const removableImages = [
            removed?.imageFileName,
            removed?.desktopImageFileName,
            removed?.mobileImageFileName,
            // 문의를 지우면 붙어 있던 화면 사진도 함께 지운다. 남겨 두면
            // 아무도 볼 수 없는 파일이 저장소에 계속 쌓인다.
            ...(Array.isArray(removed?.screenshotFileNames) ? removed.screenshotFileNames : [])
        ].filter(fileName => fileName && path.basename(fileName) === fileName);
        await Promise.all(removableImages.map(fileName =>
            fs.rm(path.join(bannerInquiryImageDir, fileName), { force: true }).catch(() => {})
        ));
        res.status(204).send();
    } catch (error) {
        res.status(500).json({ error: error.message || '피드백 삭제 실패' });
    }
});

/* 문의함을 노션에 붙여 넣을 수 있는 마크다운으로 내보낸다.
   ids를 주면 그 문의만, 주지 않으면 보이는 문의 전부를 담는다.
   노션은 표 붙여넣기를 잘 받으므로 목차 표 + 항목별 본문 구조로 만든다. */
function escapeMarkdownCell(value) {
    return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function feedbackKindLabel(category) {
    if (category === 'banner') return '홍보 신청';
    if (category === 'summary_mismatch') return '요약 오류';
    if (category === 'staff') return '운영진 제보';
    return '일반 문의';
}

function buildFeedbackMarkdown(items) {
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const lines = [
        '# SNU ECE 공지방 문의함',
        '',
        `> 내보낸 시각: ${stamp} · 총 ${items.length}건`,
        '',
        '| # | 종류 | 접수 시각 | 요약 |',
        '| --- | --- | --- | --- |'
    ];

    items.forEach((item, index) => {
        const when = item.createdAt ? String(item.createdAt).slice(0, 16).replace('T', ' ') : '-';
        const digest = escapeMarkdownCell(String(item.message || '').slice(0, 60));
        const kind = item.category === 'staff' ? feedbackKindLabelForStaff(item) : feedbackKindLabel(item.category);
        lines.push(`| ${index + 1} | ${kind} | ${when} | ${digest} |`);
    });

    lines.push('', '---', '');

    items.forEach((item, index) => {
        const when = item.createdAt ? String(item.createdAt).replace('T', ' ').slice(0, 19) : '-';
        lines.push(`## ${index + 1}. ${feedbackKindLabel(item.category)} — ${when}`, '');
        if (item.inquiry) {
            const inquiry = item.inquiry;
            lines.push('| 항목 | 내용 |', '| --- | --- |');
            lines.push(`| 신청자 | ${escapeMarkdownCell(inquiry.name)} |`);
            lines.push(`| 소속 | ${escapeMarkdownCell(inquiry.organization)} |`);
            lines.push(`| 연락처 | ${escapeMarkdownCell(inquiry.phone || inquiry.email)} |`);
            lines.push(`| 제목 | ${escapeMarkdownCell(inquiry.title)} |`);
            lines.push(`| 게재 희망 | ${escapeMarkdownCell(`${inquiry.startDate || '-'} ~ ${inquiry.endDate || '-'}`)} |`);
            if (inquiry.linkUrl) lines.push(`| 링크 | ${escapeMarkdownCell(inquiry.linkUrl)} |`);
            lines.push('');
        }
        if (item.noticeId) lines.push(`- 관련 공지 ID: \`${item.noticeId}\``, '');
        lines.push(String(item.message || '(내용 없음)').trim(), '');
    });

    return lines.join('\n');
}

app.post('/api/admin/feedback/export', requireAnyAdmin, async (req, res) => {
    try {
        const visible = visibleFeedbackForRole(await readFeedback(), req.adminRole);
        const requestedIds = Array.isArray(req.body?.ids)
            ? req.body.ids.map(String)
            : null;
        const selected = requestedIds?.length
            ? visible.filter(item => requestedIds.includes(String(item.id)))
            : visible;

        if (!selected.length) {
            return res.status(400).json({ error: '내보낼 문의가 없습니다.' });
        }

        res.json({
            filename: `snu-ece-문의함-${new Date().toISOString().slice(0, 10)}.md`,
            count: selected.length,
            markdown: buildFeedbackMarkdown(selected)
        });
    } catch (error) {
        res.status(500).json({ error: error.message || '문의 내보내기 실패' });
    }
});

/* 공지·배너 관리자가 마스터에게 남기는 내부 제보.
   문의함에 'staff' 종류로 쌓이고 마스터만 읽는다. */
app.post('/api/admin/staff-report', requireAnyAdmin, async (req, res) => {
    try {
        const message = String(req.body?.message || '').trim();
        const kind = ['bug', 'question', 'request'].includes(req.body?.kind)
            ? req.body.kind
            : 'question';
        if (message.length < 5) {
            return res.status(400).json({ error: '내용을 5자 이상 적어주세요.' });
        }

        const items = await readFeedback();
        items.unshift({
            id: `staff-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
            category: 'staff',
            staffRole: req.adminRole,
            staffKind: kind,
            message: message.slice(0, 2000),
            createdAt: new Date().toISOString()
        });
        await writeFeedback(items.slice(0, 1000));
        res.status(201).json({ ok: true });
    } catch (error) {
        res.status(500).json({ error: error.message || '제보 저장 실패' });
    }
});

app.post('/api/admin/verify', requireNoticeAdmin, (req, res) => {
    res.json({ ok: true });
});

app.post('/api/super-admin/verify', requireSuperAdmin, (req, res) => {
    res.json({ ok: true });
});

app.post('/api/banner/verify', async (req, res) => {
    try {
        const inputPassword = String(req.body?.password || '').trim();
        const settings = await getSecuritySettings();
        const ok = verifyCredential(inputPassword, roleCredentialHash(settings, 'banner'));
        if (!ok) {
            return res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });
        }

        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ error: error.message || '배너 인증 실패' });
    }
});

app.put('/api/settings', requireSuperAdmin, async (req, res) => {
    try {
        const current = await getSecuritySettings();
        const next = {
            ...current,
            adminInfo: normalizeAdminInfo(req.body?.adminInfo || current.adminInfo),
            bannerInfo: normalizeBannerInfo(req.body?.bannerInfo || current.bannerInfo)
        };

        const saved = await saveSecuritySettings(next);
        res.json(toClientSettings(saved));
    } catch (error) {
        res.status(500).json({ error: error.message || '관리자 정보 업데이트 실패' });
    }
});

app.put('/api/settings/passwords', requireSuperAdmin, async (req, res) => {
    try {
        const newNoticeAdminToken = String(req.body?.newNoticeAdminToken || req.body?.newAdminToken || '').trim();
        const newBannerPassword = String(req.body?.newBannerPassword || '').trim();
        const newMasterPassword = String(req.body?.newMasterPassword || '').trim();

        if (!newNoticeAdminToken && !newBannerPassword && !newMasterPassword) {
            return res.status(400).json({ error: '변경할 비밀번호가 없습니다.' });
        }

        const current = await getSecuritySettings();
        const next = {
            ...current,
            adminTokenHash: newNoticeAdminToken ? createCredentialHash(newNoticeAdminToken) : current.adminTokenHash,
            bannerTokenHash: newBannerPassword ? createCredentialHash(newBannerPassword) : current.bannerTokenHash,
            masterTokenHash: newMasterPassword ? createCredentialHash(newMasterPassword) : current.masterTokenHash
        };

        await saveSecuritySettings(next);
        res.json({
            ok: true,
            noticeAdminTokenChanged: Boolean(newNoticeAdminToken),
            bannerPasswordChanged: Boolean(newBannerPassword),
            masterPasswordChanged: Boolean(newMasterPassword)
        });
    } catch (error) {
        res.status(500).json({ error: error.message || '비밀번호 변경 실패' });
    }
});

app.get('/api/notices', async (req, res) => {
    try {
        const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
        const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
        const filters = normalizeNoticeListFilters(req.query);
        res.json(await listNoticeSummaries({ page, limit, filters }));
    } catch (error) {
        res.status(500).json({ error: error.message || '공지 조회 실패' });
    }
});

app.get('/api/admin/notices', requireNoticeAdmin, async (req, res) => {
    try {
        const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
        const rows = await addNoticeLifecycle(await listNotices());
        const offset = (page - 1) * limit;
        res.json({
            notices: rows.slice(offset, offset + limit).map(toNoticeSummary),
            pagination: {
                page,
                limit,
                total: rows.length,
                totalPages: Math.ceil(rows.length / limit)
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message || '관리자 공지 조회 실패' });
    }
});

app.get('/api/notices/deadlines/imminent', async (req, res) => {
    try {
        const days = Math.min(31, Math.max(0, Number.parseInt(req.query.days, 10) || 7));
        const rows = await listNoticeFilterRows();
        res.json(listImminentDeadlineNotices(rows, {
            days,
            publicBaseUrl: publicSiteUrl
        }));
    } catch (error) {
        res.status(500).json({ error: error.message || '마감 임박 공지 조회 실패' });
    }
});

app.use(createNoticeThumbnailRouter({
    loadSource: loadPublishedNoticeThumbnailSource,
    thumbnailService: noticeThumbnailService,
    defaultUrl: '/icons/default-notice-thumbnail.png'
}));

/* 크롤링한 공지의 첨부파일 내려받기.
   ECE 홈페이지는 첨부 주소에 Referer가 없거나 자기 사이트가 아니면 404를 준다.
   그래서 링크를 그대로 걸면 사용자 브라우저가 우리 도메인을 Referer로 보내
   전부 실패한다. 서버가 원문 페이지를 Referer로 붙여 대신 받아 넘긴다. */
const ATTACHMENT_ALLOWED_HOSTS = new Set(['ece.snu.ac.kr', 'www.ece.snu.ac.kr']);

app.get('/api/notices/:id/attachments/:index', async (req, res) => {
    try {
        const id = Number.parseInt(req.params.id, 10);
        const index = Number.parseInt(req.params.index, 10);
        if (!Number.isSafeInteger(id) || !Number.isSafeInteger(index) || index < 0) {
            return res.status(400).json({ error: '잘못된 첨부 요청입니다.' });
        }

        const notice = await getPublishedNoticeById(id);
        const attachment = notice?.attachments?.[index];
        if (!attachment?.url) {
            return res.status(404).json({ error: '첨부파일을 찾을 수 없습니다.' });
        }

        // 공지에 실제로 적힌 주소만 받는다. 임의의 주소를 대신 받아주지 않는다.
        let target;
        try {
            target = new URL(attachment.url);
        } catch {
            return res.status(400).json({ error: '첨부 주소가 올바르지 않습니다.' });
        }
        if (target.protocol !== 'https:' || !ATTACHMENT_ALLOWED_HOSTS.has(target.hostname)) {
            return res.status(400).json({ error: '허용되지 않은 첨부 주소입니다.' });
        }

        const upstream = await fetch(target.toString(), {
            headers: {
                Referer: notice.sourceUrl || `${target.origin}/community/academics`,
                'User-Agent': 'Mozilla/5.0 (compatible; SNU-ECE-Notice/1.0)'
            }
        });
        if (!upstream.ok) {
            return res.status(502).json({ error: `원문 서버에서 파일을 받지 못했습니다. (${upstream.status})` });
        }

        const fileName = String(attachment.name || 'attachment').replace(/[\r\n"]/g, '').slice(0, 120);
        res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
        res.setHeader(
            'Content-Disposition',
            `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`
        );
        res.setHeader('Cache-Control', 'private, max-age=300');
        const length = upstream.headers.get('content-length');
        if (length) res.setHeader('Content-Length', length);

        res.send(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
        res.status(500).json({ error: error.message || '첨부파일 전달 실패' });
    }
});

app.get('/api/notices/:id', async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isSafeInteger(id)) {
            return res.status(400).json({ error: '유효하지 않은 id입니다.' });
        }
        const notice = await getPublishedNoticeById(id);
        if (!notice) return res.status(404).json({ error: '공지 없음' });
        // 목록과 같은 규칙으로 채운다. 상세만 비어 오면 카드에는 있던 분류가 상세에서 사라진다.
        const resolvedCategory = ensureNoticeCategory(
            notice,
            await automationStore.listCategories({ activeOnly: false })
        );
        res.json({
            notice: {
                ...notice,
                category: resolvedCategory.category,
                categoryIds: resolvedCategory.categoryIds
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message || '공지 조회 실패' });
    }
});

app.post('/api/notices', requireNoticeAdmin, async (req, res) => {
    try {
        const payload = normalizeNoticeInput(req.body || {});

        if (!payload.title || !payload.content) {
            return res.status(400).json({ error: 'title과 content는 필수입니다.' });
        }

        // 사진은 DB가 아니라 버킷에 두고 주소만 저장한다.
        payload.images = await noticeImageStore.persistImages(payload.images);

        const newNotice = await createNotice(payload);
        const webhookResult = await kakaoBotWebhookService.notifyPublishedNotice(newNotice);
        if (webhookResult.reason === 'webhook_error') {
            console.warn('카카오톡 봇 웹훅 전송 실패:', webhookResult.status || webhookResult.error);
        }
        res.status(201).json({ notice: newNotice });
    } catch (error) {
        const status = error instanceof TypeError ? 400 : 500;
        res.status(status).json({ error: error.message || '공지 등록 실패' });
    }
});

app.put('/api/notices/:id', requireNoticeAdmin, async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) {
            return res.status(400).json({ error: '유효하지 않은 id입니다.' });
        }

        const payload = normalizeNoticeInput(req.body || {});
        if (!payload.title || !payload.content) {
            return res.status(400).json({ error: 'title과 content는 필수입니다.' });
        }

        payload.images = await noticeImageStore.persistImages(payload.images);

        const updated = await updateNotice(id, payload);
        if (!updated) {
            return res.status(404).json({ error: '공지 없음' });
        }

        res.json({ notice: updated });
    } catch (error) {
        const status = error instanceof TypeError ? 400 : 500;
        res.status(status).json({ error: error.message || '공지 수정 실패' });
    }
});

app.delete('/api/notices/:id', requireNoticeAdmin, async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) {
            return res.status(400).json({ error: '유효하지 않은 id입니다.' });
        }

        // 소프트 삭제라 행은 남지만 되살리는 경로가 없다. 공개 버킷에 파일만
        // 남으면 주소를 아는 사람은 계속 볼 수 있으므로 지운다.
        const doomedImages = await getNoticeImagesById(id);

        const deleted = await softDeleteNotice(id);
        if (!deleted) {
            return res.status(404).json({ error: '공지 없음' });
        }

        await noticeImageStore.removeImages(doomedImages);

        res.status(204).send();
    } catch (error) {
        res.status(500).json({ error: error.message || '공지 삭제 실패' });
    }
});

app.post('/api/notices/:id/view', async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) {
            return res.status(400).json({ error: '유효하지 않은 id입니다.' });
        }

        const notice = await incrementViewCount(id);
        if (!notice) {
            return res.status(404).json({ error: '공지 없음' });
        }

        res.json({ notice });
    } catch (error) {
        res.status(500).json({ error: error.message || '조회수 반영 실패' });
    }
});

app.post('/api/summary', requireNoticeAdmin, async (req, res) => {
    const { prompt } = req.body || {};

    if (!noticeAnalyzer) {
        return res.status(503).json({ error: 'GEMINI_API_KEY가 설정되지 않았습니다.' });
    }

    if (!prompt || typeof prompt !== 'string') {
        return res.status(400).json({ error: 'prompt가 비어 있습니다.' });
    }

    try {
        // analyzer가 이미 재시도·폴백 모델·페이싱을 담당한다.
        // 여기서 다시 fetch를 만들면 부하가 몰릴 때 폴백을 못 받아 그대로 실패한다.
        const text = await noticeAnalyzer.callGemini(prompt);
        res.json({ text });
    } catch (error) {
        if (typeof error?.code === 'string' && error.code.startsWith('GEMINI_')) {
            const status = Number(error.status) >= 400 && Number(error.status) < 600
                ? Number(error.status)
                : 503;
            const payload = { error: error.message || 'Gemini 호출 실패', code: error.code };
            if (Number(error.retryAfterSeconds) > 0) {
                payload.retryAfterSeconds = Number(error.retryAfterSeconds);
                res.set('Retry-After', String(Math.ceil(Number(error.retryAfterSeconds))));
            }
            return res.status(status).json(payload);
        }
        console.error(error);
        res.status(500).json({ error: error.message || '서버 오류' });
    }
});

app.get('/api/banner-slides', async (req, res) => {
    try {
        // 임시 배너는 아직 자리를 못 정한 대기 항목이라 공개 화면에 내보내지 않는다.
        const slides = (await listBannerSlides())
            .filter(slide => slide.placement !== 'staging');
        res.json({ slides });
    } catch (error) {
        res.status(500).json({ error: error.message || '배너 조회 실패' });
    }
});

app.patch('/api/notices/:id/visibility', requireNoticeAdmin, async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isSafeInteger(id)) {
            return res.status(400).json({ error: '유효하지 않은 id입니다.' });
        }
        const notice = await setNoticeHidden(id, req.body?.hidden === true);
        if (!notice) return res.status(404).json({ error: '공지 없음' });
        res.json({ notice: toNoticeSummary(notice) });
    } catch (error) {
        res.status(500).json({ error: error.message || '공지 공개 상태 변경 실패' });
    }
});

/* 카드 메뉴의 「공지 상단으로 보내기」. 만료 시각은 서버가 정한다.
   클라이언트가 기간을 보내오면 그 값을 검증할 규칙이 또 필요해진다. */
app.patch('/api/notices/:id/pin', requireNoticeAdmin, async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isSafeInteger(id)) {
            return res.status(400).json({ error: '유효하지 않은 id입니다.' });
        }
        if (typeof req.body?.pinned !== 'boolean') {
            return res.status(400).json({ error: 'pinned는 true 또는 false여야 합니다.' });
        }

        const result = await setNoticePin(id, req.body.pinned);
        if (result.error === 'DEADLINE_PASSED') {
            return res.status(400).json({
                error: '마감이 지난 공지는 고정할 수 없습니다. 목록에서 이미 아래로 내려가 있습니다.'
            });
        }
        if (!result.notice) return res.status(404).json({ error: '공지 없음' });
        res.json({ notice: toNoticeSummary(result.notice) });
    } catch (error) {
        res.status(500).json({ error: error.message || '공지 고정 변경 실패' });
    }
});

const REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/* 카드 메뉴의 「알림 주기」. 카카오톡 공지방에서 마감 임박 공지를 다시 올리던
   운영 습관을 웹 푸시로 옮긴 것이다.

   같은 공지에 여러 번 보낼 수 있어야 하므로 notification_jobs의 통짜 유니크
   제약을 부분 인덱스로 바꿨다. 대신 남발을 두 겹으로 막는다. 24시간 쿨다운과,
   아직 처리되지 않은 리마인드가 남아 있으면 새로 쌓지 않는 검사다. */
app.post('/api/notices/:id/reminder', requireNoticeAdmin, async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isSafeInteger(id)) {
            return res.status(400).json({ error: '유효하지 않은 id입니다.' });
        }
        if (!automationConfig.push.enabled) {
            return res.status(503).json({ error: '웹 푸시가 설정되지 않아 알림을 보낼 수 없습니다.' });
        }

        const notice = await getPublishedNoticeById(id);
        if (!notice || notice.isHidden) {
            return res.status(404).json({ error: '게시 중인 공지가 아닙니다.' });
        }

        const previous = await automationStore.listNotificationJobsForNotice(id, 'reminder');
        if (previous.some(job => job.status === 'pending' || job.status === 'processing')) {
            return res.status(409).json({
                error: '아직 보내는 중인 리마인드가 있습니다. 처리가 끝난 뒤에 다시 시도해주세요.',
                retryAfterHours: 0
            });
        }
        const last = previous[0];
        const sinceLast = last?.createdAt ? Date.now() - new Date(last.createdAt).getTime() : null;
        if (sinceLast !== null && sinceLast < REMINDER_COOLDOWN_MS) {
            const retryAfterHours = Math.ceil((REMINDER_COOLDOWN_MS - sinceLast) / 3_600_000);
            return res.status(409).json({
                error: `최근에 이미 알림을 보냈습니다. ${retryAfterHours}시간 뒤에 다시 보낼 수 있습니다.`,
                retryAfterHours
            });
        }

        const job = await automationStore.createNotificationJob({ noticeId: id, kind: 'reminder' });
        if (!job) return res.status(500).json({ error: '알림 작업을 만들지 못했습니다.' });

        const subscriptions = await automationStore.listPushSubscriptions();
        const recipients = subscriptions.filter(subscription =>
            subscription.status === 'active' && matchesSubscription(notice, subscription)
        ).length;

        await automationStore.recordAuditLog({
            action: 'notice.reminder_sent',
            entityType: 'notice',
            entityId: String(id),
            metadata: { jobId: job.id, recipients }
        });

        res.status(201).json({ job: { id: job.id, kind: job.kind }, recipients });
    } catch (error) {
        res.status(500).json({ error: error.message || '리마인드 발송 실패' });
    }
});

app.get('/api/banner-slides/manage', requireBannerAdmin, async (req, res) => {
    try {
        const slides = await listBannerSlides(Date.now(), { includeUnpublished: true });
        res.json({ slides });
    } catch (error) {
        res.status(500).json({ error: error.message || '학내 홍보 관리 목록 조회 실패' });
    }
});

app.post('/api/banner-slides', requireBannerAdmin, async (req, res) => {
    try {
        const payload = normalizeBannerPayload(req.body);

        const newSlide = await createBannerSlide(payload);
        res.status(201).json({ slide: newSlide });
    } catch (error) {
        if (error instanceof TypeError) {
            return res.status(400).json({ error: error.message });
        }
        if (error instanceof RangeError) {
            return res.status(409).json({ error: error.message });
        }
        res.status(500).json({ error: error.message || '배너 등록 실패' });
    }
});

app.put('/api/banner-slides/reorder', requireBannerAdmin, async (req, res) => {
    try {
        const items = Array.isArray(req.body?.items) ? req.body.items : [];
        if (items.length === 0) {
            return res.status(400).json({ error: '순서 변경 항목이 없습니다.' });
        }

        const slides = await reorderBannerSlides(items);
        res.json({ slides });
    } catch (error) {
        res.status(500).json({ error: error.message || '배너 순서 변경 실패' });
    }
});

app.put('/api/banner-slides/:id', requireBannerAdmin, async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) {
            return res.status(400).json({ error: '유효하지 않은 id입니다.' });
        }

        const payload = normalizeBannerPayload(req.body);

        const updated = await updateBannerSlide(id, payload);
        if (!updated) {
            return res.status(404).json({ error: '배너 없음' });
        }

        res.json({ slide: updated });
    } catch (error) {
        if (error instanceof TypeError) {
            return res.status(400).json({ error: error.message });
        }
        if (error instanceof RangeError) {
            return res.status(409).json({ error: error.message });
        }
        res.status(500).json({ error: error.message || '배너 수정 실패' });
    }
});

/* 임시 배너를 실제 노출 자리로 올린다.
   승인만으로는 공개되지 않고, 다섯 자리 중 어디를 바꿀지 관리자가 고른 뒤에야
   레일에 오른다. 자리를 비워 두고 싶으면 targetId 없이 빈 자리를 고르면 된다.
   바뀌어 내려가는 배너는 지우지 않고 임시 자리로 물러나 되돌릴 수 있게 둔다. */
app.post('/api/banner-slides/:id/promote', requireBannerAdmin, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const targetOrder = Number(req.body?.order);
        if (!Number.isFinite(id)) {
            return res.status(400).json({ error: '유효하지 않은 id입니다.' });
        }
        if (!Number.isInteger(targetOrder) || targetOrder < 0 || targetOrder >= MAX_RIGHT_RAIL_BANNERS) {
            return res.status(400).json({
                error: `바꿀 자리는 1번부터 ${MAX_RIGHT_RAIL_BANNERS}번 사이여야 합니다.`
            });
        }

        const all = await listBannerSlides(Date.now(), { includeUnpublished: true });
        const staged = all.find(slide => Number(slide.id) === id);
        if (!staged) {
            return res.status(404).json({ error: '임시 배너를 찾을 수 없습니다.' });
        }
        if (staged.placement !== 'staging') {
            return res.status(400).json({ error: '임시 배너만 자리에 올릴 수 있습니다.' });
        }
        if (!staged.src || !staged.mobileSrc) {
            return res.status(400).json({
                error: '데스크탑과 모바일 이미지가 모두 있어야 자리에 올릴 수 있습니다.'
            });
        }

        // 그 자리에 있던 배너는 임시 자리로 물러난다. 실수로 바꿔도 되돌릴 수 있다.
        const replaced = all.find(slide =>
            slide.placement === 'right_rail'
            && slide.status === 'approved'
            && Number(slide.order) === targetOrder);
        if (replaced) {
            await updateBannerSlide(Number(replaced.id), {
                ...replaced,
                placement: 'staging',
                status: 'approved',
                order: 0
            });
        }

        const promoted = await updateBannerSlide(id, {
            ...staged,
            placement: 'right_rail',
            status: 'approved',
            order: targetOrder
        });

        res.json({
            ok: true,
            slide: promoted,
            replacedId: replaced ? Number(replaced.id) : null
        });
    } catch (error) {
        res.status(500).json({ error: error.message || '임시 배너 반영 실패' });
    }
});

app.delete('/api/banner-slides/:id', requireBannerAdmin, async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) {
            return res.status(400).json({ error: '유효하지 않은 id입니다.' });
        }

        const deleted = await softDeleteBannerSlide(id);
        if (!deleted) {
            return res.status(404).json({ error: '배너 없음' });
        }

        res.status(204).send();
    } catch (error) {
        res.status(500).json({ error: error.message || '배너 삭제 실패' });
    }
});

/* 테스트가 로그인 제한을 되돌릴 수 있게 열어 둔다. 같은 IP를 여러 테스트가
   공유하므로, 실패 기록이나 요청 수 제한이 남아 있으면 뒤따르는 테스트가
   로그인하지 못한다. 둘 다 여기서 함께 비운다. */
function resetAdminLoginAttempts() {
    adminLoginAttempts.clear();
    authenticationLimiter.resetKey?.('::ffff:127.0.0.1');
    authenticationLimiter.resetKey?.('127.0.0.1');
    authenticationLimiter.store?.resetAll?.();
}

export {
    applyNoticeListFilters,
    app,
    resetAdminLoginAttempts,
    buildBannerSlideUpdate,
    cleanupExpiredBanners,
    createBannerSlide,
    ensureFileStorageSeed,
    isBannerExpiryActive,
    listBannerSlides,
    listImminentDeadlineNotices,
    legacySecuritySettingsRow,
    securitySettingsFromRow,
    securitySettingsToRow,
    normalizeNoticeListFilters,
    normalizeBannerPayload,
    toNoticeSummary,
    toClientBannerSlide
};

const isDirectRun = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
ensureDefaultData()
    .then(() => {
        initializeBannerCleanupCron();
        initializeNotificationWorker();
        app.listen(PORT, () => {
            console.log(`Server running on http://localhost:${PORT} (storage: ${useSupabase ? 'supabase' : 'file'})`);
        });
    })
    .catch(error => {
        console.error('초기화 실패:', error);
        process.exit(1);
    });
}
