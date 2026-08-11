import XCTest
@testable import SNUECENotice

/// 당겨서 새로고침이 취소되는 경우를 다룬다.
///
/// `.refreshable`이 준 작업은 사용자가 손을 떼거나 화면이 바뀌면 취소된다.
/// 그때 URLSession은 `NSURLErrorCancelled`를 던지는데, 이것을 연결 실패로
/// 취급하면 멀쩡한 목록이 "서버에 연결하지 못했습니다"로 덮인다.
@MainActor
final class BoardRefreshTests: XCTestCase {
    /// 요청이 오래 걸리다가, 취소되면 URLSession과 같은 오류를 내는 가짜 서버.
    private final class SlowService: NoticeServing, @unchecked Sendable {
        let configuration = APIConfiguration(
            baseURL: URL(string: "https://example.invalid")!,
            publicSiteURL: URL(string: "https://example.invalid")!
        )
        var deliver: NoticeListResponse
        /// 취소가 아니라 진짜로 서버가 죽은 경우를 흉내 낼 때 켠다.
        var failWithRealError = false

        init(deliver: NoticeListResponse) { self.deliver = deliver }

        func loadNotices(page: Int, limit: Int, filters: NoticeFilters) async throws -> NoticeListResponse {
            if failWithRealError { throw APIError.transport(URLError(.cannotConnectToHost)) }
            do {
                try await Task.sleep(for: .seconds(3))
            } catch {
                // URLSession이 취소될 때 내는 것과 같은 오류.
                throw APIError.transport(URLError(.cancelled))
            }
            return deliver
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

    private func makeResponse(ids: [Int]) throws -> NoticeListResponse {
        let notices = ids.map { #"{"id": \#($0), "title": "공지 \#($0)"}"# }.joined(separator: ",")
        let json = """
        {"notices": [\(notices)],
         "pagination": {"page": 1, "limit": 16, "total": \(ids.count), "totalPages": 1}}
        """
        return try JSONDecoder().decode(NoticeListResponse.self, from: Data(json.utf8))
    }

    /// 취소된 새로고침은 오류가 아니다. 화면에 오류를 띄우지 않는다.
    func testCancelledRefreshDoesNotSurfaceAnError() async throws {
        let service = SlowService(deliver: try makeResponse(ids: [1, 2]))
        // cache: nil — 테스트는 앱 샌드박스에 실리므로, 캐시를 살려 두면
        // 가짜 공지가 실제 앱의 오프라인 캐시 파일에 적힌다.
        let board = BoardViewModel(service: service, cache: nil)

        let task = Task { await board.refresh() }
        try await Task.sleep(for: .milliseconds(80))
        task.cancel()
        _ = await task.value

        XCTAssertNil(board.loadError, "취소는 연결 실패가 아니므로 오류를 띄우면 안 된다")
    }

    /// 취소된 새로고침이 이미 받아 둔 목록을 지워서도 안 된다.
    func testCancelledRefreshKeepsTheListOnScreen() async throws {
        let service = SlowService(deliver: try makeResponse(ids: [1, 2, 3]))
        let board = BoardViewModel(service: service, cache: nil)

        // 먼저 한 번 제대로 받아 둔다.
        service.failWithRealError = false
        let first = Task { await board.reload(page: 1) }
        _ = await first.value
        XCTAssertEqual(board.notices.count, 3)

        // 그 상태에서 새로고침을 걸었다가 취소한다.
        let task = Task { await board.refresh() }
        try await Task.sleep(for: .milliseconds(80))
        task.cancel()
        _ = await task.value

        XCTAssertEqual(board.notices.count, 3, "취소됐다고 목록을 비우면 안 된다")
        XCTAssertNil(board.loadError)
    }

    /// 진짜 연결 실패는 그대로 알린다. 취소를 봐주느라 실제 오류를 삼키면 안 된다.
    func testRealFailureStillReportsAnError() async {
        let service = SlowService(deliver: NoticeListResponse(
            notices: [], pagination: .empty, facets: nil
        ))
        service.failWithRealError = true
        let board = BoardViewModel(service: service, cache: nil)

        await board.reload(page: 1)

        XCTAssertNotNil(board.loadError)
        XCTAssertFalse(board.loadError?.isCancellation ?? true)
    }

    func testCancellationIsRecognisedOnTheErrorType() {
        XCTAssertTrue(APIError.transport(URLError(.cancelled)).isCancellation)
        XCTAssertFalse(APIError.transport(URLError(.timedOut)).isCancellation)
        XCTAssertFalse(APIError(message: "서버 오류").isCancellation)
    }
}

private extension NoticeListResponse {
    init(notices: [Notice], pagination: NoticePagination, facets: NoticeFacets?) {
        let json = """
        {"notices": [], "pagination": {"page": 1, "limit": 16, "total": 0, "totalPages": 0}}
        """
        self = try! JSONDecoder().decode(NoticeListResponse.self, from: Data(json.utf8))
    }
}
