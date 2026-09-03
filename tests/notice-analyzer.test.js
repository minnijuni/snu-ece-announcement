import test from 'node:test';
import assert from 'node:assert/strict';
import {
    NoticeAnalysisError,
    createNoticeAnalyzer,
    validateNoticeAnalysis
} from '../server/services/notice-analyzer.js';

test('validateNoticeAnalysis normalizes and constrains model output', () => {
    const analysis = validateNoticeAnalysis({
        summary: [' a ', 'b', 'c', 'd'],
        deadline: '2026-08-10',
        targets: ['25학번', '임의대상', '25학번'],
        keywords: [' 복수전공 ', '복수전공', ...Array.from({ length: 12 }, (_, i) => `키워드${i}`)],
        existingCategoryIds: [1, 999, 1],
        verifiedNumbers: [' 8월 10일 ', '8월 10일'],
        verificationWarnings: ['마감 시각 확인 필요'],
        confidence: 1.3
    }, new Set([1, 2]));

    assert.deepEqual(analysis.summary, ['a', 'b', 'c']);
    assert.deepEqual(analysis.targets, ['25학번']);
    assert.equal(analysis.keywords.length, 10);
    assert.equal(analysis.keywords[0], '복수전공');
    assert.deepEqual(analysis.existingCategoryIds, [1]);
    assert.deepEqual(analysis.verifiedNumbers, ['8월 10일']);
    assert.deepEqual(analysis.verificationWarnings, ['마감 시각 확인 필요']);
    assert.equal(analysis.confidence, 1);
    assert.equal(analysis.analysisStatus, 'succeeded');
});

test('validateNoticeAnalysis rejects missing summaries and invalid deadlines', () => {
    assert.throws(
        () => validateNoticeAnalysis({
            summary: [],
            deadline: 'next week',
            targets: ['전체'],
            keywords: [],
            existingCategoryIds: [],
            confidence: 0.5
        }, new Set()),
        NoticeAnalysisError
    );
});

test('analyzer retries one schema-invalid response and returns corrected JSON', async () => {
    let calls = 0;
    const requests = [];
    const fetchImpl = async (url, options) => {
        calls += 1;
        requests.push({ url: String(url), body: JSON.parse(options.body) });
        const text = calls === 1
            ? '{"summary":[]}'
            : (calls === 2
                ? '```json\n{"summary":["초안"],"deadline":null,"targets":["전체"],"keywords":["수강신청"],"existingCategoryIds":[2],"confidence":0.8}\n```'
                : '{"summary":["검증된 핵심"],"deadline":null,"targets":["전체"],"keywords":["수강신청"],"existingCategoryIds":[2],"verifiedNumbers":["2학기"],"verificationWarnings":[],"confidence":0.9}');
        return {
            ok: true,
            json: async () => ({
                candidates: [{ content: { parts: [{ text }] } }]
            })
        };
    };
    const analyzer = createNoticeAnalyzer({
        apiKey: 'test-key',
        wait: async () => {},
        model: 'gemini-test-model',
        fetchImpl,
        categoryProvider: async () => [{ id: 2, key: 'ACADEMIC', name: '학사' }]
    });

    const result = await analyzer.analyzeNotice({
        title: '수강신청 안내',
        content: '본문'
    });

    assert.equal(calls, 3);
    assert.deepEqual(result.summary, ['검증된 핵심']);
    assert.deepEqual(result.existingCategoryIds, [2]);
    assert.equal(result.category, 'ACADEMIC');
    assert.deepEqual(result.verifiedNumbers, ['2학기']);
    assert.match(requests[0].url, /gemini-test-model:generateContent/);
    assert.match(requests[0].body.contents[0].parts[0].text, /학사: 수강·학점·졸업·성적·전공진입/);
    assert.match(requests[0].body.contents[0].parts[0].text, /네 카테고리 중 가장 핵심적인 하나만 선택/);
    assert.match(
        requests[1].body.contents[0].parts[0].text,
        /이전 응답이 스키마를 만족하지 못했습니다/
    );
    assert.match(requests[2].body.contents[0].parts[0].text, /독립적으로 재검수하는 두 번째 에이전트/);
});

