import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

// css/core.css의 --rail-bg. 워드마크 반전판이 얹히도록 그려진 레일 색이라
// 같은 값을 써야 글자 주변에 테두리처럼 뜨는 자리가 없다.
// iOS는 투명 픽셀을 검게 칠하므로 아이콘 배경은 반드시 불투명해야 한다.
const BRAND_NAVY = '#1f3f8f';
// 아이콘 캔버스는 512 좌표계로 그리고 출력 크기만 바꾼다.
const CANVAS = 512;
// 라운드 사각형 반경. 홈 화면 스쿼클 마스크와 어긋나지 않는 22% 선이다.
const CORNER_RADIUS = 112;
// 워드마크가 캔버스에서 차지하는 가로 비율. 좌우 10%씩 여백이 남는다.
const WORDMARK_WIDTH_RATIO = 0.8;
// SVG에 박아 넣을 워드마크의 가로 픽셀. 가장 큰 출력(1024)에서 등배가 되는 크기다.
const EMBED_WIDTH = 820;
// maskable 안전 영역: 글리프를 캔버스의 약 80%로 줄여 원형·스쿼클 마스킹에도 잘리지 않게 한다.
const MASKABLE_GLYPH_SIZE = 410;
// App Store에 올리는 iOS 마케팅 아이콘 크기.
const IOS_ICON_SIZE = 1024;
// 512 좌표계를 1024로 렌더링하기 위한 밀도(기본 72dpi의 두 배).
// 큰 쪽을 먼저 그리고 줄여야 작은 아이콘의 글자 획이 뭉개지지 않는다.
const RENDER_DENSITY = 144;

// 워드마크는 래스터 원본뿐이라 아이콘 SVG에 base64로 박아 넣는다.
// 이렇게 해두면 favicon(app-icon.svg)과 PWA·iOS 래스터가 한 파일에서 갈라져 나온다.
async function buildAppIconSvg(iconsDir) {
    // 투명 여백을 먼저 잘라내야 글리프가 캔버스 중앙에 광학적으로 맞는다.
    const wordmark = await sharp(path.join(iconsDir, 'brand-wordmark-light.png'))
        .trim({ threshold: 1 })
        .resize({ width: EMBED_WIDTH })
        // favicon으로도 쓰이는 파일이라 팔레트로 양자화해 base64 부피를 줄인다.
        // 흰색·금색 두 계열뿐이라 256색으로도 눈에 띄는 손실이 없다.
        .png({ compressionLevel: 9, palette: true, quality: 90, colors: 255 })
        .toBuffer();

    const { width, height } = await sharp(wordmark).metadata();
    const drawWidth = CANVAS * WORDMARK_WIDTH_RATIO;
    const drawHeight = (drawWidth * height) / width;
    const x = (CANVAS - drawWidth) / 2;
    const y = (CANVAS - drawHeight) / 2;
    const href = `data:image/png;base64,${wordmark.toString('base64')}`;

    // base64가 파일 부피의 거의 전부라 href는 한 번만 적는다.
    // xlink:href를 함께 적으면 같은 데이터가 두 벌 들어가 파일이 두 배가 된다.
    return Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg"`
        + ` viewBox="0 0 ${CANVAS} ${CANVAS}" role="img" aria-label="SNU ECE 공지방">\n`
        + `  <rect width="${CANVAS}" height="${CANVAS}" rx="${CORNER_RADIUS}" fill="${BRAND_NAVY}"/>\n`
        + `  <image x="${x.toFixed(2)}" y="${y.toFixed(2)}"`
        + ` width="${drawWidth.toFixed(2)}" height="${drawHeight.toFixed(2)}"`
        + ` href="${href}"/>\n`
        + `</svg>\n`
    );
}

async function exists(target) {
    try {
        await access(target);
        return true;
    } catch {
        return false;
    }
}

export async function generateIcons({ rootDir }) {
    const iconsDir = path.join(rootDir, 'icons');
    const badgeIcon = path.join(iconsDir, 'badge-icon.svg');

    // 아이콘 SVG 자체가 브랜드 워드마크에서 만들어지는 산출물이다.
    const appIcon = await buildAppIconSvg(iconsDir);
    await writeFile(path.join(iconsDir, 'app-icon.svg'), appIcon);

    const render = () => sharp(appIcon, { density: RENDER_DENSITY });

    // Android는 알림 icon·설치 아이콘으로 SVG를 읽지 못하므로 래스터 사본이 필요하다.
    await render().resize(192, 192).png().toFile(path.join(iconsDir, 'app-icon-192.png'));
    await render().resize(512, 512).png().toFile(path.join(iconsDir, 'app-icon-512.png'));

    await render()
        .resize(180, 180)
        .flatten({ background: BRAND_NAVY })
        .png()
        .toFile(path.join(iconsDir, 'apple-touch-icon.png'));

    const glyph = await render()
        .resize(MASKABLE_GLYPH_SIZE, MASKABLE_GLYPH_SIZE)
        .png()
        .toBuffer();
    await sharp({ create: { width: 512, height: 512, channels: 3, background: BRAND_NAVY } })
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

    // iOS 앱 아이콘. 알파 채널이 남아 있으면 App Store Connect가 업로드를 거부한다.
    const appIconSet = path.join(
        rootDir, 'ios', 'SNUECENotice', 'Resources', 'Assets.xcassets', 'AppIcon.appiconset'
    );
    if (await exists(appIconSet)) {
        await render()
            .resize(IOS_ICON_SIZE, IOS_ICON_SIZE)
            .flatten({ background: BRAND_NAVY })
            .png({ compressionLevel: 9 })
            .toFile(path.join(appIconSet, 'app-icon-1024.png'));
    }
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
    await generateIcons({ rootDir: path.resolve(path.dirname(scriptPath), '..') });
}
