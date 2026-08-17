"use strict";

require("dotenv").config();
const crypto=require("crypto");
const fs=require("fs");
const path=require("path");
const express=require("express");
const helmet=require("helmet");
const {rateLimit}=require("express-rate-limit");
const bcrypt=require("bcryptjs");
const jwt=require("jsonwebtoken");
const {Pool}=require("pg");
const {compile,ident}=require("./query");

const REQUIRED=["DATABASE_URL","JWT_SECRET","PUBLIC_ORIGIN","STORAGE_ROOT"];
const missing=REQUIRED.filter(key=>!process.env[key]);
if(missing.length) throw new Error("Missing environment variables: "+missing.join(", "));
if(process.env.JWT_SECRET.length<48) throw new Error("JWT_SECRET must contain at least 48 characters");

const PORT=Number(process.env.PORT||8787);
const ORIGINS=new Set(process.env.PUBLIC_ORIGIN.split(",").map(value=>value.trim().replace(/\/$/,"")).filter(Boolean));
const STORAGE_ROOT=path.resolve(process.env.STORAGE_ROOT);
const sslMode=String(process.env.PGSSL||"").toLowerCase();
const pool=new Pool({
  connectionString:process.env.DATABASE_URL,
  ssl:sslMode&&sslMode!=="disable"?{rejectUnauthorized:sslMode!=="no-verify"}:undefined,
  max:Number(process.env.PGPOOL_MAX||15),
  idleTimeoutMillis:30000,
  connectionTimeoutMillis:10000
});

const TABLES=new Set([
  "applications","apps_settings","bot_messages","bot_status","complaint_form","complaint_history","complaints",
  "composition","custom_roles","ds_channels","ds_guild_roles","ds_members","ds_roles","ds_sync_requests","faq",
  "holiday_state","info_page","learn_materials","news","payroll_archive","payroll_drafts","payroll_send_requests",
  "payroll_settings","raids_events","raids_settings","report_forms","report_send_requests","request_forms","requests",
  "requests_settings","site_data","supply_entries","supply_form","supply_requests","supply_rescan_requests",
  "telegram_bot_status","telegram_notifications","telegram_settings","telegram_topics","test_attempts","test_blocks",
  "test_categories","test_ping_lines","test_questions","test_result_requests","tests","train_categories","train_lessons",
  "user_roles","ustavy","vehicles","violations_history","violations_registry","violations_settings","vp_archive",
  "vp_checks","vp_report_requests","vp_reports","vp_request_forms","vp_role_mapping","vp_settings"
]);
const PUBLIC_READ=new Set([
  "apps_settings","bot_status","complaint_form","composition","ds_channels","ds_guild_roles","ds_members","ds_roles",
  "faq","holiday_state","info_page","learn_materials","news","request_forms","requests_settings","site_data",
  "supply_form","test_categories","test_ping_lines","test_questions","tests","train_categories","train_lessons","ustavy",
  "vehicles","vp_request_forms"
]);
const ADMIN_TABLES=new Set(["user_roles","custom_roles"]);
const DEFAULT_CONFLICTS=Object.freeze({
  complaint_form:"id",faq:"id",holiday_state:"id",learn_materials:"id",info_page:"id",
  payroll_settings:"id",request_forms:"id",requests_settings:"id",violations_settings:"id",
  test_categories:"id",tests:"id",test_questions:"id",test_ping_lines:"id"
});
const RPC_SET=new Set(["get_complaint_form","submit_complaint","submit_request","get_supply_form"]);
const RPC_SCALAR=new Set([
  "staff_upsert_role","submit_supply_request","count_test_attempts","check_test_blocked","submit_test_attempt",
  "request_test_result","ensure_payroll_draft","archive_payroll_draft"
]);
const RPC_PUBLIC=new Set([
  "get_complaint_form","submit_complaint","submit_request","get_supply_form","submit_supply_request",
  "count_test_attempts","check_test_blocked","submit_test_attempt"
]);
const STORAGE_BUCKETS=new Set(["composition-photos","autopark-photos"]);
const IMAGE_TYPES=new Set(["image/jpeg","image/png","image/webp","image/gif"]);
const IMAGE_EXTENSIONS=new Set([".jpg",".jpeg",".png",".webp",".gif"]);

