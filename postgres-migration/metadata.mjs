export const TABLES=[
  "applications","apps_settings","bot_messages","bot_status","complaint_form","complaint_history","complaints",
  "composition","custom_roles","ds_channels","ds_guild_roles","ds_members","ds_roles","ds_sync_requests","faq",
  "holiday_state","info_page","learn_materials","news","payroll_archive","payroll_drafts","payroll_send_requests",
  "payroll_settings","raids_events","raids_settings","report_forms","report_send_requests","request_forms","requests",
  "requests_settings","site_data","supply_entries","supply_form","supply_requests","supply_rescan_requests",
  "telegram_bot_status","telegram_notifications","telegram_settings","telegram_topics","test_attempts","test_blocks",
  "test_categories","test_ping_lines","test_questions","test_result_requests","tests","train_categories","train_lessons",
  "user_roles","ustavy","vehicles","violations_history","violations_registry","violations_settings","vp_archive",
  "vp_checks","vp_report_requests","vp_reports","vp_request_forms","vp_role_mapping","vp_settings"
];

export const PRIMARY_KEYS={
  applications:["id"],apps_settings:["id"],bot_messages:["id"],bot_status:["id"],complaint_form:["id"],complaint_history:["id"],complaints:["id"],
  composition:["id"],custom_roles:["key"],ds_channels:["channel_id"],ds_guild_roles:["role_id"],ds_members:["discord_id"],ds_roles:["role_id"],ds_sync_requests:["id"],faq:["id"],
  holiday_state:["id"],info_page:["id"],learn_materials:["id"],news:["id"],payroll_archive:["id"],payroll_drafts:["id"],payroll_send_requests:["id"],payroll_settings:["id"],
  raids_events:["id"],raids_settings:["id"],report_forms:["id"],report_send_requests:["id"],request_forms:["id"],requests:["id"],requests_settings:["id"],site_data:["key"],
  supply_entries:["id"],supply_form:["id"],supply_requests:["id"],supply_rescan_requests:["id"],telegram_bot_status:["id"],telegram_notifications:["id"],telegram_settings:["id"],telegram_topics:["chat_id","thread_id"],
  test_attempts:["id"],test_blocks:["id"],test_categories:["id"],test_ping_lines:["id"],test_questions:["id"],test_result_requests:["id"],tests:["id"],train_categories:["id"],train_lessons:["id"],
  user_roles:["user_id"],ustavy:["id"],vehicles:["id"],violations_history:["id"],violations_registry:["id"],violations_settings:["id"],vp_archive:["id"],vp_checks:["id"],
  vp_report_requests:["id"],vp_reports:["id"],vp_request_forms:["id"],vp_role_mapping:["role_id"],vp_settings:["id"]
};

export const IDENTITY_TABLES=new Set(["news","faq","ustavy","vehicles"]);
