/* 공지 카드 관리자 메뉴.

   카카오톡 공지방에는 "리마인드 공지"가 있었다. 마감이 임박한 공지를 방에 다시
   올려 한 번 더 눈에 띄게 하는 운영 작업이다. 웹에서는 그 한 동작이 둘로 갈린다.
   구독자에게 알림을 다시 보내는 일과, 목록 위로 끌어올리는 일이다. 둘 다 관리자가
   이미 보고 있는 그 카드에서 바로 되어야 한다.

   이 파일은 index.html에 정적으로 실리지 않는다. core.js가 관리자 세션을 확인한
   뒤에만 내려받는다. 학생이 받는 번들에는 이 코드가 들어가지 않는다.
   그래서 스타일도 core.css가 아니라 여기서 주입한다. */

(function () {
    'use strict';

    const MENU_ID = 'notice-card-admin-menu';
    let openTrigger = null;

    // ========================================
    // 스타일
    // ========================================

    /* core.css에 넣으면 학생에게도 내려가고, admin.css는 index.html이 부르지
       않는다. 별도 파일을 동적으로 붙이면 요청이 하나 더 늘고 스타일이 늦게 붙어
       메뉴가 잠깐 날것으로 보인다. 색과 간격은 core.css의 변수를 그대로 쓴다. */
    function injectStyles() {
        if (document.getElementById('notice-card-admin-style')) return;
        const style = document.createElement('style');
        style.id = 'notice-card-admin-style';
        style.textContent = `
.card-admin-controls {
    position: absolute;
    top: 10px;
    right: 10px;
    z-index: 4;
    opacity: 0;
    transform: translateX(5px);
    pointer-events: none;
    transition: opacity 0.15s ease, transform 0.15s ease;
}
.card:hover .card-admin-controls,
.card:focus-within .card-admin-controls,
.card-admin-controls.is-open {
    opacity: 1;
    transform: translateX(0);
    pointer-events: auto;
}
.card-admin-menu-trigger {
    width: 28px;
    height: 32px;
    padding: 0;
    display: grid;
    place-items: center;
    color: #7b818b;
    background: rgba(255, 255, 255, 0.94);
    border: 1px solid var(--border);
    border-radius: 5px;
    box-shadow: 0 2px 8px rgba(20, 26, 36, 0.12);
    cursor: pointer;
    transition: color 0.15s ease, border-color 0.15s ease;
}
.card-admin-menu-trigger:hover,
.card-admin-menu-trigger:focus-visible {
    color: var(--primary);
    border-color: var(--primary);
    outline: none;
}
#${MENU_ID} {
    position: fixed;
    z-index: 900;
    min-width: 190px;
    padding: 5px;
    margin: 0;
    list-style: none;
    background: #fff;
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 10px 30px rgba(20, 26, 36, 0.18);
}
#${MENU_ID}[hidden] { display: none; }
#${MENU_ID} button {
    width: 100%;
    padding: 9px 11px;
    display: block;
    font: inherit;
    font-size: 13px;
    text-align: left;
    color: var(--text-main, #1b1f27);
    background: none;
    border: 0;
    border-radius: 5px;
    cursor: pointer;
}
#${MENU_ID} button:hover,
#${MENU_ID} button:focus-visible {
    background: #f2f4f7;
    outline: none;
}
#${MENU_ID} button[disabled] { opacity: 0.5; cursor: default; }
#${MENU_ID} .menu-separator {
    height: 1px;
    margin: 5px 3px;
    background: var(--border);
}
.notice-admin-toast {
    position: fixed;
    left: 50%;
    bottom: 28px;
    z-index: 950;
    max-width: min(420px, calc(100vw - 32px));
    padding: 12px 16px;
    font-size: 13px;
    line-height: 1.5;
    color: #fff;
    background: #23282f;
    border-radius: 8px;
    box-shadow: 0 10px 30px rgba(20, 26, 36, 0.28);
    transform: translateX(-50%);
}
.notice-admin-toast.is-error { background: var(--danger, #c0392b); }
.notice-admin-toast a { color: #9ec5ff; }
@media (prefers-reduced-motion: no-preference) {
    .notice-admin-toast { animation: notice-admin-toast-in 0.18s ease; }
    @keyframes notice-admin-toast-in {
        from { opacity: 0; transform: translate(-50%, 8px); }
        to { opacity: 1; transform: translate(-50%, 0); }
    }
}
`;
        document.head.appendChild(style);
    }

    // ========================================
    // 토스트
    // ========================================

    let toastTimer = null;

    function showToast(html, { isError = false, duration = 5000 } = {}) {
        document.querySelector('.notice-admin-toast')?.remove();
        if (toastTimer) clearTimeout(toastTimer);

        const toast = document.createElement('div');
        toast.className = `notice-admin-toast${isError ? ' is-error' : ''}`;
        toast.setAttribute('role', 'status');
        toast.innerHTML = html;
        document.body.appendChild(toast);
        toastTimer = setTimeout(() => toast.remove(), duration);
    }

    // ========================================
    // 메뉴
    // ========================================

    /* 드롭다운은 카드마다 만들지 않고 문서에 하나만 둔다. 카드 20개에 드롭다운
       20개는 낭비이고, 그리드의 overflow 안에서 잘린다. 열 때 트리거 위치를 재서
       화면 좌표에 띄운다. */
    function getMenuElement() {
        let menu = document.getElementById(MENU_ID);
        if (menu) return menu;

        menu = document.createElement('div');
        menu.id = MENU_ID;
        menu.setAttribute('role', 'menu');
        menu.hidden = true;
        document.body.appendChild(menu);

        menu.addEventListener('keydown', event => {
            const items = [...menu.querySelectorAll('button:not([disabled])')];
            const index = items.indexOf(document.activeElement);
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                items[(index + 1) % items.length]?.focus();
            } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                items[(index - 1 + items.length) % items.length]?.focus();
            } else if (event.key === 'Escape') {
                event.preventDefault();
                closeMenu({ restoreFocus: true });
            }
        });

        document.addEventListener('click', event => {
            if (menu.hidden) return;
            if (menu.contains(event.target) || openTrigger?.contains(event.target)) return;
            closeMenu();
        });
        window.addEventListener('scroll', () => closeMenu(), true);
        window.addEventListener('resize', () => closeMenu());

        return menu;
    }

    function closeMenu({ restoreFocus = false } = {}) {
        const menu = document.getElementById(MENU_ID);
        if (!menu || menu.hidden) return;
        menu.hidden = true;
        if (openTrigger) {
            openTrigger.setAttribute('aria-expanded', 'false');
            openTrigger.closest('.card-admin-controls')?.classList.remove('is-open');
            if (restoreFocus) openTrigger.focus();
        }
        openTrigger = null;
    }

    function openMenu(trigger, notice) {
        const menu = getMenuElement();
        closeMenu();

        const pinned = window.isNoticePinnedNow?.(notice) === true;
        const items = [
            { label: '알림 주기', action: () => sendReminder(notice) },
            {
                label: pinned ? '고정 해제' : '공지 상단으로 보내기',
                action: () => setPinned(notice, !pinned)
            },
            { separator: true },
            { label: '수정', action: () => editNotice(notice) },
            { label: '숨김', action: () => hideNotice(notice) }
        ];

        menu.innerHTML = '';
        for (const item of items) {
            if (item.separator) {
                const line = document.createElement('div');
                line.className = 'menu-separator';
                menu.appendChild(line);
                continue;
            }
            const button = document.createElement('button');
            button.type = 'button';
            button.setAttribute('role', 'menuitem');
            button.textContent = item.label;
            button.addEventListener('click', () => {
                closeMenu();
                item.action();
            });
            menu.appendChild(button);
        }

        menu.hidden = false;
        positionMenu(menu, trigger);

        openTrigger = trigger;
        trigger.setAttribute('aria-expanded', 'true');
        trigger.closest('.card-admin-controls')?.classList.add('is-open');
        menu.querySelector('button')?.focus();
    }

    /* 뷰포트 아래쪽 카드에서는 메뉴가 화면 밖으로 나간다. 아래 공간이 모자라면
       트리거 위로 편다. 오른쪽도 마찬가지로 화면 안쪽으로 당긴다. */
    function positionMenu(menu, trigger) {
        const anchor = trigger.getBoundingClientRect();
        const size = menu.getBoundingClientRect();
        const gap = 6;

        let top = anchor.bottom + gap;
        if (top + size.height > window.innerHeight - 8) {
            top = Math.max(8, anchor.top - size.height - gap);
        }
        let left = anchor.right - size.width;
        left = Math.max(8, Math.min(left, window.innerWidth - size.width - 8));

        menu.style.top = `${top}px`;
        menu.style.left = `${left}px`;
    }

    // ========================================
    // 동작
    // ========================================

    function noticeLabel(notice) {
        const title = String(notice.title || '제목 없음');
        return title.length > 40 ? `${title.slice(0, 40)}…` : title;
    }

    /* 되돌릴 수 없고 사람들의 휴대폰이 울린다. 메뉴 항목 중 여기에만 확인을 건다. */
    async function sendReminder(notice) {
        const confirmed = confirm(
            `"${noticeLabel(notice)}" 공지 알림을 다시 보낼까요?\n`
            + '학번과 카테고리가 맞는 구독자에게 발송됩니다.'
        );
        if (!confirmed) return;

        try {
            const result = await apiRequest(
                `/api/notices/${encodeURIComponent(notice.id)}/reminder`,
                { method: 'POST', headers: getNoticeAdminHeaders() }
            );
            const count = Number(result?.recipients) || 0;
            showToast(count > 0
                ? `구독자 ${count}명에게 리마인드를 보냅니다.`
                : '리마인드를 등록했지만 지금 조건에 맞는 구독자가 없습니다.');
        } catch (error) {
            showToast(escapeHtml(error.message || '리마인드를 보내지 못했습니다.'), { isError: true });
        }
    }

    async function setPinned(notice, pinned) {
        try {
            await apiRequest(`/api/notices/${encodeURIComponent(notice.id)}/pin`, {
                method: 'PATCH',
                headers: getNoticeAdminHeaders(),
                body: JSON.stringify({ pinned })
            });
            showToast(pinned
                ? '목록 맨 위로 올렸습니다. 마감일이나 7일 뒤 중 빠른 쪽에 자동으로 풀립니다.'
                : '고정을 해제했습니다.');
            // 순서가 바뀌므로 서버에서 목록을 다시 받는다. 정렬 규칙이 서버에
            // 있어서 클라이언트가 재현하면 두 벌이 된다.
            await filterCards();
        } catch (error) {
            showToast(escapeHtml(error.message || '고정을 바꾸지 못했습니다.'), { isError: true });
        }
    }

    function editNotice(notice) {
        // admin.js가 이미 읽는 딥링크다. 새 경로가 아니다.
        window.location.assign(`/admin/workspace?edit=${encodeURIComponent(notice.id)}`);
    }

    async function hideNotice(notice) {
        try {
            await apiRequest(`/api/notices/${encodeURIComponent(notice.id)}/visibility`, {
                method: 'PATCH',
                headers: getNoticeAdminHeaders(),
                body: JSON.stringify({ hidden: true })
            });
            // 숨기면 공개 목록에서 사라져 이 화면으로는 되돌릴 수 없다.
            showToast(
                '공개 목록에서 숨겼습니다. '
                + '<a href="/admin/workspace">관리자 화면</a>에서 되돌릴 수 있습니다.',
                { duration: 8000 }
            );
            await filterCards();
        } catch (error) {
            showToast(escapeHtml(error.message || '숨기지 못했습니다.'), { isError: true });
        }
    }

    // ========================================
    // 등록
    // ========================================

    function decorate(card, notice) {
        const controls = document.createElement('div');
        controls.className = 'card-admin-controls';

        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'card-admin-menu-trigger';
        trigger.setAttribute('aria-haspopup', 'menu');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.setAttribute('aria-label', `${notice.title || '공지'} 관리 메뉴`);
        trigger.innerHTML = '<svg width="4" height="16" viewBox="0 0 4 16" aria-hidden="true">'
            + '<g fill="currentColor"><circle cx="2" cy="3" r="1.5"/>'
            + '<circle cx="2" cy="8" r="1.5"/><circle cx="2" cy="13" r="1.5"/></g></svg>';

        // 카드 전체에 상세를 여는 onclick이 걸려 있다.
        trigger.addEventListener('click', event => {
            event.stopPropagation();
            event.preventDefault();
            if (openTrigger === trigger) {
                closeMenu({ restoreFocus: true });
                return;
            }
            openMenu(trigger, notice);
        });

        controls.appendChild(trigger);
        card.appendChild(controls);
    }

    injectStyles();
    registerNoticeCardExtension({ decorate });
})();