test('analyzer fails after two invalid model responses', async () => {
    const analyzer = createNoticeAnalyzer({
        apiKey: 'test-key',
        wait: async () => {},
        model: 'gemini-test-model',
        fetchImpl: async () => ({
            ok: true,
            json: async () => ({
                candidates: [{ content: { parts: [{ text: 'not json' }] } }]
            })
        }),
        categoryProvider: async () => []
    });

    await assert.rejects(
        () => analyzer.analyzeNotice({ title: '제목', content: '본문' }),
        NoticeAnalysisError
    );
});

test('verification retries with a correction before giving up', async () => {
    // 분석은 스키마를 못 맞추면 교정 프롬프트로 한 번 더 묻는데 2차 검수만
    // 단발이었다. 모델 출력은 확률적이라 한 번의 흔들림이 곧 분석 실패였다.
    const good = JSON.stringify({
        summary: ['핵심'],
        deadline: null,
        targets: ['전체'],
        keywords: ['수강'],
        existingCategoryIds: [2],
        confidence: 0.9
    });
    const bodies = [];
    const replies = [good, '{"summary": []}', good];
    const analyzer = createNoticeAnalyzer({
        apiKey: 'test-key',
        wait: async () => {},
        fetchImpl: async (url, options) => {
            bodies.push(JSON.parse(options.body).contents[0].parts[0].text);
            return {
                ok: true,
                json: async () => ({
                    candidates: [{ content: { parts: [{ text: replies.shift() }] } }]
                })
            };
        },
        categoryProvider: async () => [{ id: 2, key: 'ACADEMIC', name: '학사' }]
    });

    const result = await analyzer.analyzeNotice({ title: '제목', content: '본문' });

    assert.deepEqual(result.summary, ['핵심']);
    // 분석 1회 + 검수 2회.
    assert.equal(bodies.length, 3);
    assert.match(bodies[2], /이전 응답이 스키마를 만족하지 못했습니다/);
});

test('a schema failure names the rule that broke', async () => {
    // "did not satisfy the required schema"만으로는 어느 항목이 문제인지
    // 알 수 없어 운영자가 손쓸 수 없다.
    const analyzer = createNoticeAnalyzer({
        apiKey: 'test-key',
        wait: async () => {},
        fetchImpl: async () => ({
            ok: true,
            json: async () => ({
                candidates: [{
                    content: {
                        parts: [{
                            text: JSON.stringify({
                                summary: ['핵심'],
                                deadline: '다음 주',
                                targets: ['전체'],
                                keywords: [],
                                existingCategoryIds: [],
                                confidence: 0.5
                            })
                        }]
                    }
                }]
            })
        }),
        categoryProvider: async () => []
    });

    await assert.rejects(
        analyzer.analyzeNotice({ title: '제목', content: '본문' }),
        error => {
            assert.match(error.message, /deadline/);
            return true;
        }
    );
});

test('a rate limited call fails fast instead of burning the next attempt', async () => {
    // 429는 스키마 오류가 아니다. 곧바로 다시 부르면 남은 한도만 태우고
    // 똑같이 실패한다. 재시도는 스키마가 틀렸을 때만 의미가 있다.
    let calls = 0;
    const analyzer = createNoticeAnalyzer({
        apiKey: 'test-key',
        wait: async () => {},
        fetchImpl: async () => {
            calls += 1;
            return {
                ok: false,
                status: 429,
                headers: { get: name => (name.toLowerCase() === 'retry-after' ? '47' : null) },
                json: async () => ({ error: { message: 'Quota exceeded. retry in 47s' } })
            };
        },
        categoryProvider: async () => []
    });

    await assert.rejects(
        analyzer.analyzeNotice({ title: '제목', content: '본문' }),
        error => {
            assert.equal(error.status, 429);
            assert.equal(error.retryAfterSeconds, 47);
            return true;
        }
    );
    assert.equal(calls, 1);
});

