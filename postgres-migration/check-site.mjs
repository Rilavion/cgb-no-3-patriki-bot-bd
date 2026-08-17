import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import {fileURLToPath} from "node:url";

const site=fileURLToPath(new URL("..",import.meta.url));
const entries=await fs.readdir(site,{withFileTypes:true});
let checked=0,failed=0;

function parse(source,file,label=""){
  try{new vm.Script(source,{filename:file+(label?`:${label}`:"")});checked++;}
  catch(error){failed++;console.error("FAIL",file,label,error.message);}
}

for(const entry of entries){
  if(!entry.isFile())continue;
  const file=path.join(site,entry.name);
  if(entry.name.endsWith(".js"))parse(await fs.readFile(file,"utf8"),file);
  if(entry.name.endsWith(".html")){
    const html=await fs.readFile(file,"utf8");
    const pattern=/<script([^>]*)>([\s\S]*?)<\/script>/gi;
    let match,index=0;
    while((match=pattern.exec(html))){
      index++;
      const attrs=match[1]||"";
      if(/\bsrc\s*=|type\s*=\s*["'](?:application\/json|module)["']/i.test(attrs))continue;
      if(match[2].trim())parse(match[2],file,`inline-${index}`);
    }
  }
}

if(failed)process.exitCode=1;
else console.log(`Site JavaScript syntax: OK (${checked} blocks)`);
