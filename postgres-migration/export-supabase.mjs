import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import {TABLES} from "./metadata.mjs";

const base=String(process.env.SUPABASE_URL||"").replace(/\/$/,"");
const key=String(process.env.SUPABASE_SERVICE_ROLE||"");
const out=path.resolve(process.env.EXPORT_DIR||"./export");
if(!base||!key) throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE");
if(out===path.parse(out).root||out===path.resolve("."))throw new Error("EXPORT_DIR points to an unsafe directory");
const headers={apikey:key,Authorization:`Bearer ${key}`};

async function json(url,options={}){
  const response=await fetch(url,{...options,headers:{...headers,...options.headers}});
  if(!response.ok)throw new Error(`${response.status} ${url}: ${(await response.text()).slice(0,500)}`);
  const text=await response.text();return text?JSON.parse(text):null;
}
async function exportTable(table){
  const rows=[];const page=1000;
  for(let offset=0;;offset+=page){
    const url=`${base}/rest/v1/${encodeURIComponent(table)}?select=*&limit=${page}&offset=${offset}`;
    let batch;
    try{batch=await json(url);}catch(error){console.warn(`[skip] ${table}: ${error.message}`);return null;}
    rows.push(...batch);if(batch.length<page)break;
  }
  await fs.writeFile(path.join(out,"tables",`${table}.json`),JSON.stringify(rows,null,2),"utf8");
  console.log(`[table] ${table}: ${rows.length}`);return rows.length;
}
async function exportAuth(){
  if(process.env.SUPABASE_DATABASE_URL){
    const pool=new pg.Pool({connectionString:process.env.SUPABASE_DATABASE_URL,ssl:{rejectUnauthorized:false}});
    try{
      const {rows}=await pool.query(`select id,email,encrypted_password as password_hash,raw_user_meta_data as user_metadata,email_confirmed_at,last_sign_in_at,created_at,updated_at from auth.users order by created_at`);
      await fs.writeFile(path.join(out,"auth-users.json"),JSON.stringify(rows,null,2),"utf8");
      return {count:rows.length,passwordHashes:true};
    }finally{await pool.end();}
  }
  const users=[];
  for(let page=1;;page++){
    const payload=await json(`${base}/auth/v1/admin/users?page=${page}&per_page=1000`);
    const batch=payload?.users||[];users.push(...batch);if(batch.length<1000)break;
  }
  const safe=users.map(user=>({id:user.id,email:user.email,user_metadata:user.user_metadata||{},email_confirmed_at:user.email_confirmed_at,last_sign_in_at:user.last_sign_in_at,created_at:user.created_at,updated_at:user.updated_at,password_hash:null}));
  await fs.writeFile(path.join(out,"auth-users.json"),JSON.stringify(safe,null,2),"utf8");
  return {count:safe.length,passwordHashes:false};
}
async function listObjects(bucket,prefix=""){
  const found=[];
  for(let offset=0;;offset+=1000){
    const batch=await json(`${base}/storage/v1/object/list/${encodeURIComponent(bucket)}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prefix,limit:1000,offset,sortBy:{column:"name",order:"asc"}})});
    for(const item of batch||[]){
      const objectName=prefix?`${prefix}/${item.name}`:item.name;
      if(item.id||item.metadata)found.push(objectName);else found.push(...await listObjects(bucket,objectName));
    }
    if((batch||[]).length<1000)break;
  }
  return found;
}
async function exportStorage(){
  let buckets=[];try{buckets=await json(`${base}/storage/v1/bucket`)||[];}catch(error){console.warn("[storage]",error.message);return {buckets:0,files:0};}
  let total=0;
  for(const bucket of buckets){
    const names=await listObjects(bucket.id);
    for(const name of names){
      const response=await fetch(`${base}/storage/v1/object/authenticated/${encodeURIComponent(bucket.id)}/${name.split("/").map(encodeURIComponent).join("/")}`,{headers});
      if(!response.ok){console.warn(`[storage skip] ${bucket.id}/${name}: ${response.status}`);continue;}
      const target=path.join(out,"storage",bucket.id,...name.split("/"));await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,Buffer.from(await response.arrayBuffer()));total++;
    }
    console.log(`[storage] ${bucket.id}: ${names.length}`);
  }
  return {buckets:buckets.length,files:total};
}

const marker=path.join(out,".cgb-migration-export");
let existing=[];try{existing=await fs.readdir(out);}catch(error){if(error.code!=="ENOENT")throw error;}
if(existing.length&&!existing.includes(".cgb-migration-export"))throw new Error("EXPORT_DIR is not an existing CGB export directory; refusing to overwrite it");
await fs.mkdir(out,{recursive:true});await fs.writeFile(marker,"CGB PostgreSQL migration export\n","utf8");
for(const name of ["tables","storage"]){await fs.rm(path.join(out,name),{recursive:true,force:true});}
for(const name of ["auth-users.json","manifest.json"]){await fs.rm(path.join(out,name),{force:true});}
await fs.mkdir(path.join(out,"tables"),{recursive:true});
const counts={};for(const table of TABLES){const count=await exportTable(table);if(count!==null)counts[table]=count;}
const auth=await exportAuth();const storage=await exportStorage();
const manifest={createdAt:new Date().toISOString(),source:base,tables:counts,auth,storage,sha256:{}};
for(const name of await fs.readdir(path.join(out,"tables"))){const bytes=await fs.readFile(path.join(out,"tables",name));manifest.sha256[`tables/${name}`]=crypto.createHash("sha256").update(bytes).digest("hex");}
await fs.writeFile(path.join(out,"manifest.json"),JSON.stringify(manifest,null,2),"utf8");
console.log("Export complete:",out,manifest);
