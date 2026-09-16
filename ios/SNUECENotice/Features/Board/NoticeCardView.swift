import SwiftUI

/// 공지 카드 한 장.
///
/// featurejaewon부터 카드는 고정 비율이 아니라 **내용만큼 자란다**. 다만 카드는
/// 미리보기이므로 텍스트에 상한을 둔다 — 본문 제목 2줄, 텍스트 포스터 제목 4줄.
/// 포스터(사진)는 154pt로 고정이고, 사진 없는 공지의 텍스트 포스터는 154pt를
/// 바닥으로 제목만큼(상한까지) 자란다. 제목은 포스터 안에 크게 쓴 카드라도 본문
/// 첫 줄에 한 번 더 적는다 — 목록을 아래로 훑을 때 태그 다음에 제목을 놓쳐
/// 버리지 않게 하려는 것이다.
/// 본문 아래는 태그 → 제목 → 날짜 한 줄 → 리워드·조회수 순으로 자리가 정해져
/// 있다. 본문 발췌는 싣지 않는다 — 원문과 요약은 상세 화면의 몫이다.
struct NoticeCardView: View {
    let notice: Notice
    let thumbnailURL: URL?
    let onTap: () -> Void

    /// 웹 `mobile.css`의 `.card-poster { height: 154px }`.
    private static let posterHeight: CGFloat = 154