test('calls are paced so one crawl cannot drain the minute quota', async () => {
    // 크롤 한 번에 스무 건을 연속으로 분석하면 무료 등급 분당 한도를
    // 곧바로 넘긴다. 호출 사이 최소 간격을 지켜야 한다.
    const good = JSON.stringify({
        summary: ['핵심'],
        deadline: null,
        targets: ['전체'],
        keywords: [],
        existingCategoryIds: [],
        confidence: 0.9
    });
    const waited = [];
    const analyzer = createNoticeAnalyzer({
        apiKey: 'test-key',
        wait: async () => {},
        minIntervalMs: 6000,
        wait: async ms => { waited.push(ms); },
        now: (() => { let t = 0; return () => t; })(),
        fetchImpl: async () => ({
            ok: true,
            json: async () => ({ candidates: [{ content: { parts: [{ text: good }] } }] })
        }),
        categoryProvider: async () => []
    });

    await analyzer.analyzeNotice({ title: '제목', content: '본문' });

    // 분석 1회 + 검수 1회. 두 번째 호출 앞에서 간격을 지켜야 한다.
    assert.equal(waited.length, 1);
    assert.equal(waited[0], 6000);
});

test('a transient upstream 503 is retried with backoff before failing the attempt', async () => {
    // Google이 "This model is currently experiencing high demand"으로 응답을 거부하는
    // 순간이 있다. 이건 스키마 문제도 한도 문제도 아니라 잠깐의 부하다.
    // 곧바로 재요청하면 그대로 다시 막힌다. 백오프로 한 번 더 기다린 뒤 성공하면
    // 관리자 흐름이 실패 없이 이어진다.
    const good = JSON.stringify({
        summary: ['핵심'],
        deadline: null,
        targets: ['전체'],
        keywords: [],
        existingCategoryIds: [2],
        confidence: 0.9
    });
    const responses = [
        { ok: false, status: 503, message: 'This model is currently experiencing high demand. Please try again later.' },
        { ok: true, text: good },
        { ok: true, text: good }
    ];
    const backoffs = [];
    const analyzer = createNoticeAnalyzer({
        apiKey: 'test-key',
        wait: async ms => { backoffs.push(ms); },
        minIntervalMs: 0,
        transientBackoffMs: [10, 20, 40],
        fetchImpl: async () => {
            const next = responses.shift();
            if (next.ok) {
                return {
                    ok: true,
                    json: async () => ({ candidates: [{ content: { parts: [{ text: next.text }] } }] })
                };
            }
            return {
                ok: false,
                status: next.status,
                headers: { get: () => null },
                json: async () => ({ error: { message: next.message } })
            };
        },
        categoryProvider: async () => [{ id: 2, key: 'ACADEMIC', name: '학사' }]
    });

    const result = await analyzer.analyzeNotice({ title: '제목', content: '본문' });

    assert.deepEqual(result.summary, ['핵심']);
    // 첫 시도가 503으로 실패하면 백오프를 한 번 삽입해야 한다.
    assert.ok(backoffs.some(ms => ms === 10), `expected 10ms transient backoff, got ${backoffs}`);
});

