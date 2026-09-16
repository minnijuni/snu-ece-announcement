import XCTest
@testable import SNUECENotice

/// 백그라운드에서 돌아왔을 때의 재조회를 다룬다.
///
/// 관리자가 올린 공지는 서버에 바로 실리지만, 앱은 켜 둔 채로 다시 조회하지
/// 않아 당겨서 새로고침하기 전까지 보이지 않았다. `refreshAfterForeground()`가
/// 그 틈을 메운다 — 단, 보고 있던 쪽을 유지하고, 오는 중인 요청에 끼어들지 않는다.
@MainActor
final class BoardForegroundRefreshTests: XCTestCase {
    /// 요청받은 쪽 번호를 기록하고, 그 번호를 그대로 돌려주는 가짜 서버.
    private final class RecordingService: NoticeServing, @unchecked Sendable {
        let configuration = APIConfiguration(
            baseURL: URL(string: "https://example.invalid")!,
            publicSiteURL: URL(string: "https://example.invalid")!
        )
        private(set) var requestedPages: [Int] = []
        /// 응답 한 쪽에 실을 공지 id. 새 공지가 올라온 상황은 여기를 바꿔 흉내 낸다.
        var ids: [Int] = [1, 2]
        /// 응답을 이만큼 늦춘다. 오는 중인 요청에 끼어드는지 볼 때 쓴다.
        var delay: Duration = .zero

        func loadNotices(page: Int, limit: Int, filters: NoticeFilters) async throws -> NoticeListResponse {
            requestedPages.append(page)
            if delay > .zero {
                do {
                    try await Task.sleep(for: delay)
                } catch {
                    throw APIError.transport(URLError(.cancelled))
                }
            }
            let notices = ids.map { #"{"id": \#($0), "title": "공지 \#($0)"}"# }.joined(separator: ",")
            let json = """
            {"notices": [\(notices)],
             "pagination": {"page": \(page), "limit": 16, "total": 48, "totalPages": 3}}
            """
            return try JSONDecoder().decode(NoticeListResponse.self, from: Data(json.utf8))
        }

        func loadDetail(id: Int) async throws -> Notice { throw APIError(message: "쓰지 않음") }
        func incrementView(id: Int) async throws -> Int? { nil }
        func loadCategories() async throws -> [NoticeCategory] { [] }
        func loadBannerSlides() async throws -> [BannerSlide] { [] }
        func loadSyncStatus() async throws -> SyncStatus { SyncStatus(lastSyncedAt: Date(), noticeCount: 1) }
        func submitFeedback(message: String, screenshots: [Data]) async throws {}
        func attachmentURL(noticeId: Int, index: Int) -> URL? { nil }
        func thumbnailURL(for notice: Notice) -> URL? { nil }
    }

    /// 돌아오면 그사이 올라온 공지가 목록에 나타난다.
    func testForegroundRefreshPicksUpNoticesPostedMeanwhile() async {
        let service = RecordingService()
        // cache: nil — 테스트는 앱 샌드박스에 실리므로, 캐시를 살려 두면
        // 가짜 공지가 실제 앱의 오프라인 캐시 파일에 적힌다.
        let board = BoardViewModel(service: service, cache: nil)
        await board.loadInitialIfNeeded()
        XCTAssertEqual(board.notices.map(\.id), [1, 2])

        // 앱이 뒤에 가 있는 동안 관리자가 3번 공지를 올렸다.
        service.ids = [3, 1, 2]
        await board.refreshAfterForeground()

        XCTAssertEqual(board.notices.map(\.id), [3, 1, 2])
        XCTAssertNil(board.loadError)
        XCTAssertFalse(board.isLoading)
    }

    /// 2쪽을 보고 있었다면 2쪽을 다시 받는다. 1쪽으로 튕겨 보내지 않는다.
    func testForegroundRefreshKeepsTheCurrentPage() async {
        let service = RecordingService()
        let board = BoardViewModel(service: service, cache: nil)
        await board.loadInitialIfNeeded()
        await board.goToPage(2)
        XCTAssertEqual(board.pagination.page, 2)

        await board.refreshAfterForeground()

        XCTAssertEqual(service.requestedPages, [1, 2, 2])
        XCTAssertEqual(board.pagination.page, 2)
    }

    /// 첫 화면이 아직 오는 중이면 끼어들지 않는다. 겹쳐 부르면 먼저 간 요청의
    /// 응답이 버려져 헛수고가 된다.
    func testForegroundRefreshDoesNotInterruptALoadInFlight() async throws {
        let service = RecordingService()
        service.delay = .seconds(3)
        let board = BoardViewModel(service: service, cache: nil)

        let initial = Task { await board.loadInitialIfNeeded() }
        try await Task.sleep(for: .milliseconds(80))
        XCTAssertTrue(board.isLoading)

        await board.refreshAfterForeground()

        XCTAssertEqual(service.requestedPages, [1], "오는 중인 요청 위에 겹쳐 부르면 안 된다")
        initial.cancel()
        _ = await initial.value
    }

    /// 첫 화면을 받기 전에는 아무것도 하지 않는다. 그 몫은 `loadInitialIfNeeded()`다.
    func testForegroundRefreshBeforeFirstLoadIsANoOp() async {
        let service = RecordingService()
        let board = BoardViewModel(service: service, cache: nil)

        await board.refreshAfterForeground()

        XCTAssertEqual(service.requestedPages, [])
    }
}
