import SwiftUI

/// 상태 표시줄 글자색을 화면이 정한다.
///
/// SwiftUI는 상태 표시줄 색을 화면의 색상 모드로만 고르는데, 이 앱은 라이트로
/// 고정돼 있어 목록 위 남색 띠에서도 시계가 검게 찍힌다. 그래서 `Info.plist`의
/// `UIViewControllerBasedStatusBarAppearance`를 꺼 앱 단위 설정으로 돌리고,
/// 화면이 뜰 때마다 제 바탕에 맞는 색을 요구한다 — 목록은 흰 글자, 상세는 검은 글자.
/// 그 대신 `.statusBarHidden()`도 듣지 않으므로 숨김 역시 여기로 부른다.
enum StatusBarAppearance {
    static func apply(_ style: UIStatusBarStyle) {
        UIApplication.shared.setStatusBarStyle(style, animated: true)
    }

    static func setHidden(_ hidden: Bool) {
        UIApplication.shared.setStatusBarHidden(hidden, with: .fade)
    }
}

extension View {
    /// 이 화면이 보일 때 상태 표시줄 글자를 `style`로 바꾼다.
    func statusBarStyle(_ style: UIStatusBarStyle) -> some View {
        onAppear { StatusBarAppearance.apply(style) }
    }
}
