import SwiftUI

/// 서울대 소식 스타일 카테고리 탭.
///
/// featurejaewon부터 모바일에서는 활성 칸에 밑줄을 긋지 않는다. 활성 칸은
/// 색과 굵기로만 구분되고, 아래에만 2px 남색 줄을 긋는다. 위쪽 경계는 바로
/// 위에 붙는 남색 띠(`BoardHeaderView`)가 맡는다 — 여기에도 줄을 그으면 띠는
/// 좌우 끝까지 닿고 줄은 본문 여백만큼 들어가 있어, 띠 아래 양끝이 계단처럼
/// 튀어나와 보인다.
/// 칸 수를 못 박지 않는다. 다섯으로 적어 두면 카테고리가 하나 늘거나 줄 때마다
/// 여기까지 손대야 하고, 잊으면 마지막 칸이 삐져나가 간격이 어긋난다.
struct CategoryTabsView: View {
    let categories: [NoticeCategory]
    let selectedSlug: String
    let onSelect: (String) -> Void

    private var tabs: [(slug: String, name: String)] {
        [(slug: "all", name: "전체")] + categories.map { (slug: $0.slug, name: $0.name) }
    }

    var body: some View {
        HStack(spacing: 0) {
            ForEach(tabs, id: \.slug) { tab in
                let isActive = tab.slug == selectedSlug
                Button {
                    onSelect(tab.slug)
                } label: {
                    Text(tab.name)
                        .font(Theme.Typography.sans(13, isActive ? .bold : .semibold))
                        .tracking(-0.4)
                        .foregroundStyle(isActive ? Theme.Palette.primaryDeep : Theme.Palette.textSub)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .frame(maxWidth: .infinity)
                        .frame(height: 52)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(isActive ? [.isButton, .isSelected] : .isButton)
            }
        }
        .animation(.easeOut(duration: 0.2), value: selectedSlug)
        .frame(height: 54)
        .overlay(alignment: .bottom) { Theme.Palette.primaryDeep.frame(height: 2) }
    }
}

#Preview {
    CategoryTabsView(
        categories: [
            NoticeCategory(id: 1, name: "학사", slug: "academic"),
            NoticeCategory(id: 2, name: "기회", slug: "opportunity"),
            NoticeCategory(id: 3, name: "설문", slug: "survey"),
            NoticeCategory(id: 4, name: "행사", slug: "community")
        ],
        selectedSlug: "opportunity",
        onSelect: { _ in }
    )
    .padding()
}