function apiError(status,message,code="API_ERROR"){
  const error=new Error(message);error.status=status;error.code=code;return error;
}
function safeUser(row){
  return {id:row.id,email:row.email,user_metadata:row.user_metadata||{},created_at:row.created_at,last_sign_in_at:row.last_sign_in_at};
}
function tokenFor(user){
  return jwt.sign({sub:user.id,email:user.email,type:"access"},process.env.JWT_SECRET,{expiresIn:process.env.JWT_TTL||"8h",issuer:"cgb-postgres-api",audience:"cgb-site"});
}
function refreshHash(token){return crypto.createHash("sha256").update(String(token||"")).digest("hex");}
async function issueRefresh(client,user,req){
  const token=crypto.randomBytes(48).toString("base64url");
  const days=Math.max(1,Math.min(180,Number(process.env.REFRESH_DAYS||30)));
  await client.query("insert into public.refresh_tokens(user_id,token_hash,expires_at,user_agent,ip) values($1,$2,now()+make_interval(days=>$3::int),$4,$5)",[
    user.id,refreshHash(token),String(days),String(req.headers["user-agent"]||"").slice(0,500)||null,req.ip||null
  ]);
  return token;
}
function parseToken(req){
  const match=String(req.headers.authorization||"").match(/^Bearer\s+(.+)$/i);
  if(!match) return null;
  try{return jwt.verify(match[1],process.env.JWT_SECRET,{issuer:"cgb-postgres-api",audience:"cgb-site"});}
  catch(_){return null;}
}
async function loadUser(req){
  const claims=parseToken(req);
  if(!claims||!claims.sub) return null;
  const {rows}=await pool.query("select * from public.users where id=$1 and disabled=false limit 1",[claims.sub]);
  return rows[0]||null;
}
async function roleFor(client,userId){
  if(!userId) return null;
  const {rows}=await client.query("select role,custom_role_id,display_name from public.user_roles where user_id=$1 limit 1",[userId]);
  return rows[0]||null;
}
async function requireUser(req){
  const user=req.user||await loadUser(req);
  if(!user) throw apiError(401,"Требуется авторизация","AUTH_REQUIRED");
  return user;
}
async function requireAdmin(req,client=pool){
  const user=await requireUser(req);
  const role=await roleFor(client,user.id);
  if(!role||role.role!=="admin") throw apiError(403,"Требуются права администратора","ADMIN_REQUIRED");
  return user;
}
async function requireSiteDataKeys(client,spec){
  const keys=new Set();
  const rows=Array.isArray(spec.body)?spec.body:[spec.body];
  for(const row of rows)if(row&&row.key)keys.add(String(row.key));
  for(const filter of spec.filters||[]){
    if(filter.column!=="key")continue;
    if(filter.op==="eq")keys.add(String(filter.value));
    if(filter.op==="in"&&Array.isArray(filter.value))filter.value.forEach(value=>keys.add(String(value)));
  }
  if(!keys.size) throw apiError(403,"Не указан разрешённый раздел сайта","SITE_DATA_KEY_REQUIRED");
  for(const key of keys){
    const {rows:allowed}=await client.query("select public.can_edit_site_data($1) allowed",[key]);
    if(!allowed[0]?.allowed) throw apiError(403,"Нет права редактировать этот раздел","SITE_DATA_FORBIDDEN");
  }
}
async function transaction(user,work){
  const client=await pool.connect();
  try{
    await client.query("begin");
    if(user) await client.query("select set_config('cgb.user_id',$1,true)",[user.id]);
    const result=await work(client);
    await client.query("commit");
    return result;
  }catch(error){
    await client.query("rollback").catch(()=>{});
    throw error;
  }finally{client.release();}
}

const app=express();
if(String(process.env.TRUST_PROXY||"").toLowerCase()==="true") app.set("trust proxy",1);
app.disable("x-powered-by");
app.use(helmet({crossOriginResourcePolicy:{policy:"cross-origin"}}));
app.use((req,res,next)=>{
  const origin=req.headers.origin;
  if(origin&&!ORIGINS.has(origin)) return res.status(403).json({error:{message:"Origin denied",code:"ORIGIN_DENIED"}});
  if(origin){res.setHeader("Access-Control-Allow-Origin",origin);res.setHeader("Vary","Origin");}
  res.setHeader("Access-Control-Allow-Headers","Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods","GET, POST, PATCH, DELETE, OPTIONS");
  if(req.method==="OPTIONS") return res.sendStatus(204);
  next();
});
app.use("/api/v1",express.json({limit:"8mb"}));
app.use(async(req,res,next)=>{try{req.user=await loadUser(req);next();}catch(error){next(error);}});

