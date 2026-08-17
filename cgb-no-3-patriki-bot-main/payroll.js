/* Премирование: сайт создаёт запись в payroll_send_requests (status=pending),
 * бот публикует реестр в канал Discord (картинка/текст/оба варианта)
 * и помечает черновик отправленным. */
const { EmbedBuilder } = require("discord.js");
const BOT_TZ = process.env.TIMEZONE || "Europe/Moscow"; // все метки времени бота — по МСК, независимо от часового пояса сервера/ПК

function fmtMoney(n){
  const v = Math.round(+n||0);
  return v.toLocaleString("ru-RU",{timeZone:BOT_TZ}) + " ₽";
}
function ruDate(iso){try{return new Date(iso).toLocaleDateString("ru-RU",{timeZone:BOT_TZ,day:"2-digit",month:"2-digit",year:"numeric"})}catch(e){return String(iso||"")}}

// Тот же расчёт, что в payroll-engine.js на сайте (CGB_PAYROLL.calc)
function calc(draft){
  const data=(draft&&draft.data)||{departments:[]};
  const fund=Math.round(Number(draft&&draft.fund_amount)||0);
  const depts=(data.departments||[]).map(d=>Object.assign({},d,{members:(d.members||[]).slice()}));
  const manual=draft&&draft.pct_manual!==false;
  if(!manual&&depts.length){
    const equal=100/depts.length;
    for(const d of depts) d.pct=equal;
  }
  for(const d of depts){
    const pct=Number(d.pct)||0;
    d.dept_amount=Math.round(fund*(pct/100));
    const active=d.members.filter(m=>!m.excluded);
    let overrideSum=0, sharesSum=0;
    for(const m of active){
      if(m.override_amount!=null&&m.override_amount!==""){overrideSum+=Math.round(Number(m.override_amount)||0)}
      else {sharesSum+=Number(m.share||1)||1}
    }
    const remaining=Math.max(0,d.dept_amount-overrideSum);
    const shareItems=[];
    for(const m of d.members){
      if(m.excluded){m.amount=0;continue}
      if(m.override_amount!=null&&m.override_amount!==""){m.amount=Math.round(Number(m.override_amount)||0)}
      else {
        const share=Number(m.share||1)||1;
        const raw=sharesSum>0?(remaining*share/sharesSum):0;
        m.amount=Math.floor(raw);
        shareItems.push(m);
      }
    }
    const distributed=shareItems.reduce((s,m)=>s+m.amount,0);
    let leftover=remaining-distributed;
    let i=0;
    while(leftover>0&&shareItems.length){
      shareItems[i%shareItems.length].amount+=1;
      leftover--;i++;
    }
    d.members_sum=d.members.reduce((s,m)=>s+(m.excluded?0:m.amount),0);
  }
  return {fund, departments:depts, total_spent:depts.reduce((s,d)=>s+d.members_sum,0)};
}

async function getSettings(database){
  const {data} = await database.from("payroll_settings").select("*").eq("id",1).maybeSingle();
  return data;
}

