import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAutomationStore } from '../server/storage/automation-store.js';
import { createEceCrawler } from '../server/services/ece-crawler.js';

function response(body, ok = true) {
    return {
        ok,
        status: ok ? 200 : 500,
        text: async () => body
    };
}

test('crawler checks configured pages and creates only unknown notices', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ece-crawler-'));
    const store = createAutomationStore({
        useSupabase: false,
        filePath: path.join(directory, 'automation.json')
    });
    await store.createPendingNotice({
        sourceType: 'ece_academics',
        sourceExternalId: 'known',
        title: 'known',
        content: 'known',
        status: 'pending_review'
    });

    const requestedUrls = [];
    const waits = [];
    const fetchImpl = async url => {
        requestedUrls.push(String(url));
        return response(String(url).includes('md=v') ? 'detail' : 'list');
    };
    const parser = {
        parseAcademicsList: (_html, url) => {
            const page = new URL(url).searchParams.get('page') || '1';
            return [
                {
                    externalId: page === '1' ? 'known' : `new-${page}`,
                    audience: '학부',
                    title: `title-${page}`,
                    sourceUrl: `https://ece.snu.ac.kr/community/academics?md=v&bbsidx=${page}`,
                    publishedDate: '2026-07-01'
                }
            ];
        },
        parseAcademicsDetail: (_html, sourceUrl) => ({
            externalId: new URL(sourceUrl).searchParams.get('bbsidx'),
            title: 'detail title',
            content: 'detail content',
            publishedDate: '2026-07-01',
            attachments: [],
            sourceUrl
        })
    };
    const analyzer = {
        analyzeNotice: async () => ({
            summary: ['요약'],
            deadline: null,
            targets: ['전체'],
            keywords: ['수강신청'],
            existingCategoryIds: [],
            confidence: 0.9,
            analysisStatus: 'succeeded'
        })
    };
    const crawler = createEceCrawler({
        store,
        fetchImpl,
        parser,
        analyzer,
        config: {
            baseUrl: 'https://ece.snu.ac.kr/community/academics',
            pages: 3,
            maxDetails: 20,
            requestDelayMs: 1000,
            timeoutMs: 10000
        },
        wait: async milliseconds => waits.push(milliseconds)
    });

    const result = await crawler.run();

    assert.equal(result.discoveredCount, 3);
    assert.equal(result.createdCount, 2);
    assert.equal(result.failedCount, 0);
    assert.equal(requestedUrls.filter(url => !url.includes('md=v')).length, 3);
    assert.equal(requestedUrls.filter(url => url.includes('md=v')).length, 2);
    assert.deepEqual(waits, [1000, 1000, 1000, 1000]);

    const rerun = await crawler.run();
    assert.equal(rerun.createdCount, 0);
});

test('crawler caps detail requests and records partial failures', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ece-crawler-cap-'));
    const store = createAutomationStore({
        useSupabase: false,
        filePath: path.join(directory, 'automation.json')
    });
    let detailRequests = 0;
    const fetchImpl = async url => {
        if (String(url).includes('md=v')) {
            detailRequests += 1;
            return response('detail', detailRequests !== 2);
        }
        return response('list');
    };
    const summaries = Array.from({ length: 25 }, (_value, index) => ({
        externalId: String(index + 1),
        audience: '학부',
        title: `title-${index + 1}`,
        sourceUrl: `https://ece.snu.ac.kr/community/academics?md=v&bbsidx=${index + 1}`,
        publishedDate: '2026-07-01'
    }));
    const crawler = createEceCrawler({
        store,
        fetchImpl,
        parser: {
            parseAcademicsList: () => summaries,
            parseAcademicsDetail: (_html, sourceUrl) => ({
                externalId: new URL(sourceUrl).searchParams.get('bbsidx'),
                title: 'title',
                content: 'content',
                publishedDate: '2026-07-01',
                attachments: [],
                sourceUrl
            })
        },
        analyzer: null,
        config: {
            baseUrl: 'https://ece.snu.ac.kr/community/academics',
            pages: 1,
            maxDetails: 20,
            requestDelayMs: 0,
            timeoutMs: 10000
        },
        wait: async () => {}
    });

    const result = await crawler.run();

    assert.equal(detailRequests, 20);
    assert.equal(result.status, 'partial');
    assert.equal(result.createdCount, 19);
    assert.equal(result.failedCount, 1);
});

