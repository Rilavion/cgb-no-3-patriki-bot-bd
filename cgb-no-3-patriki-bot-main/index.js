/* Discord-бот ЦГБ №3 (RMRP).
 *
 * Что делает:
 *  • заявления из канала приёма → на сайт (applications) + реакции-статусы;
 *  • вердикты по заявлениям с сайта → в канал результатов с пингом;
 *  • синхронизация состава/ролей сервера → ds_members / ds_roles (формат ника
 *    «Должность | ФИО | Статик»), heartbeat → bot_status («бот онлайн» на сайте);
 *  • каналы сервера → ds_channels; очередь сообщений bot_messages → DS;
 *  • отчёт проверок АБ (vp_report_requests), запросы наказаний АБ
 *    (violations_registry pending → active/refused) — vp-request;
 *  • жалобы и реестр нарушений (complaints / violations_registry) + авто-снятия
 *    и авто-эскалация предупреждений;
 *  • заявки персонала requests (отгул/отпуск/увольнение/повышение/восстановление);
 *  • еженедельные отчёты (report_send_requests);
 *  • результаты тестов (test_result_requests);
 *  • поставки (supply_requests) + статусные реакции + пересчёт;
 *  • премирование (payroll_send_requests);
 *  • детектор рейдов по пингу ролей (raids_events).
 *
 * Запуск: npm install && npm start  (нужен .env — см. .env.example)
 */
require("dotenv").config();
const { Client, GatewayIntentBits, Partials, Events, EmbedBuilder } = require("discord.js");
const { createPostgresClient } = require("./postgres-client");
const { parseDiscordMessage } = require("./parser");
const { setupVP } = require("./vp");
const { setupMSG } = require("./msg");
const { setupReport } = require("./vp-report");
const { setupTestReport } = require("./test-report");
const { setupSupply } = require("./supply");
const complaintsMod = require("./complaints");
const payrollMod = require("./payroll");
const requestsMod = require("./requests");
const raidsMod = require("./raids");
const reportMod = require("./report");
const vpRequestMod = require("./vp-request");
const reactions = require("./reactions");

const REQUIRED = ["DISCORD_TOKEN","GUILD_ID","CHANNEL_INCOMING_ID","CHANNEL_RESULTS_ID","DATABASE_URL"];
const missing = REQUIRED.filter(k=>!process.env[k]);
if(missing.length){
  console.error("[ENV] Не заданы переменные:", missing.join(", "));
  console.error("Скопируй .env.example в .env и заполни значения.");
  process.exit(1);
}

const {
  DISCORD_TOKEN, GUILD_ID, CHANNEL_INCOMING_ID: ENV_INCOMING, CHANNEL_RESULTS_ID: ENV_RESULTS,
  DATABASE_URL, PGSSL,
  BACKFILL_ON_START, BACKFILL_LIMIT
} = process.env;

// Каналы заявлений/результатов и пинг-роли можно менять с сайта
// (apps.html → таблица apps_settings) — бот перечитывает каждые 30 секунд.
const APPS_CFG = {
  incoming_channel_id: ENV_INCOMING,
  verdict_channel_id: ENV_RESULTS,
  ping_role_id: null,
  ping_role_id_2: null,
  loaded_at: 0
};
function CHANNEL_INCOMING_ID(){ return APPS_CFG.incoming_channel_id || ENV_INCOMING; }
function CHANNEL_RESULTS_ID(){ return APPS_CFG.verdict_channel_id || ENV_RESULTS; }
async function reloadAppsCfg(database){
  try{
    const { data } = await database.from("apps_settings").select("*").eq("id",1).maybeSingle();
    if(data){
      APPS_CFG.incoming_channel_id = data.incoming_channel_id || ENV_INCOMING;
      APPS_CFG.verdict_channel_id = data.verdict_channel_id || data.results_channel_id || ENV_RESULTS;
      APPS_CFG.ping_role_id = data.ping_role_id || null;
      APPS_CFG.ping_role_id_2 = data.ping_role_id_2 || null;
      APPS_CFG.loaded_at = Date.now();
    }
  }catch(e){}
}

