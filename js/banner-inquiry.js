const bannerInquiryForm = document.getElementById('banner-inquiry-form');
const bannerInquiryStatus = document.getElementById('banner-inquiry-status');
const bannerInquirySubmit = document.getElementById('banner-inquiry-submit');
const bannerInquiryApiBase = (
    typeof window.API_BASE_URL === 'string' ? window.API_BASE_URL : ''
).trim().replace(/\/$/, '');
const bannerImageFields = {
    desktop: {
        input: document.getElementById('inquiry-desktop-image'),
        preview: document.getElementById('inquiry-desktop-image-preview'),
        image: document.getElementById('inquiry-desktop-image-preview-img'),
        name: document.getElementById('inquiry-desktop-image-name'),
        meta: document.getElementById('inquiry-desktop-image-meta'),
        // 오른쪽 레일은 폭 240px에 화면 높이만큼 길다. 이 비율이라야 꽉 찬다.
        ratio: 720 / 2400,
        formatLabel: '세로 3:10 (720×2400px)',
        prepared: ''
    },
    mobile: {
        input: document.getElementById('inquiry-mobile-image'),
        preview: document.getElementById('inquiry-mobile-image-preview'),
        image: document.getElementById('inquiry-mobile-image-preview-img'),
        name: document.getElementById('inquiry-mobile-image-name'),
        meta: document.getElementById('inquiry-mobile-image-meta'),
        ratio: 1200 / 675,
        formatLabel: '가로 16:9 (1200×675px)',
        prepared: ''
    }
};

function setBannerInquiryStatus(message, isError = false) {
    bannerInquiryStatus.textContent = message;
    bannerInquiryStatus.classList.toggle('error', isError);
}

function formatBytes(bytes) {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function readImageDimensions(dataUrl) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = dataUrl;
    });
}

function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

async function prepareImage(file) {
    const source = await fileToDataUrl(file);
    const image = await readImageDimensions(source);
    const maxSide = 1600;
    let scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    let dataUrl = '';
    for (let attempt = 0; attempt < 4; attempt += 1) {
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        dataUrl = canvas.toDataURL('image/jpeg', Math.max(0.64, 0.84 - attempt * 0.07));
        if (dataUrl.length <= 1_800_000) break;
        scale *= 0.82;
    }
    if (dataUrl.length > 1_800_000) throw new Error('compressed-image-too-large');
    return {
        dataUrl,
        width: image.naturalWidth,
        height: image.naturalHeight
    };
}

async function handleBannerImageChange(kind) {
    const field = bannerImageFields[kind];
    const file = field.input.files?.[0];
    field.prepared = '';
    field.preview.hidden = true;
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
        setBannerInquiryStatus('PNG, JPG 또는 WEBP 이미지만 제출할 수 있습니다.', true);
        field.input.value = '';
        return;
    }
    if (file.size > 5 * 1024 * 1024) {
        setBannerInquiryStatus('이미지 원본은 5MB 이하로 선택해주세요.', true);
        field.input.value = '';
        return;
    }
    try {
        setBannerInquiryStatus('이미지 미리보기를 준비하고 있습니다.');
        const prepared = await prepareImage(file);
        field.prepared = prepared.dataUrl;
        field.image.src = prepared.dataUrl;
        field.name.textContent = file.name;
        field.meta.textContent =
            `${prepared.width} × ${prepared.height}px · ${formatBytes(file.size)}`;
        field.preview.hidden = false;

        /* 비율이 어긋난 사진은 화면에서 잘리거나 여백이 생긴다. 제출하고 나서
           돌려받으면 다시 만들어 오는 수고가 크므로 고르는 자리에서 알린다.
           막지는 않는다. 의도한 비율일 수도 있고, 판단은 검토 때 한다. */
        const off = Math.abs(prepared.width / prepared.height - field.ratio) / field.ratio;
        setBannerInquiryStatus(off > 0.1
            ? `권장 비율(${field.formatLabel})과 달라 게재하면 가장자리가 잘립니다. 비율을 맞춰 다시 만들어 주세요.`
            : '');
    } catch {
        field.input.value = '';
        setBannerInquiryStatus('이미지를 읽지 못했습니다. 다른 파일을 선택해주세요.', true);
    }
}

function resetBannerImage(kind) {
    const field = bannerImageFields[kind];
    field.input.value = '';
    field.prepared = '';
    field.preview.hidden = true;
    field.input.click();
}

