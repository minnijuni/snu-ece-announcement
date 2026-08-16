import SwiftUI

/// 카드 두 열.
///
/// 두 열이 나란히 끝나면 아래에 빈 띠가 남는다. 왼쪽 열을 정렬 버튼 줄
/// 높이까지 끌어올려 벽돌처럼 어긋나게 두면 그 자리가 메워진다. 정렬 버튼은
/// 오른쪽에 몰려 있어 그 왼쪽은 비어 있기 때문이다.
/// 검색·필터를 걸면 그 자리에 "결과 N건"이 들어서므로 끌어올리기를 멈춘다.
struct NoticeGrid: View {
    let notices: [Notice]
    let isLoading: Bool
    let staggered: Bool
    let thumbnailURL: (Notice) -> URL?
    let onSelect: (Notice) -> Void

    /// 왼쪽 열을 끌어올리는 높이. 웹 `margin-top: -46px`와 같다.
    private static let staggerOffset: CGFloat = -46

    /// 투어가 짚는 카드. 첫 카드는 목록을 맨 위로 굴렸을 때 위에 뜨는
    /// 검색줄에 머리가 눌려 잘려 보이므로, 한 행 아래(왼쪽 열 둘째 카드)를
    /// 짚는다. 카드가 그만큼 없으면 첫 카드로 물러난다.
    private var tutorialCardID: Notice.ID? {
        (notices.count > 2 ? notices[2] : notices.first)?.id
    }

    private var columns: (left: [Notice], right: [Notice]) {
        var left: [Notice] = []
        var right: [Notice] = []
        for (index, notice) in notices.enumerated() {
            if index.isMultiple(of: 2) { left.append(notice) } else { right.append(notice) }
        }
        return (left, right)
    }

    var body: some View {
        if isLoading {
            skeleton
        } else {
            HStack(alignment: .top, spacing: Theme.Metrics.gridSpacing) {
                column(columns.left)
                    .padding(.top, staggered ? Self.staggerOffset : 0)
                column(columns.right)
            }
            .animation(.easeOut(duration: 0.2), value: notices.map(\.id))
        }
    }

    private func column(_ items: [Notice]) -> some View {
        VStack(spacing: Theme.Metrics.gridSpacing) {
            ForEach(items) { notice in
                NoticeCardView(
                    notice: notice,
                    thumbnailURL: thumbnailURL(notice),
                    onTap: { onSelect(notice) }
                )
                .tutorialTarget(notice.id == tutorialCardID ? .noticeCard : nil)
            }
        }
        .frame(maxWidth: .infinity, alignment: .top)
    }

    /// 첫 화면을 기다리는 동안 세우는 골격. 카드가 내용만큼 자라는 구조라
    /// 비율 대신 대략의 카드 높이 하나로 세운다.
    private var skeleton: some View {
        HStack(alignment: .top, spacing: Theme.Metrics.gridSpacing) {
            ForEach(0..<2, id: \.self) { _ in
                VStack(spacing: Theme.Metrics.gridSpacing) {
                    ForEach(0..<3, id: \.self) { _ in
                        Rectangle()
                            .fill(Theme.Palette.posterPlaceholder)
                            .frame(height: 250)
                            .overlay(Rectangle().stroke(Theme.Palette.cardBorder, lineWidth: 1))
                    }
                }
            }
        }
        .redacted(reason: .placeholder)
        .accessibilityLabel("공지를 불러오는 중입니다")
    }
}

/// 쪽 넘김. 앞뒤 화살표와 다섯 칸짜리 창을 함께 보여준다.
struct NoticePaginationView: View {
    let pagination: NoticePagination
    let isLoading: Bool
    let onSelect: (Int) -> Void

    private var pageWindow: [Int] {
        let totalPages = max(1, pagination.totalPages)
        let page = max(1, pagination.page)
        let size = 5
        var start = max(1, page - size / 2)
        let end = min(totalPages, start + size - 1)
        start = max(1, end - size + 1)
        return Array(start...max(start, end))
    }

    var body: some View {
        VStack(spacing: 8) {
            if pagination.totalPages > 1 {
                HStack(spacing: 6) {
                    arrow("chevron.left", label: "이전 페이지", enabled: pagination.page > 1) {
                        onSelect(pagination.page - 1)
                    }
                    ForEach(pageWindow, id: \.self) { page in
                        pageButton(page)
                    }
                    arrow("chevron.right", label: "다음 페이지", enabled: pagination.page < pagination.totalPages) {
                        onSelect(pagination.page + 1)
                    }
                }
            }

            if pagination.totalPages > 0 {
                Text("\(pagination.page) / \(pagination.totalPages) 페이지 · 전체 \(pagination.total)건")
                    .font(Theme.Typography.sans(13))
                    .foregroundStyle(Theme.Palette.textSub)
                    .monospacedDigit()
            }
        }
        .padding(.top, 16)
        .padding(.bottom, 24)
        .frame(maxWidth: .infinity)
    }

    private func pageButton(_ page: Int) -> some View {
        let isActive = page == pagination.page
        return Button {
            onSelect(page)
        } label: {
            Text("\(page)")
                .font(Theme.Typography.sans(13, .bold))
                .foregroundStyle(isActive ? .white : Theme.Palette.textMain)
                .frame(minWidth: 42, minHeight: 42)
                .background(
                    RoundedRectangle(cornerRadius: 13, style: .continuous)
                        .fill(isActive ? Theme.Palette.primary : Color.white)
                        .overlay(
                            RoundedRectangle(cornerRadius: 13, style: .continuous)
                                .stroke(isActive ? Theme.Palette.primary : Theme.Palette.border, lineWidth: 1)
                        )
                )
        }
        .buttonStyle(PressableStyle())
        .disabled(isLoading)
        .accessibilityLabel("\(page)페이지")
        .accessibilityAddTraits(isActive ? [.isButton, .isSelected] : .isButton)
    }

    private func arrow(_ systemName: String, label: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(enabled ? Theme.Palette.textMain : Theme.Palette.disabledText)
                .frame(minWidth: 42, minHeight: 42)
                .background(
                    RoundedRectangle(cornerRadius: 13, style: .continuous)
                        .fill(enabled ? Color.white : Theme.Palette.disabledBackground)
                        .overlay(
                            RoundedRectangle(cornerRadius: 13, style: .continuous)
                                .stroke(Theme.Palette.border, lineWidth: 1)
                        )
                )
        }
        .buttonStyle(PressableStyle())
        .disabled(!enabled || isLoading)
        .accessibilityLabel(label)
    }
}
