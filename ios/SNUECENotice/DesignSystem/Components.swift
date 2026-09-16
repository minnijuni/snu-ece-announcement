import SwiftUI

// MARK: - 태그

/// 카드와 상세 위쪽에 붙는 작은 표. 첫 자리는 언제나 D-Day(또는 '상시')다.
struct TagChip: View {
    enum Style {
        case primary        // D-Day 기본
        case urgent         // 마감 3일 이내
        case expired        // 마감됨
        case neutral        // 주관 기관
        case target         // 대상 학번
        case pinned         // 고정

        var background: Color {
            switch self {
            case .primary: Theme.Palette.primaryLight
            case .urgent: Theme.Palette.dangerBackground
            case .expired: Theme.Palette.tagExpiredBackground
            case .neutral: Theme.Palette.tagBackground
            case .target: Theme.Palette.okBackground
            case .pinned: Theme.Palette.tagPinnedBackground
            }
        }

        var foreground: Color {
            switch self {
            case .primary: Theme.Palette.primary
            case .urgent: Theme.Palette.danger
            case .expired: Theme.Palette.tagExpiredText
            case .neutral: Theme.Palette.tagText
            case .target: Theme.Palette.ok
            case .pinned: Theme.Palette.tagPinnedText
            }
        }
    }

    let text: String
    var style: Style = .neutral
    var compact = false

    var body: some View {
        Text(text)
            .font(Theme.Typography.sans(compact ? 9.5 : 11.5, .bold))
            .tracking(-0.2)
            .foregroundStyle(style.foreground)
            .padding(.horizontal, compact ? 5 : 9)
            .padding(.vertical, compact ? 3 : 3)
            .background(style.background)
            .lineLimit(1)
    }
}

// MARK: - 버튼

/// 웹 `.btn`. 네이비 채움에 흰 글자.
struct FilledButtonStyle: ButtonStyle {
    var small = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.Typography.sans(small ? 13 : 14, .bold))
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .frame(minHeight: small ? 38 : Theme.Metrics.tapTarget)
            .padding(.horizontal, 14)
            .background(configuration.isPressed ? Theme.Palette.primaryHover : Theme.Palette.primary)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Metrics.controlRadius, style: .continuous))
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

/// 웹 `.btn-outline`. 흰 바탕에 네이비 글자, 회색 테두리.
struct OutlineButtonStyle: ButtonStyle {
    var small = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.Typography.sans(small ? 13 : 14, .bold))
            .foregroundStyle(Theme.Palette.primary)
            .frame(maxWidth: .infinity)
            .frame(minHeight: small ? 38 : Theme.Metrics.tapTarget)
            .padding(.horizontal, 14)
            .background(configuration.isPressed ? Theme.Palette.primaryLight : Color.white)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Metrics.controlRadius, style: .continuous)
                    .stroke(configuration.isPressed ? Theme.Palette.primary : Theme.Palette.border, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.Metrics.controlRadius, style: .continuous))
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

/// 눌리면 살짝 가라앉는 손맛. `mobile.css`의
/// `transform: translateY(1px) scale(0.97)`을 옮긴 것이다.
struct PressableStyle: ButtonStyle {
    var scale: CGFloat = 0.97

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? scale : 1)
            .brightness(configuration.isPressed ? -0.02 : 0)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

// MARK: - 흐름 배치

/// 칩처럼 폭이 제각각인 항목을 줄바꿈하며 늘어놓는다.
/// iOS 16의 `Layout`으로 짠 것이라 자식 개수가 달라져도 다시 계산된다.
struct FlowLayout: Layout {
    var spacing: CGFloat = 5
    var lineSpacing: CGFloat = 5

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        let rows = arrange(subviews: subviews, maxWidth: maxWidth)
        let height = rows.reduce(into: CGFloat.zero) { total, row in
            total += row.height
        } + lineSpacing * CGFloat(max(0, rows.count - 1))
        let width = rows.map(\.width).max() ?? 0
        return CGSize(width: min(width, maxWidth), height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let rows = arrange(subviews: subviews, maxWidth: bounds.width)
        var y = bounds.minY
        for row in rows {
            var x = bounds.minX
            for item in row.items {
                let size = subviews[item].sizeThatFits(.unspecified)
                subviews[item].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + lineSpacing
        }
    }

    private struct Row {
        var items: [Int] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func arrange(subviews: Subviews, maxWidth: CGFloat) -> [Row] {
        var rows: [Row] = []
        var current = Row()
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            let projected = current.items.isEmpty ? size.width : current.width + spacing + size.width
            if !current.items.isEmpty && projected > maxWidth {
                rows.append(current)
                current = Row()
            }
            current.width = current.items.isEmpty ? size.width : current.width + spacing + size.width
            current.height = max(current.height, size.height)
            current.items.append(index)
        }
        if !current.items.isEmpty { rows.append(current) }
        return rows
    }
}

// MARK: - 작은 조각들

/// 목록·상세를 불러오는 동안 띄우는 표시.
struct LoadingOverlay: View {
    var message: String = "공지를 불러오는 중입니다…"

    var body: some View {
        HStack(spacing: 10) {
            ProgressView().tint(Theme.Palette.primary)
            Text(message)
                .font(Theme.Typography.sans(13, .semibold))
                .foregroundStyle(Theme.Palette.textMain)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 14)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .shadow(color: .black.opacity(0.12), radius: 18, y: 6)
    }
}

/// 결과가 없을 때 그 자리에 서는 안내. 웹 `renderNoticeEmptyState()`와 문구가 같다.
struct NoticeEmptyState: View {
    let title: String
    let message: String
    var actionTitle: String?
    var isError = false
    var action: (() -> Void)?

    var body: some View {
        VStack(spacing: 9) {
            Text(title)
                .font(Theme.Typography.sans(17, .bold))
                .foregroundStyle(isError ? Theme.Palette.danger : Theme.Palette.textMain)
                .multilineTextAlignment(.center)
            Text(message)
                .font(Theme.Typography.sans(13))
                .foregroundStyle(Theme.Palette.textSub)
                .multilineTextAlignment(.center)
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .buttonStyle(OutlineButtonStyle(small: true))
                    .frame(maxWidth: 200)
                    .padding(.top, 9)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 60)
    }
}

/// 상태 표시줄 자리를 덮는 흰 판.
///
/// 내비게이션 바를 감춘 화면에서는 본문이 상태 표시줄 아래로 흘러 들어가
/// 시계·와이파이 표시와 글자가 겹친다. 그 띠만 페이지와 같은 색으로 덮는다.
/// 높이는 창의 안전 영역에서 읽는다 — 노치가 있는 기기와 없는 기기가 다르다.
struct StatusBarBackdrop: View {
    /// 판의 색. 기본은 본문과 같은 흰색이고, 남색 띠가 있는 화면은 띠 색을 준다.
    var color: Color = Theme.Palette.background

    var body: some View {
        color
            .frame(height: Self.topInset)
            .ignoresSafeArea(edges: .top)
            .allowsHitTesting(false)
    }

    private static var topInset: CGFloat {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow }?
            .safeAreaInsets.top ?? 0
    }
}
