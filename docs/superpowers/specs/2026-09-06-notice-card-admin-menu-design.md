# 공지 카드 관리자 메뉴 (리마인드 · 상단 고정) 설계

작성일: 2026-09-06

## 배경

카카오톡 공지방에는 "리마인드 공지"가 있었다. 마감이 임박한 공지를 방에 다시 올려
사람들 눈에 한 번 더 띄게 하는 운영 작업이다. 웹사이트에는 대응하는 수단이 없다.
공지를 올리고 나면 관리자가 할 수 있는 일은 수정·숨김·삭제뿐이고, 그 셋 모두
admin.html의 텍스트 행 목록에서만 가능하다.

카카오톡에서 "다시 올리기" 한 번이 하던 일은 웹에서 두 가지로 갈린다.

1. 구독자에게 알림이 한 번 더 간다 → 웹 푸시 재발송
2. 목록에서 위로 올라온다 → 상단 고정

이 두 동작을 공개 화면의 공지 카드에서 바로 실행할 수 있게 한다. 진입점은 카드
우측 상단에 hover로 나타나는 3점(⋮) 메뉴다.

## 목표

- 관리자가 공개 화면(학생이 보는 그 화면)에서 카드 단위로 리마인드와 고정을 실행한다.
- 학생이 받는 번들에는 관리자 UI 코드가 들어가지 않는다. README가 못 박은 원칙이다.
- 기존 알림 파이프라인(`notification_jobs` → `push-service`)과 기존 `isPinned`
  정렬을 재사용한다. 새 발송 경로나 새 정렬 축을 만들지 않는다.

## 범위 밖

- **카카오 웹훅 리마인드.** `KAKAO_NOTICE_WEBHOOK_URL`로 `notice.reminder` 이벤트를
  보내는 일은 봇 중계 서버 쪽 수신 처리가 따로 필요하다. 이번에는 웹 푸시만 보내고,
  리마인드 엔드포인트 안에 훅 지점만 남긴다.
- **예약 발송.** `notification_jobs.scheduled_at`이 이미 있어 나중에 얹기 쉽다.
- **카드 메뉴에서의 삭제.** hover로 열리는 메뉴에서 되돌릴 수 없는 동작은 위험하고,
  admin.html에 이미 있다.

## 결정과 근거

| 결정 | 근거 |
| --- | --- |
| 공개 화면(index.html)에 메뉴를 두되 스크립트를 동적 로드 | 관리자는 학생이 보는 화면 그대로에서 검수하며 조작한다. 동적 로드로 학생 번들의 청결함도 지킨다. |
| 알림 채널은 웹 푸시만 | 사이트가 가진 유일한 자체 발송 수단. 카카오는 외부 의존이 붙는다. |
| 고정에 만료 시각을 둔다 | 관리자가 푸는 걸 잊어도 상단이 묵지 않는다. 리마인드의 대상은 곧 마감될 공지라 만료가 자연스럽다. |
| 메뉴 항목 4개 (알림 주기 / 상단 고정 / 수정 / 숨김) | 삭제만 뺀 관리자 상시 동작 전부. |

---

## 1. 관리자 감지와 코드 분리

### core.js의 확장 훅

`index.html`은 수정하지 않는다. `js/core.js`에 확장 지점 하나를 추가한다.

```js
let noticeCardExtension = null;

function registerNoticeCardExtension(extension) {
    noticeCardExtension = extension;
    renderNoticeCards();
}
```

`renderNoticeCards()`가 카드를 `grid.appendChild(card)` 하기 직전에 확장을 부른다.

```js
noticeCardExtension?.decorate(card, notice);
grid.appendChild(card);
```

확장이 등록되지 않으면 아무 일도 일어나지 않는다. 학생이 받는 DOM은 지금과 동일하다.
`desktop.js`·`mobile.js`가 쓰는 `registerViewModule()`과 같은 모양이라 새 개념이 아니다.

`renderCompareSpace()`가 그리는 비교 공간의 카드에는 메뉴를 붙이지 않는다. 비교 중인
공지를 옮기거나 숨기면 비교 상태가 깨진다.

### 세션 확인과 동적 로드

`loadData()`가 기존 `/api/settings` 호출과 함께 관리자 세션을 한 번 확인한다.

```js
async function loadNoticeCardAdminExtension() {
    let session;
    try {
        session = await apiRequest('/api/admin/session', { method: 'GET' });
    } catch {
        return;                       // 401이면 학생. 조용히 끝낸다.
    }
    if (!session?.authenticated) return;
    if (session.role !== 'notice' && session.role !== 'master') return;

    const script = document.createElement('script');
    script.src = '/js/notice-card-admin.js';
    document.head.appendChild(script);
}
```

