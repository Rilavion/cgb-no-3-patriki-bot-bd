/* Результаты тестов: сайт (test.html / редактор тестов) создаёт
 * test_result_requests (status=pending), бот отправляет красивый результат
 * в канал теста с пингом сдававшего. */
const { EmbedBuilder } = require("discord.js");
const BOT_TZ = process.env.TIMEZONE || "Europe/Moscow"; // все метки времени бота — по МСК, независимо от часового пояса сервера/ПК

function ruDT(d){try{return new Date(d).toLocaleString("ru-RU",{timeZone:BOT_TZ,day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"})}catch(e){return String(d||"")}}

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
    const found = await guild.members.fetch({ query: h.value, limit: 5 }).catch(()=>null);
    if(!found || !found.size) return null;
    let hit = found.find(m => (m.user.username||"").toLowerCase() === h.value);
    if(!hit) hit = found.find(m => (m.user.globalName||"").toLowerCase() === h.value);
    if(!hit) hit = found.first();
    return hit ? { mention: `<@${hit.id}>`, id: hit.id } : null;
  }catch(e){ return null }
}

function statusStyle(passed){
  return passed ? {
    color: 0x2ecc71, emoji: "✅", label: "УСПЕШНО ПРОЙДЕН",
    footer: "Поздравляем! Тест сдан."
  } : {
    color: 0xe74c3c, emoji: "⛔", label: "НЕ ПРОЙДЕН",
    footer: "Тест не сдан — попробуйте ещё раз."
  };
}

async function buildResultMessage(database, attempt, testRow, guild, isRepeat){
  const st = statusStyle(attempt.passed);
  const pingLines = await loadPrefilledAnswers(database, testRow.id, attempt.answers || {});
  const attemptsInfo = await loadAttemptsInfo(database, attempt, testRow);

  let mention = null, mentionId = null;
  if(guild && attempt.discord){
    const r = await resolveMention(guild, attempt.discord);
    if(r && r.mention){ mention = r.mention; mentionId = r.id }
  }

  const maxScore = (attempt.max_score != null ? attempt.max_score : (attempt.total != null ? attempt.total : 0));

  const embed = new EmbedBuilder()
    .setColor(st.color)
    .setAuthor({ name: "СИСТЕМА ТЕСТИРОВАНИЯ · ЦГБ №3" })
    .setTitle(`${st.emoji}  ${st.label}`)
    .setDescription(`### ${escapeMd(testRow.title || "Тестирование")}\n_Результат прохождения служебного теста_`)
    .setTimestamp(new Date(attempt.finished_at || Date.now()))
    .setFooter({ text: `ЦГБ №3 · Минздрав · ${st.footer}` });

  const fields = [];
  fields.push({ name: "👤  ФИО", value: `**${attempt.fio}**`, inline: true });
  fields.push({ name: "🆔  Статик", value: `\`${attempt.static_id}\``, inline: true });
  fields.push({ name: "💬  Discord", value: attempt.discord ? `\`${attempt.discord}\`` : "—", inline: true });

  fields.push({ name: "📊  Результат", value: `**${attempt.score} / ${maxScore}** баллов`, inline: true });
  fields.push({ name: "📈  Процент", value: `**${attempt.percent}%**`, inline: true });
  fields.push({ name: "🎯  Порог сдачи", value: `${testRow.pass_score}%`, inline: true });

  if(!attempt.passed && attemptsInfo){
    const { used, max, remaining } = attemptsInfo;
    if(max > 0){
      const status = remaining > 0
        ? `**${remaining}** из ${max} (использовано ${used})`
        : `⚠️ **Попытки исчерпаны** (${used}/${max}). Обратитесь к администрации для сброса.`;
      fields.push({ name: "🔁  Осталось попыток", value: status, inline: false });
    } else {
      fields.push({ name: "🔁  Попыток пройдено", value: `${used} (лимита нет)`, inline: false });
    }
  }

  if(pingLines && pingLines.length){
    const val = pingLines.map(l => `**${l.key}:** ${l.value}`).join("\n");
    fields.push({ name: "📝  Дополнительно", value: val, inline: false });
  }

  if(attempt.reviewed_by_name){
    fields.push({ name: "✍️  Проверено вручную", value: `${attempt.reviewed_by_name} · ${ruDT(attempt.reviewed_at)}`, inline: false });
  }

  if(isRepeat){
    fields.push({ name: "🔁  Повторная отправка", value: "Результат был отредактирован администрацией и отправлен повторно.", inline: false });
  }

  embed.addFields(fields);

  const payload = { embeds: [embed] };
  if(mention){
    payload.content = mention + (isRepeat ? "  ⚠ **обновление результата**" : "");
    payload.allowedMentions = { users: [mentionId] };
  } else {
    payload.allowedMentions = { parse: [] };
  }
  return payload;
}

function escapeMd(s){ return String(s||"").replace(/([*_`~|>#\\])/g,"\\$1") }

async function loadAttemptsInfo(database, attempt, testRow){
  try{
    const max = testRow.max_attempts || 0;
    const { data, error } = await database.rpc("count_test_attempts", {
      p_test_id: testRow.id,
      p_static: attempt.static_id || null,
      p_discord: attempt.discord || null
    });
    if(error) return null;
    const used = data || 0;
    return { used, max, remaining: max > 0 ? Math.max(0, max - used) : null };
  }catch(e){ return null }
}

async function loadPrefilledAnswers(database, testId, answers){
  try{
    const { data } = await database.from("test_questions").select("*").eq("test_id", testId).eq("kind","prefilled").order("sort", { ascending: true });
    const rows = (data || []).map(q => ({ key: q.text, value: q.prefilled_value || "" })).filter(x => x.key && x.value);
    return rows;
  }catch(e){ return [] }
}

async function sendResult(database, client, attemptId, channelId, isRepeat, log){
  try{
    const { data: attempt, error: aErr } = await database.from("test_attempts").select("*").eq("id", attemptId).maybeSingle();
    if(aErr || !attempt) throw new Error("attempt not found: " + (aErr && aErr.message));

    const { data: testRow, error: tErr } = await database.from("tests").select("*").eq("id", attempt.test_id).maybeSingle();
    if(tErr || !testRow) throw new Error("test not found: " + (tErr && tErr.message));

    const finalChannelId = channelId || testRow.result_channel_id;
    if(!finalChannelId) throw new Error("no channel configured");

    const ch = await client.channels.fetch(finalChannelId);
    if(!ch || !ch.isTextBased()) throw new Error("channel not found or not text");

    const guild = ch.guild;
    const payload = await buildResultMessage(database, attempt, testRow, guild, !!isRepeat);
    const sent = await ch.send(payload);

    await database.from("test_attempts").update({
      channel_sent_id: finalChannelId,
      channel_message_id: sent.id,
      channel_sent_at: new Date().toISOString()
    }).eq("id", attemptId);

    log("TEST-RESULT sent attempt=" + attemptId + " → " + sent.id + (isRepeat?" [REPEAT]":""));
    return { ok: true, message_id: sent.id };
  }catch(e){
    log("TEST-RESULT err:", e.message);
    return { ok: false, error: e.message };
  }
}

function setupTestReport({ client, database, log }){
  function subscribe(){
    database.channel("test-result-queue")
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "test_result_requests" },
        async (payload) => {
          const req = payload.new;
          if(!req || req.status !== "pending") return;
          log("TEST-RESULT request id=" + req.id + " attempt=" + req.attempt_id);
          await database.from("test_result_requests").update({ status: "sending" }).eq("id", req.id);
          const r = await sendResult(database, client, req.attempt_id, req.channel_id, req.is_repeat, log);
          if(r.ok){
            await database.from("test_result_requests").update({
              status: "sent", sent_message_id: r.message_id, sent_at: new Date().toISOString()
            }).eq("id", req.id);
          } else {
            await database.from("test_result_requests").update({
              status: "error", message: r.error, sent_at: new Date().toISOString()
            }).eq("id", req.id);
          }
        })
      .subscribe((s) => log("TEST-RESULT realtime:", s));
  }
  return { subscribe };
}

module.exports = { setupTestReport };
