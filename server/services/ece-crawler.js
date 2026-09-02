import { categoryIdForKey, classifyNoticeCategory } from './notice-classifier.js';

const SOURCE_TYPE = 'ece_academics';

function listPageUrl(baseUrl, page) {
    const url = new URL(baseUrl);
    url.searchParams.set('page', String(page));
    return url.toString();
}

function sourcePublishedAt(date) {
    return date ? `${date}T00:00:00+09:00` : null;
}

function fallbackAnalysis() {
    return {
        summary: [],
        deadline: null,
        targets: ['전체'],
        keywords: [],
        existingCategoryIds: [],
        category: null,
        hasReward: false,
        rewardNote: null,
        requiresAction: false,
        confidence: null,
        analysisStatus: 'failed'
    };
}

export function createEceCrawler({
    store,
    fetchImpl = fetch,
    parser,
    analyzer = null,
    config,
    wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
}) {
    if (!store || !parser || !config) {
        throw new Error('store, parser, and config are required');
    }

    /* 카테고리 id는 저장소마다 다르다. 크롤 한 번에 한 번만 읽고, 읽기가
       실패해도 크롤을 멈추지 않는다 — 키는 남고 id만 비는 편이 낫다. */
    async function loadCategories() {
        if (typeof store.listCategories !== 'function') return [];
        try {
            return await store.listCategories();
        } catch {
            return [];
        }
    }

    /* 분석이 실패했거나 모델이 카테고리를 비워 보낸 공지도 넷 중 하나를
       달고 검수함에 들어간다. 비워 두면 승인 뒤에도 어느 탭에도 안 잡힌다. */
    function withFallbackCategory(analysis, detail, categories) {
        if (analysis.category) return analysis;
        const fallback = classifyNoticeCategory({
            title: detail.title,
            content: detail.content,
            keywords: analysis.keywords
        });
        const categoryId = categoryIdForKey(categories, fallback.key);
        return {
            ...analysis,
            category: fallback.key,
            existingCategoryIds: categoryId === null ? [] : [categoryId],
            categorySource: fallback.source
        };
    }

    async function run({ backfill = false } = {}) {
        const crawlRun = await store.beginCrawlRun(SOURCE_TYPE);
        let requestCount = 0;
        let categories = null;

        async function requestText(url) {
            if (requestCount > 0 && config.requestDelayMs > 0) {
                await wait(config.requestDelayMs);
            } else if (requestCount > 0) {
                await wait(0);
            }
            requestCount += 1;
            const response = await fetchImpl(url, {
                headers: {
                    'User-Agent': 'SNU-ECE-Announcement/1.0 (+https://snu-ece-announcement.pages.dev)'
                },
                signal: AbortSignal.timeout(config.timeoutMs)
            });
            if (!response.ok) {
                throw new Error(`ECE request failed (${response.status})`);
            }
            return response.text();
        }

        try {
            const summaries = new Map();
            const pageCount = backfill ? Math.max(config.pages, 10) : config.pages;
            for (let page = 1; page <= pageCount; page += 1) {
                const url = listPageUrl(config.baseUrl, page);
                const html = await requestText(url);
                for (const summary of parser.parseAcademicsList(html, url)) {
                    summaries.set(String(summary.externalId), summary);
                }
            }

            let createdCount = 0;
            let failedCount = 0;
            const candidates = [];
            for (const summary of summaries.values()) {
                const existing = await store.findNoticeBySource(
                    SOURCE_TYPE,
                    summary.externalId
                );
                if (existing) {
                    await store.recordCrawlItem(crawlRun.id, {
                        sourceExternalId: summary.externalId,
                        status: 'duplicate'
                    });
                } else {
                    candidates.push(summary);
                }
            }

            const limited = candidates.slice(0, config.maxDetails);
            for (const summary of limited) {
                try {
                    const detailHtml = await requestText(summary.sourceUrl);
                    const detail = parser.parseAcademicsDetail(
                        detailHtml,
                        summary.sourceUrl
                    );
                    let analysis = fallbackAnalysis();
                    if (analyzer) {
                        try {
                            analysis = await analyzer.analyzeNotice({
                                title: detail.title,
                                content: detail.content
                            });
                        } catch (error) {
                            // 이 자리에서 오류를 버리면 검수함에 "분석 failed"만
                            // 남고 어느 규칙이 깨졌는지 알 길이 사라진다.
                            console.warn(
                                `공지 분석 실패 (${summary.externalId}): ${error?.message || error}`
                            );
                            analysis = fallbackAnalysis();
                        }
                    }
                    if (!analysis.category) {
                        categories ??= await loadCategories();
                        analysis = withFallbackCategory(analysis, detail, categories);
                    }

                    await store.createPendingNotice({
                        sourceType: SOURCE_TYPE,
                        sourceExternalId: detail.externalId,
                        sourceUrl: detail.sourceUrl,
                        sourcePublishedAt: sourcePublishedAt(detail.publishedDate),
                        lastCrawledAt: new Date().toISOString(),
                        title: analysis.editedTitle || detail.title,
                        content: analysis.editedContent || detail.content,
                        rawTitle: detail.title,
                        rawContent: detail.content,
                        target: '전체',
                        targets: analysis.targets || ['전체'],
                        host: '전기정보공학부',
                        deadline: analysis.deadline,
                        aiSummary: analysis.summary || [],
                        keywords: analysis.keywords || [],
                        surveyReward: analysis.surveyReward || '',
                        category: analysis.category || null,
                        hasReward: analysis.hasReward === true,
                        rewardNote: analysis.rewardNote || null,
                        requiresAction: analysis.requiresAction === true,
                        existingCategoryIds: analysis.existingCategoryIds || [],
                        analysisStatus: analysis.analysisStatus || 'failed',
                        analysisConfidence: analysis.confidence ?? null,
                        attachments: detail.attachments || [],
                        crawlMetadata: { audience: summary.audience }
                    });
                    createdCount += 1;
                    await store.recordCrawlItem(crawlRun.id, {
                        sourceExternalId: summary.externalId,
                        status: 'created'
                    });
                } catch (error) {
                    failedCount += 1;
                    await store.recordCrawlItem(crawlRun.id, {
                        sourceExternalId: summary.externalId,
                        status: 'failed',
                        errorMessage: error.message
                    });
                }
            }

            const result = {
                status: failedCount > 0 ? 'partial' : 'succeeded',
                discoveredCount: summaries.size,
                createdCount,
                failedCount,
                errorMessage: failedCount > 0
                    ? `${failedCount} detail request(s) failed`
                    : null
            };
            await store.finishCrawlRun(crawlRun.id, result);
            return result;
        } catch (error) {
            await store.finishCrawlRun(crawlRun.id, {
                status: 'failed',
                discoveredCount: 0,
                createdCount: 0,
                failedCount: 1,
                errorMessage: error.message
            });
            throw error;
        }
    }

    return { run };
}