app.get("/api/v1/health",async(req,res,next)=>{
  try{const {rows}=await pool.query("select current_database() database, now() time");res.json({ok:true,database:rows[0].database,time:rows[0].time});}
  catch(error){next(error);}
});

const loginLimiter=rateLimit({windowMs:10*60*1000,limit:20,standardHeaders:true,legacyHeaders:false});
app.post("/api/v1/auth/login",loginLimiter,async(req,res,next)=>{
  try{
    const email=String(req.body?.email||"").trim().toLowerCase();
    const password=String(req.body?.password||"");
    if(!email||!password) throw apiError(400,"Введите почту и пароль","INVALID_CREDENTIALS");
    const {rows}=await pool.query("select * from public.users where lower(email)=$1 limit 1",[email]);
    const user=rows[0];
    if(!user||user.disabled||!user.password_hash||!(await bcrypt.compare(password,user.password_hash)))
      throw apiError(401,"Неверная почта или пароль","INVALID_CREDENTIALS");
    if(user.password_reset_required) throw apiError(403,"Администратор должен назначить новый пароль","PASSWORD_RESET_REQUIRED");
    const role=await roleFor(pool,user.id);
    if(!role) throw apiError(403,"Доступ к сайту отозван","ACCESS_REVOKED");
    await pool.query("update public.users set last_sign_in_at=now() where id=$1",[user.id]);
    const refresh_token=await transaction(null,client=>issueRefresh(client,user,req));
    const access_token=tokenFor(user);
    res.json({data:{user:safeUser(user),session:{access_token,refresh_token,token_type:"bearer",user:safeUser(user)}}});
  }catch(error){next(error);}
});

app.post("/api/v1/auth/refresh",async(req,res,next)=>{
  try{
    const oldToken=String(req.body?.refresh_token||"");
    if(!oldToken) throw apiError(401,"Сессия истекла","REFRESH_REQUIRED");
    const result=await transaction(null,async client=>{
      const {rows}=await client.query("select rt.id refresh_id,u.* from public.refresh_tokens rt join public.users u on u.id=rt.user_id where rt.token_hash=$1 and rt.revoked_at is null and rt.expires_at>now() and u.disabled=false limit 1",[refreshHash(oldToken)]);
      const user=rows[0];if(!user) throw apiError(401,"Сессия истекла","INVALID_REFRESH_TOKEN");
      const role=await roleFor(client,user.id);if(!role) throw apiError(403,"Доступ к сайту отозван","ACCESS_REVOKED");
      return {user,refresh_token:oldToken};
    });
    const access_token=tokenFor(result.user);
    res.json({data:{session:{access_token,refresh_token:result.refresh_token,token_type:"bearer",user:safeUser(result.user)}}});
  }catch(error){next(error);}
});

app.post("/api/v1/auth/logout",async(req,res,next)=>{
  try{
    const refreshToken=String(req.body?.refresh_token||"");
    if(refreshToken) await pool.query("update public.refresh_tokens set revoked_at=coalesce(revoked_at,now()) where token_hash=$1",[refreshHash(refreshToken)]);
    res.json({data:{ok:true}});
  }catch(error){next(error);}
});

app.get("/api/v1/auth/session",async(req,res)=>{
  if(!req.user) return res.json({data:{session:null}});
  res.json({data:{session:{access_token:null,token_type:"bearer",user:safeUser(req.user)}}});
});

app.patch("/api/v1/auth/user",async(req,res,next)=>{
  try{
    const user=await requireUser(req);
    const password=req.body?.password;
    const metadata=req.body?.data;
    if(password!==undefined){
      if(String(password).length<8) throw apiError(400,"Пароль должен содержать минимум 8 символов","WEAK_PASSWORD");
      const hash=await bcrypt.hash(String(password),12);
      await pool.query("update public.users set password_hash=$1,password_reset_required=false where id=$2",[hash,user.id]);
    }
    if(metadata!==undefined){
      await pool.query("update public.users set user_metadata=coalesce(user_metadata,'{}'::jsonb)||$1::jsonb where id=$2",[JSON.stringify(metadata||{}),user.id]);
    }
    const {rows}=await pool.query("select * from public.users where id=$1",[user.id]);
    res.json({data:{user:safeUser(rows[0])}});
  }catch(error){next(error);}
});

