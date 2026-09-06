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

function normalizePreferences(preferences = {}) {
    const admissionYear = String(preferences.admissionYear || '').trim();
    const reminder = preferences.deadlineReminderDays;
    return {
        admissionYear: /^\d{2}학번$/.test(admissionYear) ? admissionYear : null,
        allNotices: Boolean(preferences.allNotices),
        categoryIds: normalizeCategoryIds(preferences.categoryIds),
        urgentEnabled: preferences.urgentEnabled !== false,
        deadlineReminderDays: [1, 3, 7].includes(Number(reminder))
            ? Number(reminder)
            : null
    };
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

export function matchesSubscription(notice, subscription) {
    if (subscription?.status && subscription.status !== 'active') return false;
    const noticeTargets = Array.isArray(notice?.targets) ? notice.targets : [];
    const audienceMatches = noticeTargets.includes('전체')
        || !subscription?.admissionYear
        || noticeTargets.includes(subscription.admissionYear);
    if (!audienceMatches) return false;
    if (subscription?.allNotices) return true;
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
        const isReminder = job.kind === 'reminder';
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
        const subscriptions = (await store.listPushSubscriptions())
            .filter(subscription =>
                subscription.status === 'active'
                && matchesSubscription(notice, subscription)
            );
        await store.ensureNotificationDeliveries(
            job.id,
            subscriptions.map(subscription => subscription.id)
        );
        const subscriptionById = new Map(
            subscriptions.map(subscription => [String(subscription.id), subscription])
        );
        const timestamp = now();
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
                    title: isReminder ? `[마감 임박] ${notice.title}` : notice.title,
                    body: (notice.aiSummary?.[0] || notice.content || '').slice(0, 180),
                    url: `/?id=${encodeURIComponent(notice.id)}`,
                    // 태그가 같으면 브라우저가 이전 알림을 조용히 덮어쓴다. 리마인드가
                    // 새 알림으로 뜨지 않고 원래 알림을 갈아치우면 기능이 무의미해진다.
                    tag: isReminder ? `notice-${notice.id}-r${job.id}` : `notice-${notice.id}`
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
                if (statusCode === 404 || statusCode === 410) {
                    await store.deactivatePushSubscription(subscription.id);
                    await store.updateNotificationDelivery(delivery.id, {
                        status: 'permanent_failure',
                        attempts,
                        nextAttemptAt: null,
                        lastError: `push endpoint gone (${statusCode})`
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
