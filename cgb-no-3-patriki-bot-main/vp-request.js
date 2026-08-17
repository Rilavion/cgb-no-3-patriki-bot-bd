/* Запросы наказаний от сотрудников АБ (vp-request.html → violations_registry
 * со status=pending): бот публикует запрос в канал формы
 * (vp_request_forms.channel_id) со статусной реакцией 🕒; после решения
 * администрации (active/refused) — отправляет вердикт и меняет реакцию. */
const { EmbedBuilder } = require("discord.js");
const BOT_TZ = process.env.TIMEZONE || "Europe/Moscow"; // все метки времени бота — по МСК, независимо от часового пояса сервера/ПК
const reactions = require("./reactions");

const KIND_LABELS = { warn:"Предупреждение", reproach:"Выговор", talk:"Беседа с АБ", confinement:"Дисциплинарное заключение", uval:"Отстранение" };
const KIND_ICONS = { warn:"⚠", reproach:"‼", talk:"💬", confinement:"🔒", uval:"⛔" };
const KIND_COLORS = { warn:0xe6b800, reproach:0xe67e22, talk:0x5a8fcd, confinement:0x9b59b6, uval:0xe74c3c };

function ruDT(d){try{return new Date(d).toLocaleString("ru-RU",{timeZone:BOT_TZ,day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"})}catch(e){return String(d||"")}}

function humanKind(kind){ return KIND_LABELS[kind] || kind; }

async function getForm(database, id){
  const { data } = await database.from("vp_request_forms").select("*").eq("id", id||"default").maybeSingle();
  return data;
}

async function resolveDsIds(database, staticStr, discordRaw){
  const ids = new Set();
  const push = v => { if(v && /^\d{15,25}$/.test(String(v))) ids.add(String(v)); };
  if(discordRaw){
    const m = String(discordRaw).match(/(\d{15,25})/);
    if(m) push(m[1]);
  }
  if(staticStr){
    const norm = String(staticStr).replace(/\D/g,"");
    if(norm){
      const { data } = await database.from("ds_members").select("discord_id,parsed_static").limit(2000);
      if(data){
        for(const dm of data){
          if(String(dm.parsed_static||"").replace(/\D/g,"") === norm) push(dm.discord_id);
        }
      }
    }
  }
  return Array.from(ids);
}

function fmtDur(min){
  const t = Math.round(min||0);
  if(t<=0) return "";
  const d = Math.floor(t/1440), h = Math.floor((t%1440)/60), m = t%60;
  const parts = [];
  if(d) parts.push(d+" д");
  if(h) parts.push(h+" ч");
  if(m) parts.push(m+" мин");
  return parts.join(" ") || "0 мин";
}

function buildRequestEmbed(v){
  const extra = v.request_extra || {};
  const kindLbl = humanKind(v.kind);
  const kindIco = KIND_ICONS[v.kind] || "•";
  const color = 0x3a7d6b;
  const e = new EmbedBuilder()
    .setColor(color)
    .setTitle(`⏳ ЗАПРОС НА НАКАЗАНИЕ · ${kindIco} ${kindLbl.toUpperCase()}`)
    .setDescription("**Ожидает решения Администрации**")
    .setTimestamp(new Date(v.requested_at || v.created_at))
    .setFooter({ text: "Администрация Больницы · Запрос от АБ" });
  e.addFields(
    { name: "🎯 Нарушитель", value: (v.target_fio||"—") + (v.target_static?" · `"+v.target_static+"`":"") + (v.target_position?"\n_"+v.target_position+"_":""), inline: false },
    { name: "👮 Запросил", value: (v.requested_by_name||"—") + (v.requested_by_static?" · `"+v.requested_by_static+"`":"") + (v.requested_by_position?"\n_"+v.requested_by_position+"_":""), inline: false },
    { name: "📅 Дата запроса", value: ruDT(v.requested_at||v.created_at), inline: true }
  );
  if(v.kind === "confinement" && v.confinement_minutes){
    e.addFields({ name: "⏱ Запрошенный срок", value: fmtDur(v.confinement_minutes), inline: true });
  }
  if(v.reason){
    e.addFields({ name: "📝 Описание", value: String(v.reason).slice(0,1024), inline: false });
  }
  if(extra.article){
    e.addFields({ name: "📖 Статья / норма", value: String(extra.article).slice(0,1024), inline: false });
  }
  if(v.evidence_url){
    e.addFields({ name: "🔗 Доказательства", value: v.evidence_url, inline: false });
  }
  return e;
}

function buildVerdictEmbed(v, approved){
  const kindLbl = humanKind(v.kind);
  const kindIco = KIND_ICONS[v.kind] || "•";
  if(approved){
    const color = KIND_COLORS[v.kind] || 0x50b450;
    const title = v.kind==="confinement" && v.confinement_minutes
      ? `${kindIco} ${kindLbl.toUpperCase()} · ${fmtDur(v.confinement_minutes)}`
      : `${kindIco} НАКАЗАНИЕ ВЫДАНО · ${kindLbl.toUpperCase()}`;
    const e = new EmbedBuilder()
      .setColor(color)
      .setTitle("✅ " + title)
      .setDescription("Запрос АБ одобрен. Наказание внесено в реестр.")
      .setTimestamp(new Date(v.reviewed_at||Date.now()))
      .setFooter({ text: "Администрация Больницы · Официальный документ" });
    e.addFields(
      { name: "🎯 Нарушитель", value: (v.target_fio||"—") + (v.target_static?" · `"+v.target_static+"`":""), inline: true },
      { name: "👮 Запросил", value: v.requested_by_name||"—", inline: true },
      { name: "⚖ Одобрил", value: v.reviewed_by_name||"—", inline: true }
    );
    if(v.reason) e.addFields({ name: "📝 Причина", value: String(v.reason).slice(0,1024), inline: false });
    if(v.evidence_url) e.addFields({ name: "🔗 Доказательства", value: v.evidence_url, inline: false });
    if(v.reviewer_comment) e.addFields({ name: "💬 Комментарий администрации", value: String(v.reviewer_comment).slice(0,1024), inline: false });
    if(v.expires_at) e.addFields({ name: "⏱ Действует до", value: ruDT(v.expires_at), inline: true });
    return e;
  } else {
    const e = new EmbedBuilder()
      .setColor(0x7a8a4a)
      .setTitle("❌ ЗАПРОС ОТКЛОНЁН · " + kindLbl.toUpperCase())
      .setDescription("Запрос АБ отклонён администрацией. Наказание НЕ выдано.")
      .setTimestamp(new Date(v.reviewed_at||Date.now()))
      .setFooter({ text: "Администрация Больницы · Отказ по запросу" });
    e.addFields(
      { name: "🎯 О ком запрос", value: (v.target_fio||"—") + (v.target_static?" · `"+v.target_static+"`":""), inline: true },
      { name: "👮 Запросил", value: v.requested_by_name||"—", inline: true },
      { name: "⚖ Отклонил", value: v.reviewed_by_name||"—", inline: true }
    );
    if(v.reviewer_comment) e.addFields({ name: "💬 Причина отказа", value: String(v.reviewer_comment).slice(0,1024), inline: false });
    return e;
  }
}

async function postRequest(database, guild, v){
  const form = await getForm(database, v.request_source);
  const chId = (form && form.channel_id) || null;
  if(!chId){ console.warn("[ab-req] postRequest: no channel for form", v.request_source); return null; }
  const ch = await guild.channels.fetch(chId).catch(()=>null);
  if(!ch || !ch.isTextBased()) return null;

  const targetIds = await resolveDsIds(database, v.target_static, null);
  const authorIds = await resolveDsIds(database, v.requested_by_static, null);
  const roleIds = [form && form.ping_role_id, form && form.ping_role_id_2].filter(Boolean);
  const parts = [];
  const allow = {};
  if(roleIds.length){ parts.push(...roleIds.map(r=>"<@&"+r+">")); allow.roles = roleIds; }
  const users = new Set([...targetIds, ...authorIds]);
  if(users.size){ parts.push(...Array.from(users).map(u=>"<@"+u+">")); allow.users = Array.from(users); }

  const embed = buildRequestEmbed(v);
  try{
    const m = await ch.send({ content: parts.join(" ") || undefined, embeds:[embed], allowedMentions: Object.keys(allow).length?allow:{parse:[]} });
    await database.from("violations_registry").update({ ds_channel_id: ch.id, ds_message_id: m.id }).eq("id", v.id);
    try{ await m.react(reactions.EMOJI.pending); }catch(e){}
    return m;
  }catch(e){ console.warn("[ab-req] postRequest send:", e.message); return null; }
}

async function postVerdict(database, guild, v, approved){
  const form = await getForm(database, v.request_source);
  const chId = (form && form.verdict_channel_id) || (form && form.channel_id);
  if(!chId){ console.warn("[ab-req] postVerdict: no channel"); return null; }
  const ch = await guild.channels.fetch(chId).catch(()=>null);
  if(!ch || !ch.isTextBased()) return null;

  const targetIds = await resolveDsIds(database, v.target_static, null);
  const authorIds = await resolveDsIds(database, v.requested_by_static, null);
  const roleIds = [form && form.ping_role_id, form && form.ping_role_id_2].filter(Boolean);
  const parts = [];
  const allow = {};
  if(roleIds.length){ parts.push(...roleIds.map(r=>"<@&"+r+">")); allow.roles = roleIds; }
  const users = new Set([...targetIds, ...authorIds]);
  if(users.size){ parts.push(...Array.from(users).map(u=>"<@"+u+">")); allow.users = Array.from(users); }

  const embed = buildVerdictEmbed(v, approved);
  try{
    const m = await ch.send({ content: parts.join(" ") || undefined, embeds:[embed], allowedMentions: Object.keys(allow).length?allow:{parse:[]} });
    await database.from("violations_registry").update({ verdict_ds_message_id: m.id }).eq("id", v.id);
    if(v.ds_channel_id && v.ds_message_id){
      await reactions.setStatus(guild.client, v.ds_channel_id, v.ds_message_id, approved?"approved":"rejected");
    }
    return m;
  }catch(e){ console.warn("[ab-req] postVerdict send:", e.message); return null; }
}

async function pollPending(database, client){
  try{
    const guild = client.guilds.cache.first();
    if(!guild) return;

    const { data: pending } = await database.from("violations_registry")
      .select("*").eq("status","pending").is("ds_message_id", null).limit(10);
    if(pending){
      for(const v of pending){
        console.log("[ab-req] new request:", v.id, v.kind, "for", v.target_static);
        await postRequest(database, guild, v);
      }
    }

    const { data: reviewed } = await database.from("violations_registry")
      .select("*").in("status",["active","refused"]).not("reviewed_at","is",null).is("verdict_ds_message_id", null).not("ds_message_id","is",null).limit(10);
    if(reviewed){
      for(const v of reviewed){
        console.log("[ab-req] verdict:", v.id, "->", v.status);
        await postVerdict(database, guild, v, v.status==="active");
      }
    }
  }catch(e){ console.warn("[ab-req] poll:", e.message); }
}

function subscribe(database, client){
  console.log("[ab-req] polling every 10s");
  setInterval(async ()=>{ await pollPending(database, client); }, 10*1000);
  setTimeout(async ()=>{ await pollPending(database, client); }, 15*1000);
}

module.exports = { subscribe, postRequest, postVerdict };
