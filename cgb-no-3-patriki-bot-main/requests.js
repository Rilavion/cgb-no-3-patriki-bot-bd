/* Заявки персонала (отгул / отпуск IC / отпуск OOC / увольнение / повышение /
 * восстановление): сайт пишет строку в requests, бот публикует её в канал
 * формы (request_forms.channel_id) со статусной реакцией 🕒; после вердикта
 * на сайте — отправляет результат (request_forms.verdict_channel_id) и меняет
 * реакцию на ✅ / ❌ / ↩️. Для повышения поддержан роутинг по отделам
 * (rank_matrix.departments). */
const { EmbedBuilder } = require("discord.js");
const BOT_TZ = process.env.TIMEZONE || "Europe/Moscow"; // все метки времени бота — по МСК, независимо от часового пояса сервера/ПК
const reactions = require("./reactions");

const KIND_META = {
  leave:{ label:"Отгул", icon:"🕒", color:0x38bdf8 },
  vacation_ic:{ label:"Отпуск (IC)", icon:"🏖", color:0x8fd97a },
  vacation_ooc:{ label:"Отпуск (OOC)", icon:"💤", color:0xa2d8ff },
  dismissal:{ label:"Увольнение", icon:"⛔", color:0xe97a7a },
  promotion:{ label:"Повышение в должности", icon:"⭐", color:0xa5f3fc },
  restoration:{ label:"Восстановление в ЦГБ №3", icon:"🔄", color:0x7ac3f0 },
  appointment:{ label:"Запись к врачу", icon:"🩺", color:0x34d399 }
};

const FIELD_LABELS = {
  submitter_fio:"ФИО", submitter_static:"Статик", submitter_discord:"Discord", position:"Должность", department:"Отдел",
  leave_date:"Дата отгула", split:"Разбить 2×30", time_start:"Начало ч.1", time_start_2:"Начало ч.2", duration:"Длительность (мин)",
  reason:"Причина/Обоснование", mil_id:"Мед. книжка №", from_date:"Дата начала", to_date:"Дата окончания",
  current_rank:"Текущая должность", target_rank:"Желаемая должность", exam_link:"Аттестация", supply_link:"Поставки", vp_link:"Проверка АБ",
  achievements:"Достижения", return_gear:"Сдача имущества",
  restore_type:"Тип восстановления", vb_rank:"Должность в МК/удостоверении", dismissed_at:"Дата увольнения",
  dismiss_reason:"Причина прошлого увольнения", name_changed:"Смена имени/фамилии",
  vb_screenshot:"Скрин МК", passport_screenshot:"Скрин паспорта", personal_file:"Личное дело",
  certificates:"Справки", udost_screenshot:"Скрин удостоверения",
  ready_reattest:"Готов на переаттестацию", rules_ack:"Согласен с правилами", comment:"Комментарий",
  appt_dept:"Отделение", doctor:"Конкретный врач", appt_date:"Желаемая дата", appt_time:"Желаемое время (МСК)",
  address:"Место жительства", phone:"Контактный номер", urgency:"Характер жалобы / срочность"
};

