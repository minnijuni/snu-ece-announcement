import SwiftUI
import PhotosUI

/// 익명 피드백. 이름·연락처·IP를 저장하지 않는다.
///
/// 오류는 글로 설명하기 어려울 때가 많아 화면 사진을 최대 세 장까지 붙일 수
/// 있다. 서버는 JPEG만 받으므로 고른 사진은 여기서 줄여 JPEG로 바꾼다.
struct FeedbackView: View {
    @Environment(\.dismiss) private var dismiss

    @State private var message = ""
    @State private var pickedItems: [PhotosPickerItem] = []
    @State private var shots: [FeedbackShot] = []
    @State private var status: String?
    @State private var isError = false
    @State private var isSending = false

    private static let maxShots = 3
    private static let maxCharacters = 2000
    /// 긴 변이 이보다 길면 줄여 보낸다. 웹 `FEEDBACK_SHOT_MAX_EDGE`와 같다.
    private static let maxEdge: CGFloat = 1600

    private let service = NoticeService()

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextEditor(text: $message)
                        .font(Theme.Typography.sans(14))
                        .frame(minHeight: 160)
                        .overlay(alignment: .topLeading) {
                            if message.isEmpty {
                                Text("개선 의견이나 오류 제보를 적어주세요. (5자 이상)")
                                    .font(Theme.Typography.sans(14))
                                    .foregroundStyle(Theme.Palette.textSub.opacity(0.7))
                                    .padding(.top, 8)
                                    .padding(.leading, 5)
                                    .allowsHitTesting(false)
                            }
                        }
                } header: {
                    Text("익명 피드백")
                } footer: {
                    Text("이름·연락처·IP를 저장하지 않습니다. \(message.count) / \(Self.maxCharacters)자")
                        .font(Theme.Typography.sans(11.5))
                }

                Section {
                    PhotosPicker(
                        selection: $pickedItems,
                        maxSelectionCount: Self.maxShots,
                        matching: .images
                    ) {
                        Label("화면 사진 첨부", systemImage: "camera")
                            .font(Theme.Typography.sans(14, .semibold))
                    }
                    .disabled(shots.count >= Self.maxShots)

                    if !shots.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                ForEach(shots) { shot in
                                    thumbnail(shot)
                                }
                            }
                            .padding(.vertical, 4)
                        }
                    }
                } footer: {
                    Text("최대 \(Self.maxShots)장 · 이름이나 연락처가 찍히지 않았는지 확인해주세요")
                        .font(Theme.Typography.sans(11.5))
                }

                if let status {
                    Section {
                        Text(status)
                            .font(Theme.Typography.sans(13, .semibold))
                            .foregroundStyle(isError ? Theme.Palette.danger : Theme.Palette.ok)
                    }
                }

                Section {
                    Button {
                        Task { await submit() }
                    } label: {
                        if isSending {
                            ProgressView().tint(.white)
                        } else {
                            Text("익명으로 보내기")
                        }
                    }
                    .buttonStyle(FilledButtonStyle())
                    .disabled(isSending || message.trimmed.count < 5)
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                }
            }
            .navigationTitle("문의하기")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("닫기") { dismiss() }
                }
            }
            .onChange(of: pickedItems) { _, items in
                Task { await load(items) }
            }
        }
    }

    private func thumbnail(_ shot: FeedbackShot) -> some View {
        Image(uiImage: shot.image)
            .resizable()
            .scaledToFill()
            .frame(width: 78, height: 78)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(alignment: .topTrailing) {
                Button {
                    shots.removeAll { $0.id == shot.id }
                    pickedItems.removeAll { $0 == shot.item }
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 17))
                        .foregroundStyle(.white, .black.opacity(0.55))
                }
                .padding(3)
                .accessibilityLabel("첨부 사진 빼기")
            }
    }

    private func load(_ items: [PhotosPickerItem]) async {
        var loaded: [FeedbackShot] = []
        for item in items.prefix(Self.maxShots) {
            // 이미 변환해 둔 사진은 다시 읽지 않는다. 하나만 뺐을 때 남은 사진이 유지된다.
            if let existing = shots.first(where: { $0.item == item }) {
                loaded.append(existing)
                continue
            }
            guard let data = try? await item.loadTransferable(type: Data.self),
                  let image = UIImage(data: data),
                  let shrunk = image.shrunkJPEG(maxEdge: Self.maxEdge) else { continue }
            loaded.append(FeedbackShot(item: item, image: shrunk.image, jpeg: shrunk.data))
        }
        shots = loaded
    }

    private func submit() async {
        let trimmed = message.trimmed
        guard trimmed.count >= 5 else {
            status = "피드백을 5자 이상 입력해주세요."
            isError = true
            return
        }
        guard trimmed.count <= Self.maxCharacters else {
            status = "피드백은 \(Self.maxCharacters)자 이내로 입력해주세요."
            isError = true
            return
        }

        isSending = true
        defer { isSending = false }
        do {
            try await service.submitFeedback(message: trimmed, screenshots: shots.map(\.jpeg))
            status = "보내주셔서 감사합니다. 확인 후 반영하겠습니다."
            isError = false
            message = ""
            shots = []
            pickedItems = []
            try? await Task.sleep(for: .seconds(1.2))
            dismiss()
        } catch {
            status = (error as? APIError)?.message ?? error.localizedDescription
            isError = true
        }
    }
}

struct FeedbackShot: Identifiable {
    let id = UUID()
    let item: PhotosPickerItem
    let image: UIImage
    let jpeg: Data
}

extension UIImage {
    /// 긴 변을 `maxEdge`까지 줄여 JPEG로 다시 굽는다.
    /// 서버가 1.4MB를 넘는 사진을 거르므로 여기서 미리 맞춘다.
    func shrunkJPEG(maxEdge: CGFloat, quality: CGFloat = 0.72) -> (image: UIImage, data: Data)? {
        let longest = max(size.width, size.height)
        let scale = longest > maxEdge ? maxEdge / longest : 1
        let target = CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())

        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        format.opaque = true
        let resized = UIGraphicsImageRenderer(size: target, format: format).image { _ in
            draw(in: CGRect(origin: .zero, size: target))
        }
        guard let data = resized.jpegData(compressionQuality: quality) else { return nil }
        return (resized, data)
    }
}