function buildEmbeds(draft, settings){
  const c = calc(draft);
  const header = (settings && settings.header_text) || "ПРИКАЗ О ПРЕМИРОВАНИИ";
  const footer = (settings && settings.footer_text) || "Бухгалтерия · ЦГБ №3";

  const embeds = [];
  const head = new EmbedBuilder()
    .setColor(0x3a7d6b)
    .setTitle("◈ " + header + " ◈")
    .setDescription("**" + (draft.title||"Премия") + "**"
      + (draft.period_from||draft.period_to ? "\nПериод: **" + ruDate(draft.period_from) + " — " + ruDate(draft.period_to) + "**" : ""))
    .addFields(
      { name: "💰 Общий фонд", value: "**" + fmtMoney(c.fund) + "**", inline: true },
      { name: "📤 Распределено", value: "**" + fmtMoney(c.total_spent) + "**", inline: true },
      { name: "📊 Отделов", value: "**" + c.departments.length + "**", inline: true }
    )
    .setTimestamp(new Date());
  embeds.push(head);

  for(const d of c.departments){
    const active = d.members.filter(m=>!m.excluded);
    if(!active.length) continue;
    const lines = active.map((m,i)=>{
      const num = String(i+1).padStart(2,"0");
      const stat = m.static ? "` " + m.static + " `" : "";
      return `\`${num}\` **${m.fio}** ${stat} → **${fmtMoney(m.amount)}**`;
    });
    const chunks = [];
    let cur = "";
    for(const line of lines){
      if(cur.length + line.length + 1 > 4000){ chunks.push(cur); cur = ""; }
      cur += (cur ? "\n" : "") + line;
    }
    if(cur) chunks.push(cur);
    for(let i=0; i<chunks.length; i++){
      const emb = new EmbedBuilder()
        .setColor(0x2a4838)
        .setTitle(`${d.icon||"🏥"} ${d.name}${chunks.length>1?` (${i+1}/${chunks.length})`:""}`)
        .setDescription(chunks[i]);
      if(i === chunks.length-1){
        emb.addFields(
          { name: "Доля отдела", value: (+d.pct).toFixed(1) + "%", inline: true },
          { name: "Сумма отдела", value: fmtMoney(d.dept_amount), inline: true },
          { name: "Выдано сотрудникам", value: fmtMoney(d.members_sum), inline: true }
        );
      }
      embeds.push(emb);
      if(embeds.length >= 10) break;
    }
    if(embeds.length >= 10) break;
  }

  const last = embeds[embeds.length-1];
  last.setFooter({ text: footer });

  return { embeds, calc: c };
}

function dataUrlToBuffer(dataUrl){
  if(!dataUrl || !dataUrl.startsWith("data:")) return null;
  const idx = dataUrl.indexOf(",");
  if(idx < 0) return null;
  const b64 = dataUrl.slice(idx+1);
  return Buffer.from(b64, "base64");
}

