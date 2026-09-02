# SNU ECE 공지방

서울대학교 전기정보공학부 공지를 카카오톡 공지방 대신 웹에서 검색·필터링하고, ECE 학사 공지를 자동 수집해 관리자가 검수한 뒤 대상자에게 알림을 보내는 서비스입니다.

## 구성

- 프런트엔드: 정적 HTML/CSS/JavaScript, PWA, Cloudflare Pages
- API: Express, Render
- 데이터베이스: Supabase PostgreSQL
- 자동 수집: Cloudflare Cron Worker → Render 보호 엔드포인트
- 공지 분석: Gemini JSON 응답
- 알림: VAPID Web Push
- 카카오톡 봇 준비: 신청·학사 신규 공지 웹훅, 고유 링크, 마감 임박 조회 API

## 공지 카드 관리자 메뉴

관리자로 로그인한 상태에서 공개 화면을 열면 각 공지 카드 우측 상단에 ⋮ 메뉴가 나타납니다.
카카오톡 공지방에서 마감 임박 공지를 다시 올리던 "리마인드 공지"를 웹으로 옮긴 것으로,
알림 주기·상단 고정·수정·숨김을 카드에서 바로 실행합니다. 삭제는 넣지 않았습니다.

- **알림 주기**: 학번·카테고리가 맞는 구독자에게 웹 푸시를 다시 보냅니다. 알림 제목에
  `[마감 임박]`이 붙고, 브라우저가 원래 알림을 덮어쓰지 않도록 태그를 따로 씁니다.
  같은 공지에는 24시간에 한 번만 보낼 수 있고, 아직 처리 중인 리마인드가 있으면 거절합니다.
- **공지 상단으로 보내기**: 7일 뒤와 마감 시각 중 빠른 쪽에 자동으로 풀립니다(`pinned_until`).
  공지 편집 폼의 무기한 고정(`is_pinned`)과 공존하며, 해제는 둘 다 끕니다.
  마감이 지난 공지는 고정할 수 없습니다.

이 메뉴는 [js/notice-card-admin.js](js/notice-card-admin.js)에 있고 `index.html`에
정적으로 실리지 않습니다. `core.js`가 `GET /api/admin/session`으로 공지 또는 마스터
권한을 확인한 뒤에만 내려받습니다. 학생이 받는 번들에는 관리자 UI가 들어가지 않는다는
원칙을 지키기 위해서이며, `tests/public-build.test.js`가 이를 검사합니다.

자동 수집 공지는 즉시 공개되지 않습니다. 항상 `pending_review` 상태로 들어오며, 관리자가 원문·대상·요약·키워드·카테고리를 검수해 승인한 경우에만 공개되고 알림 작업이 생성됩니다.

카테고리는 학사·기회·설문·행사 넷 중 하나로 항상 채워집니다. Gemini가 고른 값이 우선이고, 모델이 비워 보내거나 분석이 실패했거나 관리자가 카테고리 없이 등록한 공지는 `server/services/notice-classifier.js`의 규칙 분류기가 제목·키워드·본문으로 하나를 정합니다(단서가 없으면 행사). 이미 저장된 미분류 공지도 읽을 때 같은 규칙으로 채워 내보내므로 화면과 앱에 빈 카테고리가 나오지 않습니다. 저장값까지 맞추려면 `npm run backfill:categories:dry-run`으로 확인한 뒤 `npm run backfill:categories`를 실행합니다.

## 로컬 실행

```bash
npm install
copy .env.example .env
npm start
```

기본 주소는 `http://localhost:3000`입니다. Supabase 환경 변수가 없으면 `server/data/*.json`을 사용하는 기능 확인용 파일 모드로 실행됩니다.

프런트엔드 배포 산출물은 다음 명령으로 생성합니다.

```bash
npm run prepare:public
```

`index.html`, `admin.html`, `css`, `js`, PWA 파일과 Cloudflare 헤더가 `public/`에 복사됩니다. `public/`을 직접 수정하지 마세요.

## 프런트엔드 구조

공개 화면과 관리자 화면은 파일부터 분리되어 있습니다. 학생이 받는 번들에는 관리자 UI가 들어가지 않습니다.

| 파일 | 역할 |
| --- | --- |
| `index.html` | 공개 화면. 공지 열람·검색·비교·알림 구독 |
| `admin.html` | 관리자 화면. 검수, 공지 등록/수정/삭제, 배너, 카테고리, 설정 |
| `css/core.css`, `js/core.js` | 뷰 모드와 무관한 공통 레이어 (토큰, 카드, 모달, API, 필터) |
| `css/desktop.css`, `js/desktop.js` | 데스크탑 모드 전용. 좌우 고정 레일, 4열 그리드, 공지 비교 |
| `css/mobile.css`, `js/mobile.js` | 모바일 모드 전용. 서랍 메뉴, 1열 그리드 |
| `css/admin.css`, `js/admin.js` | 관리자 화면 전용 |

