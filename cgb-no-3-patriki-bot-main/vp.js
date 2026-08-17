/* Синхронизация состава Discord-гильдии → PostgreSQL (ds_members / ds_roles).
 *
 * ФОРМАТ НИКА НА СЕРВЕРЕ:   Должность | ФИО | Статик
 *   пример: «Фел | Иванов Иван Иванович | 355-221»
 *   пример: «Зам.зав.(Хирургия) | Петров П.П. | 123-456»
 *
 * Должность пишется сокращённо. Известные сокращения (регистр не важен):
 *   Зам.зав.(Отдел)  Зав.(Отдел)  ГВ.  ЗГВ.  Асс.(Отдел)  ВВК  В1К  В2К
 *   Орд2г  Орд1г  Фел  Сан  Фарм  ВСП
 * Статик — 4–7 цифр (можно с дефисом или «№»): 355221 / 355-221 / №355-221.
 *
 * Таблицы могли быть созданы ранее без части колонок — поэтому все записи
 * идут через safeUpsert/safeUpdate: если база отвечает «Could not find
 * the 'X' column», запись автоматически повторяется без этой колонки.
 * Для полного набора данных примените postgres-migration/01-schema.sql.
 */

// ---------- парсер ника ----------
const POS_ROOTS = [
  "замзав", "орд2г", "орд1г", "згв", "ввк", "в1к", "в2к", "фарм", "всп",
  "асс", "зав", "орд", "фел", "сан", "гв",
  "заместитель", "заведующ", "главврач", "ассистент", "ординатор",
  "фельдшер", "санитар", "фармацевт"
];
function looksLikePosition(p) {
  const t = String(p || "").toLowerCase().replace(/[\s.]+/g, "");
  if (!t) return false;
  return POS_ROOTS.some(r => t.startsWith(r));
}
function staticOf(p) {
  const d = String(p || "").replace(/\D/g, "");
  return (d.length >= 4 && d.length <= 7) ? p.trim().replace(/^[\s№#]+/,"") : null;
}

/**
 * «Должность | ФИО | Статик» → { dept, rank, fio }
 * (имена полей исторические: dept = Должность, rank = Статик, fio = ФИО)
 */
function parseNick(rawName) {
  const s = String(rawName || "").trim();
  if (!s) return { dept: null, rank: null, fio: null };
  const parts = s.split("|").map(p => p.trim()).filter(Boolean);
  if (parts.length === 1) {
    return { dept: null, rank: staticOf(s), fio: s };
  }
  // 1) статик — часть из 4–7 цифр (где бы ни стояла)
  let statik = null, rest = parts;
  const si = parts.findIndex(p => staticOf(p));
  if (si >= 0) { statik = staticOf(parts[si]); rest = parts.filter((_, i) => i !== si); }
  // 2) должность — первая часть (по регламенту), но если похожа на должность
  //    только вторая — меняем местами
  let pos = null, fio = null;
  if (rest.length >= 2) {
    if (looksLikePosition(rest[0]) || !looksLikePosition(rest[1])) {
      pos = rest[0]; fio = rest.slice(1).join(" | ");
    } else {
      fio = rest[0]; pos = rest.slice(1).join(" | ");
    }
  } else if (rest.length === 1) {
    if (looksLikePosition(rest[0])) pos = rest[0]; else fio = rest[0];
  }
  return { dept: pos, rank: statik, fio: fio || null };
}

// ---------- безопасные запись/обновление (пропускаем отсутствующие колонки) ----------
function missingColumn(errMsg) {
  const text=String(errMsg || "");
  const m = /Could not find the '([^']+)' column/.exec(text) || /column "([^"]+)"(?: of relation "[^"]+")? does not exist/i.exec(text);
  return m ? m[1] : null;
}

async function safeUpsert(database, table, rows, onConflict, log) {
  let attempt = rows;
  for (let i = 0; i < 8; i++) {
    const { error } = await database.from(table).upsert(attempt, { onConflict });
    if (!error) return { ok: true };
    const col = missingColumn(error.message);
    if (!col) {
      log(table + " upsert err:", error.message);
      return { ok: false, error: error.message };
    }
    log(table + " upsert: в таблице нет колонки «" + col + "» — повтор без неё (примените актуальный 01-schema.sql)");
    attempt = attempt.map(r => { const c = Object.assign({}, r); delete c[col]; return c; });
  }
  return { ok: false, error: "too many retries" };
}

