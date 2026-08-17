/* Поставки: сайт (supply.html) создаёт supply_requests через RPC
 * (status=pending), бот публикует запрос в канал снабжения и ставит
 * 5 статусных реакций. Реакции снабженцев отслеживаются: один статус
 * на человека, снятые реакции бота восстанавливаются, статус пишется
 * обратно в таблицу (emoji_status). Поддерживается пересчёт по
 * supply_rescan_requests (кнопка на странице статистики). */
const { EmbedBuilder } = require("discord.js");
const BOT_TZ = process.env.TIMEZONE || "Europe/Moscow"; // все метки времени бота — по МСК, независимо от часового пояса сервера/ПК

const DEFAULT_EMOJI = { ok:"✅", fail:"❌", offline:"📵", undelivered:"🚫", replaced:"🔄" };
const KIND_ICONS = {
  "Медикаменты":"⚕", "Расходники":"🩹", "Оборудование":"🩺",
  "Продовольствие":"🍞", "ГСМ":"⛽", "Прочее":"📦"
};

function escMd(s){ return String(s==null?"":s).replace(/([*_`~|>#\\])/g,"\\$1") }

function ruDT(d){try{return new Date(d).toLocaleString("ru-RU",{timeZone:BOT_TZ,day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"})}catch(e){return String(d||"")}}

async function loadForm(database){
  const { data } = await database.from("supply_form").select("*").eq("id",1).maybeSingle();
  return data;
}

function extractDiscordHandle(raw){
  const s = String(raw||"").trim();
  if(!s) return null;
  const m1 = s.match(/<@!?(\d{15,25})>/);
  if(m1) return { type:"id", value:m1[1] };
  const m2 = s.match(/^(\d{15,25})$/);
  if(m2) return { type:"id", value:m2[1] };
  const m3 = s.match(/@?([a-z0-9_.]{2,32})/i);
  if(m3) return { type:"username", value:m3[1].toLowerCase() };
  return null;
}

async function resolveMention(guild, discordRaw){
  const h = extractDiscordHandle(discordRaw);
  if(!h || !guild) return null;
  try{
    if(h.type === "id"){
      const m = await guild.members.fetch(h.value).catch(()=>null);
      return m ? { mention:`<@${m.id}>`, id:m.id } : null;
    }
    const found = await guild.members.fetch({ query:h.value, limit:5 }).catch(()=>null);
    if(!found || !found.size) return null;
    let hit = found.find(m => (m.user.username||"").toLowerCase() === h.value);
    if(!hit) hit = found.find(m => (m.user.globalName||"").toLowerCase() === h.value);
    if(!hit) hit = found.first();
    return hit ? { mention:`<@${hit.id}>`, id:hit.id } : null;
  }catch(e){ return null }
}

function buildEmbed(req, form){
  const vals = req.values || {};
  const fields = form.fields || [];
  const kindVal = vals.kind || "";
  const kindIcon = KIND_ICONS[kindVal] || "📦";

  const embed = new EmbedBuilder()
    .setColor(0x3a7d6b)
    .setAuthor({ name:"СНАБЖЕНИЕ · ЦГБ №3" })
    .setTitle(`${kindIcon}  Новый запрос на поставку`)
    .setDescription(vals.org ? `Организация **${escMd(vals.org)}** запросила снабжение` : "Поступил новый запрос на снабжение")
    .setFooter({ text: `От ${req.fio||"—"} · ${ruDT(req.created_at||new Date())}` })
    .setTimestamp(new Date(req.created_at || Date.now()));

  const embedFields = [];
  embedFields.push({ name:"👤  Заявитель", value:`${req.fio||"—"} \`${req.static_id||"—"}\``, inline:false });

  for(const f of fields){
    const v = vals[f.key];
    if(v == null || v === "") continue;
    if(f.key === "org") continue;
    let icon = "•", val = String(v);
    if(f.type === "checkbox") val = v ? "✅ Да" : "❌ Нет";
    if(f.key === "kind"){ icon = "📦"; }
    else if(f.key === "escort"){ icon = "🛡"; val = v==="Будет" ? "✅ Будет" : v==="Не будет" ? "❌ Не будет" : String(v) }
    else if(f.key === "team"){ icon = "👥" }
    else if(f.key === "time"){ icon = "🕐" }
    else if(f.key === "comment"){ icon = "💬" }
    embedFields.push({ name:`${icon}  ${f.label}`, value:String(val).slice(0,1000), inline:false });
  }

  embed.addFields(embedFields);
  return embed;
}

async function sendRequest(database, client, requestId, log){
  try{
    await database.from("supply_requests").update({ status:"sending" }).eq("id",requestId);
    const { data:req, error:e1 } = await database.from("supply_requests").select("*").eq("id",requestId).maybeSingle();
    if(e1 || !req) throw new Error("request not found");
    const form = await loadForm(database);
    if(!form) throw new Error("form not configured");
    if(!form.channel_id) throw new Error("channel not set");

    const ch = await client.channels.fetch(form.channel_id);
    if(!ch || !ch.isTextBased()) throw new Error("channel not text");

    const guild = ch.guild;
    let mention = null, mentionId = null;
    if(form.ping_role_id){
      try{
        const role = await guild.roles.fetch(form.ping_role_id);
        if(role) mention = `<@&${role.id}>`;
      }catch(e){}
    }
    if(!mention && req.discord){
      const r = await resolveMention(guild, req.discord);
      if(r){ mention = r.mention; mentionId = r.id }
    }

    const embed = buildEmbed(req, form);
    const payload = { embeds:[embed] };
    if(mention){
      payload.content = mention + " поступил новый запрос!";
      payload.allowedMentions = form.ping_role_id ? { roles:[form.ping_role_id] } : (mentionId ? { users:[mentionId] } : { parse:[] });
    }
    const sent = await ch.send(payload);

    const emojis = form.status_emoji || DEFAULT_EMOJI;
    for(const key of ["ok","fail","offline","undelivered","replaced"]){
      const em = emojis[key];
      if(!em) continue;
      try{ await sent.react(em) }catch(e){ log("supply react err ("+em+"):", e.message) }
    }

    await database.from("supply_requests").update({
      status:"sent", channel_id:ch.id, message_id:sent.id, sent_at:new Date().toISOString()
    }).eq("id",requestId);

    log("SUPPLY sent id="+requestId+" → "+sent.id);
    return { ok:true, message_id:sent.id };
  }catch(e){
    log("SUPPLY send err:", e.message);
    await database.from("supply_requests").update({ status:"error", error_message:e.message }).eq("id",requestId).catch(()=>{});
    return { ok:false, error:e.message };
  }
}

function detectStatus(emojiName, emojiMap){
  const map = emojiMap || DEFAULT_EMOJI;
  for(const [key, ch] of Object.entries(map)){
    if(!ch) continue;
    if(ch === emojiName) return key;
    if(String(ch).includes(emojiName)) return key;
  }
  return null;
}

async function rescanMessage(database, client, req, form){
  try{
    if(!req.message_id || !req.channel_id) return null;
    const ch = await client.channels.fetch(req.channel_id).catch(()=>null);
    if(!ch) return null;
    const msg = await ch.messages.fetch(req.message_id).catch(()=>null);
    if(!msg){
      await database.from("supply_requests").update({ emoji_status:"deleted", emoji_status_note:"message not found" }).eq("id",req.id);
      return "deleted";
    }
    const map = (form && form.status_emoji) || DEFAULT_EMOJI;
    let found = null, foundNote = null, otherReactions = [];
    for(const r of msg.reactions.cache.values()){
      let hasHuman = false;
      try{
        const users = await r.users.fetch();
        for(const u of users.values()){
          if(!u.bot){ hasHuman = true; break }
        }
      }catch(e){}
      if(!hasHuman) continue;
      const emName = r.emoji.name;
      const status = detectStatus(emName, map);
      if(status){
        if(!found || status === "replaced") found = status;
        if(status === "replaced") foundNote = "замена";
      } else {
        otherReactions.push(emName);
      }
    }
    let finalStatus = found;
    let note = foundNote;
    if(!finalStatus && otherReactions.length){
      finalStatus = "dispute";
      note = "спорная (эмодзи: " + otherReactions.slice(0,5).join(",") + ")";
    }
    if(!finalStatus){
      finalStatus = "none";
    }
    await database.from("supply_requests").update({ emoji_status:finalStatus, emoji_status_note:note }).eq("id",req.id);
    return finalStatus;
  }catch(e){
    return null;
  }
}

async function rescanAll(database, client, log, fromDate, toDate){
  try{
    const form = await loadForm(database);
    let q = database.from("supply_requests").select("*").not("message_id","is",null);
    if(fromDate) q = q.gte("created_at", fromDate);
    if(toDate) q = q.lte("created_at", toDate);
    const { data } = await q;
    if(!data) return 0;
    let n = 0;
    for(const req of data){
      await rescanMessage(database, client, req, form);
      n++;
    }
    log("SUPPLY rescan done: "+n);
    return n;
  }catch(e){ log("SUPPLY rescan err:", e.message); return 0 }
}

function setupSupply({ client, database, guildId, log }){
  function subscribe(){
    database.channel("supply-queue")
      .on("postgres_changes",
        { event:"INSERT", schema:"public", table:"supply_requests" },
        async (payload) => {
          const req = payload.new;
          if(!req || req.status !== "pending") return;
          log("SUPPLY request id="+req.id);
          await sendRequest(database, client, req.id, log);
        })
      .subscribe((s)=> log("SUPPLY realtime:", s));

    database.channel("supply-rescan-req")
      .on("postgres_changes",
        { event:"INSERT", schema:"public", table:"supply_rescan_requests" },
        async (payload) => {
          const req = payload.new;
          if(!req || req.status !== "pending") return;
          log("SUPPLY rescan request id="+req.id+" from="+req.from_date+" to="+req.to_date);
          await database.from("supply_rescan_requests").update({ status:"running" }).eq("id",req.id);
          try{
            const n = await rescanAll(database, client, log, req.from_date, req.to_date);
            await database.from("supply_rescan_requests").update({ status:"done", scanned:n, finished_at:new Date().toISOString() }).eq("id",req.id);
          }catch(e){
            await database.from("supply_rescan_requests").update({ status:"error", message:e.message, finished_at:new Date().toISOString() }).eq("id",req.id);
          }
        })
      .subscribe();

  }

  async function handleReactionEvent(reaction, user){
    try{
      if(user && user.bot) return;
      const msg = reaction.message;
      if(!msg || !msg.id) return;
      const { data:req } = await database.from("supply_requests").select("*").eq("message_id",msg.id).maybeSingle();
      if(!req) return;
      const form = await loadForm(database);
      await rescanMessage(database, client, req, form);
    }catch(e){ log("SUPPLY reaction err:", e.message) }
  }

  async function userHasAnyStatusReaction(msg, user, statusEmojis){
    for(const em of statusEmojis){
      try{
        const r = msg.reactions.resolve(em) || msg.reactions.cache.find(x=>x.emoji.name===em);
        if(!r) continue;
        const users = await r.users.fetch();
        if(users.has(user.id)) return em;
      }catch(e){}
    }
    return null;
  }

  async function enforceSingleReaction(reaction, user){
    try{
      if(!reaction || !user || user.bot) return false;
      let msg = reaction.message;
      if(!msg || !msg.id) return false;
      if(msg.partial){ try{ msg = await msg.fetch() }catch(e){ log("SUPPLY enforce msg.fetch err:", e.message); return false } }
      const { data:req } = await database.from("supply_requests").select("id").eq("message_id",msg.id).maybeSingle();
      if(!req) return false;
      const form = await loadForm(database);
      const emojis = (form && form.status_emoji) || DEFAULT_EMOJI;
      const statusKeys = ["ok","fail","offline","undelivered","replaced"];
      const statusEmojis = statusKeys.map(k=>emojis[k]).filter(Boolean);
      const currentEmoji = reaction.emoji.name;
      if(!statusEmojis.includes(currentEmoji)) return false;

      let removedAny = false;
      for(const em of statusEmojis){
        if(em === currentEmoji) continue;
        try{
          const r = msg.reactions.resolve(em) || msg.reactions.cache.find(x=>x.emoji.name===em);
          if(!r) continue;
          const users = await r.users.fetch();
          if(users.has(client.user.id)){
            await r.users.remove(client.user.id);
            log("SUPPLY enforce: снял СВОЮ реакцию", em, "на", msg.id);
            removedAny = true;
          }
        }catch(e){ log("SUPPLY enforce remove err:", em, e.message) }
      }
      return removedAny;
    }catch(e){ log("SUPPLY enforceSingle err:", e.message); return false }
  }

  async function restoreBotReactions(reaction, user){
    try{
      if(!reaction || !user || user.bot) return false;
      const rawMsg = reaction.message;
      if(!rawMsg || !rawMsg.id) return false;
      const chId = rawMsg.channelId || (rawMsg.channel && rawMsg.channel.id);
      const msgId = rawMsg.id;
      if(!chId) return false;
      const removedEmoji = reaction.emoji.name;

      const { data:req } = await database.from("supply_requests").select("id").eq("message_id",msgId).maybeSingle();
      if(!req) return false;
      const form = await loadForm(database);
      const emojis = (form && form.status_emoji) || DEFAULT_EMOJI;
      const statusKeys = ["ok","fail","offline","undelivered","replaced"];
      const statusEmojis = statusKeys.map(k=>emojis[k]).filter(Boolean);
      if(!statusEmojis.includes(removedEmoji)) return false;

      let ch;
      try{ ch = await client.channels.fetch(chId) }catch(e){ log("SUPPLY restore ch.fetch err:", e.message); return false }
      if(!ch || !ch.isTextBased()) return false;
      let msg;
      try{ msg = await ch.messages.fetch(msgId) }catch(e){ log("SUPPLY restore msg.fetch err:", e.message); return false }
      if(!msg){ log("SUPPLY restore: msg not found"); return false }

      const stillActive = await userHasAnyStatusReaction(msg, user, statusEmojis);
      if(stillActive){
        log("SUPPLY restore: юзер ещё держит", stillActive, "— не восстанавливаю");
        return false;
      }
      for(const em of statusEmojis){
        try{
          const r = msg.reactions.resolve(em) || msg.reactions.cache.find(x=>x.emoji.name===em);
          const hasBot = r ? (await r.users.fetch()).has(client.user.id) : false;
          if(hasBot) continue;
          await msg.react(em);
          log("SUPPLY restore: вернул СВОЮ реакцию", em, "на", msg.id);
        }catch(e){ log("SUPPLY restore add err:", em, e.message) }
      }
      return true;
    }catch(e){ log("SUPPLY restore err:", e.message); return false }
  }

  client.on("messageReactionAdd", async (reaction, user)=>{
    try{
      if(reaction.partial) await reaction.fetch();
      if(user.partial) await user.fetch();
      if(user.bot) return;
      log("SUPPLY reactionAdd:", reaction.emoji.name, "by", user.id, "on", reaction.message.id);
      await enforceSingleReaction(reaction, user);
      await handleReactionEvent(reaction, user);
    }catch(e){ log("SUPPLY reactionAdd err:", e.message) }
  });
  client.on("messageReactionRemove", async (reaction, user)=>{
    try{
      if(reaction.partial) await reaction.fetch();
      if(user.partial) await user.fetch();
      if(user.bot) return;
      log("SUPPLY reactionRemove:", reaction.emoji.name, "by", user.id, "on", reaction.message.id);
      await restoreBotReactions(reaction, user);
      await handleReactionEvent(reaction, user);
    }catch(e){ log("SUPPLY reactionRemove err:", e.message) }
  });

  return { subscribe, rescanAll };
}

module.exports = { setupSupply, DEFAULT_EMOJI };