function ruDT(d){try{return new Date(d).toLocaleString("ru-RU",{timeZone:BOT_TZ,day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"})}catch(e){return String(d||"")}}

async function getForm(database, kind){
  const { data } = await database.from("request_forms").select("*").eq("id", kind).maybeSingle();
  return data;
}

function buildEmbed(req, extraLabels){
  const m = KIND_META[req.kind] || { label:req.kind, icon:"📋", color:0x888888 };
  const e = new EmbedBuilder()
    .setColor(m.color)
    .setTitle(`${m.icon} ${m.label.toUpperCase()} · ${req.code}`)
    .setDescription("**"+(req.submitter_fio||"—")+"**"+(req.submitter_static?" · `"+req.submitter_static+"`":""))
    .setTimestamp(new Date(req.created_at));
  const skip = new Set(["submitter_fio","submitter_static","submitter_discord"]);
  const labels = Object.assign({}, FIELD_LABELS, extraLabels || {});
  const entries = Object.entries(req.values || {});
  const priority = ["department","current_rank","target_rank","position","leave_date","time_start","duration","split","time_start_2","from_date","to_date","address","phone","appt_dept","doctor","appt_date","appt_time","urgency","reason"];
  entries.sort((a,b)=>{
    const ai = priority.indexOf(a[0]); const bi = priority.indexOf(b[0]);
    if(ai===-1 && bi===-1) return 0;
    if(ai===-1) return 1;
    if(bi===-1) return -1;
    return ai-bi;
  });
  for(const [k,v] of entries){
    if(v===null || v===undefined || v==="" || skip.has(k)) continue;
    let val = v;
    if(typeof v === "boolean") val = v ? "✓ Да" : "✗ Нет";
    e.addFields({ name: labels[k] || k, value: String(val).slice(0, 1024), inline: false });
  }
  if(req.submitter_discord) e.addFields({ name:"Discord", value: String(req.submitter_discord).slice(0, 256), inline: true });
  e.setFooter({ text: "Заявка № "+req.code });
  return e;
}

async function getExtraLabels(database, req){
  if(req.kind !== "promotion") return {};
  const form = await getForm(database, "promotion");
  if(!form || !form.rank_matrix) return {};
  const labels = {};
  const rm = form.rank_matrix;

  function harvest(map){
    if(!map || typeof map !== "object") return;
    for(const rankName of Object.keys(map)){
      const arr = map[rankName];
      if(!Array.isArray(arr)) continue;
      for(const f of arr){
        if(f && f.key && f.label) labels[f.key] = f.label;
      }
    }
  }

  harvest(rm.fields);
  if(rm.dept_fields && typeof rm.dept_fields === "object"){
    for(const deptKey of Object.keys(rm.dept_fields)){
      harvest(rm.dept_fields[deptKey]);
    }
  }
  return labels;
}

function buildVerdictEmbed(req){
  const m = KIND_META[req.kind] || { label:req.kind, icon:"📋" };
  const approved = req.status === "approved";
  const color = approved ? 0x7dd97d : req.status === "rejected" ? 0xe97a7a : 0x999999;
  const icon = approved ? "✅" : req.status === "rejected" ? "❌" : "↩";
  const lbl = approved ? "ОДОБРЕНО" : req.status === "rejected" ? "ОТКАЗАНО" : "ОТОЗВАНО";
  const e = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${icon} ВЕРДИКТ · ${lbl}`)
    .setDescription(`**${m.label}**\n**Заявка:** \`${req.code}\`\n**Дата решения:** ${ruDT(req.verdict_at)}`)
    .addFields(
      { name:"Заявитель", value:(req.submitter_fio||"—")+(req.submitter_static?" · `"+req.submitter_static+"`":""), inline:true },
      { name:"Решение вынес", value: req.verdict_by_name || "—", inline:true }
    );
  if(req.verdict_comment) e.addFields({ name:"Комментарий", value: String(req.verdict_comment).slice(0,1024), inline:false });
  e.setFooter({ text: "ЦГБ №3 · " + req.code });
  e.setTimestamp(new Date(req.verdict_at || Date.now()));
  return e;
}

async function resolveDsId(database, staticStr, discordRaw){
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

function resolveDeptOverride(form, req){
  if(!form || req.kind !== "promotion") return {
    channelId: form && form.channel_id,
    verdictChannelId: (form && form.verdict_channel_id) || (form && form.channel_id),
    roleIds: [form && form.ping_role_id, form && form.ping_role_id_2].filter(Boolean)
  };
  const rm = form.rank_matrix || {};
  const depts = Array.isArray(rm.departments) ? rm.departments : [];
  const deptName = req.values && req.values.department;
  const dept = deptName ? depts.find(d => d.name === deptName || d.key === deptName) : null;
  if(dept){
    const channelId = dept.channel_id || form.channel_id;
    const verdictChannelId = dept.verdict_channel_id || form.verdict_channel_id || channelId;
    const roleIds = [dept.ping_role_id, dept.ping_role_id_2].filter(Boolean);
    if(!roleIds.length){
      if(form.ping_role_id) roleIds.push(form.ping_role_id);
      if(form.ping_role_id_2) roleIds.push(form.ping_role_id_2);
    }
    return { channelId, verdictChannelId, roleIds, deptName: dept.name };
  }
  return {
    channelId: form.channel_id,
    verdictChannelId: form.verdict_channel_id || form.channel_id,
    roleIds: [form.ping_role_id, form.ping_role_id_2].filter(Boolean)
  };
}

async function postNew(database, guild, req){
  const form = await getForm(database, req.kind);
  if(!form) return null;
  const routing = resolveDeptOverride(form, req);
  if(!routing.channelId){ console.warn("[requests] postNew: нет channelId для", req.kind, req.code); return null }
  const ch = await guild.channels.fetch(routing.channelId).catch(()=>null);
  if(!ch || !ch.isTextBased()){ console.warn("[requests] postNew: канал", routing.channelId, "не найден"); return null }
  const extraLabels = await getExtraLabels(database, req);
  const embed = buildEmbed(req, extraLabels);
  const userIds = await resolveDsId(database, req.submitter_static, req.submitter_discord);
  const roleIds = routing.roleIds;
  const parts = [];
  const allow = {};
  if(roleIds.length){ parts.push(...roleIds.map(r=>"<@&"+r+">")); allow.roles = roleIds; }
  if(userIds.length){ parts.push(...userIds.map(u=>"<@"+u+">")); allow.users = userIds; }
  try{
    const m = await ch.send({ content: parts.join(" ") || undefined, embeds:[embed], allowedMentions: Object.keys(allow).length?allow:undefined });
    await database.from("requests").update({ ds_channel_id: ch.id, ds_message_id: m.id }).eq("id", req.id);
    try{ await m.react(reactions.EMOJI.pending); }catch(e){ console.warn("[requests] react pending:", e.message); }
    return m;
  }catch(e){ console.warn("[requests] postNew:", e.message); return null }
}

function statusToReaction(status){
  if(status === "approved") return "approved";
  if(status === "rejected") return "rejected";
  if(status === "withdrawn" || status === "canceled" || status === "cancelled") return "withdrawn";
  return null;
}

async function postVerdict(database, guild, req){
  const form = await getForm(database, req.kind);
  if(!form) return null;
  const routing = resolveDeptOverride(form, req);
  const channelId = routing.verdictChannelId || req.ds_channel_id || routing.channelId;
  if(!channelId) return null;
  const ch = await guild.channels.fetch(channelId).catch(()=>null);
  if(!ch || !ch.isTextBased()) return null;
  const embed = buildVerdictEmbed(req);
  const userIds = await resolveDsId(database, req.submitter_static, req.submitter_discord);
  const roleIds = routing.roleIds;
  const parts = [];
  const allow = {};
  if(userIds.length){ parts.push(...userIds.map(u=>"<@"+u+">")); allow.users = userIds; }
  if(roleIds.length){ parts.push(...roleIds.map(r=>"<@&"+r+">")); allow.roles = roleIds; }
  try{
    const m = await ch.send({ content: parts.join(" ") || undefined, embeds:[embed], allowedMentions: Object.keys(allow).length?allow:undefined });
    await database.from("requests").update({ ds_message_id_2: m.id }).eq("id", req.id);
    return m;
  }catch(e){ console.warn("[requests] postVerdict:", e.message); return null }
}

async function pollPending(database, client){
  try{
    const guild = client.guilds.cache.first();
    if(!guild) return;

    const { data: newOnes } = await database.from("requests")
      .select("*").is("ds_message_id", null).limit(20);
    if(newOnes){
      for(const r of newOnes){
        console.log("[requests] new:", r.kind, r.code);
        await postNew(database, guild, r);
      }
    }

    const { data: settings } = await database.from("requests_settings").select("notify_verdict").eq("id",1).maybeSingle();
    const notifyVerdict = !settings || settings.notify_verdict !== false;

    const { data: decided } = await database.from("requests")
      .select("*").in("status", ["approved","rejected"]).is("ds_message_id_2", null).limit(20);
    if(decided){
      for(const r of decided){
        if(!r.ds_message_id){
          continue;
        }
        if(!notifyVerdict){
          console.log("[requests] verdict SKIP (notify_verdict=false):", r.kind, r.code);
          await database.from("requests").update({ ds_message_id_2: "SKIP:notify_off" }).eq("id", r.id);
        }else{
          console.log("[requests] verdict:", r.kind, r.code, "->", r.status);
          await postVerdict(database, guild, r);
        }
        const target = statusToReaction(r.status) || "pending";
        await reactions.setStatus(client, r.ds_channel_id, r.ds_message_id, target);
      }
    }

    const { data: withdrawnRows } = await database.from("requests")
      .select("id,ds_channel_id,ds_message_id,status,verdict_at")
      .in("status", ["withdrawn","canceled","cancelled"])
      .not("ds_message_id","is",null)
      .order("verdict_at", { ascending: false, nullsFirst: false })
      .limit(20);
    if(withdrawnRows){
      for(const r of withdrawnRows){
        await reactions.setWithdrawn(client, r.ds_channel_id, r.ds_message_id);
      }
    }
  }catch(e){ console.warn("[requests] pollPending:", e.message) }
}

async function backfillReactions(database, client){
  try{
    const { data: rows } = await database.from("requests")
      .select("id,status,ds_channel_id,ds_message_id")
      .not("ds_message_id","is",null)
      .order("id", { ascending: false })
      .limit(100);
    if(!rows || !rows.length){ return; }
    console.log("[requests] backfillReactions:", rows.length);
    for(const r of rows){
      const target = statusToReaction(r.status) || "pending";
      await reactions.setStatus(client, r.ds_channel_id, r.ds_message_id, target);
    }
  }catch(e){ console.warn("[requests] backfillReactions:", e.message) }
}

function subscribe(database, client){
  console.log("[requests] polling every 12s");
  setInterval(async ()=>{ await pollPending(database, client) }, 12*1000);
  setTimeout(async ()=>{ await pollPending(database, client) }, 20*1000);
  setTimeout(async ()=>{ await backfillReactions(database, client) }, 30*1000);
}

module.exports = { subscribe, postNew, postVerdict, backfillReactions };
