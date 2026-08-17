/* Отчёт проверок АБ: на сайте (vp.html, архив) жмут «Отправить отчёт в DS» →
 * строка в vp_report_requests; бот шлёт полный отчёт по архиву проверок:
 * шапка-embed, сводка по отделам, легенда, сравнение с прошлым отчётом,
 * таблицы по отделам (ANSI), подпись. */
const { EmbedBuilder } = require("discord.js");
const BOT_TZ = process.env.TIMEZONE || "Europe/Moscow"; // все метки времени бота — по МСК, независимо от часового пояса сервера/ПК

const COLS = [
  { key: "medbook", label: "Мед. Книжка", short: "МК" },
  { key: "narko", label: "Справка Нарк.", short: "Н" },
  { key: "driver", label: "Вод. Права", short: "ВП" },
  { key: "passport", label: "Паспорт", short: "П" },
  { key: "personal_file", label: "Личное Дело", short: "ЛД" },
  { key: "weapon_license", label: "Лицензия Оружия", short: "ЛО" },
  { key: "attestation", label: "Аттестация", short: "АТ" }
];

const A = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  white: "\u001b[0;37m",
  wbold: "\u001b[1;37m",
  gray: "\u001b[2;37m",
  red: "\u001b[0;31m",
  rbold: "\u001b[1;31m",
  green: "\u001b[0;32m",
  gbold: "\u001b[1;32m",
  yellow: "\u001b[0;33m",
  ybold: "\u001b[1;33m",
  blue: "\u001b[0;34m",
  pink: "\u001b[0;35m",
  cyan: "\u001b[0;36m",
  gold: "\u001b[1;33m"
};

function pad(s, n, right){
  s = String(s == null ? "" : s);
  if(s.length >= n) return s.slice(0, n);
  const gap = " ".repeat(n - s.length);
  return right ? gap + s : s + gap;
}

function truncate(s, n){
  s = String(s == null ? "" : s);
  return s.length > n ? s.slice(0, n-1) + "…" : s;
}

function icon(v){
  if(v === "yes") return "✓";
  if(v === "no") return "✕";
  if(v === "absent") return "○";
  return "·";
}

function color(v){
  if(v === "yes") return A.green;
  if(v === "no") return A.red;
  if(v === "absent") return A.gray;
  return A.gray;
}

function ru(dt){
  try{ return new Date(dt).toLocaleString("ru-RU",{timeZone:BOT_TZ,day:"2-digit", month:"2-digit", year:"numeric", hour:"2-digit", minute:"2-digit"}); }
  catch(e){ return String(dt||""); }
}

function ruDate(dt){
  try{ return new Date(dt).toLocaleDateString("ru-RU",{timeZone:BOT_TZ,day:"2-digit", month:"2-digit", year:"numeric"}); }
  catch(e){ return String(dt||""); }
}

