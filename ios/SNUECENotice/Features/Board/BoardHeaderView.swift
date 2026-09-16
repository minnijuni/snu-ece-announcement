import SwiftUI

/// 화면 맨 위 남색 띠. 앱 아이콘에 박힌 워드마크를 그대로 얹는다.
///
/// 아이콘과 같은 남색을 좌우 끝과 상태 표시줄 자리까지 채우고 그 위에 흰·금색
/// 워드마크를 두면, 타일 옆에 이름을 또 적는 겹치기 없이 아이콘이 화면으로
/// 그대로 이어진다. 데스크톱은 왼쪽 레일이 이 몫을 하지만 폰에는 레일이
/// 없으므로 여기가 유일한 자리다.
struct BoardHeaderView: View {
    @EnvironmentObject private var board: BoardViewModel

    /// 상태 표시줄 아래로 띠가 차지하는 높이. 목록이 이만큼 올라가면 띠는 다 지나간다.
    static let bandHeight: CGFloat = 64

    var body: some View {
        HStack(spacing: 0) {
            // 마크를 누르면 조건을 지우고 목록을 다시 받는다. 화면은 그대로 둔다 —
            // 검색창으로 굴리지도, 불러오는 중 표시를 띄우지도 않는다. 이 띠는
            // 목록 맨 위에 있어 누르는 순간 이미 홈 화면을 보고 있기 때문이다.
            Button {
                board.resetToHome()
            } label: {
                Image(.brandWordmarkLight)
                    .resizable()
                    .scaledToFit()
                    .frame(height: 48)
            }
            .buttonStyle(PressableStyle(scale: 0.98))
            .accessibilityLabel("SNU ECE 공지방 홈으로 돌아가기")

            Spacer(minLength: 0)

            NotificationBellButton()
        }
        .padding(.leading, 14)
        .padding(.trailing, 8)
        .frame(maxWidth: .infinity)
        .frame(height: Self.bandHeight)
        .background {
            // 당겨서 새로고침하면 띠가 아래로 끌려 내려오며 위가 벌어진다. 그
            // 자리까지 같은 남색으로 이어 두면 상태 표시줄 판과 한 장으로 보인다.
            Theme.Palette.railBackground.padding(.top, -600)
        }
    }
}

/// 띠 오른쪽 종. 남색 위라 흰색이고, 켜 둔 알림이 하나라도 있으면 노란색으로 바뀐다.
struct NotificationBellButton: View {
    @EnvironmentObject private var router: AppRouter
    @EnvironmentObject private var preferences: NotificationPreferencesStore

    var body: some View {
        Button {
            router.present(.notificationPreferences)
        } label: {
            Image(systemName: preferences.isAlertActive ? "bell.fill" : "bell")
                .font(.system(size: 20, weight: .medium))
                .foregroundStyle(preferences.isAlertActive ? Color(hex: 0xF2B705) : Theme.Palette.railText)
                .frame(width: 40, height: 40)
        }
        .buttonStyle(PressableStyle())
        .accessibilityLabel(preferences.isAlertActive ? "알림 설정 변경" : "공지 알림 받기")
    }
}
