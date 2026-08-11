import Foundation

/// 서버가 내려주는 공지 한 건.
///
/// 웹의 `toNoticeSummary`(목록)와 `toClientNotice`(상세)는 같은 공지를 두 벌로 내려준다.
/// 목록에는 `content`·`images`·`attachments`가 없고 상세에는 `hasImages`·`thumbnailUrl`이
/// 없다. 두 타입으로 갈라 두면 화면마다 어느 쪽인지 따져야 하므로, 한 타입에 담고
/// 없는 값은 nil로 둔다. 상세를 받아 오면 `merging(detail:)`이 목록 항목을 덮어쓴다.
struct Notice: Identifiable, Equatable {
    let id: Int
    var title: String
    var target: String
    var targets: [String]
    var host: String
    var deadline: String?
    var deadlineAt: String?
    var startDate: String?
    var expiresAt: String?
    var isAlwaysOpen: Bool
    var isPinned: Bool
    var category: String?
    var hasReward: Bool
    var rewardNote: String?
    var requiresAction: Bool
    var surveyReward: String?
    var isArchived: Bool
    var isInGracePeriod: Bool
    var aiSummary: [String]
    var keywords: [String]
    var categoryIds: [Int]
    var views: Int
    var sourcePublishedAt: String?
    var createdAt: String?
    var updatedAt: String?

    /// 목록 응답에만 있다.
    var hasImages: Bool?
    var thumbnailPath: String?

    /// 상세 응답에만 있다. 상세를 아직 받지 않았으면 nil이다.
    var content: String?
    var images: [String]?
    var attachments: [NoticeAttachment]?
    var sourceUrl: String?

    var isDetailLoaded: Bool { content != nil }

    /// 사진이 있는지. 목록은 서버가 알려주고, 상세는 실제 배열로 판단한다.
    var showsPoster: Bool {
        if let hasImages { return hasImages }
        return !(images?.isEmpty ?? true)
    }

    var rewardText: String? {
        let value = rewardNote?.trimmed.nilIfEmpty ?? surveyReward?.trimmed.nilIfEmpty
        return value
    }

    /// 목록에서 받은 요약을 상세 응답으로 덮어쓴다.
    /// 상세에 없는 목록 전용 값(썸네일 등)은 그대로 남긴다.
    func merging(detail: Notice) -> Notice {
        var merged = detail
        merged.hasImages = detail.hasImages ?? hasImages
        merged.thumbnailPath = detail.thumbnailPath ?? thumbnailPath
        return merged
    }
}

struct NoticeAttachment: Equatable, Codable {
    var name: String?
    var url: String?

    var displayName: String { name?.trimmed.nilIfEmpty ?? "첨부파일" }
}

// MARK: - Codable

