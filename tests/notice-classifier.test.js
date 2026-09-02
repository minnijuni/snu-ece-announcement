import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_NOTICE_CATEGORY,
    categoryIdForKey,
    categorySlugForKey,
    classifyNoticeCategory,
    ensureNoticeCategory,
    normalizeCategoryKey,
    resolveNoticeCategory
} from '../server/services/notice-classifier.js';

const CATEGORIES = [
    { id: 1, key: 'ACADEMIC', slug: 'academic', name: '학사' },
    { id: 2, key: 'OPPORTUNITY', slug: 'opportunity', name: '기회' },
    { id: 3, key: 'SURVEY', slug: 'survey', name: '설문' },
    { id: 4, key: 'COMMUNITY', slug: 'community', name: '행사' },
    { id: 5, slug: 'benefit', name: '혜택', isActive: false }
];

test('notices that used to have no category land in one of the four', () => {
    // 운영 데이터에서 category가 비어 있어 '전체' 탭에만 나오던 공지들.
    const cases = [
        ['[학생회] 2026 서울대학교 연합축제 BLUEPRINT 포토부스 안내', '연합축제 포토부스 전용 프레임을 소개합니다.', 'COMMUNITY'],
        ['[학생회] [학생회비 납부 관련 안내]', '학생회비 납부 방법 안내드립니다.', 'COMMUNITY'],
        ['[SNU ECE 공지방 웹 시범운영 안내]', '웹사이트 기반 공지전달 공간을 2주간 시범운영합니다.', 'COMMUNITY'],
        ['[학생회] [공과대학 9월 교육환경 실태조사] 설문', '교육환경 실태조사를 진행합니다.', 'SURVEY'],
        ['[서울대학교 제도혁신위원회] 학사 대학원 연계과정 및 다전공 인식조사', '의견을 수렴하고자 설문조사를 실시합니다.', 'SURVEY'],
        ['[학생회] 9월 학사달력 안내', '새로운 학기의 리듬이 다시 자리 잡습니다.', 'ACADEMIC'],
        ['2026학년도 2학기 개설 공통교육과정 교과목 성적평가방법 변경 안내', '변경 기간과 방법을 안내드립니다.', 'ACADEMIC'],
        ['[그린바이오 혁신융합대학사업단] 2026학년도 2학기 개설 교과목 홍보', '수강신청 기간: 8. 7.(금) ~ 8. 11.(화)', 'ACADEMIC'],
        ['[교양 수학 모의고사 문제 공모전]', '출제될 문제를 선발하는 문제 공모전을 진행합니다.', 'OPPORTUNITY'],
        ['2027학년도 1학기 본부 해외파견 교환학생 후보자 모집 안내', '', 'OPPORTUNITY'],
        ['[학생회] 창업캠프 The Ignition 참가자 모집', '', 'OPPORTUNITY'],
        ['[서울대학교 총학생회 X Adobe 제휴 안내]', 'Adobe 공동구매를 진행하고자 수요조사를 진행합니다.', 'COMMUNITY'],
        ["먹거리장터 '별별요리사' & 예술장터 '별별예술가' 참가자 추가 모집", '축제에 즐거움을 더할 음식들의 향연', 'COMMUNITY'],
        ['[2026 상반기 정기 전체학생대표자회의 의안 공고]', '총학생회칙 제22조에 의거하여 의안을 공고합니다.', 'COMMUNITY'],
        ['[4월 광역셔틀(용인-성남) 신청]', '용인-성남 노선으로 광역셔틀 운행을 재개합니다.', 'COMMUNITY'],
        ['💡28동 강의실 전수조사 안내💡', '강의실 환경 개선을 위해 전수조사 사업을 진행합니다.', 'COMMUNITY'],
        ['[재난 인권 강의 참가 신청]', '재난과 권리를 주제로 강연을 진행합니다.', 'COMMUNITY'],
        ['[4월 문화행사 달력 게재 모집 연장 안내]', '4월 문화행사 달력을 배포하고자 합니다.', 'COMMUNITY'],
        ['[학생회] 엔지니어랩 전기쌍기사 수강료 90% 할인 지원', '선착순 10명 수강료 지원. 제휴 혜택.', 'COMMUNITY']
    ];
    for (const [title, content, expected] of cases) {
        assert.equal(classifyNoticeCategory({ title, content }).key, expected, title);
    }
});

test('the classifier agrees with the model on notices the model already placed', () => {
    const cases = [
        ['제80회 후기 학위수여식 및 학부 졸업행사 안내', 'ACADEMIC'],
        ['2026학년도 2학기 등록금 수납계획 알림', 'ACADEMIC'],
        ['2026학년도 하계 계절학기 강의평가 실시 안내', 'ACADEMIC'],
        ['2026학년도 2학기 등록, 복학, 재입학 및 휴학 안내', 'ACADEMIC'],
        ['[전기공학설계프로젝트] 결과보고서 폐지 및 논문 작성 안내', 'ACADEMIC'],
        ['교과목 중복인정 신청 메뉴 오픈 알림', 'ACADEMIC']
    ];
    for (const [title, expected] of cases) {
        assert.equal(classifyNoticeCategory({ title }).key, expected, title);
    }
});

