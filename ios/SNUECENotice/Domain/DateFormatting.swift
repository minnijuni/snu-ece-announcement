import Foundation

/// 날짜를 읽고 쓰는 자리를 한곳에 모은다.
///
/// 서버는 날짜를 `YYYY-MM-DD` 또는 ISO 8601 타임스탬프로 내려준다. 앞의 것은
/// 시간대가 없으므로 UTC로 읽으면 하루가 밀린다. 웹이 `new Date(value + 'T00:00:00')`로
/// 로컬 자정을 잡는 것과 같게, 여기서도 현재 시간대의 자정으로 읽는다.
enum DateFormatting {
    static let koreanLocale = Locale(identifier: "ko_KR")
    static let weekdaySymbols = ["일", "월", "화", "수", "목", "금", "토"]

    static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.locale = koreanLocale
        return calendar
    }

    private static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    private static let isoFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let isoNoFractionFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    /// 서버 값의 앞 10글자만 떼어낸 `YYYY-MM-DD`. 값이 없으면 nil.
    static func dayKey(_ value: String?) -> String? {
        guard let value = value?.trimmed, value.count >= 10 else { return nil }
        let key = String(value.prefix(10))
        return dayFormatter.date(from: key) == nil ? nil : key
    }

    /// `YYYY-MM-DD`를 로컬 자정으로 읽는다.
    static func parseDay(_ value: String?) -> Date? {
        guard let key = dayKey(value) else { return nil }
        return dayFormatter.date(from: key)
    }

    /// ISO 타임스탬프와 `YYYY-MM-DD`를 모두 받아 준다.
    static func parseTimestamp(_ value: String?) -> Date? {
        guard let value = value?.trimmed, !value.isEmpty else { return nil }
        if let date = isoFormatter.date(from: value) { return date }
        if let date = isoNoFractionFormatter.date(from: value) { return date }
        return parseDay(value)
    }

    static func isoDay(_ date: Date) -> String {
        dayFormatter.string(from: date)
    }

    /// "2026.07.27(월)". 서울대 소식과 같은 표기다.
    static func dayWithWeekday(_ value: String?) -> String {
        guard let date = parseDay(value) else { return value?.trimmed ?? "" }
        return dayWithWeekday(date)
    }

    static func dayWithWeekday(_ date: Date) -> String {
        let components = calendar.dateComponents([.year, .month, .day, .weekday], from: date)
        let year = components.year ?? 0
        let month = components.month ?? 1
        let day = components.day ?? 1
        let weekday = weekdaySymbols[max(0, (components.weekday ?? 1) - 1)]
        return String(format: "%04d.%02d.%02d(%@)", year, month, day, weekday)
    }

    /// "08.01(토)". 연도를 뗀 표기. 목록 카드처럼 한 줄에 기간을 다 적어야 하는 좁은 자리에 쓴다.
    static func shortDayWithWeekday(_ value: String?) -> String {
        guard let date = parseDay(value) else { return value?.trimmed ?? "" }
        let components = calendar.dateComponents([.month, .day, .weekday], from: date)
        let weekday = weekdaySymbols[max(0, (components.weekday ?? 1) - 1)]
        return String(format: "%02d.%02d(%@)", components.month ?? 1, components.day ?? 1, weekday)
    }

    /// 푸터 동기화 배지의 "2026.08.04 09:30".
    static func syncTimestamp(_ date: Date) -> String {
        let components = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        return String(format: "%04d.%02d.%02d %02d:%02d",
                      components.year ?? 0, components.month ?? 1, components.day ?? 1,
                      components.hour ?? 0, components.minute ?? 0)
    }

    /// 달력상 며칠 차이인지. 시각은 버리고 날짜만 본다.
    static func calendarDayDifference(from earlier: Date, to later: Date) -> Int {
        let start = calendar.startOfDay(for: earlier)
        let end = calendar.startOfDay(for: later)
        return calendar.dateComponents([.day], from: start, to: end).day ?? 0
    }
}

extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
