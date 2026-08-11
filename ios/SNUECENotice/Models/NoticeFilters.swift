import Foundation

/// 목록 조회에 걸리는 조건 한 벌.
///
/// 걸러내기는 전부 서버가 한다(`applyNoticeListFilters`). 앱은 웹의
/// `getNoticeListFilters()`와 똑같은 질의 문자열을 만들어 보내기만 한다.
/// 값 하나라도 어긋나면 웹과 앱이 다른 목록을 보여주게 되므로, 문자열은
/// 서버가 받는 한국어 값을 그대로 쓴다.
struct NoticeFilters: Equatable {
    enum DeadlineStatus: String, CaseIterable, Identifiable {
        case all = "전체"
        case ongoing = "진행중"
        case imminent = "마감임박"
        case always = "상시"
        case closed = "마감됨"

        var id: String { rawValue }

        var label: String {
            switch self {
            case .all: "전체"
            case .ongoing: "진행 중"
            case .imminent: "마감 임박 (D-3 이내)"
            case .always: "상시"
            case .closed: "마감됨"
            }
        }
    }

    enum ViewRange: String, CaseIterable, Identifiable {
        case all = "전체"
        case over100 = "100이상"
        case over50 = "50이상"
        case under10 = "10미만"

        var id: String { rawValue }

        var label: String {
            switch self {
            case .all: "전체"
            case .over100: "100+"
            case .over50: "50+"
            case .under10: "10 미만"
            }
        }
    }

    enum Sort: String, CaseIterable, Identifiable {
        case latest = "최신순"
        case deadline = "마감임박순"
        case views = "조회순"

        var id: String { rawValue }
    }

    /// 상세 필터의 대상 학번 선택지. 웹 `index.html`의 `#targetFilter`와 같다.
    static let targetOptions = ["전체", "26학번", "25학번", "24학번", "24학번 이상", "23학번", "23학번 이상"]

    var searchText = ""
    var selectedCategoryIds: Set<Int> = []
    var target = "전체"
    var deadlineStatus: DeadlineStatus = .all
    var host = "전체"
    var viewRange: ViewRange = .all
    var sort: Sort = .latest
    var dateFrom: Date?
    var dateTo: Date?
    /// 학부 홈페이지에서 모아 온 공지까지 포함할지. 평소에는 켜 둔다.
    var includeRelated = true

    var urgentOnly = false
    var rewardOnly = false
    var actionOnly = false
    var includePast = false

    /// 검색어나 조건 하나라도 기본값에서 벗어났는지.
    /// "결과 N건" 표시와 카드 목록의 위쪽 여백이 이 값에 달려 있다.
    var hasActiveQuery: Bool {
        !searchText.trimmed.isEmpty || hasDetailedFilters || !selectedCategoryIds.isEmpty
    }

    /// 아무 조건도 정렬 변경도 없는 기본 최신순 목록인지. 오프라인 텍스트
    /// 캐시(`NoticeCache`)는 이 상태의 응답만 적재하고, 이 상태의 첫 화면만
    /// 캐시로 대신 채운다. 조회순·마감임박순 쪽을 섞으면 "최근 공지"라는
    /// 캐시의 뜻이 흐려진다.
    var isDefaultLatestFeed: Bool {
        !hasActiveQuery && sort == .latest
    }

    /// 검색어를 뺀 나머지 조건이 걸려 있는지.
    var hasDetailedFilters: Bool {
        target != "전체"
            || deadlineStatus != .all
            || host != "전체"
            || viewRange != .all
            || dateFrom != nil
            || dateTo != nil
            || !includeRelated
            || urgentOnly || rewardOnly || actionOnly || includePast
    }