test('a survey word in the title outranks academic words around it', () => {
    // 학사 제도에 대한 인식조사는 학사 공지가 아니라 설문 공지다.
    const result = classifyNoticeCategory({
        title: '학사·대학원 연계과정 및 다전공 인식조사',
        content: '수강신청, 학점, 졸업 요건에 대한 의견을 듣습니다.'
    });
    assert.equal(result.key, 'SURVEY');
});

test('a notice with no clue at all falls back to 행사', () => {
    const result = classifyNoticeCategory({ title: '[샤人AI: 선배에게 듣는 AI 현장 이야기]', content: '' });
    assert.equal(result.key, DEFAULT_NOTICE_CATEGORY);
    assert.equal(result.source, 'default');
});

test('model keywords count when the title says nothing', () => {
    assert.equal(classifyNoticeCategory({ title: '안내', keywords: ['수강신청', '정정'] }).key, 'ACADEMIC');
});

test('legacy keys, slugs, and names normalize to the current four', () => {
    assert.equal(normalizeCategoryKey('BENEFIT'), 'COMMUNITY');
    assert.equal(normalizeCategoryKey('benefits-partnerships'), 'COMMUNITY');
    assert.equal(normalizeCategoryKey('academics'), 'ACADEMIC');
    assert.equal(normalizeCategoryKey('opportunity'), 'OPPORTUNITY');
    assert.equal(normalizeCategoryKey('설문'), 'SURVEY');
    assert.equal(normalizeCategoryKey(' academic '), 'ACADEMIC');
    assert.equal(normalizeCategoryKey('banner'), null);
    assert.equal(normalizeCategoryKey(''), null);
    assert.equal(normalizeCategoryKey(undefined), null);
    assert.equal(categorySlugForKey('COMMUNITY'), 'community');
    assert.equal(resolveNoticeCategory('BENEFIT', { title: '졸업 안내' }), 'COMMUNITY');
    assert.equal(resolveNoticeCategory(null, { title: '졸업 안내' }), 'ACADEMIC');
});

test('categoryIdForKey resolves by key or slug and skips inactive rows', () => {
    assert.equal(categoryIdForKey(CATEGORIES, 'ACADEMIC'), 1);
    assert.equal(categoryIdForKey([{ id: 9, slug: 'survey' }], 'SURVEY'), 9);
    assert.equal(categoryIdForKey(CATEGORIES, 'BENEFIT'), 4);
    assert.equal(categoryIdForKey(CATEGORIES, null), null);
    assert.equal(categoryIdForKey([], 'ACADEMIC'), null);
});

test('ensureNoticeCategory fills category and categoryIds so they point the same way', () => {
    const filled = ensureNoticeCategory({ title: '[학생회] 학생회비 납부 안내', categoryIds: [] }, CATEGORIES);
    assert.deepEqual(filled, {
        category: 'COMMUNITY',
        categoryIds: [4],
        categorySource: 'rules',
        changed: true
    });

    const kept = ensureNoticeCategory({ category: 'ACADEMIC', categoryIds: [1], title: '축제' }, CATEGORIES);
    assert.equal(kept.category, 'ACADEMIC');
    assert.deepEqual(kept.categoryIds, [1]);
    assert.equal(kept.categorySource, 'stored');
    assert.equal(kept.changed, false);

    // 키는 없고 id만 있으면 id의 키를 따른다. 관리자 화면은 id만 보낸다.
    const fromIds = ensureNoticeCategory({ categoryIds: [2], title: '축제' }, CATEGORIES);
    assert.equal(fromIds.category, 'OPPORTUNITY');
    assert.deepEqual(fromIds.categoryIds, [2]);

    // 예전 키는 현재 키로 바꾸고, 그 카테고리 id를 앞에 붙여 탭 필터에 걸리게 한다.
    const legacy = ensureNoticeCategory({ category: 'BENEFIT', categoryIds: [5], title: '제휴' }, CATEGORIES);
    assert.equal(legacy.category, 'COMMUNITY');
    assert.deepEqual(legacy.categoryIds, [4, 5]);
    assert.equal(legacy.changed, true);

    // 카테고리 목록이 없으면 키만 채우고 id는 비워 둔다.
    const noCategories = ensureNoticeCategory({ title: '설문 참여' }, []);
    assert.equal(noCategories.category, 'SURVEY');
    assert.deepEqual(noCategories.categoryIds, []);
});
