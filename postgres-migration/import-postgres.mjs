import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import {TABLES,PRIMARY_KEYS,IDENTITY_TABLES} from "./metadata.mjs";

const databaseUrl=process.env.DATABASE_URL;
if(!databaseUrl)throw new Error("Set DATABASE_URL");
const sslMode=String(process.env.PGSSL||"require").toLowerCase();
const pool=new pg.Pool({connectionString:databaseUrl,ssl:sslMode==="disable"?undefined:{rejectUnauthorized:sslMode!=="no-verify"}});
const root=path.resolve(process.env.EXPORT_DIR||"./export");
const qid=value=>'"'+String(value).replaceAll('"','""')+'"';

function rewriteStorageLinks(value){
  if(Array.isArray(value))return value.map(rewriteStorageLinks);
  if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,rewriteStorageLinks(item)]));
  if(typeof value!=="string")return value;
  const match=value.match(/^https:\/\/[^/]+\/storage\/v1\/object\/(?:public|authenticated)\/([^/]+)\/(.+)$/i);
  return match?`/media/${match[1]}/${match[2]}`:value;
}

async function upsertRows(client,table,rows){
  if(!rows.length)return;
  const pk=PRIMARY_KEYS[table]||[];
  for(let i=0;i<rows.length;i+=250){
    const batch=rows.slice(i,i+250).map(rewriteStorageLinks),columns=[...new Set(batch.flatMap(row=>Object.keys(row)))],values=[];
    const tuples=batch.map(row=>'('+columns.map(column=>{values.push(row[column]===undefined?null:row[column]);return `$${values.length}`;}).join(',')+')');
    let sql=`insert into public.${qid(table)} (${columns.map(qid).join(',')}) `;
    if(IDENTITY_TABLES.has(table))sql+='overriding system value ';
    sql+=`values ${tuples.join(',')}`;
    if(pk.length){const updates=columns.filter(column=>!pk.includes(column));sql+=` on conflict (${pk.map(qid).join(',')}) `+(updates.length?`do update set ${updates.map(c=>`${qid(c)}=excluded.${qid(c)}`).join(',')}`:'do nothing');}
    else sql+=' on conflict do nothing';
    await client.query(sql,values);
  }
}
async function readJson(file,fallback=[]){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return fallback;throw error;}}

const client=await pool.connect();
try{
  if(String(process.env.APPLY_SCHEMA||"true").toLowerCase()==="true"){
    const schema=await fs.readFile(new URL("./01-schema.sql",import.meta.url),"utf8");await client.query(schema);console.log("Schema applied");
  }
  await client.query("begin");
  const authUsers=await readJson(path.join(root,"auth-users.json"));
  for(const user of authUsers){
    await client.query(`insert into public.users(id,email,password_hash,user_metadata,email_confirmed_at,password_reset_required,last_sign_in_at,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(id) do update set email=excluded.email,password_hash=coalesce(excluded.password_hash,public.users.password_hash),user_metadata=excluded.user_metadata,email_confirmed_at=excluded.email_confirmed_at,password_reset_required=case when excluded.password_hash is null then public.users.password_reset_required else false end,last_sign_in_at=excluded.last_sign_in_at,updated_at=excluded.updated_at`,[user.id,user.email,user.password_hash||null,user.user_metadata||{},user.email_confirmed_at||null,!user.password_hash,user.last_sign_in_at||null,user.created_at||new Date(),user.updated_at||new Date()]);
  }
  for(const table of TABLES){const rows=await readJson(path.join(root,"tables",`${table}.json`));await upsertRows(client,table,rows);console.log(`[import] ${table}: ${rows.length}`);}
  for(const table of IDENTITY_TABLES){await client.query(`select setval(pg_get_serial_sequence('public.${table}','id'),coalesce(max(id),1),max(id) is not null) from public.${qid(table)}`);}
  await client.query("commit");
}catch(error){await client.query("rollback").catch(()=>{});throw error;}finally{client.release();await pool.end();}

const storageSource=path.join(root,"storage"),storageTarget=process.env.STORAGE_ROOT;
if(storageTarget){await fs.mkdir(storageTarget,{recursive:true});await fs.cp(storageSource,storageTarget,{recursive:true,force:true}).catch(error=>{if(error.code!=="ENOENT")throw error;});console.log("Storage copied to",storageTarget);}
console.log("Import complete");
