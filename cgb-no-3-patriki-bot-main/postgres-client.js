"use strict";

const {Pool}=require("pg");
const IDENT=/^[a-z_][a-z0-9_]*$/i;
const OPS={eq:"=",neq:"<>",gt:">",gte:">=",lt:"<",lte:"<="};
const RPC_SET=new Set(["get_complaint_form","submit_complaint","submit_request","get_supply_form"]);

function id(value){const s=String(value||"");if(!IDENT.test(s))throw new Error("Invalid identifier");return `"${s}"`;}
function cols(value){const s=String(value||"*").trim();return !s||s==="*"?"*":s.split(",").map(x=>id(x.trim())).join(",");}
function val(values,value){values.push(value);return `$${values.length}`;}
function scalar(value){if(value==="null")return null;if(value==="true")return true;if(value==="false")return false;if(/^-?\d+(\.\d+)?$/.test(String(value)))return Number(value);return value;}

function filterSql(filter,values){
  const column=id(filter.column),op=filter.op,value=filter.value;
  if(OPS[op])return `${column} ${OPS[op]} ${val(values,value)}`;
  if(op==="is")return value==null||value==="null"?`${column} IS NULL`:`${column} IS ${value===true||value==="true"?"TRUE":"FALSE"}`;
  if(op==="not.is")return value==null||value==="null"?`${column} IS NOT NULL`:`${column} IS NOT ${value===true||value==="true"?"TRUE":"FALSE"}`;
  if(op==="in")return !Array.isArray(value)||!value.length?"FALSE":`${column} IN (${value.map(v=>val(values,v)).join(",")})`;
  if(op==="not.in"){
    let list=Array.isArray(value)?value:[];
    if(!list.length&&typeof value==="string"){
      const raw=value.trim().replace(/^\(/,"").replace(/\)$/,"");
      list=raw?raw.split(",").map(item=>item.trim().replace(/^['\"]|['\"]$/g,"")):[];
    }
    return list.length?`${column} NOT IN (${list.map(v=>val(values,v)).join(",")})`:"TRUE";
  }
  if(op==="contains")return `${column} @> ${val(values,JSON.stringify(value))}::jsonb`;
  throw new Error("Unsupported filter: "+op);
}
function where(spec,values){
  const clauses=(spec.filters||[]).map(f=>filterSql(f,values));
  for(const expression of spec.or||[]){
    const parts=String(expression).split(",").filter(Boolean).map(part=>{
      const bits=part.split("."),column=bits.shift();let op=bits.shift();
      if(op==="not"&&bits[0]==="is"){bits.shift();op="not.is";}
      return filterSql({column,op,value:scalar(bits.join("."))},values);
    });
    if(parts.length)clauses.push(`(${parts.join(" OR ")})`);
  }
  return clauses.length?` WHERE ${clauses.join(" AND ")}`:"";
}

class Builder{
  constructor(db,table){this.db=db;this.spec={table,action:"select",filters:[],or:[],orders:[]};this.mode=null;}
  select(columns="*"){this.spec.select=columns||"*";if(this.spec.action!=="select")this.spec.returning=true;return this;}
  insert(body){this.spec.action="insert";this.spec.body=body;return this;}
  upsert(body,options={}){this.spec.action="upsert";this.spec.body=body;this.spec.onConflict=options.onConflict;return this;}
  update(body){this.spec.action="update";this.spec.body=body;return this;}
  delete(){this.spec.action="delete";return this;}
  f(column,op,value){this.spec.filters.push({column,op,value});return this;}
  eq(c,v){return this.f(c,"eq",v)} neq(c,v){return this.f(c,"neq",v)} gt(c,v){return this.f(c,"gt",v)} gte(c,v){return this.f(c,"gte",v)} lt(c,v){return this.f(c,"lt",v)} lte(c,v){return this.f(c,"lte",v)} is(c,v){return this.f(c,"is",v)} in(c,v){return this.f(c,"in",v)} contains(c,v){return this.f(c,"contains",v)} not(c,o,v){return this.f(c,`not.${o}`,v)}
  match(object){Object.entries(object||{}).forEach(([c,v])=>this.eq(c,v));return this;}
  or(expression){this.spec.or.push(expression);return this;}
  order(column,options={}){this.spec.orders.push({column,ascending:options.ascending!==false,nullsFirst:options.nullsFirst});return this;}
  limit(value){this.spec.limit=Number(value);return this;}
  range(from,to){this.spec.range={from:Number(from),to:Number(to)};return this;}
  single(){this.mode="single";return this;}
  maybeSingle(){this.mode="maybeSingle";return this;}
  async execute(){try{
    const spec=this.spec,values=[],table=id(spec.table);let sql="";
    if(spec.action==="select"){
      sql=`SELECT ${cols(spec.select)} FROM public.${table}${where(spec,values)}`;
      if(spec.orders.length)sql+=" ORDER BY "+spec.orders.map(o=>`${id(o.column)} ${o.ascending?"ASC":"DESC"}${o.nullsFirst===true?" NULLS FIRST":o.nullsFirst===false?" NULLS LAST":""}`).join(",");
      let limit=Number.isInteger(spec.limit)?spec.limit:null,offset=0;
      if(spec.range){offset=Math.max(0,spec.range.from);limit=Math.max(0,spec.range.to-offset+1);}
      if(limit!==null)sql+=` LIMIT ${val(values,Math.min(10000,Math.max(0,limit)))}`;
      if(offset)sql+=` OFFSET ${val(values,offset)}`;
    }else if(spec.action==="insert"||spec.action==="upsert"){
      const rows=Array.isArray(spec.body)?spec.body:[spec.body],columns=[...new Set(rows.flatMap(r=>Object.keys(r||{})))];
      sql=`INSERT INTO public.${table} (${columns.map(id).join(",")}) VALUES `+rows.map(row=>`(${columns.map(c=>val(values,row[c]===undefined?null:row[c])).join(",")})`).join(",");
      if(spec.action==="upsert"){
        const conflict=String(spec.onConflict||"").split(",").map(x=>x.trim()).filter(Boolean),updates=columns.filter(c=>!conflict.includes(c));
        if(!conflict.length)throw new Error("onConflict is required");
        sql+=` ON CONFLICT (${conflict.map(id).join(",")}) `+(updates.length?`DO UPDATE SET ${updates.map(c=>`${id(c)}=EXCLUDED.${id(c)}`).join(",")}`:"DO NOTHING");
      }
      if(spec.returning)sql+=` RETURNING ${cols(spec.select)}`;
    }else if(spec.action==="update"){
      const entries=Object.entries(spec.body||{}),condition=where(spec,values);if(!condition)throw new Error("Refusing update without filters");sql=`UPDATE public.${table} SET `+entries.map(([c,v])=>`${id(c)}=${val(values,v)}`).join(",")+condition;if(spec.returning)sql+=` RETURNING ${cols(spec.select)}`;
    }else if(spec.action==="delete"){
      const condition=where(spec,values);if(!condition)throw new Error("Refusing delete without filters");sql=`DELETE FROM public.${table}${condition}`;if(spec.returning)sql+=` RETURNING ${cols(spec.select)}`;
    }
    const result=await this.db.pool.query(sql,values);
    let data=spec.action==="select"||spec.returning?result.rows:null;
    if(this.mode){const rows=Array.isArray(data)?data:[];if(rows.length===1)data=rows[0];else if(this.mode==="maybeSingle"&&rows.length===0)data=null;else return{data:null,error:{message:`Ожидалась одна запись, получено: ${rows.length}`}};}
    return {data,error:null,count:null};
  }catch(error){return {data:null,error:{message:error.message,code:error.code||"PG_ERROR"},count:null};}}
  then(a,b){return this.execute().then(a,b)} catch(b){return this.execute().catch(b)} finally(c){return this.execute().finally(c)}
}

class Channel{
  constructor(db,name){this.db=db;this.name=name;this.handlers=[];}
  on(type,filter,callback){if(type==="postgres_changes")this.handlers.push({filter,callback});return this;}
  subscribe(callback){this.db.addChannel(this).then(()=>{if(callback)callback("SUBSCRIBED")}).catch(()=>{if(callback)callback("CHANNEL_ERROR")});return this;}
  unsubscribe(){this.db.removeChannel(this);return Promise.resolve("ok");}
  dispatch(payload){for(const item of this.handlers){const event=String(item.filter.event||"*").toUpperCase();if(item.filter.table===payload.table&&(event==="*"||event===payload.event)){Promise.resolve(item.callback({eventType:payload.event,old:payload.old||{},new:payload.new||{}})).catch(()=>{});}}}
}

class PostgresClient{
  constructor(connectionString,options={}){
    this.pool=new Pool({connectionString,ssl:options.ssl?{rejectUnauthorized:options.rejectUnauthorized!==false}:undefined,max:Number(options.max||10)});
    this.channels=new Set();this.listener=null;this.connecting=null;
  }
  from(table){return new Builder(this,table);}
  async rpc(name,args={}){try{if(!IDENT.test(name))throw new Error("Invalid RPC");const values=[],named=Object.entries(args).map(([k,v])=>{if(!IDENT.test(k))throw new Error("Invalid argument");values.push(v);return `${id(k)}=>$${values.length}`;}).join(",");const sql=RPC_SET.has(name)?`select * from public.${id(name)}(${named})`:`select public.${id(name)}(${named}) as value`;const {rows}=await this.pool.query(sql,values);return{data:RPC_SET.has(name)?rows:(rows[0]?.value??null),error:null};}catch(error){return{data:null,error:{message:error.message,code:error.code||"PG_ERROR"}};}}
  channel(name){return new Channel(this,name);}
  async addChannel(channel){
    this.channels.add(channel);if(this.listener)return;if(this.connecting)return this.connecting;
    this.connecting=(async()=>{
      this.listener=await this.pool.connect();await this.listener.query("LISTEN cgb_changes");
      this.listener.on("notification",async message=>{try{
        const payload=JSON.parse(message.payload);
        if(payload.event!=="DELETE"&&payload.new?.id!=null&&IDENT.test(payload.table)){
          const {rows}=await this.pool.query(`SELECT * FROM public.${id(payload.table)} WHERE id=$1 LIMIT 1`,[payload.new.id]);
          if(rows[0])payload.new=rows[0];
        }
        for(const ch of this.channels)ch.dispatch(payload);
      }catch(_){}});
      this.listener.on("error",()=>{try{this.listener.release(true)}catch(_){}this.listener=null;setTimeout(()=>{if(this.channels.size)this.addChannel([...this.channels][0]).catch(()=>{});},3000);});
    })().finally(()=>{this.connecting=null});
    return this.connecting;
  }
  removeChannel(channel){this.channels.delete(channel);return Promise.resolve("ok");}
  async close(){if(this.listener){await this.listener.query("UNLISTEN cgb_changes").catch(()=>{});this.listener.release();this.listener=null;}await this.pool.end();}
}

function createPostgresClient(connectionString,options){return new PostgresClient(connectionString,options);}
module.exports={createPostgresClient};
