import Foundation

/// 오프라인에서도 최근 목록을 보여주기 위한 텍스트 캐시.
///
/// 사진 데이터는 담지 않는다(용량이 커서 `ImageCache`가 URL 기준으로 따로
/// 관리한다). 조건 없는 최신순 목록이 도착할 때마다 기존 캐시와 합쳐
/// 최신 `limit`건만 남겨 디스크에 적어 둔다. 오프라인이라 첫 화면조차
/// 못 받았을 때 `BoardViewModel`이 이걸로 목록을 대신 채운다.
actor NoticeCache {
    static let shared = NoticeCache()

    /// 캐시에 남겨 둘 최대 건수. 목록용 `Notice`(텍스트만, 건당 수 KB)
    /// 기준이라 이 정도는 메모리·디스크 어느 쪽에도 부담이 없다.
    static let limit = 200

    private let fileURL: URL
    private var loaded: [Notice]?

    init(fileManager: FileManager = .default) {
        let directory = fileManager.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory
        fileURL = directory.appendingPathComponent("notice-text-cache.json")
    }

    /// 조건 없는 최신순 목록 한 쪽이 도착하면 부른다. id로 기존 캐시와
    /// 합친 뒤 발행일 기준 최신 `limit`건만 남긴다.
    func merge(_ notices: [Notice]) {
        guard !notices.isEmpty else { return }
        var byId = Dictionary(read().map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
        for notice in notices { byId[notice.id] = notice }
        // 타임스탬프 파싱은 느리다(ISO8601 포매터). 비교자 안에서 부르면
        // O(n log n)번 파싱하므로 정렬 전에 한 번씩만 해 둔다.
        let trimmed = byId.values.map { (recency(of: $0), $0) }
            .sorted { $0.0 == $1.0 ? $0.1.id > $1.1.id : $0.0 > $1.0 }
            .prefix(Self.limit)
            .map { $0.1 }
        // 깊은 쪽 페이지처럼 캐시를 바꾸지 못하는 병합이 잦다. 그대로면 디스크에 안 쓴다.
        guard trimmed != loaded else { return }
        loaded = trimmed
        write(trimmed)
    }

    func read() -> [Notice] {
        if let loaded { return loaded }
        guard let data = try? Data(contentsOf: fileURL),
              let decoded = try? JSONDecoder().decode([Notice].self, from: data) else {
            loaded = []
            return []
        }
        loaded = decoded
        return decoded
    }

    private func write(_ notices: [Notice]) {
        guard let data = try? JSONEncoder().encode(notices) else { return }
        try? data.write(to: fileURL, options: .atomic)
    }

    /// 발행일이 있으면 발행일, 없거나 못 읽으면 등록일. 화면의
    /// `registeredOn`(NoticePresentation)과 같은 우선순위다.
    private func recency(of notice: Notice) -> Date {
        DateFormatting.parseTimestamp(notice.sourcePublishedAt)
            ?? DateFormatting.parseTimestamp(notice.createdAt)
            ?? .distantPast
    }
}
