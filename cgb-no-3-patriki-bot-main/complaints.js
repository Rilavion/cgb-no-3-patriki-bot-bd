/* Жалобы и реестр нарушений (модуль Администрации Больницы):
 *  • новая жалоба (complaints, status=new) → публикация в канал жалоб,
 *  • вердикт по жалобе → отдельное сообщение + смена реакции,
 *  • нарушение (violations_registry, notify_mode=notify) → публикация,
 *  • снятие нарушения (вручную или по истечении срока) → публикация,
 *  • авто-эскалация: N активных предупреждений → выговор (каждый час),
 *  • синхронизация ролей сервера → ds_guild_roles (каждые 30 мин). */
const { EmbedBuilder } = require("discord.js");
const BOT_TZ = process.env.TIMEZONE || "Europe/Moscow"; // все метки времени бота — по МСК, независимо от часового пояса сервера/ПК
const reactions = require("./reactions");

const KIND_LABELS = { warn:"Предупреждение", reproach:"Выговор", talk:"Беседа с АБ", confinement:"Дисциплинарное заключение", uval:"Отстранение" };
const KIND_COLORS = { warn:0xe6b800, reproach:0xe67e22, talk:0x5a8fcd, confinement:0x9b59b6, uval:0xe74c3c };
const KIND_ICONS  = { warn:"⚠", reproach:"‼", talk:"💬", confinement:"🔒", uval:"⛔" };
const VERDICT_LABELS = { refuse:"Отказано", warn:"Предупреждение", reproach:"Выговор", talk:"Беседа с АБ", confinement:"Дисциплинарное заключение", uval:"Отстранение" };
const VERDICT_COLORS = { refuse:0x7a8a4a, warn:0xe6b800, reproach:0xe67e22, talk:0x5a8fcd, confinement:0x9b59b6, uval:0xe74c3c };
const VERDICT_ICONS  = { refuse:"✕", warn:"⚠", reproach:"‼", talk:"💬", confinement:"🔒", uval:"⛔" };

const FIELD_LABELS = {
  submitter_fio:"ФИО заявителя",
  submitter_static:"Статик заявителя",
  submitter_discord:"Discord заявителя",
  submitter_position:"Должность заявителя",
  target_fio:"ФИО нарушителя",
  target_static:"Статик нарушителя",
  target_position:"Должность нарушителя",
  incident_date:"Дата и время инцидента",
  article:"Нарушенная статья",
  description:"Суть нарушения",
  norms:"Нарушенные нормы (ВУ ЦГБ №3, УК, ПК и иные)",
  evidence_url:"Ссылка на доказательство"
};

