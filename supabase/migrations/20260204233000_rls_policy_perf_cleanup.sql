-- RLS policy performance cleanup and duplicate removal.
-- - Replace auth.* calls with SELECT auth.* to avoid initplan per-row eval
-- - Remove duplicate permissive read policies

begin;

-- account_metrics: remove duplicate permissive policy
drop policy if exists "Users can view own metrics" on public.account_metrics;

-- profiles
drop policy if exists "Users can insert their own profile" on public.profiles;
create policy "Users can insert their own profile"
  on public.profiles
  for insert
  to public
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile"
  on public.profiles
  for update
  to public
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can view their own profile" on public.profiles;
create policy "Users can view their own profile"
  on public.profiles
  for select
  to public
  using ((select auth.uid()) = user_id);

-- exchange_credentials
drop policy if exists "Allow individual insert access" on public.exchange_credentials;
create policy "Allow individual insert access"
  on public.exchange_credentials
  for insert
  to public
  with check ((select auth.uid()) = user_id);

drop policy if exists "Allow individual update access" on public.exchange_credentials;
create policy "Allow individual update access"
  on public.exchange_credentials
  for update
  to public
  using ((select auth.uid()) = user_id);

drop policy if exists "Allow individual read access" on public.exchange_credentials;
create policy "Allow individual read access"
  on public.exchange_credentials
  for select
  to public
  using ((select auth.uid()) = user_id);

drop policy if exists "Allow individual delete access" on public.exchange_credentials;
create policy "Allow individual delete access"
  on public.exchange_credentials
  for delete
  to public
  using ((select auth.uid()) = user_id);

-- trading_sessions
drop policy if exists "Allow individual insert access" on public.trading_sessions;
create policy "Allow individual insert access"
  on public.trading_sessions
  for insert
  to public
  with check ((select auth.uid()) = user_id);

drop policy if exists "Allow individual update access" on public.trading_sessions;
create policy "Allow individual update access"
  on public.trading_sessions
  for update
  to public
  using ((select auth.uid()) = user_id);

drop policy if exists "Allow individual read access" on public.trading_sessions;
create policy "Allow individual read access"
  on public.trading_sessions
  for select
  to public
  using ((select auth.uid()) = user_id);

drop policy if exists "Allow individual delete access" on public.trading_sessions;
create policy "Allow individual delete access"
  on public.trading_sessions
  for delete
  to public
  using ((select auth.uid()) = user_id);

-- trade_log
drop policy if exists "trade_log_user_policy" on public.trade_log;
create policy "trade_log_user_policy"
  on public.trade_log
  for all
  to public
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- user_roles: consolidate duplicate permissive select policies
drop policy if exists "Admins can manage all roles" on public.user_roles;
drop policy if exists "Users can view their own roles" on public.user_roles;
-- Idempotency: prod already has these new policies from historical apply;
-- preview branches clone prod and would conflict without the DROP.
drop policy if exists "user_roles_select" on public.user_roles;
drop policy if exists "user_roles_insert_admin" on public.user_roles;
drop policy if exists "user_roles_update_admin" on public.user_roles;
drop policy if exists "user_roles_delete_admin" on public.user_roles;

create policy "user_roles_select"
  on public.user_roles
  for select
  to public
  using (
    has_role((select auth.uid()), 'admin'::app_role)
    or (select auth.uid()) = user_id
  );

create policy "user_roles_insert_admin"
  on public.user_roles
  for insert
  to public
  with check (has_role((select auth.uid()), 'admin'::app_role));

create policy "user_roles_update_admin"
  on public.user_roles
  for update
  to public
  using (has_role((select auth.uid()), 'admin'::app_role))
  with check (has_role((select auth.uid()), 'admin'::app_role));

create policy "user_roles_delete_admin"
  on public.user_roles
  for delete
  to public
  using (has_role((select auth.uid()), 'admin'::app_role));

commit;