app.get("/api/v1/auth/admin/users",async(req,res,next)=>{
  try{await requireAdmin(req);const {rows}=await pool.query("select id,email,user_metadata,email_confirmed_at,password_reset_required,disabled,last_sign_in_at,created_at,updated_at from public.users order by created_at desc");res.json({data:{users:rows}});}catch(error){next(error);}
});
app.post("/api/v1/auth/admin/users",async(req,res,next)=>{
  try{
    await requireAdmin(req);
    const email=String(req.body?.email||"").trim().toLowerCase();
    const password=String(req.body?.password||"");
    const displayName=String(req.body?.display_name||"").trim()||null;
    const role=String(req.body?.role||"user");
    const customRoleId=req.body?.custom_role_id||null;
    if(!email||!email.includes("@")) throw apiError(400,"Некорректная почта","INVALID_EMAIL");
    if(password.length<8) throw apiError(400,"Пароль должен содержать минимум 8 символов","WEAK_PASSWORD");
    const hash=await bcrypt.hash(password,12);
    const result=await transaction(req.user,async client=>{
      const {rows}=await client.query("insert into public.users(email,password_hash,email_confirmed_at,password_reset_required,user_metadata) values($1,$2,now(),false,$3::jsonb) returning *",[email,hash,JSON.stringify({display_name:displayName||""})]);
      await client.query("select public.staff_upsert_role($1,$2,$3,$4)",[rows[0].id,role,displayName,customRoleId]);
      return rows[0];
    });
    res.status(201).json({data:{user:safeUser(result)}});
  }catch(error){next(error);}
});
app.delete("/api/v1/auth/admin/users/:id",async(req,res,next)=>{
  try{
    const admin=await requireAdmin(req);
    if(admin.id===req.params.id) throw apiError(400,"Нельзя удалить собственную учётную запись","SELF_DELETE");
    await transaction(admin,async client=>{await client.query("delete from public.user_roles where user_id=$1",[req.params.id]);await client.query("delete from public.users where id=$1",[req.params.id]);});
    res.json({data:{ok:true}});
  }catch(error){next(error);}
});

app.post("/api/v1/db/query",async(req,res,next)=>{
  try{
    const spec=req.body||{};
    if(!TABLES.has(spec.table)) throw apiError(404,"Таблица недоступна","TABLE_NOT_ALLOWED");
    const action=String(spec.action||"select");
    if(action==="select"){
      if(!PUBLIC_READ.has(spec.table)&&!req.user) throw apiError(401,"Требуется авторизация","AUTH_REQUIRED");
    }else{
      await requireUser(req);
      if(ADMIN_TABLES.has(spec.table)) await requireAdmin(req);
    }
    if(action==="upsert"&&!spec.onConflict&&DEFAULT_CONFLICTS[spec.table]) spec.onConflict=DEFAULT_CONFLICTS[spec.table];
    const compiled=compile(spec);
    const output=await transaction(req.user,async client=>{
      if(spec.table==="site_data"&&action!=="select") await requireSiteDataKeys(client,spec);
      const result=await client.query(compiled.text,compiled.values);
      let count=null;
      if(compiled.countText){const counted=await client.query(compiled.countText,compiled.countValues||compiled.values);count=counted.rows[0]?.count??0;}
      return {rows:result.rows,count};
    });
    res.json({data:spec.head?null:(spec.returning||action==="select"?output.rows:null),count:output.count,error:null});
  }catch(error){next(error);}
});

