import SwiftUI

/// 사용 설명서 투어. 웹 `js/tutorial.js`를 그대로 옮겼다.
///
/// 문서를 읽히는 대신 실제 화면 위에서 한 기능씩 짚는다. 설명하는 자리만
/// 남기고 나머지는 어둡게 덮으므로 시선이 흩어지지 않는다. 안내 중에는
/// 아래 화면을 누를 수 없다 — 서랍이 열리거나 상세로 넘어가면 다음에 짚을
/// 자리가 사라져 안내가 끊기기 때문이다. 이동은 카드의 이전·다음뿐이다.
///
/// 짚는 자리는 각 뷰가 `tutorialTarget(_:)`으로 자기 테두리를 알려 주고,
/// 이 층이 anchor preference로 모아 읽는다. 자리가 화면에 없는 단계
/// (예: 필터를 접어 둔 동안의 빠른 조건 줄)는 들어가기 전에 펼쳐 만든다.

// MARK: - 표적

enum TutorialTarget: Hashable {
    case searchField
    case guideButton
    case menuHandle
    case categoryTabs
    case quickFilters
    case filterToggle
    case sortChips
    case noticeCard
    case banner
    case footerLinks
    case footerSync
}

struct TutorialAnchorKey: PreferenceKey {
    static var defaultValue: [TutorialTarget: Anchor<CGRect>] = [:]
    static func reduce(value: inout [TutorialTarget: Anchor<CGRect>],
                       nextValue: () -> [TutorialTarget: Anchor<CGRect>]) {
        value.merge(nextValue()) { _, new in new }
    }
}

extension View {
    /// 튜토리얼이 짚을 수 있게 자기 테두리를 알린다. nil이면 아무 일도 하지 않는다
    /// (목록 첫 카드처럼 조건이 맞는 하나만 알릴 때 쓴다).
    @ViewBuilder
    func tutorialTarget(_ target: TutorialTarget?) -> some View {
        if let target {
            anchorPreference(key: TutorialAnchorKey.self, value: .bounds) { [target: $0] }
        } else {
            self
        }
    }
}

// MARK: - 단계

struct TutorialStep {
    /// nil이면 마지막 인사 단계 — 짚을 곳 없이 화면 전체를 덮는다.
    let target: TutorialTarget?
    let title: String
    let body: String
    var hint: String?

    /// 문구는 웹 `js/tutorial.js`의 것을 그대로 쓰되, 데스크톱 전용
    /// 단계(끌어서 비교)는 뺐다.
    static let all: [TutorialStep] = [
        TutorialStep(target: .searchField,
                     title: "검색으로 시작하세요",
                     body: "제목과 본문을 함께 찾습니다. 글자를 입력하는 즉시 아래 목록이 걸러지니 검색 버튼을 따로 누를 필요는 없습니다.",
                     hint: "안내를 보는 동안에는 화면이 잠깁니다"),
        TutorialStep(target: .guideButton,
                     title: "이 안내는 언제든 다시",
                     body: "검색은 입력만으로 걸리기 때문에 돋보기 자리는 설명서 입구로 씁니다. 길을 잃으면 여기를 누르세요."),
        TutorialStep(target: .menuHandle,
                     title: "왼쪽 위 손잡이",
                     body: "목록을 조금 내리면 나타납니다. 누르면 바로가기 서랍이 열리고, 잠시 두면 다시 숨어 화면을 가리지 않습니다. 화면 왼쪽 끝에서 오른쪽으로 밀어도 열립니다."),
        TutorialStep(target: .categoryTabs,
                     title: "카테고리로 나눠 보기",
                     body: "학사·기회·설문·행사로 갈라 봅니다. 기회와 설문은 마감이 급한 순서로, 학사와 행사는 최신 순서로 자동 정렬됩니다."),
        TutorialStep(target: .quickFilters,
                     title: "자주 쓰는 조건은 한 번에",
                     body: "마감 임박, 리워드 있음, 신청 필요, 마감을 바로 켜고 끕니다. 여러 개를 함께 켜면 모두 만족하는 공지만 남습니다."),
        TutorialStep(target: .filterToggle,
                     title: "더 좁히고 싶다면",
                     body: "대상 학번, 마감 상태, 주관 기관, 조회수, 마감일 범위까지 상세 조건을 펼쳐 고를 수 있습니다. 켜 둔 조건은 이 줄에 칩으로 남아 한눈에 보입니다."),
        TutorialStep(target: .sortChips,
                     title: "정렬 바꾸기",
                     body: "최신순, 마감임박순, 조회순 중에 고릅니다. 마감임박순에서 마감일이 없는 공지는 맨 뒤로 갑니다."),
        TutorialStep(target: .noticeCard,
                     title: "공지 열어보기",
                     body: "카드를 누르면 원문, 첨부파일, AI 3줄 요약을 함께 봅니다. 요약은 참고용이고 판단은 언제나 원문이 기준입니다."),
        TutorialStep(target: .banner,
                     title: "학내 홍보",
                     body: "목록 아래는 학생 단체와 학내 행사 홍보가 도는 자리입니다. 검수를 거친 항목만 정해진 기간 동안 걸립니다."),
        TutorialStep(target: .footerLinks,
                     title: "문의와 홍보 신청",
                     body: "개선 의견은 익명으로 보낼 수 있고, 홍보 신청은 양식을 내면 검수 뒤 배너로 올라갑니다. 자주 묻는 질문도 여기 있습니다."),
        TutorialStep(target: .footerSync,
                     title: "언제 가져온 공지인지",
                     body: "마지막으로 학부 홈페이지에서 공지를 가져온 시각입니다. 원문이 방금 올라왔다면 여기 시각 이후에 반영됩니다."),
        TutorialStep(target: nil,
                     title: "준비되었습니다",
                     body: "이제 화면 잠금을 풀고 직접 써 보세요. 검색으로 찾고, 조건으로 좁히고, 열어서 확인하면 됩니다. 이 안내는 검색창 오른쪽 돋보기에서 언제든 다시 열 수 있습니다.")
    ]
}

