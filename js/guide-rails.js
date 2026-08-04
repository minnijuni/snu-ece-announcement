(() => {
    const left = document.getElementById('guide-left-rail');
    const right = document.getElementById('guide-right-rail');
    if (!left || !right) return;
    const apiBase = (typeof window.API_BASE_URL === 'string' ? window.API_BASE_URL : '').trim().replace(/\/$/, '');
    const guideApiUrl = path => apiBase ? `${apiBase}${path}` : path;

    left.innerHTML = `
        <a class="brand-logo-btn" href="./index.html" aria-label="SNU ECE 공지방 홈">
            <img class="brand-logo-img" src="./icons/snu-emblem.png" alt="서울대학교">
        </a>
        <p class="brand-university-name">서울대학교</p>
        <img class="brand-wordmark" src="./icons/brand-wordmark-light.png" alt="SNU ECE 공지방">
        <p class="rail-section-label">관련 페이지</p>
        <nav class="brand-links">
            <a href="./service-guide.html">서비스 안내</a>
            <a href="https://www.snu.ac.kr/" target="_blank" rel="noopener noreferrer">서울대학교 홈페이지</a>
            <a href="https://ece.snu.ac.kr/" target="_blank" rel="noopener noreferrer">전기·정보공학부</a>
            <a href="https://my.snu.ac.kr/" target="_blank" rel="noopener noreferrer">mySNU</a>
        </nav>
        <p class="rail-section-label">문의</p>
        <nav class="brand-links inquiry-links">
            <a href="./index.html#contact-modal">일반 문의하기</a>
            <a href="./banner-inquiry.html">홍보 신청하기</a>
        </nav>
        <time class="rail-clock"><strong id="guide-clock-time">--:--:--</strong><span id="guide-clock-date"></span></time>`;
    right.innerHTML = '<div id="right-rail-ad-content"><span class="guide-banner-loading">배너를 불러오는 중입니다.</span></div>';

    const esc = value => String(value || '').replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
    let active = 0;
    let slides = [];
    function draw() {
        if (!slides.length) {
            right.querySelector('#right-rail-ad-content').innerHTML = '<a class="rail-cta rail-ad-fallback" href="./banner-inquiry.html">홍보 신청하기</a>';
            return;
        }
        const slide = slides[active];
        const image = `<img class="rail-ad-image" src="${esc(slide.src)}" alt="${esc(slide.altText || slide.name || '학내 홍보 이미지')}">`;
        const body = slide.linkUrl ? `<a class="rail-ad-link rail-ad-image-link" href="${esc(slide.linkUrl)}" target="_blank" rel="noopener noreferrer">${image}</a>` : image;
        right.querySelector('#right-rail-ad-content').innerHTML = `<div class="rail-ad-viewport"><div class="rail-ad-stage"><div class="rail-ad-track"><div class="rail-ad-slide">${body}</div></div>${slides.length > 1 ? `<div class="rail-ad-controls"><button class="rail-ad-arrow is-prev" type="button" data-step="-1" aria-label="이전 배너">‹</button><button class="rail-ad-arrow is-next" type="button" data-step="1" aria-label="다음 배너">›</button></div><div class="rail-ad-status"><div class="rail-ad-dots">${slides.map((_, index) => `<button class="rail-ad-dot${index === active ? ' is-active' : ''}" data-index="${index}" aria-label="${index + 1}번째 배너"></button>`).join('')}</div><span class="rail-ad-count">${active + 1} / ${slides.length}</span></div>` : ''}</div></div>`;
        right.querySelectorAll('[data-step]').forEach(button => button.onclick = () => { active = (active + Number(button.dataset.step) + slides.length) % slides.length; draw(); });
        right.querySelectorAll('[data-index]').forEach(button => button.onclick = () => { active = Number(button.dataset.index); draw(); });
    }
    fetch(guideApiUrl('/api/banner-slides')).then(response => response.ok ? response.json() : Promise.reject()).then(data => {
        slides = (data.slides || []).filter(slide => slide.src).slice(0, 5);
        draw();
        if (slides.length > 1) window.setInterval(() => { active = (active + 1) % slides.length; draw(); }, 6500);
    }).catch(draw);

    function updateClock() {
        const now = new Date();
        document.getElementById('guide-clock-time').textContent = now.toLocaleTimeString('ko-KR', { hour12: false });
        document.getElementById('guide-clock-date').textContent = now.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
    }
    updateClock();
    window.setInterval(updateClock, 1000);
})();