async function processSendRequest(database, client, req){
  try{
    await database.from("payroll_send_requests").update({status:"running"}).eq("id", req.id);
    const {data:draft} = await database.from("payroll_drafts").select("*").eq("id", req.draft_id).maybeSingle();
    if(!draft){
      await database.from("payroll_send_requests").update({status:"error", message:"draft not found", finished_at:new Date().toISOString()}).eq("id", req.id);
      return;
    }
    const settings = await getSettings(database);
    if(!settings || !settings.channel_id){
      await database.from("payroll_send_requests").update({status:"error", message:"channel not configured", finished_at:new Date().toISOString()}).eq("id", req.id);
      return;
    }
    const guild = client.guilds.cache.first();
    if(!guild){
      await database.from("payroll_send_requests").update({status:"error", message:"no guild", finished_at:new Date().toISOString()}).eq("id", req.id);
      return;
    }
    const ch = await guild.channels.fetch(settings.channel_id).catch(()=>null);
    if(!ch || !ch.isTextBased()){
      await database.from("payroll_send_requests").update({status:"error", message:"channel not accessible", finished_at:new Date().toISOString()}).eq("id", req.id);
      return;
    }

    const outMode = req.output_mode || settings.output_mode || "both";
    const splitByDept = req.split_by_dept != null ? req.split_by_dept : !!settings.split_by_dept;
    let firstMsgId = null;

    const draftCalc = calc(draft);
    const activeDepts = draftCalc.departments.filter(d=>d.members.filter(m=>!m.excluded).length>0);

    if(outMode === "image" || outMode === "both"){
      const parts = Array.isArray(req.image_parts) ? req.image_parts : null;
      if(splitByDept && parts && parts.length){
        for(let i=0; i<parts.length; i++){
          const buf = dataUrlToBuffer(parts[i]);
          if(!buf) continue;
          const opts = { files: [{ attachment: buf, name: "payroll_"+(i+1)+".png" }] };
          const roleIds = [];
          if(i === 0 && settings.ping_role_id) roleIds.push(settings.ping_role_id);
          const deptIdx = i - 1;
          if(deptIdx >= 0 && deptIdx < activeDepts.length){
            const d = activeDepts[deptIdx];
            if(d.ping && d.role_id) roleIds.push(d.role_id);
          }
          if(roleIds.length){
            opts.content = roleIds.map(r=>"<@&"+r+">").join(" ");
            opts.allowedMentions = { roles: roleIds };
          }
          const m = await ch.send(opts);
          if(!firstMsgId) firstMsgId = m.id;
        }
      } else {
        const imgBuf = dataUrlToBuffer(req.image_data);
        if(imgBuf){
          const opts = { files: [{ attachment: imgBuf, name: "payroll.png" }] };
          const roleIds = [];
          if(settings.ping_role_id) roleIds.push(settings.ping_role_id);
          for(const d of activeDepts){ if(d.ping && d.role_id) roleIds.push(d.role_id) }
          if(roleIds.length){
            opts.content = roleIds.map(r=>"<@&"+r+">").join(" ");
            opts.allowedMentions = { roles: roleIds };
          }
          const m = await ch.send(opts);
          firstMsgId = m.id;
        }
      }
    }

    if(outMode === "text" || outMode === "both"){
      const { embeds } = buildEmbeds(draft, settings);
      const batches = [];
      for(let i=0; i<embeds.length; i+=10) batches.push(embeds.slice(i, i+10));
      for(let i=0; i<batches.length; i++){
        const opts = { embeds: batches[i] };
        if(i === 0 && !firstMsgId){
          const roleIds = [];
          if(settings.ping_role_id) roleIds.push(settings.ping_role_id);
          for(const d of activeDepts){ if(d.ping && d.role_id) roleIds.push(d.role_id) }
          if(roleIds.length){
            opts.content = roleIds.map(r=>"<@&"+r+">").join(" ");
            opts.allowedMentions = { roles: roleIds };
          }
        }
        const m = await ch.send(opts);
        if(!firstMsgId) firstMsgId = m.id;
      }
    }

    if(!firstMsgId){
      await database.from("payroll_send_requests").update({status:"error", message:"no output produced", finished_at:new Date().toISOString()}).eq("id", req.id);
      return;
    }

    await database.from("payroll_drafts").update({
      status: "sent",
      sent_at: new Date().toISOString(),
      sent_by_name: req.requested_by_name,
      ds_message_id: firstMsgId, ds_channel_id: ch.id,
      updated_at: new Date().toISOString()
    }).eq("id", draft.id);

    await database.from("payroll_send_requests").update({status:"done", message:"sent, msg="+firstMsgId, image_data:null, image_parts:null, finished_at:new Date().toISOString()}).eq("id", req.id);
    console.log("[payroll] sent draft", draft.id, "→ msg", firstMsgId, "mode:", outMode);
  }catch(e){
    console.warn("[payroll] processSend err:", e.message);
    await database.from("payroll_send_requests").update({status:"error", message:e.message, image_data:null, image_parts:null, finished_at:new Date().toISOString()}).eq("id", req.id).catch(()=>{});
  }
}

async function pollSendRequests(database, client){
  try{
    const { data } = await database.from("payroll_send_requests").select("*").eq("status","pending").order("created_at",{ascending:true}).limit(5);
    if(!data || !data.length) return;
    for(const req of data){
      await processSendRequest(database, client, req);
    }
  }catch(e){ console.warn("[payroll] poll err:", e.message) }
}

function subscribe(database, client){
  console.log("[payroll] send-request polling every 10s");
  setInterval(async ()=>{ await pollSendRequests(database, client) }, 10*1000);
  setTimeout(async ()=>{ await pollSendRequests(database, client) }, 20*1000);
}

module.exports = { subscribe, processSendRequest, buildEmbeds };
