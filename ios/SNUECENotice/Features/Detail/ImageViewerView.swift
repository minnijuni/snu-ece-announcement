import SwiftUI
import Photos

/// 사진 크게 보기. 검은 바탕에 사진 하나만 남기고, 좌우로 넘기며 확대·저장한다.
struct ImageViewerView: View {
    let urls: [URL]
    let startIndex: Int

    @Environment(\.dismiss) private var dismiss
    @State private var index: Int
    @State private var zoom: CGFloat = 1
    @State private var savedMessage: String?

    init(urls: [URL], startIndex: Int) {
        self.urls = urls
        self.startIndex = startIndex
        _index = State(initialValue: startIndex)
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            TabView(selection: $index) {
                ForEach(Array(urls.enumerated()), id: \.offset) { position, url in
                    ZoomableImage(url: url, zoom: position == index ? $zoom : .constant(1))
                        .tag(position)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            // 확대한 동안에는 좌우 넘김이 끼어들지 않게 한다.
            .allowsHitTesting(true)
            .onChange(of: index) { _, _ in zoom = 1 }

            VStack {
                toolbar
                Spacer()
                if let savedMessage {
                    Text(savedMessage)
                        .font(Theme.Typography.sans(13, .semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .background(Color.white.opacity(0.18), in: Capsule())
                        .padding(.bottom, 40)
                        .transition(.opacity)
                }
            }
        }
        // 앱 단위 상태 표시줄 설정(`StatusBarAppearance`)이라 `.statusBarHidden()`은 듣지 않는다.
        .onAppear { StatusBarAppearance.setHidden(true) }
        .onDisappear { StatusBarAppearance.setHidden(false) }
    }

    private var toolbar: some View {
        HStack(spacing: 8) {
            if urls.count > 1 {
                Text("\(index + 1) / \(urls.count)")
                    .font(Theme.Typography.sans(12, .semibold))
                    .monospacedDigit()
                    .foregroundStyle(.white)
                    .frame(minWidth: 42)
            }

            Spacer(minLength: 0)

            Button("사진 저장") { save() }
                .font(Theme.Typography.sans(11, .semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 10)
                .frame(minHeight: 38)
                .background(Color.white.opacity(0.16), in: Capsule())

            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 38, height: 38)
                    .background(Color.white.opacity(0.16), in: Circle())
            }
            .accessibilityLabel("이미지 뷰어 닫기")
        }
        .buttonStyle(PressableStyle())
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    /// 사진 앱에 저장. 권한은 '추가 전용'만 요청한다 — 앱이 사진첩을 읽을
    /// 일은 없으므로 더 넓은 권한을 달라고 하지 않는다.
    private func save() {
        guard urls.indices.contains(index) else { return }
        let url = urls[index]
        Task {
            guard let image = await ImageCache.shared.image(for: url) else {
                await show("사진을 저장하지 못했습니다.")
                return
            }
            let status = await withCheckedContinuation { continuation in
                PHPhotoLibrary.requestAuthorization(for: .addOnly) { continuation.resume(returning: $0) }
            }
            guard status == .authorized || status == .limited else {
                await show("설정에서 사진 추가 권한을 허용해주세요.")
                return
            }
            do {
                try await PHPhotoLibrary.shared().performChanges {
                    PHAssetChangeRequest.creationRequestForAsset(from: image)
                }
                await show("사진 앱에 저장했습니다.")
            } catch {
                await show("사진을 저장하지 못했습니다.")
            }
        }
    }

    @MainActor
    private func show(_ message: String) async {
        withAnimation { savedMessage = message }
        try? await Task.sleep(for: .seconds(2))
        withAnimation { savedMessage = nil }
    }
}

/// 두 손가락으로 벌려 키우고 두 번 눌러 되돌리는 사진 한 장.
struct ZoomableImage: View {
    let url: URL
    @Binding var zoom: CGFloat

    @State private var steadyZoom: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var steadyOffset: CGSize = .zero

    var body: some View {
        GeometryReader { proxy in
            RemoteImage(url: url, contentMode: .fit, alignment: .center) {
                AnyView(
                    Text("사진을 불러오지 못했습니다.")
                        .font(Theme.Typography.sans(13))
                        .foregroundStyle(.white.opacity(0.7))
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                )
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
            .scaleEffect(zoom)
            .offset(offset)
            .gesture(
                MagnificationGesture()
                    .onChanged { value in zoom = max(1, min(4, steadyZoom * value)) }
                    .onEnded { _ in
                        steadyZoom = zoom
                        if zoom <= 1 { resetPan() }
                    }
            )
            .simultaneousGesture(
                DragGesture()
                    .onChanged { value in
                        guard zoom > 1 else { return }
                        offset = CGSize(width: steadyOffset.width + value.translation.width,
                                        height: steadyOffset.height + value.translation.height)
                    }
                    .onEnded { _ in steadyOffset = offset }
            )
            .onTapGesture(count: 2) {
                withAnimation(.easeOut(duration: 0.2)) {
                    if zoom > 1 {
                        zoom = 1
                        resetPan()
                    } else {
                        zoom = 2.4
                    }
                    steadyZoom = zoom
                }
            }
            .onChange(of: zoom) { _, value in
                if value <= 1 { resetPan() }
            }
        }
    }

    private func resetPan() {
        offset = .zero
        steadyOffset = .zero
    }
}