app.post("/api/v1/db/rpc/:name",async(req,res,next)=>{
  try{
    const name=String(req.params.name||"");
    if(!RPC_SET.has(name)&&!RPC_SCALAR.has(name)) throw apiError(404,"Функция недоступна","RPC_NOT_ALLOWED");
    if(!RPC_PUBLIC.has(name)) await requireUser(req);
    if(name==="staff_upsert_role") await requireAdmin(req);
    const args=req.body&&typeof req.body==="object"?req.body:{};
    const entries=Object.entries(args);
    const values=[];
    const named=entries.map(([key,value])=>{values.push(value);return `${ident(key,"argument")} => $${values.length}`;}).join(",");
    const sql=RPC_SET.has(name)?`select * from public.${ident(name)}(${named})`:`select public.${ident(name)}(${named}) as value`;
    const data=await transaction(req.user,async client=>{
      const {rows}=await client.query(sql,values);
      return RPC_SET.has(name)?rows:(rows[0]?.value??null);
    });
    res.json({data,error:null});
  }catch(error){next(error);}
});

function storagePath(bucket,objectPath){
  if(!STORAGE_BUCKETS.has(String(bucket||""))) throw apiError(404,"Хранилище недоступно","BUCKET_NOT_ALLOWED");
  if(!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(bucket)) throw apiError(400,"Некорректный бакет","BAD_BUCKET");
  const clean=String(objectPath||"").replace(/\\/g,"/").replace(/^\/+/,"");
  if(!clean||clean.split("/").some(part=>!part||part==="."||part==="..")) throw apiError(400,"Некорректный путь","BAD_PATH");
  const full=path.resolve(STORAGE_ROOT,bucket,...clean.split("/"));
  const root=path.resolve(STORAGE_ROOT,bucket)+path.sep;
  if(!full.startsWith(root)) throw apiError(400,"Некорректный путь","BAD_PATH");
  return {full,clean};
}
app.use("/media",express.static(STORAGE_ROOT,{fallthrough:false,maxAge:"30d",immutable:true,index:false}));
app.put("/api/v1/storage/:bucket/*object",express.raw({type:"*/*",limit:"25mb"}),async(req,res,next)=>{
  try{
    await requireUser(req);
    const objectPath=Array.isArray(req.params.object)?req.params.object.join("/"):req.params.object;
    const target=storagePath(req.params.bucket,objectPath);
    const contentType=String(req.headers["content-type"]||"").split(";",1)[0].trim().toLowerCase();
    if(!IMAGE_TYPES.has(contentType)||!IMAGE_EXTENSIONS.has(path.extname(target.clean).toLowerCase()))
      throw apiError(415,"Разрешены только JPG, PNG, WebP и GIF","UNSUPPORTED_FILE_TYPE");
    await fs.promises.mkdir(path.dirname(target.full),{recursive:true});
    const exists=await fs.promises.access(target.full).then(()=>true).catch(()=>false);
    if(exists&&String(req.query.upsert||"")!=="true") throw apiError(409,"Файл уже существует","FILE_EXISTS");
    const temp=target.full+`.tmp-${process.pid}-${crypto.randomBytes(5).toString("hex")}`;
    await fs.promises.writeFile(temp,req.body);
    await fs.promises.rename(temp,target.full);
    res.status(201).json({data:{path:target.clean}});
  }catch(error){next(error);}
});
app.delete("/api/v1/storage/:bucket",async(req,res,next)=>{
  try{
    await requireUser(req);
    const paths=Array.isArray(req.body?.paths)?req.body.paths:[];
    for(const item of paths){const target=storagePath(req.params.bucket,item);await fs.promises.rm(target.full,{force:true});}
    res.json({data:paths.map(name=>({name}))});
  }catch(error){next(error);}
});

app.use((error,req,res,next)=>{
  const status=Number(error.status)||(/duplicate key/i.test(error.message||"")?409:500);
  const code=error.code||"INTERNAL_ERROR";
  if(status>=500) console.error(new Date().toISOString(),req.method,req.originalUrl,error);
  res.status(status).json({data:null,error:{message:status>=500?"Внутренняя ошибка сервера":error.message,code,details:status>=500?undefined:error.detail}});
});

async function start(){
  await pool.query("select 1");
  await pool.query("delete from public.refresh_tokens where expires_at<now()-interval '7 days' or revoked_at<now()-interval '7 days'");
  await fs.promises.mkdir(STORAGE_ROOT,{recursive:true});
  app.listen(PORT,"127.0.0.1",()=>console.log(`[CGB API] listening on 127.0.0.1:${PORT}`));
}
start().catch(error=>{console.error("[CGB API] startup failed",error);process.exit(1);});
