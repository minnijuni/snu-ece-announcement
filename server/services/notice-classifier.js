/* 공지를 학사·기회·설문·행사 넷 중 하나로 반드시 배정하는 규칙 분류기.

   카테고리는 Gemini가 고르는 것이 원칙이다. 그런데 모델이 existingCategoryIds를
   비워 보내거나, 분석 자체가 실패하거나, 관리자가 카테고리 없이 손으로 올리면
   category가 null로 남고 그 공지는 '전체' 탭 말고는 어디에도 나타나지 않았다.
   운영 데이터를 세어 보니 공개 공지의 절반이 그랬다.

   이 모듈은 모델의 판단이 있으면 그것을 그대로 쓰고, 없을 때만 제목·키워드·
   본문의 단서로 점수를 매겨 하나를 고른다. 아무 단서도 없으면 캠퍼스 생활 전반을
   뜻하는 행사(COMMUNITY)로 둔다. 네 카테고리의 정의상 행사가 "놓쳐도 학사상
   불이익이 없는 나머지 전부"이기 때문이다. */
import { CANONICAL_NOTICE_CATEGORIES } from '../config/notice-categories.js';

export const DEFAULT_NOTICE_CATEGORY = 'COMMUNITY';

/* 예전 스키마의 키와 slug. '혜택'은 기회와 갈라지지 않아 없앴고, 제휴·할인은
   카테고리 정의대로 행사(캠퍼스 생활)로 간다. */
export const LEGACY_NOTICE_CATEGORY_MAP = Object.freeze({
    BENEFIT: 'COMMUNITY',
    BENEFITS: 'COMMUNITY',
    benefit: 'COMMUNITY',
    benefits: 'COMMUNITY',
    'benefits-partnerships': 'COMMUNITY',
    academics: 'ACADEMIC',
    campus: 'COMMUNITY',
    governance: 'COMMUNITY'
});

const CANONICAL_KEYS = new Set(CANONICAL_NOTICE_CATEGORIES.map(category => category.key));
const KEY_BY_SLUG = new Map(CANONICAL_NOTICE_CATEGORIES.map(category => [category.slug, category.key]));
const KEY_BY_NAME = new Map(CANONICAL_NOTICE_CATEGORIES.map(category => [category.name, category.key]));
const SLUG_BY_KEY = new Map(CANONICAL_NOTICE_CATEGORIES.map(category => [category.key, category.slug]));

/* 동점일 때의 우선순위. 학사는 놓치면 불이익이 있으니 가장 먼저, 행사는
   나머지 전부를 받는 칸이니 가장 나중이다. 설문은 아래 결정 규칙이 먼저
   잡아가므로 여기까지 오는 일이 드물다. */
const TIE_ORDER = Object.freeze(['ACADEMIC', 'OPPORTUNITY', 'SURVEY', 'COMMUNITY']);

/* 제목은 본문보다 훨씬 믿을 만하다. 본문은 인사말·계좌·링크가 절반이라
   단어 하나가 우연히 걸리기 쉬우니 가중치를 낮게 둔다. */
const SOURCE_WEIGHTS = Object.freeze({ title: 3, keywords: 2, host: 1, content: 1 });
const CONTENT_LEAD_LENGTH = 1500;

/* 같은 규칙은 한 출처에서 한 번만 센다. 본문에 '학생회'가 열 번 나온다고
   열 배가 되면 긴 인사말이 분류를 좌우한다. */
