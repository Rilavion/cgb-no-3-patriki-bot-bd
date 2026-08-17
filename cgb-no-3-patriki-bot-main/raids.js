const { Events } = require("discord.js");

async function loadSettings(database){
  try{
    const { data } = await database.from("raids_settings").select("*").eq("id",1).maybeSingle();
    return data || {};
  }catch(e){ console.warn("[raids] loadSettings:", e.message); return {} }
}

function detectKind(message, settings){
  if(!settings) return null;
  const chId = message.channelId || (message.channel && message.channel.id);
  const successRole = settings.success_role_id;
  const failRole = settings.fail_role_id;
  const chSuccess = settings.channel_success_id;
  const chFail = settings.channel_fail_id;

  const mentions = message.mentions && message.mentions.roles ? message.mentions.roles : null;
  const hasSuccessRole = successRole && mentions && mentions.has(successRole);
  const hasFailRole = failRole && mentions && mentions.has(failRole);

  const contentSuccess = successRole && message.content && message.content.includes("<@&"+successRole+">");
  const contentFail = failRole && message.content && message.content.includes("<@&"+failRole+">");

  const isSuccessRole = hasSuccessRole || contentSuccess;
  const isFailRole = hasFailRole || contentFail;

  if(chId === chSuccess && chId === chFail){
    if(isSuccessRole && !isFailRole) return "success";
    if(isFailRole && !isSuccessRole) return "fail";
    return null;
  }
  if(chId === chSuccess && isSuccessRole) return "success";
  if(chId === chFail && isFailRole) return "fail";
  return null;
}

async function saveEvent(database, message, kind){
  try{
    const row = {
      kind,
      channel_id: message.channelId || (message.channel && message.channel.id) || null,
      channel_name: (message.channel && message.channel.name) || null,
      ds_message_id: message.id,
      ds_author_id: message.author ? message.author.id : null,
      ds_author_name: message.author ? (message.author.globalName || message.author.username) : null,
      content_preview: (message.content || "").slice(0, 200)
    };
    const { error } = await database.from("raids_events").insert(row);
    if(error){
      if(error.code === "23505") return;
      console.warn("[raids] insert:", error.message);
    } else {
      console.log("[raids] +1", kind, "in #"+(row.channel_name||"?"), "by", row.ds_author_name);
    }
  }catch(e){ console.warn("[raids] saveEvent:", e.message) }
}

function subscribe(database, client){
  console.log("[raids] listening messageCreate for role pings");
  client.on(Events.MessageCreate, async (message) => {
    try{
      if(!message || message.author && message.author.bot) return;
      if(!message.guild) return;
      const settings = await loadSettings(database);
      if(!settings || (!settings.channel_success_id && !settings.channel_fail_id)) return;
      const kind = detectKind(message, settings);
      if(!kind) return;
      await saveEvent(database, message, kind);
    }catch(e){ console.warn("[raids] onMessage:", e.message) }
  });
}

module.exports = { subscribe };
