import SwiftUI

/// 알림 설정 화면.
///
/// 앞에는 가장 자주 만지는 둘 — 새 공지 등록 알림 켜기/끄기와 마감 며칠 전에
/// 알릴지 — 만 세우고, 대상 학번·관심 카테고리·마감 임박 포함은 고급 설정으로
/// 접어 둔다. 화면에서 만지는 것은 사본이다. '설정 저장'을 눌러야 저장소로
/// 가고, '취소'는 열었을 때(또는 마지막으로 저장했을 때)의 설정으로 되돌린 뒤 닫는다.
struct NotificationPreferencesView: View {
    @EnvironmentObject private var store: NotificationPreferencesStore
    @EnvironmentObject private var board: BoardViewModel
    @Environment(\.dismiss) private var dismiss

    /// 화면에서 만지는 사본.
    @State private var draft = NotificationPreferences()
    /// '취소'가 되돌리는 기준. 화면을 열 때와 저장할 때 갱신된다.
    @State private var saved = NotificationPreferences()
    @State private var showsAdvanced = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("새 공지가 올라올 때와 마감이 다가올 때 알려드립니다. 알림을 하나라도 켜 두면 제목 옆 종이 노란색으로 바뀝니다.")
                        .font(Theme.Typography.sans(13))
                        .foregroundStyle(Theme.Palette.textSub)
                        .listRowBackground(Color.clear)
                }

                Section("알림") {
                    Toggle("새 공지 등록 알림", isOn: $draft.newNoticeAlerts)
                        .tint(Theme.Palette.primary)

                    VStack(alignment: .leading, spacing: 10) {
                        Text("마감 임박 알림")
                        Picker("마감 임박 알림", selection: reminderSelection) {
                            Text("없음").tag(0)
                            ForEach(NotificationPreferences.reminderOptions, id: \.self) { days in
                                Text("\(days)일 전").tag(days)
                            }
                        }
                        .pickerStyle(.segmented)
                    }
                    .padding(.vertical, 4)
                }

                Section {
                    DisclosureGroup("고급 설정", isExpanded: $showsAdvanced) {
                        Picker("대상 학번", selection: yearSelection) {
                            Text("학번 제한 없음").tag("")
                            ForEach(NotificationPreferences.yearOptions, id: \.self) { year in
                                Text(year).tag(year)
                            }
                        }

                        Toggle("모든 카테고리 알림", isOn: $draft.allCategories)
                            .tint(Theme.Palette.primary)

                        if !draft.allCategories {
                            if board.orderedCategories.isEmpty {
                                Text("카테고리를 불러오는 중입니다.")
                                    .font(Theme.Typography.sans(13))
                                    .foregroundStyle(Theme.Palette.textSub)
                            } else {
                                ForEach(board.orderedCategories) { category in
                                    Toggle(category.name, isOn: categorySelection(category.id))
                                        .tint(Theme.Palette.primary)
                                }
                            }
                        }

                        Toggle("마감 임박 공지 포함", isOn: $draft.includeUrgent)
                            .tint(Theme.Palette.primary)
                    }
                    .tint(Theme.Palette.textSub)
                } footer: {
                    Text("학번과 카테고리를 고르면 그에 맞는 공지만 알립니다. 비워 두면 모든 공지가 대상입니다.")
                        .font(Theme.Typography.sans(11.5))
                }

                if let message = store.statusMessage {
                    Section {
                        Text(message)
                            .font(Theme.Typography.sans(13, .semibold))
                            .foregroundStyle(Theme.Palette.textSub)
                    }
                }

                Section {
                    Button {
                        Task {
                            await store.save(draft)
                            saved = draft
                            await store.rescheduleReminders(for: board.notices)
                        }
                    } label: {
                        Text(store.isSubscribed || !draft.hasAnyAlert ? "설정 저장" : "알림 허용 및 저장")
                    }
                    .buttonStyle(FilledButtonStyle())
                    .disabled(store.isBusy)
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 4, trailing: 16))

                    Button("취소") {
                        draft = saved
                        dismiss()
                    }
                    .buttonStyle(OutlineButtonStyle())
                    .disabled(store.isBusy)
                    .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 8, trailing: 16))
                } footer: {
                    Text("마감 알림은 이 기기 안에서 예약됩니다. 새 공지를 실시간으로 밀어 주는 서버 알림은 백엔드에 APNs 발송 경로가 추가되면 위 설정대로 켜집니다.")
                        .font(Theme.Typography.sans(11.5))
                }
                .listRowSeparator(.hidden)
            }
            .navigationTitle("공지 알림 받기")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("닫기") { dismiss() }
                }
            }
            .onAppear {
                draft = store.preferences
                saved = store.preferences
            }
            .onDisappear { store.clearStatus() }
        }
    }

    // MARK: - 바인딩

    private var reminderSelection: Binding<Int> {
        Binding(
            get: { draft.reminderDaysBefore ?? 0 },
            set: { draft.reminderDaysBefore = $0 == 0 ? nil : $0 }
        )
    }

    private var yearSelection: Binding<String> {
        Binding(
            get: { draft.year ?? "" },
            set: { draft.year = $0.isEmpty ? nil : $0 }
        )
    }

    private func categorySelection(_ categoryId: Int) -> Binding<Bool> {
        Binding(
            get: { draft.categoryIds.contains(categoryId) },
            set: { isOn in
                if isOn {
                    draft.categoryIds.insert(categoryId)
                } else {
                    draft.categoryIds.remove(categoryId)
                }
            }
        )
    }
}