뷰 모드는 `<html data-view="desktop|mobile">`로 갈립니다. 첫 페인트가 흔들리지 않도록 `index.html`의 인라인 스크립트가 CSS보다 먼저 값을 정하고(저장된 선택 → 없으면 화면 폭), 헤더의 전환 버튼이 `localStorage.eceLayoutMode`에 선택을 기억합니다. `desktop.js`와 `mobile.js`는 `registerViewModule()`로 자신을 등록하며, 활성화된 한쪽만 동작합니다.

좌우 레일은 `position: fixed`라 본문을 스크롤해도 자리가 고정됩니다. 승인된 학내 홍보는 오른쪽 레일에만 노출되며(`placement: right_rail`), 상단 가로 배너는 제거되었습니다.

학내 홍보는 무료이며 선착순으로 확정하지 않습니다. 전기정보공학부 학생과의 관련성,
내용의 명확성, 일정 충돌을 검수하고, 기본 7일·최대 14일 동안 동시에 5개까지
순환 노출합니다. 5개 슬롯이 모두 찬 경우 신청을 자동 승인하지 않고 다음 가능한
일정을 신청자에게 회신합니다.

공지 제목은 자유 입력이 아니라 `[주관 기관] 핵심 내용 유형` 양식으로 조립됩니다. 조합 규칙은 `js/admin.js`의 `composeNoticeTitle()` 한 곳에만 있고, 기존 제목을 양식으로 되돌려 읽는 일은 `applyTitleToBuilder()`가 맡습니다.

## 주요 흐름

1. Cloudflare Worker가 30분마다 Render의 `POST /api/internal/crawl/ece-academics`를 호출합니다.
2. 크롤러는 ECE 커뮤니티 → 학사 게시판에서 `학부`, `학부&대학원` 공지만 읽습니다.
3. 외부 게시물 번호로 중복을 차단하고 Gemini가 요약·마감일·대상 학번·키워드를 분석합니다.
4. 관리자가 검수함에서 승인 또는 반려합니다.
5. 승인한 공지만 공개되며, “승인 및 알림”을 선택하면 알림 작업이 원자적으로 생성됩니다.
6. 서버 워커가 구독자의 학번·카테고리 설정과 공지를 비교해 웹 푸시를 전송합니다.
7. 최근 60일 동안 5개 이상의 공지에서 평균 신뢰도 0.75 이상으로 반복된 키워드를 카테고리 후보로 추천합니다. 생성·병합·보류·반려 결정은 관리자만 수행합니다.

## Supabase 준비

1. Supabase 프로젝트를 생성합니다.
2. SQL Editor에서 [server/sql/supabase-schema.sql](server/sql/supabase-schema.sql)을 전체 실행합니다.
3. Render에 `SUPABASE_URL`과 `SUPABASE_SERVICE_ROLE_KEY`를 설정합니다.

서비스 역할 키는 Express 서버 전용입니다. Cloudflare Pages의 JavaScript나 저장소에 넣지 마세요. 자동화 테이블은 RLS가 활성화되어 있고 `anon`, `authenticated` 직접 접근이 취소되어 있습니다.

기존 DB에 재적용해도 `create table if not exists`, `add column if not exists`를 사용하므로 마이그레이션을 반복 실행할 수 있습니다. 적용 전에는 Supabase 백업 또는 스테이징 프로젝트에서 먼저 검증하세요.

## Render 배포

- Build command: `npm install`
- Start command: `npm start`
- Health check: `/api/health`
- Runtime: Node.js 22 이상 (`package.json`의 `engines`와 일치)

필수 환경 변수는 [.env.example](.env.example)을 기준으로 설정합니다.

- `FRONTEND_ORIGIN`: 실제 Cloudflare Pages origin
- `PUBLIC_SITE_URL`: 공지별 카카오톡 링크를 만들 공개 사이트 주소
- `KAKAO_NOTICE_WEBHOOK_URL`: 신청·학사 공지 게시 이벤트를 받을 봇 중계 서버 주소
- `SUPER_ADMIN_TOKEN`, `NOTICE_ADMIN_TOKEN`, `BANNER_ADMIN_PASSWORD`: 서로 다른 긴 난수
- `CRAWL_TRIGGER_SECRET`: 32자 이상 난수
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- `GEMINI_API_KEY`
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`

VAPID 키는 로컬에서 생성할 수 있습니다.

```bash
npx web-push generate-vapid-keys
```

키를 바꾸면 기존 브라우저 구독은 다시 받아야 합니다.

## Cloudflare Pages 배포

- Build command: `npm run prepare:public`
- Build output directory: `public`

[js/config.js](js/config.js)의 `window.API_BASE_URL`을 Render API 주소로 설정합니다. `_headers`의 CSP `connect-src`는 기본적으로 `https://*.onrender.com`과 `https://*.supabase.co`를 허용합니다. 다른 API 도메인을 쓰면 배포 전에 정확한 origin을 추가하세요.

## Cloudflare Cron Worker 배포

[cloudflare/wrangler.jsonc](cloudflare/wrangler.jsonc)의 `API_BASE_URL`을 Render 주소로 바꾼 뒤 `cloudflare` 디렉터리에서 배포합니다.

