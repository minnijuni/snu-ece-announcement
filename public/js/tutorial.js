/* 사용 설명서 튜토리얼.

   문서를 읽히는 대신 실제 화면 위에서 한 기능씩 짚는다. 설명하는 자리만
   남기고 나머지는 어둡게 덮으므로 시선이 흩어지지 않는다.

   안내 중에는 아래 화면을 누를 수 없다. 서랍이 열리거나 공지 상세로
   넘어가 버리면 다음에 짚을 자리가 화면에서 사라져 안내가 끊기기 때문이다.
   덮개가 클릭을 모두 받아내고, 사용자는 카드의 이전·다음으로만 움직인다.

   단계마다 target으로 가리킬 곳을 정한다. 그 자리가 화면에 없으면
   (데스크탑 전용 버튼을 모바일에서 볼 때 같은 경우) 그 단계는 조용히 건너뛴다.
   덕분에 데스크탑과 모바일이 한 벌의 단계 목록을 함께 쓴다. */

(function () {
    'use strict';

    const TUTORIAL_SEEN_KEY = 'eceTutorialSeen';
    const RING_PADDING = 0;
    const CARD_GAP = 14;
    const EDGE = 12;
    const MOVE_MIN_MS = 300;
    const MOVE_MAX_MS = 1000;

    /* hint를 적으면 카드 아래에 한 줄 덧붙는다. */
    const STEPS = [
        {
            target: '.search-field',
            title: '검색으로 시작하세요',
            body: '제목과 본문을 함께 찾습니다. 글자를 입력하는 즉시 아래 목록이 걸러지니 검색 버튼을 따로 누를 필요는 없습니다.',
            hint: '안내를 보는 동안에는 화면이 잠깁니다'
        },
        {
            target: '#search-guide-btn',
            title: '이 안내는 언제든 다시',
            body: '검색은 입력만으로 걸리기 때문에 돋보기 자리는 설명서 입구로 씁니다. 길을 잃으면 여기를 누르세요.'
        },
        {
            target: '.mobile-menu-btn',
            title: '왼쪽 위 손잡이',
            body: '목록을 조금 내리면 나타납니다. 누르면 카테고리와 바로가기 서랍이 열리고, 잠시 두면 다시 숨어 화면을 가리지 않습니다.',
            /* 이 손잡이는 가만두면 스스로 숨는다. 설명하는 동안에는 계속
               보이도록 붙잡아 두었다가, 단계를 떠날 때 손을 뗀다. */
            onEnter(target) {
                const hold = window.setInterval(() => target.classList.add('is-visible'), 600);
                target.classList.add('is-visible');
                return () => window.clearInterval(hold);
            }
        },
        {
            target: '#category-tabs',
            title: '카테고리로 나눠 보기',
            body: '학사·기회·설문·행사로 갈라 봅니다. 기회와 설문은 마감이 급한 순서로, 학사와 행사는 최신 순서로 자동 정렬됩니다.'
        },
        {
            target: '#notice-quick-filters',
            title: '자주 쓰는 조건은 한 번에',
            body: '마감 임박, 리워드 있음, 신청 필요, 마감을 바로 켜고 끕니다. 여러 개를 함께 켜면 모두 만족하는 공지만 남습니다.'
        },
        {
            target: '#filter-toggle-bar',
            title: '더 좁히고 싶다면',
            body: '학년, 대상, 등록 기간, 조회수까지 상세 조건을 펼쳐 고를 수 있습니다. 학부 홈페이지에서 모아 온 관련 공지를 뺄지도 여기서 정합니다. 켜 둔 조건은 이 줄에 칩으로 남아 한눈에 보입니다.'
        },
        {
            target: '#notice-sort-chips',
            title: '정렬 바꾸기',
            body: '최신순, 마감임박순, 조회순 중에 고릅니다. 마감임박순에서 마감일이 없는 공지는 맨 뒤로 갑니다.'
        },
        {
            target: '#notice-grid .card',
            title: '공지 열어보기',
            body: '카드를 누르면 원문, 첨부파일, AI 3줄 요약을 함께 봅니다. 요약은 참고용이고 판단은 언제나 원문이 기준입니다.'
        },
        {
            target: '#notice-grid .card .card-drag-handle, #notice-grid .card',
            title: '끌어서 나란히 비교',
            body: '카드 왼쪽 위 6점 손잡이를 잡아 왼쪽이나 오른쪽에 놓으면 공지를 나란히 펼쳐 비교합니다. 아래 휴지통에 놓으면 비교에서 뺍니다.',
            desktopOnly: true,
            /* 손잡이는 카드에 마우스를 올려야 나타난다. 설명하는 동안에는
               가리키는 것이 눈에 보여야 하므로 붙잡아 둔다. */
            onEnter(target) {
                const holder = target.closest('.card')?.querySelector('.card-block-controls');
                holder?.classList.add('is-tutorial-shown');
                return () => holder?.classList.remove('is-tutorial-shown');
            }
        },
        {
            target: '#right-ad-rail',
            title: '학내 홍보',
            body: '학생 단체와 학내 행사 홍보가 도는 자리입니다. 검수를 거친 항목만 정해진 기간 동안 걸립니다.'
        },
        {
            target: '.footer-column[aria-label="문의"] .footer-tutorial-links',
            title: '문의와 홍보 신청',
            body: '개선 의견은 익명으로 보낼 수 있고, 홍보 신청은 양식을 내면 검수 뒤 배너로 올라갑니다. 자주 묻는 질문도 여기 있습니다.'
        },
        {
            target: '#footer-sync .footer-sync-content',
            title: '언제 가져온 공지인지',
            body: '마지막으로 학부 홈페이지에서 공지를 가져온 시각입니다. 원문이 방금 올라왔다면 여기 시각 이후에 반영됩니다.'
        },
        {
            final: true,
            title: '준비되었습니다',
            body: '이제 화면 잠금을 풀고 직접 써 보세요. 검색으로 찾고, 조건으로 좁히고, 열어서 확인하면 됩니다. 이 안내는 검색창 오른쪽 돋보기에서 언제든 다시 열 수 있습니다.'
        }
    ];

    let layer = null;
    let shades = {};
    let ring = null;
    let card = null;
    let elements = {};
    let steps = [];
    let index = 0;
    let currentTarget = null;
    let followTimer = 0;
    let leaveStep = null;
    let currentHole = null;   // 지금 뚫려 있는 자리(화면 좌표)
    let currentSpot = null;   // 지금 카드가 앉은 자리
    let currentAlpha = 1;     // 지금 테두리의 진하기
    let correctedStep = -1;   // 어긋남을 이미 바로잡은 단계
    let lastTarget = null;    // 직전 단계가 짚던 자리

    function buildLayer() {
        if (layer) return;
        layer = document.createElement('div');
        layer.className = 'tutorial-layer';
        layer.id = 'tutorial-layer';
        layer.hidden = true;
        layer.setAttribute('role', 'dialog');
        layer.setAttribute('aria-modal', 'true');
        layer.setAttribute('aria-label', '사용 설명서');
        layer.innerHTML = `
            <div class="tutorial-shade" data-shade="top"></div>
            <div class="tutorial-shade" data-shade="bottom"></div>
            <div class="tutorial-shade" data-shade="left"></div>
            <div class="tutorial-shade" data-shade="right"></div>
            <div class="tutorial-ring" aria-hidden="true"></div>
            <div class="tutorial-card">
                <div class="tutorial-progress" aria-hidden="true">
                    <span class="tutorial-progress-fill" style="width:0%"></span>
                </div>
                <p class="tutorial-count"></p>
                <h2 class="tutorial-title"></h2>
                <p class="tutorial-body"></p>
                <p class="tutorial-hint"><span class="tutorial-hint-dot"></span><span class="tutorial-hint-text"></span></p>
                <a class="tutorial-doc" href="./guide.html">글로 된 설명서 보기</a>
                <div class="tutorial-actions">
                    <button type="button" class="tutorial-skip">그만 보기</button>
                    <span class="tutorial-spacer"></span>
                    <button type="button" class="tutorial-prev">이전</button>
                    <button type="button" class="tutorial-next">다음</button>
                </div>
            </div>`;
        document.body.appendChild(layer);

        ring = layer.querySelector('.tutorial-ring');
        card = layer.querySelector('.tutorial-card');
        shades = {
            top: layer.querySelector('[data-shade="top"]'),
            bottom: layer.querySelector('[data-shade="bottom"]'),
            left: layer.querySelector('[data-shade="left"]'),
            right: layer.querySelector('[data-shade="right"]')
        };
        elements = {
            fill: layer.querySelector('.tutorial-progress-fill'),
            count: layer.querySelector('.tutorial-count'),
            title: layer.querySelector('.tutorial-title'),
            body: layer.querySelector('.tutorial-body'),
            hint: layer.querySelector('.tutorial-hint-text'),
            doc: layer.querySelector('.tutorial-doc'),
            prev: layer.querySelector('.tutorial-prev'),
            next: layer.querySelector('.tutorial-next')
        };

        elements.prev.addEventListener('click', () => goTo(index - 1));
        elements.next.addEventListener('click', () => goTo(index + 1));
        layer.querySelector('.tutorial-skip').addEventListener('click', () => closeTutorial());

        /* 안내 중에는 아래 화면이 눌리지 않아야 한다. 층 전체가 화면을 덮고
           클릭을 받으므로 아래로는 아무것도 내려가지 않는다. 여기서 한 번 더
           막는 것은 층에 떨어진 클릭이 문서까지 올라가 다른 처리를 깨우는 것을
           끊기 위해서다. 카드 안에서 난 클릭만 그대로 지나간다. */
        const swallow = (types, cancel) => {
            for (const type of types) {
                layer.addEventListener(type, event => {
                    if (card.contains(event.target)) return;
                    if (cancel) event.preventDefault();
                    event.stopPropagation();
                }, true);
            }
        };
        swallow(['click', 'dblclick', 'mousedown', 'mouseup', 'contextmenu'], true);
        /* 손가락과 포인터는 여기서 취소하지 않는다. 취소하면 브라우저가
           탭으로 이어지는 흐름까지 끊어 카드 버튼이 둔해진다. 어차피 층이
           받아내므로 아래로는 내려가지 않는다. */
        swallow(['pointerdown', 'pointerup', 'touchstart', 'touchend'], false);
        /* 손으로 굴리는 것도 막는다. 안내가 짚는 자리로 화면을 옮겨 주는데
           그 위에서 사람이 또 끌면 두 움직임이 겹쳐 위치가 어긋난다. */
        for (const type of ['wheel', 'touchmove']) {
            layer.addEventListener(type, event => {
                if (card.contains(event.target)) return;
                event.preventDefault();
            }, { passive: false, capture: true });
        }
    }

    function isVisible(element) {
        if (!element) return false;
        if (element.hidden) return false;
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) return false;
        return getComputedStyle(element).visibility !== 'hidden';
    }

    function resolveTarget(step) {
        if (step.final) return null;
        for (const selector of String(step.target || '').split(',')) {
            const element = document.querySelector(selector.trim());
            if (isVisible(element)) return element;
        }
        return undefined; // 못 찾았다는 뜻. null(가리킬 곳 없음)과 구분한다.
    }

    function usableSteps() {
        return STEPS.filter(step => {
            if (step.final) return true;
            if (step.desktopOnly && document.documentElement.dataset.view === 'mobile') return false;
            return resolveTarget(step) !== undefined;
        });
    }

    /* 설명 카드를 어디에 놓을지.
       짚는 자리를 가리지 않는 것이 우선이다. 위아래로 붙일 자리가 없으면
       옆으로 돌리고, 세로로 긴 공지 카드처럼 사방이 좁으면 덜 가려지는
       쪽 끝에 붙인다. */
    function pickCardSpot(rect, cw, ch, vw, vh) {
        const clampV = value => Math.min(Math.max(EDGE, value), Math.max(EDGE, vh - ch - EDGE));
        const clampH = value => Math.min(Math.max(EDGE, value), Math.max(EDGE, vw - cw - EDGE));
        const middle = clampH(rect.left + rect.width / 2 - cw / 2);
        // 검색창처럼 설명 상자보다 넓은 대상은 가운데에 띄우기보다 왼쪽 선을
        // 맞추는 편이 대상과 설명의 관계가 반듯하게 보인다.
        const stackedLeft = rect.width >= cw ? clampH(rect.left) : middle;

        const beside = [];
        if (rect.right + CARD_GAP + cw + EDGE <= vw) beside.push({ left: rect.right + CARD_GAP, top: clampV(rect.top) });
        if (rect.left - CARD_GAP - cw - EDGE >= 0) beside.push({ left: rect.left - CARD_GAP - cw, top: clampV(rect.top) });

        const stacked = [];
        if (rect.bottom + CARD_GAP + ch + EDGE <= vh) stacked.push({ top: rect.bottom + CARD_GAP, left: stackedLeft });
        if (rect.top - CARD_GAP - ch - EDGE >= 0) stacked.push({ top: rect.top - CARD_GAP - ch, left: stackedLeft });

        // 세로로 긴 표적은 옆에 세우는 편이 낫다. 넓적한 것은 아래위가 자연스럽다.
        const tall = rect.height > vh * 0.4;
        const order = tall ? [...beside, ...stacked] : [...stacked, ...beside];
        if (order.length) return order[0];

        return vh - rect.bottom >= rect.top
            ? { top: Math.max(EDGE, vh - ch - EDGE), left: middle }
            : { top: EDGE, left: middle };
    }

    /* 화면을 얼마나 굴려야 표적과 카드가 함께 보이는지.
       둘을 세로로 세워도 들어가면 그 묶음을 가운데로, 표적이 화면보다 길면
       카드가 앉을 자리만 위에 비우고 표적을 그 아래로 내린다. */
    function scrollAmountFor(rect, cardWidth, cardHeight) {
        const vh = window.innerHeight;
        const vw = window.innerWidth;
        const fitsBeside = rect.right + CARD_GAP + cardWidth + EDGE <= vw
            || rect.left - CARD_GAP - cardWidth - EDGE >= 0;

        // 옆에 세울 수 있으면 표적만 가운데로 올리면 된다.
        if (fitsBeside) return rect.top - Math.max(EDGE, (vh - Math.min(rect.height, vh)) / 2);

        const group = rect.height + CARD_GAP + cardHeight;
        if (group + EDGE * 2 <= vh) return rect.top - (vh - group) / 2;
        return rect.top - (cardHeight + CARD_GAP + EDGE);
    }

    /* 테두리가 감쌀 자리. 화면 밖으로 나간 값도 그대로 둔다.
       여기서 미리 잘라 버리면 두 자리를 섞을 때 모양이 일그러진다.
       자르는 일은 실제로 그릴 때 한 번만 한다. */
    function holeAround(rect) {
        return {
            top: Math.max(4, rect.top - RING_PADDING),
            left: Math.max(4, rect.left - RING_PADDING),
            right: Math.min(window.innerWidth - 4, rect.right + RING_PADDING),
            bottom: Math.min(window.innerHeight - 4, rect.bottom + RING_PADDING)
        };
    }

    // 마지막 단계에는 짚을 자리가 없다. 화면 한가운데의 크기 없는 구멍을 주면
    // 가림판 넉 장이 저절로 화면을 다 덮는다.
    function holeOf(element) {
        if (element) return holeAround(element.getBoundingClientRect());
        return { top: window.innerHeight / 2, left: window.innerWidth / 2,
                 right: window.innerWidth / 2, bottom: window.innerHeight / 2 };
    }

    /* 화면에 실제로 그리는 곳. 여기서는 계산하지 않고 받은 값만 옮긴다. */
    function applyFrame(hole, spot, alpha) {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const clampV = value => Math.min(Math.max(0, value), vh);
        const clampH = value => Math.min(Math.max(0, value), vw);

        const top = clampV(hole.top);
        const bottom = Math.max(top, clampV(hole.bottom));
        const left = clampH(hole.left);
        const right = Math.max(left, clampH(hole.right));
        const width = right - left;
        const height = bottom - top;

        Object.assign(shades.top.style, { top: '0px', left: '0px', width: `${vw}px`, height: `${top}px` });
        Object.assign(shades.bottom.style, { top: `${bottom}px`, left: '0px', width: `${vw}px`, height: `${vh - bottom}px` });
        Object.assign(shades.left.style, { top: `${top}px`, left: '0px', width: `${left}px`, height: `${height}px` });
        Object.assign(shades.right.style, { top: `${top}px`, left: `${right}px`, width: `${vw - right}px`, height: `${height}px` });
        Object.assign(ring.style, {
            top: `${top}px`, left: `${left}px`, width: `${width}px`, height: `${height}px`,
            opacity: String(alpha)
        });

        card.style.top = `${spot.top}px`;
        card.style.left = `${spot.left}px`;
    }

    /* 화면에 붙박여 스크롤을 따라오지 않는 것인지.
       오른쪽 홍보 칸은 데스크탑에서 그렇다. 어차피 늘 같은 자리에 보이므로
       그런 것을 짚을 때는 화면을 굴릴 까닭이 없다. 굳이 굴리면 맨 위로
       올라갔다가 다음 단계에서 다시 맨 아래로 내려가는 헛걸음이 생긴다. */
    function isPinned(element) {
        for (let node = element; node && node !== document.body; node = node.parentElement) {
            if (getComputedStyle(node).position === 'fixed') return true;
        }
        return false;
    }

    function scrollGoalFor(target) {
        const startY = window.scrollY;
        if (!target || isPinned(target)) return startY;
        const cardRect = card.getBoundingClientRect();
        const limit = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
        const delta = scrollAmountFor(target.getBoundingClientRect(), cardRect.width, cardRect.height);
        return Math.min(Math.max(0, startY + delta), limit);
    }

    /* 다 굴리고 났을 때의 모습을 미리 알아낸다.
       화면을 도착 지점으로 한 번 옮겨 재고 곧바로 되돌리는데, 같은 프레임
       안에서 끝나므로 화면에는 그려지지 않는다. */
    function measureAtGoal(target, startY, endY) {
        const cardRect = card.getBoundingClientRect();
        const moved = endY !== startY;
        if (moved) window.scrollTo(0, endY);
        const hole = holeOf(target);
        const spot = target
            ? pickCardSpot(target.getBoundingClientRect(), cardRect.width, cardRect.height,
                           window.innerWidth, window.innerHeight)
            : { top: (window.innerHeight - cardRect.height) / 2, left: (window.innerWidth - cardRect.width) / 2 };
        if (moved) window.scrollTo(0, startY);
        return { hole, spot };
    }

    const lerp = (from, to, t) => from + (to - from) * t;

    function lerpHole(from, to, t) {
        return {
            top: lerp(from.top, to.top, t),
            left: lerp(from.left, to.left, t),
            right: lerp(from.right, to.right, t),
            bottom: lerp(from.bottom, to.bottom, t)
        };
    }

    const middleOf = hole => ({ x: (hole.left + hole.right) / 2, y: (hole.top + hole.bottom) / 2 });

    // 시작과 끝이 부드럽게 붙는 곡선. 가운데가 빠르고 양끝이 느리다.
    const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

    /* 한 단계에서 다음 단계로.

       테두리는 매 프레임 두 대상의 '지금 자리'를 재서 섞는다. 미리 잰 값을
       직선으로 이으면 화면이 굴러가는 동안 테두리만 따로 날아가 내용에서
       떨어져 보인다. 지금 자리를 섞으면 굴러가는 내용에 붙은 채 옮겨 간다.

       걸리는 시간은 거리에 비례한다. 먼 길을 짧은 시간에 밀어붙이면 한
       프레임에 수백 픽셀씩 건너뛰어, 끌어당긴 게 아니라 장면이 잘린 것처럼
       보인다. 대신 아주 먼 길에서는 가는 동안 테두리를 옅게 낮춘다.
       흐르는 내용 위를 테두리가 가로지르는 모습이 어지럽기 때문이다. */
    function moveTo(target) {
        window.cancelAnimationFrame(followTimer);

        const from = lastTarget && lastTarget.isConnected ? lastTarget : null;
        const startY = window.scrollY;
        const endY = scrollGoalFor(target);
        const { hole: holeGoal, spot: spotGoal } = measureAtGoal(target, startY, endY);
        const spotFrom = currentSpot || spotGoal;
        const alphaFrom = currentAlpha;
        const alphaGoal = target ? 1 : 0;

        lastTarget = target;
        currentSpot = spotGoal;
        currentAlpha = alphaGoal;

        const draw = e => {
            if (endY !== startY) window.scrollTo(0, lerp(startY, endY, e));
            const live = holeOf(target);
            currentHole = from && e < 1 ? lerpHole(holeOf(from), live, e) : live;
            applyFrame(
                currentHole,
                { top: lerp(spotFrom.top, spotGoal.top, e), left: lerp(spotFrom.left, spotGoal.left, e) },
                alphaAt(e)
            );
        };

        const holeStart = from ? holeOf(from) : holeGoal;
        const a = middleOf(holeStart);
        const b = middleOf(holeGoal);
        const travel = Math.hypot(b.x - a.x, b.y - a.y) + Math.abs(endY - startY);
        const dip = Math.min(0.8, travel / 1800);
        const alphaAt = e => lerp(alphaFrom, alphaGoal, e) * (1 - dip * Math.sin(Math.PI * e));

        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
            draw(1);
            return;
        }

        // 초당 1700픽셀쯤으로 일정하게 끈다. 너무 짧거나 길지 않게 잘라 둔다.
        const span = Math.min(1500, Math.max(380, travel / 1.7));
        const began = performance.now();
        const tick = now => {
            const t = Math.min(1, (now - began) / span);
            draw(ease(t));
            if (t < 1) followTimer = window.requestAnimationFrame(tick);
            else settleAfterMove(target);
        };
        followTimer = window.requestAnimationFrame(tick);
    }

    /* 도착하고 나서 한 번 확인한다.
       멀리 굴러가는 동안 그림이 늦게 떠서 문서 길이가 달라지면 짚는 자리가
       화면 밖으로 밀려날 수 있다. 그런 때만 조용히 다시 맞춘다. 한 단계에
       한 번만 손대므로 서로 밀며 되풀이될 일은 없다. */
    function settleAfterMove(target) {
        if (!target || target !== currentTarget || correctedStep === index) return;
        const rect = target.getBoundingClientRect();
        const missed = rect.bottom < 0 || rect.top > window.innerHeight;
        if (!missed) return;
        correctedStep = index;
        lastTarget = null;   // 이미 제자리를 잃었으니 섞을 것이 없다
        moveTo(target);
    }

    // 창 크기가 바뀌면 계산이 통째로 어긋나므로 움직임 없이 다시 맞춘다.
    function reposition() {
        window.cancelAnimationFrame(followTimer);
        const cardRect = card.getBoundingClientRect();
        currentHole = holeOf(currentTarget);
        currentSpot = currentTarget
            ? pickCardSpot(currentTarget.getBoundingClientRect(), cardRect.width, cardRect.height,
                           window.innerWidth, window.innerHeight)
            : { top: (window.innerHeight - cardRect.height) / 2, left: (window.innerWidth - cardRect.width) / 2 };
        currentAlpha = currentTarget ? 1 : 0;
        applyFrame(currentHole, currentSpot, currentAlpha);
    }

    function render() {
        const step = steps[index];
        if (!step) return closeTutorial();

        if (leaveStep) { leaveStep(); leaveStep = null; }
        currentTarget = step.final ? null : resolveTarget(step) || null;
        layer.classList.toggle('has-target', Boolean(currentTarget));
        if (currentTarget && typeof step.onEnter === 'function') {
            leaveStep = step.onEnter(currentTarget) || null;
        }

        layer.dataset.action = step.hint ? 'note' : 'read';
        elements.count.textContent = `${index + 1} / ${steps.length}`;
        elements.title.textContent = step.title;
        elements.body.textContent = step.body;
        elements.hint.textContent = step.hint || '';
        elements.fill.style.width = `${Math.round(((index + 1) / steps.length) * 100)}%`;
        elements.doc.hidden = !step.final;
        // 카드 폭이 마지막 단계에서만 달라진다. 재기 전에 미리 바꿔 둬야
        // 도착 자리를 제대로 계산한다.
        card.classList.toggle('is-centered', Boolean(step.final));
        elements.prev.disabled = index === 0;
        elements.next.textContent = step.final ? '시작하기' : '다음';

        // 카드 크기는 글을 넣은 뒤에야 정해진다. 한 프레임 기다렸다 재야
        // 어디에 놓고 얼마나 굴릴지 제대로 계산된다.
        correctedStep = -1;
        window.requestAnimationFrame(() => moveTo(currentTarget));
        elements.next.focus({ preventScroll: true });
    }

    function goTo(next) {
        if (next < 0) return;
        if (next >= steps.length) return closeTutorial(true);
        index = next;
        render();
    }

    function onKeyDown(event) {
        // 키보드로도 아래 화면을 깨울 수 없어야 한다. 카드 밖에 초점이
        // 가 있다면 누르는 시늉만 나고 아무 일도 일어나지 않는다.
        if ((event.key === 'Enter' || event.key === ' ') && card && !card.contains(event.target)) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        if (event.key === 'Escape') { event.preventDefault(); closeTutorial(); }
        else if (event.key === 'ArrowRight') { event.preventDefault(); goTo(index + 1); }
        else if (event.key === 'ArrowLeft') { event.preventDefault(); goTo(index - 1); }
    }

    function startTutorial() {
        buildLayer();
        /* 두 번째 단계에서 가리키는 것이 이 안내를 여는 돋보기다. 설명대로
           눌러보는 사람이 있으므로, 이미 열려 있으면 처음으로 되돌리지 않는다. */
        if (!layer.hidden) return;
        /* 서랍이나 상세 화면이 열린 채로 시작하면 짚을 자리가 가려진다.
           안내는 언제나 공지 목록에서 출발한다. */
        window.closeMobileDrawer?.();
        steps = usableSteps();
        if (!steps.length) return;
        index = 0;
        currentHole = null;
        currentSpot = null;
        currentAlpha = 0;
        lastTarget = null;
        layer.hidden = false;
        requestAnimationFrame(() => layer.classList.add('is-open'));
        /* 스크롤은 듣지 않는다.
           화면을 굴리는 것은 오직 이 안내뿐이고(사람 손은 막아 두었다),
           굴릴 때마다 스크롤 소식이 날아와 다시 맞추면 그리던 움직임을
           스스로 끊어 버린다. 실제로 그래서 자리를 옮기는 단계마다 툭툭
           끊겼다. 창 크기만 살핀다. */
        window.addEventListener('resize', reposition);
        document.addEventListener('keydown', onKeyDown, true);
        render();
        try { localStorage.setItem(TUTORIAL_SEEN_KEY, '1'); } catch { /* 저장이 막혀도 진행에는 지장 없다. */ }
    }

    function closeTutorial() {
        if (!layer || layer.hidden) return;
        if (leaveStep) { leaveStep(); leaveStep = null; }
        window.cancelAnimationFrame(followTimer);
        currentHole = null;
        currentSpot = null;
        lastTarget = null;
        window.removeEventListener('resize', reposition);
        document.removeEventListener('keydown', onKeyDown, true);
        layer.classList.remove('is-open');
        currentTarget = null;
        window.setTimeout(() => { if (layer) layer.hidden = true; }, 220);
    }

    window.startTutorial = startTutorial;
    window.closeTutorial = closeTutorial;

    // 다른 페이지에서 ?tutorial=1로 넘어오면 목록이 그려진 뒤 바로 연다.
    function autoStart() {
        const params = new URLSearchParams(location.search);
        if (params.get('tutorial') !== '1') return;
        history.replaceState(null, '', location.pathname);
        window.setTimeout(startTutorial, 700);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', autoStart);
    } else {
        autoStart();
    }
})();