const database = createPostgresClient(DATABASE_URL, {
  ssl: String(PGSSL||"").toLowerCase() !== "disable",
  rejectUnauthorized: String(PGSSL||"").toLowerCase() !== "no-verify"
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

function log(...a){ console.log("["+new Date().toISOString()+"]", ...a); }

function buildMessageLink(guildId, channelId, messageId){
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

function pickText(msg){
  const parts = [];
  if(msg.content && msg.content.trim()) parts.push(msg.content);
  if(msg.embeds && msg.embeds.length){
    for(const e of msg.embeds){
      const hasFields = Array.isArray(e.fields) && e.fields.length > 0;
      const isLinkPreview = e.url && !hasFields;
      if(isLinkPreview) continue;
      if(e.title) parts.push("**"+e.title+"**");
      if(e.description) parts.push(e.description);
      if(hasFields){
        for(const f of e.fields){
          parts.push("**"+f.name+":**");
          parts.push(f.value);
        }
      }
    }
  }
  return parts.join("\n");
}

async function saveApplication(msg){
  const text = pickText(msg);
  if(!text || !text.trim()){
    log("SKIP: пустое сообщение", msg.id);
    return null;
  }

  const parsed = parseDiscordMessage(text);
  const fieldCount = Object.keys(parsed.fields || {}).length;
  if(fieldCount < 2){
    log("SKIP: не похоже на заявление (распознано полей:", fieldCount, ")", msg.id);
    return null;
  }

  const authorTag = msg.author ? (msg.author.tag || msg.author.username || "") : "";
  const authorAvatar = msg.author && msg.author.displayAvatarURL ? msg.author.displayAvatarURL({ size: 128, extension: "png" }) : null;

  const row = {
    source: "discord",
    external_id: msg.id,
    message_link: buildMessageLink(msg.guildId || GUILD_ID, msg.channelId, msg.id),
    app_type: parsed.app_type,
    fields: parsed.fields,
    raw_text: parsed.raw_text,
    submitter_name: parsed.submitter_name || null,
    submitter_discord: parsed.submitter_discord || authorTag || null,
    submitter_avatar: authorAvatar,
    status: "new"
  };

  const { data, error } = await database
    .from("applications")
    .upsert(row, { onConflict: "external_id" })
    .select()
    .single();

  if(error){
    log("ERR upsert", msg.id, error.message);
    return null;
  }
  log("SAVED", data.id, "|", data.app_type, "|", data.submitter_name || data.submitter_discord || "?");
  try{
    const target = appStatusToReaction(data.status) || "pending";
    await reactions.setStatus(client, msg.channelId, msg.id, target);
  }catch(e){ log("REACT app err:", e.message); }
  return data;
}

function appStatusToReaction(status){
  if(status === "approved") return "approved";
  if(status === "rejected") return "rejected";
  if(status === "archived" || status === "withdrawn" || status === "canceled" || status === "cancelled") return "withdrawn";
  return null;
}

async function backfill(){
  const limit = Math.max(1, Math.min(100, parseInt(BACKFILL_LIMIT||"50",10)));
  log("BACKFILL: загружаю последние", limit, "сообщений из #incoming");
  try{
    const ch = await client.channels.fetch(CHANNEL_INCOMING_ID());
    if(!ch || !ch.isTextBased()){
      log("BACKFILL: канал не найден или не текстовый");
      return;
    }
    const messages = await ch.messages.fetch({ limit });
    const arr = Array.from(messages.values()).reverse();
    log("BACKFILL: получено", arr.length, "сообщений");
    for(const m of arr){
      try{ await saveApplication(m); }catch(e){ log("BACKFILL err", e.message); }
    }
    log("BACKFILL: готово");
  }catch(e){
    log("BACKFILL fail:", e.message);
  }
}

const STATUS_STYLE = {
  approved: {
    color: 0x2ecc71,
    accent: 0x1e8449,
    label: "ОДОБРЕНО",
    emoji: "✅",
    title: "Заявление одобрено",
    footer: "Добро пожаловать в коллектив"
  },
  rejected: {
    color: 0xe74c3c,
    accent: 0xa93226,
    label: "ОТКАЗАНО",
    emoji: "⛔",
    title: "Заявление отклонено",
    footer: "Причина указана ниже"
  },
  archived: {
    color: 0x7f8c8d,
    accent: 0x566573,
    label: "АРХИВ",
    emoji: "🗄️",
    title: "Заявление в архиве",
    footer: "Без официального ответа"
  }
};

function truncate(s, n){
  const t = String(s == null ? "" : s);
  return t.length > n ? t.slice(0, n-1) + "…" : t;
}

function buildResultEmbed(row){
  const st = STATUS_STYLE[row.status] || STATUS_STYLE.approved;
  const submitter = row.submitter_name || row.submitter_discord || "неизвестно";
  const who = row.responded_by_name || "Администрация ЦГБ №3";
  const link = row.message_link || null;

  const embed = new EmbedBuilder()
    .setColor(st.color)
    .setTitle(`${st.emoji}  ${st.title}`)
    .setTimestamp(row.responded_at ? new Date(row.responded_at) : new Date())
    .setFooter({ text: `ЦГБ №3 • Министерство здравоохранения • ${st.footer}` });

  const headerLines = [
    "```ansi",
    `\u001b[1;37m▍ СТАТУС:\u001b[0m  ${st.emoji} ${st.label}`,
    "```"
  ];

  const fields = [
    { name: "👤 Заявитель", value: "```" + truncate(submitter, 200) + "```", inline: false },
    { name: "🎖️ Рассмотрел", value: "```" + truncate(who, 200) + "```", inline: false }
  ];

  if(row.submitter_discord && row.submitter_discord !== submitter){
    fields.push({ name: "💬 Discord", value: "`" + truncate(row.submitter_discord, 200) + "`", inline: false });
  }

  if(row.status === "rejected" && row.reject_reason){
    fields.push({
      name: "📝 Причина отказа",
      value: "> " + truncate(row.reject_reason.replace(/\n+/g, "\n> "), 900),
      inline: false
    });
  }

  if(link){
    fields.push({
      name: "🔗 Оригинал заявления",
      value: `[Открыть сообщение в канале →](${link})`,
      inline: false
    });
  }

  embed.setDescription(headerLines.join("\n"));
  embed.addFields(fields);

  return embed;
}

function extractDiscordHandle(raw){
  const s = String(raw||"").trim();
  if(!s) return null;
  const mentionId = s.match(/<@!?(\d{15,25})>/);
  if(mentionId) return { type: "id", value: mentionId[1] };
  const rawId = s.match(/^(\d{15,25})$/);
  if(rawId) return { type: "id", value: rawId[1] };
  const atUser = s.match(/@?([a-z0-9_.]{2,32})/i);
  if(atUser) return { type: "username", value: atUser[1].toLowerCase() };
  return null;
}

async function resolveMention(guild, submitterDiscord){
  const h = extractDiscordHandle(submitterDiscord);
  if(!h || !guild) return null;
  try{
    if(h.type === "id"){
      const m = await guild.members.fetch(h.value).catch(()=>null);
      if(m) return `<@${m.id}>`;
      return null;
    }
    const found = await guild.members.fetch({ query: h.value, limit: 5 }).catch(()=>null);
    if(!found || !found.size) return null;
    let hit = found.find(m => (m.user.username||"").toLowerCase() === h.value);
    if(!hit) hit = found.find(m => (m.user.globalName||"").toLowerCase() === h.value);
    if(!hit) hit = found.first();
    return hit ? `<@${hit.id}>` : null;
  }catch(e){
    log("MENTION resolve err:", e.message);
    return null;
  }
}

async function sendResult(row){
  if(row.status === "archived"){
    log("RESULT skip: архив (ответ не шлём)", row.id);
    if(row.external_id) await reactions.setWithdrawn(client, CHANNEL_INCOMING_ID(), row.external_id);
    return;
  }
  if(row.status !== "approved" && row.status !== "rejected"){
    if(row.external_id){
      const t = appStatusToReaction(row.status) || "pending";
      await reactions.setStatus(client, CHANNEL_INCOMING_ID(), row.external_id, t);
    }
    return;
  }
  if(row.external_id){
    const t = appStatusToReaction(row.status) || "pending";
    await reactions.setStatus(client, CHANNEL_INCOMING_ID(), row.external_id, t);
  }
  try{
    const ch = await client.channels.fetch(CHANNEL_RESULTS_ID());
    if(!ch || !ch.isTextBased()){
      log("RESULT ERR: канал результатов не найден");
      return;
    }

    let mention = null;
    let mentionUserId = null;
    try{
      const guild = ch.guild || await client.guilds.fetch(GUILD_ID).catch(()=>null);
      if(guild && row.submitter_discord){
        mention = await resolveMention(guild, row.submitter_discord);
        if(mention){
          const m = mention.match(/<@(\d+)>/);
          if(m) mentionUserId = m[1];
        }
      }
    }catch(e){ log("MENTION err:", e.message); }

    const embed = buildResultEmbed(row);
    const pingRoles = [APPS_CFG.ping_role_id, APPS_CFG.ping_role_id_2].filter(Boolean);
    const contentParts = [];
    const allow = {};
    if(pingRoles.length){
      contentParts.push(...pingRoles.map(r=>"<@&"+r+">"));
      allow.roles = pingRoles;
    }
    if(mention){
      contentParts.push(mention);
      allow.users = [mentionUserId];
    }
    if(!contentParts.length) allow.parse = [];
    const payload = { embeds: [embed], allowedMentions: allow };
    if(contentParts.length) payload.content = contentParts.join(" ");

    const sent = await ch.send(payload);
    log("RESULT sent", row.id, "→", sent.id, mention ? "(pinged "+mentionUserId+")" : "(no ping)");

    await database
      .from("applications")
      .update({ result_message_id: sent.id, result_sent_at: new Date().toISOString() })
      .eq("id", row.id);
  }catch(e){
    log("RESULT ERR:", e.message);
  }
}

async function backfillAppReactions(){
  try{
    const { data } = await database.from("applications")
      .select("id,status,external_id")
      .not("external_id","is",null)
      .order("id", { ascending: false })
      .limit(100);
    if(!data || !data.length) return;
    log("APPS backfillReactions:", data.length);
    for(const r of data){
      const target = appStatusToReaction(r.status) || "pending";
      await reactions.setStatus(client, CHANNEL_INCOMING_ID(), r.external_id, target);
    }
  }catch(e){ log("APPS backfill err:", e.message) }
}

function subscribeRealtime(){
  const channel = database.channel("cgb-apps-updates")
    .on("postgres_changes",
      { event: "UPDATE", schema: "public", table: "applications" },
      async (payload) => {
        const oldRow = payload.old || {};
        const newRow = payload.new || {};
        if(oldRow.status === newRow.status) return;
        if(newRow.result_message_id) return;
        log("REALTIME status change", newRow.id, oldRow.status, "→", newRow.status);
        await sendResult(newRow);
      })
    .subscribe((status)=>{
      log("REALTIME channel status:", status);
    });
  return channel;
}

const vp = setupVP({ client, database, guildId: GUILD_ID, log });
const msg = setupMSG({ client, database, guildId: GUILD_ID, log });
const vpReport = setupReport({ client, database, log });
const testReport = setupTestReport({ client, database, log });
const supply = setupSupply({ client, database, guildId: GUILD_ID, log });

client.once(Events.ClientReady, async (c) => {
  log("BOT READY as", c.user.tag);
  await reloadAppsCfg(database);
  log("Guild:", GUILD_ID, "| Incoming:", CHANNEL_INCOMING_ID(), "| Results:", CHANNEL_RESULTS_ID(), "| PingRoles:", [APPS_CFG.ping_role_id,APPS_CFG.ping_role_id_2].filter(Boolean).join(",")||"нет");
  setInterval(()=>{ reloadAppsCfg(database); }, 30*1000);

  subscribeRealtime();
  vp.subscribeSyncRequests();
  vp.startHeartbeat();
  msg.subscribe();
  msg.initChannels();
  vpReport.subscribe();
  testReport.subscribe();
  supply.subscribe();
  complaintsMod.subscribe(database, client);
  log("COMPLAINTS: subscribed (poll 15s, expirations 1h)");
  payrollMod.subscribe(database, client);
  log("PAYROLL: polling started");
  requestsMod.subscribe(database, client);
  raidsMod.subscribe(database, client);
  reportMod.subscribe(database, client);
  vpRequestMod.subscribe(database, client);
  log("REQUESTS / REPORT / AB-REQ / RAIDS: polling started");

  const syncMin = parseInt(process.env.VP_SYNC_MINUTES || "5", 10);
  vp.scheduleInterval(syncMin);
  log("VP: interval sync every", syncMin, "min");

  vp.initialSync().then(r => {
    if(r.ok) log("VP: initial sync ok,", r.count, "members");
    else log("VP: initial sync failed:", r.error);
  });

  if(String(BACKFILL_ON_START).toLowerCase() === "true"){
    await backfill();
  }

  setTimeout(()=>{ backfillAppReactions(); }, 25*1000);
});

client.on(Events.MessageCreate, async (msg2) => {
  try{
    if(!msg2.guildId || msg2.guildId !== GUILD_ID) return;
    if(msg2.channelId !== CHANNEL_INCOMING_ID()) return;
    if(msg2.author && msg2.author.id === client.user.id) return;
    await saveApplication(msg2);
  }catch(e){
    log("MSG handler err:", e.message);
  }
});

client.on(Events.Error, (e)=>log("CLIENT ERR:", e.message));
process.on("unhandledRejection", (e)=>log("UNHANDLED:", e && e.message ? e.message : e));

async function markOffline(){
  try{ await database.from("bot_status").upsert({ id: 1, online: false, last_seen: new Date().toISOString(), updated_at: new Date().toISOString() }, { onConflict: "id" }); }catch(e){}
}
process.on("SIGINT", async ()=>{ log("SIGINT"); await markOffline(); await database.close(); process.exit(0); });
process.on("SIGTERM", async ()=>{ log("SIGTERM"); await markOffline(); await database.close(); process.exit(0); });

client.login(DISCORD_TOKEN).catch(e=>{
  log("LOGIN FAIL:", e.message);
  process.exit(1);
});
