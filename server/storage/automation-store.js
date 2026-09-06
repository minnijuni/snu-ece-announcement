import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const STALE_CRAWL_RUN_MS = 15 * 60 * 1000;
const STALE_NOTIFICATION_JOB_MS = 5 * 60 * 1000;

function emptyDocument() {
    return {
        version: 1,
        notices: [],
        crawlRuns: [],
        crawlItems: [],
        categories: [],
        categoryAliases: [],
        noticeCategories: [],
        categoryCandidates: [],
        categoryCandidateNotices: [],
        pushSubscriptions: [],
        notificationJobs: [],
        notificationDeliveries: [],
        auditLogs: []
    };
}

function nextId(rows) {
    return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1;
}

function mergeCanonicalCategories(document, canonicalCategories = []) {
    const canonicalSlugs = new Set(canonicalCategories.map(category => category.slug));
    for (const canonical of canonicalCategories) {
        const existing = document.categories.find(category =>
            category.slug === canonical.slug || category.name === canonical.name
        );
        if (existing) {
            existing.name = canonical.name;
            existing.slug = canonical.slug;
            existing.key = canonical.key;
            existing.definition = canonical.definition;
            existing.isActive = true;
            continue;
        }
        document.categories.push({
            id: nextId(document.categories),
            name: canonical.name,
            slug: canonical.slug,
            key: canonical.key,
            definition: canonical.definition,
            isActive: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        });
    }
    for (const category of document.categories) {
        if (!canonicalSlugs.has(category.slug)) category.isActive = false;
    }
    return document;
}

function duplicateSourceError() {
    const error = new Error('duplicate source notice');
    error.code = 'DUPLICATE_SOURCE_NOTICE';
    return error;
}

function noticeNotPendingError() {
    const error = new Error('notice is not pending review');
    error.code = 'NOTICE_NOT_PENDING';
    return error;
}

function crawlAlreadyRunningError() {
    const error = new Error('crawl is already running');
    error.code = 'CRAWL_ALREADY_RUNNING';
    return error;
}

