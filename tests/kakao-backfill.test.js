import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildKakaoBackfillDrafts,
    kakaoBackfillInternals,
    parseKakaoExport
} from '../server/services/kakao-backfill.js';

const SAMPLE = [
    '--------------- 2025년 3월 9일 일요일 ---------------',
    '[전기정보 학생회] [오전 9:46] [수강신청 안내]\n수강 변경은 3월 12일까지입니다.',
    '[전기정보 학생회] [오전 9:47] 사진 2장',
    '[전기정보 학생회] [오전 9:48] 파일: 수강편람.pdf',
    '[총학생회] [오후 1:05] [학생 지원 프로그램 모집]\n신청 기간 3월 9일부터 3월 20일까지\nhttps://example.com/form',
    '--------------- 2025년 3월 20일 목요일 ---------------',
    '[총학생회] [오후 2:10] [재공지] 학생 지원 프로그램 모집\n접수 기간 3월 20일까지 https://example.com/form'
].join('\r\n');

test('Kakao parser preserves CRLF records and internal LF body lines', () => {
    const messages = parseKakaoExport(SAMPLE);
    assert.equal(messages.length, 3);
    assert.equal(messages[0].sentAt, '2025-03-09T00:46:00.000Z');
    assert.equal(messages[0].body, '[수강신청 안내]\n수강 변경은 3월 12일까지입니다.');
    assert.equal(messages[0].imageAttachmentCount, 2);
    assert.deepEqual(messages[0].attachments, [{ name: '수강편람.pdf', url: '' }]);
    assert.deepEqual(messages[1].urls, ['https://example.com/form']);
    assert.throws(
        () => parseKakaoExport(SAMPLE.replaceAll('\r\n', '\n')),
        /CRLF 메시지 경계/
    );
});

test('Kakao backfill classifies drafts and groups reminders within 30 days', () => {
    const result = buildKakaoBackfillDrafts(SAMPLE);
    assert.equal(result.stats.messageCount, 3);
    assert.equal(result.stats.draftCount, 2);
    assert.equal(result.stats.groupedDuplicateCount, 1);
    assert.equal(result.drafts[0].categorySlug, 'academic');
    assert.equal(result.drafts[0].requiresAction, true);
    assert.equal(result.drafts[0].host, '전기정보 학생회');
    assert.equal(result.drafts[0].sourceGroup, '전기정보');
    assert.equal(result.drafts[1].categorySlug, 'opportunity');
    assert.equal(result.drafts[1].requiresAction, true);
    assert.equal(result.drafts[1].host, '총학생회');
    assert.equal(result.drafts[1].sourceGroup, '총학·중앙');
    assert.equal(result.drafts[1].reminderCount, 1);
    assert.equal(result.drafts[1].threadMessages.length, 2);
});

test('Kakao category rules follow the four topic-only categories', () => {
    const { classifyDraft, classifySender, extractDeadlineExpressions } = kakaoBackfillInternals;
    assert.equal(
        classifyDraft('장학금 신청', '3월 1일까지 폼으로 신청하세요'),
        'opportunity'
    );
    assert.equal(classifyDraft('졸업 학점 안내', '필수 이수 학점을 확인하세요'), 'academic');
    // 제휴·할인은 '혜택' 칸을 없애면서 캠퍼스 생활로 옮겼다.
    assert.equal(classifyDraft('학생 제휴 할인', '상점 할인 쿠폰'), 'community');
    // 선발이 없으면 설문, 있으면 기회로 갈린다.
    assert.equal(classifyDraft('사용자 조사 참여자 모집', '30분 인터뷰, 사례비 지급'), 'survey');
    assert.equal(classifyDraft('하계 인턴 모집', '서류 전형 후 면접'), 'opportunity');
    assert.equal(classifyDraft('정전 안내', '내일 캠퍼스 출입 통제'), 'community');
    assert.equal(classifyDraft('대의원 총회', '회칙 의결'), 'community');
    assert.equal(classifySender('서울대학교 공과대학 학생회'), '공과대학');
    assert.deepEqual(
        extractDeadlineExpressions('신청 기간 3월 1일까지, D-3'),
        ['신청 기간 3월 1일까지, D-3', '까지, D-3', 'D-3']
    );
});

test('Kakao drafts the rules cannot place still get a proposed category', () => {
    // 규칙에 안 걸린 메시지가 '미분류'로 남으면 관리자가 하나하나 골라야
    // 가져올 수 있었다. 공용 분류기가 제안하고 드롭다운에서 바꾸게 한다.
    const sample = [
        '--------------- 2025년 3월 9일 일요일 ---------------',
        '[총학생회] [오전 9:46] [샤人AI: 선배에게 듣는 AI 현장 이야기]\n동문 선배들과 네트워킹하는 세션입니다.'
    ].join('\r\n');
    const result = buildKakaoBackfillDrafts(sample);
    assert.equal(result.drafts[0].categorySlug, 'community');
    assert.equal(result.drafts[0].classificationStatus, 'fallback');
    assert.equal(result.stats.unclassifiedCount, 0);
});
