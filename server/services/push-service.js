import crypto from 'node:crypto';

function serviceError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function hashToken(token) {
    return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function tokensMatch(token, expectedHash) {
    const actual = Buffer.from(hashToken(token));
    const expected = Buffer.from(String(expectedHash || ''));
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function normalizeCategoryIds(values) {
    return Array.from(new Set(
        (Array.isArray(values) ? values : [])
            .map(Number)
            .filter(value => Number.isSafeInteger(value) && value > 0)
    ));
}

const DEADLINE_REMINDER_DAYS = [1, 3, 7];
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function normalizePreferences(preferences = {}) {
    const admissionYear = String(preferences.admissionYear || '').trim();
    const reminder = preferences.deadlineReminderDays;
    return {
        admissionYear: /^\d{2}학번$/.test(admissionYear) ? admissionYear : null,
        allNotices: Boolean(preferences.allNotices),
        categoryIds: normalizeCategoryIds(preferences.categoryIds),
        urgentEnabled: preferences.urgentEnabled !== false,
        deadlineReminderDays: DEADLINE_REMINDER_DAYS.includes(Number(reminder))
            ? Number(reminder)
            : null
    };
}

// 마감까지 남은 일수를 한국 시간 달력 날짜 기준으로 센다. 마감이 없거나 상시 모집이면 null.
function deadlineDDayInSeoul(notice, now = new Date()) {
    if (!notice || notice.isAlwaysOpen) return null;
    const deadlineTime = Date.parse(notice.deadlineAt || notice.deadline || '');
    const nowTime = now instanceof Date ? now.getTime() : Date.parse(now);
    if (!Number.isFinite(deadlineTime) || !Number.isFinite(nowTime)) return null;
    return Math.floor((deadlineTime + KST_OFFSET_MS) / DAY_MS)
        - Math.floor((nowTime + KST_OFFSET_MS) / DAY_MS);
}

function validateBrowserSubscription(subscription) {
    let endpoint;
    try {
        endpoint = new URL(String(subscription?.endpoint || ''));
    } catch {
        throw serviceError('INVALID_PUSH_SUBSCRIPTION', '유효하지 않은 푸시 구독 주소입니다.');
    }
    const p256dh = String(subscription?.keys?.p256dh || '').trim();
    const auth = String(subscription?.keys?.auth || '').trim();
    if (endpoint.protocol !== 'https:' || !p256dh || !auth) {
        throw serviceError('INVALID_PUSH_SUBSCRIPTION', '유효하지 않은 푸시 구독 정보입니다.');
    }
    return { endpoint: endpoint.toString(), p256dh, auth };
}

function publicSubscription(row) {
    const {
        managementTokenHash: _managementTokenHash,
        p256dh: _p256dh,
        auth: _auth,
        ...safe
    } = row;
    return safe;
}

export function matchesSubscription(notice, subscription, now = new Date()) {
    if (subscription?.status && subscription.status !== 'active') return false;
    const noticeTargets = Array.isArray(notice?.targets) ? notice.targets : [];
    const audienceMatches = noticeTargets.includes('전체')
        || !subscription?.admissionYear
        || noticeTargets.includes(subscription.admissionYear);
    if (!audienceMatches) return false;
    if (subscription?.allNotices) return true;
    if (subscription?.urgentEnabled) {
        // '마감 임박 공지 포함': 마감이 3일 이내면 카테고리 필터를 건너뛴다(학번 필터는 유지).
        const dDay = deadlineDDayInSeoul(notice, now);
        if (dDay !== null && dDay >= 0 && dDay <= 3) return true;
    }
    const noticeCategories = normalizeCategoryIds(notice?.categoryIds);
    const subscribedCategories = normalizeCategoryIds(subscription?.categoryIds);
    return noticeCategories.some(id => subscribedCategories.includes(id));
}

export function createPushService({ store, webPushClient, config, now = () => new Date() }) {
    if (!store || !webPushClient || !config) {
        throw new Error('Push service dependencies are required');
    }
    if (config.enabled) {
        webPushClient.setVapidDetails(
            config.subject,
            config.publicKey,
            config.privateKey
        );
    }

    async function authenticatedSubscription(id, managementToken) {
        const subscription = await store.getPushSubscription(id);
        if (!subscription || !tokensMatch(managementToken, subscription.managementTokenHash)) {
            throw serviceError(
                'INVALID_SUBSCRIPTION_TOKEN',
                '알림 구독 관리 토큰이 올바르지 않습니다.'
            );
        }
        return subscription;
    }

    async function processJob(job) {
        const notice = job.noticeSnapshot || await store.getAutomationNotice(job.noticeId);
        if (!notice || notice.status !== 'published') {
            await store.updateNotificationJob(job.id, {
                status: 'completed',
                completedAt: now().toISOString(),
                claimedAt: null,
                claimToken: null
            }, job.claimToken);
            return { sent: 0, failed: 0 };
        }
        const timestamp = now();
        const isDeadlineReminder = job.kind === 'deadline_reminder';
        const reminderDays = isDeadlineReminder ? Number(job.reminderDays) : null;
        const subscriptions = (await store.listPushSubscriptions())
            .filter(subscription =>
                subscription.status === 'active'
                && matchesSubscription(notice, subscription, timestamp)
                && (!isDeadlineReminder || subscription.deadlineReminderDays === reminderDays)
            );
        await store.ensureNotificationDeliveries(
            job.id,
            subscriptions.map(subscription => subscription.id)
        );
        const subscriptionById = new Map(
            subscriptions.map(subscription => [String(subscription.id), subscription])
        );
        const deliveries = await store.listNotificationDeliveries(job.id);
        let sent = 0;
        let failed = 0;

        for (const delivery of deliveries) {
            if (delivery.status === 'sent' || delivery.status === 'permanent_failure') continue;
            if (delivery.nextAttemptAt && new Date(delivery.nextAttemptAt) > timestamp) continue;
            const renewed = await store.renewNotificationJobClaim(job.id, job.claimToken);
            if (!renewed) throw new Error('notification job claim lost');
            const subscription = subscriptionById.get(String(delivery.subscriptionId));
            if (!subscription) {
                await store.updateNotificationDelivery(delivery.id, {
                    status: 'permanent_failure',
                    lastError: 'subscription unavailable',
                    nextAttemptAt: null
                });
                failed += 1;
                continue;
            }
            try {
                await webPushClient.sendNotification({
                    endpoint: subscription.endpoint,
                    keys: {
                        p256dh: subscription.p256dh,
                        auth: subscription.auth
                    }
                }, JSON.stringify({
                    title: isDeadlineReminder
                        ? `[마감 D-${reminderDays}] ${notice.title}`
                        : notice.title,
                    body: (notice.aiSummary?.[0] || notice.content || '').slice(0, 180),
                    url: `/?id=${encodeURIComponent(notice.id)}`,
                    tag: isDeadlineReminder
                        ? `notice-${notice.id}-d${reminderDays}`
                        : `notice-${notice.id}`
                }), { TTL: 300, timeout: 30_000 });
                await store.updateNotificationDelivery(delivery.id, {
                    status: 'sent',
                    attempts: Number(delivery.attempts || 0) + 1,
                    sentAt: timestamp.toISOString(),
                    nextAttemptAt: null,
                    lastError: null
                });
                sent += 1;
            } catch (error) {
                const statusCode = Number(error?.statusCode || error?.status);
                const attempts = Number(delivery.attempts || 0) + 1;
                // 401/403은 VAPID 키 불일치처럼 재시도로 살아나지 않으므로 404/410과 같게 처리한다.
                if ([401, 403, 404, 410].includes(statusCode)) {
                    await store.deactivatePushSubscription(subscription.id);
                    await store.updateNotificationDelivery(delivery.id, {
                        status: 'permanent_failure',
                        attempts,
                        nextAttemptAt: null,
                        lastError: `push endpoint unusable (${statusCode})`
                    });
                } else {
                    const retryMinutes = [1, 5, 30][attempts - 1];
                    await store.updateNotificationDelivery(delivery.id, {
                        status: retryMinutes ? 'retry' : 'permanent_failure',
                        attempts,
                        nextAttemptAt: retryMinutes
                            ? new Date(timestamp.getTime() + retryMinutes * 60_000).toISOString()
                            : null,
                        lastError: String(error?.message || 'push delivery failed').slice(0, 500)
                    });
                }
                failed += 1;
            }
        }

        const updatedDeliveries = await store.listNotificationDeliveries(job.id);
        const terminal = updatedDeliveries.every(delivery =>
            delivery.status === 'sent' || delivery.status === 'permanent_failure'
        );
        if (terminal) {
            await store.updateNotificationJob(job.id, {
                status: 'completed',
                completedAt: now().toISOString(),
                claimedAt: null,
                claimToken: null
            }, job.claimToken);
        } else {
            await store.updateNotificationJob(job.id, {
                status: 'pending',
                completedAt: null,
                claimedAt: null,
                claimToken: null
            }, job.claimToken);
        }
        return { sent, failed };
    }

    return {
        publicKey: config.enabled ? config.publicKey : null,

        async createSubscription(browserSubscription, preferences = {}) {
            if (!config.enabled) {
                throw serviceError('PUSH_DISABLED', '웹 푸시가 설정되지 않았습니다.');
            }
            const keys = validateBrowserSubscription(browserSubscription);
            const managementToken = crypto.randomBytes(32).toString('base64url');
            const saved = await store.createPushSubscription({
                ...keys,
                ...normalizePreferences(preferences),
                managementTokenHash: hashToken(managementToken),
                status: 'active',
                createdAt: now().toISOString(),
                updatedAt: now().toISOString()
            });
            return {
                subscription: publicSubscription(saved),
                managementToken
            };
        },

        async updateSubscription(id, managementToken, preferences = {}) {
            await authenticatedSubscription(id, managementToken);
            const updated = await store.updatePushSubscription(
                id,
                normalizePreferences(preferences)
            );
            return publicSubscription(updated);
        },

        async deleteSubscription(id, managementToken) {
            await authenticatedSubscription(id, managementToken);
            await store.deletePushSubscription(id);
        },

        // 마감 1/3/7일 전 리마인더 잡을 만든다. dedupeKey 덕분에 여러 번 불러도 안전하다.
        async enqueueDeadlineReminders({ notices = [], now: timestamp = now() } = {}) {
            if (!config.enabled) return { created: 0 };
            const subscriptions = (await store.listPushSubscriptions())
                .filter(subscription => subscription.status === 'active');
            let created = 0;
            for (const notice of notices) {
                if (!notice || notice.status !== 'published') continue;
                const dDay = deadlineDDayInSeoul(notice, timestamp);
                if (dDay === null || !DEADLINE_REMINDER_DAYS.includes(dDay)) continue;
                const hasRecipient = subscriptions.some(subscription =>
                    subscription.deadlineReminderDays === dDay
                    && matchesSubscription(notice, subscription, timestamp)
                );
                if (!hasRecipient) continue;
                const job = await store.createNotificationJobIfAbsent({
                    kind: 'deadline_reminder',
                    reminderDays: dDay,
                    noticeId: notice.id,
                    dedupeKey: `reminder-${notice.id}-${dDay}`
                });
                if (job) created += 1;
            }
            return { created };
        },

        async processPendingJobs({ batchSize = 50 } = {}) {
            if (!config.enabled) return { jobs: 0, sent: 0, failed: 0 };
            const jobs = await store.listPendingNotificationJobs(batchSize);
            const summary = { jobs: 0, sent: 0, failed: 0 };
            for (const job of jobs) {
                const claimed = await store.claimNotificationJob(job.id);
                if (!claimed) continue;
                summary.jobs += 1;
                try {
                    const result = await processJob(claimed);
                    summary.sent += result.sent;
                    summary.failed += result.failed;
                } catch (error) {
                    await store.updateNotificationJob(job.id, {
                        status: 'pending',
                        completedAt: null,
                        claimedAt: null,
                        claimToken: null
                    }, claimed.claimToken);
                    throw error;
                }
            }
            return summary;
        }
    };
}
