// web-push는 공개키 65바이트·비밀키 32바이트가 아니면 setVapidDetails에서 예외를
// 던진다. 자리표시 값 하나로 서버 전체가 부팅에 실패하지 않도록 여기서 미리 거른다.
function isValidVapidKey(value, expectedBytes) {
    if (!value) return false;
    try {
        return Buffer.from(value, 'base64url').length === expectedBytes;
    } catch {
        return false;
    }
}

export function getAutomationConfig(env = process.env) {
    const crawlSecret = String(env.CRAWL_TRIGGER_SECRET || '');
    const vapidPublicKey = String(env.VAPID_PUBLIC_KEY || '');
    const vapidPrivateKey = String(env.VAPID_PRIVATE_KEY || '');
    const vapidSubject = String(env.VAPID_SUBJECT || '');

    let pushEnabled = Boolean(vapidPublicKey && vapidPrivateKey && vapidSubject);
    if (pushEnabled) {
        const invalidVapidKeys = [
            !isValidVapidKey(vapidPublicKey, 65) && 'VAPID_PUBLIC_KEY',
            !isValidVapidKey(vapidPrivateKey, 32) && 'VAPID_PRIVATE_KEY'
        ].filter(Boolean);
        if (invalidVapidKeys.length > 0) {
            console.warn(
                `VAPID 키 형식이 올바르지 않아 웹 푸시를 비활성화합니다: ${invalidVapidKeys.join(', ')}`
            );
            pushEnabled = false;
        }
    }

    return Object.freeze({
        crawl: Object.freeze({
            enabled: crawlSecret.length >= 32,
            secret: crawlSecret,
            baseUrl: 'https://ece.snu.ac.kr/community/academics',
            pages: 3,
            maxDetails: 20,
            requestDelayMs: 1000,
            timeoutMs: 10000
        }),
        push: Object.freeze({
            enabled: pushEnabled,
            publicKey: vapidPublicKey,
            privateKey: vapidPrivateKey,
            subject: vapidSubject
        }),
        categories: Object.freeze({
            windowDays: 60,
            minimumNotices: 5,
            minimumConfidence: 0.75
        })
    });
}