/// 디코딩은 서버 응답의 빈틈을 받아 주느라 손으로 쓴다. 인코딩은 `NoticeCache`가
/// 디스크 저장에 쓰는데, 케이스 이름이 전부 속성 이름과 같아야 컴파일러가
/// 합성해 준다. `thumbnailPath`만 서버 키(`thumbnailUrl`)와 달라 원시값으로 잇는다.
extension Notice: Codable {
    private enum CodingKeys: String, CodingKey {
        case id, title, target, targets, host, deadline, deadlineAt, startDate, expiresAt
        case isAlwaysOpen, isPinned, category, hasReward, rewardNote, requiresAction, surveyReward
        case isArchived, isInGracePeriod, aiSummary, keywords, categoryIds, views
        case sourcePublishedAt, createdAt, updatedAt, hasImages, thumbnailPath = "thumbnailUrl"
        case content, images, attachments, sourceUrl
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // 파일 모드 저장소는 id를 문자열로 내려주기도 한다. 둘 다 받아 준다.
        if let numeric = try? container.decode(Int.self, forKey: .id) {
            id = numeric
        } else {
            let text = try container.decode(String.self, forKey: .id)
            guard let numeric = Int(text) else {
                throw DecodingError.dataCorruptedError(forKey: .id, in: container,
                                                      debugDescription: "id를 숫자로 읽지 못했습니다.")
            }
            id = numeric
        }
        title = (try? container.decode(String.self, forKey: .title)) ?? ""
        target = (try? container.decode(String.self, forKey: .target)) ?? "전체"
        targets = (try? container.decode([String].self, forKey: .targets)) ?? []
        host = (try? container.decode(String.self, forKey: .host)) ?? "기타"
        deadline = try? container.decodeIfPresent(String.self, forKey: .deadline)
        deadlineAt = try? container.decodeIfPresent(String.self, forKey: .deadlineAt)
        startDate = try? container.decodeIfPresent(String.self, forKey: .startDate)
        expiresAt = try? container.decodeIfPresent(String.self, forKey: .expiresAt)
        isAlwaysOpen = (try? container.decode(Bool.self, forKey: .isAlwaysOpen)) ?? false
        isPinned = (try? container.decode(Bool.self, forKey: .isPinned)) ?? false
        category = try? container.decodeIfPresent(String.self, forKey: .category)
        hasReward = (try? container.decode(Bool.self, forKey: .hasReward)) ?? false
        rewardNote = try? container.decodeIfPresent(String.self, forKey: .rewardNote)
        requiresAction = (try? container.decode(Bool.self, forKey: .requiresAction)) ?? false
        surveyReward = try? container.decodeIfPresent(String.self, forKey: .surveyReward)
        isArchived = (try? container.decode(Bool.self, forKey: .isArchived)) ?? false
        isInGracePeriod = (try? container.decode(Bool.self, forKey: .isInGracePeriod)) ?? false
        aiSummary = (try? container.decode([String].self, forKey: .aiSummary)) ?? []
        keywords = (try? container.decode([String].self, forKey: .keywords)) ?? []
        categoryIds = (try? container.decode([Int].self, forKey: .categoryIds)) ?? []
        views = (try? container.decode(Int.self, forKey: .views)) ?? 0
        sourcePublishedAt = try? container.decodeIfPresent(String.self, forKey: .sourcePublishedAt)
        createdAt = try? container.decodeIfPresent(String.self, forKey: .createdAt)
        updatedAt = try? container.decodeIfPresent(String.self, forKey: .updatedAt)
        hasImages = try? container.decodeIfPresent(Bool.self, forKey: .hasImages)
        thumbnailPath = try? container.decodeIfPresent(String.self, forKey: .thumbnailPath)
        content = try? container.decodeIfPresent(String.self, forKey: .content)
        images = try? container.decodeIfPresent([String].self, forKey: .images)
        attachments = try? container.decodeIfPresent([NoticeAttachment].self, forKey: .attachments)
        sourceUrl = try? container.decodeIfPresent(String.self, forKey: .sourceUrl)
    }
}

// MARK: - 목록 응답

struct NoticeListResponse: Decodable {
    var notices: [Notice]
    var pagination: NoticePagination
    var facets: NoticeFacets?

    private enum CodingKeys: String, CodingKey { case notices, pagination, facets }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        notices = (try? container.decode([Notice].self, forKey: .notices)) ?? []
        pagination = (try? container.decode(NoticePagination.self, forKey: .pagination))
            ?? .singlePage(count: notices.count)
        facets = try? container.decodeIfPresent(NoticeFacets.self, forKey: .facets)
    }
}

struct NoticePagination: Decodable, Equatable {
    var page: Int
    var limit: Int
    var total: Int
    var totalPages: Int

    static let empty = NoticePagination(page: 1, limit: 16, total: 0, totalPages: 0)

    /// 목록 전체가 한 쪽에 다 담긴 경우. 캐시 폴백과 pagination 없는 응답이 쓴다.
    static func singlePage(count: Int) -> NoticePagination {
        NoticePagination(page: 1, limit: count, total: count, totalPages: 1)
    }
}

struct NoticeFacets: Decodable, Equatable {
    var hosts: [String]

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        hosts = ((try? container.decode([String].self, forKey: .hosts)) ?? [])
            .map(\.trimmed)
            .filter { !$0.isEmpty }
    }

    private enum CodingKeys: String, CodingKey { case hosts }
}

struct NoticeDetailResponse: Decodable {
    var notice: Notice
}

struct NoticeViewResponse: Decodable {
    var notice: NoticeViewCount?

    struct NoticeViewCount: Decodable {
        var id: Int
        var views: Int
    }
}
