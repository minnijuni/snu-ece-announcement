import XCTest
@testable import SNUECENotice

/// 서버는 같은 공지를 목록용과 상세용 두 벌로 내려주고, 저장소(파일/Supabase)에
/// 따라 빠지는 열이 있다. 어느 쪽이 와도 화면이 깨지지 않아야 한다.
final class NoticeDecodingTests: XCTestCase {
    private func decode(_ json: String) throws -> Notice {
        try JSONDecoder().decode(Notice.self, from: Data(json.utf8))
    }

    func testSummaryPayloadDecodes() throws {
        let notice = try decode("""
        {
          "id": 12, "title": "[학사과] 수강신청 안내", "target": "24학번 이상",
          "targets": ["24학번", "25학번"], "host": "학사과",
          "deadline": "2026-08-20", "deadlineAt": "2026-08-20",
          "isAlwaysOpen": false, "isPinned": true, "hasReward": true,
          "rewardNote": "기프티콘 증정", "requiresAction": true,
          "aiSummary": ["첫 줄", "둘째 줄"], "categoryIds": [1, 2], "views": 42,
          "hasImages": true, "thumbnailUrl": "/api/notices/12/thumbnail?v=1"
        }
        """)

        XCTAssertEqual(notice.id, 12)
        XCTAssertEqual(notice.targetBadge, "24학번 외 1")
        XCTAssertTrue(notice.isPinned)
        XCTAssertEqual(notice.rewardText, "기프티콘 증정")
        XCTAssertEqual(notice.aiSummary, ["첫 줄", "둘째 줄"])
        XCTAssertEqual(notice.categoryIds, [1, 2])
        XCTAssertTrue(notice.showsPoster)
        XCTAssertFalse(notice.isDetailLoaded)
    }

    func testDetailPayloadDecodes() throws {
        let response = try JSONDecoder().decode(NoticeDetailResponse.self, from: Data("""
        {"notice": {
          "id": 7, "title": "공지", "content": "본문입니다.", "host": "학생회",
          "images": ["data:image/jpeg;base64,AAAA"],
          "attachments": [{"name": "붙임1.pdf", "url": "https://ece.snu.ac.kr/a.pdf"}],
          "sourceUrl": "https://ece.snu.ac.kr/notice/7", "views": 5
        }}
        """.utf8))

        let notice = response.notice
        XCTAssertTrue(notice.isDetailLoaded)
        XCTAssertEqual(notice.content, "본문입니다.")
        XCTAssertEqual(notice.attachments?.first?.displayName, "붙임1.pdf")
        XCTAssertTrue(notice.showsPoster, "images가 있으면 포스터를 그린다")
    }

