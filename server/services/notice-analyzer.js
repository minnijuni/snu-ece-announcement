import { getGeminiRetryAfterSeconds } from './gemini-rate-limit.js';
import { categoryIdForKey, classifyNoticeCategory, normalizeCategoryKey } from './notice-classifier.js';

export class NoticeAnalysisError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = 'NoticeAnalysisError';
    }
}

function uniqueStrings(values, { limit, maxLength = 200 } = {}) {
    if (!Array.isArray(values)) return [];
    const seen = new Set();
    const result = [];
    for (const rawValue of values) {
        const value = String(rawValue || '').trim().slice(0, maxLength);
        if (!value || seen.has(value)) continue;
        seen.add(value);
        result.push(value);
        if (result.length >= limit) break;
    }
    return result;
}

function isAllowedTarget(value) {
    return value === '전체' || /^\d{2}학번(?: 이상)?$/.test(value);
}

function normalizeDeadline(value) {
    if (value == null || value === '') return null;
    const deadline = String(value).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) {
        throw new NoticeAnalysisError('deadline must be an ISO date or null');
    }
    const date = new Date(`${deadline}T00:00:00Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== deadline) {
        throw new NoticeAnalysisError('deadline is not a valid date');
    }
    return deadline;
}

export function validateNoticeAnalysis(value, activeCategoryIds = new Set()) {
    if (!value || typeof value !== 'object') {
        throw new NoticeAnalysisError('analysis must be an object');
    }

    const summary = uniqueStrings(value.summary, { limit: 3, maxLength: 300 });
    if (summary.length === 0) {
        throw new NoticeAnalysisError('analysis summary is required');
    }

    const targets = uniqueStrings(value.targets, { limit: 20, maxLength: 20 })
        .filter(isAllowedTarget);
    const keywords = uniqueStrings(value.keywords, { limit: 10, maxLength: 40 });
    const existingCategoryIds = Array.from(new Set(
        (Array.isArray(value.existingCategoryIds) ? value.existingCategoryIds : [])
            .map(Number)
            .filter(id => Number.isFinite(id) && activeCategoryIds.has(id))
    )).slice(0, 1);
    const rawConfidence = Number(value.confidence);
    if (!Number.isFinite(rawConfidence)) {
        throw new NoticeAnalysisError('confidence must be numeric');
    }

    return {
        editedTitle: String(value.editedTitle || '').trim().slice(0, 300),
        editedContent: String(value.editedContent || '').trim().slice(0, 30000),
        summary,
        deadline: normalizeDeadline(value.deadline),
        targets: targets.length > 0 ? targets : ['전체'],
        keywords,
        existingCategoryIds,
        rewardNote: String(value.rewardNote || value.surveyReward || '').trim().slice(0, 120) || null,
        hasReward: value.hasReward === true || Boolean(String(value.rewardNote || value.surveyReward || '').trim()),
        requiresAction: value.requiresAction === true,
        surveyReward: String(value.rewardNote || value.surveyReward || '').trim().slice(0, 120),
        verifiedNumbers: uniqueStrings(value.verifiedNumbers, { limit: 12, maxLength: 120 }),
        verificationWarnings: uniqueStrings(value.verificationWarnings, { limit: 8, maxLength: 200 }),
        confidence: Math.min(1, Math.max(0, rawConfidence)),
        analysisStatus: 'succeeded'
    };
}

function buildVerificationPrompt({ title, content, categories, draft, correction }) {
    const categoryList = categories.length > 0
        ? categories.map(category =>
            `${category.id}: ${category.name} — ${category.definition || '이름의 의미를 엄격하게 적용'}`
        ).join('\n')
        : '없음';
    const correctionText = correction
        ? '이전 응답이 스키마를 만족하지 못했습니다. 설명 없이 올바른 JSON만 다시 출력하세요.\n\n'
        : '';
    return `${correctionText}당신은 공지 분석 결과를 독립적으로 재검수하는 두 번째 에이전트입니다.
원문을 처음부터 다시 읽고 1차 결과의 날짜·시각·금액·인원·학점·기간·비율·연락처와 카테고리를 대조하세요.
1차 결과는 틀릴 수 있으므로 그대로 승인하지 말고, 잘못된 항목을 고친 최종 JSON 하나만 출력하세요.

형식:
{
  "editedTitle": "원문의 의미를 유지한 제목",
  "editedContent": "원문의 수치·URL·조건을 보존한 읽기 쉬운 본문",
  "summary": ["검증된 요약 1", "검증된 요약 2", "검증된 요약 3"],
  "deadline": "YYYY-MM-DD 또는 null",
  "startDate": "YYYY-MM-DD 또는 null",
  "targets": ["전체 또는 NN학번"],
  "keywords": ["최대 10개"],
  "existingCategoryIds": [검증된 기존 카테고리 ID],
  "hasReward": true 또는 false,
  "rewardNote": "상품·지원금·할인 등 짧은 표기 또는 null",
  "requiresAction": true 또는 false,
  "verifiedNumbers": ["원문과 대조한 주요 수치"],
  "verificationWarnings": ["관리자 확인이 필요한 불명확한 점"],
  "confidence": 0과 1 사이 숫자
}

검수 원칙:
- 원문에 없는 사실·수치·조건은 모두 제거합니다.
- deadline은 실제 신청 또는 제출 마감이 명확할 때만 지정합니다.
- startDate는 행사가 열리는 날 또는 접수를 받기 시작하는 날입니다.
  "7월 20일 ~ 9월 15일"처럼 기간이 적혀 있으면 앞이 startDate, 뒤가 deadline입니다.
  하루짜리 행사는 startDate만 채우고 deadline은 비웁니다. 근거가 없으면 null입니다.
- 카테고리는 반드시 학사, 기회, 설문, 행사 중 가장 핵심적인 하나만 선택합니다.
- existingCategoryIds는 비워 두지 않습니다. 1차가 비웠으면 원문을 근거로 하나를 고르고, 어느 쪽도 뚜렷하지 않으면 행사를 고릅니다.
- requiresAction은 신청·제출·응답이 필요할 때만 true입니다.
- hasReward는 기프티콘·상품·간식·지원금·할인 등 즉시 확인 가능한 보상이 있을 때만 true입니다.

활성 카테고리:
${categoryList}

원문 제목:
${String(title || '').slice(0, 500)}

원문 본문:
${String(content || '').slice(0, 30000)}

1차 분석:
${JSON.stringify(draft)}`.trim();
}

/* 어느 규칙이 깨졌는지까지 남긴다. "스키마를 만족하지 못했다"만으로는
   운영자가 손쓸 수 없고, 크롤러 로그에도 단서가 남지 않는다. */
function isRateLimited(error) {
    return Number(error?.status) === 429;
}

function describeCause(error) {
    const message = String(error?.message || '').trim();
    return message || 'reason unknown';
}

function parseModelJson(text) {
    const normalized = String(text || '')
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '');
    try {
        return JSON.parse(normalized);
    } catch (error) {
        throw new NoticeAnalysisError('model response is not valid JSON', { cause: error });
    }
}

function buildPrompt({ title, content, categories, correction }) {
    const categoryList = categories.length > 0
        ? categories.map(category =>
            `${category.id}: ${category.name} — ${category.definition || '이름의 의미를 엄격하게 적용'}`
        ).join('\n')
        : '없음';
    const correctionText = correction
        ? '\n이전 응답이 스키마를 만족하지 못했습니다. 설명 없이 올바른 JSON만 다시 출력하세요.\n'
        : '';

    return `${correctionText}
서울대학교 전기정보공학부 공지를 분석하세요.
반드시 다음 JSON 형태만 출력하세요.
{
  "editedTitle": "중복·깨진 문자를 정리한 읽기 쉬운 제목",
  "editedContent": "원문의 사실과 링크를 보존하고 문단·목록만 읽기 쉽게 정돈한 본문",
  "summary": ["핵심 요약 1", "핵심 요약 2", "핵심 요약 3"],
  "deadline": "YYYY-MM-DD 또는 null",
  "startDate": "YYYY-MM-DD 또는 null",
  "targets": ["전체 또는 NN학번"],
  "keywords": ["최대 10개"],
  "existingCategoryIds": [기존 카테고리 ID],
  "hasReward": true 또는 false,
  "rewardNote": "상품·지원금·할인 등 짧은 표기 또는 null",
  "requiresAction": true 또는 false,
  "confidence": 0과 1 사이 숫자
}

카테고리 분류 원칙:
- 학사: 수강·학점·졸업·성적·전공진입에 직접 영향을 줍니다.
- 기회: 인턴·연구실·공모전·대회·장학·교환처럼 선발을 거쳐 자리나 자격을 얻는 것입니다.
- 설문: 설문·인터뷰·실험 피험자·사용자 조사처럼 선발 없이 참여해 응답하면 끝나는 모집입니다.
  사례비나 기프티콘이 걸려 있어도 참여가 목적이면 여기입니다.
- 행사: 학생 자치, 학내 행사, 시설·출입·교통, 제휴·할인 등 캠퍼스 생활 정보입니다.
- 네 카테고리 중 가장 핵심적인 하나만 선택합니다.
- existingCategoryIds에는 활성 카테고리 ID를 정확히 하나 넣습니다. 빈 배열은 허용되지 않습니다.
- 어느 쪽도 뚜렷하지 않으면 캠퍼스 생활 전반을 뜻하는 행사를 고릅니다. 학사 불이익이 걸려 있으면 학사, 선발이 있으면 기회, 응답만 하면 끝나면 설문입니다.
- 기회와 설문은 선발이 있느냐로 가릅니다. 붙고 떨어지는 일이 있으면 기회입니다.
- requiresAction은 신청·제출·응답이 필요할 때 true입니다.
- hasReward는 상품·기프티콘·사례비·지원금·할인 등이 확인될 때 true이며 rewardNote에 짧게 적습니다.
- 제목의 단어만 보지 말고 본문의 행동 요구, 마감, 실제 영향과 수신 대상을 근거로 판단합니다.

편집 원칙:
- editedTitle은 의미를 바꾸거나 정보를 새로 만들지 말고, 깨진 문자·불필요한 반복만 정리합니다.
- editedContent는 날짜·금액·연락처·URL·신청 조건을 임의로 바꾸지 않습니다.
- 긴 덩어리는 빈 줄과 짧은 문단으로 나누고, 나열은 줄바꿈으로 정돈합니다.
- 원문에 없는 사실을 추정하거나 홍보 문구를 덧붙이지 않습니다.

활성 카테고리:
${categoryList}

제목:
${String(title || '').slice(0, 500)}

본문:
${String(content || '').slice(0, 30000)}`.trim();
}

export function createNoticeAnalyzer({
    apiKey,
    model = 'gemini-flash-latest',
    fetchImpl = fetch,
    categoryProvider = async () => [],
    // 무료 등급은 분당 호출 수가 막혀 있다. 크롤 한 번이 스무 건을 연속으로
    // 분석하면 한도를 즉시 넘겨, 그 창 동안 관리자의 수동 편집까지 막힌다.
    minIntervalMs = 6000,
    // 2차 검수는 호출 수를 두 배로 만든다. 무료 등급처럼 하루 한도가 빠듯하면
    // 접을 수 있다. 자동 수집 공지는 어차피 관리자 검수를 거쳐야 공개된다.
    verifyAnalysis = true,
    wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    now = () => Date.now()
}) {
    if (!apiKey) throw new Error('Gemini API key is required');

    let nextCallAt = 0;

    async function pace() {
        const delay = nextCallAt - now();
        if (delay > 0) await wait(delay);
        nextCallAt = now() + minIntervalMs;
    }

    async function generate(prompt) {
        await pace();
        const response = await fetchImpl(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { responseMimeType: 'application/json' }
                })
            }
        );
        const data = await response.json();
        if (!response.ok) {
            const error = new NoticeAnalysisError(
                data?.error?.message || `Gemini request failed (${response.status})`
            );
            error.status = response.status;
            if (response.status === 429) {
                error.retryAfterSeconds = getGeminiRetryAfterSeconds(
                    response.headers?.get?.('retry-after'),
                    data
                );
            }
            throw error;
        }
        return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }

    return {
        async analyzeNotice({ title, content }) {
            const categories = (await categoryProvider())
                .filter(category => category?.isActive !== false)
                .map(category => ({
                    id: Number(category.id),
                    key: String(category.key || ''),
                    name: String(category.name || ''),
                    definition: String(category.definition || '')
                }))
                .filter(category => Number.isFinite(category.id) && category.name);
            const activeCategoryIds = new Set(categories.map(category => category.id));
            let lastError;
            let draft = null;

            for (let attempt = 0; attempt < 2; attempt += 1) {
                try {
                    const prompt = buildPrompt({
                        title,
                        content,
                        categories,
                        correction: attempt > 0
                    });
                    draft = validateNoticeAnalysis(
                        parseModelJson(await generate(prompt)),
                        activeCategoryIds
                    );
                    break;
                } catch (error) {
                    // 한도 초과는 스키마 오류가 아니다. 곧바로 다시 부르면
                    // 남은 한도만 태우고 똑같이 막힌다.
                    if (isRateLimited(error)) throw error;
                    lastError = error;
                }
            }

            if (!draft) {
                throw new NoticeAnalysisError(
                    `Gemini analysis did not satisfy the required schema: ${describeCause(lastError)}`,
                    { cause: lastError }
                );
            }

            /* 모델이 고른 카테고리가 있으면 그대로 쓴다. 비워 보냈으면 다시
               부르지 않는다 — 한 번 더 부르면 무료 등급 한도만 태우고 같은 답이
               오기 쉽다. 대신 규칙 분류기로 메워 어느 탭에든 반드시 잡히게 한다. */
            const withCategory = analysis => {
                const chosen = categories.find(item =>
                    Number(item.id) === Number(analysis.existingCategoryIds[0])
                );
                const modelKey = chosen ? normalizeCategoryKey(chosen.key || chosen.slug) : null;
                if (modelKey) {
                    return { ...analysis, category: modelKey, categorySource: 'model' };
                }
                const fallback = classifyNoticeCategory({
                    title,
                    content,
                    keywords: analysis.keywords
                });
                const categoryId = categoryIdForKey(categories, fallback.key);
                return {
                    ...analysis,
                    category: fallback.key,
                    existingCategoryIds: categoryId === null ? [] : [categoryId],
                    categorySource: 'rules'
                };
            };

            if (!verifyAnalysis) return withCategory(draft);

            // 검수도 분석과 같은 횟수만큼 기회를 준다. 모델 출력은 확률적이라
            // 한 번의 흔들림으로 분석 전체를 버리면 실패율이 그대로 드러난다.
            let verificationError;
            for (let attempt = 0; attempt < 2; attempt += 1) {
                try {
                    const verificationPrompt = buildVerificationPrompt({
                        title,
                        content,
                        categories,
                        draft,
                        correction: attempt > 0
                    });
                    const verified = validateNoticeAnalysis(
                        parseModelJson(await generate(verificationPrompt)),
                        activeCategoryIds
                    );
                    return withCategory(verified);
                } catch (error) {
                    if (isRateLimited(error)) throw error;
                    verificationError = error;
                }
            }

            throw new NoticeAnalysisError(
                `Gemini verification did not satisfy the required schema: ${describeCause(verificationError)}`,
                { cause: verificationError }
            );
        }
    };
}
