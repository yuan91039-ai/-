const key=word=>String(word??'').trim().toLowerCase();
export function validateTrafficSnapshot(input){
  if(input?.version!==1||input.marketplace!=='UK'||!/^\d{4}-\d{2}-\d{2}$/.test(input.exportedAt??'')||!Array.isArray(input.reports))throw new Error('SIF流量快照格式无效。');
  const asins=new Set();
  for(const report of input.reports){
    if(!/^[A-Z0-9]{10}$/.test(report.asin??'')||asins.has(report.asin)||typeof report.product!=='string'||!Array.isArray(report.terms)||typeof report.available!=='boolean'||typeof report.period!=='string')throw new Error('SIF子体报告信息无效。');
    asins.add(report.asin);const words=new Set();
    if(!report.available&&report.terms.length)throw new Error('无独立报告的子体不能包含流量数值。');
    for(const term of report.terms){
      const word=key(term.keyword);
      if(!word||word.length>120||words.has(word))throw new Error('SIF关键词为空、重复或过长。');words.add(word);
      for(const field of ['naturalRatio','adRatio','trafficShare'])if(term[field]!==null&&!(typeof term[field]==='number'&&Number.isFinite(term[field])&&term[field]>=0&&term[field]<=1))throw new Error('SIF流量占比必须为0到1之间的数值或空值。');
    }
  }
  return input;
}
export function trafficIndex(snapshot){
  return new Map((snapshot?.reports??[]).map(report=>[report.asin,{...report,byKeyword:new Map(report.terms.map(term=>[key(term.keyword),term]))}]));
}
export function getTrafficInfo(index,asin,keyword){
  const report=index.get(asin),term=report?.byKeyword.get(key(keyword));
  return {status:!report?'unavailable':!report.available?'no_report':!term?'not_observed':'observed',report,term};
}
export function percent(value){return typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1?value>0&&value<0.001?'<0.1%':`${(value*100).toFixed(1)}%`:'—';}
export function spObservation(row){
  if(typeof row?.sponsoredRank==='number'&&row.sponsoredRank>0)return {kind:'seen',text:`SP #${row.sponsoredRank}`};
  if(!row)return {kind:'pending',text:'SP 待采'};
  if(!Object.hasOwn(row,'sponsoredRank')||!['found','not_found'].includes(row.status)||!(row.plannedPages>0&&row.scannedPages>=row.plannedPages))return {kind:'unknown',text:'SP 未确认'};
  return {kind:'not_seen',text:'SP 本次未见'};
}
export function selectTrafficRows(snapshot,{asins,asin='',keyword='',scope='all',source='ad',pairs=[]}={}){
  const active=new Set(pairs.map(pair=>`${pair.asin}|${key(pair.keyword)}`)),needle=key(keyword),rows=[];
  for(const report of snapshot?.reports??[]){
    if(asins&&!asins.has(report.asin)||asin&&report.asin!==asin)continue;
    for(const term of report.terms){
      const monitored=active.has(`${report.asin}|${key(term.keyword)}`);
      if(needle&&!key(term.keyword).includes(needle)||scope==='active'&&!monitored||source==='ad'&&!(term.adRatio>0)||source==='mixed'&&!(term.adRatio>0&&term.naturalRatio>0)||source==='natural'&&!(term.naturalRatio>0))continue;
      rows.push({asin:report.asin,product:report.product,period:report.period,sourceFile:report.sourceFile,...term,monitored});
    }
  }
  return rows.sort((a,b)=>a.asin.localeCompare(b.asin)||(b.trafficShare??-1)-(a.trafficShare??-1)||a.keyword.localeCompare(b.keyword));
}