function ruDT(d){try{return new Date(d).toLocaleString("ru-RU",{timeZone:BOT_TZ,day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"})}catch(e){return String(d||"")}}
function ruDate(d){try{return new Date(d).toLocaleDateString("ru-RU",{timeZone:BOT_TZ,day:"2-digit",month:"2-digit",year:"numeric"})}catch(e){return String(d||"")}}
function labelOf(k){ return FIELD_LABELS[k] || k }
function normalizeStatic(s){ return String(s||"").replace(/[^0-9]/g,"") }

async function getSettings(database){
  const { data } = await database.from("violations_settings").select("*").eq("id",1).maybeSingle();
  return data;
}

async function resolveDsId(database, guild, opts){
  const ids = new Set();
  const push = (v) => { if(v && /^\d{15,25}$/.test(String(v))) ids.add(String(v)); };
  push(opts.explicit_id);
  const stat = normalizeStatic(opts.static);
  if(stat){
    try{
      const { data } = await database.from("ds_members").select("discord_id,raw_nick,parsed_static").limit(2000);
      if(data){
        for(const m of data){
          const ms = normalizeStatic(m.parsed_static);
          if(ms && ms === stat){ push(m.discord_id); }
        }
      }
    }catch(e){ console.warn("[complaints] resolveDsId:", e.message) }
  }
  return Array.from(ids);
}

async function collectMentions(database, guild, targets){
  const ids = new Set();
  for(const t of targets){
    const found = await resolveDsId(database, guild, t);
    for(const id of found) ids.add(id);
  }
  const arr = Array.from(ids);
  const settings = await getSettings(database);
  const roleId = settings && settings.ping_role_id;
  const parts = [];
  const allow = {};
  if(arr.length) allow.users = arr;
  if(roleId){
    parts.push("<@&"+roleId+">");
    allow.roles = [roleId];
  }
  parts.push(...arr.map(id => "<@"+id+">"));
  return { content: parts.join(" "), allowedMentions: Object.keys(allow).length ? allow : { parse: [] } };
}

function violationChannelForKind(settings, kind){
  if(kind === "confinement" && settings && settings.confinement_channel_id) return settings.confinement_channel_id;
  return settings && (settings.report_channel_id || settings.verdicts_channel_id);
}
function complaintVerdictChannel(settings){
  return settings && (settings.verdicts_channel_id || settings.report_channel_id);
}

function confinementLen(minutes){
  const totalMin = Math.round(minutes || 0);
  if(totalMin <= 0) return "";
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  const parts = [];
  if(d) parts.push(d + " д");
  if(h) parts.push(h + " ч");
  if(m) parts.push(m + " мин");
  return parts.join(" ") || "0 мин";
}
function confMinutesOf(v){
  if(v.confinement_minutes != null) return v.confinement_minutes;
  if(v.confinement_hours != null) return Math.round(v.confinement_hours * 60);
  return 0;
}

function buildComplaintEmbed(complaint){
  const e = new EmbedBuilder()
    .setColor(0x3a7d6b)
    .setTitle("📨 НОВАЯ ЖАЛОБА · " + complaint.code)
    .setDescription(`Подана: ${ruDT(complaint.created_at)}`)
    .setTimestamp(new Date(complaint.created_at));

  const submitterLine = `**${complaint.submitter_fio||"—"}**${complaint.submitter_static?" · `"+complaint.submitter_static+"`":""}${complaint.submitter_discord?" · "+complaint.submitter_discord:""}`;
  const targetLine = `**${complaint.target_fio||"—"}**${complaint.target_static?" · `"+complaint.target_static+"`":""}`;
  e.addFields(
    { name: "📬 Заявитель", value: submitterLine, inline: false },
    { name: "🎯 Нарушитель", value: targetLine, inline: false }
  );

  const values = complaint.values || {};
  const skipKeys = new Set(["submitter_fio","submitter_static","submitter_discord","target_fio","target_static","evidence_url"]);
  for(const [k, v] of Object.entries(values)){
    if(!v || skipKeys.has(k)) continue;
    e.addFields({ name: labelOf(k), value: String(v).slice(0, 1024), inline: false });
  }

  if(complaint.evidence_url){
    e.addFields({ name: "🔗 Доказательство", value: complaint.evidence_url, inline: false });
  }
  e.setFooter({ text: "Администрация Больницы · Код жалобы: " + complaint.code });
  return e;
}

async function postNewComplaint(database, guild, complaint){
  const s = await getSettings(database);
  if(!s || !s.complaints_channel_id) return null;
  const ch = await guild.channels.fetch(s.complaints_channel_id).catch(()=>null);
  if(!ch || !ch.isTextBased()) return null;
  const embed = buildComplaintEmbed(complaint);
  const ping = await collectMentions(database, guild, [
    { explicit_id: complaint.target_discord_id, static: complaint.target_static },
    { explicit_id: complaint.submitter_discord, static: complaint.submitter_static }
  ]);
  try{
    const m = await ch.send({ content: ping.content || undefined, embeds: [embed], allowedMentions: ping.allowedMentions });
    await database.from("complaints").update({ ds_channel_id: ch.id, ds_message_id: m.id }).eq("id", complaint.id);
    try{ await m.react(reactions.EMOJI.pending); }catch(e){ console.warn("[complaints] react pending:", e.message); }
    return m;
  }catch(e){ console.warn("[complaints] postNew:", e.message); return null }
}

function complaintVerdictToReaction(verdict){
  if(verdict === "refuse") return "rejected";
  if(verdict === "withdrawn" || verdict === "canceled" || verdict === "cancelled") return "withdrawn";
  if(verdict) return "approved";
  return null;
}

function verdictOf(c){ return c.verdict || c.verdict_kind || null; }

function buildVerdictEmbed(complaint){
  const v = verdictOf(complaint);
  const label = VERDICT_LABELS[v] || v;
  const color = VERDICT_COLORS[v] || 0x888888;
  const icon = VERDICT_ICONS[v] || "•";
  const e = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${icon} ВЕРДИКТ · ${String(label||"").toUpperCase()}`)
    .setDescription(`**Жалоба:** \`${complaint.code}\`\n**Дата решения:** ${ruDT(complaint.verdict_at)}`)
    .addFields(
      { name: "📬 Заявитель", value: (complaint.submitter_fio||"—")+(complaint.submitter_static?" · `"+complaint.submitter_static+"`":""), inline:true },
      { name: "🎯 Нарушитель", value: (complaint.target_fio||"—")+(complaint.target_static?" · `"+complaint.target_static+"`":""), inline:true },
      { name: "⚖ Решение вынес", value: complaint.verdict_by_name||"—", inline:true }
    );
  if(complaint.verdict_comment){
    e.addFields({ name: "📝 Комментарий", value: String(complaint.verdict_comment).slice(0,1024), inline:false });
  }
  if(complaint.evidence_url){
    e.addFields({ name: "🔗 Доказательство", value: complaint.evidence_url, inline:false });
  }
  e.setFooter({ text: "Администрация Больницы · Официальный документ · " + complaint.code });
  e.setTimestamp(new Date(complaint.verdict_at||Date.now()));
  return e;
}

async function postVerdict(database, guild, complaint){
  const s = await getSettings(database);
  const chId = complaintVerdictChannel(s);
  if(!chId) return null;
  const ch = await guild.channels.fetch(chId).catch(()=>null);
  if(!ch || !ch.isTextBased()) return null;
  const embed = buildVerdictEmbed(complaint);
  const ping = await collectMentions(database, guild, [
    { explicit_id: complaint.target_discord_id, static: complaint.target_static },
    { explicit_id: complaint.submitter_discord, static: complaint.submitter_static }
  ]);
  try{
    const m = await ch.send({ content: ping.content || undefined, embeds:[embed], allowedMentions: ping.allowedMentions });
    await database.from("complaints").update({ verdict_ds_message_id: m.id }).eq("id", complaint.id);
    if(complaint.ds_channel_id && complaint.ds_message_id){
      const target = complaintVerdictToReaction(verdictOf(complaint)) || "pending";
      await reactions.setStatus(guild.client, complaint.ds_channel_id, complaint.ds_message_id, target);
    }
    return m;
  }catch(e){ console.warn("[complaints] postVerdict:", e.message); return null }
}

function buildViolationEmbed(violation){
  const kind = violation.kind;
  const label = KIND_LABELS[kind] || kind;
  const color = KIND_COLORS[kind] || 0x888888;
  const icon = KIND_ICONS[kind] || "•";
  const cm = confMinutesOf(violation);
  const title = kind === "confinement" && cm > 0
    ? `${icon} ${label.toUpperCase()} · ${confinementLen(cm)}`
    : `${icon} НАРУШЕНИЕ · ${label.toUpperCase()}`;
  const e = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription("Внесено в реестр нарушений сотрудников")
    .addFields(
      { name: "👮 Кто выдал", value: violation.issued_by_name || "—", inline:true },
      { name: "🎯 Кто получил", value: (violation.target_fio||"—")+(violation.target_static?" · `"+violation.target_static+"`":""), inline:true },
      { name: "📅 Дата выдачи", value: ruDT(violation.created_at), inline:true },
      { name: "📝 Причина", value: String(violation.reason||"—").slice(0,1024), inline:false }
    );
  if(violation.evidence_url){
    e.addFields({ name: "🔗 Доказательство", value: violation.evidence_url, inline:false });
  }
  if(violation.expires_at){
    const expShown = kind === "confinement" ? ruDT(violation.expires_at) : ruDate(violation.expires_at);
    e.addFields({ name: "⏱ Действует до", value: expShown, inline:true });
  }
  if(violation.target_position){
    e.addFields({ name: "🎖 Должность нарушителя", value: violation.target_position, inline:true });
  }
  e.setFooter({ text: "Администрация Больницы · Официальный документ" });
  e.setTimestamp(new Date(violation.created_at||Date.now()));
  return e;
}

async function postViolation(database, guild, violation){
  if(violation.notify_mode !== "notify") return null;
  const s = await getSettings(database);
  const chId = violationChannelForKind(s, violation.kind);
  if(!chId) return null;
  const ch = await guild.channels.fetch(chId).catch(()=>null);
  if(!ch || !ch.isTextBased()) return null;
  const embed = buildViolationEmbed(violation);
  const ping = await collectMentions(database, guild, [
    { explicit_id: violation.target_discord_id, static: violation.target_static },
    { explicit_id: violation.issued_by_discord_id, static: null }
  ]);
  try{
    const m = await ch.send({ content: ping.content || undefined, embeds:[embed], allowedMentions: ping.allowedMentions });
    await database.from("violations_registry").update({ ds_channel_id: ch.id, ds_message_id: m.id }).eq("id", violation.id);
    return m;
  }catch(e){ console.warn("[complaints] postViolation:", e.message); return null }
}

async function postRemoval(database, guild, violation, autoExpired){
  const s = await getSettings(database);
  const chId = s && (s.removal_channel_id || s.verdicts_channel_id || s.report_channel_id);
  if(!chId){
    console.warn("[complaints] postRemoval: НЕТ КАНАЛА (ни removal_channel_id, ни verdicts, ни report) — снятие", violation.id, "не будет отправлено. Настрой каналы на сайте.");
    await database.from("violations_registry").update({ removed_ds_message_id: "SKIP:no_channel" }).eq("id", violation.id);
    return null;
  }
  const ch = await guild.channels.fetch(chId).catch(err=>{ console.warn("[complaints] postRemoval channel fetch err:", chId, err.message); return null });
  if(!ch || !ch.isTextBased()){
    console.warn("[complaints] postRemoval: канал", chId, "не найден или не текстовый");
    await database.from("violations_registry").update({ removed_ds_message_id: "SKIP:no_channel_access" }).eq("id", violation.id);
    return null;
  }
  const kind = violation.kind;
  const label = KIND_LABELS[kind] || kind;
  const e = new EmbedBuilder()
    .setColor(0x50b450)
    .setTitle(`✓ СНЯТИЕ · ${label.toUpperCase()}`)
    .setDescription(autoExpired ? "⏱ Срок действия нарушения истёк, оно снято автоматически." : "✂ Нарушение снято решением Администрации Больницы.")
    .addFields(
      { name: "🎯 С кого снято", value: (violation.target_fio||"—")+(violation.target_static?" · `"+violation.target_static+"`":""), inline:true },
      { name: "👮 Снял", value: violation.removed_by_name || "Система", inline:true },
      { name: "📅 Изначальная выдача", value: ruDT(violation.created_at), inline:true },
      { name: "📝 За что было", value: String(violation.reason||"—").slice(0,1024), inline:false }
    );
  if(violation.removed_reason){
    e.addFields({ name: "💬 Комментарий к снятию", value: String(violation.removed_reason).slice(0,1024), inline:false });
  }
  e.setFooter({ text: "Администрация Больницы · Реестр нарушений" });
  e.setTimestamp(new Date(violation.removed_at||Date.now()));
  const ping = await collectMentions(database, guild, [
    { explicit_id: violation.target_discord_id, static: violation.target_static }
  ]);
  try{
    const m = await ch.send({ content: ping.content || undefined, embeds:[e], allowedMentions: ping.allowedMentions });
    await database.from("violations_registry").update({ removed_ds_message_id: m.id }).eq("id", violation.id);
    console.log("[complaints] postRemoval OK:", violation.id, "→", m.id);
    return m;
  }catch(err){
    console.warn("[complaints] postRemoval SEND err:", err.message);
    await database.from("violations_registry").update({ removed_ds_message_id: "ERR:"+err.message.slice(0,50) }).eq("id", violation.id);
    return null;
  }
}

async function checkExpirations(database, guild){
  try{
    const { data:expired } = await database.from("violations_registry")
      .select("*").is("removed_at", null).lt("expires_at", new Date().toISOString()).neq("kind","uval").or("status.is.null,status.eq.active");
    if(!expired || !expired.length) return 0;
    for(const v of expired){
      const nowIso = new Date().toISOString();
      const upd = { removed_at: nowIso, removed_reason: "Автоматически: срок действия истёк", removed_by_name: "Система" };
      const { data:updated } = await database.from("violations_registry").update(upd).eq("id", v.id).select().single();
      const merged = updated || Object.assign({}, v, upd);
      await postRemoval(database, guild, merged, true);
    }
    return expired.length;
  }catch(e){ console.warn("[complaints] checkExpirations:", e.message); return 0 }
}

async function checkEscalations(database, guild){
  try{
    const s = await getSettings(database);
    const thr = (s && s.warn_to_reproach_threshold) || 3;
    const { data:allActive } = await database.from("violations_registry")
      .select("*").is("removed_at", null).eq("kind", "warn").or("status.is.null,status.eq.active");
    if(!allActive || !allActive.length) return 0;
    const byStatic = new Map();
    for(const v of allActive){
      const k = v.target_static || v.target_fio;
      if(!byStatic.has(k)) byStatic.set(k, []);
      byStatic.get(k).push(v);
    }
    let converted = 0;
    for(const [k, warns] of byStatic){
      if(warns.length < thr) continue;
      const first = warns[0];
      const now = new Date();
      const reprDays = (s && s.expire_reproach_days) || 30;
      const expires = new Date(now.getTime() + reprDays*86400000).toISOString();
      const insert = {
        target_fio: first.target_fio,
        target_static: first.target_static,
        target_discord_id: first.target_discord_id,
        target_position: first.target_position,
        kind: "reproach",
        reason: `Автоматическая конвертация: ${warns.length} активных предупреждений превысили порог ${thr}`,
        notify_mode: "notify",
        issued_by_name: "Система",
        expires_at: expires,
        escalated_from: { warn_ids: warns.map(w=>w.id), threshold: thr }
      };
      const { data:created } = await database.from("violations_registry").insert(insert).select().single();
      const ids = warns.map(w=>w.id);
      await database.from("violations_registry").update({
        removed_at: new Date().toISOString(),
        removed_reason: "Автоматически конвертировано в выговор",
        removed_by_name: "Система"
      }).in("id", ids);
      if(created && guild) await postViolation(database, guild, created);
      converted++;
    }
    return converted;
  }catch(e){ console.warn("[complaints] checkEscalations:", e.message); return 0 }
}

async function backfillComplaintReactions(database, client){
  try{
    const { data: rows } = await database.from("complaints")
      .select("id,status,verdict,ds_channel_id,ds_message_id")
      .not("ds_message_id","is",null)
      .order("id", { ascending: false })
      .limit(100);
    if(!rows || !rows.length) return;
    console.log("[complaints] backfillReactions:", rows.length);
    for(const c of rows){
      let target = "pending";
      if(c.status === "decided") target = complaintVerdictToReaction(c.verdict) || "approved";
      else if(c.status === "withdrawn" || c.status === "canceled" || c.status === "cancelled") target = "withdrawn";
      await reactions.setStatus(client, c.ds_channel_id, c.ds_message_id, target);
    }
  }catch(e){ console.warn("[complaints] backfillReactions:", e.message) }
}

async function pollPending(database, guild){
  try{
    const { data:newComplaints } = await database.from("complaints")
      .select("*").is("ds_message_id", null).limit(20);
    if(newComplaints){
      for(const c of newComplaints){
        console.log("[complaints] poll: new complaint", c.code);
        await postNewComplaint(database, guild, c);
      }
    }

    const { data:pendingVerdicts } = await database.from("complaints")
      .select("*").eq("status","decided").is("verdict_ds_message_id", null).limit(20);
    if(pendingVerdicts){
      for(const c of pendingVerdicts){
        console.log("[complaints] poll: verdict for", c.code);
        await postVerdict(database, guild, c);
      }
    }

    const { data:withdrawnComplaints } = await database.from("complaints")
      .select("id,status,ds_channel_id,ds_message_id")
      .in("status", ["withdrawn","canceled","cancelled"])
      .not("ds_message_id","is",null)
      .order("id", { ascending: false })
      .limit(20);
    if(withdrawnComplaints){
      for(const c of withdrawnComplaints){
        await reactions.setWithdrawn(guild.client, c.ds_channel_id, c.ds_message_id);
      }
    }

    const { data:newViolationsRaw } = await database.from("violations_registry")
      .select("*").is("ds_message_id", null).eq("notify_mode","notify").is("removed_at", null).limit(50);
    const newViolations = (newViolationsRaw||[]).filter(v =>
      (v.status===null || v.status==="active") && !v.requested_at && !v.request_source
    );
    if(newViolations.length){
      for(const v of newViolations){
        console.log("[complaints] poll: new violation", v.kind, v.target_static, "status:", v.status);
        await postViolation(database, guild, v);
      }
    }

    const { data:removedRaw, error:remErr } = await database.from("violations_registry")
      .select("*").not("removed_at","is",null).is("removed_ds_message_id", null).limit(50);
    if(remErr) console.warn("[complaints] poll removed err:", remErr.message);
    const removed = (removedRaw||[]).filter(v => v.status !== "pending" && v.status !== "refused");
    if(removed.length){
      console.log("[complaints] poll: found", removed.length, "removed to notify");
      for(const v of removed){
        const auto = v.removed_by_name === "Система";
        console.log("[complaints] poll: removal", v.kind, v.id, "auto:", auto, "source:", v.request_source||"manual");
        await postRemoval(database, guild, v, auto);
      }
    }
    if(removedRaw && removedRaw.length > removed.length){
      const skipIds = removedRaw.filter(v => v.status === "pending" || v.status === "refused").map(v=>v.id);
      if(skipIds.length){
        await database.from("violations_registry").update({ removed_ds_message_id: "SKIP:vp_refused" }).in("id", skipIds);
      }
    }
  }catch(e){ console.warn("[complaints] pollPending:", e.message) }
}

async function syncGuildRoles(database, guild){
  try{
    const roles = await guild.roles.fetch();
    const rows = [];
    for(const r of roles.values()){
      if(r.id === guild.id) continue;
      if(r.managed) continue;
      rows.push({ role_id: r.id, name: r.name, color: r.color, position: r.position, updated_at: new Date().toISOString() });
    }
    if(rows.length){
      await database.from("ds_guild_roles").upsert(rows, { onConflict: "role_id" });
    }
    const validIds = new Set(rows.map(r=>r.role_id));
    const { data:existing } = await database.from("ds_guild_roles").select("role_id");
    if(existing){
      const toDelete = existing.filter(x=>!validIds.has(x.role_id)).map(x=>x.role_id);
      if(toDelete.length) await database.from("ds_guild_roles").delete().in("role_id", toDelete);
    }
    console.log("[complaints] synced", rows.length, "guild roles");
    return rows.length;
  }catch(e){ console.warn("[complaints] syncGuildRoles:", e.message); return 0 }
}

function subscribe(database, client){
  console.log("[complaints] polling every 15s + expirations every 1h + roles every 30min");

  setInterval(async ()=>{
    const guild = client.guilds.cache.first();
    if(!guild) return;
    const exp = await checkExpirations(database, guild);
    const esc = await checkEscalations(database, guild);
    if(exp || esc) console.log("[complaints] hourly: expired=", exp, "escalated=", esc);
  }, 60*60*1000);

  setInterval(async ()=>{
    const guild = client.guilds.cache.first();
    if(!guild) return;
    await syncGuildRoles(database, guild);
  }, 30*60*1000);

  setInterval(async ()=>{
    const guild = client.guilds.cache.first();
    if(!guild) return;
    await pollPending(database, guild);
  }, 15*1000);

  setTimeout(async ()=>{
    const guild = client.guilds.cache.first();
    if(!guild) return;
    await syncGuildRoles(database, guild);
    const exp = await checkExpirations(database, guild);
    const esc = await checkEscalations(database, guild);
    await pollPending(database, guild);
    if(exp || esc) console.log("[complaints] startup: expired=", exp, "escalated=", esc);
  }, 30*1000);

  setTimeout(async ()=>{
    await backfillComplaintReactions(database, client);
  }, 40*1000);
}

module.exports = { subscribe, postNewComplaint, postVerdict, postViolation, postRemoval, checkExpirations, checkEscalations, backfillComplaintReactions };
