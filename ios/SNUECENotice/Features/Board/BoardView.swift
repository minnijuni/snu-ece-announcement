import SwiftUI

/// 공지 목록 화면. 웹 `index.html`의 `#board-view` 한 벌을 그대로 옮겼다.
///
/// 위에서부터 제목 → 카테고리 탭 → 검색 → 상세 필터 → 정렬 → 카드 목록 →
/// 쪽 넘김 → 학내 홍보 → 푸터 순서다. 순서를 바꾸면 웹과 다른 화면이 되므로
/// 새 요소는 이 흐름 안의 제자리에 끼워 넣는다.
struct BoardView: View {
    @EnvironmentObject private var board: BoardViewModel
    @EnvironmentObject private var router: AppRouter

    @State private var scrollOffset: CGFloat = 0
    /// 진짜 검색창이 화면 밖으로 나갔는지. 나갔으면 위에 대신 붙는 줄을 띄운다.
    @State private var searchFieldHidden = false
    /// 왼쪽 위 손잡이는 목록을 조금이라도 내리면 나타나고, 손을 떼고 잠시 두면 사라진다.
    @State private var menuHandleVisible = false
    @State private var menuHideTask: Task<Void, Never>?
    @State private var isFilterExpanded = false
    /// 사용 설명서 투어의 현재 단계. nil이면 꺼져 있다.
    @State private var tutorialIndex: Int?
    /// 투어가 빠른 조건 줄을 보여 주려고 필터를 대신 펼쳤는지. 끝나면 되돌린다.
    @State private var tutorialExpandedFilters = false

    private static let searchAnchor = "notice-search"
    private static let categoryAnchor = "tutorial-categories"
    private static let sortAnchor = "tutorial-sort"
    private static let gridAnchor = "tutorial-grid"
    private static let bannerAnchor = "tutorial-banner"
    private static let footerAnchor = "tutorial-footer"
    /// 손잡이가 스스로 숨기까지 기다리는 시간. 웹 `MENU_HANDLE_IDLE_MS`와 같다.
    private static let menuHandleIdle = Duration.milliseconds(2600)

