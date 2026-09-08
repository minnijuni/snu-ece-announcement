import SwiftUI

/// 왼쪽에서 열리는 서랍. 웹의 브랜드 레일(`.rail-left`)을 그대로 옮겼다.
///
/// 학교 상징 → 학교 이름 → 서비스 워드마크 → 관련 페이지 → 문의 → 시계 순서다.
/// 링크를 누르면 서랍이 남아 있으면 안 되므로 무엇을 누르든 먼저 닫는다.
struct SideDrawerView: View {
    @EnvironmentObject private var router: AppRouter
    @EnvironmentObject private var board: BoardViewModel
    @Environment(\.openURL) private var openURL

    @State private var now = Date()

    private let clock = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    private static let relatedLinks: [(title: String, url: String)] = [
        ("서울대학교 홈페이지", "https://www.snu.ac.kr/"),
        ("전기정보공학부", "https://ece.snu.ac.kr/"),
        ("mySNU", "https://my.snu.ac.kr/")
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Button {
                    router.closeDrawer()
                } label: {
                    HStack(spacing: 7) {
                        Image(systemName: "arrow.left")
                            .font(.system(size: 15, weight: .medium))
                        Text("돌아가기")
                            .font(Theme.Typography.sans(13, .bold))
                    }
                    .foregroundStyle(Theme.Palette.railText)
                    .padding(.horizontal, 12)
                    .frame(minHeight: 36)
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .stroke(Theme.Palette.railText, lineWidth: 1)
                    )
                }
                .buttonStyle(PressableStyle())
                .accessibilityLabel("메뉴에서 돌아가기")

                brand

                sectionLabel("관련 페이지")
                VStack(alignment: .leading, spacing: 10) {
                    drawerButton("서비스 안내") { router.present(.userGuide) }
                    ForEach(Self.relatedLinks, id: \.title) { link in
                        drawerButton(link.title) {
                            router.closeDrawer()
                            if let url = URL(string: link.url) { openURL(url) }
                        }
                    }
                }

                sectionLabel("문의")
                VStack(alignment: .leading, spacing: 4) {
                    drawerButton("일반 문의하기") { router.present(.feedback) }
                    drawerButton("홍보 신청하기") { router.present(.bannerInquiry) }
                }

                Spacer(minLength: 24)

                railClock
            }
            .padding(.horizontal, 22)
            .padding(.top, 60)
            .padding(.bottom, 32)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: .infinity)
        .background(Theme.Palette.railBackground)
        .clipShape(
            UnevenRoundedRectangle(
                topLeadingRadius: 0, bottomLeadingRadius: 0,
                bottomTrailingRadius: 24, topTrailingRadius: 24,
                style: .continuous
            )
        )
        .onReceive(clock) { now = $0 }
    }

    private var brand: some View {
        VStack(spacing: 2) {
            Button {
                board.resetToHome()
                router.closeDrawer()
            } label: {
                Image(.appMark)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: 154)
            }
            .buttonStyle(PressableStyle(scale: 0.98))
            .accessibilityLabel("SNU ECE 공지방 홈으로 돌아가기")
        }
        .frame(maxWidth: .infinity)
    }

    /// 서랍 아래에 붙는 시계. 데스크톱 레일에 있던 것과 같은 자리다.
    private var railClock: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(now, format: .dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits).second(.twoDigits))
                .font(Theme.Typography.sans(19, .bold))
                .monospacedDigit()
                .tracking(0.8)
                .foregroundStyle(Theme.Palette.railText)
            Text(now, format: .dateTime.year().month(.wide).day().weekday(.wide))
                .font(Theme.Typography.sans(13, .semibold))
                .foregroundStyle(Theme.Palette.railTextDim)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 16)
        .overlay(alignment: .top) {
            Theme.Palette.railText.opacity(0.2).frame(height: 1)
        }
        .accessibilityHidden(true)
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(text)
            .font(Theme.Typography.sans(11, .heavy))
            .tracking(1.1)
            .foregroundStyle(Theme.Palette.railTextDim)
    }

    private func drawerButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(Theme.Typography.sans(14))
                .foregroundStyle(Theme.Palette.railText)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 7)
                .contentShape(Rectangle())
        }
        .buttonStyle(PressableStyle(scale: 0.99))
    }
}