    private var presentation: NoticeDatePresentation {
        NoticeDatePresentation.make(for: notice)
    }

    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 0) {
                poster
                cardBody
            }
            .frame(maxWidth: .infinity, alignment: .top)
            .background(cardBackground)
            .overlay(cardBorder)
            .clipped()
            .shadow(color: shadowColor, radius: 11, y: 4)
            .opacity(notice.isArchived ? 0.58 : 1)
        }
        .buttonStyle(PressableStyle(scale: 0.985))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
    }

    // MARK: - 포스터

    @ViewBuilder
    private var poster: some View {
        if notice.showsPoster {
            RemoteImage(url: thumbnailURL, contentMode: .fill, alignment: .top) {
                AnyView(
                    Image(.defaultNoticeThumbnail)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                )
            }
            .frame(height: Self.posterHeight)
            .clipped()
        } else {
            textPoster
        }
    }

    /// 사진 없는 공지: 남색 배경 위에 흰 가로줄을 긋고 그 아래 제목을 둔다.
    /// 높이는 154pt를 바닥으로 제목이 다 들어갈 때까지 자란다.
    private var textPoster: some View {
        let title = PosterTitle.make(from: notice.title)

        return VStack(alignment: .leading, spacing: 6) {
            Rectangle()
                .fill(Color.white.opacity(0.92))
                .frame(height: 2)

            if let hostLine = title.hostLine {
                Text(hostLine)
                    .font(Theme.Typography.sans(PosterTitle.fontSize * 0.72, .heavy))
                    .foregroundStyle(Color.white.opacity(0.72))
                    .lineLimit(1)
            }

            Text(title.body)
                .font(Theme.Typography.sans(PosterTitle.fontSize, .bold))
                .tracking(-0.3)
                .lineSpacing(PosterTitle.fontSize * (PosterTitle.lineHeight - 1))
                .foregroundStyle(.white)
                .multilineTextAlignment(.leading)
                .lineLimit(4)
                .fixedSize(horizontal: false, vertical: true)

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(minHeight: Self.posterHeight, alignment: .top)
        .background {
            Theme.Palette.posterBackground
                .overlay(
                    Image(.noticePosterBackground)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                )
                .clipped()
        }
    }

    // MARK: - 본문

    private var cardBody: some View {
        VStack(alignment: .leading, spacing: 5) {
            tags

            // 텍스트 포스터 카드도 본문에 제목을 다시 적는다. 카드가 미리보기로
            // 남도록 두 줄까지만 보여주고, 전문은 상세 화면에 맡긴다.
            Text(notice.title)
                .font(Theme.Typography.sans(12.5, .bold))
                .lineSpacing(2)
                .foregroundStyle(Theme.Palette.textMain)
                .multilineTextAlignment(.leading)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)

            dateRow

            meta
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// 날짜 한 줄. 제목 바로 아래, 카드마다 같은 자리에 한 줄로만 선다.
    ///
    /// 카드는 미리보기라 본문(AI 요약)은 싣지 않는다. 두 열짜리 카드는 폭이
    /// 좁아 연도를 뗀 짧은 표기를 쓰고, 그래도 넘치면 줄을 바꾸는 대신 글자를
    /// 조금 줄인다. 기간도 마감도 없는 공지는 줄이 비지 않게 등록일을 세운다.
    private var dateRow: some View {
        HStack(spacing: 4) {
            Image(systemName: "calendar")
                .font(.system(size: 9, weight: .semibold))
            Text(cardDateText)
                .lineLimit(1)
                .minimumScaleFactor(0.85)
        }
        .font(Theme.Typography.sans(10.5, .semibold))
        .foregroundStyle(Theme.Palette.textSub)
        .monospacedDigit()
        .frame(height: 16)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var cardDateText: String {
        let label = presentation.compactDateLabel
        if !label.isEmpty { return label }
        if let registered = NoticeDatePresentation.registeredOn(notice) {
            return "등록 \(DateFormatting.shortDayWithWeekday(registered))"
        }
        return ""
    }

    private var tags: some View {
        HStack(spacing: 3) {
            if !presentation.badgeText.isEmpty {
                TagChip(text: presentation.badgeText, style: badgeStyle, compact: true)
            }
            if notice.isPinned {
                TagChip(text: "고정", style: .pinned, compact: true)
            }
            TagChip(text: notice.targetBadge, style: .target, compact: true)
            if !notice.host.isEmpty {
                TagChip(text: notice.host, style: .neutral, compact: true)
                    .layoutPriority(-1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .clipped()
    }

    /// 리워드는 조회수와 같은 줄, 바로 왼쪽에 놓는다. 자리가 모자라면
    /// 조회수 대신 리워드 칩이 줄어든다.
    private var meta: some View {
        HStack(spacing: 5) {
            if let reward = notice.rewardText {
                HStack(spacing: 4) {
                    Text("🎁").font(.system(size: 9))
                    Text(reward)
                        .font(Theme.Typography.sans(9.5, .bold))
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                .foregroundStyle(Theme.Palette.rewardText)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Theme.Palette.rewardBackground, in: Capsule())
                .accessibilityLabel("리워드 \(reward)")
            }

            Spacer(minLength: 0)

            Text("조회 \(notice.views)")
                .font(Theme.Typography.sans(10))
                .foregroundStyle(Theme.Palette.textSub)
                .fixedSize()
        }
        .padding(.top, 2)
    }

    // MARK: - 겉모습

    private var badgeStyle: TagChip.Style {
        switch presentation.badgeStyle {
        case .urgent: .urgent
        case .expired: .expired
        case .none: .primary
        }
    }

    private var isUrgent: Bool { presentation.badgeStyle == .urgent }
    private var isExpired: Bool { presentation.badgeStyle == .expired }

    private var cardBackground: some View {
        (isExpired ? Theme.Palette.expiredCardBackground : Theme.Palette.cardBackground)
    }

    private var cardBorder: some View {
        Rectangle()
            .stroke(isUrgent ? Theme.Palette.danger : Theme.Palette.cardBorder,
                    lineWidth: isUrgent ? 2 : 1)
    }

    private var shadowColor: Color {
        isUrgent ? Theme.Palette.danger.opacity(0.18) : Color(hex: 0x142B58).opacity(0.14)
    }

    private var accessibilityText: String {
        var parts = [notice.title]
        if !presentation.badgeText.isEmpty { parts.append(presentation.badgeText) }
        if !cardDateText.isEmpty { parts.append(cardDateText) }
        parts.append("주관 \(notice.host)")
        parts.append("조회 \(notice.views)")
        return parts.joined(separator: ", ")
    }
}