// MARK: - 가림판

/// 화면 전체를 덮되 짚는 자리만 뚫린 판. 구멍 네 변이 모두 움직일 수 있어야
/// 단계 사이를 미끄러지듯 옮겨 다니므로 rect 전체를 animatableData로 쓴다.
private struct SpotlightShade: Shape {
    var hole: CGRect
    var corner: CGFloat

    var animatableData: AnimatablePair<AnimatablePair<CGFloat, CGFloat>,
                                       AnimatablePair<CGFloat, CGFloat>> {
        get {
            AnimatablePair(AnimatablePair(hole.origin.x, hole.origin.y),
                           AnimatablePair(hole.size.width, hole.size.height))
        }
        set {
            hole = CGRect(x: newValue.first.first, y: newValue.first.second,
                          width: newValue.second.first, height: newValue.second.second)
        }
    }

    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.addRect(rect)
        if hole.width > 0, hole.height > 0 {
            path.addRoundedRect(in: hole.intersection(rect.insetBy(dx: -40, dy: -40)),
                                cornerSize: CGSize(width: corner, height: corner),
                                style: .continuous)
        }
        return path
    }
}

// MARK: - 층

struct TutorialOverlayView: View {
    let index: Int
    let anchors: [TutorialTarget: Anchor<CGRect>]
    let onPrev: () -> Void
    let onNext: () -> Void
    let onSkip: () -> Void
    let onOpenDoc: () -> Void

    private static let corner: CGFloat = 14
    private static let cardGap: CGFloat = 14
    private static let edge: CGFloat = 12
    private static let move = Animation.easeInOut(duration: 0.35)

    private var steps: [TutorialStep] { TutorialStep.all }
    private var step: TutorialStep { steps[min(index, steps.count - 1)] }

    var body: some View {
        GeometryReader { proxy in
            let hole = holeRect(in: proxy)
            ZStack(alignment: .topLeading) {
                // 덮개. 아래 화면으로는 탭도 끌기도 내려가지 않는다.
                SpotlightShade(hole: hole ?? centerPoint(of: proxy), corner: Self.corner)
                    .fill(Color.black.opacity(0.56), style: FillStyle(eoFill: true))
                    .contentShape(Rectangle())
                    .onTapGesture {}
                    .gesture(DragGesture())
                    .animation(Self.move, value: hole)

                // 짚는 자리를 감싸는 테두리
                if let hole {
                    RoundedRectangle(cornerRadius: Self.corner, style: .continuous)
                        .stroke(Color.white.opacity(0.95), lineWidth: 2.5)
                        .shadow(color: .black.opacity(0.35), radius: 8)
                        .frame(width: hole.width, height: hole.height)
                        .position(x: hole.midX, y: hole.midY)
                        .animation(Self.move, value: hole)
                        .allowsHitTesting(false)
                }

                card(in: proxy, hole: hole)
            }
        }
        /* 안전 영역 무시는 GeometryReader 바깥에 건다. 안쪽 ZStack에 걸면
           판만 화면 끝까지 늘어나고 앵커 좌표는 안전 영역 안을 기준으로 남아,
           구멍이 상태 표시줄 높이만큼 위로 어긋난다 — 노치 높이가 기기마다
           달라 어긋남도 기기마다 달랐다. 재는 곳과 그리는 곳이 한 좌표계를
           써야 구멍이 표적 위에 앉는다. */
        .ignoresSafeArea()
        .transition(.opacity)
    }

    // MARK: 자리 계산