function buildDeptTables(rawSnapshot){
  const snapshot = normalizeSnapshot(rawSnapshot);
  const groups = snapshot.groups || [];
  const chunks = [];
  const W_IDX = 3, W_FIO = 18, W_ST = 8, W_CELL = 5, W_CHK = 12;
  const SEP_V = "│";
  const widths = [W_IDX, W_FIO, W_ST, ...COLS.map(()=>W_CELL), W_CHK];
  const totalW = widths.reduce((a,b)=>a+b,0) + (widths.length - 1);
  for(const g of groups){
    const rows = g.list || [];
    if(!rows.length) continue;
    const lines = [];
    lines.push(`${A.gold}▍${A.reset} ${A.wbold}${g.name}${A.reset}  ${A.cyan}[${rows.length} чел.]${A.reset}`);
    lines.push(A.yellow + "═".repeat(totalW) + A.reset);
    const head = [
      `${A.wbold}${pad("№",W_IDX)}${A.reset}`,
      `${A.wbold}${pad("ФИО",W_FIO)}${A.reset}`,
      `${A.wbold}${pad("Статик",W_ST)}${A.reset}`,
      ...COLS.map(c=>`${A.wbold}${pad(c.short,W_CELL)}${A.reset}`),
      `${A.wbold}${pad("Проверил",W_CHK)}${A.reset}`
    ].join(`${A.yellow}${SEP_V}${A.reset}`);
    lines.push(head);
    lines.push(A.yellow + "─".repeat(totalW) + A.reset);
    rows.forEach((m, i) => {
      const fio = truncate(m.parsed_fio || m.display_name || "—", W_FIO);
      const st = truncate(m.parsed_static || "—", W_ST);
      const checker = truncate(m.checked_by_name || "—", W_CHK);
      const checkerColor = m.checked_by_name ? A.green : A.gray;
      const cells = COLS.map(c => {
        const v = m[c.key] || null;
        return color(v) + pad(icon(v), W_CELL) + A.reset;
      });
      const parts = [
        `${A.cyan}${pad(String(i+1).padStart(2,"0"),W_IDX)}${A.reset}`,
        `${A.white}${pad(fio,W_FIO)}${A.reset}`,
        `${A.ybold}${pad(st,W_ST)}${A.reset}`,
        ...cells,
        `${checkerColor}${pad(checker,W_CHK)}${A.reset}`
      ];
      lines.push(parts.join(" "));
    });
    lines.push(A.yellow + "═".repeat(totalW) + A.reset);
    chunks.push(lines.join("\n"));
  }
  return chunks;
}

function buildLegend(){
  const abbrs = [
    ["МК","Мед. Книжка"],["Н","Справка Нарк."],["ВП","Вод. Права"],
    ["П","Паспорт"],["ЛД","Личное Дело"],["ЛО","Лицензия Оружия"],["АТ","Аттестация"]
  ];
  const lines = [];
  lines.push(`${A.wbold}СОКРАЩЕНИЯ КОЛОНОК:${A.reset}`);
  const parts = abbrs.map(([a,f]) => `${A.ybold}${a}${A.reset} ${A.gray}—${A.reset} ${A.white}${f}${A.reset}`);
  lines.push("  " + parts.slice(0,4).join(A.gray + "   ·   " + A.reset));
  lines.push("  " + parts.slice(4).join(A.gray + "   ·   " + A.reset));
  lines.push("");
  lines.push(`${A.wbold}СТАТУСЫ:${A.reset}  ${A.gbold}✓${A.reset} ${A.white}ДА${A.reset}   ${A.rbold}✕${A.reset} ${A.white}НЕТ${A.reset}   ${A.pink}○${A.reset} ${A.white}Отсутствует${A.reset}   ${A.gray}·${A.reset} ${A.white}не проверено${A.reset}`);
  return lines.join("\n");
}

function buildComparison(currentStats, prevStats){
  if(!prevStats) return null;
  const diff = (a,b) => {
    const d = (a||0) - (b||0);
    if(d === 0) return `${A.gray}(без изменений)${A.reset}`;
    if(d > 0) return `${A.gbold}▲ +${d}${A.reset}`;
    return `${A.rbold}▼ ${d}${A.reset}`;
  };
  const totals = currentStats.totals || {};
  const pTotals = prevStats.totals || {};
  const lines = [];
  lines.push(`${A.gold}▍${A.reset} ${A.wbold}СРАВНЕНИЕ С ПРЕДЫДУЩИМ ОТЧЁТОМ${A.reset}`);
  lines.push(A.yellow + "─".repeat(52) + A.reset);
  lines.push(`${A.white}Проверено полностью:${A.reset}  ${A.gbold}${pad(String(currentStats.checked||0),4,true)}${A.reset}  ${diff(currentStats.checked, prevStats.checked)}`);
  lines.push(`${A.white}Частично проверено: ${A.reset}  ${A.ybold}${pad(String(currentStats.partial||0),4,true)}${A.reset}  ${diff(currentStats.partial, prevStats.partial)}`);
  lines.push(`${A.white}Не проверено:       ${A.reset}  ${A.rbold}${pad(String(currentStats.unchecked||0),4,true)}${A.reset}  ${diff(currentStats.unchecked, prevStats.unchecked)}`);
  lines.push("");
  lines.push(`${A.wbold}По типам документов (кол-во «ДА»):${A.reset}`);
  for(const c of COLS){
    const cur = (totals[c.key] && totals[c.key].yes) || 0;
    const prev = (pTotals[c.key] && pTotals[c.key].yes) || 0;
    lines.push(`  ${A.white}${pad(c.label, 10)}${A.reset}  ${A.gbold}${pad(String(cur), 4, true)}${A.reset}  ${diff(cur, prev)}`);
  }
  return lines.join("\n");
}

