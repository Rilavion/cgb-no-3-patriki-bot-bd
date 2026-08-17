import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
const root=path.resolve(process.env.EXPORT_DIR||"./export");
const manifest=JSON.parse(await fs.readFile(path.join(root,"manifest.json"),"utf8"));
const sslMode=String(process.env.PGSSL||"require").toLowerCase();
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:sslMode==="disable"?undefined:{rejectUnauthorized:sslMode!=="no-verify"}});
let failed=0;
const {rows:userRows}=await pool.query("select count(*)::integer count from public.users");
const expectedUsers=Number(manifest.auth?.count||0),actualUsers=userRows[0].count;
if(actualUsers!==expectedUsers){console.log("FAIL users",`${actualUsers}/${expectedUsers}`);failed++;}else console.log("OK users",`${actualUsers}/${expectedUsers}`);
for(const [table,expected] of Object.entries(manifest.tables||{})){
  const safe='"'+table.replaceAll('"','""')+'"';const {rows}=await pool.query(`select count(*)::integer count from public.${safe}`);const actual=rows[0].count;const ok=actual===expected;console.log(ok?"OK":"FAIL",table,`${actual}/${expected}`);if(!ok)failed++;
}
const {rows:functions}=await pool.query("select count(*)::integer count from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('submit_request','submit_complaint','submit_test_attempt','staff_upsert_role')");
if(functions[0].count!==4){console.log("FAIL RPC functions",functions[0].count,"/4");failed++;}else console.log("OK RPC functions 4/4");
async function countFiles(directory){
  let total=0,entries=[];try{entries=await fs.readdir(directory,{withFileTypes:true});}catch(error){if(error.code==="ENOENT")return 0;throw error;}
  for(const entry of entries){if(entry.isDirectory())total+=await countFiles(path.join(directory,entry.name));else total++;}
  return total;
}
if(process.env.STORAGE_ROOT&&manifest.storage){
  const actualFiles=await countFiles(path.resolve(process.env.STORAGE_ROOT));
  const expectedFiles=Number(manifest.storage.files||0);
  if(actualFiles<expectedFiles){console.log("FAIL storage files",`${actualFiles}/${expectedFiles}`);failed++;}
  else console.log("OK storage files",`${actualFiles}/${expectedFiles}${actualFiles>expectedFiles?" (including pre-existing files)":""}`);
}
await pool.end();if(failed)process.exitCode=1;else console.log("Verification complete: no differences");