- 학생은 401 한 번을 받고 끝난다. 관리자 스크립트는 네트워크에 뜨지도 않는다.
- 관리자는 새 탭이든 재접속이든 세션 쿠키만 살아 있으면 켜진다. sessionStorage 토큰은
  탭을 새로 열면 사라지므로 쿠키 쪽이 신뢰도가 높다.
- `role: 'banner'`는 제외한다. 배너 관리자에게는 공지 권한이 없다.

교차 오리진(Cloudflare Pages ↔ Render) 쿠키 전송은 이미 성립한다.
`adminSessionCookiePolicy()`가 프로덕션에서 `SameSite=None; Secure`를 주고,
`apiRequest()`가 `credentials: 'include'`를 쓴다.

`loadNoticeCardAdminExtension()`은 `loadData()`의 `Promise.all`에 넣지 않는다.
실패하거나 느려도 공개 화면 렌더를 붙잡으면 안 된다. 던져 놓고 잊는다.

---

## 2. 알림 주기

### 유니크 제약 교체

`notification_jobs`에 `unique (notice_id, kind)`가 걸려 있어 같은 공지에 리마인드를
두 번 넣을 수 없다. 블랭킷 제약을 부분 인덱스로 바꾼다.

```sql
alter table public.notification_jobs
  drop constraint if exists notification_jobs_notice_id_kind_key;

create unique index if not exists notification_jobs_new_notice_once
  on public.notification_jobs (notice_id)
  where kind = 'new_notice';
```

`new_notice`의 "공지당 한 번" 보장은 그대로 유지되고, `reminder`만 여러 행을 허용한다.

`server/sql/supabase-schema.sql`은 재실행 가능해야 하므로 `drop constraint if exists`와
`create unique index if not exists`를 쓴다. 파일 모드 저장소(`automation-store.js`)는
제약이 코드로만 있으므로 리마인드 작업을 그냥 push한다.

### 중복 발송 방지

제약을 푼 만큼 애플리케이션에서 막는다. 두 가지를 함께 본다.

1. **쿨다운** — 같은 공지의 마지막 `reminder` 작업이 24시간 안에 만들어졌으면 거절한다.
2. **진행 중 차단** — 그 공지에 `pending` 또는 `processing` 상태의 `reminder` 작업이
   남아 있으면 거절한다. 재시도 대기 중인 작업이 있는데 새로 쌓으면 안 된다.

### 리마인드 엔드포인트

```text
POST /api/notices/:id/reminder          requireNoticeAdmin
```

| 응답 | 조건 | 본문 |
| --- | --- | --- |
| 201 | 작업 생성 | `{ job: { id, kind: 'reminder' }, recipients: N }` |
| 409 | 쿨다운 또는 진행 중 | `{ error, retryAfterHours }` |
| 404 | 공지 없음 또는 `status !== 'published'` | `{ error }` |
| 400 | id가 정수가 아님 | `{ error }` |
| 503 | 웹 푸시 미설정 (`config.enabled === false`) | `{ error }` |

`recipients`는 `listPushSubscriptions()`를 `matchesSubscription(notice, sub)`로 걸러
센 값이다. 실제 발송은 워커가 하므로 이 숫자는 생성 시점의 추정치다.

`automation_audit_logs`에 `notice.reminder_sent`를 남긴다. `metadata`에 `noticeId`,
`jobId`, `recipients`를 넣는다.

숨김 상태(`isHidden`)인 공지는 공개 목록에 없으므로 카드 메뉴로 도달할 수 없지만,
엔드포인트는 직접 호출될 수 있으므로 서버에서도 거절한다.

### push-service 변경

`processJob()`은 지금도 `kind`를 보지 않으므로 리마인드 작업을 그대로 처리한다.
알림 문구와 태그만 갈라야 한다.

```js
const isReminder = job.kind === 'reminder';
// ...
JSON.stringify({
    title: isReminder ? `[마감 임박] ${notice.title}` : notice.title,
    body: (notice.aiSummary?.[0] || notice.content || '').slice(0, 180),
    url: `/?id=${encodeURIComponent(notice.id)}`,
    tag: isReminder ? `notice-${notice.id}-r${job.id}` : `notice-${notice.id}`
})
```

`tag`에 `job.id`를 넣지 않으면 브라우저가 같은 태그의 원래 알림을 **덮어쓴다.**
리마인드가 새 알림으로 뜨지 않고 기존 알림을 조용히 갈아치우면 기능이 무의미해진다.