    /// 상세 필터 바에 다는 칩. 웹 `updateFilterChips()`가 만드는 목록과 같다.
    var activeChips: [FilterChip] {
        var chips: [FilterChip] = []
        if target != "전체" { chips.append(FilterChip(kind: .target, label: target)) }
        if deadlineStatus != .all { chips.append(FilterChip(kind: .deadlineStatus, label: deadlineStatus.rawValue)) }
        if host != "전체" { chips.append(FilterChip(kind: .host, label: host)) }
        if viewRange != .all { chips.append(FilterChip(kind: .viewRange, label: "조회 \(viewRange.label)")) }
        if dateFrom != nil || dateTo != nil {
            let from = dateFrom.map(DateFormatting.isoDay) ?? ""
            let to = dateTo.map(DateFormatting.isoDay) ?? ""
            chips.append(FilterChip(kind: .dateRange, label: "\(from) ~ \(to)"))
        }
        if !includeRelated { chips.append(FilterChip(kind: .related, label: "직접 등록만")) }
        if urgentOnly { chips.append(FilterChip(kind: .urgent, label: "마감 임박")) }
        if rewardOnly { chips.append(FilterChip(kind: .reward, label: "리워드 있음")) }
        if actionOnly { chips.append(FilterChip(kind: .action, label: "신청 필요")) }
        if includePast { chips.append(FilterChip(kind: .past, label: "마감 포함")) }
        return chips
    }

    mutating func clear(_ kind: FilterChip.Kind) {
        switch kind {
        case .target: target = "전체"
        case .deadlineStatus: deadlineStatus = .all
        case .host: host = "전체"
        case .viewRange: viewRange = .all
        case .dateRange: dateFrom = nil; dateTo = nil
        case .related: includeRelated = true
        case .urgent: urgentOnly = false
        case .reward: rewardOnly = false
        case .action: actionOnly = false
        case .past: includePast = false
        }
    }

    /// 검색어와 카테고리는 남기고 상세·빠른 필터만 되돌린다.
    /// 웹 '필터 전체 초기화'와 같은 범위다.
    mutating func resetDetailed() {
        let keptSearch = searchText
        let keptCategories = selectedCategoryIds
        let keptSort = sort
        self = NoticeFilters()
        searchText = keptSearch
        selectedCategoryIds = keptCategories
        sort = keptSort
    }

    /// `/api/notices` 질의 문자열. 웹 `getNoticeListFilters()`와 짝이 맞아야 한다.
    func queryItems(page: Int, limit: Int) -> [URLQueryItem] {
        var items = [
            URLQueryItem(name: "page", value: String(page)),
            URLQueryItem(name: "limit", value: String(limit))
        ]
        func add(_ name: String, _ value: String) {
            guard !value.isEmpty else { return }
            items.append(URLQueryItem(name: name, value: value))
        }
        add("category", selectedCategoryIds.sorted().map(String.init).joined(separator: ","))
        add("search", searchText.trimmed)
        add("target", target)
        add("deadlineStatus", deadlineStatus.rawValue)
        add("host", host)
        add("views", viewRange.rawValue)
        add("sort", sort.rawValue)
        add("dateFrom", dateFrom.map(DateFormatting.isoDay) ?? "")
        add("dateTo", dateTo.map(DateFormatting.isoDay) ?? "")
        add("source", includeRelated ? "전체" : "manual")
        if urgentOnly { add("urgent", "true") }
        if rewardOnly { add("reward", "true") }
        if actionOnly { add("action", "true") }
        if includePast { add("past", "true") }
        return items
    }
}

struct FilterChip: Identifiable, Equatable {
    enum Kind: Hashable {
        case target, deadlineStatus, host, viewRange, dateRange, related
        case urgent, reward, action, past
    }

    let kind: Kind
    let label: String

    var id: Kind { kind }
}

/// 목록 위에 놓인 빠른 필터 네 칸.
enum QuickFilter: String, CaseIterable, Identifiable {
    case urgent, reward, action, past

    var id: String { rawValue }

    var label: String {
        switch self {
        case .urgent: "마감 임박"
        case .reward: "리워드 있음"
        case .action: "신청 필요"
        case .past: "마감"
        }
    }
}

extension NoticeFilters {
    func isOn(_ quick: QuickFilter) -> Bool {
        switch quick {
        case .urgent: urgentOnly
        case .reward: rewardOnly
        case .action: actionOnly
        case .past: includePast
        }
    }

    mutating func toggle(_ quick: QuickFilter) {
        switch quick {
        case .urgent: urgentOnly.toggle()
        case .reward: rewardOnly.toggle()
        case .action: actionOnly.toggle()
        case .past: includePast.toggle()
        }
    }
}
