# SNU ECE 공지방 — iOS

`snu-ece-announcement`의 **공개 화면(학생용)** 을 Swift·SwiftUI 네이티브 앱으로 옮긴 것입니다.
웹의 모바일 뷰(`css/mobile.css`, `js/mobile.js`가 켜지는 `index.html`)를 기준으로 삼아,
같은 화면 순서와 같은 색·같은 문구를 쓰되 손가락으로 쓰기 자연스럽게 다시 짰습니다.

**기준 웹 버전: `featurejaewon` 브랜치.** 그 브랜치에서 들어온 것들이 반영되어 있습니다 —
내용만큼 자라는 카드(고정 비율 폐지, 제목 항상 표시·줄임 없음, 포스터 154pt 고정),
밑줄 없는 카테고리 탭, 상세의 등록일·시작일·마감일 상자, 한국어 조사에서 끊는 링크 인식,
베타 측정과 3·13회 열람 평가창(`POST /api/analytics/events`).

서버는 그대로 씁니다. 이 저장소에는 백엔드가 없고, 기존 Express API(`/api/notices`,
`/api/categories`, `/api/banner-slides`, `/api/sync-status`, `/api/feedback`)를 그대로 호출합니다.

## 요구 사항

- Xcode 16.4 이상
- iOS 18.0 이상 (아래 [왜 iOS 18인가](#왜-ios-18인가) 참고)
- 외부 의존성 없음. `xcodebuild`나 Xcode에서 바로 엽니다.

```bash
open SNUECENotice.xcodeproj
```

```bash
xcodebuild test -project SNUECENotice.xcodeproj -scheme SNUECENotice -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 16'
```

## 서버 주소 바꾸기

기본값은 운영 API(`https://snu-ece-announcement.onrender.com`)입니다.
로컬 서버에 붙여 보려면 실행 인자로 넘깁니다 (Xcode의 Scheme → Run → Arguments).

```
-ECE_API_BASE_URL http://localhost:3000
-ECE_PUBLIC_SITE_URL http://localhost:3000
```

`ECE_PUBLIC_SITE_URL`은 '링크 복사'와 아직 네이티브로 옮기지 않은 문서 페이지에 씁니다.
로컬 http 주소는 `Info.plist`의 `NSAllowsLocalNetworking`으로만 열려 있고, 운영은 https입니다.

## 구조

| 폴더 | 역할 |
| --- | --- |
| `App/` | 진입점, 화면 사이 이동(`AppRouter`), 서랍을 얹는 `RootView` |
| `Models/` | 서버 응답 모델과 필터 상태 (`Notice`, `NoticeFilters`, `BannerSlide`, `SyncStatus`) |
| `Networking/` | `APIClient`(JSON 한 겹), `NoticeService`(호출 모음), `APIConfiguration`(주소) |
| `Domain/` | 날짜·D-Day·포스터 제목·링크 인식처럼 화면과 무관한 계산 |
| `DesignSystem/` | `core.css` 토큰을 옮긴 `Theme`, 태그·버튼·흐름 배치, 이미지 캐시 |
| `Features/` | 화면별 뷰와 뷰모델 (`Board`, `Detail`, `Drawer`, `Footer`, `Banner`, `Feedback`, `Notifications`) |

`SNUECENotice.xcodeproj`는 Xcode 16의 **파일 시스템 동기화 그룹**을 씁니다.
폴더에 `.swift` 파일을 넣으면 프로젝트 파일을 고치지 않아도 자동으로 타깃에 들어갑니다.

## 웹과 대응

| 웹 | iOS |
| --- | --- |
| `index.html` `#board-view` | `Features/Board/BoardView` |
| `renderNoticeCards()` | `NoticeCardView` + `NoticeGrid` |
| `calcDDay()`, `getNoticeDatePresentation()` | `Domain/NoticePresentation` |
| `posterTitleFit()` | `Domain/PosterTitle` |
| `getNoticeListFilters()` | `NoticeFilters.queryItems(page:limit:)` |
| `createNoticeRepository()` | `Networking/NoticeService` + `BoardViewModel` |
| `.rail-left` 서랍 | `Features/Drawer/SideDrawerView` |
| `renderRightRailAd()` | `Features/Banner/BannerCarouselView` |
| `refreshFooterSyncStatus()` | `SyncState` + 푸터의 "업데이트" 한 줄 |
| `js/tutorial.js` 스포트라이트 안내 | `Features/Board/UserGuideView` (아래 참고) |
| `renderDetailDates()` | `NoticeDatePresentation.detailDateRows` + 상세의 날짜 상자 |
| `initializeBetaAnalytics()`, `recordBetaNoticeOpen()` | `Features/Analytics/BetaAnalytics` |

웹에서 그대로 가져온 동작:

- 두 열 카드 목록. 왼쪽 열을 46pt 끌어올려 정렬 버튼 옆 빈 자리를 메우고,
  "결과 N건"이 그 자리에 서면 끌어올리기를 멈춥니다.
- 카드는 내용만큼 자랍니다. 제목은 포스터에 크게 쓴 카드라도 본문 첫 줄에 한 번 더,
  줄임 없이 전부 적습니다. 사진 포스터는 154pt 고정, 텍스트 포스터는 154pt를 바닥으로 자랍니다.
- 베타 측정: 앱을 열면 `page_view`(재방문이면 `return_visit`도), 공지를 3번째·13번째
  열면 1~5점 평가창이 한 번씩 뜹니다. 기기 난수 식별자만 보내고 서버에는 해시만 남습니다.
- 목록을 내리면 왼쪽 위 손잡이가 나타나고 2.6초 손을 떼면 스스로 숨습니다.
- 검색창이 화면 밖으로 나가면 위에 대신 붙는 줄이 서고, 누르면 검색창으로 돌아갑니다.
- 검색은 220ms 쉬었다 서버에 갑니다. 늦게 온 응답이 최신 목록을 덮지 않습니다.
- 기회·설문 탭은 마감임박순, 나머지는 최신순으로 자동 정렬됩니다.
- 배너는 6.5초마다 넘어가고, 손으로도 넘길 수 있습니다.

iOS답게 바꾼 것:

- 상세는 모달이 아니라 `NavigationStack` 푸시입니다. 가장자리 스와이프로 뒤로 갑니다.
- 왼쪽 서랍은 화면 왼쪽 끝에서 밀어 열고, 열린 상태에서 왼쪽으로 밀거나 막을 눌러 닫습니다.
- 목록을 아래로 당기면 새로 고칩니다.
- 이미지 뷰어는 두 손가락으로 키우고 두 번 눌러 되돌립니다. 저장은 사진 앱 '추가 전용' 권한만 씁니다.
- 데스크톱 전용 기능(공지 나란히 비교, 6점 드래그 핸들, 폰 미리보기 프레임)은 넣지 않았습니다.
  웹에서도 `mobile.css`가 `display: none`으로 감추는 것들입니다.

## 함께 옮기지 않은 것

- **관리자 화면** (`admin.html`, `admin-login.html`, `operator.html`).
  검수·등록·배너 관리는 데스크톱 back-office이고, 요청도 모바일 UI 기준이었습니다.
- **홍보 신청 양식** (`banner-inquiry.html`)과 **문서 페이지**(이용약관·개인정보처리방침·FAQ·
  업데이트 내역·운영 주체 안내). 앱 안에서 `SFSafariViewController`로 웹 페이지를 띄웁니다.
  양식 검증 규칙이 서버 쪽에 있어 두 벌로 관리하면 어긋나기 때문입니다.
- **사용 설명서의 스포트라이트 연출.** 웹은 화면 요소를 하나씩 짚어 주는 오버레이지만,
  폰에서는 그 오버레이가 화면을 거의 다 덮습니다. 같은 문구를 차례대로 읽는 목록으로 옮겼습니다.

## 알림에 관하여 (중요)

웹은 브라우저 **Web Push(VAPID)** 로 서버가 알림을 밀어 줍니다. iOS 앱은 그 규격을 쓸 수 없고,
현재 백엔드에는 APNs 발송 경로가 없습니다. 그래서 이 앱의 알림 설정은:

- 앞에는 새 공지 등록 알림 켜기/끄기와 마감 알림(없음·1·3·7일 전) 둘만 두고,
  웹과 같은 나머지 항목(대상 학번·관심 카테고리·마감 임박 포함)은 고급 설정으로 접어 받고,
- '설정 저장'을 눌렀을 때만 **기기에 저장**하고('취소'는 직전 설정으로 되돌린 뒤 닫는다),
- 목록에 실린 공지 가운데 설정에 맞는 것의 마감 알림을 **기기 안에서 예약**합니다(아침 9시).

즉 앱을 한 번은 열어야 예약이 갱신되고, 새 공지가 올라온 즉시 오는 알림은 아직 없습니다.
대신 백그라운드에 있다가 돌아오면 보고 있던 목록을 조용히 다시 받습니다(`RootView`의
`scenePhase` → `BoardViewModel.refreshAfterForeground()`). 앱을 켜 둔 사이에 관리자가 올린
공지는 돌아오는 순간 목록에 실리고, 마감 알림 예약도 그 목록으로 다시 세워집니다.
서버에 APNs 엔드포인트(기기 토큰 등록 + 발송)가 생기면
`Features/Notifications/NotificationPreferences.swift`에 토큰 등록을 더하면 됩니다.

## 왜 iOS 18인가

스크롤 위치에 반응하는 두 가지(위에 붙는 검색 줄, 스스로 숨는 메뉴 손잡이) 때문입니다.
`GeometryReader` + `PreferenceKey`로 스크롤 위치를 재는 예전 방식은 이 화면 구조에서
값이 `ScrollView` 밖으로 나오지 않아 동작하지 않았습니다. iOS 18의
`onScrollGeometryChange`가 그 일을 위해 있는 API라 그쪽으로 갔습니다.
iOS 17까지 내려야 한다면 두 기능을 빼거나 `UIScrollView`를 직접 들여다봐야 합니다.

## 배너 이미지

기본 배너(`/icons/banner-*.svg`)는 SVG라 iOS가 내려받아 바로 그리지 못합니다.
같은 이름의 자산을 앱에 함께 넣어 두고 `BannerImage`가 먼저 그쪽을 찾습니다.
관리자가 올린 배너처럼 다른 주소면 서버에서 받아 오고, 그마저 실패하면 문구만으로 배너를 세웁니다.