function getBannerInquiryPayload() {
    return {
        name: document.getElementById('inquiry-name').value.trim(),
        organization: document.getElementById('inquiry-organization').value.trim(),
        type: document.getElementById('inquiry-type').value,
        phone: document.getElementById('inquiry-phone').value.trim(),
        email: document.getElementById('inquiry-email').value.trim(),
        title: document.getElementById('inquiry-title').value.trim(),
        description: document.getElementById('inquiry-description').value.trim(),
        linkUrl: document.getElementById('inquiry-link').value.trim(),
        startDate: document.getElementById('inquiry-start').value,
        endDate: document.getElementById('inquiry-end').value,
        desktopImageDataUrl: bannerImageFields.desktop.prepared,
        mobileImageDataUrl: bannerImageFields.mobile.prepared,
        consent: document.getElementById('inquiry-consent').checked
    };
}

function validateBannerInquiry(payload) {
    if (payload.name.length < 2 || payload.organization.length < 2) {
        return '실명과 소속/단체명을 각각 2자 이상 입력해주세요.';
    }
    if (!payload.phone && !payload.email) return '전화번호 또는 이메일 중 하나를 입력해주세요.';
    if (payload.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) return '이메일 주소를 확인해주세요.';
    if (!['club', 'project', 'council', 'survey', 'etc'].includes(payload.type)) return '홍보 유형을 선택해주세요.';
    if (payload.title.length < 2 || payload.description.length < 10) return '홍보 제목과 10자 이상의 설명을 입력해주세요.';
    if (payload.linkUrl && !/^https?:\/\//i.test(payload.linkUrl)) return '연결 링크는 http:// 또는 https://로 시작해야 합니다.';
    if (!payload.startDate || !payload.endDate) return '희망 게재 시작일과 종료일을 선택해주세요.';
    if (payload.endDate < payload.startDate) return '종료일은 시작일보다 빠를 수 없습니다.';
    const startAt = Date.parse(`${payload.startDate}T00:00:00Z`);
    const endAt = Date.parse(`${payload.endDate}T00:00:00Z`);
    const exposureDays = Math.floor((endAt - startAt) / 86_400_000) + 1;
    if (!Number.isFinite(exposureDays) || exposureDays > 14) {
        return '게재 기간은 시작일과 종료일을 포함해 최대 14일까지 선택할 수 있습니다.';
    }
    if (!payload.desktopImageDataUrl) return '데스크탑 홍보 이미지를 선택해주세요.';
    if (!payload.mobileImageDataUrl) return '모바일 홍보 이미지를 선택해주세요.';
    if (!payload.consent) return '개인정보 수집 및 이용에 동의해주세요.';
    return '';
}

async function submitBannerInquiry(event) {
    event.preventDefault();
    const payload = getBannerInquiryPayload();
    const validationError = validateBannerInquiry(payload);
    if (validationError) {
        setBannerInquiryStatus(validationError, true);
        return;
    }

    bannerInquirySubmit.disabled = true;
    setBannerInquiryStatus('학내 홍보 신청을 제출하고 있습니다.');
    try {
        const response = await fetch(`${bannerInquiryApiBase}/api/banner-inquiries`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/vnd.ece-banner+json' },
            body: JSON.stringify(payload)
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || '학내 홍보 신청을 제출하지 못했습니다.');
        bannerInquiryForm.reset();
        Object.values(bannerImageFields).forEach(field => {
            field.prepared = '';
            field.preview.hidden = true;
        });
        setBannerInquiryStatus('접수가 완료되었습니다. 담당자가 확인 후 입력하신 연락처로 회신합니다.');
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    } catch (error) {
        // fetch가 회선 단계에서 끊기면 'Failed to fetch' 같은 영어 원문이 올라온다.
        const isNetworkError = error instanceof TypeError;
        setBannerInquiryStatus(isNetworkError
            ? '네트워크 연결을 확인한 뒤 다시 시도해주세요.'
            : (error.message || '잠시 후 다시 시도해주세요.'), true);
    } finally {
        bannerInquirySubmit.disabled = false;
    }
}

bannerImageFields.desktop.input.addEventListener('change', () => handleBannerImageChange('desktop'));
bannerImageFields.mobile.input.addEventListener('change', () => handleBannerImageChange('mobile'));
document.getElementById('inquiry-desktop-image-remove').addEventListener('click', () => resetBannerImage('desktop'));
document.getElementById('inquiry-mobile-image-remove').addEventListener('click', () => resetBannerImage('mobile'));
bannerInquiryForm.addEventListener('submit', submitBannerInquiry);
