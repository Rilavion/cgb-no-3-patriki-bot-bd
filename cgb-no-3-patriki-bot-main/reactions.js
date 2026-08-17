const EMOJI = {
  pending: "🕒",
  approved: "✅",
  rejected: "❌",
  withdrawn: "↩️"
};

const ALL_EMOJI = [EMOJI.pending, EMOJI.approved, EMOJI.rejected, EMOJI.withdrawn];

async function fetchMessage(client, channelId, messageId){
  if(!channelId || !messageId) return null;
  try{
    const ch = await client.channels.fetch(String(channelId)).catch(()=>null);
    if(!ch || !ch.isTextBased()) return null;
    const msg = await ch.messages.fetch(String(messageId)).catch(()=>null);
    return msg || null;
  }catch(e){
    return null;
  }
}

async function removeBotReactions(msg, emojis){
  if(!msg || !msg.reactions) return;
  const me = msg.client && msg.client.user ? msg.client.user.id : null;
  if(!me) return;
  for(const em of emojis){
    try{
      const r = msg.reactions.cache.find(x => x.emoji && x.emoji.name === em);
      if(r) await r.users.remove(me).catch(()=>{});
    }catch(e){}
  }
}

async function addReaction(msg, emoji){
  if(!msg) return false;
  try{
    await msg.react(emoji);
    return true;
  }catch(e){
    return false;
  }
}

async function setStatus(client, channelId, messageId, status){
  const msg = await fetchMessage(client, channelId, messageId);
  if(!msg) return false;
  const target = EMOJI[status];
  if(!target) return false;
  const toRemove = ALL_EMOJI.filter(e => e !== target);
  await removeBotReactions(msg, toRemove);
  const has = msg.reactions && msg.reactions.cache.find(x => x.emoji && x.emoji.name === target && x.me);
  if(!has) await addReaction(msg, target);
  return true;
}

async function setPending(client, channelId, messageId){
  return setStatus(client, channelId, messageId, "pending");
}
async function setApproved(client, channelId, messageId){
  return setStatus(client, channelId, messageId, "approved");
}
async function setRejected(client, channelId, messageId){
  return setStatus(client, channelId, messageId, "rejected");
}
async function setWithdrawn(client, channelId, messageId){
  return setStatus(client, channelId, messageId, "withdrawn");
}

async function clearAll(client, channelId, messageId){
  const msg = await fetchMessage(client, channelId, messageId);
  if(!msg) return false;
  await removeBotReactions(msg, ALL_EMOJI);
  return true;
}

module.exports = {
  EMOJI,
  setStatus,
  setPending,
  setApproved,
  setRejected,
  setWithdrawn,
  clearAll,
  fetchMessage
};
