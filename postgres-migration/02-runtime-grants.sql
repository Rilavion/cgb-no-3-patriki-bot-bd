-- Запускать владельцем БД после 01-schema.sql.
-- Групповые роли не содержат паролей. Владелец создаёт LOGIN-пользователей
-- отдельно и включает их в нужную роль, как показано в руководстве.

do $$
begin
  if not exists (select 1 from pg_roles where rolname='cgb_api_role') then
    create role cgb_api_role nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname='cgb_bot_role') then
    create role cgb_bot_role nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname='cgb_telegram_role') then
    create role cgb_telegram_role nologin;
  end if;
end $$;

do $$
begin
  execute format('grant connect on database %I to cgb_api_role, cgb_bot_role, cgb_telegram_role', current_database());
end $$;

grant usage on schema public, auth to cgb_api_role, cgb_bot_role;
grant execute on all functions in schema public, auth to cgb_api_role, cgb_bot_role;
grant select, insert, update, delete on all tables in schema public to cgb_api_role, cgb_bot_role;
grant usage, select on all sequences in schema public to cgb_api_role, cgb_bot_role;
revoke all on table public.users, public.refresh_tokens, public.user_roles, public.custom_roles from cgb_bot_role;

grant usage on schema public to cgb_telegram_role;
grant select, insert, update, delete on table
  public.telegram_settings,
  public.telegram_topics,
  public.telegram_notifications,
  public.telegram_bot_status
to cgb_telegram_role;
grant usage, select on all sequences in schema public to cgb_telegram_role;

alter default privileges in schema public
  grant select, insert, update, delete on tables to cgb_api_role;
alter default privileges in schema public
  grant usage, select on sequences to cgb_api_role, cgb_bot_role;
alter default privileges in schema public
  grant execute on functions to cgb_api_role, cgb_bot_role;