`processJob()`이 `job.kind`를 읽으려면 `claimNotificationJob()`이 돌려주는 객체에
`kind`가 있어야 한다. Supabase 구현은 이미 매핑에 넣고 있다. 파일 모드는
`claimNotificationJob()`이 작업 객체를 통째로(`{ ...job }`) 돌려주므로 전달 자체는
되지만, **작업을 만들 때 `kind`를 저장하지 않고 있다.** `createManualNotice()`와
승인 경로가 `notificationJobs`에 push하는 객체에 `kind: 'new_notice'`를 넣도록
고치고, 리마인드 작업은 `kind: 'reminder'`로 만든다.

수신자 선정은 기존 `matchesSubscription()`을 그대로 쓴다. 학번·카테고리·`allNotices`
설정이 맞는 활성 구독자다. 리마인드라고 해서 대상을 넓히거나 좁히지 않는다.

---

## 3. 상단 고정

### 컬럼 추가

```sql
alter table public.notices
  add column if not exists pinned_until timestamptz;
```

기존 `is_pinned`(무기한, 공지 편집 폼의 체크박스)는 건드리지 않고 공존시킨다.
둘 중 하나만 참이어도 고정으로 친다.

### 정렬

`server/server.js`의 목록 정렬에서 `a.isPinned !== b.isPinned` 비교를 바꾼다.

```js
const pinnedNow = notice => notice.isPinned === true
    || (notice.pinnedUntil && new Date(notice.pinnedUntil).getTime() > now);

if (pinnedNow(a) !== pinnedNow(b)) return pinnedNow(a) ? -1 : 1;
```

읽을 때 시각으로 판정하므로 만료된 고정을 청소하는 배치가 필요 없다.
`notice-expiry.js`가 마감·유예를 다루는 방식과 같다.

고정끼리의 순서는 기존 정렬 기준(마감임박순·최신순 등)을 그대로 따른다. 고정 여부는
정렬의 첫 번째 축일 뿐 그 안을 다시 나누지 않는다.

### 만료 시각 계산

**7일 후와 마감 시각 중 빠른 쪽.** 마감 정보가 없으면 7일 후.

```js
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function computePinnedUntil(notice, now) {
    const sevenDays = new Date(now.getTime() + SEVEN_DAYS_MS);
    const raw = notice.deadlineAt
        || (notice.deadline ? `${String(notice.deadline).slice(0, 10)}T23:59:59` : '');
    if (!raw) return sevenDays;
    const deadline = new Date(raw);
    if (Number.isNaN(deadline.getTime())) return sevenDays;
    return deadline < sevenDays ? deadline : sevenDays;
}
```

날짜만 있는 `deadline`은 그날 끝(`23:59:59`)까지로 읽는다. 마감일 당일 아침에
고정이 풀리면 안 된다.

이미 마감이 지난 공지는 고정을 거절한다(400). 마감된 공지는 정렬에서 이미 맨 아래
그룹(`lifecycleGroup`)으로 내려가 있어 고정해도 위로 올라오지 않는다. 아무 일도
일어나지 않는 버튼을 두는 대신 이유를 말해 준다. `isAlwaysOpen` 공지는 마감이 없으므로
7일 규칙을 그대로 받는다.

### 고정 엔드포인트

```text
PATCH /api/notices/:id/pin              requireNoticeAdmin
body: { pinned: true | false }
```

| 응답 | 조건 | 본문 |
| --- | --- | --- |
| 200 | 성공 | `{ notice }` (`toNoticeSummary`, `pinnedUntil` 포함) |
| 400 | 마감이 지난 공지를 고정하려 함 | `{ error }` |
| 400 | id가 정수가 아니거나 `pinned`가 불리언이 아님 | `{ error }` |
| 404 | 공지 없음 | `{ error }` |

`pinned: false`는 `pinned_until = null`**과 함께** `is_pinned = false`도 끈다.
화면에 「고정」 배지가 떠 있는데 "고정 해제"를 눌러도 안 풀리면 관리자는 버그로 읽는다.
어느 경로로 고정됐든 해제는 해제여야 한다.

`toNoticeSummary()`에 `pinnedUntil`을 추가하고, `automation-store.js`의 행 매핑에
`pinnedUntil: row.pinned_until || null`을 넣는다.

### 카드 배지

`core.js`의 카드 렌더에서 「고정」 배지 조건을 넓힌다.

```js
${isNoticePinnedNow(notice) ? '<span class="tag pinned">고정</span>' : ''}
```

