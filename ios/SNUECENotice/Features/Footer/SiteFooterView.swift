import SwiftUI

/// 목록 맨 아래 푸터.
///
/// 폰에서는 서랍이 접혀 있어 푸터가 사실상 주 내비게이션이 된다. 다만 본문
/// 카드보다 눈에 띄어서는 안 되므로 글자는 카드의 메타 정보만큼 작게 둔다.
/// 순서는 업데이트 시각 → 링크 → 법적 고지다.
struct SiteFooterView: View {
    let syncState: SyncState

    @EnvironmentObject private var router: AppRouter
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            updatedLine
                .tutorialTarget(.footerSync)
                .padding(.bottom, 10)

            HStack(alignment: .top, spacing: 16) {
                VStack(alignment: .leading, spacing: 0) {
                    column("서비스") {
                        footerButton("서비스 안내") { router.present(.userGuide) }
                        footerButton("알림 설정") { router.present(.notificationPreferences) }
                        footerLink("업데이트 내역", "changelog.html")
                    }
                    column("바로가기") {
                        externalLink("전기정보공학부", "https://ece.snu.ac.kr")
                        externalLink("mySNU", "https://my.snu.ac.kr")
                        externalLink("eTL", "https://etl.snu.ac.kr")
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                VStack(alignment: .leading, spacing: 0) {
                    column("문의") {
                        footerButton("일반 문의") { router.present(.feedback) }
                        footerButton("홍보 신청") { router.present(.bannerInquiry) }
                        footerLink("자주 묻는 질문", "faq.html")
                    }
                    .tutorialTarget(.footerLinks)
                    column("운영") {
                        footerLink("운영 주체 안내", "operator.html")
                        footerLink("개인정보처리방침", "privacy.html")
                        footerLink("이용약관", "terms.html")
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            legal
        }
        .padding(.top, 14)
        .padding(.horizontal, 4)
        .overlay(alignment: .top) {
            Theme.Palette.borderSoft.frame(height: 1)
        }
        .padding(.top, 26)
    }

    /// 마지막으로 학부 홈페이지에서 공지를 가져온 시각. 상태 상자 대신
    /// 작고 옅은 한 줄로만 적는다.
    private var updatedLine: some View {
        Text(syncState.updatedLabel)
            .font(Theme.Typography.sans(10.5))
            .foregroundStyle(Theme.Palette.footerText)
            .monospacedDigit()
            .lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityLabel("공지 \(syncState.updatedLabel)")
    }

    private var legal: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("본 서비스는 학생이 운영하는 비공식 통합 안내 페이지입니다. 공지 원문과 운영 기관의 안내를 최종 기준으로 합니다.")
            Text("© \(currentYear) SNU ECE 공지방")
        }
        .font(Theme.Typography.sans(10.5))
        .lineSpacing(3)
        .foregroundStyle(Theme.Palette.footerText)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 10)
        .padding(.bottom, 16)
        .overlay(alignment: .top) {
            Theme.Palette.borderSoft.frame(height: 1).offset(y: -10)
        }
        .padding(.top, 10)
    }

    private var currentYear: String {
        String(DateFormatting.calendar.component(.year, from: Date()))
    }

    @ViewBuilder
    private func column(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title)
                .font(Theme.Typography.sans(11, .bold))
                .foregroundStyle(Theme.Palette.textSub)
                .padding(.bottom, 3)
            content()
        }
        .padding(.vertical, 4)
        .padding(.bottom, 8)
    }

    private func footerButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(Theme.Typography.sans(12.5, .semibold))
                .foregroundStyle(Theme.Palette.textMain)
                .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(PressableStyle(scale: 0.99))
    }

    /// 아직 앱 화면으로 옮기지 않은 문서는 웹의 같은 페이지를 앱 안에서 연다.
    private func footerLink(_ title: String, _ page: String) -> some View {
        footerButton(title) {
            let base = APIConfiguration.current.publicSiteURL
            router.present(.webPage(base.appendingPathComponent(page)))
        }
    }

    private func externalLink(_ title: String, _ url: String) -> some View {
        Button {
            if let target = URL(string: url) { openURL(target) }
        } label: {
            HStack(spacing: 4) {
                Text(title)
                    .font(Theme.Typography.sans(12.5, .semibold))
                Image(systemName: "arrow.up.right.square")
                    .font(.system(size: 10, weight: .bold))
                    .opacity(0.7)
            }
            .foregroundStyle(Theme.Palette.textMain)
            .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableStyle(scale: 0.99))
        .accessibilityLabel("\(title) (새 창)")
    }
}
