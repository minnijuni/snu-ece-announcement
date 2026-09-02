/* 저장된 공지 중 category가 비었거나 예전 키('BENEFIT')인 것을 학사·기회·설문·
   행사 넷 중 하나로 채운다. 서버는 읽을 때 이미 같은 규칙으로 채워 내보내므로
   이 스크립트를 돌리지 않아도 화면과 앱은 맞다. 다만 저장값까지 맞춰 두면
   알림·다이제스트·통계처럼 저장값을 직접 읽는 곳과도 일치한다.

   기본은 dry-run이고 --apply를 붙여야 쓴다. SUPABASE_URL과
   SUPABASE_SERVICE_ROLE_KEY가 있으면 Supabase를, 없으면 server/data의 JSON을
   손본다. 이미 맞는 값은 건드리지 않으므로 몇 번을 돌려도 같다. */
import dotenv from 'dotenv';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { CANONICAL_NOTICE_CATEGORIES } from '../server/config/notice-categories.js';
import { ensureNoticeCategory } from '../server/services/notice-classifier.js';

dotenv.config();

const apply = process.argv.includes('--apply');
const supabaseUrl = String(process.env.SUPABASE_URL || '').trim();
const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const useSupabase = Boolean(supabaseUrl && serviceRoleKey);

function describe(notice, resolved, extra = {}) {
    return {
        ...extra,
        id: notice.id,
        status: notice.status || 'published',
        title: String(notice.title || '').slice(0, 40),
        before: notice.category || '(없음)',
        after: resolved.category,
        beforeIds: (notice.categoryIds || []).map(Number),
        afterIds: resolved.categoryIds,
        source: resolved.categorySource,
        changed: resolved.changed
    };
}

async function planSupabase() {
    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const { data: categoryRows, error: categoryError } = await supabase
        .from('categories')
        .select('id, slug, is_active');
    if (categoryError) throw categoryError;
    const categories = (categoryRows || []).map(row => ({
        id: Number(row.id),
        slug: row.slug,
        key: CANONICAL_NOTICE_CATEGORIES.find(category => category.slug === row.slug)?.key || null,
        isActive: row.is_active
    }));

    const rows = [];
    const batchSize = 1000;
    for (let offset = 0; ; offset += batchSize) {
        const { data, error } = await supabase
            .from('notices')
            .select('id, title, content, keywords, host, status, category, notice_categories(category_id)')
            .eq('is_deleted', false)
            .order('id', { ascending: true })
            .range(offset, offset + batchSize - 1);
        if (error) throw error;
        rows.push(...(data || []));
        if ((data || []).length < batchSize) break;
    }

    const plans = rows.map(row => {
        const notice = {
            id: Number(row.id),
            status: row.status,
            title: row.title,
            content: row.content,
            keywords: row.keywords,
            host: row.host,
            category: row.category,
            categoryIds: (row.notice_categories || []).map(item => Number(item.category_id))
        };
        return describe(notice, ensureNoticeCategory(notice, categories), { store: 'supabase' });
    });

    return {
        plans,
        async applyPlans(changed) {
            for (const plan of changed) {
                const { error } = await supabase
                    .from('notices')
                    .update({ category: plan.after })
                    .eq('id', plan.id);
                if (error) throw error;
                const newIds = plan.afterIds.filter(id => !plan.beforeIds.includes(id));
                if (newIds.length === 0) continue;
                const { error: linkError } = await supabase
                    .from('notice_categories')
                    .upsert(newIds.map(id => ({ notice_id: plan.id, category_id: id })), {
                        onConflict: 'notice_id,category_id',
                        ignoreDuplicates: true
                    });
                if (linkError) throw linkError;
            }
        }
    };
}

async function planFile() {
    const dataDir = path.resolve('server/data');
    const automationPath = path.join(dataDir, 'automation.json');
    const noticesPath = path.join(dataDir, 'notices.json');
    const document = JSON.parse(await fs.readFile(automationPath, 'utf8'));
    const manualNotices = await fs.readFile(noticesPath, 'utf8')
        .then(text => {
            const parsed = JSON.parse(text);
            return Array.isArray(parsed) ? parsed : [];
        })
        .catch(() => []);
    const categories = (document.categories || []).map(category => ({
        id: Number(category.id),
        key: category.key,
        slug: category.slug,
        isActive: category.isActive
    }));
    const linkedIds = noticeId => (document.noticeCategories || [])
        .filter(item => Number(item.noticeId) === Number(noticeId))
        .map(item => Number(item.categoryId));

    const plans = [];
    for (const notice of document.notices || []) {
        if (notice.isDeleted) continue;
        const withIds = { ...notice, categoryIds: linkedIds(notice.id) };
        plans.push(describe(withIds, ensureNoticeCategory(withIds, categories), { store: 'automation' }));
    }
    for (const notice of manualNotices) {
        if (notice.isDeleted) continue;
        plans.push(describe(notice, ensureNoticeCategory(notice, categories), { store: 'manual' }));
    }

    return {
        plans,
        async applyPlans(changed) {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const now = new Date().toISOString();
            await fs.copyFile(automationPath, path.join(dataDir, `automation.before-category-backfill-${stamp}.json`));
            if (manualNotices.length > 0) {
                await fs.copyFile(noticesPath, path.join(dataDir, `notices.before-category-backfill-${stamp}.json`));
            }
            for (const plan of changed) {
                if (plan.store === 'automation') {
                    const notice = document.notices.find(item => Number(item.id) === Number(plan.id));
                    notice.category = plan.after;
                    if (Array.isArray(notice.categoryIds)) notice.categoryIds = plan.afterIds;
                    for (const categoryId of plan.afterIds) {
                        if (plan.beforeIds.includes(categoryId)) continue;
                        document.noticeCategories.push({ noticeId: notice.id, categoryId, createdAt: now });
                    }
                } else {
                    const notice = manualNotices.find(item => Number(item.id) === Number(plan.id));
                    notice.category = plan.after;
                    notice.categoryIds = plan.afterIds;
                }
            }
            await writeJson(automationPath, document);
            if (manualNotices.length > 0) await writeJson(noticesPath, manualNotices);
        }
    };
}

async function writeJson(filePath, value) {
    const temporaryPath = `${filePath}.tmp`;
    await fs.writeFile(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
    await fs.rename(temporaryPath, filePath);
}

const { plans, applyPlans } = useSupabase ? await planSupabase() : await planFile();
const changed = plans.filter(plan => plan.changed);

console.log(`저장소: ${useSupabase ? 'supabase' : 'file'} / 공지 ${plans.length}건 / 채울 것 ${changed.length}건`);
if (changed.length > 0) {
    console.table(changed.map(plan => ({
        id: plan.id,
        status: plan.status,
        title: plan.title,
        before: plan.before,
        after: plan.after,
        ids: `${plan.beforeIds.join('+') || '-'} → ${plan.afterIds.join('+') || '-'}`,
        source: plan.source
    })));
}
if (!apply) {
    console.log('dry-run만 수행했습니다. 적용하려면 --apply를 붙이세요.');
} else if (changed.length === 0) {
    console.log('채울 공지가 없습니다.');
} else {
    await applyPlans(changed);
    console.log(`적용 완료: ${changed.length}건`);
}
