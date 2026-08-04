create table if not exists public.notices (
  id bigint generated always as identity primary key,
  title text not null,
  content text not null,
  target text not null default '전체',
  host text not null default '기타',
  deadline date,
  deadline_at timestamptz,
  -- 행사가 열리는 날 또는 신청을 받기 시작하는 날. 마감일과 짝지어 기간으로 보여준다.
  start_date date,
  expires_at timestamptz,
  is_always_open boolean not null default false,
  is_pinned boolean not null default false,
  is_hidden boolean not null default false,
  category text check (category is null or category in ('ACADEMIC', 'OPPORTUNITY', 'SURVEY', 'BENEFIT', 'COMMUNITY')),
  has_reward boolean not null default false,
  reward_note text,
  requires_action boolean not null default false,
  survey_reward text not null default '',
  ai_summary jsonb not null default '[]'::jsonb,
  images jsonb not null default '[]'::jsonb,
  has_images boolean generated always as (jsonb_array_length(images) > 0) stored,
  views integer not null default 0,
  is_deleted boolean not null default false,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists notices_active_created_idx on public.notices (is_deleted, created_at desc);

-- 익명 베타 분석: 원본 식별자·IP·사용자 에이전트는 저장하지 않는다.
create table if not exists public.beta_analytics_events (
  id bigint generated always as identity primary key,
  event_type text not null check (event_type in ('page_view', 'return_visit', 'rating')),
  session_hash text not null,
  page_path text not null default '/',
  rating smallint check (rating between 1 and 5),
  created_at timestamptz not null default now()
);
create index if not exists beta_analytics_events_created_idx on public.beta_analytics_events (created_at desc);
create index if not exists beta_analytics_events_session_idx on public.beta_analytics_events (session_hash, created_at desc);
alter table public.beta_analytics_events enable row level security;
revoke all on public.beta_analytics_events from anon, authenticated;

create table if not exists public.app_settings (
  id integer primary key,
  admin_name text not null,
  admin_phone text not null,
  admin_kakao text not null,
  banner_admin_name text not null default '학생회 대외협력국 (국장 : 이배너)',
  banner_admin_phone text not null default '010-8888-9999',
  banner_admin_kakao text not null default 'snu_ece_ads',
  -- 더는 쓰지 않는다. 서버는 banner_token_hash로만 판단하고 저장할 때마다
  -- 이 열을 빈 문자열로 덮어쓴다. not null이라 열 자체는 남겨 둔다.
  banner_password text not null default '',
  admin_token_hash text not null,
  -- 배너·마스터 비밀번호도 해시로 보관한다. 기존 행에는 없을 수 있으므로
  -- 비워 둘 수 있게 두고, 서버가 읽을 때 환경변수 기본값으로 되돌린다.
  banner_token_hash text,
  master_token_hash text,
  updated_at timestamptz not null default now()
);

alter table if exists public.app_settings add column if not exists banner_admin_name text not null default '학생회 대외협력국 (국장 : 이배너)';
alter table if exists public.app_settings add column if not exists banner_admin_phone text not null default '010-8888-9999';
alter table if exists public.app_settings add column if not exists banner_admin_kakao text not null default 'snu_ece_ads';
alter table if exists public.app_settings add column if not exists banner_token_hash text;
alter table if exists public.app_settings add column if not exists master_token_hash text;
alter table if exists public.app_settings alter column banner_password set default '';

-- 평문 배너 비밀번호를 지운다. 해시가 아직 비어 있는 행은 지우기 전에 그 평문을
-- 옛 형식(salt 없는 sha256)으로 옮겨 둬야 기존 비밀번호가 계속 통한다. 서버가
-- 읽는 형식과 같아야 하므로 여기서도 sha256을 쓴다. 다음 로그인에 성공하면
-- 서버가 scrypt로 다시 적는다.
update public.app_settings
set banner_token_hash = encode(sha256(banner_password::bytea), 'hex')
where coalesce(banner_token_hash, '') = ''
  and coalesce(banner_password, '') <> '';

update public.app_settings
set banner_password = ''
where banner_password <> '';

create table if not exists public.banner_slides (
  id bigint generated always as identity primary key,
  name text not null,
  text text not null,
  bg_style text not null,
  text_color text not null,
  src text,
  "order" integer not null default 0,
  placement text not null default 'header'
    check (placement in ('header', 'right_rail')),
  link_url text,
  alt_text text,
  description text,
  type text not null default 'council'
    check (type in ('club', 'project', 'council')),
  owner text not null default 'SNU ECE 학생회',
  starts_at timestamptz not null default now(),
  status text not null default 'approved'
    check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  is_deleted boolean not null default false
);

alter table public.banner_slides
  add column if not exists placement text not null default 'header',
  add column if not exists link_url text,
  add column if not exists alt_text text,
  add column if not exists description text,
  add column if not exists type text not null default 'council',
  add column if not exists owner text not null default 'SNU ECE 학생회',
  add column if not exists starts_at timestamptz not null default now(),
  add column if not exists status text not null default 'approved';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'banner_slides_placement_check'
      and conrelid = 'public.banner_slides'::regclass
  ) then
    alter table public.banner_slides
      add constraint banner_slides_placement_check
      check (placement in ('header', 'right_rail'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'banner_slides_type_check'
      and conrelid = 'public.banner_slides'::regclass
  ) then
    alter table public.banner_slides
      add constraint banner_slides_type_check
      check (type in ('club', 'project', 'council'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'banner_slides_status_check'
      and conrelid = 'public.banner_slides'::regclass
  ) then
    alter table public.banner_slides
      add constraint banner_slides_status_check
      check (status in ('pending', 'approved', 'rejected'));
  end if;
end;
$$;

create index if not exists banner_slides_active_order_idx on public.banner_slides (is_deleted, "order" asc);
create index if not exists banner_slides_expires_idx on public.banner_slides (expires_at);
create index if not exists banner_slides_placement_active_order_idx
  on public.banner_slides (placement, is_deleted, "order" asc);
create index if not exists banner_slides_public_period_idx
  on public.banner_slides (status, starts_at, expires_at, is_deleted);

create table if not exists public.promo_slots (
  id bigint generated always as identity primary key,
  type text not null check (type in ('club', 'project', 'council')),
  title text not null,
  image_url text,
  mobile_image_url text,
  link_url text,
  owner text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  internal_name text,
  description text,
  alt_text text,
  "order" integer not null default 0,
  placement text not null default 'right_rail'
    check (placement = 'right_rail'),
  bg_style text,
  text_color text,
  created_at timestamptz not null default now(),
  is_deleted boolean not null default false
);

create index if not exists promo_slots_public_period_idx
  on public.promo_slots (status, starts_at, ends_at, is_deleted, "order" asc);

alter table if exists public.promo_slots
  add column if not exists mobile_image_url text;

insert into public.promo_slots (
  type, title, image_url, mobile_image_url, link_url, owner, starts_at, ends_at, status,
  internal_name, description, alt_text, "order", placement, bg_style, text_color, created_at, is_deleted
)
select
  coalesce(type, 'council'),
  text,
  src,
  src,
  link_url,
  coalesce(nullif(owner, ''), 'SNU ECE 학생회'),
  coalesce(starts_at, created_at),
  expires_at,
  coalesce(status, 'approved'),
  name,
  description,
  alt_text,
  "order",
  'right_rail',
  bg_style,
  text_color,
  created_at,
  is_deleted
from public.banner_slides legacy
where legacy.placement = 'right_rail'
  and not exists (
    select 1
    from public.promo_slots promo
    where promo.title = legacy.text
      and coalesce(promo.link_url, '') = coalesce(legacy.link_url, '')
      and promo.starts_at = coalesce(legacy.starts_at, legacy.created_at)
  );

alter table public.notices
  add column if not exists has_images boolean
    generated always as (jsonb_array_length(images) > 0) stored,
  add column if not exists status text not null default 'published'
    check (status in ('pending_review', 'published', 'rejected')),
  add column if not exists source_type text not null default 'manual',
  add column if not exists source_external_id text,
  add column if not exists source_group text,
  add column if not exists thread_key text,
  add column if not exists ocr_text text,
  add column if not exists source_url text,
  add column if not exists source_published_at timestamptz,
  add column if not exists last_crawled_at timestamptz,
  add column if not exists published_at timestamptz,
  add column if not exists targets jsonb not null default '[]'::jsonb,
  add column if not exists keywords jsonb not null default '[]'::jsonb,
  add column if not exists analysis_status text
    check (analysis_status is null or analysis_status in ('pending', 'succeeded', 'failed')),
  add column if not exists analysis_confidence numeric,
  add column if not exists crawl_metadata jsonb not null default '{}'::jsonb,
  add column if not exists raw_title text,
  add column if not exists raw_content text,
  add column if not exists attachments jsonb not null default '[]'::jsonb,
  add column if not exists reviewed_at timestamptz,
  add column if not exists review_note text,
  add column if not exists deadline_at timestamptz,
  add column if not exists start_date date,
  add column if not exists expires_at timestamptz,
  add column if not exists is_always_open boolean not null default false,
  add column if not exists is_pinned boolean not null default false,
  add column if not exists is_hidden boolean not null default false,
  add column if not exists category text,
  add column if not exists has_reward boolean not null default false,
  add column if not exists reward_note text,
  add column if not exists requires_action boolean not null default false,
  add column if not exists survey_reward text not null default '';

update public.notices
set deadline_at = (
  (deadline::timestamp + interval '23 hours 59 minutes 59 seconds')
  at time zone 'Asia/Seoul'
)
where deadline is not null
  and deadline_at is null;

create index if not exists notices_active_expiry_idx
  on public.notices (is_deleted, status, expires_at);

update public.notices
set published_at = coalesce(published_at, created_at),
    targets = case
      when jsonb_array_length(targets) = 0 then jsonb_build_array(target)
      else targets
    end
where status = 'published';

create unique index if not exists notices_source_external_unique
  on public.notices (source_type, source_external_id)
  where source_external_id is not null;

create index if not exists notices_status_created_idx
  on public.notices (status, created_at desc);

create or replace function public.get_notice_thumbnail_source(target_notice_id bigint)
returns table(id bigint, updated_at timestamptz, image text)
language sql
stable
security definer
set search_path = public
as $$
  select n.id, n.updated_at, n.images->>0
  from public.notices n
  where n.id = target_notice_id
    and n.status = 'published'
    and n.is_deleted = false;
$$;

revoke all on function public.get_notice_thumbnail_source(bigint) from public;
grant execute on function public.get_notice_thumbnail_source(bigint) to service_role;

create table if not exists public.crawl_runs (
  id bigint generated always as identity primary key,
  source_type text not null,
  status text not null check (status in ('running', 'succeeded', 'partial', 'failed')),
  discovered_count integer not null default 0,
  created_count integer not null default 0,
  failed_count integer not null default 0,
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists public.crawl_items (
  id bigint generated always as identity primary key,
  crawl_run_id bigint not null references public.crawl_runs(id) on delete cascade,
  source_external_id text not null,
  status text not null check (status in ('created', 'duplicate', 'failed')),
  error_message text,
  created_at timestamptz not null default now(),
  unique (crawl_run_id, source_external_id)
);

create table if not exists public.categories (
  id bigint generated always as identity primary key,
  name text not null,
  slug text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.categories (name, slug, is_active)
values
  ('학사', 'academic', true),
  ('기회', 'opportunity', true),
  ('설문', 'survey', true),
  ('행사', 'community', true)
on conflict (slug) do update
set name = excluded.name,
    is_active = true,
    updated_at = now();

-- '혜택'은 기회와 갈라지지 않아 없앴다. 그 자리에 '설문'이 들어왔고
-- 제휴·할인은 '행사'로 옮겼다. 옛 칸은 지우지 않고 꺼 두어, 이미 그 칸으로
-- 분류된 공지가 있어도 참조가 끊기지 않게 한다.
update public.categories
set is_active = false, updated_at = now()
where slug not in ('academic', 'opportunity', 'survey', 'community');

create table if not exists public.category_aliases (
  id bigint generated always as identity primary key,
  category_id bigint not null references public.categories(id) on delete cascade,
  alias text not null,
  normalized_alias text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.notice_categories (
  notice_id bigint not null references public.notices(id) on delete cascade,
  category_id bigint not null references public.categories(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (notice_id, category_id)
);

-- 기존 6개 혼합 축을 새 주제 4개로 한 번에 접는다.
-- 신청은 제목·본문 키워드로만 분류하고 근거가 없으면 category를 비워 수동 검수 대상으로 남긴다.
with old_category_flags as (
  select
    n.id,
    n.title,
    n.content,
    n.category as current_category,
    coalesce(bool_or(c.slug = 'application'), false) as was_application,
    coalesce(bool_or(c.slug in ('academic', 'academics')), false) as was_academic,
    coalesce(bool_or(c.slug in ('benefit', 'benefits-partnerships', 'survey')), false) as was_benefit,
    coalesce(bool_or(c.slug = 'survey'), false) as was_survey,
    coalesce(bool_or(c.slug in ('community', 'campus', 'governance')), false) as was_community
  from public.notices n
  left join public.notice_categories nc on nc.notice_id = n.id
  left join public.categories c on c.id = nc.category_id
  group by n.id, n.title, n.content, n.category
),
classified as (
  select
    id,
    case
      when was_application and concat_ws(' ', title, content)
        ~* '(인턴|연구실|모집|공모전|경진대회|대회|장학|교환[[:space:]]*학생)'
        then 'OPPORTUNITY'
      when was_application and concat_ws(' ', title, content)
        ~* '(수강[[:space:]]*신청|수강신청|수강[[:space:]]*정정|졸업|성적|전공[[:space:]]*진입)'
        then 'ACADEMIC'
      when was_application then null
      when was_academic then 'ACADEMIC'
      when was_benefit then 'BENEFIT'
      when was_community then 'COMMUNITY'
      when current_category in ('ACADEMIC', 'OPPORTUNITY', 'SURVEY', 'BENEFIT', 'COMMUNITY')
        then current_category
      else null
    end as category
  from old_category_flags
)
update public.notices n
set
  category = classified.category,
  requires_action = n.requires_action or flags.was_application or flags.was_survey,
  has_reward = n.has_reward or flags.was_survey
from classified
join old_category_flags flags on flags.id = classified.id
where n.id = classified.id;

delete from public.notice_categories;

insert into public.notice_categories (notice_id, category_id)
select n.id, c.id
from public.notices n
join public.categories c on c.slug = case n.category
  when 'ACADEMIC' then 'academic'
  when 'OPPORTUNITY' then 'opportunity'
  when 'BENEFIT' then 'benefit'
  when 'COMMUNITY' then 'community'
end
where n.category is not null
on conflict (notice_id, category_id) do nothing;

-- 저장된 상태 열 대신 deadline 하나만 기준으로 진행중·마감임박·마감을 파생한다.
update public.notices
set expires_at = case when is_always_open then null else deadline_at end;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'notices_category_check'
      and conrelid = 'public.notices'::regclass
  ) then
    alter table public.notices
      add constraint notices_category_check
      check (category is null or category in ('ACADEMIC', 'OPPORTUNITY', 'SURVEY', 'BENEFIT', 'COMMUNITY'))
      not valid;
  end if;
end
$$;

alter table public.notices validate constraint notices_category_check;

create table if not exists public.category_candidates (
  id bigint generated always as identity primary key,
  normalized_keyword text not null unique,
  display_name text not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'merged', 'rejected', 'deferred')),
  occurrence_count integer not null,
  average_confidence numeric not null,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  deferred_until timestamptz,
  decided_at timestamptz,
  merged_category_id bigint references public.categories(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.category_candidate_notices (
  candidate_id bigint not null references public.category_candidates(id) on delete cascade,
  notice_id bigint not null references public.notices(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (candidate_id, notice_id)
);

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  management_token_hash text not null,
  channel text not null default 'web_push',
  admission_year text,
  all_notices boolean not null default false,
  category_ids jsonb not null default '[]'::jsonb,
  urgent_enabled boolean not null default true,
  deadline_reminder_days integer,
  status text not null default 'active'
    check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.notification_jobs (
  id bigint generated always as identity primary key,
  notice_id bigint not null references public.notices(id) on delete cascade,
  kind text not null default 'new_notice',
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'completed', 'failed')),
  scheduled_at timestamptz not null default now(),
  claimed_at timestamptz,
  claim_token uuid,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (notice_id, kind)
);

alter table public.notification_jobs
  add column if not exists claimed_at timestamptz,
  add column if not exists claim_token uuid;

create table if not exists public.notification_deliveries (
  id bigint generated always as identity primary key,
  job_id bigint not null references public.notification_jobs(id) on delete cascade,
  subscription_id uuid not null references public.push_subscriptions(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'retry', 'permanent_failure')),
  attempts integer not null default 0,
  next_attempt_at timestamptz,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (job_id, subscription_id)
);

create table if not exists public.automation_audit_logs (
  id bigint generated always as identity primary key,
  action text not null,
  entity_type text not null,
  entity_id text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists crawl_runs_started_idx
  on public.crawl_runs (started_at desc);
do $$
begin
  if to_regclass('public.crawl_runs_one_running_per_source') is null then
    with duplicate_runs as (
      select id
      from (
        select id,
               row_number() over (
                 partition by source_type
                 order by started_at desc, id desc
               ) as position
        from public.crawl_runs
        where status = 'running'
      ) ranked
      where position > 1
    )
    update public.crawl_runs
    set status = 'failed',
        error_message = coalesce(error_message, 'duplicate crawl closed during schema migration'),
        finished_at = coalesce(finished_at, now())
    where id in (select id from duplicate_runs);
  end if;
end;
$$;
create unique index if not exists crawl_runs_one_running_per_source
  on public.crawl_runs (source_type)
  where status = 'running';
create index if not exists category_candidates_status_idx
  on public.category_candidates (status, last_seen_at desc);
create index if not exists notification_jobs_due_idx
  on public.notification_jobs (status, scheduled_at);
create index if not exists notification_deliveries_due_idx
  on public.notification_deliveries (status, next_attempt_at);

-- 서버는 service_role 키로만 붙고 그 역할은 RLS를 우회한다. 프런트는 Supabase에
-- 직접 붙지 않으므로, 정책을 하나도 두지 않은 채 RLS만 켜면 anon 키로 오는
-- PostgREST 요청이 전부 막힌다. app_settings에는 평문 배너 비밀번호와 관리자
-- 토큰 해시가 들어 있으니 이 네 개가 빠지면 안 된다.
alter table public.app_settings enable row level security;
alter table public.notices enable row level security;
alter table public.banner_slides enable row level security;
alter table public.promo_slots enable row level security;
alter table public.crawl_runs enable row level security;
alter table public.crawl_items enable row level security;
alter table public.categories enable row level security;
alter table public.category_aliases enable row level security;
alter table public.notice_categories enable row level security;
alter table public.category_candidates enable row level security;
alter table public.category_candidate_notices enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.notification_jobs enable row level security;
alter table public.notification_deliveries enable row level security;
alter table public.automation_audit_logs enable row level security;

-- RLS를 켜도 Supabase가 public 스키마의 새 테이블에 기본으로 준 권한은 남는다.
-- 두 가지를 함께 걸어야 anon 키가 쓸모없어진다.
revoke all on public.app_settings from anon, authenticated;
revoke all on public.notices from anon, authenticated;
revoke all on public.banner_slides from anon, authenticated;
revoke all on public.promo_slots from anon, authenticated;
revoke all on public.crawl_runs from anon, authenticated;
revoke all on public.crawl_items from anon, authenticated;
revoke all on public.categories from anon, authenticated;
revoke all on public.category_aliases from anon, authenticated;
revoke all on public.notice_categories from anon, authenticated;
revoke all on public.category_candidates from anon, authenticated;
revoke all on public.category_candidate_notices from anon, authenticated;
revoke all on public.push_subscriptions from anon, authenticated;
revoke all on public.notification_jobs from anon, authenticated;
revoke all on public.notification_deliveries from anon, authenticated;
revoke all on public.automation_audit_logs from anon, authenticated;

create or replace function public.create_manual_notice(
  notice_payload jsonb,
  should_notify boolean default true
)
returns setof public.notices
language plpgsql
security definer
set search_path = public
as $$
declare
  created_row public.notices;
  category_value jsonb;
begin
  insert into public.notices (
    title, content, target, targets, host, deadline, deadline_at, start_date, expires_at,
    is_always_open, is_pinned, is_hidden, category, has_reward, reward_note,
    requires_action, survey_reward, ai_summary, images,
    status, source_type, raw_title, raw_content, analysis_status,
    published_at, views, is_deleted
  ) values (
    notice_payload->>'title',
    notice_payload->>'content',
    coalesce(nullif(notice_payload->>'target', ''), '전체'),
    jsonb_build_array(coalesce(nullif(notice_payload->>'target', ''), '전체')),
    coalesce(nullif(notice_payload->>'host', ''), '기타'),
    nullif(notice_payload->>'deadline', '')::date,
    nullif(notice_payload->>'deadlineAt', '')::timestamptz,
    nullif(notice_payload->>'startDate', '')::date,
    nullif(notice_payload->>'expiresAt', '')::timestamptz,
    coalesce((notice_payload->>'isAlwaysOpen')::boolean, false),
    coalesce((notice_payload->>'isPinned')::boolean, false),
    coalesce((notice_payload->>'isHidden')::boolean, false),
    nullif(notice_payload->>'category', ''),
    coalesce((notice_payload->>'hasReward')::boolean, false),
    nullif(notice_payload->>'rewardNote', ''),
    coalesce((notice_payload->>'requiresAction')::boolean, false),
    coalesce(notice_payload->>'surveyReward', ''),
    coalesce(notice_payload->'aiSummary', '[]'::jsonb),
    coalesce(notice_payload->'images', '[]'::jsonb),
    'published',
    'manual',
    notice_payload->>'title',
    notice_payload->>'content',
    'succeeded',
    now(),
    0,
    false
  )
  returning * into created_row;

  if notice_payload ? 'categoryIds' then
    for category_value in select * from jsonb_array_elements(notice_payload->'categoryIds')
    loop
      insert into public.notice_categories (notice_id, category_id)
      select created_row.id, (category_value #>> '{}')::bigint
      from public.categories
      where id = (category_value #>> '{}')::bigint
        and is_active = true
      on conflict do nothing;
    end loop;
  end if;

  if should_notify then
    insert into public.notification_jobs (notice_id, kind, status)
    values (created_row.id, 'new_notice', 'pending')
    on conflict (notice_id, kind) do nothing;
  end if;

  return next created_row;
  return;
end;
$$;

revoke all on function public.create_manual_notice(jsonb, boolean) from public;
grant execute on function public.create_manual_notice(jsonb, boolean) to service_role;

create or replace function public.publish_review_notice(
  target_notice_id bigint,
  edits jsonb default '{}'::jsonb,
  should_notify boolean default true
)
returns setof public.notices
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_row public.notices;
  category_value jsonb;
begin
  update public.notices
  set title = coalesce(nullif(edits->>'title', ''), title),
      content = coalesce(nullif(edits->>'content', ''), content),
      target = coalesce(nullif(edits->>'target', ''), target),
      targets = case when edits ? 'targets' then edits->'targets' else targets end,
      host = coalesce(nullif(edits->>'host', ''), host),
      deadline = case
        when edits ? 'deadline' then nullif(edits->>'deadline', '')::date
        else deadline
      end,
      deadline_at = case
        when edits ? 'deadlineAt' then nullif(edits->>'deadlineAt', '')::timestamptz
        else deadline_at
      end,
      expires_at = case
        when edits ? 'expiresAt' then nullif(edits->>'expiresAt', '')::timestamptz
        else expires_at
      end,
      is_always_open = case
        when edits ? 'isAlwaysOpen' then coalesce((edits->>'isAlwaysOpen')::boolean, false)
        else is_always_open
      end,
      is_pinned = case
        when edits ? 'isPinned' then coalesce((edits->>'isPinned')::boolean, false)
        else is_pinned
      end,
      is_hidden = case
        when edits ? 'isHidden' then coalesce((edits->>'isHidden')::boolean, false)
        else is_hidden
      end,
      category = case when edits ? 'category' then nullif(edits->>'category', '') else category end,
      has_reward = case
        when edits ? 'hasReward' then coalesce((edits->>'hasReward')::boolean, false)
        else has_reward
      end,
      reward_note = case when edits ? 'rewardNote' then nullif(edits->>'rewardNote', '') else reward_note end,
      requires_action = case
        when edits ? 'requiresAction' then coalesce((edits->>'requiresAction')::boolean, false)
        else requires_action
      end,
      survey_reward = case
        when edits ? 'surveyReward' then coalesce(edits->>'surveyReward', '')
        else survey_reward
      end,
      ai_summary = case when edits ? 'aiSummary' then edits->'aiSummary' else ai_summary end,
      keywords = case when edits ? 'keywords' then edits->'keywords' else keywords end,
      attachments = case when edits ? 'attachments' then edits->'attachments' else attachments end,
      analysis_confidence = case
        when edits ? 'analysisConfidence' then (edits->>'analysisConfidence')::numeric
        else analysis_confidence
      end,
      status = 'published',
      reviewed_at = now(),
      published_at = now(),
      updated_at = now()
  where id = target_notice_id
    and status = 'pending_review'
    and is_deleted = false
  returning * into updated_row;

  if updated_row is null then
    raise exception 'NOTICE_NOT_PENDING';
  end if;

  if should_notify then
    insert into public.notification_jobs (notice_id, kind, status)
    values (updated_row.id, 'new_notice', 'pending')
    on conflict (notice_id, kind) do nothing;
  end if;

  if edits ? 'categoryIds' then
    delete from public.notice_categories where notice_id = updated_row.id;
    for category_value in select * from jsonb_array_elements(edits->'categoryIds')
    loop
      insert into public.notice_categories (notice_id, category_id)
      select updated_row.id, (category_value #>> '{}')::bigint
      from public.categories
      where id = (category_value #>> '{}')::bigint
        and is_active = true
      on conflict do nothing;
    end loop;
  end if;

  insert into public.automation_audit_logs (
    action, entity_type, entity_id, metadata
  ) values (
    'notice_published',
    'notice',
    updated_row.id::text,
    jsonb_build_object('notify', should_notify)
  );

  return next updated_row;
  return;
end;
$$;

revoke all on function public.publish_review_notice(bigint, jsonb, boolean) from public;
grant execute on function public.publish_review_notice(bigint, jsonb, boolean) to service_role;

create or replace function public.decide_category_candidate(
  target_candidate_id bigint,
  decision_action text,
  category_name text default null,
  category_slug text default null,
  target_category_id bigint default null,
  defer_until timestamptz default null
)
returns setof public.category_candidates
language plpgsql
security definer
set search_path = public
as $$
declare
  candidate_row public.category_candidates;
  updated_row public.category_candidates;
  selected_category_id bigint;
  next_status text;
begin
  select * into candidate_row
  from public.category_candidates
  where id = target_candidate_id
    and status in ('pending', 'deferred')
  for update;

  if candidate_row is null then
    raise exception 'CATEGORY_CANDIDATE_NOT_PENDING';
  end if;

  if decision_action = 'approve' then
    if nullif(trim(category_name), '') is null
      or nullif(trim(category_slug), '') is null then
      raise exception 'CATEGORY_NAME_AND_SLUG_REQUIRED';
    end if;
    insert into public.categories (name, slug)
    values (trim(category_name), trim(category_slug))
    returning id into selected_category_id;
    next_status := 'approved';
  elsif decision_action = 'merge' then
    select id into selected_category_id
    from public.categories
    where id = target_category_id and is_active = true;
    if selected_category_id is null then
      raise exception 'CATEGORY_NOT_FOUND';
    end if;
    insert into public.category_aliases (
      category_id, alias, normalized_alias
    ) values (
      selected_category_id,
      candidate_row.display_name,
      candidate_row.normalized_keyword
    )
    on conflict (normalized_alias) do update
      set category_id = excluded.category_id,
          alias = excluded.alias;
    next_status := 'merged';
  elsif decision_action = 'reject' then
    next_status := 'rejected';
  elsif decision_action = 'defer' then
    if defer_until is null then
      raise exception 'DEFER_UNTIL_REQUIRED';
    end if;
    next_status := 'deferred';
  else
    raise exception 'INVALID_CATEGORY_DECISION';
  end if;

  if selected_category_id is not null then
    insert into public.notice_categories (notice_id, category_id)
    select notice_id, selected_category_id
    from public.category_candidate_notices
    where candidate_id = candidate_row.id
    on conflict do nothing;
  end if;

  update public.category_candidates
  set status = next_status,
      merged_category_id = selected_category_id,
      deferred_until = case when decision_action = 'defer' then defer_until else null end,
      decided_at = case when decision_action = 'defer' then null else now() end,
      updated_at = now()
  where id = candidate_row.id
  returning * into updated_row;

  insert into public.automation_audit_logs (
    action, entity_type, entity_id, metadata
  ) values (
    'category_candidate_' || decision_action,
    'category_candidate',
    candidate_row.id::text,
    jsonb_build_object(
      'categoryId', selected_category_id,
      'deferredUntil', defer_until
    )
  );

  return next updated_row;
  return;
end;
$$;

revoke all on function public.decide_category_candidate(
  bigint, text, text, text, bigint, timestamptz
) from public;
grant execute on function public.decide_category_candidate(
  bigint, text, text, text, bigint, timestamptz
) to service_role;

create or replace function public.increment_notice_views(target_notice_id bigint)
returns setof public.notices
language plpgsql
security definer
as $$
declare
  updated_row public.notices;
begin
  update public.notices
  set views = views + 1,
      updated_at = now()
  where id = target_notice_id
    and is_deleted = false
  returning * into updated_row;

  if updated_row is null then
    return;
  end if;

  return next updated_row;
  return;
end;
$$;
