import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

// css/core.css의 --primary. iOS는 투명 픽셀을 검게 칠하므로 불투명 배경이 필요하다.
const BRAND_NAVY = '#1f3f8f';
// app-icon.svg 라운드 사각형의 채움색. maskable 배경을 같은 색으로 깔아야 이음새가 없다.
const ICON_NAVY = '#1e3a8a';
// maskable 안전 영역: 글리프를 캔버스의 약 80%로 줄여 원형·스쿼클 마스킹에도 잘리지 않게 한다.
const MASKABLE_GLYPH_SIZE = 410;

export async function generateIcons({ rootDir }) {
    const iconsDir = path.join(rootDir, 'icons');
    const appIcon = path.join(iconsDir, 'app-icon.svg');
    const badgeIcon = path.join(iconsDir, 'badge-icon.svg');

    // Android는 알림 icon·설치 아이콘으로 SVG를 읽지 못하므로 래스터 사본이 필요하다.
    await sharp(appIcon).resize(192, 192).png().toFile(path.join(iconsDir, 'app-icon-192.png'));
    await sharp(appIcon).resize(512, 512).png().toFile(path.join(iconsDir, 'app-icon-512.png'));

    await sharp(appIcon)
        .resize(180, 180)
        .flatten({ background: BRAND_NAVY })
        .png()
        .toFile(path.join(iconsDir, 'apple-touch-icon.png'));

    const glyph = await sharp(appIcon)
        .resize(MASKABLE_GLYPH_SIZE, MASKABLE_GLYPH_SIZE)
        .png()
        .toBuffer();
    await sharp({ create: { width: 512, height: 512, channels: 3, background: ICON_NAVY } })
        .composite([{ input: glyph, gravity: 'centre' }])
        .png()
        .toFile(path.join(iconsDir, 'app-icon-maskable-512.png'));

    // Android 알림 badge는 알파 채널만 마스크로 쓰고 색은 시스템이 입힌다.
    // 다색 원본을 그대로 내보내면 흐릿한 회색 덩어리로 보이므로,
    // 불투명 픽셀을 전부 흰색으로 바꾼 단색 실루엣을 만든다.
    const badgeAlpha = await sharp(badgeIcon)
        .resize(96, 96)
        .ensureAlpha()
        .extractChannel('alpha')
        .toBuffer();
    await sharp({ create: { width: 96, height: 96, channels: 3, background: '#ffffff' } })
        .joinChannel(badgeAlpha)
        .png()
        .toFile(path.join(iconsDir, 'badge-icon-96.png'));
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
    await generateIcons({ rootDir: path.resolve(path.dirname(scriptPath), '..') });
}
