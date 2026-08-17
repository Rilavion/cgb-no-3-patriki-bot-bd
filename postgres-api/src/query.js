"use strict";

const IDENT = /^[a-z_][a-z0-9_]*$/i;
const OPS = Object.freeze({eq:"=",neq:"<>",gt:">",gte:">=",lt:"<",lte:"<="});

function ident(value, label="identifier"){
  const text=String(value||"");
  if(!IDENT.test(text)) throw Object.assign(new Error(`Invalid ${label}`),{status:400});
  return `"${text}"`;
}

function parseColumns(select){
  const raw=String(select||"*").trim();
  if(raw===""||raw==="*") return "*";
  return raw.split(",").map(x=>ident(x.trim(),"column")).join(", ");
}

function addValue(values,value){ values.push(value); return `$${values.length}`; }

function scalarText(value){
  if(value==="null") return null;
  if(value==="true") return true;
  if(value==="false") return false;
  if(/^-?\d+(?:\.\d+)?$/.test(String(value))) return Number(value);
  return value;
}

function oneFilter(filter,values){
  const col=ident(filter.column,"filter column");
  const op=String(filter.op||"eq");
  const value=filter.value;
  if(OPS[op]) return `${col} ${OPS[op]} ${addValue(values,value)}`;
  if(op==="is"){
    if(value===null||value==="null") return `${col} IS NULL`;
    if(value===true||value==="true") return `${col} IS TRUE`;
    if(value===false||value==="false") return `${col} IS FALSE`;
    throw Object.assign(new Error("Invalid is filter"),{status:400});
  }
  if(op==="not.is"){
    if(value===null||value==="null") return `${col} IS NOT NULL`;
    if(value===true||value==="true") return `${col} IS NOT TRUE`;
    if(value===false||value==="false") return `${col} IS NOT FALSE`;
    throw Object.assign(new Error("Invalid not.is filter"),{status:400});
  }
  if(op==="in"){
    const list=Array.isArray(value)?value:[];
    if(!list.length) return "FALSE";
    return `${col} IN (${list.map(v=>addValue(values,v)).join(",")})`;
  }
  if(op==="not.in"){
    let list=Array.isArray(value)?value:[];
    if(!list.length&&typeof value==="string"){
      const raw=value.trim().replace(/^\(/,"").replace(/\)$/,"");
      list=raw?raw.split(",").map(item=>item.trim().replace(/^['\"]|['\"]$/g,"")):[];
    }
    if(!list.length) return "TRUE";
    return `${col} NOT IN (${list.map(v=>addValue(values,v)).join(",")})`;
  }
  if(op==="contains") return `${col} @> ${addValue(values,JSON.stringify(value))}::jsonb`;
  throw Object.assign(new Error(`Unsupported filter: ${op}`),{status:400});
}

function parseOr(expression,values){
  const clauses=String(expression||"").split(",").filter(Boolean).map(part=>{
    const bits=part.split(".");
    if(bits.length<3) throw Object.assign(new Error("Invalid or filter"),{status:400});
    const column=bits.shift();
    let op=bits.shift();
    if(op==="not"&&bits[0]==="is"){bits.shift();op="not.is";}
    return oneFilter({column,op,value:scalarText(bits.join("."))},values);
  });
  return clauses.length?`(${clauses.join(" OR ")})`:"TRUE";
}

function whereSql(spec,values){
  const clauses=[];
  for(const filter of spec.filters||[]) clauses.push(oneFilter(filter,values));
  for(const expression of spec.or||[]) clauses.push(parseOr(expression,values));
  return clauses.length?` WHERE ${clauses.join(" AND ")}`:"";
}

function orderSql(spec){
  const orders=(spec.orders||[]).map(item=>{
    let sql=`${ident(item.column,"order column")} ${item.ascending===false?"DESC":"ASC"}`;
    if(item.nullsFirst===true) sql+=" NULLS FIRST";
    else if(item.nullsFirst===false) sql+=" NULLS LAST";
    return sql;
  });
  return orders.length?` ORDER BY ${orders.join(", ")}`:"";
}

function pageSql(spec,values){
  let sql="";
  let limit=Number.isInteger(spec.limit)?spec.limit:null;
  let offset=0;
  if(spec.range&&Number.isInteger(spec.range.from)&&Number.isInteger(spec.range.to)){
    offset=Math.max(0,spec.range.from);
    limit=Math.max(0,spec.range.to-offset+1);
  }
  if(limit!==null) sql+=` LIMIT ${addValue(values,Math.max(0,Math.min(limit,10000)))}`;
  if(offset) sql+=` OFFSET ${addValue(values,offset)}`;
  return sql;
}

function normalizeRows(body){
  if(Array.isArray(body)) return body;
  if(body&&typeof body==="object") return [body];
  throw Object.assign(new Error("Body must be an object or array"),{status:400});
}

function mutationSql(spec,values){
  const table=ident(spec.table,"table");
  const rows=normalizeRows(spec.body);
  if(!rows.length) return {text:"select null where false",values,mutation:true};
  const columns=[...new Set(rows.flatMap(row=>Object.keys(row)))];
  columns.forEach(c=>ident(c,"column"));
  const tuples=rows.map(row=>`(${columns.map(c=>addValue(values,row[c]===undefined?null:row[c])).join(",")})`);
  let text=`INSERT INTO public.${table} (${columns.map(c=>ident(c)).join(",")}) VALUES ${tuples.join(",")}`;
  if(spec.action==="upsert"){
    const conflict=String(spec.onConflict||"").split(",").map(x=>x.trim()).filter(Boolean);
    if(!conflict.length) throw Object.assign(new Error("onConflict is required"),{status:400});
    conflict.forEach(c=>ident(c,"conflict column"));
    const updateCols=columns.filter(c=>!conflict.includes(c));
    text+=` ON CONFLICT (${conflict.map(c=>ident(c)).join(",")}) `;
    text+=updateCols.length?`DO UPDATE SET ${updateCols.map(c=>`${ident(c)}=EXCLUDED.${ident(c)}`).join(",")}`:"DO NOTHING";
  }
  if(spec.returning) text+=` RETURNING ${parseColumns(spec.select)}`;
  return {text,values,mutation:true};
}

function compile(spec){
  const values=[];
  const action=String(spec.action||"select");
  const table=ident(spec.table,"table");
  if(action==="insert"||action==="upsert") return mutationSql(spec,values);
  if(action==="select"){
    const where=whereSql(spec,values);
    const countValues=values.slice();
    const text=`SELECT ${parseColumns(spec.select)} FROM public.${table}${where}${orderSql(spec)}${pageSql(spec,values)}`;
    return {text,values,countText:spec.countExact?`SELECT count(*)::integer AS count FROM public.${table}${where}`:null,countValues,mutation:false};
  }
  if(action==="update"){
    if(!spec.body||typeof spec.body!=="object"||Array.isArray(spec.body)) throw Object.assign(new Error("Invalid update body"),{status:400});
    const entries=Object.entries(spec.body);
    if(!entries.length) throw Object.assign(new Error("Empty update"),{status:400});
    const set=entries.map(([key,value])=>`${ident(key,"column")}=${addValue(values,value)}`).join(",");
    const where=whereSql(spec,values);
    if(!where) throw Object.assign(new Error("Refusing update without filters"),{status:400});
    let text=`UPDATE public.${table} SET ${set}${where}`;
    if(spec.returning) text+=` RETURNING ${parseColumns(spec.select)}`;
    return {text,values,mutation:true};
  }
  if(action==="delete"){
    const where=whereSql(spec,values);
    if(!where) throw Object.assign(new Error("Refusing delete without filters"),{status:400});
    let text=`DELETE FROM public.${table}${where}`;
    if(spec.returning) text+=` RETURNING ${parseColumns(spec.select)}`;
    return {text,values,mutation:true};
  }
  throw Object.assign(new Error(`Unsupported action: ${action}`),{status:400});
}

module.exports={compile,ident};