function buildDeptStats(rawSnapshot){
  const snapshot = normalizeSnapshot(rawSnapshot);
  const groups = snapshot.groups || [];
  const lines = [];
  lines.push(`${A.gold}▍${A.reset} ${A.wbold}СВОДКА ПО ОТДЕЛАМ${A.reset}`);
  lines.push(A.yellow + "─".repeat(52) + A.reset);
  lines.push(`${A.wbold}${pad("Отдел", 26)} ${pad("Люди", 6, true)} ${pad("Полн.", 7, true)} ${pad("%", 6, true)}${A.reset}`);
  lines.push(A.yellow + "─".repeat(52) + A.reset);
  for(const g of groups){
    const list = g.list || [];
    let full = 0;
    for(const m of list){
      const set = COLS.filter(c => m[c.key] != null).length;
      if(set === COLS.length) full++;
    }
    const pct = list.length ? Math.round(full*100/list.length) : 0;
    const clr = pct === 100 ? A.gbold : pct >= 50 ? A.ybold : A.rbold;
    lines.push(`${A.white}${pad(truncate(g.name, 26), 26)}${A.reset} ${A.cyan}${pad(String(list.length), 6, true)}${A.reset} ${clr}${pad(String(full), 7, true)}${A.reset} ${clr}${pad(pct+"%", 6, true)}${A.reset}`);
  }
  return lines.join("\n");
}

function normalizeMember(m){
  if(!m) return m;
  const hasNo = COLS.some(c => m[c.key] === "no");
  const hasProof = !!(m.evidence_url && String(m.evidence_url).trim());
  if(hasNo && !hasProof){
    const out = Object.assign({}, m);
    for(const c of COLS){ if(out[c.key] === "no") out[c.key] = null; }
    return out;
  }
  return m;
}
function normalizeSnapshot(snapshot){
  if(!snapshot || !snapshot.groups) return snapshot;
  return {
    ...snapshot,
    groups: snapshot.groups.map(g => ({
      ...g,
      list: (g.list||[]).map(normalizeMember)
    }))
  };
}

function calcTotals(rawSnapshot){
  const snapshot = normalizeSnapshot(rawSnapshot);
  const groups = snapshot.groups || [];
  const totals = {};
  for(const c of COLS) totals[c.key] = { yes: 0, no: 0, absent: 0, none: 0 };
  let checked = 0, partial = 0, unchecked = 0, all = 0;
  for(const g of groups){
    for(const m of (g.list||[])){
      all++;
      let set = 0;
      for(const c of COLS){
        const v = m[c.key] || null;
        if(v === "yes"){ totals[c.key].yes++; set++ }
        else if(v === "no"){ totals[c.key].no++; set++ }
        else if(v === "absent"){ totals[c.key].absent++; set++ }
        else totals[c.key].none++;
      }
      if(set === COLS.length) checked++;
      else if(set > 0) partial++;
      else unchecked++;
    }
  }
  return { totals, checked, partial, unchecked, total: all };
}

