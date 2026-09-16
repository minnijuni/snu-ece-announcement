import Foundation
import SwiftUI

/// 목록 화면이 들고 있는 상태 전부.
///
/// 웹은 전역 변수 여럿(`notices`, `filterState`, `selectedCategoryFilters`…)에
/// 흩어 두고 `filterCards()`가 그것들을 읽어 다시 그렸다. 여기서는 그 상태를
/// 한 객체에 모으고, 조건이 바뀌면 `reload()` 한 곳으로만 흐르게 한다.
@MainActor
final class BoardViewModel: ObservableObject {
    @Published private(set) var notices: [Notice] = []
    @Published private(set) var pagination = NoticePagination.empty
    @Published private(set) var hosts: [String] = []
    @Published private(set) var categories: [NoticeCategory] = []
    @Published private(set) var bannerSlides: [BannerSlide] = []
    @Published private(set) var syncState: SyncState = .loading

    @Published private(set) var isLoading = false
    @Published private(set) var loadError: APIError?
    /// 첫 화면을 아직 한 번도 못 받았는지. 목록 자리에 골격을 세울지 판단한다.
    @Published private(set) var hasLoadedOnce = false

    @Published var filters = NoticeFilters()
    /// 지금 눌린 카테고리 탭. 'all'이거나 카테고리 slug다.
    @Published private(set) var selectedCategorySlug = "all"

    let service: NoticeServing
    /// 오프라인 폴백용 텍스트 캐시. 단위 테스트는 nil을 넣어 실제 앱의
    /// Caches 디렉터리에 가짜 공지가 적히는 일을 막는다.
    private let cache: NoticeCache?

    /// 늦게 도착한 응답이 최신 목록을 덮어쓰지 않게 하는 표.
    /// 웹 `noticeListRequestVersion`과 같은 구실이다.
    private var requestVersion = 0
    private var searchTask: Task<Void, Never>?

    /// 검색어를 입력하는 동안 매 글자마다 서버를 부르지 않는다.
    private static let searchDebounce = Duration.milliseconds(220)

    init(service: NoticeServing = NoticeService(), cache: NoticeCache? = .shared) {
        self.service = service
        self.cache = cache
    }

    var orderedCategories: [NoticeCategory] {
        NoticeCategoryCatalog.ordered(categories)
    }

    /// "결과 N건"을 보일지. 조건을 하나도 걸지 않은 기본 목록에서는
    /// 전체 건수를 다시 알려줄 필요가 없다. 카테고리(메뉴)만 고른 목록도
    /// 숨긴다 — 건수 줄이 서면 왼쪽 열이 정렬 칸 옆으로 올라오지 못해
    /// 벽돌 배치가 풀리고, 탭을 옮길 때마다 줄이 들썩인다.
    var showsResultCount: Bool {
        pagination.total > 0
            && (!filters.searchText.trimmed.isEmpty || filters.hasDetailedFilters)
    }

    var isEmpty: Bool {
        !isLoading && pagination.total == 0 && loadError == nil
    }

    // MARK: - 불러오기

    func loadInitialIfNeeded() async {
        guard !hasLoadedOnce else { return }
        async let list: Void = reload(page: 1)
        async let meta: Void = loadMetadata()
        _ = await (list, meta)
    }

    func loadMetadata() async {
        async let categories = try? service.loadCategories()
        async let slides = try? service.loadBannerSlides()
        async let sync = try? service.loadSyncStatus()

        if let loaded = await categories {
            self.categories = loaded
        }
        self.bannerSlides = (await slides) ?? []
        if let status = await sync {
            syncState = .from(status)
        } else {
            syncState = .failed
        }
    }

    /// 조건이 바뀌었을 때 목록을 다시 받는다. 첫 쪽부터 새로 센다.
    ///
    /// `quietly`면 불러오는 중 표시를 켜지 않는다. 보고 있던 목록을 그대로 둔 채
    /// 뒤에서 바꿔 끼우는 새로고침(상징 탭)에 쓴다. 끝날 때는 조용한 쪽도
    /// 표시를 끈다 — 앞서 시끄럽게 시작한 요청을 이 요청이 밀어냈다면 그쪽은
    /// 끌 기회를 잃기 때문이다.
    func reload(page: Int = 1, quietly: Bool = false) async {
        requestVersion += 1
        let version = requestVersion
        if !quietly { isLoading = true }
        loadError = nil

        defer {
            if version == requestVersion {
                isLoading = false
                hasLoadedOnce = true
            }
        }

        do {
            let result = try await service.loadNotices(
                page: page,
                limit: NoticeService.pageSize,
                filters: filters
            )
            guard version == requestVersion else { return }
            notices = result.notices
            pagination = result.pagination
            if let facets = result.facets, !facets.hosts.isEmpty {
                hosts = facets.hosts.sorted { $0.compare($1, locale: DateFormatting.koreanLocale) == .orderedAscending }
            }
            if filters.isDefaultLatestFeed, let cache {
                await cache.merge(result.notices)
            }
        } catch {
            guard version == requestVersion else { return }
            let failure = error as? APIError ?? APIError.transport(error)
            // 사용자가 새로고침을 놓거나 화면을 떠나 끊긴 요청은 실패가 아니다.
            // 보고 있던 목록을 그대로 두고 조용히 물러난다.
            guard !failure.isCancellation else { return }
            // 이미 받아 둔 목록이 있으면 지우지 않는다. 새로고침 한 번 실패했다고
            // 보고 있던 공지가 사라지면, 오프라인에서 읽던 사람이 화면을 통째로 잃는다.
            if notices.isEmpty {
                // 첫 화면조차 못 받았다면(콜드 스타트에 오프라인) 텍스트 캐시로
                // 대신 채운다. 검색·필터가 걸린 상태는 캐시가 답할 수 없으니 그대로 둔다.
                let cached = filters.isDefaultLatestFeed ? (await cache?.read() ?? []) : []
                notices = cached
                pagination = cached.isEmpty ? .empty : .singlePage(count: cached.count)
            }
            loadError = failure
        }
    }

