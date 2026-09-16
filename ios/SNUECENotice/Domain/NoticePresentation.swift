import Foundation

/// 마감일에서 뽑아낸 D-Day 배지. 웹 `calcDDay()`와 같은 규칙이다.
struct DDay: Equatable {
    let text: String
    let isUrgent: Bool
    let isExpired: Bool

    static func calculate(deadline: String?, now: Date = Date()) -> DDay {
        guard let date = DateFormatting.parseDay(deadline) else {
            return DDay(text: "상시", isUrgent: false, isExpired: false)
        }
        let diff = DateFormatting.calendarDayDifference(from: now, to: date)
        if diff < 0 { return DDay(text: "마감됨", isUrgent: false, isExpired: true) }
        if diff == 0 { return DDay(text: "오늘 마감", isUrgent: true, isExpired: false) }
        return DDay(text: "D-\(diff)", isUrgent: diff <= 3, isExpired: false)
    }
}

/// 카드와 상세에 붙는 날짜 표기.
///
/// 학생이 알고 싶은 것은 '언제 열려 있는가'다. 마감일이 있으면 시작과 끝을
/// 함께 적어 기간으로 보여준다. 시작일이 없는 공지가 많은데, 그런 때는 공지가
/// 올라온 날부터 열려 있었다고 보는 편이 사실에 가까우므로 등록일을 시작 자리에
/// 세운다. 마감이 없고 날짜 하나만 있는 행사는 그 하루만 적는다.
struct NoticeDatePresentation: Equatable {
    enum BadgeStyle: Equatable { case none, urgent, expired }

    var badgeText: String
    var badgeStyle: BadgeStyle
    /// 적을 날짜들(`YYYY-MM-DD`). 비어 있으면 날짜를 쓰지 않고, 하나면 그날만,
    /// 둘이면 `시작 ~ 끝`으로 잇는다.
    var days: [String]

    /// "2026.08.01(토) ~ 2026.08.09(일)". 상세 화면처럼 폭이 넉넉한 곳에 쓴다.
    var dateLabel: String {
        days.map { DateFormatting.dayWithWeekday($0) }.joined(separator: " ~ ")
    }

    /// "08.01(토) ~ 08.09(일)". 두 열짜리 카드는 좁아 연도를 뗀다.
    var compactDateLabel: String {
        days.map { DateFormatting.shortDayWithWeekday($0) }.joined(separator: " ~ ")
    }

    static func make(for notice: Notice, now: Date = Date()) -> NoticeDatePresentation {
        if notice.isAlwaysOpen {
            return NoticeDatePresentation(badgeText: "상시", badgeStyle: .none, days: [])
        }

        let deadline = DateFormatting.dayKey(notice.deadlineAt) ?? DateFormatting.dayKey(notice.deadline)
        let start = DateFormatting.dayKey(notice.startDate)
        let registered = registeredOn(notice)

        guard let deadline else {
            // 마감이 없으면 행사가 열리는 날 하나만 알린다.
            return NoticeDatePresentation(badgeText: "", badgeStyle: .none, days: start.map { [$0] } ?? [])
        }

        let dDay = DDay.calculate(deadline: deadline, now: now)
        let style: BadgeStyle = dDay.isExpired ? .expired : (dDay.isUrgent ? .urgent : .none)
        let from = start ?? registered

        // 시작이 마감보다 뒤면 잘못 들어온 값이다. 그럴 때는 마감만 적는다.
        guard let from, from < deadline else {
            return NoticeDatePresentation(badgeText: dDay.text, badgeStyle: style, days: [deadline])
        }
        return NoticeDatePresentation(badgeText: dDay.text, badgeStyle: style, days: [from, deadline])
    }

    static func registeredOn(_ notice: Notice) -> String? {
        DateFormatting.dayKey(notice.sourcePublishedAt) ?? DateFormatting.dayKey(notice.createdAt)
    }

    /// 상세 제목 아래 날짜 상자들. 웹 `renderDetailDates()`와 같은 구성으로,
    /// 값이 있는 항목만 등록일 → 시행·접수 시작일 → 마감일 차례로 선다.
    static func detailDateRows(for notice: Notice) -> [(label: String, value: String)] {
        let rows: [(String, String?)] = [
            ("등록일", registeredOn(notice)),
            ("시행·접수 시작일", DateFormatting.dayKey(notice.startDate)),
            ("마감일", DateFormatting.dayKey(notice.deadlineAt) ?? DateFormatting.dayKey(notice.deadline))
        ]
        return rows.compactMap { label, day in
            day.map { (label: label, value: DateFormatting.dayWithWeekday($0)) }
        }
    }

    /// 상세 윗줄. 날짜가 없는 공지에서 구분자만 덩그러니 남지 않도록 조립한다.
    static func detailMeta(dateLabel: String, views: Int, registeredOn: String?) -> String {
        var parts: [String] = []
        if !dateLabel.isEmpty { parts.append(dateLabel) }
        if let registeredOn { parts.append("등록 \(DateFormatting.dayWithWeekday(registeredOn))") }
        parts.append("조회: \(views)")
        return parts.joined(separator: "  |  ")
    }
}

extension Notice {
    /// 카드에 싣는 대상 배지. 학번이 여럿이면 앞의 것에 "외 N"을 붙인다.
    var targetBadge: String {
        let labels = targets.map(\.trimmed).filter { !$0.isEmpty }
        guard let first = labels.first else { return target.trimmed.nilIfEmpty ?? "전체" }
        return labels.count > 1 ? "\(first) 외 \(labels.count - 1)" : first
    }
}