const RULES = Object.freeze([
    /* 설문. 제목에 이 단어가 있으면 다른 단서와 상관없이 설문이다. 학사 제도에
       대한 인식조사는 학사 공지가 아니라 설문 공지다. */
    {
        key: 'SURVEY',
        weight: 4,
        decisive: true,
        pattern: /설문|서베이|survey|인식\s*조사|실태\s*조사|만족도\s*조사|수요\s*조사|의견\s*조사|피험자|실험\s*참(?:여|가)자|응답자|사용자\s*조사|\bFGI\b/i
    },
    {
        key: 'SURVEY',
        weight: 2,
        pattern: /인터뷰|면담|리서치|응답|의견\s*수렴|참여자\s*모집|사례비/
    },

    /* 학사. 수강·학점·졸업·성적·등록처럼 학사 상태에 직접 닿는 말. */
    {
        key: 'ACADEMIC',
        weight: 4,
        pattern: /수강\s*신청|수강\s*정정|수강\s*지도|수강\s*취소|수강\s*철회|졸업\s*(?:신청|요건|사정|논문|프로젝트|심사|예정)|학위\s*수여|전공\s*진입|등록금|성적\s*(?:평가|정정|공시|이의|열람|확인|입력)|학점\s*(?:인정|교류|취득|이수)|휴학|복학|재입학|제적|초안지|정원\s*외/
    },
    {
        key: 'ACADEMIC',
        weight: 3,
        pattern: /교과목|개설\s*(?:강좌|과목|교과)|강의\s*평가|계절\s*(?:학기|수업)|학사\s*(?:일정|달력|안내|정보|제도|경고|운영)|복수\s*전공|부전공|연계\s*전공|다전공|전과\b|편입|선이수|이수\s*(?:요건|기준|구분|인정|체계)|학적|졸업|성적|학점|중복\s*인정|영역\s*인정|교류\s*수업|원격\s*수업|시험\s*(?:일정|시간|장소|안내)|중간고사|기말고사|\beTL\b|수업\s*(?:일정|시간|운영|계획|방식|안내)|논문|학위/i
    },
    {
        // '수강료'는 제휴 할인 공지에 나오는 말이라 뺀다.
        key: 'ACADEMIC',
        weight: 2,
        pattern: /수강(?!료)|학사|수업|시험|시간표|전공|교육과정/
    },

    /* 기회. 선발을 거쳐 자리·자격·돈을 얻는 것. */
    {
        key: 'OPPORTUNITY',
        weight: 4,
        pattern: /인턴|공모전|경진\s*대회|장학|교환\s*학생|해외\s*파견|채용|리크루팅|recruit|연구\s*참여|학부\s*연구생|연구실\s*(?:모집|인턴|소개|탐방)|랩\s*(?:인턴|모집)|서포터즈|홍보\s*대사|기자단|튜터\s*모집|조교\s*모집|근로\s*장학|멘토\s*모집|멘티\s*모집|선발/i
    },
    {
        key: 'OPPORTUNITY',
        weight: 3,
        pattern: /대회|캠프|해커톤|아이디어톤|공모|지원\s*사업|지원금|창업|스타트업|전형|합격|어워드|award|수상|취업|커리어|진로|박람회|파견|연수|입사|경력|현장\s*실습|산학|프로그램\s*모집/i
    },
    {
        /* '모집'은 행사 참가자·부스 운영자·설문 응답자에도 붙는 말이라 약하게만
           센다. 참가자 모집 하나로 축제 공지가 기회로 넘어가면 안 된다. */
        key: 'OPPORTUNITY',
        weight: 2,
        pattern: /참가자\s*모집/
    },
    {
        key: 'OPPORTUNITY',
        weight: 1,
        pattern: /모집|지원\s*자격|신청\s*자격/
    },

    /* 행사. 학생 자치, 학내 행사, 시설·교통, 제휴·할인. 캠퍼스 생활 전반. */
    {
        key: 'COMMUNITY',
        weight: 4,
        pattern: /축제|행사|제휴|할인|쿠폰|장터|셔틀|정전|단수|출입\s*통제|공사|휴관|폐쇄|학생회비|총회|대의원|대표자\s*회의|선거|투표|의안|회칙|자치|공동구매|공구\b/
    },
    {
        key: 'COMMUNITY',
        weight: 3,
        pattern: /집행부|집행위원|운영위원|부스|포토|강연|특강|세미나|워크숍|워크샵|토크|콘서트|공연|전시|캠페인|설명회|간담회|홈커밍|동문|기념품|증정|나눔|간식|굿즈|시설|강의실|열람실|주차|교통|버스|캠퍼스|운영\s*시간|이용\s*(?:안내|제한|시간)|점검|홈페이지|사이트|앱\b|시범\s*운영|공지방|분실물|식당|카페|기숙사|생활관|보건|상담|도서관|체육|동아리|소모임|엠티|앨범|촬영|인권|안전|복지|환경\s*개선|이벤트|부대행사|세션|네트워킹/i
    },
    {
        /* 학생회 공지는 주제가 뭐든 머리에 [학생회]가 붙는다. 약한 사전
           확률로만 두어, 학사달력 안내 같은 것은 학사로 가게 한다. */
        key: 'COMMUNITY',
        weight: 1,
        pattern: /학생회|학우|학생\s*자치/
    }
]);

function normalizeText(value) {
    return String(value ?? '')
        .normalize('NFKC')
        .replace(/\s+/g, ' ')
        .trim();
}