    private func holeRect(in proxy: GeometryProxy) -> CGRect? {
        guard let target = step.target, let anchor = anchors[target] else { return nil }
        return proxy[anchor].insetBy(dx: -5, dy: -5)
    }

    /// 마지막 단계처럼 짚을 곳이 없으면 화면 한가운데 크기 없는 구멍을 준다.
    private func centerPoint(of proxy: GeometryProxy) -> CGRect {
        CGRect(x: proxy.size.width / 2, y: proxy.size.height / 2, width: 0, height: 0)
    }

    /// 설명 카드. 짚는 자리가 화면 위쪽이면 아래에, 아래쪽이면 위에 선다.
    /// 마지막 단계는 한가운데.
    @ViewBuilder
    private func card(in proxy: GeometryProxy, hole: CGRect?) -> some View {
        let placeBottom = (hole?.midY ?? 0) < proxy.size.height / 2
        let alignment: Alignment = hole == nil ? .center : (placeBottom ? .bottom : .top)
        let topInset = hole.map { $0.maxY + Self.cardGap } ?? 0
        let bottomInset = hole.map { proxy.size.height - $0.minY + Self.cardGap } ?? 0

        VStack(spacing: 0) { cardBody }
            .frame(maxWidth: 420)
            .padding(.horizontal, Self.edge)
            .padding(.top, alignment == .top && hole != nil
                     ? max(Self.edge, proxy.safeAreaInsets.top + Self.edge)
                     : (alignment == .bottom ? 0 : Self.edge))
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: alignment)
            .padding(.top, alignment == .bottom && hole != nil ? min(topInset, proxy.size.height * 0.55) : 0)
            .padding(.bottom, alignment == .top && hole != nil
                     ? min(bottomInset, proxy.size.height * 0.55)
                     : proxy.safeAreaInsets.bottom + Self.edge)
            .animation(Self.move, value: index)
    }

    private var cardBody: some View {
        VStack(alignment: .leading, spacing: 8) {
            // 진행 막대
            GeometryReader { bar in
                Capsule()
                    .fill(Theme.Palette.primaryLight)
                    .overlay(alignment: .leading) {
                        Capsule()
                            .fill(Theme.Palette.primary)
                            .frame(width: bar.size.width * CGFloat(index + 1) / CGFloat(steps.count))
                            .animation(Self.move, value: index)
                    }
            }
            .frame(height: 4)
            .padding(.bottom, 2)

            Text("\(index + 1) / \(steps.count)")
                .font(Theme.Typography.sans(11, .bold))
                .foregroundStyle(Theme.Palette.textSub)
                .monospacedDigit()

            Text(step.title)
                .font(Theme.Typography.sans(17, .bold))
                .foregroundStyle(Theme.Palette.textMain)

            Text(step.body)
                .font(Theme.Typography.sans(13))
                .lineSpacing(4)
                .foregroundStyle(Theme.Palette.textSub)
                .fixedSize(horizontal: false, vertical: true)

            if let hint = step.hint {
                HStack(spacing: 6) {
                    Circle().fill(Theme.Palette.primary).frame(width: 5, height: 5)
                    Text(hint)
                        .font(Theme.Typography.sans(11.5, .semibold))
                        .foregroundStyle(Theme.Palette.textSub)
                }
                .padding(.top, 2)
            }

            Button(action: onOpenDoc) {
                Text("글로 된 설명서 보기")
                    .font(Theme.Typography.sans(12, .semibold))
                    .underline()
                    .foregroundStyle(Theme.Palette.primary)
            }
            .buttonStyle(.plain)
            .padding(.top, 2)

            HStack(spacing: 8) {
                Button("그만 보기", action: onSkip)
                    .font(Theme.Typography.sans(12.5, .semibold))
                    .foregroundStyle(Theme.Palette.textSub)
                    .buttonStyle(.plain)

                Spacer(minLength: 0)

                if index > 0 {
                    Button(action: onPrev) {
                        Text("이전")
                            .font(Theme.Typography.sans(13, .bold))
                            .foregroundStyle(Theme.Palette.textMain)
                            .padding(.horizontal, 14)
                            .frame(minHeight: 36)
                            .background(
                                Capsule().fill(Color.white)
                                    .overlay(Capsule().stroke(Theme.Palette.border, lineWidth: 1))
                            )
                    }
                    .buttonStyle(PressableStyle())
                }

                Button(action: onNext) {
                    Text(index == steps.count - 1 ? "마치기" : "다음")
                        .font(Theme.Typography.sans(13, .bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 18)
                        .frame(minHeight: 36)
                        .background(Capsule().fill(Theme.Palette.primary))
                }
                .buttonStyle(PressableStyle())
            }
            .padding(.top, 6)
        }
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(Color.white)
                .shadow(color: .black.opacity(0.25), radius: 18, y: 6)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel("사용 설명서 \(index + 1)단계, \(step.title)")
    }
}
