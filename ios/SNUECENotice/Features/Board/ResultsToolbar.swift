import SwiftUI

/// 카드 목록 바로 위의 한 줄. 카드 두 열과 같은 폭으로 둘로 나뉜다.
///
/// 오른쪽 칸은 언제나 정렬 칸이고 그 칸을 꽉 채운다. 왼쪽 칸은 평소에 비어
/// 있어서 왼쪽 열 첫 카드가 그 자리까지 올라와 선다(`NoticeGrid`의 벽돌 배치).
/// 검색·필터를 걸면 왼쪽 칸에 "결과 N건"이 들어서고 끌어올리기는 멈춘다.
struct ResultsToolbar: View {
    let total: Int
    let showsCount: Bool
    let sort: NoticeFilters.Sort
    let onSelectSort: (NoticeFilters.Sort) -> Void

    /// 정렬 칸의 높이. 왼쪽 열은 이 높이에 열 간격을 더한 만큼 올라와
    /// 정렬 칸과 머리를 나란히 한다.
    static let slotHeight: CGFloat = 36

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Metrics.gridSpacing) {
            Group {
                if showsCount {
                    (Text("결과 ")
                     + Text("\(total)").foregroundColor(Theme.Palette.primary).bold()
                     + Text("건"))
                    .font(Theme.Typography.sans(12.5, .semibold))
                    .foregroundStyle(Theme.Palette.textSub)
                    .lineLimit(1)
                    .accessibilityLabel("결과 \(total)건")
                } else {
                    // 빈 칸. 올라온 카드가 이 위에 그려지므로 손가락도 카드가 받는다.
                    Color.clear.allowsHitTesting(false)
                }
            }
            .frame(maxWidth: .infinity, minHeight: Self.slotHeight, alignment: .leading)

            SortChips(selected: sort, onSelect: onSelectSort)
                .frame(maxWidth: .infinity)
                .tutorialTarget(.sortChips)
        }
    }
}

/// 정렬 칸. 주어진 폭과 높이를 세 칸이 똑같이 나눠 가진다.
///
/// 모서리는 살짝만 둥근 직사각형이다. 활성 표시는 버튼 배경이 아니라 흰 판
/// 하나가 미끄러져 옮겨 다닌다 — 자리만 옮기므로 레이아웃을 다시 계산하지
/// 않아 끊기지 않는다.
struct SortChips: View {
    let selected: NoticeFilters.Sort
    let onSelect: (NoticeFilters.Sort) -> Void

    @Namespace private var thumb

    private static let outerRadius: CGFloat = 8
    private static let thumbRadius: CGFloat = 6
    private static let inset: CGFloat = 2

    var body: some View {
        HStack(spacing: 2) {
            ForEach(NoticeFilters.Sort.allCases) { sort in
                let isActive = sort == selected
                Button {
                    onSelect(sort)
                } label: {
                    Text(sort.rawValue)
                        .font(Theme.Typography.sans(11.5, isActive ? .bold : .semibold))
                        .foregroundStyle(isActive ? Theme.Palette.primaryDeep : Theme.Palette.textSub)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .padding(.horizontal, 4)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background {
                            if isActive {
                                RoundedRectangle(cornerRadius: Self.thumbRadius, style: .continuous)
                                    .fill(Color.white)
                                    .shadow(color: Theme.Palette.primary.opacity(0.14), radius: 5, y: 1)
                                    .matchedGeometryEffect(id: "sort-thumb", in: thumb)
                            }
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(isActive ? [.isButton, .isSelected] : .isButton)
            }
        }
        .padding(Self.inset)
        .frame(height: ResultsToolbar.slotHeight)
        .background(
            RoundedRectangle(cornerRadius: Self.outerRadius, style: .continuous)
                .fill(Color(hex: 0xF4F6F9))
                .overlay(
                    RoundedRectangle(cornerRadius: Self.outerRadius, style: .continuous)
                        .stroke(Theme.Palette.borderSoft, lineWidth: 1)
                )
        )
        .animation(.spring(response: 0.3, dampingFraction: 0.85), value: selected)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("공지 정렬")
    }
}
