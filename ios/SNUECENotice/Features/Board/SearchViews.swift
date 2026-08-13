import SwiftUI

/// 검색창. 글자를 넣는 즉시 목록이 걸러지므로 검색 버튼이 따로 없다.
/// 오른쪽 돋보기 자리는 그래서 사용 설명서 입구로 쓴다.
struct NoticeSearchField: View {
    @Binding var text: String
    let onGuide: () -> Void

    @FocusState private var isFocused: Bool

    var body: some View {
        HStack(spacing: 8) {
            TextField("공지 제목과 내용을 검색해보세요", text: $text)
                .font(Theme.Typography.sans(14))
                .foregroundStyle(Theme.Palette.textMain)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .focused($isFocused)
                .padding(.leading, 15)

            if !text.isEmpty {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 16))
                        .foregroundStyle(Theme.Palette.textSub.opacity(0.6))
                }
                .buttonStyle(PressableStyle())
                .accessibilityLabel("검색어 지우기")
            }

            Button(action: onGuide) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 16, weight: .heavy))
                    .foregroundStyle(.white)
                    .frame(width: 38, height: 38)
                    .background(Theme.Palette.primary, in: Circle())
            }
            .buttonStyle(PressableStyle())
            .accessibilityLabel("사용 설명서 열기")
            .tutorialTarget(.guideButton)
            .padding(.trailing, 5)
        }
        .frame(minHeight: 48)
        .background(
            RoundedRectangle(cornerRadius: Theme.Metrics.searchRadius, style: .continuous)
                .fill(Color.white)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Metrics.searchRadius, style: .continuous)
                        .stroke(isFocused ? Theme.Palette.primary : Theme.Palette.border, lineWidth: 1.5)
                )
        )
        .animation(.easeOut(duration: 0.15), value: isFocused)
        .animation(.easeOut(duration: 0.15), value: text.isEmpty)
    }
}

/// 목록을 한참 내려가 진짜 검색창이 화면 밖으로 나가면 그때부터 위에 대신 선다.
/// 왼쪽 위 메뉴 손잡이와 겹치지 않게 그만큼 자리를 비워 둔다.
struct StickySearchBar: View {
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 10) {
                Text("공지 제목과 내용을 검색해보세요")
                    .font(Theme.Typography.sans(13))
                    .foregroundStyle(Theme.Palette.textSub)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)

                Image(systemName: "magnifyingglass")
                    .font(.system(size: 15, weight: .heavy))
                    .foregroundStyle(Theme.Palette.primary)
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 42)
            .background(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(Color.white)
                    .overlay(
                        RoundedRectangle(cornerRadius: 22, style: .continuous)
                            .stroke(Theme.Palette.primary, lineWidth: 1.5)
                    )
            )
        }
        .buttonStyle(PressableStyle(scale: 0.985))
        .accessibilityLabel("맨 위로 올라가 검색하기")
        .padding(.leading, 52)
        .padding(.trailing, 12)
        .padding(.top, 8)
        .padding(.bottom, 10)
        // 바탕만 상태 표시줄 자리까지 올려 덮고, 검색칸 자체는 안전 영역 안에
        // 남긴다. 통째로 올리면 시계와 글자가 겹친다.
        .background(.regularMaterial, ignoresSafeAreaEdges: .top)
        .overlay(alignment: .bottom) {
            Theme.Palette.primary.opacity(0.1).frame(height: 1)
        }
    }
}