async function safeUpdate(database, table, patch, buildQuery, log) {
  let attempt = patch;
  for (let i = 0; i < 8; i++) {
    const { error } = await buildQuery(database.from(table).update(attempt));
    if (!error) return { ok: true };
    const col = missingColumn(error.message);
    if (!col) {
      log(table + " update err:", error.message);
      return { ok: false, error: error.message };
    }
    log(table + " update: в таблице нет колонки «" + col + "» — повтор без неё");
    attempt = Object.assign({}, attempt); delete attempt[col];
  }
  return { ok: false, error: "too many retries" };
}

// ---------- маппинг ----------
function memberToRow(m) {
  const nick = m.nickname || m.displayName || (m.user && (m.user.globalName || m.user.username)) || "";
  const parsed = parseNick(nick);
  const roleIds = [];
  const roleNames = [];
  if (m.roles && m.roles.cache) {
    for (const r of m.roles.cache.values()) {
      if (r.name === "@everyone") continue;
      roleIds.push(r.id);
      roleNames.push(r.name);
    }
  }
  return {
    discord_id: m.id,
    username: m.user ? m.user.username : null,
    global_name: m.user ? (m.user.globalName || null) : null,
    display_name: m.displayName || null,
    raw_nick: nick,
    parsed_dept: parsed.dept,   // Должность
    parsed_fio: parsed.fio,     // ФИО
    parsed_static: parsed.rank, // Статик
    avatar_url: m.user && m.user.displayAvatarURL ? m.user.displayAvatarURL({ size: 128, extension: "png" }) : null,
    role_ids: roleIds,
    role_names: roleNames,
    is_bot: !!(m.user && m.user.bot),
    joined_at: m.joinedAt ? m.joinedAt.toISOString() : null,
    last_seen: new Date().toISOString(),
    active: true,
    updated_at: new Date().toISOString()
  };
}

async function syncAllRoles(database, guild, log) {
  const roles = await guild.roles.fetch();
  const rows = [];
  const activeIds = [];
  for (const r of roles.values()) {
    if (r.name === "@everyone") continue;
    rows.push({
      role_id: r.id,
      name: r.name,
      color: r.color || 0,
      position: r.position || 0,
      updated_at: new Date().toISOString()
    });
    activeIds.push(r.id);
  }
  if (!rows.length) return 0;
  const res = await safeUpsert(database, "ds_roles", rows, "role_id", log);

  // удаляем роли, которых уже нет на сервере
  if (activeIds.length) {
    try {
      const { data: existing } = await database.from("ds_roles").select("role_id");
      if (existing) {
        const stale = existing.map(r => r.role_id).filter(id => !activeIds.includes(id));
        if (stale.length) {
          const { error: delErr } = await database.from("ds_roles").delete().in("role_id", stale);
          if (delErr) log("ROLES stale delete err:", delErr.message);
          else log("ROLES: removed", stale.length, "stale");
        }
      }
    } catch (e) { log("ROLES stale check err:", e.message); }
  }
  return res.ok ? rows.length : 0;
}

async function syncAllMembers(database, guild, log) {
  log("VP-SYNC: fetching members...");
  const members = await guild.members.fetch();
  log("VP-SYNC: got", members.size, "members");

  const rows = [];
  const activeIds = [];
  for (const m of members.values()) {
    if (m.user && m.user.bot) continue;
    rows.push(memberToRow(m));
    activeIds.push(m.id);
  }

  const chunkSize = 200;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const res = await safeUpsert(database, "ds_members", chunk, "discord_id", log);
    if (!res.ok) throw new Error(res.error || "upsert failed");
  }

  if (activeIds.length) {
    await safeUpdate(
      database, "ds_members",
      { active: false, updated_at: new Date().toISOString() },
      q => q.not("discord_id", "in", "(" + activeIds.map(id => `"${id}"`).join(",") + ")"),
      log
    );
  }

  log("VP-SYNC: done,", rows.length, "members upserted");
  return rows.length;
}

async function syncOneMember(database, member, log) {
  if (!member || (member.user && member.user.bot)) return;
  const row = memberToRow(member);
  await safeUpsert(database, "ds_members", [row], "discord_id", log);
}

