import SwiftUI

/// 결과 건수와 정렬 칩이 나란히 서는 줄.
struct ResultsToolbar: View {
    let total: Int
    let showsCount: Bool
    let sort: NoticeFilters.Sort
    let onSelectSort: (NoticeFilters.Sort) -> Void

    var body: some View {
        HStack(spacing: 10) {
            if showsCount {
                (Text("결과 ")
                 + Text("\(total)").foregroundColor(Theme.Palette.primary).bold()
                 + Text("건"))
                .font(Theme.Typography.sans(12.5, .semibold))
                .foregroundStyle(Theme.Palette.textSub)
                .lineLimit(1)
                .accessibilityLabel("결과 \(total)건")
            }

            Spacer(minLength: 0)

            SortChips(selected: sort, onSelect: onSelectSort)
                .tutorialTarget(.sortChips)
        }
        .frame(minHeight: 34)
    }
}

/// 정렬 칩. 활성 표시는 버튼 배경이 아니라 알약 하나가 미끄러져 옮겨 다닌다.
/// 자리만 옮기므로 레이아웃을 다시 계산하지 않아 끊기지 않는다.
struct SortChips: View {
    let selected: NoticeFilters.Sort
    let onSelect: (NoticeFilters.Sort) -> Void

    @Namespace private var thumb

    var body: some View {
        HStack(spacing: 2) {
            ForEach(NoticeFilters.Sort.allCases) { sort in
                let isActive = sort == selected
                Button {
                    onSelect(sort)
                } label: {
                    Text(sort.rawValue)
                        .font(Theme.Typography.sans(10.5, isActive ? .bold : .semibold))
                        .foregroundStyle(isActive ? Theme.Palette.primaryDeep : Theme.Palette.textSub)
                        .lineLimit(1)
                        .padding(.horizontal, 8)
                        .frame(minHeight: 34)
                        .background {
                            if isActive {
                                Capsule()
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
        .padding(2)
        .background(
            Capsule()
                .fill(Color(hex: 0xF4F6F9))
                .overlay(Capsule().stroke(Theme.Palette.borderSoft, lineWidth: 1))
        )
        .animation(.spring(response: 0.3, dampingFraction: 0.85), value: selected)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("공지 정렬")
    }
}