export function normalizeCategoryKey(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    const upper = raw.toUpperCase();
    if (CANONICAL_KEYS.has(upper)) return upper;
    if (Object.hasOwn(LEGACY_NOTICE_CATEGORY_MAP, raw)) return LEGACY_NOTICE_CATEGORY_MAP[raw];
    if (Object.hasOwn(LEGACY_NOTICE_CATEGORY_MAP, upper)) return LEGACY_NOTICE_CATEGORY_MAP[upper];
    const lower = raw.toLowerCase();
    if (KEY_BY_SLUG.has(lower)) return KEY_BY_SLUG.get(lower);
    if (Object.hasOwn(LEGACY_NOTICE_CATEGORY_MAP, lower)) return LEGACY_NOTICE_CATEGORY_MAP[lower];
    if (KEY_BY_NAME.has(raw)) return KEY_BY_NAME.get(raw);
    return null;
}

export function categorySlugForKey(key) {
    return SLUG_BY_KEY.get(normalizeCategoryKey(key)) || null;
}

export function classifyNoticeCategory({ title, content, keywords, host } = {}) {
    const sources = {
        title: normalizeText(title),
        keywords: normalizeText(Array.isArray(keywords) ? keywords.join(' ') : keywords),
        host: normalizeText(host),
        content: normalizeText(content).slice(0, CONTENT_LEAD_LENGTH)
    };
    const scores = Object.fromEntries(TIE_ORDER.map(key => [key, 0]));
    const matched = [];

    for (const rule of RULES) {
        if (rule.decisive && rule.pattern.test(sources.title)) {
            return { key: rule.key, scores, matched: [`title:${rule.key}:decisive`], source: 'rules' };
        }
        for (const [source, weight] of Object.entries(SOURCE_WEIGHTS)) {
            if (!sources[source] || !rule.pattern.test(sources[source])) continue;
            scores[rule.key] += rule.weight * weight;
            matched.push(`${source}:${rule.key}:${rule.weight}`);
        }
    }

    let best = null;
    for (const key of TIE_ORDER) {
        if (scores[key] > 0 && (best === null || scores[key] > scores[best])) best = key;
    }
    if (best === null) {
        return { key: DEFAULT_NOTICE_CATEGORY, scores, matched, source: 'default' };
    }
    return { key: best, scores, matched, source: 'rules' };
}

/* 카테고리 목록에서 키에 해당하는 활성 카테고리 id를 찾는다. 파일 저장소는
   key를 들고 있고 Supabase는 slug만 있으므로 둘 다 본다. */
export function categoryIdForKey(categories, key) {
    const wanted = normalizeCategoryKey(key);
    if (!wanted) return null;
    const match = (categories || []).find(category =>
        category?.isActive !== false
        && normalizeCategoryKey(category.key || category.slug) === wanted
    );
    return match ? Number(match.id) : null;
}

/* 이미 정해진 값이 있으면 그것(예전 키는 현재 키로 바꿔서), 없으면 규칙으로. */
export function resolveNoticeCategory(existing, notice = {}) {
    return normalizeCategoryKey(existing) || classifyNoticeCategory(notice).key;
}

/* 공지 한 건의 category와 categoryIds를 같은 곳을 가리키게 채운다. 목록의 탭
   필터는 categoryIds로 거르고 카드와 앱은 category 키를 보므로, 한쪽만 채우면
   여전히 어느 탭에도 안 잡힌다. 이미 맞는 값이 있으면 손대지 않는다. */
export function ensureNoticeCategory(notice = {}, categories = []) {
    const keyById = new Map((categories || []).map(category => [
        Number(category.id),
        normalizeCategoryKey(category.key || category.slug)
    ]));
    const categoryIds = Array.from(new Set(
        (Array.isArray(notice.categoryIds) ? notice.categoryIds : [])
            .map(Number)
            .filter(id => Number.isFinite(id))
    ));
    const storedKey = normalizeCategoryKey(notice.category)
        || categoryIds.map(id => keyById.get(id)).find(Boolean)
        || null;
    const classification = storedKey ? null : classifyNoticeCategory(notice);
    const category = storedKey || classification.key;
    const categoryId = categoryIdForKey(categories, category);
    const hasRow = categoryId !== null && categoryIds.includes(categoryId);
    return {
        category,
        categoryIds: hasRow || categoryId === null ? categoryIds : [categoryId, ...categoryIds],
        categorySource: storedKey ? 'stored' : classification.source,
        changed: !storedKey || (categoryId !== null && !hasRow) || normalizeCategoryKey(notice.category) !== category
    };
}