test('exhausted transient retries surface the upstream message, not a schema wrapper', async () => {
    // 이전에는 상위에서 "did not satisfy the required schema: ..."로 감싸버려
    // 관리자 화면에는 스키마 오류로 보였다. 원인을 오해하고 프롬프트만 뜯어봤다.
    // 업스트림 오류는 원문과 status를 그대로 노출해야 한다.
    const analyzer = createNoticeAnalyzer({
        apiKey: 'test-key',
        wait: async () => {},
        transientBackoffMs: [1, 1, 1],
        fetchImpl: async () => ({
            ok: false,
            status: 503,
            headers: { get: () => null },
            json: async () => ({
                error: { message: 'This model is currently experiencing high demand. Please try again later.' }
            })
        }),
        categoryProvider: async () => []
    });

    await assert.rejects(
        analyzer.analyzeNotice({ title: '제목', content: '본문' }),
        error => {
            assert.equal(error.status, 503);
            assert.equal(error.code, 'GEMINI_UPSTREAM_UNAVAILABLE');
            assert.match(error.message, /high demand/);
            assert.doesNotMatch(error.message, /did not satisfy the required schema/);
            return true;
        }
    );
});

test('a fallback model takes over when the primary keeps returning transient errors', async () => {
    // gemini-flash-latest가 부하로 자리를 비운 사이에도 lite/2.0 계열은 여유가 있다.
    // 폴백 모델을 지정하면 관리자 흐름이 실패 없이 이어진다.
    const good = JSON.stringify({
        summary: ['핵심'],
        deadline: null,
        targets: ['전체'],
        keywords: [],
        existingCategoryIds: [2],
        confidence: 0.9
    });
    const modelsUsed = [];
    const analyzer = createNoticeAnalyzer({
        apiKey: 'test-key',
        wait: async () => {},
        model: 'gemini-flash-latest',
        fallbackModels: ['gemini-2.5-flash-lite'],
        transientBackoffMs: [1, 1],
        fetchImpl: async url => {
            const modelMatch = String(url).match(/models\/([^:]+):generateContent/);
            const usedModel = modelMatch ? modelMatch[1] : 'unknown';
            modelsUsed.push(usedModel);
            if (usedModel === 'gemini-flash-latest') {
                return {
                    ok: false,
                    status: 503,
                    headers: { get: () => null },
                    json: async () => ({ error: { message: 'high demand' } })
                };
            }
            return {
                ok: true,
                json: async () => ({ candidates: [{ content: { parts: [{ text: good }] } }] })
            };
        },
        categoryProvider: async () => [{ id: 2, key: 'ACADEMIC', name: '학사' }]
    });

    const result = await analyzer.analyzeNotice({ title: '제목', content: '본문' });

    assert.deepEqual(result.summary, ['핵심']);
    assert.ok(
        modelsUsed.includes('gemini-2.5-flash-lite'),
        `expected fallback to be tried, got ${modelsUsed.join(',')}`
    );
});

test('the second pass can be turned off to halve the daily quota cost', async () => {
    // 무료 등급은 하루 호출 수가 막혀 있다. 공지 1건에 두 번 부르면
    // 하루에 검수함에 넣을 수 있는 공지가 절반으로 준다.
    // 자동 수집 공지는 어차피 사람이 검수해야 공개되므로 2차 검수는 접을 수 있다.
    let calls = 0;
    const analyzer = createNoticeAnalyzer({
        apiKey: 'test-key',
        wait: async () => {},
        verifyAnalysis: false,
        fetchImpl: async () => {
            calls += 1;
            return {
                ok: true,
                json: async () => ({
                    candidates: [{
                        content: {
                            parts: [{
                                text: JSON.stringify({
                                    summary: ['핵심'],
                                    deadline: null,
                                    targets: ['전체'],
                                    keywords: [],
                                    existingCategoryIds: [2],
                                    confidence: 0.9
                                })
                            }]
                        }
                    }]
                })
            };
        },
        categoryProvider: async () => [{ id: 2, key: 'ACADEMIC', name: '학사' }]
    });

    const result = await analyzer.analyzeNotice({ title: '제목', content: '본문' });

    assert.equal(calls, 1);
    assert.deepEqual(result.summary, ['핵심']);
    // 카테고리는 1차 결과에서도 그대로 이어져야 한다.
    assert.equal(result.category, 'ACADEMIC');
});
