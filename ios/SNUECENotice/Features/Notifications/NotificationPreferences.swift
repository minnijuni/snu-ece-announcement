import Foundation
import UserNotifications

/// 알림 설정 한 벌. 웹 `collectNotificationPreferences()`가 서버로 보내던
/// 값과 같은 항목을 담는다.
struct NotificationPreferences: Codable, Equatable {
    var year: String?
    var allCategories = false
    var categoryIds: Set<Int> = []
    var includeUrgent = true
    /// 마감 며칠 전에 알릴지. nil이면 별도 마감 알림을 보내지 않는다.
    /// 새로 설치하면 3일 전으로 출발한다 — 알림을 켠 채로 주면서 예약할
    /// 것이 하나도 없으면 켠 보람이 없다. 저장된 설정은 있는 값만 읽으므로
    /// 사용자가 '없음'(nil)을 골라 둔 것은 그대로 지켜진다.
    var reminderDaysBefore: Int? = 3

    static let yearOptions = ["26학번", "25학번", "24학번", "23학번", "22학번"]
    static let reminderOptions = [1, 3, 7]

    /// 공지 하나가 이 설정에 걸리는지.
    func matches(_ notice: Notice) -> Bool {
        if let year, !year.isEmpty {
            // 전체 대상 공지는 학번과 무관하게 통과시킨다.
            let target = notice.target.trimmed
            if target != "전체", target != year, !notice.targets.contains(year) { return false }
        }
        if allCategories || categoryIds.isEmpty { return true }
        return !categoryIds.isDisjoint(with: Set(notice.categoryIds))
    }
}

/// 알림 설정을 기기에 저장하고, 마감 알림을 예약한다.
///
/// 웹은 브라우저 Web Push(VAPID)로 서버가 밀어 주는 방식이다. iOS는 그 규격을
/// 쓸 수 없고 서버에 APNs 발송 경로가 아직 없으므로, 여기서는 같은 설정을
/// 받아 **기기 안에서** 마감 알림을 예약한다. 서버가 APNs를 지원하게 되면
/// `registerRemote()` 자리에 기기 토큰 등록을 더하면 된다.
@MainActor
final class NotificationPreferencesStore: ObservableObject {
    @Published var preferences: NotificationPreferences {
        didSet { persist() }
    }
    /// 알림을 실제로 켜 둔 상태인지. 제목 옆 종의 색이 이 값을 따른다.
    @Published private(set) var isSubscribed: Bool
    @Published private(set) var statusMessage: String?
    @Published private(set) var isBusy = false

    private let defaults: UserDefaults
    private let center: UNUserNotificationCenter

    private static let preferencesKey = "ecePushPreferences"
    private static let subscribedKey = "ecePushSubscribed"
    /// 마감 알림을 띄우는 시각(아침 9시). 자정에 울리면 잠을 깨운다.
    private static let reminderHour = 9

    init(defaults: UserDefaults = .standard, center: UNUserNotificationCenter = .current()) {
        self.defaults = defaults
        self.center = center
        if let data = defaults.data(forKey: Self.preferencesKey),
           let decoded = try? JSONDecoder().decode(NotificationPreferences.self, from: data) {
            preferences = decoded
        } else {
            preferences = NotificationPreferences()
        }
        // 알림은 켜진 채로 출발한다. 꺼짐이 기본이면 처음 설치한 사람은
        // 마감 알림이 있는 줄도 모른 채 지나간다. 끈 기록이 있을 때만 꺼 둔다.
        isSubscribed = defaults.object(forKey: Self.subscribedKey) == nil
            ? true
            : defaults.bool(forKey: Self.subscribedKey)
    }

    /// 첫 실행에서 알림 권한을 묻는다. 켜진 채 출발하는데 권한을 묻지 않으면
    /// 예약이 전부 조용히 무시된다. 거절당했거나 설정 앱에서 꺼 두었으면
    /// 종도 꺼서 화면과 실제가 어긋나지 않게 한다.
    func requestAuthorizationIfNeeded() async {
        guard isSubscribed else { return }
        let settings = await center.notificationSettings()
        switch settings.authorizationStatus {
        case .notDetermined:
            let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
            isSubscribed = granted
            defaults.set(granted, forKey: Self.subscribedKey)
        case .denied:
            isSubscribed = false
            defaults.set(false, forKey: Self.subscribedKey)
        default:
            break
        }
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(preferences) else { return }
        defaults.set(data, forKey: Self.preferencesKey)
    }

    /// 알림 권한을 받고 설정을 저장한다.
    func save() async {
        isBusy = true
        defer { isBusy = false }
        statusMessage = "알림 권한을 확인하고 있습니다."
        do {
            let granted = try await center.requestAuthorization(options: [.alert, .sound, .badge])
            guard granted else {
                statusMessage = "설정 앱에서 이 앱의 알림을 허용해주세요."
                return
            }
            isSubscribed = true
            defaults.set(true, forKey: Self.subscribedKey)
            statusMessage = "알림 설정이 저장되었습니다."
        } catch {
            statusMessage = "알림 권한을 받지 못했습니다: \(error.localizedDescription)"
        }
    }

    func unsubscribe() async {
        isBusy = true
        defer { isBusy = false }
        center.removeAllPendingNotificationRequests()
        isSubscribed = false
        defaults.set(false, forKey: Self.subscribedKey)
        statusMessage = "알림을 껐습니다."
    }

    func clearStatus() {
        statusMessage = nil
    }

    /// 목록에 실린 공지 가운데 설정에 맞는 것의 마감 알림을 다시 예약한다.
    ///
    /// 예약은 기기 안에서만 이뤄지므로 앱이 한 번은 열려 목록을 받아야 한다.
    /// 이미 잡아 둔 알림은 지우고 다시 세워, 마감일이 바뀌어도 어긋나지 않는다.
    func rescheduleReminders(for notices: [Notice]) async {
        guard isSubscribed, let daysBefore = preferences.reminderDaysBefore else {
            center.removeAllPendingNotificationRequests()
            return
        }
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else { return }

        center.removeAllPendingNotificationRequests()

        let calendar = DateFormatting.calendar
        let now = Date()
        for notice in notices where preferences.matches(notice) {
            guard !notice.isAlwaysOpen,
                  let deadline = DateFormatting.parseDay(notice.deadlineAt ?? notice.deadline),
                  let fireDay = calendar.date(byAdding: .day, value: -daysBefore, to: deadline),
                  var components = Optional(calendar.dateComponents([.year, .month, .day], from: fireDay))
            else { continue }
            components.hour = Self.reminderHour
            guard let fireDate = calendar.date(from: components), fireDate > now else { continue }

            let content = UNMutableNotificationContent()
            content.title = "마감 \(daysBefore)일 전"
            content.body = notice.title
            content.sound = .default
            content.userInfo = ["noticeId": notice.id]

            let trigger = UNCalendarNotificationTrigger(
                dateMatching: calendar.dateComponents([.year, .month, .day, .hour], from: fireDate),
                repeats: false
            )
            let request = UNNotificationRequest(
                identifier: "deadline-\(notice.id)",
                content: content,
                trigger: trigger
            )
            try? await center.add(request)
        }
    }
}