async function loadPrevArchive(database, archive){
  try{
    // id — uuid (сортировать нельзя), берём предыдущий по дате сохранения
    const { data } = await database.from("vp_archive")
      .select("stats, saved_at, title")
      .lt("saved_at", archive.saved_at)
      .order("saved_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return data;
  }catch(e){ return null }
}

function buildHeaderEmbed(archive, prevArchive){
  const header = [
    "```ansi",
    `${A.gold}╔══════════════════════════════════════════════╗${A.reset}`,
    `${A.gold}║${A.reset}  ${A.wbold}МИНИСТЕРСТВО ЗДРАВООХРАНЕНИЯ${A.reset}               ${A.gold}║${A.reset}`,
    `${A.gold}║${A.reset}  ${A.wbold}  ЦГБ №3 · Центральная Городская Больница${A.reset}  ${A.gold}║${A.reset}`,
    `${A.gold}╠══════════════════════════════════════════════╣${A.reset}`,
    `${A.gold}║${A.reset}  ${A.ybold}СЛУЖЕБНЫЙ ДОКУМЕНТ · АДМИНИСТРАЦИЯ БОЛЬНИЦЫ${A.reset}  ${A.gold}║${A.reset}`,
    `${A.gold}║${A.reset}  ${A.white}Отчёт о проверках сотрудников${A.reset}                ${A.gold}║${A.reset}`,
    `${A.gold}╚══════════════════════════════════════════════╝${A.reset}`,
    "```"
  ].join("\n");

  const embed = new EmbedBuilder()
    .setColor(0x3a7d6b)
    .setAuthor({ name: "МИНЗДРАВ · ЦГБ №3" })
    .setTitle("📋   ОФИЦИАЛЬНЫЙ ОТЧЁТ О ПРОВЕРКАХ СОТРУДНИКОВ")
    .setDescription(header)
    .setTimestamp(new Date(archive.saved_at))
    .setFooter({ text: `Служебный документ · ЦГБ №3 · Отправил: ${archive.report_sent_by_name || archive.saved_by_name || "—"}` });

  const fields = [];
  fields.push({ name: "📅  Период проверки", value: archive.period_from && archive.period_to ? `**${ruDate(archive.period_from)}** — **${ruDate(archive.period_to)}**` : `**${ruDate(archive.saved_at)}**`, inline: true });
  fields.push({ name: "✍️  Оформил протокол", value: `**${archive.saved_by_name || "—"}**`, inline: true });
  fields.push({ name: "🗂  Номер записи", value: `**#${archive.id}**`, inline: true });
  fields.push({ name: "👥  Всего в списке", value: `**${archive.members_total || 0}** чел.`, inline: true });
  fields.push({ name: "✅  Проверено полностью", value: `**${archive.members_checked || 0}** чел.`, inline: true });
  fields.push({ name: "⏳  Частично проверено", value: `**${archive.members_partial || 0}** чел.`, inline: true });
  if(prevArchive){
    fields.push({ name: "🔄  Сравнение", value: `Данные сопоставлены с предыдущим отчётом от **${ruDate(prevArchive.saved_at)}**${prevArchive.title?` («${prevArchive.title}»)`:""}`, inline: false });
  }
  embed.addFields(fields);
  return embed;
}

function chunkCodeBlocks(bigText, maxLen){
  const max = maxLen || 1900;
  const chunks = [];
  const rawLines = bigText.split("\n");
  const lines = [];
  for(const l of rawLines){
    if(l.length <= max) { lines.push(l); continue; }
    for(let i=0; i<l.length; i+=max) lines.push(l.slice(i, i+max));
  }
  let cur = [];
  let curLen = 0;
  for(const line of lines){
    if(curLen + line.length + 1 > max){
      if(cur.length) chunks.push(cur.join("\n"));
      cur = [line];
      curLen = line.length + 1;
    } else {
      cur.push(line);
      curLen += line.length + 1;
    }
  }
  if(cur.length) chunks.push(cur.join("\n"));
  return chunks;
}

async function sendReport(database, client, archiveId, channelId, log){
  try{
    const { data: archive, error: aErr } = await database.from("vp_archive").select("*").eq("id", archiveId).maybeSingle();
    if(aErr || !archive) throw new Error("archive not found: " + (aErr && aErr.message));

    const ch = await client.channels.fetch(channelId);
    if(!ch || !ch.isTextBased()) throw new Error("channel not found or not text");

    const snapshot = archive.snapshot || {};
    const stats = archive.stats || calcTotals(snapshot);
    const prev = await loadPrevArchive(database, archive);

    const header = buildHeaderEmbed(archive, prev);
    const deptStats = buildDeptStats(snapshot);
    const legend = buildLegend();
    const comparison = buildComparison(stats, prev ? prev.stats : null);
    const tables = buildDeptTables(snapshot);

    await ch.send({ embeds: [header], allowedMentions: { parse: [] } });

    const introFull = deptStats + "\n\n" + legend + (comparison ? "\n\n" + comparison : "");
    for(const c of chunkCodeBlocks(introFull)){
      await ch.send({ content: "```ansi\n" + c + "\n```", allowedMentions: { parse: [] } });
    }

    for(const tbl of tables){
      const parts = chunkCodeBlocks(tbl);
      for(const p of parts){
        await ch.send({ content: "```ansi\n" + p + "\n```", allowedMentions: { parse: [] } });
      }
    }

    const closer = new EmbedBuilder()
      .setColor(0x2a4838)
      .setTitle("📜  ПОДПИСЬ И ЗАВЕРЕНИЕ")
      .setDescription([
        `✒️  **Подписал:**  ${archive.report_sent_by_name || archive.saved_by_name || "—"}`,
        `👤  **Оформил протокол:**  ${archive.saved_by_name || "—"}`,
        `📅  **Дата отправки:**  ${ru(new Date())}`,
        `📅  **Дата составления:**  ${ru(archive.saved_at)}`,
        `🗂  **Архивный номер:**  \`#${archive.id}\``,
        ``,
        `_Документ сгенерирован автоматически системой проверок Администрации Больницы._`
      ].join("\n"))
      .setFooter({ text: "ЦГБ №3 · Минздрав · Служебное" });
    const sent = await ch.send({ embeds: [closer], allowedMentions: { parse: [] } });

    await database.from("vp_archive").update({
      report_channel_id: channelId,
      report_message_id: sent.id,
      report_sent_at: new Date().toISOString()
    }).eq("id", archiveId);

    log("AB-REPORT sent archive#" + archiveId + " → channel " + channelId);
    return { ok: true, message_id: sent.id };
  }catch(e){
    log("AB-REPORT err:", e.message);
    return { ok: false, error: e.message };
  }
}

function setupReport({ client, database, log }){
  function subscribe(){
    database.channel("vp-report-queue")
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "vp_report_requests" },
        async (payload) => {
          const req = payload.new;
          if(!req || req.status !== "pending") return;
          log("AB-REPORT request id=" + req.id + " archive=" + req.archive_id);
          await database.from("vp_report_requests").update({ status: "sending" }).eq("id", req.id);
          const r = await sendReport(database, client, req.archive_id, req.channel_id, log);
          if(r.ok){
            await database.from("vp_report_requests").update({
              status: "sent",
              sent_message_id: r.message_id,
              sent_at: new Date().toISOString()
            }).eq("id", req.id);
            await database.from("vp_archive").update({
              report_sent_by: req.requested_by,
              report_sent_by_name: req.requested_by_name
            }).eq("id", req.archive_id);
          } else {
            await database.from("vp_report_requests").update({
              status: "error", message: r.error, sent_at: new Date().toISOString()
            }).eq("id", req.id);
          }
        })
      .subscribe((s) => log("AB-REPORT realtime:", s));
  }
  return { subscribe };
}

module.exports = { setupReport, calcTotals };