`isNoticePinnedNow()`는 서버의 `pinnedNow`와 같은 판정을 클라이언트에서 한 번 더 한다.
상세 화면(`core.js`의 상세 렌더)과 관리자 목록 요약에도 같은 함수를 쓴다.

---

## 4. 프런트엔드 — js/notice-card-admin.js

신규 파일. 200줄 안팎. `index.html`과 `admin.html` 어느 쪽에서도 `<script>` 태그로
정적 참조하지 않는다. `core.js`가 세션을 확인한 뒤에만 주입한다.

`prepare-public.mjs`는 `js/` 디렉터리를 통째로 재귀 복사하므로 배포 스크립트는
손댈 필요가 없다. 파일을 만들기만 하면 `public/js/`에 딸려간다.

### 트리거

카드 우측 상단에 `⋮` 버튼을 꽂는다.

```html
<div class="card-admin-controls">
  <button class="card-admin-menu-trigger" type="button"
          aria-haspopup="menu" aria-expanded="false"
          aria-label="공지 관리 메뉴">⋮</button>
</div>
```

- `position: absolute; top: 10px; right: 10px`. 좌측의 `.card-block-controls`
  (`left: 10px`, 드래그 핸들)와 자리가 겹치지 않는다.
- hover/focus-within에서만 보인다. 드래그 핸들과 같은 규칙이라 화면이 일관된다.
- 클릭 핸들러는 `event.stopPropagation()`을 부른다. 카드의 `onclick`이 상세를 연다.

### 드롭다운

**드롭다운은 카드마다 만들지 않고 문서에 하나만 둔다.** 카드 20개에 드롭다운 20개는
낭비이고, 그리드의 `overflow` 안에서 잘린다. 열 때 트리거의 `getBoundingClientRect()`를
재서 `position: fixed`로 띄운다.

닫히는 조건: 바깥 클릭, Esc, 스크롤, 리사이즈, 항목 실행 후.
`role="menu"`와 `role="menuitem"`, ↑↓ 이동, Esc에 트리거로 포커스 복귀.

뷰포트 아래쪽 카드에서는 메뉴가 화면 밖으로 나가므로 아래 공간이 부족하면 위로 편다.

### 항목

| 항목 | 동작 |
| --- | --- |
| 알림 주기 | 확인 대화상자 → `POST /api/notices/:id/reminder` → 토스트에 대상 수 |
| 공지 상단으로 보내기 / 고정 해제 | `PATCH /api/notices/:id/pin` → `filterCards()`로 목록 재요청 |
| 수정 | `location.assign('/admin/workspace?edit=' + id)` |
| 숨김 | `PATCH /api/notices/:id/visibility` → `filterCards()` |

- 라벨은 현재 상태를 보고 정한다. 이미 고정된 공지는 「공지 상단으로 보내기」가 아니라
  「고정 해제」로 뜬다.
- 「수정」은 `admin.js:2980`이 이미 읽는 `?edit=` 딥링크를 그대로 쓴다. 새 경로가 아니다.
- 고정과 숨김은 목록의 구성이나 순서를 바꾸므로 서버 응답을 받은 뒤 `filterCards()`로
  현재 페이지를 다시 부른다. 낙관적 갱신은 하지 않는다. 정렬 규칙이 서버에 있어
  클라이언트가 재현하면 두 벌이 된다.
- 알림은 목록을 바꾸지 않으므로 토스트만 띄운다.

### 확인과 피드백

「알림 주기」에만 확인 대화상자를 건다. 되돌릴 수 없고 사람들의 휴대폰이 울린다.

> "[제목]" 공지 알림을 다시 보낼까요?
> 학번·카테고리가 맞는 구독자에게 발송됩니다.

발송 후 토스트에 서버가 돌려준 실제 대상 수를 넣는다. 409면 "N시간 뒤에 다시 보낼 수
있습니다"를 그대로 보여 준다.

「숨김」을 공개 화면에서 누르면 그 카드가 목록에서 사라져 되돌리려면 admin.html로 가야
한다. 토스트에 "관리자 화면에서 되돌릴 수 있습니다" 링크를 함께 띄운다.

토스트는 확장 스크립트가 자체적으로 만든다. `core.js`에 공용 토스트가 없고, 이 기능
하나 때문에 공용 컴포넌트를 만들면 학생 번들이 커진다.

### 스타일

확장 스크립트가 자기 CSS를 `<style>` 엘리먼트로 주입한다.