test('a failed analysis says why in the log instead of vanishing', async () => {
    // 빈 catch가 오류를 통째로 버려서, 검수함에 "분석 failed"만 남고
    // 어느 규칙이 깨졌는지 로그에도 단서가 없었다.
    const directory = await mkdtemp(path.join(tmpdir(), 'ece-crawler-'));
    const store = createAutomationStore({
        useSupabase: false,
        filePath: path.join(directory, 'automation.json')
    });

    const fetchImpl = async url => response(String(url).includes('md=v') ? 'detail' : 'list');
    const parser = {
        parseAcademicsList: () => [{
            externalId: 'only',
            audience: '학부',
            title: 'title',
            sourceUrl: 'https://ece.snu.ac.kr/community/academics?md=v&bbsidx=1',
            publishedDate: '2026-07-01'
        }],
        parseAcademicsDetail: (_html, sourceUrl) => ({
            externalId: 'only',
            title: 'detail title',
            content: 'detail content',
            publishedDate: '2026-07-01',
            attachments: [],
            sourceUrl
        })
    };
    const analyzer = {
        analyzeNotice: async () => {
            throw new Error('deadline must be an ISO date or null');
        }
    };

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));

    try {
        const crawler = createEceCrawler({
            store,
            fetchImpl,
            parser,
            analyzer,
            config: {
                baseUrl: 'https://ece.snu.ac.kr/community/academics',
                pages: 1,
                maxDetails: 5,
                requestDelayMs: 0,
                timeoutMs: 10000
            },
            wait: async () => {}
        });
        await crawler.run();
    } finally {
        console.warn = originalWarn;
    }

    const reported = warnings.join('\n');
    assert.match(reported, /deadline must be an ISO date or null/);
    // 어느 공지에서 났는지도 알 수 있어야 손을 댈 수 있다.
    assert.match(reported, /only/);
});

test('crawler assigns a category even when analysis is unavailable', async () => {
    // 분석이 실패한 공지가 category null로 검수함에 쌓이고, 승인한 뒤에도
    // 어느 탭에도 안 잡혔다. 규칙 분류기가 넷 중 하나를 달아 준다.
    const { CANONICAL_NOTICE_CATEGORIES } = await import('../server/config/notice-categories.js');
    const directory = await mkdtemp(path.join(tmpdir(), 'ece-crawler-category-'));
    const store = createAutomationStore({
        useSupabase: false,
        filePath: path.join(directory, 'automation.json'),
        canonicalCategories: CANONICAL_NOTICE_CATEGORIES
    });
    const warn = console.warn;
    console.warn = () => {};
    try {
        const crawler = createEceCrawler({
            store,
            fetchImpl: async url => response(String(url).includes('md=v') ? 'detail' : 'list'),
            parser: {
                parseAcademicsList: () => [{
                    externalId: '77',
                    audience: '학부',
                    title: '2026학년도 2학기 수강신청 안내',
                    sourceUrl: 'https://ece.snu.ac.kr/community/academics?md=v&bbsidx=77',
                    publishedDate: '2026-07-01'
                }],
                parseAcademicsDetail: (_html, sourceUrl) => ({
                    externalId: '77',
                    title: '2026학년도 2학기 수강신청 안내',
                    content: '수강신청 기간을 안내합니다.',
                    publishedDate: '2026-07-01',
                    attachments: [],
                    sourceUrl
                })
            },
            analyzer: {
                analyzeNotice: async () => {
                    throw new Error('quota exhausted');
                }
            },
            config: {
                baseUrl: 'https://ece.snu.ac.kr/community/academics',
                pages: 1,
                maxDetails: 5,
                requestDelayMs: 0,
                timeoutMs: 1000
            },
            wait: async () => {}
        });

        await crawler.run();
    } finally {
        console.warn = warn;
    }

    const [notice] = await store.listReviewNotices();
    const academic = (await store.listCategories()).find(category => category.key === 'ACADEMIC');
    assert.equal(notice.analysisStatus, 'failed');
    assert.equal(notice.category, 'ACADEMIC');
    assert.deepEqual(notice.categoryIds, [academic.id]);
});
