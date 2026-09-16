import SwiftUI

/// 공지 상세. 목록을 덮는 별도 화면이며 뒤로가기로 목록에 돌아온다.
///
/// 위에서부터 태그 → 제목 → 메타 → 사진 → AI 3줄 요약 → 원문 → 출처·첨부 →
/// 링크 복사 순서다. 요약은 참고용이고 판단 기준은 언제나 원문이므로
/// 원문 상자를 요약보다 크게 잡는다.
struct NoticeDetailView: View {
    let noticeId: Int

    @EnvironmentObject private var board: BoardViewModel
    @EnvironmentObject private var analytics: BetaAnalytics
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    @StateObject private var model: NoticeDetailViewModel
    @State private var imageIndex = 0
    @State private var viewerIndex: Int?
    @State private var copiedLink = false

    init(noticeId: Int) {
        self.noticeId = noticeId
        _model = StateObject(wrappedValue: NoticeDetailViewModel(noticeId: noticeId, service: NoticeService()))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                backButton

                if let notice = model.notice {
                    content(for: notice)
                } else if let error = model.error {
                    NoticeEmptyState(
                        title: "공지 상세를 불러오지 못했습니다.",
                        message: error.message,
                        actionTitle: "다시 시도",
                        isError: true,
                        action: { Task { await model.retry(onViewCounted: applyViewCount) } }
                    )
                } else {
                    ProgressView()
                        .tint(Theme.Palette.primary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 80)
                }
            }
            .padding(.horizontal, Theme.Metrics.pagePadding)
            .padding(.bottom, 32)
        }
        .background(Theme.Palette.background)
        .toolbar(.hidden, for: .navigationBar)
        // 내비게이션 바가 없으므로 본문이 상태 표시줄 아래로 흘러 들어간다.
        // 그 자리만 흰 판으로 덮어 시계와 글자가 겹치지 않게 한다.
        .overlay(alignment: .top) { StatusBarBackdrop() }
        // 목록은 남색 띠 위라 흰 시계를 쓴다. 여기는 흰 판이니 검은 시계로 되돌린다.
        .statusBarStyle(.darkContent)
        .task {
            await model.load(onViewCounted: applyViewCount)
            // 열람 수는 상세가 실제로 떠야 센다. 불러오기에 실패한 화면은 세지 않는다.
            if model.notice != nil { analytics.noticeOpened() }
        }
        .fullScreenCover(item: Binding(
            get: { viewerIndex.map(ImageViewerTarget.init) },
            set: { viewerIndex = $0?.index }
        )) { target in
            ImageViewerView(urls: model.images, startIndex: target.index)
        }
    }

    private func applyViewCount(_ views: Int) {
        board.applyViewCount(views, for: noticeId)
    }

    // MARK: - 조각들

    private var backButton: some View {
        Button {
            dismiss()
        } label: {
            Image(systemName: "chevron.left")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Theme.Palette.textMain)
                .frame(width: 40, height: 40)
                .background(Circle().fill(Color.white).overlay(Circle().stroke(Theme.Palette.border, lineWidth: 1)))
        }
        .buttonStyle(PressableStyle())
        .accessibilityLabel("이전 화면")
        .padding(.top, 8)
        .padding(.bottom, 12)
    }

    @ViewBuilder
    private func content(for notice: Notice) -> some View {
        let presentation = NoticeDatePresentation.make(for: notice)

        FlowLayout(spacing: 5, lineSpacing: 5) {
            if !presentation.badgeText.isEmpty {
                TagChip(text: presentation.badgeText, style: badgeStyle(presentation))
            }
            if notice.isPinned { TagChip(text: "고정", style: .pinned) }
            TagChip(text: notice.targetBadge, style: .target)
            if !notice.host.isEmpty { TagChip(text: notice.host, style: .neutral) }
        }

        Text(notice.title)
            .font(Theme.Typography.sans(24, .bold))
            .lineSpacing(4)
            .foregroundStyle(Theme.Palette.textMain)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 12)

        Text(NoticeDatePresentation.detailMeta(
            dateLabel: presentation.dateLabel,
            views: notice.views,
            registeredOn: NoticeDatePresentation.registeredOn(notice)
        ))
        .font(Theme.Typography.sans(12.5))
        .foregroundStyle(Theme.Palette.textSub)
        .padding(.top, 8)

        detailDates(for: notice)

        if !model.images.isEmpty {
            hero
                .padding(.top, 16)
        }

        aiSummary(notice.aiSummary)
            .padding(.top, 18)

        if model.images.count > 1 {
            gallery
                .padding(.top, 14)
        }

        originalText(notice.content ?? "")
            .padding(.top, 18)

        if model.sourceURL != nil || !model.attachments.isEmpty {
            sourceAndAttachments
                .padding(.top, 18)
        }

        Button {
            copyLink()
        } label: {
            Label(copiedLink ? "링크를 복사했습니다" : "링크 복사",
                  systemImage: copiedLink ? "checkmark" : "link")
        }
        .buttonStyle(OutlineButtonStyle())
        .padding(.top, 22)
    }

    /// 제목 아래 날짜 상자들. 등록일·시행 시작일·마감일을 한눈에 갈라 보여준다.
    /// 웹 `.detail-dates`처럼 왼쪽에 남색 세로줄을 긋고 옅은 회색 바탕에 얹는다.
    @ViewBuilder
    private func detailDates(for notice: Notice) -> some View {
        let rows = NoticeDatePresentation.detailDateRows(for: notice)
        if !rows.isEmpty {
            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 150), spacing: 8)],
                alignment: .leading,
                spacing: 8
            ) {
                ForEach(rows, id: \.label) { row in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(row.label)
                            .font(Theme.Typography.sans(11, .heavy))
                            .foregroundStyle(Theme.Palette.textSub)
                        Text(row.value)
                            .font(Theme.Typography.sans(13, .bold))
                            .monospacedDigit()
                            .foregroundStyle(Theme.Palette.textMain)
                    }
                    .padding(.vertical, 10)
                    .padding(.horizontal, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(hex: 0xF7F8FB))
                    .overlay(alignment: .leading) {
                        Theme.Palette.primary.frame(width: 3)
                    }
                }
            }
            .padding(.top, 12)
        }
    }

    /// 상세 위쪽 자체가 넘겨 보는 갤러리다. 확대는 사진을 눌러서가 아니라
    /// '크게 보기' 버튼으로만 연다 — 목록에서 카드를 누른 손가락이 그대로
    /// 사진 위에 있어 원치 않게 뷰어가 열리던 문제를 막는다.
    private var hero: some View {
        TabView(selection: $imageIndex) {
            ForEach(Array(model.images.enumerated()), id: \.offset) { index, url in
                RemoteImage(url: url, contentMode: .fit, alignment: .center)
                    .tag(index)
            }
        }
        .tabViewStyle(.page(indexDisplayMode: .never))
        .frame(height: 320)
        .background(Theme.Palette.posterPlaceholder)
        .overlay(alignment: .bottomTrailing) {
            Button {
                viewerIndex = imageIndex
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "plus.magnifyingglass")
                        .font(.system(size: 13, weight: .bold))
                    Text("크게 보기")
                        .font(Theme.Typography.sans(12.5, .semibold))
                }
                .foregroundStyle(.white)
                .padding(.horizontal, 14)
                .frame(minHeight: Theme.Metrics.tapTarget)
                .background(Color.black.opacity(0.55), in: Capsule())
            }
            .buttonStyle(PressableStyle())
            .padding(8)
        }
        .overlay(alignment: .bottomLeading) {
            if model.images.count > 1 {
                Text("\(imageIndex + 1) / \(model.images.count)")
                    .font(Theme.Typography.sans(12, .semibold))
                    .monospacedDigit()
                    .foregroundStyle(.white)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(Color.black.opacity(0.55), in: Capsule())
                    .padding(8)
            }
        }
    }

    private var gallery: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Array(model.images.enumerated()), id: \.offset) { index, url in
                    Button {
                        withAnimation { imageIndex = index }
                    } label: {
                        RemoteImage(url: url, contentMode: .fill, alignment: .center)
                            .frame(width: 72, height: 72)
                            .clipped()
                            .overlay(
                                Rectangle().stroke(
                                    index == imageIndex ? Theme.Palette.primary : Theme.Palette.border,
                                    lineWidth: index == imageIndex ? 2 : 1
                                )
                            )
                    }
                    .buttonStyle(PressableStyle())
                    .accessibilityLabel("\(index + 1)번 사진 보기")
                }
            }
        }
    }

    private func aiSummary(_ lines: [String]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("AI 3줄 요약")
                .font(Theme.Typography.sans(14, .bold))
                .foregroundStyle(Theme.Palette.primary)

            if lines.isEmpty {
                Text("이 공지에는 아직 요약이 없습니다.")
                    .font(Theme.Typography.sans(13))
                    .foregroundStyle(Theme.Palette.textSub)
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                        HStack(alignment: .top, spacing: 8) {
                            Circle()
                                .fill(Theme.Palette.primary)
                                .frame(width: 4, height: 4)
                                .padding(.top, 7)
                            Text(line)
                                .font(Theme.Typography.sans(13.5))
                                .lineSpacing(3)
                                .foregroundStyle(Theme.Palette.textMain)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Theme.Palette.primaryLight)
        )
    }

    private func originalText(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("공지 원문")
                .font(Theme.Typography.sans(14, .bold))
                .foregroundStyle(Theme.Palette.textMain)

            Text(Linkify.attributed(text))
                .font(Theme.Typography.sans(14))
                .lineSpacing(6)
                .foregroundStyle(Theme.Palette.textMain)
                .tint(Theme.Palette.primary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color.white)
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .stroke(Theme.Palette.border, lineWidth: 1)
                )
        )
    }

    private var sourceAndAttachments: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("출처 및 첨부파일")
                .font(Theme.Typography.sans(14, .bold))
                .foregroundStyle(Theme.Palette.textMain)

            if let source = model.sourceURL {
                Button {
                    openURL(source)
                } label: {
                    Label("ECE 원문 열기", systemImage: "arrow.up.right.square")
                        .font(Theme.Typography.sans(13.5, .semibold))
                        .foregroundStyle(Theme.Palette.primary)
                        .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(PressableStyle(scale: 0.99))
            }

            ForEach(model.attachments, id: \.index) { attachment in
                Button {
                    if let url = attachment.url { openURL(url) }
                } label: {
                    Label(attachment.name, systemImage: "paperclip")
                        .font(Theme.Typography.sans(13.5, .semibold))
                        .foregroundStyle(Theme.Palette.primary)
                        .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(PressableStyle(scale: 0.99))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func badgeStyle(_ presentation: NoticeDatePresentation) -> TagChip.Style {
        switch presentation.badgeStyle {
        case .urgent: .urgent
        case .expired: .expired
        case .none: .primary
        }
    }

    private func copyLink() {
        guard let url = model.shareURL else { return }
        UIPasteboard.general.string = url.absoluteString
        withAnimation { copiedLink = true }
        Task {
            try? await Task.sleep(for: .seconds(2))
            withAnimation { copiedLink = false }
        }
    }
}

/// `fullScreenCover(item:)`에 넘기기 위한 자리 표시. Int는 Identifiable이 아니다.
struct ImageViewerTarget: Identifiable {
    let index: Int
    var id: Int { index }
}
