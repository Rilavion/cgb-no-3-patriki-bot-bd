/* Отправка произвольных сообщений ботом: сайт пишет строку в bot_messages
 * (status=pending), бот слушает realtime и публикует в нужный канал Discord.
 * Плюс синхронизация списка каналов сервера → ds_channels (их показывают
 * селекторы каналов в настройках сайта). */
const { EmbedBuilder, ChannelType } = require("discord.js");

async function syncChannels(database, guild, log){
  try{
    const chs = await guild.channels.fetch();
    const rows = [];
    for(const c of chs.values()){
      if(!c) continue;
      if(c.type !== ChannelType.GuildText && c.type !== ChannelType.GuildAnnouncement) continue;
      const parent = c.parent || null;
      rows.push({
        channel_id: c.id,
        name: c.name,
        type: String(c.type),
        parent_id: parent ? parent.id : null,
        parent_name: parent ? parent.name : null,
        position: c.rawPosition || c.position || 0,
        updated_at: new Date().toISOString()
      });
    }
    if(!rows.length) return 0;
    const { error } = await database.from("ds_channels").upsert(rows, { onConflict: "channel_id" });
    if(error) log("CHANNELS sync err:", error.message);
    return rows.length;
  }catch(e){
    log("CHANNELS sync fail:", e.message);
    return 0;
  }
}

function buildPayload(row){
  const payload = {};
  let content = row.content || "";

  const ping = row.ping_type;
  const val = row.ping_value;
  let allowed = { parse: [] };
  if(ping === "everyone"){
    content = "@everyone " + content;
    allowed = { parse: ["everyone"] };
  } else if(ping === "here"){
    content = "@here " + content;
    allowed = { parse: ["everyone"] };
  } else if(ping === "user" && val){
    content = "<@" + val + "> " + content;
    allowed = { users: [val] };
  } else if(ping === "role" && val){
    content = "<@&" + val + "> " + content;
    allowed = { roles: [val] };
  } else if(ping === "custom" && val){
    content = val + " " + content;
    allowed = { parse: ["users", "roles"] };
  }

  if(content.trim()) payload.content = content.trim();
  payload.allowedMentions = allowed;

  if(row.embed_title || row.embed_description || row.embed_image_url){
    const embed = new EmbedBuilder();
    if(row.embed_title) embed.setTitle(String(row.embed_title).slice(0, 256));
    if(row.embed_description) embed.setDescription(String(row.embed_description).slice(0, 4000));
    if(row.embed_color != null) embed.setColor(row.embed_color);
    if(row.embed_image_url) embed.setImage(row.embed_image_url);
    if(row.embed_footer) embed.setFooter({ text: String(row.embed_footer).slice(0, 2048) });
    payload.embeds = [embed];
  }

  const atts = Array.isArray(row.attachments) ? row.attachments : [];
  if(atts.length){
    payload.files = atts.map(a => (typeof a === "string" ? a : (a && a.url) || null)).filter(Boolean);
  }

  return payload;
}

async function sendBotMessage(database, client, row, log){
  try{
    await database.from("bot_messages").update({ status: "sending" }).eq("id", row.id);
    const ch = await client.channels.fetch(row.channel_id);
    if(!ch || !ch.isTextBased()){
      throw new Error("channel not found or not text");
    }
    const payload = buildPayload(row);
    if(!payload.content && !payload.embeds && !payload.files){
      throw new Error("empty message");
    }
    const sent = await ch.send(payload);
    await database.from("bot_messages").update({
      status: "sent",
      sent_message_id: sent.id,
      sent_channel_id: ch.id,
      sent_at: new Date().toISOString()
    }).eq("id", row.id);
    log("MSG sent id=" + row.id + " → " + sent.id);
  }catch(e){
    log("MSG send err id=" + row.id + ":", e.message);
    await database.from("bot_messages").update({
      status: "error",
      error_message: e.message,
      sent_at: new Date().toISOString()
    }).eq("id", row.id);
  }
}

function setupMSG({ client, database, guildId, log }){
  async function initChannels(){
    try{
      const g = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId);
      if(!g) return;
      const n = await syncChannels(database, g, log);
      log("MSG: channels synced,", n);
    }catch(e){ log("MSG initChannels err:", e.message); }
  }

  function subscribe(){
    const channel = database.channel("bot-msg-queue")
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "bot_messages" },
        async (payload) => {
          const row = payload.new;
          if(!row || row.status !== "pending") return;
          log("MSG queued id=" + row.id + " → channel " + row.channel_id);
          await sendBotMessage(database, client, row, log);
        })
      .subscribe((status) => {
        log("MSG realtime:", status);
      });
    return channel;
  }

  client.on("channelCreate", async (c) => {
    if(!c.guild || c.guild.id !== guildId) return;
    if(c.type !== ChannelType.GuildText && c.type !== ChannelType.GuildAnnouncement) return;
    await database.from("ds_channels").upsert({
      channel_id: c.id, name: c.name, type: String(c.type),
      parent_id: c.parent ? c.parent.id : null, parent_name: c.parent ? c.parent.name : null,
      position: c.rawPosition || 0, updated_at: new Date().toISOString()
    }, { onConflict: "channel_id" });
  });
  client.on("channelUpdate", async (oldC, newC) => {
    if(!newC.guild || newC.guild.id !== guildId) return;
    if(newC.type !== ChannelType.GuildText && newC.type !== ChannelType.GuildAnnouncement) return;
    await database.from("ds_channels").upsert({
      channel_id: newC.id, name: newC.name, type: String(newC.type),
      parent_id: newC.parent ? newC.parent.id : null, parent_name: newC.parent ? newC.parent.name : null,
      position: newC.rawPosition || 0, updated_at: new Date().toISOString()
    }, { onConflict: "channel_id" });
  });
  client.on("channelDelete", async (c) => {
    if(!c.guild || c.guild.id !== guildId) return;
    await database.from("ds_channels").delete().eq("channel_id", c.id);
  });

  return { subscribe, initChannels };
}

module.exports = { setupMSG };
