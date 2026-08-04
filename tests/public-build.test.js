import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import sharp from 'sharp';
import { preparePublic } from '../scripts/prepare-public.mjs';

function readNamedFunction(source, name) {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} must exist`);
    const bodyStart = source.indexOf('{', start);
    let depth = 0;
    for (let index = bodyStart; index < source.length; index += 1) {
        if (source[index] === '{') depth += 1;
        if (source[index] === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(start, index + 1);
        }
    }
    assert.fail(`${name} must have a complete body`);
}

test('preparePublic copies canonical frontend files', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'ece-public-'));
    await mkdir(path.join(rootDir, 'css'));
    await mkdir(path.join(rootDir, 'js'));
    await writeFile(path.join(rootDir, 'index.html'), '<main>ok</main>');
    await writeFile(path.join(rootDir, 'admin.html'), '<main>admin</main>');
    await writeFile(path.join(rootDir, 'admin-login.html'), '<main>admin login</main>');
    await writeFile(path.join(rootDir, 'banner-inquiry.html'), '<main>banner inquiry</main>');
    await writeFile(path.join(rootDir, 'css/core.css'), 'body{}');
    await writeFile(path.join(rootDir, 'css/mobile.css'), '.grid{}');
    await writeFile(path.join(rootDir, 'js/core.js'), 'window.ok=true');
    await writeFile(path.join(rootDir, 'js/mobile.js'), 'window.mobile=true');
    await writeFile(path.join(rootDir, 'js/config.js'), 'window.API_BASE_URL=""');

    await preparePublic({ rootDir });

    assert.equal(
        await readFile(path.join(rootDir, 'public/index.html'), 'utf8'),
        '<main>ok</main>'
    );
    assert.equal(
        await readFile(path.join(rootDir, 'public/admin.html'), 'utf8'),
        '<main>admin</main>'
    );
    assert.equal(
        await readFile(path.join(rootDir, 'public/admin-login.html'), 'utf8'),
        '<main>admin login</main>'
    );
    assert.equal(
        await readFile(path.join(rootDir, 'public/banner-inquiry.html'), 'utf8'),
        '<main>banner inquiry</main>'
    );
    assert.equal(
        await readFile(path.join(rootDir, 'public/js/core.js'), 'utf8'),
        'window.ok=true'
    );
    // 뷰별로 나뉜 파일이 하나라도 빠지면 그 모드가 통째로 죽는다.
    assert.equal(
        await readFile(path.join(rootDir, 'public/js/mobile.js'), 'utf8'),
        'window.mobile=true'
    );
    assert.equal(
        await readFile(path.join(rootDir, 'public/css/mobile.css'), 'utf8'),
        '.grid{}'
    );
});

test('default notice thumbnail is a square PNG copied byte-for-byte', async () => {
    const canonical = await readFile('icons/default-notice-thumbnail.png');
    const generated = await readFile('public/icons/default-notice-thumbnail.png');
    const metadata = await sharp(canonical).metadata();

    assert.equal(metadata.format, 'png');
    assert.equal(metadata.width, 1024);
    assert.equal(metadata.height, 1024);
    assert.deepEqual(generated, canonical);
});

test('administrator surfaces live on admin.html, not the public page', async () => {
    const html = await readFile('admin.html', 'utf8');
    const publicHtml = await readFile('index.html', 'utf8');

    for (const id of [
        'review-notice-list',
        'review-editor',
        'review-pending-count',
        'panel-compose',
        'right-rail-slides-list'
    ]) {
        assert.match(html, new RegExp(`id="${id}"`));
    }
    assert.match(html, /aria-live="polite"/);
    assert.match(html, /<script src="\/js\/admin\.js"><\/script>/);

    // 공개 화면에는 관리자 UI도, 관리자 스크립트도 실려서는 안 된다.
    for (const leaked of [
        'review-notice-list',
        'category-candidate-list',
        'post-content',
        'admin.js'
    ]) {
        assert.doesNotMatch(publicHtml, new RegExp(leaked.replace('.', '\\.')));
    }
    assert.match(publicHtml, /href="\.\/admin-login\.html" rel="nofollow">관리자 로그인</);
    assert.doesNotMatch(publicHtml, /href="[^"]*admin\.html|\/admin\/workspace/);
});

test('public shell exposes brand and managed advertising rails', async () => {
    const html = await readFile('index.html', 'utf8');
    const app = await readFile('js/core.js', 'utf8');

    for (const id of [
        'left-brand-rail',
        'right-ad-rail',
        'right-rail-ad-content',
        'page-main'
    ]) {
        assert.match(html, new RegExp(`id="${id}"`));
    }
    // 엠블럼이 없을 때 대체 워드마크는 '서울대학교'.
    assert.match(html, /class="brand-mark"[^>]*>SNU</);
    assert.match(html, />서울대학교 홈페이지</);
    assert.match(html, />전기정보공학부</);
    assert.match(html, />mySNU</);
    assert.match(app, /function getBannerSlidesByPlacement/);
    assert.match(app, /function renderRightRailAd/);
    assert.match(app, /getBannerSlidesByPlacement\('right_rail'\)/);
});

test('desktop rails stay pinned to the viewport while the page scrolls', async () => {
    const css = await readFile('css/desktop.css', 'utf8');

    // sticky는 부모 안에서만 붙어 있어 스크롤을 따라 올라간다. fixed여야 한다.
    assert.match(
        css,
        /html\[data-view="desktop"\] \.site-rail\s*\{[^}]*position:\s*fixed[^}]*top:\s*0[^}]*bottom:\s*0/s
    );
    assert.match(css, /html\[data-view="desktop"\] \.rail-left\s*\{[^}]*left:\s*0/s);
    assert.match(css, /html\[data-view="desktop"\] \.rail-right\s*\{[^}]*right:\s*0/s);
    // 고정된 레일이 본문을 덮지 않도록 그 폭만큼 자리를 비워둬야 한다.
    assert.match(
        css,
        /html\[data-view="desktop"\] \.page-shell\s*\{[^}]*padding-left:\s*var\(--rail-width\)[^}]*padding-right:\s*var\(--rail-width\)/s
    );
    assert.doesNotMatch(css, /position:\s*sticky/);
});

test('compact desktop turns the left rail into a drawer and keeps the vertical banner cropped without side gaps', async () => {
    const desktopCss = await readFile('css/desktop.css', 'utf8');
    const desktopJs = await readFile('js/desktop.js', 'utf8');
    const mobileJs = await readFile('js/mobile.js', 'utf8');

    assert.match(desktopCss, /@media \(max-width:\s*1360px\)/);
    assert.match(desktopCss, /\.page-shell\s*\{[^}]*padding-left:\s*0;[^}]*padding-right:\s*var\(--compact-ad-rail-width\)/s);
    assert.match(desktopCss, /\.rail-left\s*\{[^}]*transform:\s*translateX\(-100%\)/s);
    assert.match(desktopCss, /\.rail-left\.drawer-open\s*\{[^}]*translateX\(0\)/s);
    assert.match(desktopCss, /\.rail-right\s*\{[^}]*width:\s*var\(--compact-ad-rail-width\)/s);
    // 좁은 데스크톱에서도 레일을 끝까지 채우되, 배너 원본은 잘라내지 않는다.
    // 남는 자리는 같은 그림을 흐리게 깐 배경 층이 메운다.
    assert.match(desktopCss, /\.rail-ad-image\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*object-fit:\s*contain/s);
    assert.match(mobileJs, /function usesDrawerNavigation\(\)/);
    assert.match(mobileJs, /COMPACT_DESKTOP_DRAWER_QUERY/);
    assert.match(desktopJs, /const COMPACT_DESKTOP_DRAWER_QUERY = '\(max-width: 1360px\)'/);
    assert.match(desktopJs, /event\.key === 'Escape'[\s\S]*closeMobileDrawer\(\)/);
});

test('the public page drops the top banner, the saved-posts feature, and the refresh button', async () => {
    const html = await readFile('index.html', 'utf8');
    const app = await readFile('js/core.js', 'utf8');
    const css = await readFile('css/core.css', 'utf8');

    for (const gone of [
        'header-banner',
        'banner-track',
        'banner-toggle-btn',
        'btn-starred',
        'star-icon',
        'location.reload'
    ]) {
        assert.doesNotMatch(html, new RegExp(gone.replace('.', '\\.')), `${gone} must be gone from index.html`);
        assert.doesNotMatch(app, new RegExp(gone.replace('.', '\\.')), `${gone} must be gone from core.js`);
    }
    assert.doesNotMatch(css, /\.star-icon/);
    assert.doesNotMatch(app, /savedPosts|toggleSave|toggleViewMode/);

    // 제목은 기능 없는 표제이며, 알림 받기만 종 토글로 유지한다.
    // 제목 자리는 워드마크 이미지가 차지하고, 글자는 이미지가 없을 때만 나온다.
    assert.match(html, /<h1 class="site-title" id="site-title">[\s\S]*?id="site-title-mark"[\s\S]*?alt="SNU ECE 공지방"/);
    assert.match(html, /<span class="site-title-text">SNU ECE 공지방<\/span>/);
    assert.doesNotMatch(html, /제목을 누르면 새로고침|site-title-hint|reloadNoticeBoard/);
    // 종은 화면에서 뺐다. 알림은 푸터의 "알림 설정"으로만 연다.
    assert.doesNotMatch(html, /id="bell-toggle"/);
    assert.match(html, />알림 설정</);
    assert.match(html, /onclick="openNotificationPreferences\(\)"/);
    assert.doesNotMatch(app, /function reloadNoticeBoard/);
    assert.match(app, /function updateBellState/);
    assert.doesNotMatch(css, /site-title:hover[\s\S]*text-decoration:\s*underline/);


});

test('layout mode is chosen before first paint and follows the real viewport', async () => {
    const html = await readFile('index.html', 'utf8');
    const app = await readFile('js/core.js', 'utf8');

    // 인라인 부트스트랩이 CSS보다 먼저 data-view를 확정해야 화면이 깜빡이지 않는다.
    const headScriptIndex = html.indexOf("window.matchMedia('(max-width: 820px)')");
    const coreCssIndex = html.indexOf('css/core.css');
    assert.ok(headScriptIndex > 0 && headScriptIndex < coreCssIndex);

    // "모바일 모드" 버튼은 폰 미리보기를 연다(데스크탑 화면은 그대로 둔다).
    assert.match(html, /id="view-mode-toggle"[^>]*onclick="openDevicePreview\(\)"/);
    assert.match(app, /function setLayoutMode/);
    assert.match(app, /function openDevicePreview/);
    assert.match(app, /function initializeResponsiveLayout/);
    assert.match(app, /responsiveLayoutMedia\.addEventListener\('change', apply\)/);
    assert.doesNotMatch(html, /localStorage\.getItem\('eceLayoutMode'\)/);
    assert.doesNotMatch(app, /localStorage\.setItem\('eceLayoutMode'/);
    assert.doesNotMatch(app, /'width=1280'/);
});

test('mobile mode opens a blurred phone preview instead of reflowing the desktop page', async () => {
    const html = await readFile('index.html', 'utf8');
    const css = await readFile('css/core.css', 'utf8');
    const app = await readFile('js/core.js', 'utf8');

    assert.match(html, /id="device-preview"/);
    assert.match(html, /id="device-iframe"/);
    assert.match(app, /function openDevicePreview/);
    assert.match(app, /function closeDevicePreview/);
    // iframe 은 같은 페이지를 모바일로 강제해서 띄운다.
    assert.match(app, /searchParams\.set\('view', 'mobile'\)/);
    assert.match(app, /searchParams\.set\('preview', '1'\)/);
    // 뒤 배경은 흐리게 처리한다.
    assert.match(css, /\.device-preview\s*\{[^}]*backdrop-filter:\s*blur/s);
    assert.match(css, /\.device-frame\s*\{/);
    // display:flex 가 [hidden]을 이기지 못하도록 명시적으로 숨김을 되살려야 한다.
    // (이게 없으면 로드 즉시 빈 폰이 떠서 닫히지 않는다.)
    assert.match(css, /\.device-preview\[hidden\]\s*\{[^}]*display:\s*none/s);
    assert.match(app, /function closeDevicePreview/);
    assert.match(app, /style\.display\s*=\s*'none'/);
    // 부트스트랩은 ?view=mobile 을 읽어 iframe 안을 모바일로 고정한다.
    assert.match(html, /params\.get\('view'\)/);
});

test('result count appears only for an actual search or filter, and long rewards conveyor', async () => {
    const app = await readFile('js/core.js', 'utf8');
    const css = await readFile('css/core.css', 'utf8');

    // 조건을 걸지 않은 기본 목록에서는 "결과 N건"을 띄우지 않는다.
    const countSource = readNamedFunction(app, 'updateNoticeResultCount');
    assert.match(countSource, /total > 0 && hasActiveNoticeQuery\(\)/);
    assert.match(countSource, /countEl\.hidden = !show/);

    const querySource = readNamedFunction(app, 'hasActiveNoticeQuery');
    assert.match(querySource, /searchInput'\)\?\.value\.trim\(\)/);
    assert.match(querySource, /quickNoticeFilters\)\.some\(Boolean\)/);
    assert.match(querySource, /targetFilter/);
    assert.match(querySource, /filter-date-from/);
    assert.match(querySource, /value !== FILTER_DEFAULTS\[group\]/);

    // 리워드가 칸보다 길면 같은 글을 이어 붙여 이음매 없이 한 방향으로 흘린다.
    const marqueeSource = readNamedFunction(app, 'measureCardRewardMarquee');
    assert.match(marqueeSource, /text\.scrollWidth - viewport\.clientWidth/);
    assert.match(marqueeSource, /cloneNode\(true\)/);
    assert.match(marqueeSource, /classList\.add\('is-marquee'\)/);
    assert.match(marqueeSource, /prefers-reduced-motion: reduce/);
    assert.match(css, /@keyframes card-reward-marquee\s*\{[\s\S]*?translateX\(-50%\)/);
    // 이어 붙인 두 벌의 간격이 JS 계산과 어긋나면 이음매가 튄다.
    assert.match(app, /CARD_REWARD_MARQUEE_GAP = 28/);
    assert.match(css, /\.card-reward-text\s*\{[^}]*padding-right:\s*28px/s);
});

test('mobile cards stay compact, keep paging, and disable notice comparison dragging', async () => {
    const html = await readFile('index.html', 'utf8');
    const app = await readFile('js/core.js', 'utf8');
    const mobileCss = await readFile('css/mobile.css', 'utf8');
    const renderCards = readNamedFunction(app, 'renderNoticeCards');

    assert.doesNotMatch(html, /class="search-brand"/);
    assert.match(html, /class="detail-back"[^>]*aria-label="이전 화면"[\s\S]*<svg[\s\S]*<\/button>/);
    assert.match(mobileCss, /\.card\s*\{[^}]*min-height:\s*0/s);
    assert.doesNotMatch(mobileCss, /\.card\s*\{[^}]*aspect-ratio:/s);
    assert.match(mobileCss, /\.card\s*\{[^}]*border-radius:\s*0;[^}]*box-shadow:/s);
    assert.match(mobileCss, /\.card\.card-urgent\s*\{[^}]*border:\s*2px solid #c0392b/s);
    assert.match(mobileCss, /\.card-img-preview\s*\{[^}]*object-fit:\s*cover/s);
    assert.match(mobileCss, /\.card-img-preview\s*\{[^}]*object-position:\s*top center/s);
    // 리워드는 뷰별로 마크업을 나누지 않고 한 벌로 조회수 바로 왼쪽에 선다.
    assert.doesNotMatch(mobileCss, /card-mobile-reward|card-desktop-reward/);
    assert.match(await readFile('css/core.css', 'utf8'), /\.card-reward\s*\{[^}]*display:\s*inline-flex/s);
    // 리워드는 줄 왼쪽에서 시작하고 조회수는 오른쪽 끝에 붙는다.
    assert.match(mobileCss, /\.card-meta\s*\{[^}]*justify-content:\s*space-between/s);
    assert.match(renderCards, /class="card-meta"[\s\S]*\$\{rewardHtml\}[\s\S]*class="view-count"/);
    assert.match(mobileCss, /\.notice-pagination\s*\{[^}]*display:\s*flex/s);
    assert.match(mobileCss, /\.card-block-controls,[\s\S]*\.compare-space,[\s\S]*display:\s*none !important/s);
    // 빠른 필터 손잡이는 따로 두지 않는다. '상세 필터' 바 하나가 둘 다 연다.
    assert.doesNotMatch(html, /mobile-special-filter-toggle|toggleMobileQuickFilters/);
    assert.match(html, /id="filter-toggle-bar"[\s\S]*aria-controls="filter-panel notice-quick-filters"/);
    assert.match(readNamedFunction(app, 'setFilterPanelOpen'), /quickFilters\?\.classList\.toggle\('is-mobile-open', open\)/);
    assert.match(mobileCss, /\.notice-quick-filters\.is-mobile-open\s*\{[^}]*max-height:\s*116px;[^}]*opacity:\s*1;[^}]*visibility:\s*visible/s);
    assert.match(mobileCss, /button:active:not\(:disabled\),[\s\S]*transform:\s*translateY\(1px\) scale\(0\.97\)/s);
    assert.match(renderCards, /const comparisonEnabled = getLayoutMode\(\) === 'desktop'/);
    assert.match(renderCards, /const blockControlsHtml = comparisonEnabled/);
    assert.match(renderCards, /splitHandle\?\.addEventListener/);
});

test('notice blocks use six-dot handles and expose only left/right split targets', async () => {
    const html = await readFile('index.html', 'utf8');
    const css = await readFile('css/core.css', 'utf8');
    const app = await readFile('js/core.js', 'utf8');
    const renderSource = readNamedFunction(app, 'renderCompareSpace');

    assert.doesNotMatch(html, /id="spatial-ar-preview"/);
    assert.match(html, /id="split-drop-overlay"/);
    assert.match(html, /data-split-side="left"/);
    assert.match(html, /data-split-side="right"/);
    assert.doesNotMatch(html, /id="compare-add-zones"/);
    assert.match(renderSource, /class="compare-empty-slot/);
    assert.match(renderSource, /data-placement="\$\{emptyPlacement\}"/);
    assert.doesNotMatch(html, /data-placement="bottom"/);
    assert.match(html, /id="compare-space"[\s\S]*id="notice-base-block"[\s\S]*id="notice-grid"/);
    assert.match(renderSource, /class="compare-col notion-block\$\{expanded/);
    assert.match(renderSource, /class="compare-col-controls"/);
    assert.doesNotMatch(renderSource, /class="compare-col-add"/);
    assert.match(renderSource, /class="compare-col-drag-handle"[^>]*draggable="false"/s);
    assert.doesNotMatch(renderSource, /<header|compare-col-head/);
    assert.doesNotMatch(renderSource, /<article[^>]*draggable=/);
    assert.match(app, /class="card-drag-handle"[^>]*draggable="false"/s);
    assert.doesNotMatch(app, /class="card-block-add"/);
    assert.match(app, /function addNoticeToCompareBlock/);
    assert.match(app, /function onNoticeSplitDragStart/);
    assert.match(app, /function onSplitDropZoneDrop/);
    assert.match(app, /function applyPendingNoticeSplit/);
    assert.match(app, /function onCompareExternalNoticeDrop/);
    assert.doesNotMatch(app, /function splitCompareBlockWithNotice/);
    assert.match(app, /compareLayoutMode = 'columns'/);
    assert.match(app, /function onCompareBlockDrop/);
    assert.match(app, /DESKTOP_MAX_COMPARE_BLOCKS\s*=\s*4/);
    assert.match(app, /MOBILE_MAX_COMPARE_BLOCKS\s*=\s*0/);
    assert.doesNotMatch(html, /id="notice-block-menu"/);
    assert.doesNotMatch(app, /function openNoticeBlockMenu/);
    assert.match(app, /function moveCompareBlock/);
    assert.doesNotMatch(css, /split-drop-dash|\.split-drop-border/);
    assert.doesNotMatch(css, /\.compare-add-zone\.is-bottom\s*\{/);
    assert.doesNotMatch(css, /\.compare-col\.is-notice-split-left::after/);
    // 놓기 표적은 화면 위쪽 가운데에 작게 뜬다. 목록 한가운데를 가리지 않아야
    // 아래쪽 공지를 끌 때도 카드가 보인다.
    assert.match(css, /\.split-drop-overlay\s*\{[^}]*position:\s*fixed;[^}]*top:\s*16px;[^}]*justify-content:\s*center/s);
    // 버튼 안에는 글자를 두지 않는다.
    assert.doesNotMatch(html, /공지 놓기<\/strong>/);
    assert.match(html, /data-split-side="right"[\s\S]*?class="split-drop-glyph"/);
    assert.match(css, /\.spatial-workspace\.is-split\s*\{[^}]*display:\s*block;/s);
    assert.match(css, /\.spatial-workspace\.is-split \.compare-space-stage\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(2,/s);
    assert.match(css, /\.spatial-workspace\.is-split\[data-blocks="1"\]\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(2,/s);
    // 오른쪽 표적에 놓으면 공지 블록도 오른쪽에 선다.
    assert.match(css, /\.spatial-workspace\.is-split\[data-blocks="1"\]\[data-dock="right"\]\s*\{[^}]*grid-template-areas:\s*"base blocks"/s);
    assert.match(readNamedFunction(app, 'applyPendingNoticeSplit'), /compareDockSide = placement/);
    assert.match(css, /\.spatial-workspace\.is-split\[data-blocks="1"\] \.compare-space\s*\{[^}]*position:\s*sticky/s);
    assert.match(css, /\.spatial-workspace\.is-split\[data-blocks="1"\] \.notice-base-block > \.grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,/s);
    assert.match(css, /\.compare-space\.is-notice-drop-active \.compare-empty-slot\s*\{[^}]*display:\s*flex;/s);
    // 이미 놓인 블록의 손잡이는 늘 보인다. 가려 두면 어디를 짚어야 할지 알 수 없다.
    assert.match(css, /\.compare-col-controls\s*\{[^}]*position:\s*absolute;[^}]*left:\s*-30px;[^}]*pointer-events:\s*auto;/s);
    assert.doesNotMatch(css, /\.compare-col-controls\s*\{[^}]*opacity:\s*0;/s);
    assert.match(css, /\.compare-col:hover > \.compare-col-controls[\s\S]*opacity:\s*1;/);
    assert.match(css, /\.compare-col\s*\{[^}]*background:\s*#fff;[^}]*border:\s*1px solid #e4e8ef;[^}]*box-shadow:\s*0 10px 28px/s);
    assert.match(css, /\.compare-col-content\s*\{[^}]*max-height:\s*none;[^}]*background:\s*transparent;[^}]*border:\s*0;/s);
    assert.match(css, /\.compare-col-body\s*\{[^}]*max-height:\s*440px;[^}]*overflow:\s*hidden/s);
    assert.match(css, /\.compare-col\.is-expanded \.compare-col-body\s*\{[^}]*max-height:\s*none/s);
    assert.match(renderSource, /class="compare-col-more"/);
    assert.match(renderSource, /toggleCompareBlockExpansion/);
    assert.match(renderSource, /emptyOnLeft \? `\$\{emptySlot\}\$\{blocks\}` : `\$\{blocks\}\$\{emptySlot\}`/);
    assert.doesNotMatch(app, /document\.startViewTransition/);
});

test('removing one compared notice keeps the remaining block and exposes a trash return target', async () => {
    const html = await readFile('index.html', 'utf8');
    const app = await readFile('js/core.js', 'utf8');
    const css = await readFile('css/core.css', 'utf8');
    const removeSource = readNamedFunction(app, 'removeFromCompareBlock');
    const result = new Function(`
        let compareBlocks = ['one', 'two'];
        let compareWorkspaceOpen = true;
        let expandedCompareBlocks = new Set();
        let renderCount = 0;
        function renderCompareChange() { renderCount += 1; }
        ${removeSource}
        removeFromCompareBlock('two');
        return { compareBlocks, compareWorkspaceOpen, renderCount };
    `)();

    assert.deepEqual(result.compareBlocks, ['one']);
    assert.equal(result.compareWorkspaceOpen, true);
    assert.equal(result.renderCount, 1);
    assert.match(html, /id="compare-trash-zone"/);
    assert.match(app, /function onCompareTrashDrop/);
    assert.match(app, /shouldRemove[\s\S]*removeFromCompareBlock/);
    assert.match(css, /body\.reordering-compare-block \.compare-trash-zone/);
    assert.match(css, /\.compare-col-remove\s*\{[^}]*opacity:\s*1/s);
});

test('compare blocks reorder before, after, and at the document end', async () => {
    const app = await readFile('js/core.js', 'utf8');
    const moveCompareBlockSource = readNamedFunction(app, 'moveCompareBlock');
    const result = new Function(`
        let compareBlocks = ['one', 'two', 'three'];
        let renderCount = 0;
        function renderCompareChange() { renderCount += 1; }
        ${moveCompareBlockSource}
        moveCompareBlock('one', 'two', 'after');
        const after = [...compareBlocks];
        moveCompareBlock('three', 'two', 'before');
        const before = [...compareBlocks];
        moveCompareBlock('three', '', 'end');
        return {
            after,
            before,
            end: [...compareBlocks],
            renderCount
        };
    `)();

    assert.deepEqual(result.after, ['two', 'one', 'three']);
    assert.deepEqual(result.before, ['three', 'two', 'one']);
    assert.deepEqual(result.end, ['two', 'one', 'three']);
    assert.equal(result.renderCount, 3);
});

test('dropping either of two compared blocks on the other swaps left and right', async () => {
    const app = await readFile('js/core.js', 'utf8');
    const moveCompareBlockSource = readNamedFunction(app, 'moveCompareBlock');
    const result = new Function(`
        let compareBlocks = ['left', 'right'];
        let renderCount = 0;
        function renderCompareChange() { renderCount += 1; }
        ${moveCompareBlockSource}
        moveCompareBlock('left', 'right', 'swap');
        return { compareBlocks, renderCount };
    `)();

    assert.deepEqual(result.compareBlocks, ['right', 'left']);
    assert.equal(result.renderCount, 1);
    assert.match(app, /compareBlocks\.length === 2 \? 'swap' : position/);
});

test('drag listeners and overlays are attached only through six-dot handles', async () => {
    const app = await readFile('js/core.js', 'utf8');
    const renderSource = readNamedFunction(app, 'renderCompareSpace');
    const dragStartSource = readNamedFunction(app, 'onNoticeHandlePointerDown');

    assert.match(renderSource, /handle\.addEventListener\('pointerdown'/);
    assert.doesNotMatch(renderSource, /block\.setAttribute\(['"]draggable/);
    assert.match(app, /splitHandle\?\.addEventListener\('pointerdown', event => onNoticeHandlePointerDown/);
    assert.match(app, /function activatePointerNoticeDrag[\s\S]*suspendNoticeHoverPreview/);
    assert.match(app, /body\.classList\.add\('notice-dragging'\)/);
    assert.match(app, /body\.classList\.remove\('notice-dragging'\)/);
    assert.match(app, /Math\.hypot\(/);
    assert.match(app, /document\.elementFromPoint/);
    assert.match(app, /suppressNoticeClickUntil = Date\.now\(\) \+ 300/);
    assert.doesNotMatch(app, /card\.setAttribute\(['"]draggable/);
    assert.match(dragStartSource, /setPointerCapture/);
    assert.match(app, /function onCompareHandlePointerDown/);
    assert.match(app, /function onCompareHandlePointerMove/);
    assert.match(app, /document\.addEventListener\('pointermove', onCompareHandlePointerMove/);
    assert.match(app, /document\.removeEventListener\('pointermove', onCompareHandlePointerMove/);
});

test('the notice board opens a full-page detail instead of a modal', async () => {
    const html = await readFile('index.html', 'utf8');
    const app = await readFile('js/core.js', 'utf8');

    // 상세는 오버레이 모달이 아니라 목록을 대체하는 article 이다.
    assert.match(html, /<article class="notice-detail-view" id="notice-detail-view"/);
    assert.doesNotMatch(html, /id="detail-modal"/);
    assert.match(app, /function showDetailView/);
    assert.match(app, /function closeDetail/);
    assert.match(html, /class="detail-back"[^>]*aria-label="이전 화면"[\s\S]*<svg/);
    assert.doesNotMatch(html, /class="detail-back"[^>]*>[^<]*공지 목록/);
    // 상세를 열면 목록을 숨기고 주소창을 공유 링크로 바꾼다.
    const openDetail = app.slice(app.indexOf('async function openDetail'), app.indexOf('function showDetailView'));
    assert.match(openDetail, /showDetailView\(\)/);
    assert.match(openDetail, /syncUrlToNotice/);
    assert.doesNotMatch(app, /openModal\('detail-modal'\)/);
});

test('detail and board use a lightweight transition and restore scroll', async () => {
    const app = await readFile('js/core.js', 'utf8');
    const css = await readFile('css/core.css', 'utf8');
    const closeDetailSource = readNamedFunction(app, 'closeDetail');
    const showBoardSource = readNamedFunction(app, 'showBoardView');

    assert.match(app, /function runNoticeSurfaceTransition/);
    assert.doesNotMatch(app, /document\.startViewTransition/);
    assert.match(closeDetailSource, /detailHistoryPushed[\s\S]*history\.back\(\);[\s\S]*return;/);
    assert.doesNotMatch(closeDetailSource, /\.hidden\s*=/);
    assert.match(showBoardSource, /window\.scrollTo\(\{ top: boardScrollPosition/);
    assert.doesNotMatch(css, /::view-transition-|view-transition-name/);
    assert.match(css, /\.surface-entering\s*\{[^}]*animation:\s*notice-surface-in 0\.16s ease-out/s);
    assert.match(css, /\.btn:active\s*\{[^}]*scale\(0\.985\)/s);
    assert.match(css, /\.filter-btn:active,[\s\S]*\.gallery-thumb:active\s*\{[\s\S]*scale\(0\.97\)/);
    assert.match(css, /\.detail-back\s*\{[^}]*border-radius:\s*50%;[^}]*box-shadow:/s);
});

test('a category tab bar sits above the filters like the SNU newsroom', async () => {
    const html = await readFile('index.html', 'utf8');
    const app = await readFile('js/core.js', 'utf8');

    const tabsIndex = html.indexOf('id="category-tabs"');
    const filterIndex = html.indexOf('id="filter-toggle-bar"');
    assert.ok(tabsIndex > 0 && filterIndex > tabsIndex, '카테고리 탭이 필터보다 위에 있어야 한다');
    assert.match(html, /class="category-tab active"[^>]*onclick="selectCategoryTab\('all'\)"/);
    assert.match(app, /function buildCategoryTabs/);
    assert.match(app, /function selectCategoryTab/);
    // 상단의 1차 카테고리 탐색을 상세 필터 안에 중복 노출하지 않는다.
    assert.doesNotMatch(html, /id="fg-category"/);
    assert.doesNotMatch(app, /function buildCategoryFilterButtons/);
    assert.doesNotMatch(app, /function toggleCategoryFilter/);
});

test('the public rail presents approved campus promotion instead of advertising language', async () => {
    const html = await readFile('index.html', 'utf8');
    const app = await readFile('js/core.js', 'utf8');
    const schema = await readFile('server/sql/supabase-schema.sql', 'utf8');

    // 헤더 액션에는 모바일 모드 버튼만 남는다(문의 버튼 제거).
    const headerActions = html.slice(html.indexOf('class="header-actions"'), html.indexOf('</div>', html.indexOf('class="header-actions"')));
    assert.doesNotMatch(headerActions, /openModal\('contact-modal'\)/);
    assert.match(html, />홍보 신청하기</);
    assert.match(app, />홍보 신청하기</);
    assert.doesNotMatch(html, /class="rail-section-label">학내 홍보</);
    assert.match(html, /class="rail-section-label">문의</);
    assert.match(html, /onclick="openContactFromRail\(\)">일반 문의하기/);
    assert.match(html, /onclick="openBannerInquiryFromRail\(\)">홍보 신청하기/);
    assert.doesNotMatch(html, /class="rail-section-label">일반 문의</);
    assert.doesNotMatch(html, /class="rail-section-label">배너 문의</);
    assert.match(app, /function openBannerInquiryFromRail/);
    assert.match(app, /window\.location\.href = '\.\/banner-inquiry\.html'/);
    const renderRail = readNamedFunction(app, 'renderRightRailAd');
    assert.doesNotMatch(renderRail, /class="ad-label"/);
    assert.match(schema, /create table if not exists public\.promo_slots/);
    assert.match(schema, /type text[\s\S]*title text[\s\S]*image_url text[\s\S]*link_url text[\s\S]*owner text[\s\S]*starts_at timestamptz[\s\S]*ends_at timestamptz[\s\S]*status text/);
});

test('sort chips are exposed beside result count and category tabs restore their defaults', async () => {
    const html = await readFile('index.html', 'utf8');
    const app = await readFile('js/core.js', 'utf8');
    assert.match(html, /class="notice-results-toolbar"/);
    assert.match(html, /data-sort="최신순"[\s\S]*data-sort="마감임박순"[\s\S]*data-sort="조회순"/);
    assert.doesNotMatch(html, /id="fg-sort"/);
    const defaults = readNamedFunction(app, 'getDefaultSortForCategory');
    assert.match(defaults, /opportunity[\s\S]*survey[\s\S]*마감임박순/);
    assert.match(app, /function selectCategoryTab[\s\S]*getDefaultSortForCategory\(category\?\.slug \|\| 'all'\)[\s\S]*syncNoticeSortChips/);
});

test('notice cards show when a notice is open, as a single day or a period', async () => {
    const app = await readFile('js/core.js', 'utf8');
    const source = readNamedFunction(app, 'getNoticeDatePresentation');
    const cards = readNamedFunction(app, 'renderNoticeCards');
    assert.match(source, /notice\.isAlwaysOpen[\s\S]*badgeText: '상시'/);
    assert.match(cards, /getNoticeDatePresentation\(notice\)/);
    assert.match(app, /diffDays === 0[\s\S]*오늘 마감/);
    assert.match(app, /return `\$\{y\}\.\$\{m\}\.\$\{d\}\(\$\{WEEKDAY_KO/);

    const present = new Function(`
        const WEEKDAY_KO = ['일','월','화','수','목','금','토'];
        ${readNamedFunction(app, 'formatDateWithWeekday')}
        ${readNamedFunction(app, 'getCalendarDayDifference')}
        ${readNamedFunction(app, 'calcDDay')}
        ${readNamedFunction(app, 'noticeRegisteredOn')}
        function getCurrentDate() { return new Date('2026-07-29T00:00:00'); }
        ${source}
        return getNoticeDatePresentation;
    `)();

    // 시작일과 마감일이 모두 있으면 기간으로 잇는다.
    assert.equal(
        present({ startDate: '2026-07-20', deadline: '2026-09-15', createdAt: '2026-07-19T04:31:00Z' }).dateLabel,
        '2026.07.20(월) ~ 2026.09.15(화)'
    );
    // 시작일이 없으면 등록일이 그 자리를 대신한다.
    assert.equal(
        present({ deadline: '2026-07-31', createdAt: '2026-07-25T04:31:00Z' }).dateLabel,
        '2026.07.25(토) ~ 2026.07.31(금)'
    );
    // 원문 게시일이 있으면 그것을 등록일로 본다.
    assert.equal(
        present({ deadline: '2026-07-31', sourcePublishedAt: '2026-07-22', createdAt: '2026-07-25' }).dateLabel,
        '2026.07.22(수) ~ 2026.07.31(금)'
    );
    // 마감이 없는 하루짜리 행사는 그 하루만 적는다.
    assert.equal(
        present({ startDate: '2026-07-31', createdAt: '2026-07-01T04:31:00Z' }).dateLabel,
        '2026.07.31(금)'
    );
    // 시작이 마감과 같거나 뒤면 기간으로 잇지 않는다.
    assert.equal(
        present({ startDate: '2026-07-31', deadline: '2026-07-31', createdAt: '2026-07-01' }).dateLabel,
        '2026.07.31(금)'
    );
    // 상시 공지는 뱃지만 남고 날짜줄은 비운다.
    const always = present({ isAlwaysOpen: true, createdAt: '2026-07-29T04:31:00Z' });
    assert.equal(always.badgeText, '상시');
    assert.equal(always.dateLabel, '');
    // 아무 날짜도 없으면 아무것도 표시하지 않는다.
    assert.equal(present({ createdAt: '2026-07-29T04:31:00Z' }).dateLabel, '');

    // 상세 화면에서는 등록일도 함께 보여 오래된 공지인지 알 수 있게 한다.
    const meta = readNamedFunction(app, 'formatDetailMeta');
    assert.match(meta, /등록 \$\{escapeHtml\(formatDateWithWeekday\(registeredOn\)\)\}/);

    /* 시작일은 저장까지 이어져야 한다. 화면만 고치고 쓰기 경로를 빠뜨리면
       로컬(JSON)에서는 통째로 저장돼 멀쩡해 보이는데 운영(Supabase)에서만
       조용히 사라진다. 넣는 길과 고치는 길을 모두 확인한다. */
    const server = await readFile('server/server.js', 'utf8');
    const schema = await readFile('server/sql/supabase-schema.sql', 'utf8');
    assert.match(server, /start_date: preparedPayload\.startDate \|\| null/);
    assert.match(schema, /add column if not exists start_date date/);
    assert.match(schema, /deadline, deadline_at, start_date, expires_at/);
    assert.match(schema, /nullif\(notice_payload->>'startDate', ''\)::date/);
    assert.match(server, /startDate: String\(row\.startDate \|\| row\.start_date/);

    // 스키마를 다시 돌려도 카테고리가 옛 목록으로 되돌아가지 않아야 한다.
    assert.match(schema, /\('설문', 'survey', true\)/);
    assert.doesNotMatch(schema, /\('혜택', 'benefit', true\)/);
    assert.match(schema, /slug not in \('academic', 'opportunity', 'survey', 'community'\)/);
});

