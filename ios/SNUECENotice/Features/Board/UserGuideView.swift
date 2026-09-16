import SwiftUI

/// 글로 된 사용 설명서. 웹 `guide.html`에 해당한다.
///
/// 검색창 돋보기는 이제 화면 위에서 직접 짚는 투어(`TutorialOverlayView`)를
/// 연다. 이 목록판은 투어 카드의 "글로 된 설명서 보기"와 서랍·푸터의
/// "서비스 안내"에서 열린다. 문구는 `js/tutorial.js`의 것과 같다.
struct UserGuideView: View {
    @Environment(\.dismiss) private var dismiss

    private struct Step: Identifiable {
        let id = UUID()
        let icon: String
        let title: String
        let body: String
    }

    private static let steps: [Step] = [
        Step(icon: "magnifyingglass",
             title: "검색으로 시작하세요",
             body: "제목과 본문을 함께 찾습니다. 글자를 입력하는 즉시 아래 목록이 걸러지니 검색 버튼을 따로 누를 필요는 없습니다."),
        Step(icon: "book",
             title: "이 안내는 언제든 다시",
             body: "검색은 입력만으로 걸리기 때문에 돋보기 자리는 설명서 입구로 씁니다. 길을 잃으면 여기를 누르세요."),
        Step(icon: "line.3.horizontal",
             title: "왼쪽 위 손잡이",
             body: "목록을 조금 내리면 나타납니다. 누르면 바로가기 서랍이 열리고, 잠시 두면 다시 숨어 화면을 가리지 않습니다. 화면 왼쪽 끝에서 오른쪽으로 밀어도 열립니다."),
        Step(icon: "square.grid.2x2",
             title: "카테고리로 나눠 보기",
             body: "학사·기회·설문·행사로 갈라 봅니다. 기회와 설문은 마감이 급한 순서로, 학사와 행사는 최신 순서로 자동 정렬됩니다."),
        Step(icon: "bolt",
             title: "자주 쓰는 조건은 한 번에",
             body: "마감 임박, 리워드 있음, 신청 필요, 마감을 바로 켜고 끕니다. 여러 개를 함께 켜면 모두 만족하는 공지만 남습니다."),
        Step(icon: "slider.horizontal.3",
             title: "더 좁히고 싶다면",
             body: "대상 학번, 마감 상태, 주관 기관, 조회수, 마감일 범위까지 상세 조건을 펼쳐 고를 수 있습니다. 학부 홈페이지에서 모아 온 관련 공지를 뺄지도 여기서 정합니다. 켜 둔 조건은 이 줄에 칩으로 남아 한눈에 보입니다."),
        Step(icon: "arrow.up.arrow.down",
             title: "정렬 바꾸기",
             body: "최신순, 마감임박순, 조회순 중에 고릅니다. 마감임박순에서 마감일이 없는 공지는 맨 뒤로 갑니다."),
        Step(icon: "doc.text",
             title: "공지 열어보기",
             body: "카드를 누르면 원문, 첨부파일, AI 3줄 요약을 함께 봅니다. 요약은 참고용이고 판단은 언제나 원문이 기준입니다."),
        Step(icon: "megaphone",
             title: "학내 홍보",
             body: "목록 아래는 학생 단체와 학내 행사 홍보가 도는 자리입니다. 검수를 거친 항목만 정해진 기간 동안 걸립니다."),
        Step(icon: "envelope",
             title: "문의와 홍보 신청",
             body: "개선 의견은 익명으로 보낼 수 있고, 홍보 신청은 양식을 내면 검수 뒤 배너로 올라갑니다. 자주 묻는 질문도 푸터에 있습니다."),
        Step(icon: "arrow.triangle.2.circlepath",
             title: "언제 가져온 공지인지",
             body: "푸터의 업데이트 시각은 마지막으로 학부 홈페이지에서 공지를 가져온 때입니다. 원문이 방금 올라왔다면 여기 시각 이후에 반영됩니다.")
    ]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text("SNU ECE 공지방이 처음이신가요?")
                        .font(Theme.Typography.sans(18, .bold))
                        .foregroundStyle(Theme.Palette.textMain)

                    Text("서울대 전기정보공학부 공지를 한곳에서 검색하고, 마감을 놓치지 않게 돕는 화면입니다. 아래 순서대로 한 번만 훑어보면 충분합니다.")
                        .font(Theme.Typography.sans(13.5))
                        .lineSpacing(4)
                        .foregroundStyle(Theme.Palette.textSub)

                    ForEach(Array(Self.steps.enumerated()), id: \.element.id) { index, step in
                        stepRow(number: index + 1, step: step)
                    }

                    Text("이제 직접 써 보세요. 검색으로 찾고, 조건으로 좁히고, 열어서 확인하면 됩니다. 이 안내는 검색창 오른쪽 돋보기에서 언제든 다시 열 수 있습니다.")
                        .font(Theme.Typography.sans(13))
                        .lineSpacing(4)
                        .foregroundStyle(Theme.Palette.textSub)
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .fill(Theme.Palette.primaryLight)
                        )
                }
                .padding(16)
            }
            .background(Theme.Palette.background)
            .navigationTitle("사용 설명서")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("닫기") { dismiss() }
                }
            }
        }
    }

    private func stepRow(number: Int, step: Step) -> some View {
        HStack(alignment: .top, spacing: 12) {
            ZStack {
                Circle()
                    .fill(Theme.Palette.primaryLight)
                    .frame(width: 34, height: 34)
                Image(systemName: step.icon)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.Palette.primary)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("\(number). \(step.title)")
                    .font(Theme.Typography.sans(14.5, .bold))
                    .foregroundStyle(Theme.Palette.textMain)
                Text(step.body)
                    .font(Theme.Typography.sans(13))
                    .lineSpacing(3)
                    .foregroundStyle(Theme.Palette.textSub)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
