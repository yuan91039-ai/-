import {KEYWORD_PROFILES,KEYWORD_PROFILE_VERSION} from './keywordProfiles.mjs';
export const HALLOWEEN_GROUP=Object.freeze({name:'万圣节专区',asins:Object.freeze([]),keywords:Object.freeze([])});
const HALLOWEEN_COLOR_GROUPS=[];
const groups=[];
export const DEFAULTS=Object.freeze({groups:Object.freeze([]),expectedLocation:'SW1A 1AA',pages:1,intervalMinutes:60,enabled:false});
export const LABELS = Object.freeze({found:'已找到',not_found:'扫描范围内未找到',failed:'采集失败',partial_found:'已找到（后续页面未完成）',interrupted:'采集中断'});
const lines = value => Array.isArray(value) ? value : String(value ?? '').split(/\r?\n/);
export function validateSettings(input) {
  let sourceGroups = input.groups;
  if (!Array.isArray(sourceGroups)) {
    const asins = lines(input.asins).map(s=>String(s).trim()).filter(Boolean);
    const keywords = lines(input.keywords).map(s=>String(s).trim()).filter(Boolean);
    sourceGroups = [{name:'我的监控组',asins,keywords}];
  }
  if (sourceGroups.length > 30) throw new Error('请设置 1～30 个商品组。');
  const groupNames = new Set(), allAsins = new Set();
  const normalized = sourceGroups.map((source,index) => {
    const name = String(source.name ?? `商品组 ${index+1}`).trim();
    if (!name || name.length > 60) throw new Error(`第 ${index+1} 组名称不能为空且不能超过 60 字。`);
    if (groupNames.has(name.toLowerCase())) throw new Error(`商品组名称重复：${name}`);
    groupNames.add(name.toLowerCase());
    const asins = [...new Set(lines(source.asins).map(s=>String(s).trim().toUpperCase()).filter(Boolean))];
    const localKeywords = new Map();
    for (const value of lines(source.keywords).map(s=>String(s).trim()).filter(Boolean)) if (!localKeywords.has(value.toLowerCase())) localKeywords.set(value.toLowerCase(),value);
    const keywords = [...localKeywords.values()];
    if (!asins.length || asins.length > 20 || asins.some(s=>!/^[A-Z0-9]{10}$/.test(s))) throw new Error(`「${name}」请输入 1～20 个有效 ASIN，每行一个。`);
    if (!keywords.length || keywords.length > 10 || keywords.some(s=>s.length>120)) throw new Error(`「${name}」请输入 1～10 个关键词，每行一个，单词组不超过 120 字符。`);
    for (const asin of asins) {
      allAsins.add(asin);
    }
    return {name,asins,keywords};
  });
  if (allAsins.size > 100) throw new Error('总 ASIN 数不能超过 100 个。');
  const asinKeywords={};
  if(input.asinKeywords!==undefined){
    if(!input.asinKeywords||typeof input.asinKeywords!=='object'||Array.isArray(input.asinKeywords))throw new Error('逐 ASIN 词库格式无效。');
    for(const [asin,values] of Object.entries(input.asinKeywords)){
      if(!allAsins.has(asin))continue;
      if(!Array.isArray(values))throw new Error(`${asin} 的关键词需要为列表。`);
      const words=[...new Map(values.map(value=>{if(typeof value!=='string')throw new Error(`${asin} 的关键词需要为文字。`);const word=value.trim();return [word.toLowerCase(),word];})).values()];
      if(!words.length||words.length>10||words.some(word=>!word||word.length>120))throw new Error(`${asin} 请设置 1～10 个关键词，每个不超过 120 个字符。`);
      asinKeywords[asin]=words;
    }
  }
  const pages = Number(input.pages);
  if (![1,2,3].includes(pages)) throw new Error('扫描页数必须为 1、2 或 3。');
  const expectedLocation = String(input.expectedLocation ?? '').trim().toUpperCase().replace(/\s+/g,' ');
  if (!/^(?:GIR\s?0AA|[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})$/.test(expectedLocation)) throw new Error('请填写完整英国配送邮编，如 SW1A 1AA；不能只填写 London 等城市名。');
  const result={groups:normalized,pages,expectedLocation,intervalMinutes:60,enabled:input.enabled===true};
  if(input.asinKeywords!==undefined)result.asinKeywords=asinKeywords;
  if(input.keywordProfileVersion)result.keywordProfileVersion=String(input.keywordProfileVersion).slice(0,80);
  if(buildKeywordTasks(result).length>60)throw new Error('实际监控的不同关键词不能超过 60 个；请减少逐 ASIN 或商品组关键词。');
  return result;
}
export function getAsinKeywords(settings,asin){
  if(Object.hasOwn(settings.asinKeywords??{},asin))return [...settings.asinKeywords[asin]];
  return [...new Map(settings.groups.filter(group=>group.asins.includes(asin)).flatMap(group=>group.keywords).map(word=>[word.toLowerCase(),word])).values()];
}
export function configuredPairs(settings){
  const asins=[...new Set(settings.groups.flatMap(group=>group.asins))];
  return asins.flatMap(asin=>getAsinKeywords(settings,asin).map(keyword=>({asin,keyword,groups:settings.groups.filter(group=>group.asins.includes(asin)).map(group=>group.name)})));
}
export function applyKeywordProfiles(settings){
  const overrides={...settings.asinKeywords};
  for(const asin of new Set(settings.groups.flatMap(group=>group.asins))){
    const profile=KEYWORD_PROFILES[asin];
    if(profile)overrides[asin]=profile.terms.filter(term=>term.enabled).map(term=>term.keyword);
  }
  return validateSettings({...settings,asinKeywords:overrides,keywordProfileVersion:KEYWORD_PROFILE_VERSION});
}
export function migrateKeywordProfiles(settings){
  if(settings.keywordProfileVersion||settings.asinKeywords!==undefined)return settings;
  const signature=list=>JSON.stringify(list.map(group=>({name:group.name,asins:[...group.asins].sort(),keywords:group.keywords.map(word=>word.toLowerCase()).sort()})).sort((a,b)=>a.name.localeCompare(b.name)));
  // Only migrate unchanged defaults; an edited group configuration needs an explicit apply action.
  return signature(settings.groups)===signature(DEFAULTS.groups)?applyKeywordProfiles(settings):settings;
}
export function ensureHalloweenGroup(settings){return validateSettings(settings);}
export function buildKeywordTasks(settings) {
  const tasks = new Map();
  for (const {asin,keyword} of configuredPairs(settings)) {
    const key=keyword.toLowerCase();
    if (!tasks.has(key)) tasks.set(key,{keyword,asins:[]});
    tasks.get(key).asins.push(asin);
  }
  return [...tasks.values()].map(task=>({...task,asins:[...new Set(task.asins)]}));
}
export function searchUrl(keyword,page,expectedLocation=DEFAULTS.expectedLocation) {
  const url=new URL('https://www.amazon.co.uk/s'); url.searchParams.set('k',keyword); url.searchParams.set('page',String(page)); url.searchParams.set('language','en_GB'); url.searchParams.set('currency','GBP'); url.searchParams.set('deliveryPostalCode',String(expectedLocation??'').trim().toUpperCase()); return url.href;
}
export function makeJob(settings,now=Date.now()) {
  const keywordTasks=buildKeywordTasks(settings);
  if(!keywordTasks.length)throw new Error('请先在监控设置中添加 ASIN 和关键词。');
  return {id:crypto.randomUUID(),startedAt:new Date(now).toISOString(),settings:structuredClone(settings),keywordTasks,keywordIndex:0,page:1,pages:[],status:'waiting',tabId:null};
}
export function finishKeyword(job,failure=null) {
  const pages=job.pages, items=pages.flatMap(p=>p.items), sponsoredItems=pages.flatMap(p=>p.sponsoredItems??[]), capturedAt=pages.at(-1)?.capturedAt??new Date().toISOString();
  const task=job.keywordTasks[job.keywordIndex];
  return task.asins.map(asin=>{
    const index=items.findIndex(x=>x.asin===asin);
    const sponsoredIndex=sponsoredItems.findIndex(item=>item.asin===asin),sponsored=sponsoredIndex>=0?sponsoredItems[sponsoredIndex]:null;
    return {jobId:job.id,startedAt:job.startedAt,capturedAt,marketplace:'UK',asin,keyword:task.keyword,
      rank:index>=0?index+1:null,resultPage:index>=0?items[index].page:null,pagePosition:index>=0?items[index].pagePosition:null,title:index>=0?items[index].title:'',
      sponsoredRank:sponsored?sponsoredIndex+1:null,sponsoredPage:sponsored?.page??null,sponsoredPagePosition:sponsored?.pagePosition??null,
      status:index>=0?(failure?'partial_found':'found'):(failure?'failed':'not_found'),reason:failure??'',scannedPages:pages.length,plannedPages:job.settings.pages,organicResults:items.length,
      location:pages[0]?.location??'',environment:pages.length&&pages.every(page=>page.environment?.mode==='regular'&&page.environment.account==='signed_out')?pages[0].environment:null,evidence:pages.map(({url,capturedAt,location,items,sponsoredItems,sponsoredCount,environment})=>({url,capturedAt,location,environment:environment??null,organicCount:items.length,sponsoredCount,sponsoredAsins:(sponsoredItems??[]).map(item=>item.asin)})),failedUrl:failure?searchUrl(task.keyword,job.page,job.settings.expectedLocation):''};
  });
}
export function interruptedRows(job,reason='浏览器或扩展重启，本次采集未完成') {
  const rows=finishKeyword(job,reason);
  for(const row of rows) if(row.status==='failed') row.status='interrupted';
  for(let i=job.keywordIndex+1;i<job.keywordTasks.length;i++) for(const asin of job.keywordTasks[i].asins) rows.push({jobId:job.id,capturedAt:new Date().toISOString(),startedAt:job.startedAt,marketplace:'UK',asin,keyword:job.keywordTasks[i].keyword,rank:null,status:'interrupted',reason,scannedPages:0,plannedPages:job.settings.pages,organicResults:0,evidence:[]});
  return rows;
}
export function csvCell(value) {let text=String(value??'');if(typeof value==='string'&&/^[\s]*[=+\-@]/.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';}
export function toCsv(rows) {
  const fields=[['采集时间','capturedAt'],['站点','marketplace'],['ASIN','asin'],['关键词','keyword'],['自然结果累计位置','rank'],['所在页','resultPage'],['页内自然位置','pagePosition'],['扫描范围SP广告序位','sponsoredRank'],['SP广告页码','sponsoredPage'],['SP广告页内序位','sponsoredPagePosition'],['状态','status'],['原因','reason'],['已扫描页数','scannedPages'],['计划页数','plannedPages'],['实际自然结果数','organicResults'],['配送地区','location'],['标题','title'],['采集环境','environment'],['页面证据','evidence']];
  return '\uFEFF'+[fields.map(([title])=>csvCell(title)).join(','),...rows.map(row=>fields.map(([,key])=>csvCell(key==='status'?LABELS[row[key]]??row[key]:key==='evidence'||key==='environment'?JSON.stringify(row[key]??null):row[key])).join(','))].join('\r\n');
}

