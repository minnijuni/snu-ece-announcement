import SwiftUI

/// 앱의 바깥 껍데기. 목록 스택 위에 왼쪽 서랍을 얹는다.
///
/// 웹은 `.rail-left`를 `transform: translateX(-100%)`로 밀어 두었다가 서랍으로
/// 끌어냈다. 여기서도 같은 방식이다 — 화면 왼쪽 가장자리에서 오른쪽으로 밀면
/// 열리고, 열린 상태에서 왼쪽으로 밀거나 막을 누르면 닫힌다.
struct RootView: View {
    @EnvironmentObject private var board: BoardViewModel
    @EnvironmentObject private var analytics: BetaAnalytics
    @EnvironmentObject private var notifications: NotificationPreferencesStore
    @StateObject private var router = AppRouter()
    @Environment(\.scenePhase) private var scenePhase

    @State private var drawerDrag: CGFloat = 0
    /// 백그라운드를 거쳤는지. 컨트롤 센터·알림 배너·앱 전환기처럼 `.inactive`만
    /// 스치는 경우와 구분한다 — 그때마다 서버를 부르면 낭비다.
    @State private var wasInBackground = false

    var body: some View {
        GeometryReader { proxy in
            let drawerWidth = min(Theme.Metrics.drawerWidth, proxy.size.width * Theme.Metrics.drawerMaxWidthRatio)

            ZStack(alignment: .leading) {
                NavigationStack(path: $router.path) {
                    BoardView()
                        .navigationDestination(for: Int.self) { noticeId in
                            NoticeDetailView(noticeId: noticeId)
                        }
                }
                .disabled(router.isDrawerOpen)

                // 서랍 뒤를 덮는 막. 누르면 닫힌다.
                if router.isDrawerOpen || drawerDrag > 0 {
                    Color(hex: 0x0F2C62)
                        .opacity(0.5 * scrimProgress(width: drawerWidth))
                        .ignoresSafeArea()
                        .onTapGesture { router.closeDrawer() }
                        .accessibilityLabel("메뉴 닫기")
                        .accessibilityAddTraits(.isButton)
                }

                SideDrawerView()
                    .frame(width: drawerWidth)
                    .offset(x: drawerOffset(width: drawerWidth))
                    .ignoresSafeArea(edges: .vertical)

                // 베타 평가창. 공지를 3번째·13번째 열었을 때 한 번씩 뜬다.
                if let prompt = analytics.pendingPrompt {
                    BetaRatingPromptView(
                        prompt: prompt,
                        onRate: { analytics.submitRating($0) },
                        onDismiss: { analytics.dismissPrompt() }
                    )
                    .zIndex(10)
                }
            }
            .animation(.easeOut(duration: 0.2), value: analytics.pendingPrompt)
            // 왼쪽 가장자리에서 밀어 열고, 열린 서랍은 왼쪽으로 밀어 닫는다.
            .simultaneousGesture(edgeDragGesture(width: drawerWidth, screenWidth: proxy.size.width))
        }
        .environmentObject(router)
        .sheet(item: $router.sheet) { sheet in
            switch sheet {
            case .feedback:
                FeedbackView()
            case .notificationPreferences:
                NotificationPreferencesView()
            case .userGuide:
                UserGuideView()
            case .bannerInquiry:
                BannerInquiryView()
            case .webPage(let url):
                SafariView(url: url).ignoresSafeArea()
            }
        }
        .onOpenURL { router.handle(url: $0) }
        #if DEBUG
        // 시뮬레이터에서는 탭을 넣을 수 없어 시트를 열어 볼 길이 없다. 실행 인자로 연다:
        //   xcrun simctl launch <udid> kr.ac.notice.ece.snu -presentSheet notifications
        // 상세도 같다 — 딥링크는 시뮬레이터가 "열까요?" 확인창을 띄워 넘어가지 못한다:
        //   xcrun simctl launch <udid> kr.ac.notice.ece.snu -openNotice 92
        .onAppear {
            switch UserDefaults.standard.string(forKey: "presentSheet") {
            case "notifications": router.present(.notificationPreferences)
            case "guide": router.present(.userGuide)
            case "feedback": router.present(.feedback)
            default: break
            }
            if let id = UserDefaults.standard.string(forKey: "openNotice").flatMap(Int.init) {
                router.openNotice(id: id)
            }
        }
        #endif
        .task {
            analytics.appLaunched()
            // 목록을 먼저 띄운다. 권한 물음은 사용자가 답할 때까지 멈춰
            // 있으므로 앞에 두면 첫 화면까지 그만큼 늦어진다.
            await board.loadInitialIfNeeded()
            await notifications.requestAuthorizationIfNeeded()
            await notifications.rescheduleReminders(for: board.notices)
        }
        // 목록이 갱신될 때마다 마감 알림을 다시 세운다. 설정 화면에서 저장할
        // 때만 예약하면 그 뒤 새로 받은 공지의 마감은 영영 잡히지 않는다.
        .onChange(of: board.notices) { _, notices in
            Task { await notifications.rescheduleReminders(for: notices) }
        }
        // 백그라운드에 있다가 돌아오면 그동안 올라온 공지를 받는다. 관리자가
        // 등록한 공지는 서버에 바로 실리지만, 앱은 켜 둔 채로 다시 조회하지
        // 않아 사용자가 당겨서 새로고침하기 전까지 보이지 않았다.
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background:
                wasInBackground = true
            case .active where wasInBackground:
                wasInBackground = false
                Task { await board.refreshAfterForeground() }
            default:
                break
            }
        }
    }

    private func drawerOffset(width: CGFloat) -> CGFloat {
        let closed = -width
        if router.isDrawerOpen {
            return min(0, closed + width + min(0, drawerDrag))
        }
        return min(0, closed + max(0, drawerDrag))
    }

    private func scrimProgress(width: CGFloat) -> Double {
        let offset = drawerOffset(width: width)
        return Double(1 + offset / width)
    }

    private func edgeDragGesture(width: CGFloat, screenWidth: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 12, coordinateSpace: .global)
            .onChanged { value in
                let startedAtEdge = value.startLocation.x < 24
                if router.isDrawerOpen {
                    drawerDrag = max(-width, min(0, value.translation.width))
                } else if startedAtEdge {
                    drawerDrag = max(0, min(width, value.translation.width))
                }
            }
            .onEnded { value in
                let travelled = value.translation.width
                let startedAtEdge = value.startLocation.x < 24
                drawerDrag = 0
                if router.isDrawerOpen, travelled < -60 {
                    router.closeDrawer()
                } else if !router.isDrawerOpen, startedAtEdge, travelled > 60 {
                    router.openDrawer()
                }
            }
    }
}
