import SwiftUI

/// 화면 맨 위 제목 줄. 서비스 마크와 워드마크를 한 줄에 세운다.
///
/// 데스크톱은 왼쪽 레일에 마크가 이미 있어 제목에는 넣지 않지만, 폰에는
/// 레일이 없으므로 여기가 유일한 자리다.
///
/// 밝은 배경 위라 앱 마크의 남색 라운드 타일이 그대로 드러난다. 타일만으로는
/// 30pt에서 글자를 읽을 수 없으므로 이름은 옆의 워드마크가 맡는다.
struct BoardHeaderView: View {
    @EnvironmentObject private var board: BoardViewModel
    @EnvironmentObject private var router: AppRouter

    var body: some View {
        HStack(spacing: 9) {
            Button {
                board.resetToHome()
                router.jumpToSearch()
            } label: {
                HStack(spacing: 9) {
                    Image(.appMark)
                        .resizable()
                        .scaledToFit()
                        .frame(height: 30)
                        .padding(.leading, 6)

                    Image(.brandWordmarkHeader)
                        .resizable()
                        .scaledToFit()
                        .frame(height: 32)
                }
            }
            .buttonStyle(PressableStyle(scale: 0.98))
            .accessibilityLabel("SNU ECE 공지방 홈으로 돌아가기")

            Spacer(minLength: 0)

            NotificationBellButton()
        }
        .padding(.top, 2)
        .padding(.bottom, 8)
    }
}

/// 제목 줄 오른쪽 종. 알림을 받고 있으면 노란색으로 바뀐다.
struct NotificationBellButton: View {
    @EnvironmentObject private var router: AppRouter
    @EnvironmentObject private var preferences: NotificationPreferencesStore

    var body: some View {
        Button {
            router.present(.notificationPreferences)
        } label: {
            Image(systemName: preferences.isSubscribed ? "bell.fill" : "bell")
                .font(.system(size: 20, weight: .medium))
                .foregroundStyle(preferences.isSubscribed ? Color(hex: 0xF2B705) : Theme.Palette.textSub)
                .frame(width: 38, height: 38)
        }
        .buttonStyle(PressableStyle())
        .accessibilityLabel(preferences.isSubscribed ? "알림 설정 변경" : "공지 알림 받기")
    }
}
