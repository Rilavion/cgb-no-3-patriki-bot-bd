/* Еженедельные отчёты: сайт (report.html) создаёт report_send_requests
 * (status=pending), бот публикует отчёт в канал формы (report_forms.channel_id)
 * с пингом ролей и автора. */
const { EmbedBuilder } = require("discord.js");
const BOT_TZ = process.env.TIMEZONE || "Europe/Moscow"; // все метки времени бота — по МСК, независимо от часового пояса сервера/ПК

function ruDT(d){try{return new Date(d).toLocaleString("ru-RU",{timeZone:BOT_TZ,day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"})}catch(e){return String(d||"")}}

async function resolveDsUserIds(database, staticStr){
  if(!staticStr) return [];
  const norm = String(staticStr).replace(/\D/g,"");
  if(!norm) return [];
  try{
    const { data } = await database.from("ds_members").select("discord_id,parsed_static").limit(2000);
    if(!data) return [];
    const out = [];
    for(const m of data){
      if(String(m.parsed_static||"").replace(/\D/g,"") === norm && m.discord_id) out.push(String(m.discord_id));
    }
    return out;
  }catch(e){ return []; }
}

function buildEmbed(form, req){
  const icon = form.icon || "📋";
  const color = form.color || 0x3a7d6b;
  const title = `${icon} ЕЖЕНЕДЕЛЬНЫЙ ОТЧЁТ · ${(form.label||form.id).toUpperCase()}`;
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(`**${req.submitter_fio||"—"}**${req.submitter_static?" · `"+req.submitter_static+"`":""}${req.submitter_position?"\n_"+req.submitter_position+"_":""}`)
    .setTimestamp(new Date(req.requested_at||Date.now()))
    .setFooter({ text: "ЦГБ №3 · Минздрав · Отчёт от " + ruDT(req.requested_at) });

  const values = req.values || {};
  const fields = Array.isArray(form.fields) ? form.fields : [];
  const labelOf = {};
  for(const f of fields){ if(f && f.key) labelOf[f.key] = { label: f.label || f.key, type: f.type || "text" }; }

  const ordered = [];
  for(const f of fields){
    if(!f || !f.key) continue;
    if(values[f.key] === undefined || values[f.key] === null || values[f.key] === "") continue;
    ordered.push([f.key, values[f.key]]);
  }
  for(const [k,v] of Object.entries(values)){
    if(labelOf[k]) continue;
    if(v === null || v === undefined || v === "") continue;
    ordered.push([k, v]);
  }

  for(const [k,v] of ordered){
    const meta = labelOf[k] || { label: k, type: "text" };
    let val = v;
    if(typeof v === "boolean") val = v ? "✓ Да" : "✗ Нет";
    else val = String(v);
    if(meta.type === "url" && val) val = "[Открыть →]("+val+")";
    if(val.length > 1024) val = val.slice(0, 1020) + "…";
    embed.addFields({ name: meta.label, value: val, inline: (meta.type==="text"||meta.type==="number"||meta.type==="date") && val.length<40 });
  }
  return embed;
}

async function processOne(database, client, req){
  try{
    await database.from("report_send_requests").update({ status: "running" }).eq("id", req.id);

    const { data: form } = await database.from("report_forms").select("*").eq("id", req.form_id).maybeSingle();
    if(!form){
      await database.from("report_send_requests").update({ status:"error", message:"form not found: "+req.form_id, finished_at:new Date().toISOString() }).eq("id", req.id);
      return;
    }
    if(!form.channel_id){
      await database.from("report_send_requests").update({ status:"error", message:"channel not configured for form "+req.form_id, finished_at:new Date().toISOString() }).eq("id", req.id);
      return;
    }

    const guild = client.guilds.cache.first();
    if(!guild){
      await database.from("report_send_requests").update({ status:"error", message:"no guild", finished_at:new Date().toISOString() }).eq("id", req.id);
      return;
    }

    const ch = await guild.channels.fetch(form.channel_id).catch(()=>null);
    if(!ch || !ch.isTextBased()){
      await database.from("report_send_requests").update({ status:"error", message:"channel "+form.channel_id+" not accessible", finished_at:new Date().toISOString() }).eq("id", req.id);
      return;
    }

    const embed = buildEmbed(form, req);
    const userIds = await resolveDsUserIds(database, req.submitter_static);
    const roleIds = [form.ping_role_id, form.ping_role_id_2].filter(Boolean);
    const parts = [];
    const allow = {};
    if(roleIds.length){ parts.push(...roleIds.map(r=>"<@&"+r+">")); allow.roles = roleIds; }
    if(userIds.length){ parts.push(...userIds.map(u=>"<@"+u+">")); allow.users = userIds; }

    const payload = { embeds: [embed], allowedMentions: Object.keys(allow).length ? allow : { parse: [] } };
    if(parts.length) payload.content = parts.join(" ");

    const sent = await ch.send(payload);
    await database.from("report_send_requests").update({
      status: "done",
      message: "sent, msg="+sent.id,
      ds_channel_id: ch.id,
      ds_message_id: sent.id,
      finished_at: new Date().toISOString()
    }).eq("id", req.id);
    console.log("[report] sent:", req.form_id, "→", sent.id, "for", req.submitter_fio);
  }catch(e){
    await database.from("report_send_requests").update({ status:"error", message:(e.message||String(e)).slice(0,500), finished_at:new Date().toISOString() }).eq("id", req.id).catch(()=>{});
    console.warn("[report] processOne err:", e.message);
  }
}

async function pollSendRequests(database, client){
  try{
    const { data } = await database.from("report_send_requests")
      .select("*").eq("status","pending").order("requested_at",{ascending:true}).limit(5);
    if(!data || !data.length) return;
    for(const r of data){ await processOne(database, client, r); }
  }catch(e){ console.warn("[report] poll:", e.message); }
}

function subscribe(database, client){
  console.log("[report] send-request polling every 10s");
  setInterval(async ()=>{ await pollSendRequests(database, client); }, 10*1000);
  setTimeout(async ()=>{ await pollSendRequests(database, client); }, 15*1000);
}

module.exports = { subscribe, processOne, buildEmbed };
