function stripFormatting(s){
  return String(s||"")
    .replace(/\*\*\*(.+?)\*\*\*/g,"$1")
    .replace(/\*\*(.+?)\*\*/g,"$1")
    .replace(/__(.+?)__/g,"$1")
    .replace(/\+\+(.+?)\+\+/g,"$1")
    .replace(/~~(.+?)~~/g,"$1")
    .replace(/`([^`]+)`/g,"$1")
    .replace(/\*(.+?)\*/g,"$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g,"$2")
    .trim();
}

function isDateLine(s){
  const t=String(s||"").trim();
  return /^вчера,?\s*в?\s*\d/i.test(t) || /^сегодня,?\s*в?\s*\d/i.test(t) || /^\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4}(\s+\d{1,2}:\d{2})?$/i.test(t);
}

function extractBoldKey(line){
  let m=line.match(/^\s*\*\*(.+?):?\*\*\s*:?\s*$/);
  if(m) return { key: stripFormatting(m[1]).replace(/[:?]\s*$/,"").trim(), val: "" };
  m=line.match(/^\s*\*\*(.+?):?\*\*\s*:?\s*(.+)$/);
  if(m) return { key: stripFormatting(m[1]).replace(/[:?]\s*$/,"").trim(), val: m[2] };
  return null;
}

function extractPlainKey(line){
  const t=String(line||"").trim();
  if(!t || t.length > 200) return null;
  if(/^https?:/i.test(t)) return null;
  if(!/[:?]\s*$/.test(t)) return null;
  if(!/[a-zа-яё]/i.test(t)) return null;
  return { key: stripFormatting(t).replace(/[:?]\s*$/,"").trim(), val: "" };
}

function parseDiscordMessage(text){
  const raw=String(text||"").replace(/\r/g,"");
  const lines=raw.split("\n");
  const fields={};
  const order=[];
  let currentKey=null;
  let buffer=[];
  let expectValue=false;

  function commit(){
    if(currentKey){
      const val=stripFormatting(buffer.join("\n")).trim();
      if(!isDateLine(currentKey) && val){
        fields[currentKey]=val;
        order.push(currentKey);
      }
      buffer=[];
    }
    currentKey=null;
    expectValue=false;
  }

  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    const trimmed=line.trim();
    if(/^`{3,}/.test(trimmed)) continue;
    if(!trimmed) continue;
    if(isDateLine(trimmed)) { commit(); continue; }

    const bold=extractBoldKey(line);
    if(bold){
      commit();
      currentKey=bold.key;
      if(bold.val) { buffer.push(bold.val); expectValue=false; }
      else expectValue=true;
      continue;
    }

    if(expectValue){
      buffer.push(line);
      expectValue=false;
      continue;
    }

    const plain=extractPlainKey(line);
    if(plain){
      commit();
      currentKey=plain.key;
      if(plain.val) { buffer.push(plain.val); expectValue=false; }
      else expectValue=true;
      continue;
    }

    if(currentKey) buffer.push(line);
  }
  commit();

  let appType=null;
  for(const key of Object.keys(fields)){
    if(/выберите\s*тип|^\s*тип\s*$/i.test(key)){appType=fields[key];delete fields[key]}
  }
  if(!appType && fields["Ключ"]){
    delete fields["Ключ"];
  }
  let submitterName="",submitterDiscord="";
  for(const key of Object.keys(fields)){
    if(/имя\s*фамилия|фио|персонаж/i.test(key)&&!submitterName) submitterName=fields[key];
    if(/дискорд|discord/i.test(key)&&!submitterDiscord) submitterDiscord=fields[key];
  }
  return {
    app_type:appType||"Заявление",
    fields,
    submitter_name:submitterName,
    submitter_discord:submitterDiscord,
    raw_text:text
  };
}

module.exports = { stripFormatting, parseDiscordMessage };
