import Foundation

/// 푸터의 업데이트 시각이 쓰는 값. `/api/sync-status` 응답.
struct SyncStatus: Decodable, Equatable {
    var lastSyncedAt: Date?
    var noticeCount: Int

    private enum CodingKeys: String, CodingKey { case lastSyncedAt, noticeCount }

    init(lastSyncedAt: Date?, noticeCount: Int) {
        self.lastSyncedAt = lastSyncedAt
        self.noticeCount = noticeCount
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let stamp = try? container.decodeIfPresent(String.self, forKey: .lastSyncedAt)
        lastSyncedAt = stamp.flatMap(DateFormatting.parseTimestamp)
        noticeCount = (try? container.decode(Int.self, forKey: .noticeCount)) ?? 0
    }
}

/// 푸터에 적는 수집 시각.
///
/// 예전에는 최신·지연·실패를 색 상자로 갈라 보였지만, 학생에게 쓸모 있는
/// 정보는 '언제 가져온 공지인가' 하나다. 지금은 시각 한 줄만 옅게 적으므로
/// 상태도 그만큼만 남긴다.
enum SyncState: Equatable {
    case loading
    case synced(Date)
    case failed

    /// 푸터 한 줄. "2026.08.21 09:30 업데이트".
    var updatedLabel: String {
        switch self {
        case .loading: "업데이트 시각 확인 중"
        case .synced(let date): "\(DateFormatting.syncTimestamp(date)) 업데이트"
        case .failed: "업데이트 시각을 확인하지 못했습니다"
        }
    }

    static func from(_ status: SyncStatus) -> SyncState {
        status.lastSyncedAt.map(SyncState.synced) ?? .failed
    }
}
