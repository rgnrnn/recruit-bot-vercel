// Code.gs — Google Sheets writer + admin ops
const PROPS   = PropertiesService.getScriptProperties();
const SHEET_ID= PROPS.getProperty('GOOGLE_SHEET_ID');
const SECRET  = PROPS.getProperty('SECRET');

// Шапка — 24 колонки (точно в таком порядке!)
const HEADERS = [
  "timestamp","run_id","started_at","telegram","telegram_id",
  "q1_consent","q2_name","q3_interests","q4_stack",
  "q5_a1","q5_a2","q5_a3","q6_about",
  "q7_time_zone","q7_time_windows","q7_specific_slots",
  "llm_json","fit_score","roles","stack","work_style_json",
  "time_commitment","links","summary"
];

function _sheet() {
  const sh = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
  const r1 = sh.getRange(1,1,1,HEADERS.length).getValues()[0];
  const ok = HEADERS.every((h,i)=> (r1[i]||"") === h);
  if (!ok) { sh.clear(); sh.getRange(1,1,1,HEADERS.length).setValues([HEADERS]); }
  return sh;
}
function _rows() {
  const sh = _sheet();
  const vals = sh.getDataRange().getValues();
  const out = [];
  for (let i=1;i<vals.length;i++){
    const obj={}; HEADERS.forEach((h,idx)=>obj[h]=vals[i][idx]);
    out.push(obj);
  }
  return out;
}
function _json(s, def){ try{ return JSON.parse(s||""); }catch(e){ return def; } }
function _num(x){ const n=Number(x); return isFinite(n)?n:0; }

// CSV
function _csv(rows){
  const all = [HEADERS].concat(rows.map(r => HEADERS.map(h => r[h])));
  return all.map(row => row.map(cell=>{
    const s = String(cell==null?"":cell).replace(/"/g,'""');
    return `"${s}"`;
  }).join(",")).join("\n");
}

function doPost(e) {
  try{
    const body = JSON.parse(e.postData.contents||"{}");
    if (body.secret !== SECRET) return _out({ok:false, reason:"forbidden"});
    const op = body.op||"";

    if (op==="append") {
      const row = body.row; if (!Array.isArray(row) || row.length!==HEADERS.length) return _out({ok:false,reason:"bad_row"});
      _sheet().appendRow(row); return _out({ok:true});
    }

    if (op==="export_csv") {
      return ContentService.createTextOutput(_csv(_rows()))
        .setMimeType(ContentService.MimeType.CSV);
    }

    if (op==="today") {
      const rows=_rows().filter(r=> (new Date(r.timestamp)).getTime() >= Date.now()-24*3600*1000);
      const total=rows.length;
      const avg = total? Math.round(rows.reduce((a,r)=>a+_num(r.fit_score),0)/total) : 0;
      // топ интересы/роли
      const cntI = {}, cntR = {};
      rows.forEach(r=>{
        (_json(r.q3_interests,[])).forEach(x=>cntI[x]=(cntI[x]||0)+1);
        (_json(r.roles,[])).forEach(x=>cntR[x]=(cntR[x]||0)+1);
      });
      const top = (m)=>Object.entries(m).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([k])=>k);
      return _out({ok:true,total,avg_fit:avg,top_interests:top(cntI),top_roles:top(cntR)});
    }

    if (op==="stats") {
      const rows=_rows();
      const now=Date.now();
      const last7 = rows.filter(r=> (new Date(r.timestamp)).getTime()>=now-7*86400000).length;
      const last30= rows.filter(r=> (new Date(r.timestamp)).getTime()>=now-30*86400000).length;

      const cntI={}, cntS={};
      rows.forEach(r=>{
        _json(r.q3_interests,[]).forEach(x=>cntI[x]=(cntI[x]||0)+1);
        _json(r.q4_stack,[]).forEach(x=>cntS[x]=(cntS[x]||0)+1);
      });
      const pick3 = (m)=>Object.entries(m).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([k])=>k);
      return _out({ok:true,total:rows.length,last7,last30,top_interests:pick3(cntI),top_stack:pick3(cntS)});
    }

    if (op==="who") {
      const n = Math.min(50, Math.max(1, Number(body.limit||10)));
      const rows=_rows().sort((a,b)=> new Date(b.timestamp)-new Date(a.timestamp)).slice(0,n);
      return _out({ok:true, rows});
    }

    if (op==="find") {
      const q=(body.q||"").toString().toLowerCase();
      if (!q) return _out({ok:true, rows:[]});
      const rows=_rows().filter(r=>{
        const name=(r.q2_name||"").toLowerCase();
        const tg  =(r.telegram||"").toLowerCase();
        const roles= (_json(r.roles,[])).join(" ").toLowerCase();
        return name.includes(q)||tg.includes(q)||roles.includes(q);
      }).slice(0,20).sort((a,b)=> new Date(b.timestamp)-new Date(a.timestamp));
      return _out({ok:true, rows});
    }

    if (op==="slots") {
      const rows=_rows();
      const days={}, slots={};
      rows.forEach(r=>{
        const tw = _json(r.q7_time_windows, null);
        if (tw && typeof tw==="object"){
          (tw.days || []).forEach(d=> days[d]=(days[d]||0)+1);
          (tw.slots|| []).forEach(s=> slots[s]=(slots[s]||0)+1);
        }
      });
      return _out({ok:true, days, slots});
    }

    return _out({ok:false, reason:"unknown_op"});
  }catch(err){
    return _out({ok:false, reason:String(err)});
  }
}
function _out(obj){ return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
function doGet(){ return ContentService.createTextOutput("OK"); }