    /// 파일 모드 저장소는 id를 문자열로 내려주기도 한다.
    func testStringIdIsAccepted() throws {
        XCTAssertEqual(try decode(#"{"id": "31", "title": "가"}"#).id, 31)
    }

    /// 열이 통째로 빠져 있어도 기본값으로 채워 화면을 세운다.
    func testMissingFieldsFallBackToDefaults() throws {
        let notice = try decode(#"{"id": 1}"#)
        XCTAssertEqual(notice.title, "")
        XCTAssertEqual(notice.target, "전체")
        XCTAssertEqual(notice.host, "기타")
        XCTAssertEqual(notice.views, 0)
        XCTAssertTrue(notice.aiSummary.isEmpty)
        XCTAssertFalse(notice.showsPoster)
        XCTAssertNil(notice.rewardText)
    }

    /// 목록 응답에서 받은 썸네일은 상세를 받아 온 뒤에도 남아 있어야 한다.
    /// 상세 응답에는 그 열이 없어서, 그냥 덮어쓰면 카드 사진이 사라진다.
    func testMergingDetailKeepsSummaryOnlyFields() throws {
        let summary = try decode(#"{"id": 3, "title": "가", "hasImages": true, "thumbnailUrl": "/api/notices/3/thumbnail"}"#)
        let detail = try decode(#"{"id": 3, "title": "가", "content": "본문"}"#)

        let merged = summary.merging(detail: detail)
        XCTAssertEqual(merged.content, "본문")
        XCTAssertEqual(merged.thumbnailPath, "/api/notices/3/thumbnail")
        XCTAssertEqual(merged.hasImages, true)
    }

    func testListResponseDecodesPaginationAndFacets() throws {
        let response = try JSONDecoder().decode(NoticeListResponse.self, from: Data("""
        {
          "notices": [{"id": 1, "title": "가"}],
          "pagination": {"page": 2, "limit": 16, "total": 33, "totalPages": 3},
          "facets": {"hosts": ["학사과", "  ", "학생회"]}
        }
        """.utf8))

        XCTAssertEqual(response.notices.count, 1)
        XCTAssertEqual(response.pagination.totalPages, 3)
        // 빈 문자열 기관은 골라낸다. 그대로 두면 필터 목록에 빈 칸이 생긴다.
        XCTAssertEqual(response.facets?.hosts, ["학사과", "학생회"])
    }

    // MARK: - 카테고리

    func testCategoryOrderFollowsTabOrderAndDropsUnknownSlugs() {
        let categories = [
            NoticeCategory(id: 4, name: "행사", slug: "community"),
            NoticeCategory(id: 9, name: "옛칸", slug: "legacy-only"),
            NoticeCategory(id: 1, name: "학사", slug: "academic"),
            NoticeCategory(id: 2, name: "기회", slug: "opportunity")
        ]
        XCTAssertEqual(
            NoticeCategoryCatalog.ordered(categories).map(\.slug),
            ["academic", "opportunity", "community"]
        )
    }

    func testLegacySlugsRedirectToCurrentCategories() {
        let categories = [NoticeCategory(id: 2, name: "기회", slug: "opportunity")]
        XCTAssertEqual(NoticeCategoryCatalog.resolve(slug: "application", in: categories)?.id, 2)
        XCTAssertNil(NoticeCategoryCatalog.resolve(slug: "all", in: categories))
        XCTAssertNil(NoticeCategoryCatalog.resolve(slug: "expired", in: categories))
    }

    // MARK: - 동기화 상태

    /// 푸터는 상태 상자 없이 "YYYY.MM.DD HH:mm 업데이트" 한 줄만 적는다.
    /// 수집 기록이 없으면 그 사실만 옅게 알린다.
    func testSyncStateWritesUpdatedTimestamp() {
        let stamp = DateFormatting.parseTimestamp("2026-08-04T12:00:00Z")!
        let synced = SyncState.from(SyncStatus(lastSyncedAt: stamp, noticeCount: 10))

        XCTAssertEqual(synced, .synced(stamp))
        XCTAssertEqual(synced.updatedLabel, "\(DateFormatting.syncTimestamp(stamp)) 업데이트")
        XCTAssertEqual(SyncState.from(SyncStatus(lastSyncedAt: nil, noticeCount: 0)), .failed)
        XCTAssertEqual(SyncState.failed.updatedLabel, "업데이트 시각을 확인하지 못했습니다")
    }

    // MARK: - 배너

    func testOnlyRightRailBannersWithArtworkAreShown() throws {
        let slides = try JSONDecoder().decode(BannerSlideListResponse.self, from: Data("""
        {"slides": [
          {"id": 1, "name": "가", "placement": "right_rail", "order": 1, "mobileSrc": "/icons/a.svg"},
          {"id": 2, "name": "나", "placement": "staging", "order": 0, "mobileSrc": "/icons/b.svg"},
          {"id": 3, "name": "다", "placement": "right_rail", "order": 0},
          {"id": 4, "name": "라", "placement": "right_rail", "order": 2, "src": "/icons/d.svg"}
        ]}
        """.utf8)).slides

        // 대기 중(staging)이거나 그림이 없는 항목은 걸지 않는다. 차례는 order를 따른다.
        XCTAssertEqual(slides.displayableRightRail.map(\.id), [1, 4])
    }

    // MARK: - data URL

    func testDataURLPayloadIsDecodedWithoutNetwork() throws {
        let url = URL(string: "data:image/jpeg;base64,\(Data("가나".utf8).base64EncodedString())")!
        XCTAssertEqual(Data(dataURL: url).map { String(decoding: $0, as: UTF8.self) }, "가나")
        XCTAssertNil(Data(dataURL: URL(string: "https://example.com/a.jpg")!))
    }
}