    var body: some View {
        ScrollViewReader { scroller in
            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 0) {
                    BoardHeaderView()
                        .padding(.bottom, 10)

                    CategoryTabsView(
                        categories: board.orderedCategories,
                        selectedSlug: board.selectedCategorySlug,
                        onSelect: { board.selectCategory(slug: $0) }
                    )
                    .tutorialTarget(.categoryTabs)
                    .id(Self.categoryAnchor)
                    .padding(.bottom, 12)

                    searchSection(scroller)
                        .id(Self.searchAnchor)

                    ResultsToolbar(
                        total: board.pagination.total,
                        showsCount: board.showsResultCount,
                        sort: board.filters.sort,
                        onSelectSort: { board.setSort($0) }
                    )
                    .id(Self.sortAnchor)
                    .padding(.vertical, 4)

                    NoticeGrid(
                        notices: board.notices,
                        isLoading: board.isLoading && !board.hasLoadedOnce,
                        // 결과 건수 줄이 서면 그 자리가 채워지므로 왼쪽 열을 끌어올리지 않는다.
                        staggered: !board.showsResultCount,
                        thumbnailURL: { board.service.thumbnailURL(for: $0) },
                        onSelect: { router.openNotice(id: $0.id) }
                    )
                    .id(Self.gridAnchor)
                    .padding(.top, 2)

                    emptyOrError

                    if board.pagination.total > 0 {
                        NoticePaginationView(
                            pagination: board.pagination,
                            isLoading: board.isLoading,
                            onSelect: { page in
                                Task {
                                    await board.goToPage(page)
                                    withAnimation { scroller.scrollTo(Self.searchAnchor, anchor: .top) }
                                }
                            }
                        )
                    }

                    BannerCarouselView(slides: board.bannerSlides.displayableRightRail)
                        .tutorialTarget(.banner)
                        .id(Self.bannerAnchor)
                        .padding(.vertical, 4)

                    SiteFooterView(syncState: board.syncState)
                        .id(Self.footerAnchor)
                }
                .padding(.horizontal, Theme.Metrics.pagePadding)
                // 본문 폭을 스크롤 영역 폭에 못박는다. 안쪽 어느 한 조각이
                // 제 몫보다 넓다고 보고해도 가로로 밀려나지 않는다 — 웹에서
                // 칸마다 `minmax(0, 1fr)`과 `min-width: 0`으로 막아 둔 것과 같은 뜻이다.
                .containerRelativeFrame(.horizontal)
            }
            // 세로 목록이므로 가로로는 튕기지도 않는다. 비스듬히 쓸어도
            // 아래위로만 움직인다.
            .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
            // 스크롤 위치를 읽는 자리. GeometryReader와 preference로 재던 예전
            // 방식은 ScrollView 안에서 값이 밖으로 나오지 않아 쓰지 않는다.
            .onScrollGeometryChange(for: CGFloat.self) { geometry in
                geometry.contentOffset.y + geometry.contentInsets.top
            } action: { _, offset in
                handleScroll(offset: offset)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.Palette.background)
            .refreshable { await board.refresh() }
            .onChange(of: router.scrollToSearchToken) { _, _ in
                withAnimation { scroller.scrollTo(Self.searchAnchor, anchor: .top) }
            }
            // 내비게이션 바를 감췄으므로 본문이 상태 표시줄 아래로 흘러 들어가
            // 시계와 글자가 겹친다. 그 자리만 흰 판으로 덮어 둔다.
            .overlay(alignment: .top) { StatusBarBackdrop() }
            .overlay(alignment: .top) { stickySearchBar }
            .overlay(alignment: .topLeading) { floatingMenuHandle }
            .overlay(alignment: .center) {
                if board.isLoading && board.hasLoadedOnce {
                    LoadingOverlay(message: "공지를 불러오는 중입니다…")
                        .transition(.opacity)
                }
            }
            .animation(.easeOut(duration: 0.18), value: board.isLoading)
            // 사용 설명서 투어. 위 겹칠 것들까지 모두 덮도록 맨 마지막에 얹는다.
            .overlayPreferenceValue(TutorialAnchorKey.self) { anchors in
                if let step = tutorialIndex {
                    TutorialOverlayView(
                        index: step,
                        anchors: anchors,
                        onPrev: { tutorialGo(step - 1, scroller) },
                        onNext: { tutorialGo(step + 1, scroller) },
                        onSkip: { endTutorial() },
                        onOpenDoc: {
                            endTutorial()
                            router.present(.userGuide)
                        }
                    )
                }
            }
        }
        .toolbar(.hidden, for: .navigationBar)
    }

    // MARK: - 사용 설명서 투어

    /// 지금 단계가 왼쪽 위 손잡이를 짚고 있는지. 그동안은 손잡이가 스스로
    /// 숨는 것을 막아 둔다 — 웹 튜토리얼이 `is-visible`을 붙잡아 두는 것과 같다.
    private var tutorialHoldsMenuHandle: Bool {
        tutorialIndex.map { TutorialStep.all[$0].target == .menuHandle } ?? false
    }

    private func tutorialGo(_ newIndex: Int, _ scroller: ScrollViewProxy) {
        guard newIndex >= 0 else { return }
        guard newIndex < TutorialStep.all.count else {
            endTutorial()
            return
        }
        let step = TutorialStep.all[newIndex]

        // 빠른 조건 줄은 필터를 펼쳐야 화면에 생긴다. 투어가 대신 펼쳤으면 기억해 뒀다 되돌린다.
        if step.target == .quickFilters, !isFilterExpanded {
            tutorialExpandedFilters = true
            withAnimation(.easeOut(duration: 0.22)) { isFilterExpanded = true }
        }
        if step.target == .menuHandle {
            menuHideTask?.cancel()
            withAnimation(.easeOut(duration: 0.2)) { menuHandleVisible = true }
        }

        withAnimation(.easeInOut(duration: 0.35)) {
            tutorialIndex = newIndex
            scrollTutorialTarget(step, scroller)
        }
    }

    private func scrollTutorialTarget(_ step: TutorialStep, _ scroller: ScrollViewProxy) {
        switch step.target {
        case .searchField, .guideButton, .quickFilters, .filterToggle:
            scroller.scrollTo(Self.searchAnchor, anchor: .top)
        case .categoryTabs:
            scroller.scrollTo(Self.categoryAnchor, anchor: .center)
        case .sortChips:
            scroller.scrollTo(Self.sortAnchor, anchor: .center)
        case .noticeCard:
            scroller.scrollTo(Self.gridAnchor, anchor: .top)
        case .banner:
            scroller.scrollTo(Self.bannerAnchor, anchor: .center)
        case .footerLinks:
            scroller.scrollTo(Self.footerAnchor, anchor: .center)
        case .footerSync:
            scroller.scrollTo(Self.footerAnchor, anchor: .top)
        case .menuHandle, nil:
            break // 화면에 붙박인 것과 마지막 인사는 굴릴 곳이 없다.
        }
    }

    private func endTutorial() {
        withAnimation(.easeOut(duration: 0.25)) { tutorialIndex = nil }
        if tutorialExpandedFilters {
            tutorialExpandedFilters = false
            withAnimation(.easeOut(duration: 0.22)) { isFilterExpanded = false }
        }
        if menuHandleVisible { scheduleMenuHandleHide() }
    }

    // MARK: - 조각들

    private func searchSection(_ scroller: ScrollViewProxy) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            NoticeSearchField(
                text: Binding(
                    get: { board.filters.searchText },
                    set: { board.searchTextChanged($0) }
                ),
                onGuide: { tutorialGo(0, scroller) }
            )
            .tutorialTarget(.searchField)

            FilterToggleBar(
                isExpanded: isFilterExpanded,
                chips: board.filters.activeChips,
                onToggle: {
                    withAnimation(.easeOut(duration: 0.22)) { isFilterExpanded.toggle() }
                },
                onRemoveChip: { board.clearChip($0) }
            )
            .tutorialTarget(.filterToggle)
            .padding(.top, 8)

            if isFilterExpanded {
                QuickFiltersRow(
                    isOn: { board.filters.isOn($0) },
                    onToggle: { board.toggleQuickFilter($0) }
                )
                .tutorialTarget(.quickFilters)
                .padding(.top, 5)
                .transition(.move(edge: .top).combined(with: .opacity))

                FilterPanel(
                    filters: board.filters,
                    hosts: board.hosts,
                    onApply: { board.applyFilters($0) },
                    onReset: { board.resetDetailedFilters() },
                    onClose: { withAnimation(.easeOut(duration: 0.22)) { isFilterExpanded = false } }
                )
                .padding(.top, 6)
                .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
    }

    @ViewBuilder
    private var emptyOrError: some View {
        if let error = board.loadError {
            if board.notices.isEmpty {
                NoticeEmptyState(
                    title: "공지 목록을 불러오지 못했습니다.",
                    message: error.message,
                    actionTitle: "다시 시도",
                    isError: true,
                    action: { Task { await board.reload(page: 1) } }
                )
            } else {
                // 보고 있던 목록이 남아 있으면 화면을 통째로 덮지 않는다.
                // 새로 받아오지 못했다는 것만 한 줄로 알리고 다시 시도할 길을 준다.
                refreshFailureBanner(error)
            }
        } else if board.isEmpty && board.hasLoadedOnce {
            emptyState
        }
    }

    private func refreshFailureBanner(_ error: APIError) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 13, weight: .bold))
            Text(error.message)
                .font(Theme.Typography.sans(12.5, .semibold))
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            Button("다시 시도") {
                Task { await board.reload(page: max(1, board.pagination.page)) }
            }
            .font(Theme.Typography.sans(12.5, .bold))
            .fixedSize()
        }
        .foregroundStyle(Theme.Palette.danger)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Theme.Palette.dangerBackground)
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(Theme.Palette.danger.opacity(0.22), lineWidth: 1)
                )
        )
        .padding(.top, 12)
    }

    /// 웹 `renderNoticeEmptyState()`와 문구가 같다. 검색 결과가 없을 때와
    /// 조건이 걸린 채 비었을 때, 아무것도 없을 때를 갈라 말한다.
    private var emptyState: some View {
        let search = board.filters.searchText.trimmed
        if !search.isEmpty {
            return NoticeEmptyState(
                title: "“\(search)” 검색 결과가 없습니다.",
                message: "검색어를 줄이거나 다른 표현으로 다시 찾아보세요.",
                actionTitle: "검색어 지우기",
                action: { board.clearSearch() }
            )
        }
        if board.filters.hasDetailedFilters {
            return NoticeEmptyState(
                title: "해당하는 공지가 없습니다.",
                message: "다른 카테고리나 조건으로 다시 확인해 주세요."
            )
        }
        return NoticeEmptyState(
            title: "아직 등록된 공지가 없습니다.",
            message: "새 공지가 검수되면 이곳에 표시됩니다."
        )
    }

    /// 목록을 한참 내려가 진짜 검색창이 화면 밖으로 나가면 그때부터 대신 선다.
    @ViewBuilder
    private var stickySearchBar: some View {
        if searchFieldHidden {
            StickySearchBar { router.jumpToSearch() }
                .transition(.move(edge: .top).combined(with: .opacity))
        }
    }

    /// 화면 왼쪽 위에 떠 있는 손잡이. 흐름에서 빠져 있어 제목은 이 버튼이
    /// 없는 것처럼 왼쪽 끝에 붙는다.
    @ViewBuilder
    private var floatingMenuHandle: some View {
        if menuHandleVisible || tutorialHoldsMenuHandle {
            Button {
                router.openDrawer()
            } label: {
                Image(systemName: "line.3.horizontal")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(searchFieldHidden ? Theme.Palette.primary : Color(hex: 0x7C8698))
                    .frame(width: 34, height: 34)
                    .background {
                        if !searchFieldHidden {
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .fill(.regularMaterial)
                                .overlay(
                                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                                        .stroke(Theme.Palette.primary.opacity(0.1), lineWidth: 1)
                                )
                        }
                    }
            }
            .buttonStyle(PressableStyle())
            .accessibilityLabel("메뉴 열기")
            .tutorialTarget(.menuHandle)
            .padding(.leading, 10)
            .padding(.top, searchFieldHidden ? 12 : 10)
            .transition(.opacity.combined(with: .move(edge: .top)))
        }
    }

    // MARK: - 스크롤 반응

    private func handleScroll(offset: CGFloat) {
        scrollOffset = offset
        // 검색창은 제목·탭 아래에 있다. 그만큼 내려가면 화면 밖으로 나간 것으로 본다.
        let hidden = offset > 190
        if hidden != searchFieldHidden {
            withAnimation(.easeOut(duration: 0.18)) { searchFieldHidden = hidden }
        }

        guard offset > 12 else {
            menuHideTask?.cancel()
            if menuHandleVisible {
                withAnimation(.easeOut(duration: 0.2)) { menuHandleVisible = false }
            }
            return
        }
        if !menuHandleVisible {
            withAnimation(.easeOut(duration: 0.2)) { menuHandleVisible = true }
        }
        scheduleMenuHandleHide()
    }

    private func scheduleMenuHandleHide() {
        menuHideTask?.cancel()
        menuHideTask = Task {
            try? await Task.sleep(for: Self.menuHandleIdle)
            guard !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: 0.2)) { menuHandleVisible = false }
        }
    }
}