async function markMemberInactive(database, memberId, log) {
  await safeUpdate(
    database, "ds_members",
    { active: false, updated_at: new Date().toISOString() },
    q => q.eq("discord_id", memberId),
    log
  );
}

function setupVP({ client, database, guildId, log }) {
  async function getGuild() {
    try {
      const g = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId);
      return g;
    } catch (e) {
      log("VP get guild err:", e.message);
      return null;
    }
  }

  async function fullSync(reason) {
    const guild = await getGuild();
    if (!guild) return { ok: false, error: "guild not found" };
    try {
      log("VP-SYNC start (" + (reason || "manual") + ")");
      await syncAllRoles(database, guild, log);
      const n = await syncAllMembers(database, guild, log);
      return { ok: true, count: n };
    } catch (e) {
      log("VP-SYNC fail:", e.message);
      return { ok: false, error: e.message };
    }
  }

  async function initialSync() {
    return fullSync("startup");
  }

  function scheduleInterval(minutes) {
    const ms = Math.max(1, minutes) * 60 * 1000;
    setInterval(() => { fullSync("interval").catch(() => {}); }, ms);
  }

  // ---------- heartbeat: значок «бот онлайн» на сайте ----------
  async function pingHeartbeat() {
    try {
      const g = client.guilds.cache.get(guildId);
      const patch = {
        id: 1,
        online: true,
        last_seen: new Date().toISOString(),
        version: "cgb-v7",
        guild_name: g ? g.name : null,
        members_count: g ? g.memberCount : null,
        channels_count: g ? g.channels.cache.size : null,
        updated_at: new Date().toISOString()
      };
      await safeUpsert(database, "bot_status", [patch], "id", log);
    } catch (e) { log("HEARTBEAT err:", e.message); }
  }
  function startHeartbeat() {
    pingHeartbeat();
    setInterval(pingHeartbeat, 25000);
  }

  function subscribeSyncRequests() {
    const channel = database.channel("ds-sync-req")
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "ds_sync_requests" },
        async (payload) => {
          const req = payload.new;
          if (!req || req.status !== "pending") return;
          log("VP-SYNC request from site id=" + req.id);
          await safeUpdate(database, "ds_sync_requests", { status: "running" }, q => q.eq("id", req.id), log);
          const r = await fullSync("site-button");
          await safeUpdate(database, "ds_sync_requests", {
            status: r.ok ? "done" : "error",
            message: r.ok ? "OK" : r.error,
            members_scanned: r.count || null,
            finished_at: new Date().toISOString()
          }, q => q.eq("id", req.id), log);
        })
      .subscribe((status) => {
        log("VP-SYNC-REQ realtime:", status);
      });
    return channel;
  }

  client.on("guildMemberAdd", async (m) => {
    if (m.guild.id !== guildId) return;
    await syncOneMember(database, m, log);
  });
  client.on("guildMemberRemove", async (m) => {
    if (m.guild.id !== guildId) return;
    await markMemberInactive(database, m.id, log);
  });
  client.on("guildMemberUpdate", async (oldM, newM) => {
    if (newM.guild.id !== guildId) return;
    await syncOneMember(database, newM, log);
  });
  client.on("roleCreate", async (r) => {
    if (r.guild.id !== guildId) return;
    await safeUpsert(database, "ds_roles", [{
      role_id: r.id, name: r.name, color: r.color || 0, position: r.position || 0,
      updated_at: new Date().toISOString()
    }], "role_id", log);
  });
  client.on("roleUpdate", async (oldR, newR) => {
    if (newR.guild.id !== guildId) return;
    await safeUpsert(database, "ds_roles", [{
      role_id: newR.id, name: newR.name, color: newR.color || 0, position: newR.position || 0,
      updated_at: new Date().toISOString()
    }], "role_id", log);
  });
  client.on("roleDelete", async (r) => {
    if (r.guild.id !== guildId) return;
    await database.from("ds_roles").delete().eq("role_id", r.id);
    await database.from("vp_role_mapping").delete().eq("role_id", r.id);
  });

  return { fullSync, initialSync, scheduleInterval, subscribeSyncRequests, startHeartbeat };
}

module.exports = { setupVP, parseNick };