    func refresh() async {
        await reload(page: max(1, pagination.page))
        await loadMetadata()
    }

    /// 백그라운드에 있다가 돌아왔을 때. 그동안 관리자가 올린 공지를 받으러
    /// 보고 있던 쪽을 조용히 다시 받는다. 앱을 켜 둔 채로는 새 공지가 영영
    /// 나타나지 않던 것을 여기서 메운다. 컨트롤 센터·알림 배너처럼 잠깐
    /// 가려진 경우는 여기로 오지 않는다 — `RootView`가 background를 거친
    /// 복귀만 부른다.
    ///
    /// 첫 화면이나 사용자가 건 새로고침이 아직 오는 중이면 끼어들지 않는다.
    /// `reload()`는 늦게 온 응답을 버리므로 여기서 겹쳐 부르면 그 요청이
    /// 헛수고가 된다. 보고 있던 목록이 있으면 그대로 둔 채 뒤에서 바꿔 끼우고,
    /// 아무것도 없으면(오프라인 콜드 스타트) 불러오는 중 표시를 켠다.
    func refreshAfterForeground() async {
        guard hasLoadedOnce, !isLoading else { return }
        await reload(page: max(1, pagination.page), quietly: !notices.isEmpty)
        await loadMetadata()
    }

    func goToPage(_ page: Int) async {
        guard !isLoading, page >= 1, page <= pagination.totalPages, page != pagination.page else { return }
        await reload(page: page)
    }

    // MARK: - 조건 바꾸기

    /// 검색어는 입력이 잠시 멈춘 뒤에 반영한다.
    func searchTextChanged(_ text: String) {
        filters.searchText = text
        searchTask?.cancel()
        searchTask = Task { [weak self] in
            try? await Task.sleep(for: Self.searchDebounce)
            guard !Task.isCancelled else { return }
            await self?.reload(page: 1)
        }
    }

    func clearSearch() {
        searchTask?.cancel()
        filters.searchText = ""
        Task { await reload(page: 1) }
    }

    func selectCategory(slug: String) {
        selectedCategorySlug = slug
        let category = NoticeCategoryCatalog.resolve(slug: slug, in: categories)
        filters.selectedCategoryIds = category.map { [$0.id] } ?? []
        filters.sort = defaultSort(for: category)
        Task { await reload(page: 1) }
    }

    /// 기본 정렬. 마감이 있어야 뜻이 있는 칸(기회·설문)만 마감임박순으로 연다.
    private func defaultSort(for category: NoticeCategory?) -> NoticeFilters.Sort {
        guard let category else { return .latest }
        return NoticeCategoryCatalog.deadlineFirstSlugs.contains(category.slug) ? .deadline : .latest
    }

    func setSort(_ sort: NoticeFilters.Sort) {
        guard filters.sort != sort else { return }
        filters.sort = sort
        Task { await reload(page: 1) }
    }

    func toggleQuickFilter(_ quick: QuickFilter) {
        filters.toggle(quick)
        Task { await reload(page: 1) }
    }

    func clearChip(_ kind: FilterChip.Kind) {
        filters.clear(kind)
        Task { await reload(page: 1) }
    }

    func applyFilters(_ updated: NoticeFilters) {
        guard updated != filters else { return }
        filters = updated
        Task { await reload(page: 1) }
    }

    func resetDetailedFilters() {
        filters.resetDetailed()
        Task { await reload(page: 1) }
    }

    /// 엠블럼을 눌렀을 때. 조건을 모두 지우고 첫 화면 목록을 조용히 다시 받는다.
    func resetToHome() {
        searchTask?.cancel()
        filters = NoticeFilters()
        selectedCategorySlug = "all"
        Task {
            await reload(page: 1, quietly: true)
            await loadMetadata()
        }
    }

    // MARK: - 조회수

    /// 상세를 열면 조회수가 하나 오른다. 목록 카드에도 바로 반영한다.
    func applyViewCount(_ views: Int, for id: Int) {
        guard let index = notices.firstIndex(where: { $0.id == id }) else { return }
        notices[index].views = views
    }
}