test('the contact modal is an anonymous feedback box, not admin contact info', async () => {
    const html = await readFile('index.html', 'utf8');
    const app = await readFile('js/core.js', 'utf8');
    const server = await readFile('server/server.js', 'utf8');
    const adminHtml = await readFile('admin.html', 'utf8');
    const admin = await readFile('js/admin.js', 'utf8');

    // 관리자 전화·카톡을 나열하던 연락처 블록은 사라졌다.
    assert.doesNotMatch(html, /admin-phone-display/);
    assert.doesNotMatch(html, /banner-admin-phone-display/);
    assert.doesNotMatch(html, /01040953346/);
    // 대신 익명 피드백 입력 상자가 있다.
    assert.match(html, /id="feedback-message"/);
    assert.match(html, /이름·연락처·IP를 저장하지 않습니다\.\s*\n개선 의견이나 오류를 편하게 남겨주세요\./);
    assert.match(app, /이름·연락처·IP를 저장하지 않습니다\.\\n개선 의견이나 오류를 편하게 남겨주세요\./);
    assert.doesNotMatch(html, /data-feedback-category="banner"/);
    assert.match(html, /onclick="submitFeedback\(\)"/);
    assert.match(app, /function submitFeedback/);
    assert.match(app, /message,\s*category: activeFeedbackCategory,\s*screenshots: feedbackShots/);

    /* 오류 제보에 화면 사진을 붙일 수 있다. 원본을 그대로 보내면 저장소가
       금세 차므로 긴 변을 줄여 JPEG으로 다시 그려 보낸다. 사진은 JSON이 아니라
       파일로 따로 쌓고, 문의를 지우면 함께 지운다. */
    assert.match(app, /FEEDBACK_MAX_SHOTS = 3/);
    assert.match(app, /canvas\.toDataURL\('image\/jpeg'/);
    assert.match(html, /id="feedback-shot-input"/);
    assert.match(server, /const FEEDBACK_SHOT_MAX_BYTES/);
    assert.match(server, /data:image.{0,4}jpeg;base64/);
    assert.match(server, /screenshotFileNames\.push\(fileName\)/);
    assert.match(server, /\.\.\.\(Array\.isArray\(removed\?\.screenshotFileNames\)/);
    assert.match(app, /\/api\/feedback/);
    // 서버는 신원을 저장하지 않고 메시지만 받는다.
    assert.match(server, /app\.post\('\/api\/feedback'/);
    assert.match(server, /app\.get\('\/api\/admin\/feedback'/);
    assert.match(adminHtml, /data-feedback-filter="general"/);
    assert.doesNotMatch(adminHtml, /data-feedback-filter="banner"/);
    assert.match(adminHtml, /id="banner-inquiry-admin-list"/);
    assert.match(admin, /function setAdminFeedbackFilter/);
    assert.match(admin, /item\.category === 'banner'/);
    // 익명성: 피드백 저장 객체에 IP·이름 등 식별자가 없어야 한다.
    const feedbackRoute = server.slice(server.indexOf("app.post('/api/feedback'"), server.indexOf("app.get('/api/admin/feedback'"));
    assert.doesNotMatch(feedbackRoute, /req\.ip|x-forwarded-for|headers\['user-agent'\]/i);
    // 저장하는 항목은 문의 자체에 관한 것뿐이다. 사진을 붙여도 마찬가지다.
    assert.match(feedbackRoute, /id,\s*category,\s*message,\s*screenshotFileNames,\s*createdAt/s);
});

test('AI summaries keep reporting support without a permanent mismatch prompt', async () => {
    const html = await readFile('index.html', 'utf8');
    const app = await readFile('js/core.js', 'utf8');
    const server = await readFile('server/server.js', 'utf8');
    const adminHtml = await readFile('admin.html', 'utf8');
    const admin = await readFile('js/admin.js', 'utf8');
    const guide = await readFile('service-guide.html', 'utf8');
    const prepare = await readFile('scripts/prepare-public.mjs', 'utf8');

    assert.match(html, />AI 3줄 요약</);
    assert.doesNotMatch(html, /Gemini AI 3줄 요약/);
    assert.doesNotMatch(html, /원문 확인 필수/);
    assert.doesNotMatch(html, /요약이 원문과 다릅니다/);
    assert.match(html, /aria-label="서울대학교 관련 링크"[\s\S]*href="\.\/service-guide\.html">서비스 안내/);
    const inquiryLinks = html.slice(
        html.indexOf('<nav class="brand-links inquiry-links"'),
        html.indexOf('</nav>', html.indexOf('<nav class="brand-links inquiry-links"'))
    );
    assert.doesNotMatch(inquiryLinks, /서비스 안내/);
    assert.match(app, /function reportSummaryMismatch/);
    assert.match(app, /\/summary-report/);
    assert.doesNotMatch(app, /원문 확인 필수/);
    assert.match(server, /app\.post\('\/api\/notices\/:id\/summary-report', feedbackLimiter/);
    assert.match(server, /category: 'summary_mismatch'/);
    assert.match(adminHtml, /data-feedback-filter="summary_mismatch"/);
    assert.match(admin, /isSummaryMismatch/);
    assert.match(guide, /AI 3줄 요약은 공지의 핵심을 빠르게 훑기 위한 참고 정보/);
    assert.match(guide, /원문의 내용이 우선/);
    assert.match(prepare, /service-guide\.html/);
});

test('banner inquiries use a dedicated identified submission page and protected admin image access', async () => {
    const html = await readFile('banner-inquiry.html', 'utf8');
    const app = await readFile('js/banner-inquiry.js', 'utf8');
    const css = await readFile('css/banner-inquiry.css', 'utf8');
    const server = await readFile('server/server.js', 'utf8');
    const admin = await readFile('js/admin.js', 'utf8');

    assert.match(html, /id="banner-inquiry-form"/);
    assert.match(html, /id="inquiry-name"[^>]*required/);
    assert.match(html, /id="inquiry-organization"[^>]*required/);
    assert.match(html, /id="inquiry-type"[^>]*required/);
    assert.match(html, /id="inquiry-desktop-image"[^>]*type="file"/);
    assert.match(html, /id="inquiry-mobile-image"[^>]*type="file"/);
        // 레일은 240px 폭에 화면 높이 전체라 4:5로는 한참 짧다.
    assert.match(html, /세로형 3 : 10/);
    assert.match(html, /720×2400px/);
    assert.match(html, /16:9 가로형/);
    assert.match(html, /개인정보 수집 및 이용/);
    assert.match(html, /무료 학내 홍보 운영 규칙/);
    assert.match(html, /선착순이 아닙니다/);
    assert.match(html, /기본 7일, 한 신청당 최대 14일/);
    assert.match(html, /동시에 최대 5개/);
    assert.match(app, /application\/vnd\.ece-banner\+json/);
    assert.match(app, /\/api\/banner-inquiries/);
    assert.match(app, /function validateBannerInquiry/);
    assert.match(app, /exposureDays > 14/);
    assert.match(server, /app\.post\('\/api\/banner-inquiries', bannerInquiryJson/);
    assert.match(server, /category: 'banner'/);
    assert.match(server, /bannerInquiryImageDir/);
    assert.match(server, /desktopImageFileName/);
    assert.match(server, /mobileImageFileName/);
    assert.match(server, /status: 'pending'/);
    assert.match(server, /exposureDays > 14/);
    assert.match(server, /await createBannerSlide\(normalizeBannerPayload/);
    // 배너 관리자도 자기 문의의 첨부는 봐야 하므로 역할로 거른다.
    assert.match(server, /app\.get\('\/api\/admin\/feedback\/:id\/image', requireAnyAdmin/);
    assert.match(server, /const items = visibleFeedbackForRole\(await readFeedback\(\), req\.adminRole\)/);
    assert.match(admin, /function openBannerInquiryImage/);
    assert.match(admin, /variant = 'desktop'/);
    assert.match(admin, /class="banner-inquiry-details"/);
    assert.match(css, /\.inquiry-layout\s*\{[^}]*grid-template-columns:/s);
});

test('the compose form leads with content/photo/target, then AI fills date/subject/type', async () => {
    const html = await readFile('admin.html', 'utf8');
    const admin = await readFile('js/admin.js', 'utf8');

    // 원문 → 사진 → 대상 학번 → AI 분석 순서.
    const contentIdx = html.indexOf('id="post-content"');
    const imagesIdx = html.indexOf('id="post-images"');
    const targetIdx = html.indexOf('id="post-target"');
    const analyzeIdx = html.indexOf('id="ai-analyze-btn"');
    assert.ok(contentIdx > 0 && imagesIdx > contentIdx && targetIdx > imagesIdx && analyzeIdx > targetIdx);

    assert.match(html, /onclick="analyzeNotice\(\)"/);
    assert.match(admin, /async function analyzeNotice/);
    // 유형은 정해진 보기(TITLE_KINDS) 안에서만 채운다.
    assert.match(admin, /TITLE_KINDS\.includes\(parsed\.type\)/);
    // AI 마감일은 후보로만 보여주고 관리자가 적용해야 입력란에 들어간다.
    assert.match(admin, /aiDeadlineCandidate = parsed\.deadline/);
    assert.match(admin, /function applyAiDeadlineCandidate/);
    assert.doesNotMatch(admin, /getElementById\('post-deadline'\)\.value = parsed\.deadline/);
    assert.match(admin, /getElementById\('title-subject'\)\.value/);
    // 잡다한 설명 문구(panel-help)는 제거했다.
    assert.doesNotMatch(html, /class="panel-help"/);
});

test('public category tabs keep the four canonical topic categories, with related notices as a filter switch', async () => {
    const app = await readFile('js/core.js', 'utf8');
    const html = await readFile('index.html', 'utf8');
    const server = await readFile('server/server.js', 'utf8');
    const categoryConfig = await readFile('server/config/notice-categories.js', 'utf8');
    const orderSource = app.match(/const NOTICE_CATEGORY_ORDER = Object\.freeze\(\[[\s\S]*?\]\);/)?.[0] || '';

    assert.match(orderSource, /'academic'[\s\S]*'opportunity'[\s\S]*'survey'[\s\S]*'community'/);
    assert.match(categoryConfig, /ACADEMIC[\s\S]*OPPORTUNITY[\s\S]*SURVEY[\s\S]*COMMUNITY/);
    assert.match(server, /canonicalSlugs[\s\S]*categories\.filter/);
    assert.match(app, /function orderedNoticeCategories/);

    /* '관련' 공지는 주제가 아니라 출처로 가른 것이라 카테고리 탭에 세우지
       않는다. 축이 어긋나 같은 공지가 두 칸에 나오기 때문이다. 상세 필터의
       스위치로 두되 평소에는 켜 두어 다 보인다. */
    assert.doesNotMatch(app, /RELATED_TAB_SLUG/);
    assert.match(app, /let includeRelatedNotices = true;/);
    assert.match(app, /source: includeRelatedNotices \? '전체' : 'manual'/);
    assert.match(html, /id="filter-include-related"[\s\S]{0,80}checked/);
    assert.match(app, /function setRelatedNoticeFilter/);
    // 끈 상태도 조건을 건 것으로 세어 칩과 결과 건수에 드러난다.
    assert.match(readNamedFunction(app, 'hasActiveNoticeQuery'), /!includeRelatedNotices/);
    assert.match(server, /allowedSources = new Set\(\['전체', 'crawled', 'manual'\]\)/);
    assert.match(server, /filters\.source === 'manual' && crawled/);

    // 카테고리 수가 바뀌어도 모바일 탭 간격이 어긋나지 않아야 한다.
    const mobile = await readFile('css/mobile.css', 'utf8');
    assert.match(mobile, /\.category-tabs-inner\s*\{[^}]*grid-auto-flow:\s*column;[^}]*grid-auto-columns:\s*minmax\(0, 1fr\)/s);
    assert.doesNotMatch(mobile, /grid-template-columns:\s*repeat\(5/);
});

test('manual Gemini analysis saves canonical category ids with the notice', async () => {
    const admin = await readFile('js/admin.js', 'utf8');
    const server = await readFile('server/server.js', 'utf8');
    const schema = await readFile('server/sql/supabase-schema.sql', 'utf8');

    assert.match(admin, /"categorySlugs":\["academic\|opportunity\|survey\|community 중 핵심 하나"\]/);
    assert.match(admin, /categorySlugs는 반드시 핵심 범주 하나만 선택/);
    assert.match(admin, /"hasReward":false/);
    assert.match(admin, /"requiresAction":false/);
    // 카테고리 매핑은 1차·2차 어느 결과에도 같게 적용된다.
    assert.match(admin, /categoryIds:\s*analysis\.categorySlugs/);
    assert.match(admin, /return withResolvedCategoryIds\(verified\)/);
    assert.match(admin, /verificationPrompt/);
    assert.match(admin, /출력 형식:[\s\S]*?"deadline"[\s\S]*?"startDate"/);
    assert.match(admin, /document\.getElementById\('post-start-date'\)\.value = parsed\.startDate \|\| ''/);
    const save = readNamedFunction(admin, 'generateAIAndSave');
    assert.match(save, /if \(!startDate && analysis\.startDate\)/);
    assert.match(save, /startDate = analysis\.startDate/);
    assert.match(save, /if \(!deadline && analysis\.deadline\)/);
    assert.match(admin, /verifiedNumbers/);
    assert.match(admin, /const newNoticeData = \{[\s\S]*categoryIds,/);
    assert.match(server, /const categoryIds = Array\.from\(new Set/);
    assert.match(schema, /notice_payload \? 'categoryIds'[\s\S]*insert into public\.notice_categories/);
});

test('explicit notice ranges supply start and deadline when Gemini omits them', async () => {
    const admin = await readFile('js/admin.js', 'utf8');
    const source = readNamedFunction(admin, 'extractExplicitNoticeDateRange');
    const extract = new Function(`${source}; return extractExplicitNoticeDateRange;`)();

    assert.deepEqual(
        extract('2026학년도 2학기 수강신청 안내 (8/12 18:00 ~ 9/17 24:00)', new Date('2026-08-02T00:00:00')),
        { startDate: '2026-08-12', deadline: '2026-09-17' }
    );
    assert.deepEqual(
        extract('행사일은 8월 12일입니다.', new Date('2026-08-02T00:00:00')),
        { startDate: '', deadline: '' }
    );
    const analysis = readNamedFunction(admin, 'runNoticeAnalysis');
    assert.match(analysis, /if \(!draft\.startDate && explicitRange\.startDate\)/);
    assert.match(analysis, /if \(!verified\.startDate && explicitRange\.startDate\)/);
});

test('the compose form picks an analysis mode instead of a verification checkbox', async () => {
    const html = await readFile('admin.html', 'utf8');
    const admin = await readFile('js/admin.js', 'utf8');

    // 체크박스는 사라지고 3지선다 선택기가 그 자리를 대신한다.
    assert.doesNotMatch(html, /id="ai-skip-verification"/);
    assert.match(html, /id="ai-mode"/);
    for (const mode of ['full-verified', 'full', 'summary']) {
        assert.match(html, new RegExp(`value="${mode}"`));
    }

    // 선택기가 없으면 가장 안전한 모드로 떨어져야 한다.
    const accessor = readNamedFunction(admin, 'currentAiMode');
    assert.match(accessor, /getElementById\('ai-mode'\)/);
    assert.match(accessor, /'full-verified'/);

    // 기존에 체크박스를 켜두었던 브라우저는 전체 분석 1회로 이관한다.
    const migrate = readNamedFunction(admin, 'restoreAiModeChoice');
    assert.match(migrate, /eceAiSkipVerification/);
    assert.match(migrate, /eceAiMode/);
    assert.match(migrate, /removeItem/);
});

test('summary mode asks only for the fields the compose form cannot collect', async () => {
    const admin = await readFile('js/admin.js', 'utf8');
    const source = readNamedFunction(admin, 'runNoticeAnalysis');

    // 요약 전용 프롬프트는 요약·카테고리·리워드만 요구한다.
    assert.match(admin, /function buildSummaryOnlyPrompt/);
    const prompt = readNamedFunction(admin, 'buildSummaryOnlyPrompt');
    assert.match(prompt, /"summary"/);
    assert.match(prompt, /"categorySlugs"/);
    assert.match(prompt, /"hasReward"/);
    assert.match(prompt, /"requiresAction"/);
    // 내가 직접 입력하는 항목은 요구하지 않는다.
    assert.doesNotMatch(prompt, /"subject"/);
    assert.doesNotMatch(prompt, /"type"/);
    assert.doesNotMatch(prompt, /"deadline"/);

    // summary 모드는 1차에서 끝나고 2차 검수를 부르지 않는다.
    assert.match(source, /mode === 'summary'/);
    assert.match(source, /mode !== 'full-verified'/);
});

test('summary mode leaves the typed subject, type, and deadline alone', async () => {
    const admin = await readFile('js/admin.js', 'utf8');
    const source = readNamedFunction(admin, 'analyzeNotice');

    // 폼에 값을 쓰기 전에 모드를 확인해야 한다.
    assert.match(source, /const mode = currentAiMode\(\)/);
    assert.match(source, /if \(mode !== 'summary'\)/);
    // 요약과 카테고리는 어느 모드에서나 채운다.
    assert.match(source, /composeAiCategoryIds = parsed\.categoryIds/);
});

test('the three-line summary is an editable field that drives the save', async () => {
    const html = await readFile('admin.html', 'utf8');
    const admin = await readFile('js/admin.js', 'utf8');

    assert.match(html, /id="post-ai-summary"/);
    // 변수가 아니라 입력칸이 유일한 진실 공급원이다.
    assert.doesNotMatch(admin, /composeAiSummary/);

    const read = readNamedFunction(admin, 'readSummaryField');
    assert.match(read, /split\('\\n'\)/);
    assert.match(read, /slice\(0, 3\)/);

    const write = readNamedFunction(admin, 'writeSummaryField');
    assert.match(write, /join\('\\n'\)/);

    // 요약이 이미 있으면 저장할 때 Gemini를 부르지 않는다.
    const save = readNamedFunction(admin, 'generateAIAndSave');
    assert.match(save, /readSummaryField\(\)/);
    // 수정 화면은 저장된 요약을 칸에 되살린다.
    assert.match(readNamedFunction(admin, 'editAdminNotice'), /writeSummaryField\(notice\.aiSummary/);
});

test('notice images are downscaled and re-encoded before they reach the database', async () => {
    const admin = await readFile('js/admin.js', 'utf8');

    // 공지 이미지가 들어오는 두 경로 모두 압축을 거쳐야 한다.
    assert.doesNotMatch(admin, /pastedImages\.push\(await getBase64\(/);
    assert.doesNotMatch(admin, /finalImages\.push\(await getBase64\(/);
    assert.match(admin, /pastedImages\.push\(await compressNoticeImage\(/);
    assert.match(admin, /finalImages\.push\(await compressNoticeImage\(/);

    // 배너·OCR이 쓰는 공용 getBase64는 그대로 둔다.
    assert.match(admin, /const images = await Promise\.all\(files\.map\(getBase64\)\)/);

    // 긴 변을 기준으로 줄이고, 상한보다 작은 그림은 확대하지 않는다.
    const sizing = readNamedFunction(admin, 'noticeImageTargetSize');
    const targetSize = new Function(`${sizing} return noticeImageTargetSize;`)();
    assert.deepEqual(targetSize(3024, 4032, 2000), { width: 1500, height: 2000 });
    assert.deepEqual(targetSize(4032, 3024, 2000), { width: 2000, height: 1500 });
    assert.deepEqual(targetSize(800, 600, 2000), { width: 800, height: 600 });

    // 캔버스로 다시 그리면 애니메이션이 죽으므로 GIF는 원본을 유지한다.
    const compress = readNamedFunction(admin, 'compressNoticeImage');
    assert.match(compress, /image\/gif/);
    // 압축이 실패하거나 되레 커지면 원본으로 되돌아간다.
    assert.match(compress, /getBase64\(file\)/);
});

test('the admin list flags notices missing a summary or a category', async () => {
    const admin = await readFile('js/admin.js', 'utf8');
    const source = readNamedFunction(admin, 'renderAdminNoticeList');

    // 카테고리가 없으면 공개 화면의 카테고리 탭 어디에도 안 뜬다. 목록에서 보여야 한다.
    assert.match(source, /AI 요약 없음/);
    assert.match(source, /카테고리 없음/);
    assert.match(source, /notice\.categoryIds \|\| \[\]/);
});

test('admin AI work shows progress while login is isolated in a server-session page', async () => {
    const html = await readFile('admin.html', 'utf8');
    const loginHtml = await readFile('admin-login.html', 'utf8');
    const loginApp = await readFile('js/admin-login.js', 'utf8');
    const admin = await readFile('js/admin.js', 'utf8');

    assert.match(html, /id="ai-progress-bar"/);
    assert.match(html, /id="ai-progress-percent"/);
    for (const step of ['prepare', 'analyze', 'process']) {
        assert.match(html, new RegExp(`data-ai-step="${step}"`));
    }
    assert.doesNotMatch(html, /data-ai-step="save"/);
    assert.match(admin, /beginAiProgress\('공지 원문을 준비하고 있습니다\.'/);
    assert.match(admin, /updateAiProgress\(18, 'Gemini가 원문을 분석하고 있습니다\.'/);
    assert.match(admin, /finishAiProgress\('Gemini 분석이 완료되었습니다\.'/);
    const saveFlow = readNamedFunction(admin, 'generateAIAndSave');
    assert.ok(
        saveFlow.indexOf("finishAiProgress('Gemini 편집 결과가 모두 반영되었습니다.')")
            < saveFlow.indexOf('compressNoticeImage'),
        '100% 완료 시점은 이미지 처리·공지 저장보다 앞이어야 한다'
    );
    assert.doesNotMatch(saveFlow, /updateAiProgress\((84|95),/);

    assert.doesNotMatch(html, /id="admin-gate"|id="admin-gate-password"/);
    assert.match(loginHtml, /id="admin-login-password"[^>]*value=""/);
    assert.match(loginHtml, /autocomplete="current-password"/);
    assert.match(loginApp, /\/api\/admin\/session/);
    assert.match(loginApp, /location\.replace\(getAdminWorkspaceUrl\(\)\)/);
    assert.doesNotMatch(admin, /sessionStorage\.getItem\('eceNoticeAdminToken'\)/);
    assert.doesNotMatch(admin, /function submitAdminGate/);
});

test('Gemini quota errors show only a retry countdown and admin mode has one exit control', async () => {
    const html = await readFile('admin.html', 'utf8');
    const admin = await readFile('js/admin.js', 'utf8');
    const server = await readFile('server/server.js', 'utf8');

    assert.match(server, /code:\s*'GEMINI_RATE_LIMIT'/);
    assert.match(server, /retryAfterSeconds/);
    assert.match(admin, /function showGeminiRetryCountdown/);
    assert.match(admin, /분당 호출 초과로 \$\{remaining\}초 뒤에 다시 실행 부탁드립니다\./);
    assert.match(admin, /isGeminiRateLimitError\(error\)/);
    assert.match(html, /id="admin-mode-exit"[^>]*onclick="exitAdminMode\(\)"/);
    assert.match(html, />관리자 모드 나가기<\/button>/);
    assert.doesNotMatch(html, /id="admin-logout"|>로그아웃<|공개 화면으로/);
    assert.match(admin, /getElementById\('admin-mode-exit'\)\.textContent = '관리자 모드 나가기'/);
    // 나가면 공개 화면이 아니라 들어왔던 로그인 화면으로 되돌아간다.
    assert.match(admin, /async function exitAdminMode\(\)[\s\S]*buildApiUrl\('\/api\/admin\/session'\)[\s\S]*method: 'DELETE'[\s\S]*location\.replace\('\/admin-login\.html'\)/);
});

test('automatic ECE crawling feeds a live review inbox and original text is black', async () => {
    const html = await readFile('admin.html', 'utf8');
    const admin = await readFile('js/admin.js', 'utf8');
    const adminCss = await readFile('css/admin.css', 'utf8');
    const crawler = await readFile('server/services/ece-crawler.js', 'utf8');
    const css = await readFile('css/core.css', 'utf8');

    assert.match(crawler, /store\.createPendingNotice\(/);
    assert.match(html, /자동 수집되어 이 검수함에 들어오며/);
    assert.match(html, /id="review-crawl-progress-bar"/);
    assert.match(html, /id="review-crawl-progress-percent"/);
    assert.match(admin, /function startReviewInboxPolling\(\)/);
    assert.match(admin, /loadReviewNotices\(\{ quiet: true \}\)/);
    assert.match(admin, /60_000/);
    assert.match(admin, /function beginCrawlProgress\(\)/);
    assert.match(admin, /새 공지의 원문과 리워드 여부를 확인하고 있습니다/);
    assert.match(admin, /finishCrawlProgress\(`확인 완료/);
    assert.match(admin, /class="review-actions review-actions-top"/);
    assert.match(admin, /id="review-has-reward"[\s\S]*id="review-reward-note-field"/);
    assert.match(admin, /if \(edits\.hasReward && !edits\.rewardNote\)/);
    assert.match(adminCss, /\.review-actions-top\s*\{[^}]*position:\s*sticky/s);
    assert.match(css, /\.original-text-content\s*\{[^}]*color:\s*#111111/s);
    assert.match(css, /\.compare-col-content\s*\{[^}]*color:\s*#111111/s);
});

test('Kakao backfill is previewed and human-edited before entering the review inbox', async () => {
    const html = await readFile('admin.html', 'utf8');
    const admin = await readFile('js/admin.js', 'utf8');
    const server = await readFile('server/server.js', 'utf8');
    const parser = await readFile('server/services/kakao-backfill.js', 'utf8');
    const schema = await readFile('server/sql/supabase-schema.sql', 'utf8');

    assert.match(html, /data-tab="backfill"/);
    assert.match(html, /id="kakao-backfill-file"/);
    assert.match(html, /id="kakao-backfill-rows"/);
    assert.match(admin, /function previewKakaoBackfill/);
    assert.match(admin, /function importKakaoBackfill/);
    assert.match(server, /express\.raw\([\s\S]*text\/plain/);
    assert.match(server, /\/api\/admin\/backfill\/kakao\/preview/);
    assert.match(server, /\/api\/admin\/backfill\/kakao\/import/);
    assert.match(server, /analysisStatus: 'backfill_draft'/);
    assert.match(parser, /raw\.split\('\\r\\n'\)/);
    assert.match(parser, /Math\.abs\(sentAtMs - Date\.parse\(candidate\.latestSentAt\)\) <= 30 \* DAY_MS/);
    assert.match(schema, /source_group text/);
    assert.match(schema, /thread_key text/);
});

test('image-only notices can add private OCR search text from the review inbox', async () => {
    const admin = await readFile('js/admin.js', 'utf8');
    const server = await readFile('server/server.js', 'utf8');
    const store = await readFile('server/storage/automation-store.js', 'utf8');
    const schema = await readFile('server/sql/supabase-schema.sql', 'utf8');

    assert.match(admin, /function runReviewOcr/);
    assert.match(admin, /OCR 결과는 검색 인덱스에만 저장되며 공개 원문에는 표시되지 않습니다/);
    assert.match(server, /\/api\/admin\/review-notices\/:id\/ocr/);
    assert.match(server, /visibleText\.length >= 15/);
    assert.match(server, /\$\{notice\.title\} \$\{notice\.content\} \$\{ocrText\}/);
    assert.match(store, /ocrText: 'ocr_text'/);
    assert.match(schema, /ocr_text text/);
});

test('rails share one bright navy and the emblem sits on it without a white circle', async () => {
    const css = await readFile('css/core.css', 'utf8');
    const html = await readFile('index.html', 'utf8');

    // 좌우 레일은 같은 --rail-bg 를 쓴다(통일).
    assert.match(css, /--rail-bg:\s*#1f3f8f/);
    // 엠블럼은 흰 원판(배경·라운드) 없이 레일 위에 그대로 얹힌다.
    const logoImg = css.slice(css.indexOf('.brand-logo-img'), css.indexOf('.brand-logo-img') + 200);
    assert.doesNotMatch(logoImg, /border-radius:\s*50%/);
    assert.doesNotMatch(logoImg, /background:\s*#fff/i);
    assert.match(html, /id="brand-logo-img"[^>]*src="\.\/icons\/snu-emblem\.png"/);
});

test('the rail shows the SNU emblem with a click-to-refresh and a graceful fallback', async () => {
    const html = await readFile('index.html', 'utf8');
    const css = await readFile('css/core.css', 'utf8');
    const app = await readFile('js/core.js', 'utf8');

    assert.match(html, /id="brand-logo-btn"[^>]*onclick="goHomeAndReload\(\)"/);
    assert.match(html, /id="brand-logo-img"[^>]*src="\.\/icons\/snu-emblem\.png"/);
    assert.match(html, /class="brand-university-name">서울대학교<\/p>/);
    assert.match(app, /function goHomeAndReload\(\)[\s\S]*location\.assign\(window\.location\.pathname\)/);
    // 엠블럼 파일이 없으면 둥근 SNU 마크로 떨어진다.
    assert.match(html, /id="brand-logo-fallback"/);
    assert.match(css, /\.brand-logo-img\s*\{/);
    assert.match(css, /\.brand-university-name\s*\{/);
});

test('the left rail labels related pages and shows a full live clock', async () => {
    const html = await readFile('index.html', 'utf8');
    const css = await readFile('css/core.css', 'utf8');
    const app = await readFile('js/core.js', 'utf8');

    assert.match(html, /class="rail-section-label">관련 페이지</);
    assert.match(
        html,
        /id="left-brand-rail"[^>]*draggable="false"[^>]*ondragstart="return false"/s
    );
    assert.match(
        css,
        /\.brand-rail,\s*\.brand-rail \*\s*\{[^}]*-webkit-user-drag:\s*none;[^}]*user-select:\s*none;/s
    );
    assert.match(html, /id="rail-clock-time"/);
    assert.match(html, /id="rail-clock-date"/);
    assert.match(css, /\.rail-clock\s*\{[^}]*margin-top:\s*auto/s);
    assert.match(app, /function updateRailClock/);
    assert.match(app, /second:\s*'2-digit'/);
    assert.match(app, /weekday:\s*'long'/);
    assert.match(app, /setInterval\(updateRailClock,\s*1000\)/);
});

test('view modules register themselves and only one is active at a time', async () => {
    const core = await readFile('js/core.js', 'utf8');
    const desktop = await readFile('js/desktop.js', 'utf8');
    const mobile = await readFile('js/mobile.js', 'utf8');

    const source = readNamedFunction(core, 'applyViewModule');
    const context = { viewModules: new Map() };
    const log = [];
    context.viewModules.set('desktop', {
        activate: () => log.push('desktop:on'),
        deactivate: () => log.push('desktop:off')
    });
    context.viewModules.set('mobile', {
        activate: () => log.push('mobile:on'),
        deactivate: () => log.push('mobile:off')
    });
    runInNewContext(
        `let activeViewModule = null; ${source}; this.applyViewModule = applyViewModule;`,
        context
    );

    context.applyViewModule('desktop');
    context.applyViewModule('mobile');
    assert.deepEqual(log, ['desktop:on', 'desktop:off', 'mobile:on']);

    assert.match(desktop, /registerViewModule\('desktop'/);
    assert.match(mobile, /registerViewModule\('mobile'/);
    // 비교 UI는 데스크탑에서만 쓴다.
    assert.match(desktop, /supportsCompare:\s*true/);
    assert.match(mobile, /supportsCompare:\s*true/);
    assert.match(desktop, /handleNoticeCardArrowKey\(event\)/);
    assert.match(mobile, /handleNoticeCardArrowKey\(event\)/);
});

test('the notice title is assembled from a fixed template instead of free text', async () => {
    const html = await readFile('admin.html', 'utf8');
    const admin = await readFile('js/admin.js', 'utf8');

    // 저장되는 제목은 hidden 필드이고, 사람이 채우는 건 양식 세 칸이다.
    assert.match(html, /<input type="hidden" id="post-title">/);
    for (const id of ['title-host', 'title-subject', 'title-kind', 'post-title-manual', 'title-manual']) {
        assert.match(html, new RegExp(`id="${id}"`));
    }
    // 만들어진 제목이 보이는 상자가 곧 고치는 상자다. 별도 입력칸을 두지 않는다.
    assert.match(html, /class="title-preview is-empty" id="post-title-manual"[\s\S]*readonly/);
    assert.doesNotMatch(html, /id="title-preview"/);
    assert.match(readNamedFunction(admin, 'onTitleManualToggle'), /box\.readOnly = !manual/);

    const composeSource = readNamedFunction(admin, 'composeNoticeTitle');
    const values = {
        'title-host': '학생회',
        'title-host-custom': '',
        'title-subject': '개강총회 참가자',
        'title-kind': '모집',
        'post-title-manual': '직접 쓴 제목'
    };
    const context = {
        document: { getElementById: id => ({ value: values[id], checked: false }) },
        isTitleManual: () => false,
        getSelectedTitleHost: () => values['title-host']
    };
    runInNewContext(`${composeSource}; this.composeNoticeTitle = composeNoticeTitle;`, context);
    assert.equal(context.composeNoticeTitle(), '[학생회] 개강총회 참가자 모집');

    values['title-subject'] = '';
    assert.equal(context.composeNoticeTitle(), '');

    // 수정 화면에서 기존 제목을 양식으로 되돌려 읽을 수 있어야 한다.
    assert.match(admin, /function applyTitleToBuilder/);
    assert.match(admin, /TITLE_KINDS/);
});

test('admin compose accepts pasted clipboard images alongside file uploads', async () => {
    const html = await readFile('admin.html', 'utf8');
    const admin = await readFile('js/admin.js', 'utf8');

    assert.match(html, /id="paste-dropzone"/);
    assert.match(html, /id="paste-preview"/);
    assert.match(admin, /function handleImagePaste/);
    assert.match(admin, /clipboardData/);
    assert.match(admin, /startsWith\('image\/'\)/);
    // 붙여넣은 이미지가 저장 이미지에 합쳐져야 한다.
    const saveSource = admin.slice(admin.indexOf('async function generateAIAndSave'), admin.indexOf('async function loadAdminNoticeList'));
    assert.match(saveSource, /pastedImages/);
    // 붙여넣기 패널은 제목·본문 어디서 붙여넣어도 받도록 패널 전체에 건다.
    const initSource = admin.slice(admin.indexOf('function initImagePaste'), admin.indexOf('function initImagePaste') + 400);
    assert.match(initSource, /getElementById\('panel-compose'\)/);
    assert.match(initSource, /addEventListener\('paste', handleImagePaste\)/);
});

test('right-rail image errors restore the inquiry fallback', async () => {
    const app = await readFile('js/core.js', 'utf8');
    const fallbackSource = app.match(/function renderRightRailInquiryFallback\(\) \{[\s\S]*?\n\}/)?.[0];

    assert.ok(fallbackSource);
    assert.match(fallbackSource, /openBannerInquiryFromRail\(\)/);
    // 이미지 하나가 깨져도 캐러셀 전체를 버리지 않는다. 살아 있는 배너가
    // 하나도 남지 않았을 때만 홍보 신청 안내로 떨어진다.
    assert.match(app, /onerror="handleBannerImageError\(event\)"/);
    const errorSource = readNamedFunction(app, 'handleBannerImageError');
    assert.match(errorSource, /is-broken/);
    assert.match(errorSource, /alive\.length === 0.*renderRightRailInquiryFallback\(\)/s);
});

test('right-rail banners start randomly, auto-rotate, overlay manual arrows, and swipe on mobile', async () => {
    const html = await readFile('index.html', 'utf8');
    const app = await readFile('js/core.js', 'utf8');
    const css = await readFile('css/core.css', 'utf8');
    const desktopCss = await readFile('css/desktop.css', 'utf8');
    const mobileCss = await readFile('css/mobile.css', 'utf8');
    assert.match(app, /function renderRightRailAd\(\{ restartRotation = true \} = \{\}\)/);
    assert.match(app, /slide\.linkUrl[\s\S]*class="rail-ad-link\b/);
    assert.match(app, /class="rail-ad-image"/);
    assert.match(app, /getBannerSlidesByPlacement\('right_rail'\)\.slice\(0, 5\)/);
    assert.match(app, /Math\.floor\(Math\.random\(\) \* slides\.length\)/);
    assert.match(app, /function stepRightRailBanner/);
    assert.match(app, /이전 배너[\s\S]*다음 배너/);
    assert.match(app, /function startBannerRotation/);
    assert.match(app, /BANNER_ROTATION_DELAY = 6500/);
    assert.match(app, /function startBannerSwipe/);
    assert.match(app, /function moveBannerSwipe/);
    assert.match(app, /function finishBannerSwipe/);
    assert.doesNotMatch(readNamedFunction(app, 'startBannerSwipe'), /getLayoutMode\(\) !== 'mobile'/);
    assert.match(app, /class="rail-ad-image"[\s\S]*draggable="false"/);

    // 트랙 캐러셀: 앞뒤 복제 슬라이드를 덧대 끝에서 끝으로 끊김 없이 이어진다.
    assert.match(app, /class="rail-ad-track"/);
    assert.match(app, /class="rail-ad-slide"/);
    assert.match(app, /isClone: true/);
    // readNamedFunction은 구조 분해 매개변수의 중괄호에서 멈추므로 직접 잘라 쓴다.
    const renderStart = app.indexOf('function renderRightRailAd(');
    const renderSource = app.slice(renderStart, app.indexOf('\nfunction ', renderStart + 1));
    assert.match(renderSource, /usable\[usable\.length - 1\][\s\S]*usable\[0\]/);
    // 손가락을 1:1로 따라가고, 놓으면 가까운 칸으로 붙는다.
    assert.match(readNamedFunction(app, 'moveBannerSwipe'), /dragOffset: deltaX/);
    // 폰에서 한 번에 넘기기 쉽도록 문턱을 낮추고, 짧게 튕기는 손짓도 인정한다.
    const finishSource = readNamedFunction(app, 'finishBannerSwipe');
    assert.match(finishSource, /width \* 0\.12/);
    assert.match(finishSource, /passedThreshold \|\| flicked/);
    // 세로가 확실히 클 때만 가로 끌기를 놓아준다. 조금 흔들렸다고 포기하지 않는다.
    assert.match(readNamedFunction(app, 'moveBannerSwipe'), /Math\.abs\(deltaX\) \* 1\.5/);
    // 복제 칸에 닿으면 전환이 끝난 뒤 진짜 칸으로 소리 없이 되돌린다.
    assert.match(readNamedFunction(app, 'stepRightRailBanner'), /landedOnClone[\s\S]*animate: false/);

    // 레일 세로를 비율로 묶지 않는다. 묶으면 레일 아래가 남색으로 빈다.
    assert.doesNotMatch(css, /\.rail-ad-stage\s*\{[^}]*aspect-ratio/s);
    assert.match(css, /\.rail-ad-stage\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*flex:\s*1 1 auto[^}]*touch-action:\s*pan-y/s);
    assert.match(css, /\.rail-ad-slide\s*\{[^}]*flex:\s*0 0 100%/s);
    assert.match(css, /\.rail-ad-track\s*\{[^}]*display:\s*flex;[^}]*height:\s*100%;[^}]*transition-property:\s*transform/s);
    /* 배너는 자리를 남김없이 채운다. 비율을 지켜 통째로 보이게 하면 남는
       자리가 생기고 그 경계가 테두리처럼 보였다. 권장 비율이 레일과 같으므로
       잘라 채워도 잘려 나가는 부분이 거의 없고, 어긋난 그림은 등록할 때 경고한다. */
    assert.match(css, /\.rail-ad-image\s*\{[^}]*height:\s*100%;[^}]*object-fit:\s*cover[^}]*border:\s*0/s);
    assert.doesNotMatch(css, /rail-ad-backdrop/);
    assert.doesNotMatch(app, /rail-ad-backdrop/);
    assert.doesNotMatch(mobileCss, /rail-ad-backdrop/);
    assert.match(mobileCss, /\.rail-ad-stage\s*\{[^}]*aspect-ratio:\s*16\s*\/\s*9/s);
    assert.match(css, /\.rail-ad-dot\.is-active/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);

    assert.doesNotMatch(renderSource, /slide\.description|자세히 보기|<h2>/);
    assert.doesNotMatch(renderSource, /class="ad-label"/);
    assert.doesNotMatch(html, /class="rail-section-label">학내 홍보</);
    assert.match(css, /#right-rail-ad-content\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*100%/s);
    assert.match(css, /\.rail-ad-viewport\s*\{[^}]*display:\s*flex;[^}]*min-height:\s*100%/s);
    assert.match(desktopCss, /\.rail-right\s*\{[^}]*overflow:\s*hidden/s);
});

test('right rail chooses the smallest numeric order', async () => {
    const app = await readFile('js/core.js', 'utf8');
    const source = app.match(/function getBannerSlidesByPlacement\(placement\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(source);

    const getBannerSlidesByPlacement = new Function(
        'bannerSlides',
        `${source}; return getBannerSlidesByPlacement;`
    )([
        { id: 10, placement: 'right_rail', order: '10' },
        { id: 2, placement: 'right_rail', order: '2' },
        { id: 1, placement: 'header', order: '1' }
    ]);

    assert.equal(getBannerSlidesByPlacement('right_rail')[0].id, 2);
});

test('campus promotion manager captures type, owner, status, and exposure period', async () => {
    const html = await readFile('admin.html', 'utf8');
    const app = await readFile('js/admin.js', 'utf8');

    assert.doesNotMatch(html, /id="header-banner-slides-list"/);
    assert.match(html, /id="right-rail-slides-list"/);
    assert.match(app, /function renderBannerSection/);
    assert.match(app, /new-right_rail-description/);
    assert.match(app, /new-right_rail-link-url/);
    assert.match(app, /new-right_rail-alt-text/);
    assert.match(app, /new-right_rail-expires-at/);
    assert.match(app, /new-right_rail-starts-at/);
    assert.match(app, /new-right_rail-type/);
    assert.match(app, /new-right_rail-owner/);
    assert.match(app, /new-right_rail-status/);
    assert.match(app, /new-right_rail-name/);
    assert.match(app, /async function addNewBannerSlide\(placement\)/);
    assert.match(app, /async function moveBanner\(placement, idx, dir\)/);
    assert.match(html, /id="banner-limit-status"/);
    assert.match(app, /previewBannerUpload/);
    assert.match(app, /최대 5개/);
    assert.match(app, /banner-image-preview/);
});

test('category tabs keep text-sized targets with evenly balanced outer and inner spacing', async () => {
    const css = await readFile('css/core.css', 'utf8');
    const app = await readFile('js/core.js', 'utf8');
    assert.match(css, /\.category-tabs-inner\s*\{[^}]*display:\s*grid;[^}]*justify-content:\s*space-evenly;[^}]*width:\s*100%/s);
    assert.match(css, /\.category-tab\s*\{[^}]*justify-content:\s*flex-start;[^}]*flex:\s*0 0 auto/s);
    assert.match(css, /\.card\.is-filter-entering\s*\{[^}]*opacity:\s*0;[^}]*translateY\(8px\)/s);
    assert.match(app, /function selectCategoryTab[\s\S]*classList\.toggle\('active', selected\)[\s\S]*filterCards\(true\)/);
    assert.doesNotMatch(readNamedFunction(app, 'selectCategoryTab'), /buildCategoryTabs\(\)/);
    assert.match(css, /\.rail-clock strong\s*\{[^}]*font-size:\s*19px/s);
    assert.match(css, /\.rail-clock span\s*\{[^}]*font-size:\s*13px/s);
});

test('desktop notice cards expose a delayed hover preview without enabling it on mobile', async () => {
    const html = await readFile('index.html', 'utf8');
    const app = await readFile('js/core.js', 'utf8');
    const css = await readFile('css/core.css', 'utf8');
    const mobileCss = await readFile('css/mobile.css', 'utf8');

    assert.match(html, /id="notice-hover-preview"/);
    assert.match(app, /function queueNoticeHoverPreview/);
    assert.match(app, /\(hover: hover\) and \(pointer: fine\)/);
    assert.match(app, /\}, 620\);/);
    assert.match(app, /card\.addEventListener\('mouseenter'/);
    assert.match(app, /function noticeHoverPreviewLines/);
    assert.match(app, /AI 3줄 미리보기/);
    assert.match(app, /notice-hover-preview-summary-list/);
    assert.doesNotMatch(readNamedFunction(app, 'renderNoticeHoverPreview'), /<h3>/);
    const context = {};
    runInNewContext(`${readNamedFunction(app, 'noticeHoverPreviewLines')}; this.lines = noticeHoverPreviewLines;`, context);
    assert.deepEqual(Array.from(context.lines({
        aiSummary: ['요약 1', '요약 2'],
        sourceUrl: 'https://ece.snu.ac.kr/notice',
        attachments: [{ name: 'file.pdf' }]
    })), ['요약 1', '요약 2', '출처: 전기·정보공학부 홈페이지 · 첨부파일이 있습니다.']);
    assert.deepEqual(Array.from(context.lines({ aiSummary: [], host: '학생회', attachments: [] })),
        ['AI 요약이 아직 없습니다.', '출처: 학생회', '첨부파일이 없습니다.']);
    assert.match(app, /right-ad-rail/);
    assert.match(css, /\.notice-hover-preview\s*\{[^}]*position:\s*fixed/s);
    assert.match(css, /\.notice-hover-preview-summary-list li\s*\{[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s);
    assert.match(css, /\.notice-hover-preview-summary-list\s*\{[^}]*color:\s*#111827;[^}]*font-size:\s*14px;[^}]*font-weight:\s*600/s);
    assert.match(mobileCss, /\.notice-hover-preview\s*\{\s*display:\s*none !important;/);
});

test('one fixed block keeps the complete base notice flow in the right half', async () => {
    const html = await readFile('index.html', 'utf8');
    const app = await readFile('js/core.js', 'utf8');
    const css = await readFile('css/core.css', 'utf8');
    const queueSource = readNamedFunction(app, 'queueNoticeHoverPreview');
    const dragSource = readNamedFunction(app, 'onNoticeSplitDragStart');
    // readNamedFunction은 구조 분해 매개변수의 중괄호에서 멈추므로 직접 잘라 쓴다.
    const showDropStart = app.indexOf('function showSplitDropOverlay(');
    const showDropSource = app.slice(showDropStart, app.indexOf('\nfunction ', showDropStart + 1));
    const filterSource = readNamedFunction(app, 'renderNoticeCards');

    assert.doesNotMatch(html, /id="split-notice-more"|showMoreSplitNotices/);
    assert.match(queueSource, /noticeDragInProgress \|\| activeNoticeSplitDragId/);
    assert.match(dragSource, /suspendNoticeHoverPreview\(\)/);
    assert.match(dragSource, /classList\.add\('notice-dragging'\)/);
    assert.match(filterSource, /baseNotices\.forEach\(notice =>/);
    assert.doesNotMatch(filterSource, /baseNotices\.slice\(0, 2\)/);
    assert.doesNotMatch(app, /SPLIT_NOTICE_PAGE_SIZE|showMoreSplitNotices|updateSplitNoticeMore/);
    assert.match(css, /body\.notice-dragging \.notice-hover-preview\s*\{[^}]*display:\s*none !important;/s);
    assert.doesNotMatch(css, /\.split-notice-more/);
    assert.match(showDropSource, /compareBlocks\.length >= maxCompareBlocks\(\)/);
    // 이미 놓인 블록을 다시 잡아 옮길 때는 개수 제한을 보지 않는다.
    assert.match(showDropSource, /!ignoreLimit &&/);
    assert.match(app, /showSplitDropOverlay\(\{ ignoreLimit: true \}\)/);
    assert.match(readNamedFunction(app, 'redockCompareBlock'), /compareDockSide = side/);
    assert.match(showDropSource, /overlay\.hidden = false/);
    assert.match(css, /\.split-drop-overlay\s*\{[^}]*position:\s*fixed;[^}]*top:\s*16px/s);
});

test('banner manager omits an untouched expiry so storage preserves it', async () => {
    const app = await readFile('js/admin.js', 'utf8');
    const source = app.match(/function resolveUpdateExpiresAt\(input\) \{[\s\S]*?\n\}/)?.[0];

    assert.ok(source);
    const resolveUpdateExpiresAt = new Function(`${source}; return resolveUpdateExpiresAt;`)();
    const originalIso = '2030-04-05T06:07:08.987Z';

    assert.equal(
        resolveUpdateExpiresAt({
            value: '2030-04-05T06:07',
            dataset: {
                originalExpiresAt: originalIso,
                originalLocalValue: '2030-04-05T06:07'
            }
        }),
        ''
    );
    assert.equal(
        resolveUpdateExpiresAt({
            value: '2030-04-05T06:08',
            dataset: {
                originalExpiresAt: originalIso,
                originalLocalValue: '2030-04-05T06:07'
            }
        }),
        new Date('2030-04-05T06:08').toISOString()
    );

    const originalOffsetIso = '2030-04-05T15:07:08.987+09:00';
    assert.equal(
        resolveUpdateExpiresAt({
            value: '2030-04-05T15:07',
            dataset: {
                originalExpiresAt: originalOffsetIso,
                originalLocalValue: '2030-04-05T15:07'
            }
        }),
        ''
    );

    const updateSource = app.slice(
        app.indexOf('async function updateBannerSlide(slideId)'),
        app.indexOf('\nasync function moveBanner(', app.indexOf('async function updateBannerSlide(slideId)'))
    );
    assert.match(updateSource, /expiresAt\s*\n\s*\}\)/);
    assert.doesNotMatch(updateSource, /expiresAt:\s*expiresAt\s*\?\s*new Date\(expiresAt\)\.toISOString\(\)\s*:\s*''/);
});

test('PWA manifest and service worker include install and push contracts', async () => {
    const manifest = JSON.parse(await readFile('manifest.webmanifest', 'utf8'));
    const worker = await readFile('service-worker.js', 'utf8');

    assert.equal(manifest.display, 'standalone');
    assert.match(manifest.icons[0].src, /app-icon\.svg$/);
    assert.match(worker, /addEventListener\('push'/);
    assert.match(worker, /showNotification/);
    assert.match(worker, /notificationclick/);
    assert.match(worker, /!APP_SHELL\.includes\(url\.pathname\)/);
});

test('service worker replaces the stale app-shell cache during activation', async () => {
    const worker = await readFile('service-worker.js', 'utf8');
    const handlers = {};
    const openedCaches = [];
    const deletedCaches = [];
    const cache = {
        async addAll() {},
        async put() {}
    };
    const context = {
        URL,
        Promise,
        fetch: async () => ({ ok: true, type: 'basic', clone() { return this; } }),
        caches: {
            async open(name) {
                openedCaches.push(name);
                return cache;
            },
            async keys() {
                return ['ece-notices-v1'];
            },
            async delete(name) {
                deletedCaches.push(name);
                return true;
            },
            async match() {
                return null;
            }
        },
        self: {
            location: { origin: 'http://localhost' },
            addEventListener(name, handler) {
                handlers[name] = handler;
            },
            async skipWaiting() {},
            clients: {
                async claim() {},
                async openWindow() {}
            }
        }
    };
    runInNewContext(worker, context);

    let installWork;
    handlers.install({ waitUntil(promise) { installWork = promise; } });
    await installWork;
    let activateWork;
    handlers.activate({ waitUntil(promise) { activateWork = promise; } });
    await activateWork;

    assert.notEqual(openedCaches[0], 'ece-notices-v1');
    assert.deepEqual(deletedCaches, ['ece-notices-v1']);
});

test('service worker loads app-shell files from the network before cached fallback', async () => {
    const worker = await readFile('service-worker.js', 'utf8');
    const handlers = {};
    const calls = [];
    const pendingWrites = [];
    const state = { networkFails: false };
    const cachedResponse = { source: 'cache' };
    const networkResponse = {
        source: 'network',
        ok: true,
        type: 'basic',
        clone() {
            return this;
        }
    };
    const cache = {
        async addAll() {},
        async put() {}
    };
    const context = {
        URL,
        Promise,
        async fetch() {
            calls.push('network');
            if (state.networkFails) throw new Error('offline');
            return networkResponse;
        },
        caches: {
            async open() {
                return cache;
            },
            async keys() {
                return [];
            },
            async delete() {
                return true;
            },
            async match() {
                calls.push('cache');
                return cachedResponse;
            }
        },
        self: {
            location: { origin: 'http://localhost' },
            addEventListener(name, handler) {
                handlers[name] = handler;
            },
            async skipWaiting() {},
            clients: {
                async claim() {},
                async openWindow() {}
            }
        }
    };
    runInNewContext(worker, context);

    const request = { method: 'GET', url: 'http://localhost/css/core.css' };
    let responseWork;
    handlers.fetch({
        request,
        respondWith(promise) {
            responseWork = promise;
        },
        waitUntil(promise) {
            pendingWrites.push(promise);
        }
    });
    assert.equal((await responseWork).source, 'network');
    assert.deepEqual(calls, ['network']);
    await Promise.all(pendingWrites);

    calls.length = 0;
    state.networkFails = true;
    handlers.fetch({
        request,
        respondWith(promise) {
            responseWork = promise;
        },
        waitUntil(promise) {
            pendingWrites.push(promise);
        }
    });
    assert.equal((await responseWork).source, 'cache');
    assert.deepEqual(calls, ['network', 'cache']);
});

test('expired notices use a neutral card and badge state in list and detail views', async () => {
    const app = await readFile('js/core.js', 'utf8');
    const css = await readFile('css/core.css', 'utf8');
    const listStart = app.indexOf('function renderNoticeCards(');
    const detailStart = app.indexOf('async function openDetail');
    const compareStart = app.indexOf('function renderCompareSpace');
    const datePresentation = readNamedFunction(app, 'getNoticeDatePresentation');

    assert.match(app, /isExpired:\s*true/);
    assert.match(app, /card-expired/);
    assert.ok(listStart > 0 && detailStart > listStart && compareStart > detailStart);
    assert.match(datePresentation, /dDay\.isExpired\s*\?\s*'expired'/);
    assert.match(app.slice(listStart, detailStart), /datePresentation\.badgeClass/);
    assert.match(app.slice(detailStart, compareStart), /datePresentation\.badgeClass/);
    assert.match(app.slice(compareStart), /compare-col-kicker[\s\S]*datePresentation\.badgeText/);
    assert.match(css, /\.card\.card-expired\s*\{/);
    assert.match(css, /\.tags \.tag\.expired\s*\{/);
    assert.match(css, /\.card\.is-archived\s*\{[^}]*opacity\s*:/s);
    assert.doesNotMatch(css, /\.card\.card-expired[^{]*\{[^}]*opacity\s*:/s);
    assert.doesNotMatch(css, /\.card\.card-expired[^{]*\{[^}]*text-decoration\s*:/s);
});

test('calcDDay uses calendar-day states for permanent, urgent, and expired notices', async () => {
    const app = await readFile('js/core.js', 'utf8');
    const calendarDayDifferenceSource = app.match(/function getCalendarDayDifference\([^)]*\) \{[\s\S]*?\r?\n\}/)?.[0];
    const calcDDaySource = app.match(/function calcDDay\(deadlineStr\) \{[\s\S]*?\r?\n\}/)?.[0];
    assert.ok(calendarDayDifferenceSource);
    assert.ok(calcDDaySource);

    const onDeadlineDate = new Function(
        'getCurrentDate',
        `${calendarDayDifferenceSource}\n${calcDDaySource}; return calcDDay;`
    )(() => new Date('2026-07-27T00:00:00'));
    const followingDate = new Function(
        'getCurrentDate',
        `${calendarDayDifferenceSource}\n${calcDDaySource}; return calcDDay;`
    )(() => new Date('2026-07-28T00:00:00'));

    assert.deepEqual(onDeadlineDate(null), {
        text: '상시', isUrgent: false, isD1: false, isExpired: false
    });
    assert.equal(onDeadlineDate('2026-07-27').isUrgent, true);
    assert.equal(onDeadlineDate('2026-07-27').isExpired, false);
    assert.equal(followingDate('2026-07-27').isExpired, true);
    assert.equal(followingDate('2026-07-27').isUrgent, false);
    assert.equal(onDeadlineDate('2026-07-30').isUrgent, true);
    assert.equal(onDeadlineDate('2026-07-31').isUrgent, false);
    assert.match(calendarDayDifferenceSource, /Date\.UTC/);
});

test('deadline-status filtering excludes expired notices from urgent results', async () => {
    const app = await readFile('js/core.js', 'utf8');
    const deadlineStatusSource = app.match(/function matchesDeadlineStatus\([^)]*\) \{[\s\S]*?\r?\n\}/)?.[0];
    assert.ok(deadlineStatusSource);
    const matchesDeadlineStatus = new Function(
        `${deadlineStatusSource}; return matchesDeadlineStatus;`
    )();

    const expired = { isUrgent: false, isExpired: true };
    assert.equal(matchesDeadlineStatus('마감임박', expired, true), false);
    assert.equal(matchesDeadlineStatus('마감됨', expired, true), true);
});

test('notice filtering and sorting are requested from the server before cards render', async () => {
    const app = await readFile('js/core.js', 'utf8');
    const filtersSource = readNamedFunction(app, 'getNoticeListFilters');
    const requestSource = readNamedFunction(app, 'filterCards');
    const renderSource = readNamedFunction(app, 'renderNoticeCards');
    assert.match(filtersSource, /sort:\s*filterState\.sort/);
    assert.match(requestSource, /loadNoticePage\(requestedPage\)/);
    assert.match(filtersSource, /urgent:\s*quickNoticeFilters\.urgent/);
    assert.match(filtersSource, /reward:\s*quickNoticeFilters\.reward/);
    assert.match(filtersSource, /action:\s*quickNoticeFilters\.action/);
    assert.match(filtersSource, /past:\s*quickNoticeFilters\.past/);
    assert.doesNotMatch(renderSource, /\.sort\(/);
    const syncUrlSource = readNamedFunction(app, 'syncNoticeListUrl');
    const clearNoticeUrlSource = readNamedFunction(app, 'clearNoticeUrl');
    assert.doesNotMatch(syncUrlSource, /delete\('id'\)/);
    assert.match(clearNoticeUrlSource, /params\.delete\(NOTICE_URL_PARAM\)/);
});

test('student year defaults to all without interrupting first visit', async () => {
    const html = await readFile('index.html', 'utf8');
    const app = await readFile('js/core.js', 'utf8');
    const css = await readFile('css/core.css', 'utf8');

    const searchMarkup = html.slice(
        html.indexOf('<div class="search-container">'),
        html.indexOf('<!-- 고급 필터 토글 바 -->')
    );
    const filterMarkup = html.slice(
        html.indexOf('<div class="filter-panel"'),
        html.indexOf('<div class="notice-results-toolbar"')
    );
    assert.doesNotMatch(searchMarkup, /id="targetFilter"/);
    assert.match(filterMarkup, /id="targetFilter"/);
    assert.match(filterMarkup, /id="targetFilter"[\s\S]*<option value="전체">전체 학번<\/option>/);
    assert.doesNotMatch(html, /id="student-year-modal"/);
    assert.doesNotMatch(app, /STUDENT_YEAR_PROMPTED_KEY|preferredStudentYear|saveStudentYearPreference|skipStudentYearPreference/);
    assert.doesNotMatch(app, /preferredNotices[\s\S]*otherNotices|is-outside-student-target/);
    assert.doesNotMatch(css, /\.card\.is-outside-student-target/);
});

test('public filters omit image presence, empty states stay simple, and the footer exposes quiet utility links', async () => {
    const html = await readFile('index.html', 'utf8');
    const app = await readFile('js/core.js', 'utf8');
    const css = await readFile('css/core.css', 'utf8');
    const listFilters = readNamedFunction(app, 'getNoticeListFilters');
    const emptyState = readNamedFunction(app, 'renderNoticeEmptyState');

    assert.doesNotMatch(html, /id="fg-has-image"|이미지 있음|이미지 없음/);
    assert.doesNotMatch(listFilters, /hasImage|has-image/);
    assert.match(emptyState, /해당하는 공지가 없습니다/);
    assert.doesNotMatch(emptyState, /resetAllFilters|필터 모두 해제/);
    assert.match(html, /class="site-footer"/);
    // 링크 그리드는 서비스 / 문의 / 바로가기 / 운영 네 갈래로 나뉜다.
    assert.match(html, /알림 설정[\s\S]*일반 문의[\s\S]*홍보 신청[\s\S]*이용약관/);
    // 관리자 진입점은 주 링크 목록이 아니라 법적 고지 줄의 최소 버튼으로만 남는다.
    assert.match(html, /class="footer-admin-link"[\s\S]*rel="nofollow"/);
    assert.doesNotMatch(html, /관리자 페이지/);
    assert.match(css, /\.site-footer\s*\{[^}]*color:\s*#8a919d/s);
});

test('image notices lazy-load a poster; imageless notices show a big title poster', async () => {
    const app = await readFile('js/core.js', 'utf8');
    const start = app.indexOf('function renderNoticeCards(');
    const end = app.indexOf('\nfunction navImage(', start);
    const filterCardsSource = app.slice(start, end);

    // 사진 있는 카드: 지연 로드 포스터.
    assert.match(filterCardsSource, /class="card-poster"/);
    assert.match(filterCardsSource, /data-thumbnail-src=/);
    assert.match(filterCardsSource, /notice\.thumbnailUrl\s*\|\|\s*['"]\/icons\/default-notice-thumbnail\.png['"]/);
    // 사진 없는 카드: 포스터 자리에 제목을 크게.
    assert.match(filterCardsSource, /card-poster is-text/);
    // 포스터 제목은 renderPosterTitle이 통째로 만든다(길이에 맞춘 크기 포함).
    // 학생회 홍보물 결: 가로줄 - 제목 - 날짜 순으로 쌓는다.
    assert.match(filterCardsSource, /card-poster is-text[\s\S]*?card-poster-rule[\s\S]*?renderPosterTitle\(rawTitle\)[\s\S]*?card-poster-date/);
    // 공개 화면에서 등록일을 없앴으므로 마감일이 없으면 날짜 칸이 비어 있다.
    // 빈 칸을 그리면 포스터 아래에 빈 줄만 남으므로 아예 넣지 않는다.
    assert.match(filterCardsSource, /datePresentation\.dateLabel\s*\?\s*`<span class="card-poster-date"/);
    assert.match(readNamedFunction(app, 'renderPosterTitle'), /--poster-title-size:\$\{fit\.size\}px/);
    assert.match(filterCardsSource, /renderPosterTitle\(rawTitle\)/);
    // 줄 나누기는 글자 폭 계산에 기대므로 함께 넣어 준다.
    const posterWidthSource = readNamedFunction(app, 'posterTextWidth');
    const posterLinesSource = readNamedFunction(app, 'posterTitleLines');
    const posterTitleLines = new Function(
        `${posterWidthSource}; ${posterLinesSource}; return posterTitleLines;`
    )();
    // 알파벳은 한글보다 좁으므로 같은 글자 수라도 폭이 작게 잡혀야 한다.
    const posterTextWidth = new Function(`${posterWidthSource}; return posterTextWidth;`)();
    assert.ok(posterTextWidth('가나다') > posterTextWidth('abc'));
    assert.deepEqual(
        posterTitleLines('[화생회] WE–Meet Project 참가자 모집'),
        ['[화생회]', 'WE–Meet Project', '참가자 모집']
    );
    // 날짜 표시는 공통 규칙을, 본문 발췌는 요약을 쓴다.
    assert.match(filterCardsSource, /getNoticeDatePresentation/);
    assert.match(filterCardsSource, /card-excerpt/);
});

test('notice detail supports inline image navigation, image copying, and a shadowed body', async () => {
    const html = await readFile('index.html', 'utf8');
    const app = await readFile('js/core.js', 'utf8');
    const css = await readFile('css/core.css', 'utf8');

    assert.match(html, /id="detail-image-prev"[^>]*onclick="navDetailImage\(-1, event\)"/);
    assert.match(html, /id="detail-image-next"[^>]*onclick="navDetailImage\(1, event\)"/);
    assert.match(html, /id="detail-image-counter"/);
    assert.match(html, /id="viewer-copy-btn"[^>]*onclick="copyCurrentViewerImage\(event\)"/);
    assert.match(html, /id="viewer-img"[^>]*title="우클릭으로도 이미지를 복사할 수 있습니다"/s);
    assert.match(html, /class="overlay image-viewer"[^>]*role="dialog"/);
    assert.match(html, /class="image-viewer-stage"[\s\S]*ontouchstart="startImageSwipe\(event\)"[\s\S]*ontouchend="endImageSwipe\(event, 'viewer'\)"/);
    assert.match(html, /id="detail-hero"[\s\S]*ontouchend="endImageSwipe\(event, 'detail'\)"/);
    assert.match(app, /function updateDetailImage/);
    assert.match(app, /function copyCurrentViewerImage/);
    assert.match(app, /function startImageSwipe/);
    assert.match(app, /function endImageSwipe/);
    assert.match(app, /new ClipboardItem\(\{ 'image\/png': pngBlob \}\)/);
    assert.match(css, /\.original-text-box\s*\{[^}]*box-shadow:\s*0 8px 24px/s);
    assert.match(css, /\.image-viewer-toolbar\s*\{/);
    assert.match(css, /\.image-viewer-stage\s*\{/);
    assert.match(css, /\.image-viewer-action\s*,\s*\.image-viewer-close\s*\{/s);
    assert.doesNotMatch(html, /id="image-viewer-modal"[^>]*style=/);

    const source = readNamedFunction(app, 'navDetailImage');
    const result = new Function(`
        let detailImageArray = ['one', 'two', 'three'];
        let detailImageIndex = 0;
        let updates = 0;
        function updateDetailImage() { updates += 1; }
        ${source}
        navDetailImage(-1);
        const wrappedBack = detailImageIndex;
        navDetailImage(1);
        navDetailImage(1);
        return { wrappedBack, current: detailImageIndex, updates };
    `)();
    assert.deepEqual(result, { wrappedBack: 2, current: 1, updates: 3 });
});

test('notice cards keep a baseline height but expand instead of clipping titles', async () => {
    const app = await readFile('js/core.js', 'utf8');
    const css = await readFile('css/core.css', 'utf8');

    assert.match(css, /\.grid\s*\{[^}]*display:\s*grid/s);
    // 짧은 카드는 기준 높이를 유지하고 긴 제목이 오면 아래로 늘어난다.
    assert.match(css, /\.card\s*\{[^}]*min-height:\s*440px;[^}]*height:\s*auto/s);
    assert.match(css, /\.card-title\s*\{[^}]*display:\s*block;[^}]*overflow-wrap:\s*anywhere/s);
    // 포스터는 고정 높이, 사진은 cover.
    assert.match(css, /\.card-poster\s*\{[^}]*height:\s*216px/s);
    assert.match(css, /\.card-img-preview\s*\{[^}]*object-fit:\s*cover/s);
    // 사진 없는 카드는 큰 제목을 보여준다.
    // 글자 크기는 제목 길이에 따라 정해지고, 계산이 어긋나도 상자를 넘지 않는다.
    assert.match(css, /\.card-poster-title\s*\{[^}]*font-family:\s*'Pretendard'[^}]*font-size:\s*calc\(var\(--poster-title-size/s);
    assert.match(css, /\.card-poster-title\s*\{[^}]*max-height:\s*100%;[^}]*overflow:\s*hidden/s);
    const fitSource = readNamedFunction(app, 'posterTitleFit');
    const posterTitleFit = new Function(`${fitSource}; return posterTitleFit;`)();
    // 어떤 길이가 와도 줄 수 x 줄 높이가 포스터 안쪽(약 172px)을 넘지 않아야 한다.
    for (const length of [8, 22, 23, 36, 37, 52, 53, 120]) {
        const fit = posterTitleFit(length);
        assert.ok(fit.maxLines * fit.size * 1.34 <= 172,
            `${length}자에서 ${fit.maxLines}줄 x ${fit.size}px가 포스터를 넘칩니다`);
    }
    assert.match(css, /\.card-poster-title-line\.is-host\s*\{/);
    assert.match(css, /\.card-excerpt\s*\{[^}]*-webkit-line-clamp:\s*2/s);
    assert.match(app, /class="notice-empty-state"/);
    assert.doesNotMatch(css, /\.grid\s*\{[^}]*column-count/s);
    // 공지 그리드의 열 수는 뷰별 파일이 정한다. core에 남아 있으면 두 모드가 서로를 덮어쓴다.
    assert.doesNotMatch(css, /(^|\})\s*\.grid\s*\{[^}]*grid-template-columns/s);
});

test('column counts live in the per-view layers, not in core', async () => {
    const desktop = await readFile('css/desktop.css', 'utf8');
    const mobile = await readFile('css/mobile.css', 'utf8');

    assert.match(desktop, /html\[data-view="desktop"\] \.grid\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/s);
    assert.match(desktop, /@media \(max-width:\s*1500px\)[\s\S]*grid-template-columns:\s*repeat\(2/);
    assert.doesNotMatch(desktop, /grid-template-columns:\s*repeat\(3/);
    assert.match(mobile, /html\[data-view="mobile"\] \.grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
    assert.match(mobile, /html\[data-view="mobile"\] \.category-tabs\s*\{[^}]*overflow:\s*hidden/s);
    // 칸 수를 못 박지 않는다. 카테고리가 늘거나 줄어도 저절로 고르게 나뉜다.
    assert.match(mobile, /html\[data-view="mobile"\] \.category-tabs-inner\s*\{[^}]*grid-auto-flow:\s*column;[^}]*grid-auto-columns:\s*minmax\(0, 1fr\)/s);
    assert.match(mobile, /@media \(max-width:\s*420px\)[\s\S]*\.category-tabs-inner\s*\{[^}]*width:\s*100%/s);
    assert.match(desktop, /\.spatial-workspace\.is-split\[data-blocks="1"\] \.notice-base-block > \.grid\s*\{[^}]*repeat\(2,/s);
    assert.doesNotMatch(mobile, /\.notice-base-block \.grid,\s*\nhtml\[data-view="mobile"\] \.compare-space-stage/);
    assert.match(mobile, /\.image-viewer-action\s*\{[^}]*min-height:\s*38px/s);
    assert.match(mobile, /\.image-viewer \.nav-btn\.left\s*\{[^}]*left:\s*8px/s);
    // 모바일에서는 고정 레일이 화면을 덮으면 안 된다.
    assert.match(mobile, /html\[data-view="mobile"\] \.rail-right\s*\{[^}]*position:\s*static/s);
});

test('notice paging loads one page at a time without duplicate summaries', async () => {
    const app = await readFile('js/core.js', 'utf8');
    const source = readNamedFunction(app, 'createNoticeRepository');
    const context = { URLSearchParams };
    runInNewContext(`${source}; this.createNoticeRepository = createNoticeRepository;`, context);
    const requestedPaths = [];
    const responses = {
        '/api/notices?page=1&limit=16': {
            notices: [{ id: 1, title: 'one' }, { id: 2, title: 'two' }],
            pagination: { page: 1, limit: 16, total: 3, totalPages: 2 }
        },
        '/api/notices?page=2&limit=16': {
            notices: [{ id: 2, title: 'two again' }, { id: 3, title: 'three' }],
            pagination: { page: 2, limit: 16, total: 3, totalPages: 2 }
        }
    };
    const repository = context.createNoticeRepository(async path => {
        requestedPaths.push(path);
        return responses[path];
    });

    await repository.loadPage(1, { replace: true });
    await repository.loadPage(2);

    assert.deepEqual(requestedPaths, [
        '/api/notices?page=1&limit=16',
        '/api/notices?page=2&limit=16'
    ]);
    assert.deepEqual(
        Array.from(repository.notices, notice => notice.id),
        [1, 2, 3]
    );
    assert.deepEqual(
        { ...repository.pagination },
        { page: 2, limit: 16, total: 3, totalPages: 2 }
    );
});

test('lazy notice detail shares an in-flight request and upgrades its summary', async () => {
    const app = await readFile('js/core.js', 'utf8');
    const source = readNamedFunction(app, 'createNoticeRepository');
    const context = { URLSearchParams };
    runInNewContext(`${source}; this.createNoticeRepository = createNoticeRepository;`, context);
    const requestedPaths = [];
    const repository = context.createNoticeRepository(async path => {
        requestedPaths.push(path);
        if (path === '/api/notices?page=1&limit=16') {
            return {
                notices: [{ id: 7, title: 'summary' }],
                pagination: { page: 1, limit: 16, total: 1, totalPages: 1 }
            };
        }
        return {
            notice: {
                id: 7,
                title: 'summary',
                content: 'full body',
                images: ['data:image/png;base64,image']
            }
        };
    });
    await repository.loadPage(1, { replace: true });

    const [first, second] = await Promise.all([
        repository.getDetail(7),
        repository.getDetail(7)
    ]);

    assert.equal(first.content, 'full body');
    assert.equal(second, first);
    assert.equal(repository.notices[0].content, 'full body');
    assert.deepEqual(requestedPaths, [
        '/api/notices?page=1&limit=16',
        '/api/notices/7'
    ]);
});

test('notice pagination renders previous, numbered, and next page controls', async () => {
    const html = await readFile('index.html', 'utf8');
    const app = await readFile('js/core.js', 'utf8');
    assert.match(html, /id="notice-page-prev"/);
    assert.match(html, /id="notice-page-numbers"/);
    assert.match(html, /id="notice-page-next"/);
    assert.match(html, /id="notice-page-prev"[\s\S]*?&lt;<\/button>/);
    assert.match(html, /id="notice-page-next"[\s\S]*?&gt;<\/button>/);
    assert.doesNotMatch(html, /onclick="goToPreviousNoticePage\(\)">이전<\/button>/);
    assert.doesNotMatch(html, /onclick="goToNextNoticePage\(\)">다음<\/button>/);
    assert.match(app, /async function goToNoticePage/);
    assert.doesNotMatch(html, /notice-load-more|더 보기|notice-scroll-sentinel/);

    const source = readNamedFunction(app, 'updateNoticePaginationUI');
    const previous = { disabled: false };
    const next = { disabled: false };
    const numbers = { innerHTML: '' };
    const status = { textContent: '' };
    const container = { hidden: false };
    const context = {
        document: {
            getElementById(id) {
                if (id === 'notice-page-prev') return previous;
                if (id === 'notice-page-next') return next;
                if (id === 'notice-page-numbers') return numbers;
                if (id === 'notice-page-status') return status;
                if (id === 'notice-pagination') return container;
                return null;
            }
        }
    };
    runInNewContext(`${source}; this.updateNoticePaginationUI = updateNoticePaginationUI;`, context);

    context.updateNoticePaginationUI(
        { page: 3, totalPages: 8, total: 153 },
        false
    );
    assert.equal(previous.disabled, false);
    assert.equal(next.disabled, false);
    assert.equal(numbers.hidden, false);
    assert.match(numbers.innerHTML, /aria-current="page"[\s\S]*>3<\/button>/);
    assert.equal(status.textContent, '3 / 8 페이지 · 전체 153건');

    context.updateNoticePaginationUI({ page: 1, totalPages: 8, total: 153 }, true);
    assert.equal(previous.disabled, true);
    assert.equal(next.disabled, true);
    assert.match(numbers.innerHTML, /disabled/);

    context.updateNoticePaginationUI({ page: 1, totalPages: 1, total: 3 }, false);
    assert.equal(previous.hidden, true);
    assert.equal(numbers.hidden, true);
    assert.equal(next.hidden, true);

    context.updateNoticePaginationUI({ page: 1, totalPages: 0, total: 0 }, false);
    assert.equal(container.hidden, true);
    assert.equal(status.textContent, '');
});

test('public startup fetches the notice list once and avoids forced layout during card transitions', async () => {
    const app = await readFile('js/core.js', 'utf8');
    const server = await readFile('server/server.js', 'utf8');
    const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
    const loadDataSource = readNamedFunction(app, 'loadData');
    const renderCardsSource = readNamedFunction(app, 'renderNoticeCards');
    const startupSource = app.slice(app.indexOf("document.addEventListener('DOMContentLoaded'"));

    assert.doesNotMatch(loadDataSource, /loadNoticePage/);
    assert.match(loadDataSource, /Promise\.all\(\[settingsTask, loadBannerSlides\(\)\]\)/);
    assert.match(startupSource, /Promise\.all\(\[loadData\(\), loadCategories\(\)\]\)/);
    assert.match(startupSource, /await filterCards\(false, initialNoticePage\)/);
    assert.doesNotMatch(renderCardsSource, /offsetWidth|offsetHeight/);
    assert.equal(typeof packageJson.dependencies.compression, 'string');
    assert.match(server, /import compression from 'compression'/);
    assert.match(server, /app\.use\(compression\(\{ threshold: 1024 \}\)\)/);
});

test('notice viewport loader defers thumbnails until they intersect', async () => {
    const app = await readFile('js/core.js', 'utf8');
    const source = readNamedFunction(app, 'createNoticeViewportLoader');
    const observers = [];
    class FakeIntersectionObserver {
        constructor(callback, options) {
            this.callback = callback;
            this.options = options;
            this.observed = [];
            this.unobserved = [];
            observers.push(this);
        }
        observe(target) {
            this.observed.push(target);
        }
        unobserve(target) {
            this.unobserved.push(target);
        }
        disconnect() {}
        emit(target, isIntersecting = true) {
            return this.callback([{ target, isIntersecting }]);
        }
    }
    const context = {};
    runInNewContext(`${source}; this.createNoticeViewportLoader = createNoticeViewportLoader;`, context);
    const loader = context.createNoticeViewportLoader({
        IntersectionObserverCtor: FakeIntersectionObserver,
        resolveUrl: value => `https://api.example.test${value}`,
        defaultUrl: '/icons/default-notice-thumbnail.png'
    });
    const listeners = {};
    const image = {
        dataset: { thumbnailSrc: '/api/notices/7/thumbnail?v=1' },
        src: '',
        addEventListener(type, callback) {
            listeners[type] = callback;
        }
    };

    loader.observeThumbnail(image);
    assert.equal(image.src, '');
    assert.equal(observers[0].observed[0], image);

    observers[0].emit(image, false);
    assert.equal(image.src, '');

    observers[0].emit(image, true);
    assert.equal(image.src, 'https://api.example.test/api/notices/7/thumbnail?v=1');
    assert.equal(image.dataset.thumbnailSrc, undefined);
    assert.equal(observers[0].unobserved[0], image);

    listeners.error();
    assert.equal(image.src, '/icons/default-notice-thumbnail.png');
});

test('Cloudflare scheduled worker triggers the protected crawl endpoint', async () => {
    const worker = (await import('../cloudflare/crawl-worker.js')).default;
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        return { ok: true, status: 200 };
    };
    try {
        const pending = [];
        worker.scheduled({}, {
            API_BASE_URL: 'https://api.example.test/',
            CRAWL_TRIGGER_SECRET: 'secret'
        }, {
            waitUntil(promise) {
                pending.push(promise);
            }
        });
        await Promise.all(pending);
    } finally {
        globalThis.fetch = originalFetch;
    }

    assert.equal(calls.length, 1);
    assert.equal(
        calls[0].url,
        'https://api.example.test/api/internal/crawl/ece-academics'
    );
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.headers['x-crawl-secret'], 'secret');
});

test('the admin console is usable on a phone and keeps AI editing in reach', async () => {
    const adminCss = await readFile('css/admin.css', 'utf8');
    const loginCss = await readFile('css/admin-login.css', 'utf8');
    const html = await readFile('admin.html', 'utf8');
    const admin = await readFile('js/admin.js', 'utf8');

    // 폰 폭에서 여러 열 배치를 한 열로 푼다.
    assert.match(adminCss, /@media \(max-width: 760px\)/);
    const phoneLayer = adminCss.slice(adminCss.indexOf('@media (max-width: 760px)'));
    assert.match(phoneLayer, /\.review-layout\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/);
    assert.match(phoneLayer, /\.review-editor-grid\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/);
    assert.match(phoneLayer, /\.title-builder-grid,[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\)/);
    // 탭은 줄바꿈으로 쌓이지 않고 가로로 밀린다.
    assert.match(phoneLayer, /\.admin-tabs\s*\{[\s\S]*?overflow-x:\s*auto/);
    // AI 자동 편집은 스크롤과 무관하게 늘 보여야 한다.
    assert.match(phoneLayer, /\.analyze-bar\s*\{[\s\S]*?position:\s*sticky;[\s\S]*?bottom:\s*8px/);
    assert.match(phoneLayer, /\.analyze-bar \.btn\s*\{[\s\S]*?min-height:\s*50px/);
    // 손가락으로 누를 수 있는 크기.
    assert.match(phoneLayer, /\.admin-tab\s*\{[\s\S]*?min-height:\s*44px/);

    // 로그인 화면도 폰에서 그대로 쓸 수 있어야 한다.
    assert.match(loginCss, /@media \(max-width: 520px\)/);
    assert.match(loginCss, /input:not\(\[type="radio"\]\)\s*\{[^}]*font-size:\s*16px/);

    // 직책을 고르는 자리가 로그인 화면에 있다.
    const loginHtml = await readFile('admin-login.html', 'utf8');
    for (const role of ['notice', 'banner', 'master']) {
        assert.match(loginHtml, new RegExp(`name="admin-role" value="${role}"`));
    }

    // 역할별로 열리는 탭이 코드에 못박혀 있다.
    assert.match(admin, /master: \['review', 'backfill', 'compose', 'notices', 'banner', 'banner-inquiry', 'feedback', 'analytics', 'settings'\]/);
    assert.match(admin, /notice: \['review', 'backfill', 'compose', 'notices'\]/);
    assert.match(admin, /banner: \['banner', 'banner-inquiry'\]/);
    // 쓸 수 없는 탭은 감추는 게 아니라 지운다.
    assert.match(readNamedFunction(admin, 'applyAdminRoleToChrome'), /tab\.remove\(\)/);
    assert.match(readNamedFunction(admin, 'applyAdminRoleToChrome'), /panel\.remove\(\)/);

    // 운영진이 마스터에게 남기는 창.
    assert.match(html, /id="staff-report-modal"/);
    assert.match(admin, /\/api\/admin\/staff-report/);
});

test('crawled attachments are fetched through the server so the source Referer check passes', async () => {
    const server = await readFile('server/server.js', 'utf8');
    const app = await readFile('js/core.js', 'utf8');

    // ECE 홈페이지는 Referer가 자기 사이트가 아니면 첨부에 404를 준다.
    // 원문 주소를 그대로 걸면 브라우저가 우리 도메인을 보내 전부 실패한다.
    assert.match(server, /app\.get\('\/api\/notices\/:id\/attachments\/:index'/);
    assert.match(server, /Referer: notice\.sourceUrl/);
    // 공지에 실제로 적힌 주소만, 그것도 허용된 호스트만 대신 받는다.
    assert.match(server, /ATTACHMENT_ALLOWED_HOSTS = new Set\(\['ece\.snu\.ac\.kr'/);
    assert.match(server, /!ATTACHMENT_ALLOWED_HOSTS\.has\(target\.hostname\)/);
    assert.match(server, /target\.protocol !== 'https:'/);
    assert.match(server, /Content-Disposition/);

    // 상세 화면의 첨부 링크는 원문이 아니라 우리 경로를 가리킨다.
    assert.match(app, /\/api\/notices\/\$\{encodeURIComponent\(notice\.id\)\}\/attachments\/\$\{index\}/);
    assert.doesNotMatch(app, /attachments\.map\(file =>[\s\S]{0,120}safeHttpUrl\(file\.url\)/);
});

test('the left rail never scrolls and the hover preview follows its card', async () => {
    const desktopCss = await readFile('css/desktop.css', 'utf8');
    const app = await readFile('js/core.js', 'utf8');
    const html = await readFile('index.html', 'utf8');
    const mobileCss = await readFile('css/mobile.css', 'utf8');

    // 왼쪽 레일은 한 화면에 들어오므로 스크롤 막대를 두지 않는다.
    assert.match(desktopCss, /\.rail-left\s*\{[^}]*overflow:\s*hidden/s);
    assert.doesNotMatch(desktopCss, /\.site-rail\s*\{[^}]*overflow-y:\s*auto/s);
    // 서비스 안내가 관련 페이지 맨 위에 온다.
    assert.match(html, /aria-label="서울대학교 관련 링크">\s*<a href="\.\/service-guide\.html">서비스 안내<\/a>/);

    // 미리보기는 fixed라 스크롤하면 카드와 간격이 벌어진다. 기준 카드를 따라간다.
    assert.match(app, /function followNoticeHoverPreview/);
    assert.match(app, /hoverPreviewAnchorCard = card/);
    assert.match(app, /addEventListener\('scroll', followNoticeHoverPreview/);

    // 끌어온 공지를 버릴 표적이 있다.
    assert.match(html, /data-split-side="trash"/);
    assert.match(app, /placement === 'trash'/);

    // 모바일 두 열이 나란히 끝나 생기는 아래 빈 띠를 벽돌 배치로 메운다.
    // 끌어올린 만큼 위를 비워 두지 않으면 첫 줄이 잘린다.
    assert.match(mobileCss, /\.grid > \.card:nth-child\(2n\+1\)\s*\{\s*margin-top:\s*-46px/);
    // 위에 자리를 비워 두면 오른쪽 열이 그만큼 내려가 빈 띠가 오히려 넓어진다.
    const gridBlock = mobileCss.slice(mobileCss.indexOf('html[data-view="mobile"] .grid {'));
    assert.doesNotMatch(gridBlock.slice(0, gridBlock.indexOf('}')), /padding-top/);
    // "결과 N건"이 그 자리에 들어서면 끌어올리기를 멈춘다.
    assert.match(mobileCss, /\.grid\.has-result-count > \.card:nth-child\(2n\+1\)\s*\{\s*margin-top:\s*0/);
    assert.match(readNamedFunction(app, 'updateNoticeResultCount'), /classList\.toggle\('has-result-count', show\)/);
});

test('banner slots show one at a time and the inbox toolbar acts on the selection', async () => {
    const adminCss = await readFile('css/admin.css', 'utf8');
    const adminHtml = await readFile('admin.html', 'utf8');
    const admin = await readFile('js/admin.js', 'utf8');

    // .banner-item에 display를 명시했으므로 [hidden]의 기본값이 밀린다.
    // 눌러 주지 않으면 배너 1을 골라도 다섯 개가 전부 보인다.
    assert.match(adminCss, /\.banner-slides-list \.banner-item\[hidden\]\s*\{\s*display:\s*none !important/);
    assert.match(readNamedFunction(admin, 'applyBannerSlotVisibility'), /item\.hidden = showStaging \|\| index !== activeBannerSlot/);
    // 임시 배너 자리는 다섯 자리 아래에 따로 선다.
    assert.match(adminHtml, /id="banner-staging-section"/);
    assert.match(readNamedFunction(admin, 'promoteStagingBanner'), /\/promote/);

    // 배너 문의는 왼쪽 목록이 아니라 위 탭으로 옮겼다.
    assert.match(adminHtml, /data-tab="banner-inquiry"/);
    assert.match(adminHtml, /id="panel-banner-inquiry"/);
    assert.doesNotMatch(admin, /selectBannerSlot\('inquiry'\)/);

    // 문의함 도구 막대: 전체 선택 · 내보내기 · 삭제 모두 선택 기준으로 움직인다.
    assert.match(adminHtml, />\.md 로 내보내기</);
    assert.match(adminHtml, /id="feedback-delete-selected"/);
    assert.match(adminHtml, /id="feedback-select-all"[\s\S]*?toggleAllFeedbackSelection\(\)/);
    assert.match(readNamedFunction(admin, 'exportAdminFeedback'), /if \(!ids\.length\) return/);
    assert.match(readNamedFunction(admin, 'deleteSelectedFeedback'), /window\.confirm/);
    assert.match(readNamedFunction(admin, 'toggleAllFeedbackSelection'), /allPicked/);

    // 버리는 표적은 담는 표적과 떨어져 화면 아래 가운데에 뜬다.
    const html = await readFile('index.html', 'utf8');
    const css = await readFile('css/core.css', 'utf8');
    assert.match(html, /id="split-trash-overlay"/);
    assert.match(css, /\.split-trash-overlay\s*\{[\s\S]*?bottom:\s*22px;[\s\S]*?justify-content:\s*center/);
    // 위쪽 표적 줄에는 왼쪽·오른쪽 둘만 남는다.
    const overlayBlock = html.slice(html.indexOf('id="split-drop-overlay"'), html.indexOf('id="split-trash-overlay"'));
    assert.equal((overlayBlock.match(/class="split-drop-zone/g) || []).length, 2);
});

test('the frontend never reaches the API through a relative URL', async () => {
    // 배포에서는 정적 호스트(Pages)와 API(Render)가 서로 다른 출처다.
    // 상대 경로로 부르면 요청이 정적 호스트로 가서 405가 돌아오고,
    // 화면에는 원인을 알 수 없는 "실패했습니다"만 남는다.
    const scripts = (await readdir('js')).filter(name => name.endsWith('.js'));
    assert.ok(scripts.length > 0, 'js 디렉터리에 스크립트가 있어야 한다');

    for (const name of scripts) {
        const source = await readFile(path.join('js', name), 'utf8');
        const relativeCalls = source.match(/fetch\(\s*['"`]\/api\//g) || [];
        assert.deepEqual(
            relativeCalls,
            [],
            `js/${name}은 API_BASE_URL을 거쳐 절대 주소로 호출해야 한다`
        );
    }

    // 로그인 화면은 core.js를 싣지 않으므로 config.js를 직접 실어야
    // window.API_BASE_URL이 생긴다.
    const loginHtml = await readFile('admin-login.html', 'utf8');
    assert.match(loginHtml, /<script[^>]+src="[^"]*js\/config\.js"/);
});

test('admin requests carry the session cookie across sites', async () => {
    // HttpOnly 세션 쿠키는 요청이 credentials를 실어야만 다른 출처로 오간다.
    const core = await readFile('js/core.js', 'utf8');
    assert.match(core, /fetch\(buildApiUrl\(path\), \{[\s\S]{0,240}credentials:\s*'include'/);

    const login = await readFile('js/admin-login.js', 'utf8');
    assert.match(login, /credentials:\s*'include'/);
});

test('admin navigation targets files that exist on the static host', async () => {
    // 서버는 /admin과 /admin/workspace를 직접 라우팅하지만 정적 호스트에는
    // 그런 파일이 없다. Pages에서 /admin은 워크스페이스 자신이고
    // /admin/workspace는 공개 화면으로 떨어진다. 실제 파일 이름을 쓰면
    // 서버(세션 게이트가 걸린 /admin.html)와 정적 호스트 양쪽에서 통한다.
    const login = await readFile('js/admin-login.js', 'utf8');
    assert.match(login, /\/admin\.html/);
    assert.doesNotMatch(login, /\/admin\/workspace/);

    const admin = await readFile('js/admin.js', 'utf8');
    // 로그인 안 된 채로 열면 로그인 화면으로 나가야 한다.
    // /admin으로 보내면 정적 호스트에서는 자기 자신이라 무한히 다시 뜬다.
    assert.doesNotMatch(admin, /location\.replace\(`?'?\/admin(\$\{|'|`)/);
    assert.match(admin, /location\.replace\('\/admin-login\.html'\)/);
    assert.match(admin, /location\.replace\(`\/admin-login\.html\$\{next\}`\)/);
});

test('no notice title can overflow the text poster box', async () => {
    const app = await readFile('js/core.js', 'utf8');
    const width = new Function(`${readNamedFunction(app, 'posterTextWidth')}; return posterTextWidth;`)();
    const fit = new Function(`${readNamedFunction(app, 'posterTitleFit')}; return posterTitleFit;`)();
    const split = new Function(
        `${readNamedFunction(app, 'posterTextWidth')}; ${readNamedFunction(app, 'posterTitleLines')}; return posterTitleLines;`
    )();

    // 포스터 안쪽은 좁게 잡아 200px. 높이는 가로줄과 등록일이 자리를 쓰고
    // 남는 약 143px이다.
    const INNER_WIDTH = 200;
    const INNER_HEIGHT = 143;
    const renderedHeight = title => {
        const normalized = String(title || '제목 없음').replace(/\s+/g, ' ').trim();
        const chosen = fit(normalized.length);
        const lines = split(normalized, chosen.maxLines, chosen.perLine);
        // 한 줄이 폭을 넘으면 브라우저가 한 번 더 접는다. 그것까지 센다.
        const visualLines = lines.reduce(
            (sum, line) => sum + Math.max(1, Math.ceil(width(line) * chosen.size / INNER_WIDTH)),
            0
        );
        return visualLines * chosen.size * 1.34;
    };

    // perLine이 한 칸이라도 크면 줄이 두 번 접혀 높이가 배로 뛴다.
    for (const length of [10, 22, 30, 40, 60, 120]) {
        const chosen = fit(length);
        assert.ok(chosen.perLine * chosen.size <= INNER_WIDTH,
            `${chosen.size}px에서 한 줄 ${chosen.perLine}자는 ${INNER_WIDTH}px를 넘습니다`);
    }

    const samples = [
        '',
        '가',
        '[학생회] ChatGPT Edu Pro 모델 이용 정책 변경 안내',
        '2027학년도 1학기 본부 해외파견 교환학생 후보자 모집 안내',
        "2026학년도 2학기 수강신청 안내 (전기·정보공학부 학사교과목 '정원 외 신청기간' 조정 운영 안내 포함)",
        "[학부] 2026학년도 2학기 선이수 지정 교과목 수강 신청 안내 ('프로그래밍방법론', '기초전자기학 및 연습')",
        // 띄어쓰기 없는 극단값도 상자를 넘지 않아야 한다.
        '가'.repeat(300),
        'A'.repeat(400)
    ];
    for (const title of samples) {
        assert.ok(renderedHeight(title) <= INNER_HEIGHT,
            `"${String(title).slice(0, 20)}…"가 포스터를 넘칩니다 (${Math.round(renderedHeight(title))}px)`);
    }

    // 다 담지 못하면 잘렸다는 걸 말줄임으로 알린다. 말줄임표를 붙이고도
    // 한 줄 한도를 넘지 않아야 그 줄이 다시 접히지 않는다.
    const truncated = split('가'.repeat(300), 6, 12);
    assert.match(truncated.at(-1), /…$/);
    assert.ok(width(truncated.at(-1)) <= 12,
        `말줄임표를 붙인 줄이 한 줄 한도를 넘습니다 (${width(truncated.at(-1))})`);
});

test('drop targets light up when the dragged card overlaps them, not only the cursor', async () => {
    const app = await readFile('js/core.js', 'utf8');
    const source = readNamedFunction(app, 'findDropZoneUnderDrag');

    // 겹치는 넓이로 고르고, 여러 개가 겹치면 더 많이 겹친 쪽을 잡는다.
    assert.match(source, /overlapX \* overlapY/);
    assert.match(source, /area > bestArea/);
    // 겹치는 게 없을 때만 커서 한 점을 마지막으로 본다.
    assert.match(source, /elementFromPoint/);
    // 카드 드래그와 블록 재배치 양쪽에서 같은 판정을 쓴다.
    assert.match(readNamedFunction(app, 'onNoticeHandlePointerMove'), /findDropZoneUnderDrag\(/);
    assert.match(readNamedFunction(app, 'onCompareHandlePointerMove'), /findDropZoneUnderDrag\([\s\S]*?compareDragOverlay\)/);

    // 겹침 판정을 떼어내 실제로 넓이 큰 쪽을 고르는지 확인한다.
    const zones = [
        { name: 'left',  rect: { left: 0,   right: 60,  top: 0, bottom: 50 } },
        { name: 'right', rect: { left: 70,  right: 130, top: 0, bottom: 50 } }
    ];
    const pick = drag => {
        let best = null;
        let bestArea = 0;
        for (const zone of zones) {
            const overlapX = Math.min(drag.right, zone.rect.right) - Math.max(drag.left, zone.rect.left);
            const overlapY = Math.min(drag.bottom, zone.rect.bottom) - Math.max(drag.top, zone.rect.top);
            if (overlapX <= 0 || overlapY <= 0) continue;
            const area = overlapX * overlapY;
            if (area > bestArea) { bestArea = area; best = zone.name; }
        }
        return best;
    };
    // 두 표적에 걸쳐 있으면 더 많이 덮은 쪽이 켜진다.
    assert.equal(pick({ left: 40, right: 120, top: 10, bottom: 40 }), 'right');
    assert.equal(pick({ left: 10, right: 80, top: 10, bottom: 40 }), 'left');
    // 어느 쪽에도 닿지 않으면 아무것도 켜지 않는다.
    assert.equal(pick({ left: 200, right: 260, top: 10, bottom: 40 }), null);
});

test('a sticky search row takes over once the real search box scrolls away', async () => {
    const html = await readFile('index.html', 'utf8');
    const app = await readFile('js/core.js', 'utf8');
    const mobileCss = await readFile('css/mobile.css', 'utf8');

    assert.match(html, /id="mobile-sticky-search"/);
    assert.match(html, /onclick="jumpToNoticeSearch\(\)"/);

    // 진짜 검색창이 화면 위로 넘어간 뒤부터 선다.
    const sync = readNamedFunction(app, 'syncMobileStickySearch');
    assert.match(sync, /getBoundingClientRect\(\)\.bottom <= 4/);
    // 상세 화면이나 데스크탑에서는 뜨지 않는다.
    assert.match(sync, /getLayoutMode\(\) !== 'mobile'/);
    assert.match(sync, /board-view'\)\?\.hidden/);
    // 스크롤 처리는 프레임당 한 번으로 묶는다.
    assert.match(sync, /requestAnimationFrame/);
    assert.match(readNamedFunction(app, 'watchMobileStickySearch'), /addEventListener\('scroll'[\s\S]*passive: true/);

    // 누르면 맨 위로 되돌리고, 스크롤이 끝난 뒤에 초점을 준다.
    const jump = readNamedFunction(app, 'jumpToNoticeSearch');
    assert.match(jump, /scrollTo\(\{ top: 0, behavior: 'smooth' \}\)/);
    assert.match(jump, /preventScroll: true/);

    // 화면에 붙어 있어야 스크롤해도 사라지지 않는다.
    assert.match(mobileCss, /\.mobile-sticky-search\s*\{[^}]*position:\s*fixed;[^}]*top:\s*0/s);
    // 떠 있는 메뉴 버튼이 검색 글자를 덮지 않게 왼쪽을 비워 둔다.
    assert.match(mobileCss, /\.mobile-sticky-search\s*\{[^}]*padding:\s*8px 12px 10px 52px;/s);
    // 검색 줄이 뜨면 손잡이가 그 줄에 맞춰 내려온다.
    assert.match(mobileCss, /\.mobile-menu-btn\.is-with-search\s*\{[^}]*top:\s*12px/s);
});

test('first-time users get a guide, and slow notice loads show progress', async () => {
    const html = await readFile('index.html', 'utf8');
    const app = await readFile('js/core.js', 'utf8');
    const css = await readFile('css/core.css', 'utf8');
    const headers = await readFile('_headers', 'utf8');

    // 돋보기는 검색 확인이 아니라 사용 설명서로 간다. 검색은 치는 대로 걸린다.
    assert.match(html, /id="search-guide-btn"[\s\S]*?onclick="openUserGuide\(event\)"/);
    assert.doesNotMatch(html, /class="search-submit"[^>]*onclick="filterCards\(\)"/);
    assert.match(readNamedFunction(app, 'openUserGuide'), /guide\.html/);

    // 처음 온 사람에게 한 번만 알리고, 본 뒤에는 기기에 기록이 남는다.
    assert.match(html, /id="guide-hint"/);
    assert.match(html, /SNU ECE 공지방이 처음이신가요\?/);
    assert.match(readNamedFunction(app, 'dismissGuideHint'), /localStorage\.setItem\(GUIDE_HINT_KEY/);
    assert.match(readNamedFunction(app, 'initializeGuideHint'), /localStorage\.getItem\(GUIDE_HINT_KEY\)/);

    // 느린 회선에서 공지를 여는 동안 표시가 뜬다. 빠를 때 깜빡이지 않게 잠깐 미룬다.
    assert.match(html, /id="notice-loading"/);
    assert.match(readNamedFunction(app, 'showNoticeLoading'), /setTimeout/);
    assert.match(readNamedFunction(app, 'openDetail'), /showNoticeLoading\(\)/);
    assert.match(readNamedFunction(app, 'openDetail'), /finally\s*\{[\s\S]*?hideNoticeLoading\(\)/);
    assert.match(css, /\.notice-loading\s*\{[^}]*position:\s*fixed/s);

    // 폰 미리보기는 같은 사이트를 iframe으로 띄운다. DENY면 그 창이 통째로 막힌다.
    assert.match(headers, /X-Frame-Options: SAMEORIGIN/);
    assert.match(headers, /frame-ancestors 'self'/);
    assert.doesNotMatch(headers, /frame-ancestors 'none'/);
});

test('mobile stacks notices, then the banner, then the footer', async () => {
    const html = await readFile('index.html', 'utf8');
    const mobileCss = await readFile('css/mobile.css', 'utf8');

    // 모바일에서 오른쪽 레일은 흐름 안에 놓이므로 DOM 순서가 곧 보이는 순서다.
    const board = html.indexOf('id="board-view"');
    const banner = html.indexOf('id="right-ad-rail"');
    const footer = html.indexOf('class="site-footer"');
    assert.ok(board < banner, '배너가 공지보다 앞에 있습니다');
    assert.ok(banner < footer, '배너가 푸터보다 뒤에 있습니다');

    // 가로로 끄는 동안 페이지가 대신 스크롤되지 않게 한다.
    assert.match(mobileCss, /\.rail-ad-stage\s*\{[^}]*touch-action:\s*pan-y/s);
    // 손가락으로 누를 수 있는 크기의 화살표.
    assert.match(mobileCss, /@media \(hover: none\)[\s\S]*?\.rail-ad-arrow\s*\{\s*width:\s*44px/);

    // 푸터에 자주 묻는 질문과 사용 설명서가 있다.
    assert.match(html, /href="\.\/faq\.html">자주 묻는 질문</);
    // 사용 설명서는 푸터에 따로 걸지 않고 서비스 안내 안에서 연다.
    assert.doesNotMatch(html, /href="\.\/guide\.html">사용 설명서</);
    const serviceGuidePage = await readFile('service-guide.html', 'utf8');
    assert.match(serviceGuidePage, /href="\.\/guide\.html"/);
});

test('closing a filter chip does not collapse the detail panel', async () => {
    const html = await readFile('index.html', 'utf8');
    const app = await readFile('js/core.js', 'utf8');
    const css = await readFile('css/core.css', 'utf8');
    const mobileCss = await readFile('css/mobile.css', 'utf8');

    // 칩의 x는 상세 필터 바 안에 있다. 손가락이 빗나가면 바가 눌려 패널이 닫힌다.
    assert.match(html, /id="filter-toggle-bar"[\s\S]*?onclick="toggleFilterPanel\(event\)"/);
    assert.match(readNamedFunction(app, 'toggleFilterPanel'), /closest\?\.\('\.filter-active-chips'\)\) return/);
    // 누를 수 있는 크기도 함께 키운다.
    assert.match(css, /\.filter-chip button\s*\{[^}]*width:\s*20px;[^}]*height:\s*20px/s);
    assert.match(mobileCss, /\.filter-chip button\s*\{[^}]*width:\s*28px;[^}]*height:\s*28px/s);

    // 서랍 손잡이는 헤더 줄 안에서 배경에 묻히고 아이콘만 남는다.
    const menuBlock = mobileCss.slice(mobileCss.indexOf('html[data-view="mobile"] .mobile-menu-btn {'));
    const menuRule = menuBlock.slice(0, menuBlock.indexOf('}'));
    // 흐름에서 빠져 떠 있어야 제목이 버튼 없는 것처럼 왼쪽 끝에 붙는다.
    assert.match(menuRule, /position:\s*fixed/);
    // 평소에는 숨어 있다가 목록을 내리면 나타나고, 두면 스스로 사라진다.
    assert.match(menuRule, /opacity:\s*0/);
    assert.match(menuRule, /pointer-events:\s*none/);
    assert.match(mobileCss, /\.mobile-menu-btn\.is-visible\s*\{[^}]*opacity:\s*1/s);
    assert.match(readNamedFunction(app, 'revealMobileMenuHandle'), /MENU_HANDLE_IDLE_MS/);
    assert.match(readNamedFunction(app, 'revealMobileMenuHandle'), /isMobileDrawerOpen\(\)/);
    // 푸터 2x2의 십자 구분선은 없앤다.
    assert.doesNotMatch(mobileCss, /\.footer-column\s*\{[^}]*border-right/s);
    // 헤더도 흰 카드가 아니라 배경 위에 그대로 얹힌다.
    assert.match(mobileCss, /\.header\s*\{[^}]*background:\s*transparent;[^}]*box-shadow:\s*none/s);
    // 모바일 배너 위아래로 레일 남색이 비치지 않는다.
    assert.match(mobileCss, /\.rail-right\s*\{[^}]*background:\s*transparent/s);

    // 안내를 닫은 뒤에도 서비스 안내에서 설명서로 돌아올 수 있다.
    const serviceGuide = await readFile('service-guide.html', 'utf8');
    assert.match(serviceGuide, /사용 설명서 다시 보기/);
    assert.match(serviceGuide, /href="\.\/guide\.html"/);
    // 첫 방문 안내를 다시 받게 되돌리는 것은 저장된 기록을 지우는 일이다.
    assert.match(serviceGuide, /localStorage\.removeItem\('eceGuideHintSeen'\)/);
});

test('the operator page names who runs the site and the footer points at it', async () => {
    const operator = await readFile('operator.html', 'utf8');
    const html = await readFile('index.html', 'utf8');
    const prepare = await readFile('scripts/prepare-public.mjs', 'utf8');

    // 운영 주체는 이름으로 밝힌다. 그게 이 페이지의 존재 이유다.
    assert.match(operator, /김태현/);
    assert.match(operator, /최재원/);
    // 학부 공식 서비스로 오해받으면 안 된다.
    assert.match(operator, /비공식/);
    // 학교 메일은 공개하되 개인 휴대폰 번호는 싣지 않는다.
    assert.match(operator, /mailto:aeron1120@snu\.ac\.kr/);
    assert.match(operator, /mailto:legojmon@snu\.ac\.kr/);
    assert.doesNotMatch(operator, /010-\d{4}-\d{4}/);

    // 권한이 셋으로 나뉘어 있다는 것이 한눈에 보여야 한다.
    for (const role of ['운영자 · 개발자', '공지 관리자', '배너 관리자']) {
        assert.match(operator, new RegExp(`<dt>${role}</dt>`), `${role} 항목이 없다`);
    }

    // 긴 문단 대신 훑을 수 있는 구조를 쓴다.
    const css = await readFile('css/service-guide.css', 'utf8');
    for (const selector of ['.guide-people', '.guide-defs']) {
        assert.match(operator, new RegExp(`class="${selector.slice(1)}"`));
        assert.match(css, new RegExp(`\\${selector}\\b`), `${selector} 스타일이 없다`);
    }

    // 푸터의 '운영 주체 안내'가 서비스 안내가 아니라 이 페이지를 가리켜야 한다.
    const operationColumn = html.slice(
        html.indexOf('<nav class="footer-column" aria-label="운영">'),
        html.indexOf('</nav>', html.indexOf('<nav class="footer-column" aria-label="운영">'))
    );
    assert.match(operationColumn, /href="\.\/operator\.html">운영 주체 안내/);
    assert.doesNotMatch(operationColumn, /service-guide\.html/);

    // 복사 목록에서 빠지면 서버가 404를 준다.
    assert.match(prepare, /operator\.html/);
});

test('the legal pages name the same operators as the operator page', async () => {
    const privacy = await readFile('privacy.html', 'utf8');
    const terms = await readFile('terms.html', 'utf8');

    // 개인정보 처리 책임자와 약관상 '운영자'가 누구인지 실명으로 밝혀야 한다.
    for (const [name, page] of [['privacy.html', privacy], ['terms.html', terms]]) {
        assert.match(page, /김태현/, `${name}에 운영자 이름이 없다`);
        assert.match(page, /최재원/, `${name}에 운영자 이름이 없다`);
        // 세 페이지가 따로 놀지 않도록 한 곳을 가리킨다.
        assert.match(page, /href="\.\/operator\.html"/, `${name}이 운영 주체 안내로 링크하지 않는다`);
    }

    // 약관은 곳곳에서 '운영자'를 주어로 쓰므로 처음에 정의해야 한다.
    assert.match(terms, /이하 &ldquo;운영자&rdquo;/);
});

test('mobile guide pages hide desktop rails and mobile card titles stay contained', async () => {
    const operator = await readFile('operator.html', 'utf8');
    const guide = await readFile('service-guide.html', 'utf8');
    const guideCss = await readFile('css/service-guide.css', 'utf8');
    const mobileCss = await readFile('css/mobile.css', 'utf8');

    for (const page of [operator, guide]) {
        assert.doesNotMatch(page, /<html[^>]*data-view="desktop"/);
        assert.match(page, /matchMedia\('\(max-width: 820px\)'\)/);
    }
    assert.match(guideCss, /@media \(max-width: 820px\)[\s\S]*?\.guide-page-rail\s*\{\s*display:\s*none !important;/);
    assert.match(mobileCss, /\.card-poster\.is-text\s*\{[^}]*height:\s*auto;[^}]*min-height:\s*154px/s);
    assert.match(mobileCss, /\.card-poster-title\s*\{[^}]*overflow:\s*visible/s);
    assert.match(mobileCss, /\.card-title\s*\{[^}]*word-break:\s*keep-all;[^}]*overflow-wrap:\s*anywhere;[^}]*display:\s*block;[^}]*overflow:\s*visible/s);
    assert.match(mobileCss, /\.card-date\s*\{[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere/s);
});

test('category selection uses one blue mobile baseline and a modest weight change', async () => {
    const css = await readFile('css/core.css', 'utf8');
    const mobile = await readFile('css/mobile.css', 'utf8');

    assert.match(css, /\.category-tab\.active\s*\{[^}]*font-weight:\s*750/s);
    assert.match(mobile, /\.category-tabs\s*\{[^}]*border-bottom:\s*2px solid var\(--primary-deep\)/s);
    assert.match(mobile, /\.category-tab\.active\s*\{[^}]*border-bottom-color:\s*transparent;[^}]*font-weight:\s*750/s);
});

test('notice links stop before Korean particles and surrounding punctuation', async () => {
    const app = await readFile('js/core.js', 'utf8');
    const context = {};
    runInNewContext(`
        ${readNamedFunction(app, 'escapeHtml')}
        ${readNamedFunction(app, 'linkify')}
        this.linkify = linkify;
    `, context);

    const linked = context.linkify('신청(https://forms.gle/JTkSYXtCVNE5zELt5)는 SNU 포털에서 확인.');
    assert.match(linked, /href="https:\/\/forms\.gle\/JTkSYXtCVNE5zELt5"/);
    assert.match(linked, /<\/a>\)는 SNU/);
    assert.doesNotMatch(linked, /href="[^"]*\)는/);

    const balanced = context.linkify('https://example.com/docs_(v2).');
    assert.match(balanced, /href="https:\/\/example\.com\/docs_\(v2\)"/);
    assert.match(balanced, /<\/a>\.$/);

    const quoted = context.linkify('"https://example.com/apply" <안내>');
    assert.match(quoted, /^&quot;<a href="https:\/\/example\.com\/apply"/);
    assert.match(quoted, /<\/a>&quot; &lt;안내&gt;$/);
});

test('service guide sections and footer tutorial targets have clear boundaries', async () => {
    const guide = await readFile('service-guide.html', 'utf8');
    const html = await readFile('index.html', 'utf8');
    const tutorial = await readFile('js/tutorial.js', 'utf8');
    const css = await readFile('css/core.css', 'utf8');

    assert.match(guide, /class="guide-category-sort"[\s\S]*?<\/section>\s*<section>\s*<h2>관련 공지<\/h2>/);
    assert.match(html, /class="footer-link-list footer-tutorial-links"/);
    assert.match(html, /class="footer-sync-content"/);
    assert.match(tutorial, /target:\s*'\.footer-column\[aria-label="문의"\] \.footer-tutorial-links'/);
    assert.match(tutorial, /target:\s*'#footer-sync \.footer-sync-content'/);
    assert.match(css, /\.footer-tutorial-links\s*\{[^}]*width:\s*max-content[^}]*padding:\s*4px 8px/);
    assert.match(css, /\.footer-sync-content\s*\{[^}]*display:\s*inline-flex[^}]*padding:\s*5px 8px/);
});

test('beta ratings appear only after the third and thirteenth notice opens', async () => {
    const html = await readFile('index.html', 'utf8');
    const app = await readFile('js/core.js', 'utf8');

    const feedbackModal = html.slice(
        html.indexOf('id="contact-modal"'),
        html.indexOf('id="beta-rating-modal"')
    );
    assert.doesNotMatch(feedbackModal, /베타 서비스는 어떠셨나요|beta-rating-buttons/);
    assert.match(html, /id="beta-rating-modal"/);
    assert.match(app, /BETA_RATING_MILESTONES = \[3, 13\]/);
    assert.match(readNamedFunction(app, 'recordBetaNoticeOpen'), /BETA_RATING_MILESTONES\.includes\(count\)/);
    assert.match(readNamedFunction(app, 'recordBetaNoticeOpen'), /prompted\.includes\(count\)/);
    assert.match(readNamedFunction(app, 'openDetail'), /recordBetaNoticeOpen\(\)/);
    assert.doesNotMatch(readNamedFunction(app, 'submitFeedback'), /rating|beta-rating/);
});

test('admin role radios do not inherit the rectangular text-input chrome', async () => {
    const css = await readFile('css/admin-login.css', 'utf8');
    assert.match(css, /\.role-option input\s*\{[^}]*min-height:\s*0;[^}]*padding:\s*0;[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/s);
});
