-- Lift + Keto cloud backup. Run once in the Supabase SQL Editor.
create table if not exists public.docs (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  id text not null,
  data jsonb,
  ts bigint not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

alter table public.docs enable row level security;

drop policy if exists "own docs" on public.docs;
create policy "own docs" on public.docs
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update, delete on public.docs to authenticated;

create or replace function public.touch_docs() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at = clock_timestamp();
  return new;
end $$;

drop trigger if exists docs_touch on public.docs;
create trigger docs_touch before insert or update on public.docs
  for each row execute function public.touch_docs();

create index if not exists docs_user_updated on public.docs (user_id, updated_at);