function toSupabaseNotice(row) {
    if (!row) return null;
    return {
        id: Number(row.id),
        status: row.status,
        sourceType: row.source_type,
        sourceExternalId: row.source_external_id,
        sourceUrl: row.source_url,
        sourcePublishedAt: row.source_published_at,
        lastCrawledAt: row.last_crawled_at,
        title: row.title,
        content: row.content,
        rawTitle: row.raw_title,
        rawContent: row.raw_content,
        target: row.target,
        targets: Array.isArray(row.targets) ? row.targets : [],
        host: row.host,
        sourceGroup: row.source_group,
        threadKey: row.thread_key,
        ocrText: row.ocr_text || '',
        deadline: row.deadline,
        deadlineAt: row.deadline_at,
        expiresAt: row.expires_at,
        isAlwaysOpen: row.is_always_open === true,
        isPinned: row.is_pinned === true,
        pinnedUntil: row.pinned_until || null,
        isHidden: row.is_hidden === true,
        category: row.category || null,
        hasReward: row.has_reward === true,
        rewardNote: row.reward_note || row.survey_reward || null,
        requiresAction: row.requires_action === true,
        surveyReward: row.reward_note || row.survey_reward || '',
        aiSummary: Array.isArray(row.ai_summary) ? row.ai_summary : [],
        keywords: Array.isArray(row.keywords) ? row.keywords : [],
        attachments: Array.isArray(row.attachments) ? row.attachments : [],
        analysisStatus: row.analysis_status,
        analysisConfidence: row.analysis_confidence,
        crawlMetadata: row.crawl_metadata || {},
        categoryIds: (row.notice_categories || []).map(item => Number(item.category_id)),
        rejectionReason: row.review_note,
        publishedAt: row.published_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

function toSupabaseNoticeInsert(notice) {
    const now = new Date().toISOString();
    return {
        status: 'pending_review',
        source_type: notice.sourceType,
        source_external_id: notice.sourceExternalId,
        source_url: notice.sourceUrl || null,
        source_published_at: notice.sourcePublishedAt || null,
        last_crawled_at: notice.lastCrawledAt || now,
        title: notice.title,
        content: notice.content,
        raw_title: notice.rawTitle || notice.title,
        raw_content: notice.rawContent || notice.content,
        target: notice.target || '전체',
        targets: notice.targets || ['전체'],
        host: notice.host || '전기정보공학부',
        source_group: notice.sourceGroup || null,
        thread_key: notice.threadKey || null,
        ocr_text: notice.ocrText || '',
        deadline: notice.deadline || null,
        category: notice.category || null,
        has_reward: notice.hasReward === true,
        reward_note: notice.rewardNote || null,
        requires_action: notice.requiresAction === true,
        ai_summary: notice.aiSummary || [],
        keywords: notice.keywords || [],
        attachments: notice.attachments || [],
        analysis_status: notice.analysisStatus || 'pending',
        analysis_confidence: notice.analysisConfidence ?? null,
        survey_reward: notice.surveyReward || '',
        crawl_metadata: notice.crawlMetadata || {},
        images: [],
        views: 0,
        is_deleted: false
    };
}

function createJsonStore(filePath, canonicalCategories = []) {
    let mutationQueue = Promise.resolve();

    async function readDocument() {
        await mutationQueue;
        try {
            const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
            return mergeCanonicalCategories(
                { ...emptyDocument(), ...parsed },
                canonicalCategories
            );
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            return mergeCanonicalCategories(emptyDocument(), canonicalCategories);
        }
    }

    async function writeDocument(document) {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const tempPath = `${filePath}.tmp`;
        await fs.writeFile(tempPath, JSON.stringify(document, null, 2), 'utf8');
        await fs.rename(tempPath, filePath);
    }

    function mutate(mutator) {
        const operation = mutationQueue.then(async () => {
            let document;
            try {
                document = JSON.parse(await fs.readFile(filePath, 'utf8'));
                document = mergeCanonicalCategories(
                    { ...emptyDocument(), ...document },
                    canonicalCategories
                );
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
                document = mergeCanonicalCategories(emptyDocument(), canonicalCategories);
            }
            const result = await mutator(document);
            await writeDocument(document);
            return result;
        });
        mutationQueue = operation.then(() => undefined, () => undefined);
        return operation;
    }

    return {
        async beginCrawlRun(sourceType) {
            return mutate(document => {
                const now = new Date();
                for (const run of document.crawlRuns) {
                    if (
                        run.status === 'running'
                        && now.getTime() - new Date(run.startedAt).getTime() >= STALE_CRAWL_RUN_MS
                    ) {
                        run.status = 'failed';
                        run.errorMessage = 'stale crawl run recovered automatically';
                        run.finishedAt = now.toISOString();
                    }
                }
                if (document.crawlRuns.some(run =>
                    run.sourceType === sourceType && run.status === 'running'
                )) {
                    throw crawlAlreadyRunningError();
                }
                const run = {
                    id: nextId(document.crawlRuns),
                    sourceType,
                    status: 'running',
                    discoveredCount: 0,
                    createdCount: 0,
                    failedCount: 0,
                    errorMessage: null,
                    startedAt: new Date().toISOString(),
                    finishedAt: null
                };
                document.crawlRuns.push(run);
                return { ...run };
            });
        },

        async finishCrawlRun(id, result) {
            return mutate(document => {
                const run = document.crawlRuns.find(item => Number(item.id) === Number(id));
                if (!run) throw new Error('crawl run not found');
                Object.assign(run, result, { finishedAt: new Date().toISOString() });
                return { ...run };
            });
        },

        async recordCrawlItem(crawlRunId, item) {
            return mutate(document => {
                const row = {
                    id: nextId(document.crawlItems),
                    crawlRunId: Number(crawlRunId),
                    sourceExternalId: String(item.sourceExternalId),
                    status: item.status,
                    errorMessage: item.errorMessage || null,
                    createdAt: new Date().toISOString()
                };
                document.crawlItems.push(row);
                return { ...row };
            });
        },

        async findNoticeBySource(sourceType, sourceExternalId) {
            const document = await readDocument();
            const notice = document.notices.find(item =>
                item.sourceType === sourceType
                && String(item.sourceExternalId) === String(sourceExternalId)
            );
            return notice ? { ...notice } : null;
        },

        async createPendingNotice(input) {
            return mutate(document => {
                const duplicate = document.notices.some(item =>
                    item.sourceType === input.sourceType
                    && String(item.sourceExternalId) === String(input.sourceExternalId)
                );
                if (duplicate) throw duplicateSourceError();
                const now = new Date().toISOString();
                const notice = {
                    id: nextId(document.notices),
                    ...input,
                    category: input.category || document.categories.find(category =>
                        Number(category.id) === Number(input.existingCategoryIds?.[0])
                    )?.key || null,
                    status: 'pending_review',
                    createdAt: now,
                    updatedAt: now
                };
                document.notices.push(notice);
                for (const categoryId of Array.from(new Set(
                    (input.existingCategoryIds || []).map(Number)
                ))) {
                    if (document.categories.some(category =>
                        Number(category.id) === categoryId && category.isActive !== false
                    )) {
                        document.noticeCategories.push({
                            noticeId: notice.id,
                            categoryId,
                            createdAt: now
                        });
                    }
                }
                return { ...notice };
            });
        },

        async listReviewNotices() {
            const document = await readDocument();
            return document.notices
                .filter(notice => notice.status === 'pending_review')
                .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
                .map(notice => ({
                    ...notice,
                    categoryIds: document.noticeCategories
                        .filter(item => Number(item.noticeId) === Number(notice.id))
                        .map(item => Number(item.categoryId))
                }));
        },

        async getReviewNotice(id) {
            const document = await readDocument();
            const notice = document.notices.find(item =>
                Number(item.id) === Number(id) && item.status === 'pending_review'
            );
            return notice ? {
                ...notice,
                categoryIds: document.noticeCategories
                    .filter(item => Number(item.noticeId) === Number(id))
                    .map(item => Number(item.categoryId))
            } : null;
        },

        async updateReviewAnalysis(id, analysis) {
            return mutate(document => {
                const notice = document.notices.find(item =>
                    Number(item.id) === Number(id) && item.status === 'pending_review'
                );
                if (!notice) throw noticeNotPendingError();
                Object.assign(notice, analysis, { updatedAt: new Date().toISOString() });
                if (Array.isArray(analysis.categoryIds)) {
                    document.noticeCategories = document.noticeCategories.filter(item =>
                        Number(item.noticeId) !== Number(notice.id)
                    );
                    for (const categoryId of Array.from(new Set(analysis.categoryIds.map(Number)))) {
                        if (document.categories.some(category =>
                            Number(category.id) === categoryId && category.isActive !== false
                        )) {
                            document.noticeCategories.push({
                                noticeId: notice.id,
                                categoryId,
                                createdAt: new Date().toISOString()
                            });
                        }
                    }
                    notice.category = document.categories.find(category =>
                        Number(category.id) === Number(analysis.categoryIds[0])
                    )?.key || null;
                }
                return {
                    ...notice,
                    categoryIds: document.noticeCategories
                        .filter(item => Number(item.noticeId) === Number(notice.id))
                        .map(item => Number(item.categoryId))
                };
            });
        },

        async publishReviewNotice(id, edits = {}, { notify = true } = {}) {
            return mutate(document => {
                const notice = document.notices.find(item => Number(item.id) === Number(id));
                if (!notice || notice.status !== 'pending_review') throw noticeNotPendingError();
                const now = new Date().toISOString();
                const editableFields = [
                    'title', 'content', 'target', 'targets', 'host', 'deadline',
                    'deadlineAt', 'expiresAt', 'isAlwaysOpen',
                    'isPinned',
                    'isHidden', 'category', 'hasReward', 'rewardNote', 'requiresAction',
                    'surveyReward',
                    'aiSummary', 'keywords', 'attachments', 'analysisConfidence'
                ];
                for (const field of editableFields) {
                    if (Object.hasOwn(edits, field)) notice[field] = edits[field];
                }
                if (Array.isArray(edits.categoryIds)) {
                    document.noticeCategories = document.noticeCategories.filter(item =>
                        Number(item.noticeId) !== Number(notice.id)
                    );
                    for (const categoryId of Array.from(new Set(edits.categoryIds.map(Number)))) {
                        if (document.categories.some(category =>
                            Number(category.id) === categoryId && category.isActive !== false
                        )) {
                            document.noticeCategories.push({
                                noticeId: notice.id,
                                categoryId,
                                createdAt: now
                            });
                        }
                    }
                    notice.category = document.categories.find(category =>
                        Number(category.id) === Number(edits.categoryIds[0])
                    )?.key || null;
                }
                notice.status = 'published';
                notice.publishedAt = now;
                notice.updatedAt = now;
                if (notify) {
                    document.notificationJobs.push({
                        id: nextId(document.notificationJobs),
                        noticeId: notice.id,
                        kind: 'new_notice',
                        status: 'pending',
                        targets: Array.isArray(notice.targets) ? notice.targets : [],
                        attemptCount: 0,
                        createdAt: now,
                        updatedAt: now
                    });
                }
                document.auditLogs.push({
                    id: nextId(document.auditLogs),
                    action: 'notice_published',
                    entityType: 'notice',
                    entityId: String(notice.id),
                    metadata: { notify },
                    createdAt: now
                });
                return { ...notice };
            });
        },

        async rejectReviewNotice(id, reason = '') {
            return mutate(document => {
                const notice = document.notices.find(item => Number(item.id) === Number(id));
                if (!notice || notice.status !== 'pending_review') throw noticeNotPendingError();
                const now = new Date().toISOString();
                notice.status = 'rejected';
                notice.rejectionReason = String(reason || '').trim() || null;
                notice.updatedAt = now;
                document.auditLogs.push({
                    id: nextId(document.auditLogs),
                    action: 'notice_rejected',
                    entityType: 'notice',
                    entityId: String(notice.id),
                    metadata: { reason: notice.rejectionReason },
                    createdAt: now
                });
                return { ...notice };
            });
        },

        async listPublishedNotices() {
            const document = await readDocument();
            return document.notices
                .filter(notice => notice.status === 'published' && !notice.isDeleted)
                .sort((a, b) =>
                    String(b.publishedAt || b.createdAt).localeCompare(
                        String(a.publishedAt || a.createdAt)
                    )
                )
                .map(notice => ({
                    ...notice,
                    categoryIds: document.noticeCategories
                        .filter(item => Number(item.noticeId) === Number(notice.id))
                        .map(item => Number(item.categoryId))
                }));
        },

        async setPublishedNoticeHidden(id, hidden) {
            return mutate(document => {
                const notice = document.notices.find(item =>
                    Number(item.id) === Number(id)
                    && item.status === 'published'
                    && !item.isDeleted
                );
                if (!notice) return null;
                notice.isHidden = Boolean(hidden);
                notice.updatedAt = new Date().toISOString();
                return { ...notice };
            });
        },

        async setPublishedNoticePin(id, { pinnedUntil = null, isPinned = null } = {}) {
            return mutate(document => {
                const notice = document.notices.find(item =>
                    Number(item.id) === Number(id)
                    && item.status === 'published'
                    && !item.isDeleted
                );
                if (!notice) return null;
                notice.pinnedUntil = pinnedUntil;
                if (isPinned !== null) notice.isPinned = Boolean(isPinned);
                notice.updatedAt = new Date().toISOString();
                return { ...notice };
            });
        },

        async listNotificationJobs() {
            const document = await readDocument();
            return document.notificationJobs.map(job => ({ ...job }));
        },

        /* 리마인드 쿨다운과 진행 중 검사가 보는 창구. 최신순으로 돌려주므로
           호출한 쪽은 첫 항목만 보면 마지막으로 언제 보냈는지 알 수 있다. */
        async listNotificationJobsForNotice(noticeId, kind = null) {
            const document = await readDocument();
            return document.notificationJobs
                .filter(job => Number(job.noticeId) === Number(noticeId)
                    && (kind === null || job.kind === kind))
                .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
                .map(job => ({ ...job }));
        },

        async createNotificationJob({ noticeId, kind = 'new_notice' }) {
            return mutate(document => {
                const now = new Date().toISOString();
                // new_notice는 공지당 하나. Supabase의 부분 유니크 인덱스와 같은 규칙을
                // 파일 모드에서는 코드로 지킨다.
                if (kind === 'new_notice' && document.notificationJobs.some(job =>
                    Number(job.noticeId) === Number(noticeId) && job.kind === 'new_notice'
                )) {
                    return null;
                }
                const job = {
                    id: nextId(document.notificationJobs),
                    noticeId: Number(noticeId),
                    kind,
                    status: 'pending',
                    attemptCount: 0,
                    createdAt: now,
                    updatedAt: now
                };
                document.notificationJobs.push(job);
                return { ...job };
            });
        },

        async recordAuditLog({ action, entityType, entityId, metadata = {} }) {
            return mutate(document => {
                const entry = {
                    id: nextId(document.auditLogs),
                    action,
                    entityType,
                    entityId: String(entityId),
                    metadata,
                    createdAt: new Date().toISOString()
                };
                document.auditLogs.push(entry);
                return { ...entry };
            });
        },

        async createManualNotice(payload, { notify = true } = {}) {
            return mutate(document => {
                const now = new Date().toISOString();
                const categoryIds = Array.from(new Set(
                    (payload.categoryIds || []).map(Number)
                )).filter(categoryId => document.categories.some(category =>
                    Number(category.id) === categoryId && category.isActive !== false
                ));
                const notice = {
                    id: Date.now(),
                    ...payload,
                    status: 'published',
                    sourceType: 'manual',
                    targets: Array.isArray(payload.targets)
                        ? payload.targets
                        : [payload.target].filter(Boolean),
                    categoryIds,
                    views: 0,
                    isDeleted: false,
                    publishedAt: now,
                    createdAt: now,
                    updatedAt: now
                };
                while (document.notices.some(item => Number(item.id) === notice.id)) {
                    notice.id += 1;
                }
                document.notices.push(notice);
                for (const categoryId of categoryIds) {
                    document.noticeCategories.push({
                        noticeId: notice.id,
                        categoryId
                    });
                }
                if (notify) {
                    document.notificationJobs.push({
                        id: nextId(document.notificationJobs),
                        noticeId: notice.id,
                        kind: 'new_notice',
                        status: 'pending',
                        attemptCount: 0,
                        createdAt: now,
                        updatedAt: now
                    });
                }
                return { ...notice };
            });
        },

        async updateManualNotice(id, payload) {
            return mutate(document => {
                const notice = document.notices.find(item =>
                    Number(item.id) === Number(id)
                    && item.sourceType === 'manual'
                    && item.status === 'published'
                    && !item.isDeleted
                );
                if (!notice) return null;
                const categoryIds = Array.from(new Set(
                    (payload.categoryIds || []).map(Number)
                )).filter(categoryId => document.categories.some(category =>
                    Number(category.id) === categoryId && category.isActive !== false
                ));
                Object.assign(notice, payload, {
                    targets: Array.isArray(payload.targets)
                        ? payload.targets
                        : [payload.target].filter(Boolean),
                    categoryIds,
                    updatedAt: new Date().toISOString()
                });
                document.noticeCategories = document.noticeCategories.filter(item =>
                    Number(item.noticeId) !== Number(notice.id)
                );
                for (const categoryId of categoryIds) {
                    document.noticeCategories.push({
                        noticeId: notice.id,
                        categoryId
                    });
                }
                return { ...notice, categoryIds };
            });
        },

        async deleteManualNotice(id) {
            return mutate(document => {
                const notice = document.notices.find(item =>
                    Number(item.id) === Number(id)
                    && item.sourceType === 'manual'
                    && item.status === 'published'
                    && !item.isDeleted
                );
                if (!notice) return false;
                notice.isDeleted = true;
                notice.deletedAt = new Date().toISOString();
                notice.updatedAt = notice.deletedAt;
                return true;
            });
        },

        async listPendingNotificationJobs(batchSize = 50) {
            return mutate(document => {
                const now = new Date();
                for (const job of document.notificationJobs) {
                    if (
                        job.status === 'processing'
                        && job.claimedAt
                        && now.getTime() - new Date(job.claimedAt).getTime()
                            >= STALE_NOTIFICATION_JOB_MS
                    ) {
                        job.status = 'pending';
                        job.claimedAt = null;
                        job.claimToken = null;
                        job.updatedAt = now.toISOString();
                    }
                }
                return document.notificationJobs
                    .filter(job => job.status === 'pending')
                    .slice(0, batchSize)
                    .map(job => ({ ...job }));
            });
        },

        async claimNotificationJob(id) {
            return mutate(document => {
                const job = document.notificationJobs.find(item =>
                    Number(item.id) === Number(id) && item.status === 'pending'
                );
                if (!job) return null;
                job.status = 'processing';
                job.claimToken = crypto.randomUUID();
                job.claimedAt = new Date().toISOString();
                job.updatedAt = job.claimedAt;
                return { ...job };
            });
        },

        async renewNotificationJobClaim(id, claimToken) {
            return mutate(document => {
                const job = document.notificationJobs.find(item =>
                    Number(item.id) === Number(id)
                    && item.status === 'processing'
                    && item.claimToken === claimToken
                );
                if (!job) return false;
                job.claimedAt = new Date().toISOString();
                job.updatedAt = job.claimedAt;
                return true;
            });
        },

        async getAutomationNotice(id) {
            const document = await readDocument();
            const notice = document.notices.find(item =>
                Number(item.id) === Number(id) && !item.isDeleted
            );
            return notice ? {
                ...notice,
                categoryIds: document.noticeCategories
                    .filter(item => Number(item.noticeId) === Number(notice.id))
                    .map(item => Number(item.categoryId))
            } : null;
        },

        async ensureNotificationDeliveries(jobId, subscriptionIds) {
            return mutate(document => {
                const created = [];
                for (const subscriptionId of subscriptionIds) {
                    let delivery = document.notificationDeliveries.find(item =>
                        Number(item.jobId) === Number(jobId)
                        && String(item.subscriptionId) === String(subscriptionId)
                    );
                    if (!delivery) {
                        delivery = {
                            id: nextId(document.notificationDeliveries),
                            jobId: Number(jobId),
                            subscriptionId: String(subscriptionId),
                            status: 'pending',
                            attempts: 0,
                            nextAttemptAt: null,
                            lastError: null,
                            sentAt: null,
                            createdAt: new Date().toISOString(),
                            updatedAt: new Date().toISOString()
                        };
                        document.notificationDeliveries.push(delivery);
                    }
                    created.push({ ...delivery });
                }
                return created;
            });
        },

        async listNotificationDeliveries(jobId = null) {
            const document = await readDocument();
            return document.notificationDeliveries
                .filter(item => jobId == null || Number(item.jobId) === Number(jobId))
                .map(item => ({ ...item }));
        },

        async updateNotificationDelivery(id, changes) {
            return mutate(document => {
                const delivery = document.notificationDeliveries.find(item =>
                    Number(item.id) === Number(id)
                );
                if (!delivery) throw new Error('notification delivery not found');
                Object.assign(delivery, changes, { updatedAt: new Date().toISOString() });
                return { ...delivery };
            });
        },

        async updateNotificationJob(id, changes, claimToken = null) {
            return mutate(document => {
                const job = document.notificationJobs.find(item =>
                    Number(item.id) === Number(id)
                    && (!claimToken || item.claimToken === claimToken)
                );
                if (!job) throw new Error('notification job not found');
                Object.assign(job, changes, { updatedAt: new Date().toISOString() });
                return { ...job };
            });
        },

        async deactivatePushSubscription(id) {
            return mutate(document => {
                const subscription = document.pushSubscriptions.find(item =>
                    String(item.id) === String(id)
                );
                if (!subscription) return null;
                subscription.status = 'inactive';
                subscription.updatedAt = new Date().toISOString();
                return { ...subscription };
            });
        },

        async createPushSubscription(input) {
            return mutate(document => {
                const existing = document.pushSubscriptions.find(item =>
                    item.endpoint === input.endpoint
                );
                if (existing) {
                    Object.assign(existing, input, { updatedAt: new Date().toISOString() });
                    return { ...existing };
                }
                const subscription = {
                    id: crypto.randomUUID(),
                    ...input
                };
                document.pushSubscriptions.push(subscription);
                return { ...subscription };
            });
        },

        async getPushSubscription(id) {
            const document = await readDocument();
            const subscription = document.pushSubscriptions.find(item =>
                String(item.id) === String(id)
            );
            return subscription ? { ...subscription } : null;
        },

        async updatePushSubscription(id, preferences) {
            return mutate(document => {
                const subscription = document.pushSubscriptions.find(item =>
                    String(item.id) === String(id)
                );
                if (!subscription) throw new Error('push subscription not found');
                Object.assign(subscription, preferences, {
                    status: 'active',
                    updatedAt: new Date().toISOString()
                });
                return { ...subscription };
            });
        },

        async deletePushSubscription(id) {
            return mutate(document => {
                const index = document.pushSubscriptions.findIndex(item =>
                    String(item.id) === String(id)
                );
                if (index < 0) return false;
                document.pushSubscriptions.splice(index, 1);
                return true;
            });
        },

        async listPushSubscriptions() {
            const document = await readDocument();
            return document.pushSubscriptions.map(subscription => ({ ...subscription }));
        },

        async listCategories({ activeOnly = true } = {}) {
            const document = await readDocument();
            return document.categories
                .filter(category => !activeOnly || category.isActive !== false)
                .map(category => ({
                    ...category,
                    aliases: document.categoryAliases
                        .filter(alias => Number(alias.categoryId) === Number(category.id))
                        .map(alias => alias.alias)
                }));
        },

        async incrementAutomationNoticeView(id) {
            return mutate(document => {
                const notice = document.notices.find(item =>
                    Number(item.id) === Number(id)
                    && item.status === 'published'
                    && !item.isDeleted
                );
                if (!notice) return null;
                notice.views = Number(notice.views || 0) + 1;
                notice.updatedAt = new Date().toISOString();
                return {
                    ...notice,
                    categoryIds: document.noticeCategories
                        .filter(item => Number(item.noticeId) === Number(notice.id))
                        .map(item => Number(item.categoryId))
                };
            });
        },

        async getCategoryEvaluationData() {
            const document = await readDocument();
            return {
                notices: document.notices
                    .filter(notice => notice.status === 'published')
                    .map(notice => ({ ...notice })),
                categories: document.categories.map(category => ({
                    ...category,
                    aliases: document.categoryAliases
                        .filter(alias => Number(alias.categoryId) === Number(category.id))
                        .map(alias => alias.alias)
                })),
                candidates: document.categoryCandidates.map(candidate => ({
                    ...candidate,
                    supportingNoticeIds: document.categoryCandidateNotices
                        .filter(item => Number(item.candidateId) === Number(candidate.id))
                        .map(item => Number(item.noticeId))
                }))
            };
        },

        async upsertCategoryCandidates(recommendations) {
            return mutate(document => {
                const updated = [];
                for (const recommendation of recommendations) {
                    let candidate = document.categoryCandidates.find(item =>
                        item.normalizedKeyword === recommendation.normalizedKeyword
                    );
                    if (candidate?.status === 'rejected') continue;
                    const now = new Date().toISOString();
                    if (!candidate) {
                        candidate = {
                            id: nextId(document.categoryCandidates),
                            createdAt: now
                        };
                        document.categoryCandidates.push(candidate);
                    }
                    Object.assign(candidate, recommendation, {
                        status: 'pending',
                        updatedAt: now
                    });
                    document.categoryCandidateNotices =
                        document.categoryCandidateNotices.filter(item =>
                            Number(item.candidateId) !== Number(candidate.id)
                        );
                    for (const noticeId of recommendation.supportingNoticeIds) {
                        document.categoryCandidateNotices.push({
                            candidateId: candidate.id,
                            noticeId: Number(noticeId),
                            createdAt: now
                        });
                    }
                    updated.push({ ...candidate });
                }
                return updated;
            });
        },

        async listCategoryCandidates() {
            const document = await readDocument();
            return document.categoryCandidates
                .filter(candidate => candidate.status === 'pending')
                .sort((a, b) => b.occurrenceCount - a.occurrenceCount)
                .map(candidate => {
                    const supportingNoticeIds = document.categoryCandidateNotices
                        .filter(item => Number(item.candidateId) === Number(candidate.id))
                        .map(item => Number(item.noticeId));
                    return {
                        ...candidate,
                        supportingNoticeIds,
                        supportingNotices: document.notices
                            .filter(notice => supportingNoticeIds.includes(Number(notice.id)))
                            .map(notice => ({ id: notice.id, title: notice.title }))
                    };
                });
        },

        async decideCategoryCandidate(id, decision) {
            return mutate(document => {
                const candidate = document.categoryCandidates.find(item =>
                    Number(item.id) === Number(id)
                );
                if (!candidate || !['pending', 'deferred'].includes(candidate.status)) {
                    const error = new Error('category candidate is not pending');
                    error.code = 'CATEGORY_CANDIDATE_NOT_PENDING';
                    throw error;
                }
                const now = new Date().toISOString();
                const supportingNoticeIds = document.categoryCandidateNotices
                    .filter(item => Number(item.candidateId) === Number(candidate.id))
                    .map(item => Number(item.noticeId));
                let categoryId = null;
                if (decision.action === 'approve') {
                    if (document.categories.some(item => item.slug === decision.slug)) {
                        throw new Error('category slug already exists');
                    }
                    const category = {
                        id: nextId(document.categories),
                        name: decision.name,
                        slug: decision.slug,
                        isActive: true,
                        createdAt: now,
                        updatedAt: now
                    };
                    document.categories.push(category);
                    categoryId = category.id;
                    candidate.status = 'approved';
                } else if (decision.action === 'merge') {
                    const category = document.categories.find(item =>
                        Number(item.id) === Number(decision.categoryId)
                    );
                    if (!category) throw new Error('category not found');
                    categoryId = category.id;
                    if (!document.categoryAliases.some(alias =>
                        alias.normalizedAlias === candidate.normalizedKeyword
                    )) {
                        document.categoryAliases.push({
                            id: nextId(document.categoryAliases),
                            categoryId,
                            alias: candidate.displayName,
                            normalizedAlias: candidate.normalizedKeyword,
                            createdAt: now
                        });
                    }
                    candidate.status = 'merged';
                } else if (decision.action === 'reject') {
                    candidate.status = 'rejected';
                } else if (decision.action === 'defer') {
                    candidate.status = 'deferred';
                    candidate.deferredUntil = decision.deferredUntil;
                } else {
                    throw new Error('invalid category candidate decision');
                }
                if (categoryId) {
                    candidate.mergedCategoryId = categoryId;
                    for (const noticeId of supportingNoticeIds) {
                        if (!document.noticeCategories.some(item =>
                            Number(item.noticeId) === noticeId
                            && Number(item.categoryId) === categoryId
                        )) {
                            document.noticeCategories.push({
                                noticeId,
                                categoryId,
                                createdAt: now
                            });
                        }
                    }
                }
                candidate.decidedAt = decision.action === 'defer' ? null : now;
                candidate.updatedAt = now;
                document.auditLogs.push({
                    id: nextId(document.auditLogs),
                    action: `category_candidate_${decision.action}`,
                    entityType: 'category_candidate',
                    entityId: String(candidate.id),
                    metadata: decision,
                    createdAt: now
                });
                return { ...candidate };
            });
        },

        async listCrawlRuns() {
            const document = await readDocument();
            return document.crawlRuns
                .slice()
                .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
                .map(run => ({ ...run }));
        }
    };
}

function createSupabaseStore(supabase, canonicalCategories = []) {
    return {
        async beginCrawlRun(sourceType) {
            const staleBefore = new Date(Date.now() - STALE_CRAWL_RUN_MS).toISOString();
            const { error: recoveryError } = await supabase
                .from('crawl_runs')
                .update({
                    status: 'failed',
                    error_message: 'stale crawl run recovered automatically',
                    finished_at: new Date().toISOString()
                })
                .eq('source_type', sourceType)
                .eq('status', 'running')
                .lt('started_at', staleBefore);
            if (recoveryError) throw recoveryError;
            const { data, error } = await supabase
                .from('crawl_runs')
                .insert({ source_type: sourceType, status: 'running' })
                .select('*')
                .single();
            if (error?.code === '23505') throw crawlAlreadyRunningError();
            if (error) throw error;
            return {
                id: Number(data.id),
                sourceType: data.source_type,
                status: data.status,
                startedAt: data.started_at
            };
        },

        async finishCrawlRun(id, result) {
            const payload = {
                status: result.status,
                discovered_count: result.discoveredCount,
                created_count: result.createdCount,
                failed_count: result.failedCount,
                error_message: result.errorMessage || null,
                finished_at: new Date().toISOString()
            };
            const { data, error } = await supabase
                .from('crawl_runs')
                .update(payload)
                .eq('id', id)
                .select('*')
                .single();
            if (error) throw error;
            return {
                id: Number(data.id),
                status: data.status,
                discoveredCount: data.discovered_count,
                createdCount: data.created_count,
                failedCount: data.failed_count,
                errorMessage: data.error_message,
                finishedAt: data.finished_at
            };
        },

        async recordCrawlItem(crawlRunId, item) {
            const { data, error } = await supabase
                .from('crawl_items')
                .insert({
                    crawl_run_id: crawlRunId,
                    source_external_id: item.sourceExternalId,
                    status: item.status,
                    error_message: item.errorMessage || null
                })
                .select('*')
                .single();
            if (error) throw error;
            return data;
        },

        async findNoticeBySource(sourceType, sourceExternalId) {
            const { data, error } = await supabase
                .from('notices')
                .select('*')
                .eq('source_type', sourceType)
                .eq('source_external_id', sourceExternalId)
                .maybeSingle();
            if (error) throw error;
            return toSupabaseNotice(data);
        },

        async createPendingNotice(input) {
            const { data, error } = await supabase
                .from('notices')
                .insert(toSupabaseNoticeInsert(input))
                .select('*')
                .single();
            if (error?.code === '23505') throw duplicateSourceError();
            if (error) throw error;
            if ((input.existingCategoryIds || []).length > 0) {
                const { error: categoryError } = await supabase
                    .from('notice_categories')
                    .upsert(input.existingCategoryIds.map(categoryId => ({
                        notice_id: data.id,
                        category_id: Number(categoryId)
                    })), {
                        onConflict: 'notice_id,category_id',
                        ignoreDuplicates: true
                    });
                if (categoryError) throw categoryError;
                data.notice_categories = input.existingCategoryIds.map(categoryId => ({
                    category_id: Number(categoryId)
                }));
            }
            return toSupabaseNotice(data);
        },

        async listReviewNotices() {
            const { data, error } = await supabase
                .from('notices')
                .select('*')
                .eq('status', 'pending_review')
                .eq('is_deleted', false)
                .order('created_at', { ascending: false });
            if (error) throw error;
            return (data || []).map(toSupabaseNotice);
        },

        async getReviewNotice(id) {
            const { data, error } = await supabase
                .from('notices')
                .select('*, notice_categories(category_id)')
                .eq('id', id)
                .eq('status', 'pending_review')
                .eq('is_deleted', false)
                .maybeSingle();
            if (error) throw error;
            return toSupabaseNotice(data);
        },

        async updateReviewAnalysis(id, analysis) {
            const payload = {};
            const fieldMap = {
                title: 'title',
                content: 'content',
                aiSummary: 'ai_summary',
                deadline: 'deadline',
                targets: 'targets',
                keywords: 'keywords',
                surveyReward: 'survey_reward',
                category: 'category',
                hasReward: 'has_reward',
                rewardNote: 'reward_note',
                requiresAction: 'requires_action',
                analysisStatus: 'analysis_status',
                analysisConfidence: 'analysis_confidence',
                ocrText: 'ocr_text'
            };
            for (const [field, column] of Object.entries(fieldMap)) {
                if (Object.hasOwn(analysis, field)) payload[column] = analysis[field];
            }
            const { data, error } = await supabase
                .from('notices')
                .update(payload)
                .eq('id', id)
                .eq('status', 'pending_review')
                .select('*')
                .maybeSingle();
            if (error) throw error;
            if (!data) throw noticeNotPendingError();
            if (Array.isArray(analysis.categoryIds)) {
                const deleteResult = await supabase
                    .from('notice_categories')
                    .delete()
                    .eq('notice_id', id);
                if (deleteResult.error) throw deleteResult.error;
                if (analysis.categoryIds.length > 0) {
                    const insertResult = await supabase
                        .from('notice_categories')
                        .insert(analysis.categoryIds.map(categoryId => ({
                            notice_id: id,
                            category_id: Number(categoryId)
                        })));
                    if (insertResult.error) throw insertResult.error;
                }
                data.notice_categories = analysis.categoryIds.map(categoryId => ({
                    category_id: Number(categoryId)
                }));
            }
            return toSupabaseNotice(data);
        },

        async publishReviewNotice(id, edits = {}, { notify = true } = {}) {
            const { data, error } = await supabase.rpc('publish_review_notice', {
                target_notice_id: Number(id),
                edits,
                should_notify: Boolean(notify)
            });
            if (error?.message?.includes('NOTICE_NOT_PENDING')) throw noticeNotPendingError();
            if (error) throw error;
            return toSupabaseNotice(Array.isArray(data) ? data[0] : data);
        },

        async rejectReviewNotice(id, reason = '') {
            const { data, error } = await supabase
                .from('notices')
                .update({
                    status: 'rejected',
                    review_note: String(reason || '').trim() || null,
                    reviewed_at: new Date().toISOString()
                })
                .eq('id', id)
                .eq('status', 'pending_review')
                .select('*')
                .maybeSingle();
            if (error) throw error;
            if (!data) throw noticeNotPendingError();
            return toSupabaseNotice(data);
        },

        async listPublishedNotices() {
            const { data, error } = await supabase
                .from('notices')
                .select('*, notice_categories(category_id)')
                .eq('status', 'published')
                .eq('is_deleted', false)
                .order('published_at', { ascending: false });
            if (error) throw error;
            return (data || []).map(toSupabaseNotice);
        },

        async setPublishedNoticeHidden(id, hidden) {
            const { data, error } = await supabase
                .from('notices')
                .update({ is_hidden: Boolean(hidden), updated_at: new Date().toISOString() })
                .eq('id', Number(id))
                .eq('status', 'published')
                .eq('is_deleted', false)
                .select('*, notice_categories(category_id)')
                .maybeSingle();
            if (error) throw error;
            return data ? toSupabaseNotice(data) : null;
        },

        async setPublishedNoticePin(id, { pinnedUntil = null, isPinned = null } = {}) {
            const changes = {
                pinned_until: pinnedUntil,
                updated_at: new Date().toISOString()
            };
            if (isPinned !== null) changes.is_pinned = Boolean(isPinned);
            const { data, error } = await supabase
                .from('notices')
                .update(changes)
                .eq('id', Number(id))
                .eq('status', 'published')
                .eq('is_deleted', false)
                .select('*, notice_categories(category_id)')
                .maybeSingle();
            if (error) throw error;
            return data ? toSupabaseNotice(data) : null;
        },

        async listNotificationJobs() {
            const { data, error } = await supabase
                .from('notification_jobs')
                .select('*')
                .order('created_at', { ascending: false });
            if (error) throw error;
            return data || [];
        },

        /* 리마인드 쿨다운과 진행 중 검사가 보는 창구. 최신순으로 돌려주므로
           호출한 쪽은 첫 항목만 보면 마지막으로 언제 보냈는지 알 수 있다. */
        async listNotificationJobsForNotice(noticeId, kind = null) {
            let query = supabase
                .from('notification_jobs')
                .select('*')
                .eq('notice_id', Number(noticeId));
            if (kind !== null) query = query.eq('kind', kind);
            const { data, error } = await query.order('created_at', { ascending: false });
            if (error) throw error;
            return (data || []).map(job => ({
                id: Number(job.id),
                noticeId: Number(job.notice_id),
                kind: job.kind,
                status: job.status,
                createdAt: job.created_at,
                completedAt: job.completed_at
            }));
        },

        async createNotificationJob({ noticeId, kind = 'new_notice' }) {
            const { data, error } = await supabase
                .from('notification_jobs')
                .insert({ notice_id: Number(noticeId), kind, status: 'pending' })
                .select('*')
                .maybeSingle();
            // new_notice가 이미 있으면 부분 유니크 인덱스가 막는다. 그건 오류가
            // 아니라 "이미 보냈다"는 뜻이므로 null로 돌려준다.
            if (error?.code === '23505') return null;
            if (error) throw error;
            return data
                ? { id: Number(data.id), noticeId: Number(data.notice_id), kind: data.kind, status: data.status }
                : null;
        },

        async recordAuditLog({ action, entityType, entityId, metadata = {} }) {
            const { data, error } = await supabase
                .from('automation_audit_logs')
                .insert({
                    action,
                    entity_type: entityType,
                    entity_id: String(entityId),
                    metadata
                })
                .select('*')
                .maybeSingle();
            if (error) throw error;
            return data || null;
        },

        async listPendingNotificationJobs(batchSize = 50) {
            const staleBefore = new Date(Date.now() - STALE_NOTIFICATION_JOB_MS).toISOString();
            const { error: recoveryError } = await supabase
                .from('notification_jobs')
                .update({ status: 'pending', claimed_at: null, claim_token: null })
                .eq('status', 'processing')
                .lt('claimed_at', staleBefore);
            if (recoveryError) throw recoveryError;
            const { data, error } = await supabase
                .from('notification_jobs')
                .select('*')
                .eq('status', 'pending')
                .lte('scheduled_at', new Date().toISOString())
                .order('scheduled_at', { ascending: true })
                .limit(batchSize);
            if (error) throw error;
            return (data || []).map(job => ({
                id: Number(job.id),
                noticeId: Number(job.notice_id),
                kind: job.kind,
                status: job.status
            }));
        },

        async claimNotificationJob(id) {
            const claimedAt = new Date().toISOString();
            const claimToken = crypto.randomUUID();
            const { data, error } = await supabase
                .from('notification_jobs')
                .update({
                    status: 'processing',
                    claimed_at: claimedAt,
                    claim_token: claimToken
                })
                .eq('id', id)
                .eq('status', 'pending')
                .select('*')
                .maybeSingle();
            if (error) throw error;
            if (!data) return null;
            return {
                id: Number(data.id),
                noticeId: Number(data.notice_id),
                kind: data.kind,
                status: data.status,
                claimToken: data.claim_token
            };
        },

        async renewNotificationJobClaim(id, claimToken) {
            const { data, error } = await supabase
                .from('notification_jobs')
                .update({ claimed_at: new Date().toISOString() })
                .eq('id', id)
                .eq('status', 'processing')
                .eq('claim_token', claimToken)
                .select('id')
                .maybeSingle();
            if (error) throw error;
            return Boolean(data);
        },

        async getAutomationNotice(id) {
            const { data, error } = await supabase
                .from('notices')
                .select('*, notice_categories(category_id)')
                .eq('id', id)
                .maybeSingle();
            if (error) throw error;
            if (!data) return null;
            return {
                ...toSupabaseNotice(data),
                categoryIds: (data.notice_categories || []).map(item => Number(item.category_id))
            };
        },

        async ensureNotificationDeliveries(jobId, subscriptionIds) {
            if (subscriptionIds.length === 0) return [];
            const rows = subscriptionIds.map(subscriptionId => ({
                job_id: jobId,
                subscription_id: subscriptionId,
                status: 'pending'
            }));
            const { data, error } = await supabase
                .from('notification_deliveries')
                .upsert(rows, {
                    onConflict: 'job_id,subscription_id',
                    ignoreDuplicates: true
                })
                .select('*');
            if (error) throw error;
            return data || [];
        },

        async listNotificationDeliveries(jobId = null) {
            let query = supabase.from('notification_deliveries').select('*');
            if (jobId != null) query = query.eq('job_id', jobId);
            const { data, error } = await query;
            if (error) throw error;
            return (data || []).map(item => ({
                id: Number(item.id),
                jobId: Number(item.job_id),
                subscriptionId: item.subscription_id,
                status: item.status,
                attempts: item.attempts,
                nextAttemptAt: item.next_attempt_at,
                lastError: item.last_error,
                sentAt: item.sent_at
            }));
        },

        async updateNotificationDelivery(id, changes) {
            const fieldMap = {
                status: 'status',
                attempts: 'attempts',
                nextAttemptAt: 'next_attempt_at',
                lastError: 'last_error',
                sentAt: 'sent_at'
            };
            const payload = { updated_at: new Date().toISOString() };
            for (const [field, column] of Object.entries(fieldMap)) {
                if (Object.hasOwn(changes, field)) payload[column] = changes[field];
            }
            const { data, error } = await supabase
                .from('notification_deliveries')
                .update(payload)
                .eq('id', id)
                .select('*')
                .single();
            if (error) throw error;
            return data;
        },

        async updateNotificationJob(id, changes, claimToken = null) {
            const payload = {};
            if (Object.hasOwn(changes, 'status')) payload.status = changes.status;
            if (Object.hasOwn(changes, 'completedAt')) payload.completed_at = changes.completedAt;
            if (Object.hasOwn(changes, 'claimedAt')) payload.claimed_at = changes.claimedAt;
            if (Object.hasOwn(changes, 'claimToken')) payload.claim_token = changes.claimToken;
            let query = supabase
                .from('notification_jobs')
                .update(payload)
                .eq('id', id);
            if (claimToken) query = query.eq('claim_token', claimToken);
            const { data, error } = await query
                .select('*')
                .maybeSingle();
            if (error) throw error;
            if (!data) throw new Error('notification job claim lost');
            return data;
        },

        async deactivatePushSubscription(id) {
            const { data, error } = await supabase
                .from('push_subscriptions')
                .update({ status: 'inactive', updated_at: new Date().toISOString() })
                .eq('id', id)
                .select('*')
                .maybeSingle();
            if (error) throw error;
            return data;
        },

        async createPushSubscription(input) {
            const payload = {
                endpoint: input.endpoint,
                p256dh: input.p256dh,
                auth: input.auth,
                management_token_hash: input.managementTokenHash,
                admission_year: input.admissionYear,
                all_notices: input.allNotices,
                category_ids: input.categoryIds,
                urgent_enabled: input.urgentEnabled,
                deadline_reminder_days: input.deadlineReminderDays,
                status: 'active',
                updated_at: new Date().toISOString()
            };
            const { data, error } = await supabase
                .from('push_subscriptions')
                .upsert(payload, { onConflict: 'endpoint' })
                .select('*')
                .single();
            if (error) throw error;
            return {
                id: data.id,
                endpoint: data.endpoint,
                p256dh: data.p256dh,
                auth: data.auth,
                managementTokenHash: data.management_token_hash,
                admissionYear: data.admission_year,
                allNotices: data.all_notices,
                categoryIds: data.category_ids || [],
                urgentEnabled: data.urgent_enabled,
                deadlineReminderDays: data.deadline_reminder_days,
                status: data.status
            };
        },

        async getPushSubscription(id) {
            const { data, error } = await supabase
                .from('push_subscriptions')
                .select('*')
                .eq('id', id)
                .maybeSingle();
            if (error) throw error;
            if (!data) return null;
            return {
                id: data.id,
                endpoint: data.endpoint,
                p256dh: data.p256dh,
                auth: data.auth,
                managementTokenHash: data.management_token_hash,
                admissionYear: data.admission_year,
                allNotices: data.all_notices,
                categoryIds: data.category_ids || [],
                urgentEnabled: data.urgent_enabled,
                deadlineReminderDays: data.deadline_reminder_days,
                status: data.status
            };
        },

        async updatePushSubscription(id, preferences) {
            const payload = {
                admission_year: preferences.admissionYear,
                all_notices: preferences.allNotices,
                category_ids: preferences.categoryIds,
                urgent_enabled: preferences.urgentEnabled,
                deadline_reminder_days: preferences.deadlineReminderDays,
                status: 'active',
                updated_at: new Date().toISOString()
            };
            const { data, error } = await supabase
                .from('push_subscriptions')
                .update(payload)
                .eq('id', id)
                .select('*')
                .single();
            if (error) throw error;
            return this.getPushSubscription(data.id);
        },

        async deletePushSubscription(id) {
            const { error } = await supabase
                .from('push_subscriptions')
                .delete()
                .eq('id', id);
            if (error) throw error;
            return true;
        },

        async listPushSubscriptions() {
            const { data, error } = await supabase
                .from('push_subscriptions')
                .select('*')
                .eq('status', 'active');
            if (error) throw error;
            return Promise.all((data || []).map(item => this.getPushSubscription(item.id)));
        },

        async listCategories({ activeOnly = true } = {}) {
            const fetchCategories = async () => {
                let query = supabase
                    .from('categories')
                    .select('*, category_aliases(alias)')
                    .order('name', { ascending: true });
                if (activeOnly) query = query.eq('is_active', true);
                const result = await query;
                if (result.error) throw result.error;
                return result.data || [];
            };
            let data = await fetchCategories();
            const needsCanonicalSeed = canonicalCategories.some(canonical => {
                const existing = data.find(category => category.slug === canonical.slug);
                return !existing || existing.name !== canonical.name || existing.is_active !== true;
            });
            if (needsCanonicalSeed) {
                const { error: seedError } = await supabase
                    .from('categories')
                    .upsert(canonicalCategories.map(category => ({
                        name: category.name,
                        slug: category.slug,
                        is_active: true,
                        updated_at: new Date().toISOString()
                    })), { onConflict: 'slug' });
                if (seedError) throw seedError;
                data = await fetchCategories();
            }
            const canonicalSlugSet = new Set(canonicalCategories.map(category => category.slug));
            const visibleData = activeOnly && canonicalSlugSet.size > 0
                ? data.filter(category => canonicalSlugSet.has(category.slug))
                : data;
            return visibleData.map(category => {
                const canonical = canonicalCategories.find(item => item.slug === category.slug);
                return {
                    id: Number(category.id),
                    key: canonical?.key || null,
                    name: category.name,
                    slug: category.slug,
                    definition: canonical?.definition || '',
                    isActive: category.is_active,
                    aliases: (category.category_aliases || []).map(alias => alias.alias)
                };
            });
        },

        async getCategoryEvaluationData() {
            const [noticeResult, categoryResult, candidateResult] = await Promise.all([
                supabase
                    .from('notices')
                    .select('id,status,keywords,analysis_confidence,published_at,created_at')
                    .eq('status', 'published')
                    .eq('is_deleted', false),
                this.listCategories({ activeOnly: false }),
                supabase
                    .from('category_candidates')
                    .select('*, category_candidate_notices(notice_id)')
            ]);
            if (noticeResult.error) throw noticeResult.error;
            if (candidateResult.error) throw candidateResult.error;
            return {
                notices: (noticeResult.data || []).map(notice => ({
                    id: Number(notice.id),
                    status: notice.status,
                    keywords: notice.keywords || [],
                    analysisConfidence: notice.analysis_confidence,
                    publishedAt: notice.published_at,
                    createdAt: notice.created_at
                })),
                categories: categoryResult,
                candidates: (candidateResult.data || []).map(candidate => ({
                    id: Number(candidate.id),
                    normalizedKeyword: candidate.normalized_keyword,
                    displayName: candidate.display_name,
                    status: candidate.status,
                    deferredUntil: candidate.deferred_until,
                    supportingNoticeIds: (candidate.category_candidate_notices || [])
                        .map(item => Number(item.notice_id))
                }))
            };
        },

        async upsertCategoryCandidates(recommendations) {
            const results = [];
            for (const recommendation of recommendations) {
                const { data, error } = await supabase
                    .from('category_candidates')
                    .upsert({
                        normalized_keyword: recommendation.normalizedKeyword,
                        display_name: recommendation.displayName,
                        status: 'pending',
                        occurrence_count: recommendation.occurrenceCount,
                        average_confidence: recommendation.averageConfidence,
                        first_seen_at: recommendation.firstSeenAt,
                        last_seen_at: recommendation.lastSeenAt,
                        deferred_until: null,
                        updated_at: new Date().toISOString()
                    }, { onConflict: 'normalized_keyword' })
                    .select('*')
                    .single();
                if (error) throw error;
                const deleteResult = await supabase
                    .from('category_candidate_notices')
                    .delete()
                    .eq('candidate_id', data.id);
                if (deleteResult.error) throw deleteResult.error;
                if (recommendation.supportingNoticeIds.length > 0) {
                    const insertResult = await supabase
                        .from('category_candidate_notices')
                        .insert(recommendation.supportingNoticeIds.map(noticeId => ({
                            candidate_id: data.id,
                            notice_id: noticeId
                        })));
                    if (insertResult.error) throw insertResult.error;
                }
                results.push(data);
            }
            return results;
        },

        async listCategoryCandidates() {
            const { data, error } = await supabase
                .from('category_candidates')
                .select('*, category_candidate_notices(notice_id, notices(id,title))')
                .eq('status', 'pending')
                .order('occurrence_count', { ascending: false });
            if (error) throw error;
            return (data || []).map(candidate => ({
                id: Number(candidate.id),
                normalizedKeyword: candidate.normalized_keyword,
                displayName: candidate.display_name,
                status: candidate.status,
                occurrenceCount: candidate.occurrence_count,
                averageConfidence: candidate.average_confidence,
                firstSeenAt: candidate.first_seen_at,
                lastSeenAt: candidate.last_seen_at,
                supportingNoticeIds: (candidate.category_candidate_notices || [])
                    .map(item => Number(item.notice_id)),
                supportingNotices: (candidate.category_candidate_notices || [])
                    .map(item => item.notices)
                    .filter(Boolean)
                    .map(notice => ({ id: Number(notice.id), title: notice.title }))
            }));
        },

        async decideCategoryCandidate(id, decision) {
            const { data, error } = await supabase.rpc('decide_category_candidate', {
                target_candidate_id: Number(id),
                decision_action: decision.action,
                category_name: decision.name || null,
                category_slug: decision.slug || null,
                target_category_id: decision.categoryId
                    ? Number(decision.categoryId)
                    : null,
                defer_until: decision.deferredUntil || null
            });
            if (error?.message?.includes('CATEGORY_CANDIDATE_NOT_PENDING')) {
                const conflict = new Error('category candidate is not pending');
                conflict.code = 'CATEGORY_CANDIDATE_NOT_PENDING';
                throw conflict;
            }
            if (error) throw error;
            return Array.isArray(data) ? data[0] : data;
        },

        async listCrawlRuns() {
            const { data, error } = await supabase
                .from('crawl_runs')
                .select('*')
                .order('started_at', { ascending: false })
                .limit(100);
            if (error) throw error;
            return data || [];
        }
    };
}

export function createAutomationStore({
    supabase = null,
    useSupabase,
    filePath,
    canonicalCategories = []
}) {
    if (useSupabase) {
        if (!supabase) throw new Error('Supabase client is required');
        return createSupabaseStore(supabase, canonicalCategories);
    }
    if (!filePath) throw new Error('Automation JSON file path is required');
    return createJsonStore(filePath, canonicalCategories);
}