`css/core.css`에 넣으면 학생에게도 내려가고, `css/admin.css`는 `index.html`이 부르지
않는다. 별도 `.css` 파일을 동적으로 붙이면 요청이 하나 더 늘고 스타일이 늦게 붙어
메뉴가 잠깐 날것으로 보인다. 200줄 남짓이라 인라인이 낫고, "관리자가 아니면 아무것도
내려가지 않는다"가 깨끗하게 지켜진다.

색·간격·그림자는 `core.css`의 CSS 변수(`--border`, `--primary`, `--text-sub`,
`--danger`)를 참조한다. 새 디자인 토큰을 만들지 않는다.

---

## 5. 변경 파일

| 파일 | 변경 |
| --- | --- |
| `js/notice-card-admin.js` | 신규. 확장 구현 전체 |
| `js/core.js` | 확장 훅, 세션 확인·동적 로드, 고정 판정 헬퍼, 배지 조건 |
| `server/server.js` | `POST /notices/:id/reminder`, `PATCH /notices/:id/pin`, 정렬 판정, `toNoticeSummary`에 `pinnedUntil` |
| `server/services/push-service.js` | 리마인드 title·tag 분기 |
| `server/storage/automation-store.js` | `pinnedUntil` 매핑, 리마인드 작업 생성·조회, 파일 모드 `kind` 저장 |
| `server/sql/supabase-schema.sql` | `pinned_until` 컬럼, `notification_jobs` 부분 인덱스 |
| `README.md` | 카드 관리자 메뉴와 두 엔드포인트 문서화 |

`scripts/prepare-public.mjs`는 `js/`를 통째로 복사하므로 변경이 없다.

## 6. 테스트

### tests/notice-reminder.test.js (신규)

- 게시된 공지에 리마인드 작업이 생기고 `recipients`가 대상 구독자 수와 맞는다
- 24시간 안 재요청은 409, `retryAfterHours`가 남은 시간과 맞는다
- `pending` 리마인드가 남아 있으면 409
- 미게시·숨김·없는 공지는 404
- 웹 푸시 미설정이면 503
- `push-service`가 `kind: 'reminder'` 작업을 `[마감 임박]` 제목과 job.id가 붙은
  태그로 보낸다
- `new_notice`는 여전히 공지당 하나만 만들어진다

### tests/notice-pin.test.js (신규)

- 고정하면 `pinnedUntil`이 7일 후로 설정된다
- 마감이 3일 뒤면 `pinnedUntil`이 마감 시각이 된다
- 날짜만 있는 `deadline`은 그날 `23:59:59`로 읽는다
- 마감이 지난 공지 고정은 400
- 해제는 `pinnedUntil`과 `isPinned`를 함께 끈다
- 만료된 `pinnedUntil`은 정렬에서 고정으로 치지 않는다

### 기존 테스트 보강

- `tests/notice-list-filters.test.js` — 기존 pinned 케이스 옆에 `pinnedUntil` 케이스
- `tests/public-build.test.js` — **관리자 세션이 없으면 카드에 `⋮`가 없고
  `notice-card-admin.js`를 받지 않는다.** 원칙을 테스트로 못 박는다.
  `notice-card-admin.js`가 `public/`에 복사되는지도 확인한다.

## 7. 배포 순서

1. `server/sql/supabase-schema.sql`을 Supabase SQL Editor에서 실행한다.
   컬럼 추가와 인덱스 교체 둘 다 재실행 가능하다.
2. Render를 배포한다. 새 엔드포인트가 열리고 정렬이 `pinned_until`을 본다.
3. Cloudflare Pages를 배포한다.

1과 2 사이에 이전 서버가 돌아도 문제없다. `pinned_until`을 읽지 않을 뿐이다.
2와 3 사이도 마찬가지다. 이전 프런트는 확장을 로드하지 않는다.

롤백은 프런트만 되돌려도 된다. 확장이 사라지면 메뉴도 사라지고, 이미 설정된
`pinned_until`은 서버 정렬에서 계속 존중된다.

## 8. 위험과 대응

| 위험 | 대응 |
| --- | --- |
| 리마인드 남발로 구독자가 알림을 꺼 버린다 | 24시간 쿨다운, 확인 대화상자, 감사 로그 |
| 브라우저가 리마인드로 원래 알림을 덮어쓴다 | `tag`에 job.id를 넣어 구분. 테스트로 고정 |
| 고정이 쌓여 상단이 묵는다 | 만료 시각이 있어 저절로 풀린다 |
| 공개 화면에 관리자 코드가 실린다 | 정적 참조 없음 + `public-build.test.js`가 검사 |
| 관리자가 실수로 공개 화면에서 숨김을 누른다 | 토스트에 복구 경로 링크. 삭제는 메뉴에 없다 |