```bash
cd cloudflare
npx wrangler secret put CRAWL_TRIGGER_SECRET
npx wrangler deploy
```

Worker의 `CRAWL_TRIGGER_SECRET`은 Render와 정확히 같아야 합니다. Cron 표현식은 `*/30 * * * *`이며 Cloudflare Cron은 UTC 기준으로 실행됩니다. 이 주기는 시간대와 무관하게 30분 간격입니다.

## 배포 전 스모크 테스트

스테이징 Supabase와 테스트용 브라우저 구독으로 다음을 확인합니다.

1. 관리자 화면에서 수동 크롤링을 한 번 실행합니다.
2. 새 공지가 검수함에는 보이지만 공개 목록에는 없는지 확인합니다.
3. 원문 링크와 첨부파일을 확인하고 “승인 및 알림”을 실행합니다.
4. 공개 상세 화면이 열리고 웹 푸시를 수신·클릭할 수 있는지 확인합니다.
5. 같은 크롤링과 알림 처리를 다시 실행해 공지와 알림이 중복되지 않는지 확인합니다.
6. 키워드가 기준을 충족했을 때 카테고리 추천의 근거 공지 수·기간·신뢰도가 맞는지 확인합니다.

실제 푸시 구독 endpoint, 관리 토큰, 서비스 역할 키는 체크리스트나 로그에 기록하지 마세요.

## 운영과 문제 해결

- 크롤러 실행 이력: `GET /api/admin/crawl-runs`
- 관리자 수동 크롤링: `POST /api/admin/crawl/ece-academics`
- 알림 작업 수동 재처리: `POST /api/admin/notification-jobs/process`
- 마감 임박 다이제스트 소스: `GET /api/notices/deadlines/imminent?days=7`
- 검수함: `GET /api/admin/review-notices`
- 카테고리 후보: `GET /api/admin/category-candidates`
- 리마인드 발송: `POST /api/notices/:id/reminder`
- 상단 고정: `PATCH /api/notices/:id/pin`

크롤러가 `failed` 또는 `partial`이면 ECE 사이트 HTML 구조 변경 여부를 먼저 확인하세요. 파서는 게시판 행이나 제목·본문 선택자를 찾지 못하면 조용히 잘못 저장하지 않고 실패시킵니다.

자동화가 비활성화되는 대표 원인은 다음과 같습니다.

- 크롤링: `CRAWL_TRIGGER_SECRET`이 없거나 32자 미만
- LLM 분석: `GEMINI_API_KEY` 없음
- 웹 푸시: VAPID 공개키·비밀키·subject 중 하나라도 없음
- 영구 저장: Supabase URL 또는 서비스 역할 키 없음

푸시 서비스가 404 또는 410을 반환한 구독은 자동으로 비활성화합니다. 일시 오류는 1분, 5분, 30분 후 재시도하며 성공 또는 영구 실패 기록은 중복 전송하지 않습니다.

신청 또는 학사 카테고리 공지가 새로 게시되면 `KAKAO_NOTICE_WEBHOOK_URL`로
`notice.published` JSON을 보냅니다. `message`에는 `[신청|학사]`, 공지 제목,
절대 마감일과 D-Day, 공지 고유 링크가 모두 들어갑니다. 웹훅이 설정되지 않았거나
다른 카테고리라면 게시 자체는 정상 완료되고 전송만 건너뜁니다. 하루 1회 다이제스트는
마감 임박 API의 `counts.today`, `counts.upcoming`, `notices`를 봇 중계 서버에서 묶어
발송하도록 연결할 수 있습니다.

카테고리 후보의 `occurrenceCount`는 기간 안의 서로 다른 공지 수이고, `averageConfidence`는 그 공지들의 LLM 신뢰도 평균입니다. “다시 추천 안 함”은 영구 제외, “30일 보류”는 기간이 지난 뒤 기준을 다시 충족하면 재등장합니다.

## 롤백

문제가 생기면 먼저 Cloudflare Worker Cron을 비활성화해 신규 수집을 멈춥니다. 푸시 문제라면 Render에서 VAPID 환경 변수를 제거하고 재배포하면 알림 워커가 비활성화됩니다. 이미 승인된 공지와 Supabase 데이터는 유지됩니다. 이전 Cloudflare Pages/Render 배포 버전으로 되돌린 뒤 원인을 확인하세요.

## 검증

```bash
npm test
npm run prepare:public
node --check server/server.js
git diff --check
```

`tests/automation-e2e.test.js`는 임시 JSON 저장소와 고정 HTML/Gemini/Web Push 응답으로 수집, 비공개 검수, 승인, 공개, 알림 1회 전송, 중복 차단, 카테고리 추천까지 한 흐름으로 검증합니다. 실제 Cloudflare·Render·Supabase·브라우저 푸시를 사용하는 스테이징 스모크 테스트는 위의 배포 전 체크리스트에 따라 별도로 실행해야 합니다.
