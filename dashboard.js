import {DEFAULTS,LABELS,HALLOWEEN_GROUP,toCsv,validateSettings,buildKeywordTasks,getAsinKeywords,configuredPairs,applyKeywordProfiles,migrateKeywordProfiles} from './core.mjs';
import {KEYWORD_PROFILES,KEYWORD_TIERS,keywordInfo} from './keywordProfiles.mjs';
import {getAllRecords,chooseExternalDirectory} from './recordsDb.mjs';
import {PRODUCT_NAMES} from './productNames.mjs';
import {validateTrafficSnapshot,trafficIndex,getTrafficInfo,percent,spObservation,selectTrafficRows} from './traffic.mjs';
const $=id=>document.getElementById(id), installed=typeof chrome!=='undefined'&&!!chrome.runtime?.id;
let state={settings:migrateKeywordProfiles(validateSettings(DEFAULTS)),records:[],runs:[]},working=false;
const profileDrafts=new Map();
let trendCacheKey='',trendRunId='';
let seasonLayout={order:['halloween','christmas'],visible:{halloween:true,christmas:true}};
let seasonConfig={halloween:{title:'万圣节专区',asins:[...HALLOWEEN_GROUP.asins],keywords:[...HALLOWEEN_GROUP.keywords]},christmas:{title:'圣诞链接与关键词',asins:[],keywords:[]}};
let moduleCollapsed={};
let environmentNoticeKey='';
let sifSnapshot=null,sifIndex=new Map(),sifError='',trafficAsinsKey='',trafficPage=0;
const SEASONS={halloween:'🎃 万圣节专区',christmas:'🎄 圣诞专区'};
const date=value=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'—';
const duration=value=>{if(!Number.isFinite(value)||value<0)return '—';const seconds=Math.floor(value/1000),hours=Math.floor(seconds/3600),minutes=Math.floor(seconds%3600/60),rest=seconds%60;return hours?`${hours}小时${minutes}分${rest}秒`:minutes?`${minutes}分${rest}秒`:`${rest}秒`;};
function runDuration(run){if(Number.isFinite(run?.durationMs))return run.durationMs;const rows=(state.records??[]).filter(row=>row.jobId===run?.id);if(!rows.length)return null;const started=Date.parse(rows[0].startedAt),ended=Math.max(...rows.map(row=>Date.parse(row.capturedAt)));return Number.isFinite(started)&&Number.isFinite(ended)?ended-started:null;}
function message(text,error=false){$('message').textContent=text;$('message').classList.toggle('error',error);}
async function send(data){if(!installed)throw new Error('这是界面预览；请先在 Chrome 扩展管理中加载插件。');const result=await chrome.runtime.sendMessage(data);if(!result?.ok)throw new Error(result?.error??'扩展未响应，请在扩展管理页查看错误。');return result;}
function element(tag,text,className=''){const node=document.createElement(tag);node.textContent=text;node.className=className;return node;}
function asinProductName(asin){return PRODUCT_NAMES[asin]??state.asinTitles?.[asin]?.title??'暂未采集到品名';}
function productNameCell(asin){const name=asinProductName(asin);const cell=element('td',name,'productName');cell.title=name;return cell;}
function addGroupEditor(group={name:'新商品组',asins:[],keywords:[]}){
  const card=element('div','','groupEditor');
  const heading=element('div','','groupHeading'), name=document.createElement('input');name.className='groupName';name.value=group.name;name.required=true;name.maxLength=60;name.setAttribute('aria-label','商品组名称');
  const remove=element('button','删除组','quiet removeGroup');remove.type='button';remove.addEventListener('click',()=>card.remove());heading.append(name,remove);card.append(heading);
  const asinLabel=element('label','商品 ASIN（每行一个，最多 20 个）');const asins=document.createElement('textarea');asins.className='groupAsins';asins.rows=4;asins.spellcheck=false;asins.value=group.asins.join('\n');asins.required=true;asinLabel.append(asins);
  const keywordLabel=element('label','监控关键词（每行一个，最多 10 个）');const keywords=document.createElement('textarea');keywords.className='groupKeywords';keywords.rows=4;keywords.spellcheck=false;keywords.value=group.keywords.join('\n');keywords.required=true;keywordLabel.append(keywords);
  card.append(asinLabel,keywordLabel);$('groups').append(card);
}
function settingsFromForm(){return validateSettings({...state.settings,groups:[...document.querySelectorAll('.groupEditor')].map(card=>({name:card.querySelector('.groupName').value,asins:card.querySelector('.groupAsins').value,keywords:card.querySelector('.groupKeywords').value})),pages:$('pages').value,expectedLocation:$('expectedLocation').value});}
function loadSettings(){const s=state.settings??DEFAULTS;$('groups').replaceChildren();for(const group of s.groups??DEFAULTS.groups)addGroupEditor(group);$('pages').value=String(s.pages);$('expectedLocation').value=s.expectedLocation;}
function pairHistory(asin,keyword){return (state.records??[]).filter(row=>row.asin===asin&&String(row.keyword).toLocaleLowerCase()===keyword.toLocaleLowerCase()).sort((a,b)=>String(a.capturedAt).localeCompare(String(b.capturedAt)));}
const environmentKey=row=>['regular','incognito'].includes(row?.environment?.mode)?`${row.environment.mode}|${String(row.environment.postcode??'').replace(/\s/g,'')}|${row.environment.account}`:'legacy';
const environmentLabel=row=>row?.environment?.mode==='regular'?`普通专用窗口 · 未登录 · ${row.environment.postcode}`:row?.environment?.mode==='incognito'?`旧版无痕 · 未登录 · ${row.environment.postcode}`:'采集环境未验证';
function rankChange(history,row){
  const prior=[...history].reverse().find(item=>item!==row&&item.capturedAt<row.capturedAt&&typeof item.rank==='number');
  if(!prior||typeof row?.rank!=='number')return {text:typeof row?.rank==='number'?'首次':'',kind:''};
  if(environmentKey(prior)!==environmentKey(row))return {text:'环境切换',kind:''};
  const change=prior.rank-row.rank;
  return change>0?{text:`↑${change}`,kind:'deltaUp'}:change<0?{text:`↓${Math.abs(change)}`,kind:'deltaDown'}:{text:'→持平',kind:'deltaFlat'};
}
function openTrend(asin,keyword){populateTrendControls();$('trendAsin').value=asin;populateTrendControls();$('trendKeyword').value=keyword;trendCacheKey='';$('trendPanel').scrollIntoView({behavior:'smooth',block:'start'});loadTrend(true);}
async function loadTrafficSnapshot(){
  try{const response=await fetch(new URL('./sifTraffic.json',import.meta.url),{cache:'no-store'});if(!response.ok)throw new Error('未找到本地 SIF 流量快照。');const next=validateTrafficSnapshot(await response.json());sifSnapshot=next;sifIndex=trafficIndex(next);sifError='';}
  catch(error){sifError=`${error.message}${sifSnapshot?' 暂时继续显示此前加载的快照。':' 排名采集不受影响。'}`;}
}
function trafficText(asin,keyword){
  const info=getTrafficInfo(sifIndex,asin,keyword);
  if(info.status==='observed')return `SIF 自然 ${percent(info.term.naturalRatio)} / 广告 ${percent(info.term.adRatio)}`;
  return info.status==='no_report'?'SIF 无独立报告':info.status==='not_observed'?'SIF 本期未收录':'SIF 数据未加载';
}
function trafficBadge(asin,keyword){
  const info=getTrafficInfo(sifIndex,asin,keyword),span=element('span',trafficText(asin,keyword),'sifTrafficBadge');
  span.title=info.report?`SIF UK ${info.report.period}，${sifSnapshot.exportedAt}导出。占比表示该词内的流量构成，不是后台点击或订单；未收录不代表没投广告。`:'SIF快照未加载，不能判断历史流量构成。';return span;
}
function latestPairMap(){
  const latest=new Map();for(const row of state.lookupRecords??state.records??[]){const key=`${row.asin}|${row.keyword.toLowerCase()}`,prior=latest.get(key);if(!prior||String(row.capturedAt)>String(prior.capturedAt))latest.set(key,row);}return latest;
}
function renderTraffic(){
  const asins=[...new Set(state.settings.groups.flatMap(group=>group.asins))],asinsKey=asins.join('|'),old=$('trafficAsin').value;
  if(trafficAsinsKey!==asinsKey){setOptions($('trafficAsin'),[{value:'',label:'全部监控 ASIN'},...asins.map(asin=>({value:asin,label:`${PRODUCT_NAMES[asin]??asin} · ${asin}`}))],old);trafficAsinsKey=asinsKey;}
  const asin=$('trafficAsin').value,rows=selectTrafficRows(sifSnapshot,{asins:new Set(asins),asin,keyword:$('trafficKeyword').value,scope:$('trafficScope').value,source:$('trafficSource').value,pairs:configuredPairs(state.settings)}),pageSize=50;
  trafficPage=Math.min(trafficPage,Math.max(0,Math.ceil(rows.length/pageSize)-1));
  const reportCount=sifSnapshot?.reports.filter(report=>asins.includes(report.asin)&&report.available).length??0;
  $('trafficSnapshot').textContent=sifSnapshot?`SIF UK · 最近30天 · ${sifSnapshot.exportedAt}导出 · ${reportCount}/${asins.length}个子体有独立报告。占比是每个词内的自然／广告流量构成，不是账户点击、订单或全市场广告份额。`:'尚未加载SIF流量快照。';
  $('trafficLoadError').textContent=sifError;
  $('trafficSummary').textContent=`匹配 ${rows.length} 条 ASIN–关键词记录 · 显示 ${rows.length?trafficPage*pageSize+1:0}–${Math.min(rows.length,(trafficPage+1)*pageSize)} 条 · 同一 ASIN 内按报告中的关键词流量占比排序`;
  const body=$('trafficRows'),latest=latestPairMap();body.replaceChildren();
  for(const item of rows.slice(trafficPage*pageSize,(trafficPage+1)*pageSize)){
    const row=latest.get(`${item.asin}|${item.keyword.toLowerCase()}`),tr=document.createElement('tr'),product=element('td',item.asin,'asinCell'),word=element('td',item.keyword,'trafficWord');
    product.append(element('div',item.product,'meta'));product.title=item.sourceFile;
    word.append(element('div',item.monitored?'当前监控词':'报告词 · 未加入监控','meta'));
    const natural=element('td',typeof row?.rank==='number'?`#${row.rank}`:row?LABELS[row.status]??row.status:'未采集'),ad=spObservation(row);
    natural.title=row?.reason??'';
    tr.append(product,word,element('td',percent(item.naturalRatio),'trafficNatural'),element('td',percent(item.adRatio),'trafficAdvertising'),natural,element('td',ad.text,`spObservation sp-${ad.kind}`),element('td',date(row?.capturedAt)));
    body.append(tr);
  }
  if(!rows.length){const report=sifIndex.get(asin),tr=document.createElement('tr'),td=element('td',!sifSnapshot?'请确认新版插件目录中已包含SIF流量快照。':report&&!report.available?'该子体暂无独立SIF报告，不能当作广告流量为零。':'本期报告没有符合筛选的词；不代表没有投广告。');td.colSpan=7;tr.append(td);body.append(tr);}
  $('trafficPrev').disabled=trafficPage===0;$('trafficNext').disabled=(trafficPage+1)*pageSize>=rows.length;
}
function keywordPill(asin,keyword,row,history,extraClass=''){
  const change=rankChange(history,row),rank=typeof row?.rank==='number',status=row?LABELS[row.status]??row.status:'未采集';
  const suffix=rank?`自然 #${row.rank}${change.text?` ${change.text}`:''}`:`自然：${status}`;
  const info=keywordInfo(asin,keyword),pill=element('button',`${keyword} · ${suffix}`,`keywordPill keywordButton ${rank?'ranked':row&&!['found','not_found'].includes(row.status)?'failed':extraClass} ${change.kind}`);pill.type='button';pill.title=`${KEYWORD_TIERS[info.tier]}：${info.basis}${row?.reason?`；${row.reason}`:''}；点击查看历史趋势`;
  const badges=element('span','','keywordBadgeRow'),ad=spObservation(row);
  badges.append(element('span',KEYWORD_TIERS[info.tier],`keywordTier tier-${info.tier}`),element('span',ad.text,`spObservation sp-${ad.kind}`));pill.append(badges,trafficBadge(asin,keyword));pill.addEventListener('click',()=>openTrend(asin,keyword));return pill;
}
function renderLookup(records){
  const asinFilter=$('lookupAsin').value.trim().toLocaleLowerCase(),nameFilter=$('lookupName').value.trim().toLocaleLowerCase(),keywordFilter=$('lookupKeyword').value.trim().toLocaleLowerCase(),filter=$('lookupStatus').value,asins=new Map();
  const getAsin=asin=>{if(!asins.has(asin))asins.set(asin,{asin,groups:new Set(),keywords:new Map()});return asins.get(asin);};
  for(const pair of configuredPairs(state.settings)){const item=getAsin(pair.asin);pair.groups.forEach(group=>item.groups.add(group));item.keywords.set(pair.keyword.toLocaleLowerCase(),{keyword:pair.keyword,row:null,active:true});}
  for(const row of records){const item=getAsin(row.asin),key=String(row.keyword??'').toLocaleLowerCase(),prior=item.keywords.get(key);if(!prior||!prior.row||String(row.capturedAt)>String(prior.row.capturedAt))item.keywords.set(key,{keyword:row.keyword,row,active:prior?.active===true});}
  const matchesFilter=pair=>{if(filter!=='all'&&!pair.active)return false;const history=pairHistory(pair.asin,pair.keyword),change=rankChange(history,pair.row);if(filter==='sif_ad')return getTrafficInfo(sifIndex,pair.asin,pair.keyword).term?.adRatio>0;if(filter==='sp_seen')return spObservation(pair.row).kind==='seen';if(filter==='ranked')return typeof pair.row?.rank==='number';if(filter==='not_found')return pair.row?.status==='not_found';if(filter==='changed')return ['deltaUp','deltaDown'].includes(change.kind);if(filter==='uncollected')return !pair.row;return true;};
  const rows=[...asins.values()].map(item=>({...item,keywords:[...item.keywords.values()].filter(pair=>(!keywordFilter||pair.keyword.toLocaleLowerCase().includes(keywordFilter))&&matchesFilter({...pair,asin:item.asin}))}))
    .filter(item=>item.asin.toLocaleLowerCase().includes(asinFilter)&&asinProductName(item.asin).toLocaleLowerCase().includes(nameFilter)&&item.keywords.length).sort((a,b)=>a.asin.localeCompare(b.asin));
  const body=$('lookupRows');body.replaceChildren();let pairCount=0;
  for(const item of rows){const tr=document.createElement('tr'),asin=element('td',item.asin,'asinCell'),name=productNameCell(item.asin),groups=element('td',[...item.groups].join('、')||'历史记录','meta'),keywordCell=element('td','','keywordCell'),pills=element('div','','keywordList');let newest=null;
    for(const pair of item.keywords){pairCount++;const history=pairHistory(item.asin,pair.keyword),pill=keywordPill(item.asin,pair.keyword,pair.row,history);if(!pair.active){pill.classList.add('historicalKeyword');pill.append(element('span','历史·未监控','keywordTier'));}pills.append(pill);if(pair.row?.capturedAt&&(!newest||pair.row.capturedAt>newest))newest=pair.row.capturedAt;}
    keywordCell.append(pills);tr.append(asin,name,groups,keywordCell,element('td',date(newest)));body.append(tr);
  }
  if(!rows.length){const tr=document.createElement('tr'),td=element('td','没有匹配的 ASIN。清除筛选后可查看全部。');td.colSpan=5;tr.append(td);body.append(tr);}
  $('lookupSummary').textContent=`共 ${rows.length} 个 ASIN · ${pairCount} 个 ASIN-关键词组合${filter==='all'?'（含历史旧词）':'（当前监控词）'} · 变化以排名数字变小为提升`;
}
function renderHalloween(records){
  const group=(state.settings?.groups??[]).find(item=>item.name==='万圣节专区'),config=seasonConfig.halloween;
  const body=$('halloweenRows');body.replaceChildren();
  $('halloweenHeading').textContent=`🎃 ${config.title}`;const allGroups=state.settings?.groups??[],asins=config.asins.length?config.asins:[...new Set(allGroups.filter(item=>item.name==='万圣节专区'||item.name.startsWith('万圣节')).flatMap(item=>item.asins))],keywords=config.keywords.length?config.keywords:(group?.keywords??[]);let updated=0;
  for(const asin of asins){const tr=document.createElement('tr'),name=productNameCell(asin),keywordCell=element('td','','keywordCell'),pills=element('div','','keywordList');let newest=null;
    const asinKeywords=getAsinKeywords(state.settings,asin).filter(keyword=>/halloween|purple|orange|green/i.test(keyword)||keywords.some(word=>word.toLowerCase()===keyword.toLowerCase()));
    for(const keyword of asinKeywords){const history=pairHistory(asin,keyword),row=history.at(-1);pills.append(keywordPill(asin,keyword,row,history,'halloweenPill'));if(row?.capturedAt){updated++;if(!newest||row.capturedAt>newest)newest=row.capturedAt;}}
    keywordCell.append(pills);tr.append(element('td',asin,'asinCell'),name,keywordCell,element('td',date(newest)));body.append(tr);
  }
  if(!asins.length||!keywords.length){const tr=document.createElement('tr'),td=element('td','请在专区布局中填写 ASIN 和关键词。');td.colSpan=4;tr.append(td);body.append(tr);}
  $('halloweenSummary').textContent=`${asins.length} 个 ASIN · ${updated} 条已有关键词记录`;
}
function renderChristmas(records){
  const config=seasonConfig.christmas,pairs=new Map(),terms=config.keywords.length?config.keywords:null,selectedAsins=new Set(config.asins);
  for(const pair of configuredPairs(state.settings)){const {asin,keyword}=pair;if(terms?!terms.some(term=>term.toLocaleLowerCase()===keyword.toLocaleLowerCase()):!/christmas/i.test(keyword))continue;if(selectedAsins.size&&!selectedAsins.has(asin))continue;const key=`${asin}|${keyword.toLocaleLowerCase()}`;pairs.set(key,{asin,keyword,groups:new Set(pair.groups)});}
  const asinsToShow=selectedAsins.size?[...selectedAsins]:[...new Set([...pairs.values()].map(pair=>pair.asin))];
  const byAsin=new Map(asinsToShow.map(asin=>[asin,{groups:new Set(),keywords:[]} ]));for(const pair of pairs.values()){const item=byAsin.get(pair.asin);if(item){pair.groups.forEach(group=>item.groups.add(group));item.keywords.push(pair.keyword);}}
  $('christmasHeading').textContent=`🎄 ${config.title}`;
  const body=$('christmasRows');body.replaceChildren();let updated=0;
  for(const [asin,item] of [...byAsin].sort(([a],[b])=>a.localeCompare(b))){const tr=document.createElement('tr'),pills=element('div','','keywordList'),keywords=element('td','','keywordCell');let newest=null;
    for(const keyword of new Set(item.keywords)){const history=pairHistory(asin,keyword),row=history.at(-1);pills.append(keywordPill(asin,keyword,row,history,'christmasPill'));if(row?.capturedAt){updated++;if(!newest||row.capturedAt>newest)newest=row.capturedAt;}}
    if(!item.keywords.length)pills.append(element('span','未配置该专区监控词','hint'));
    keywords.append(pills);tr.append(element('td',asin,'asinCell'),productNameCell(asin),element('td',[...item.groups].join('、'),'meta'),keywords,element('td',date(newest)));body.append(tr);
  }
  if(!byAsin.size){const tr=document.createElement('tr'),td=element('td','当前专区没有 ASIN。请在专区布局中设置 ASIN，或为监控组添加 Christmas 关键词。');td.colSpan=5;tr.append(td);body.append(tr);}
  $('christmasSummary').textContent=`${byAsin.size} 个 ASIN · ${updated} 条已有关键词记录`;
}
function renderSeasonLayout(){
  const list=$('seasonLayout');list.replaceChildren();
  for(let index=0;index<seasonLayout.order.length;index++){const id=seasonLayout.order[index],row=element('div','','seasonLayoutRow'),label=document.createElement('label'),check=document.createElement('input');check.type='checkbox';check.checked=seasonLayout.visible[id]!==false;check.addEventListener('change',()=>{seasonLayout.visible[id]=check.checked;persistSeasonLayout();renderSeasonLayout();});label.append(check,element('span',SEASONS[id]));const actions=element('div','','seasonMove');
    for(const [text,delta,title] of [['↑',-1,'上移'],['↓',1,'下移']]){const button=element('button',text,'secondary seasonMoveButton');button.type='button';button.title=title;button.setAttribute('aria-label',`${title}${SEASONS[id]}`);button.disabled=(index+delta<0||index+delta>=seasonLayout.order.length);button.addEventListener('click',()=>{const target=index+delta;[seasonLayout.order[index],seasonLayout.order[target]]=[seasonLayout.order[target],seasonLayout.order[index]];persistSeasonLayout();renderSeasonLayout();arrangeSeasonPanels();});actions.append(button);}
    row.append(label,actions);list.append(row);
  }
  arrangeSeasonPanels();
}
function arrangeSeasonPanels(){const parent=$('christmasPanel').parentElement,anchor=$('trendPanel');for(const id of seasonLayout.order){const panel=$(`${id}Panel`);panel.hidden=seasonLayout.visible[id]===false;parent.insertBefore(panel,anchor);}}
async function persistSeasonLayout(){if(installed)await chrome.storage.local.set({seasonLayout});}
function initializeCollapsibleModules(){
  const modules=[...document.querySelectorAll('main .panel')];
  const bindModuleToggle=(panel,header,body,key,toggle)=>{
    const title=header.querySelector('h2');
    const sync=()=>{body.hidden=moduleCollapsed[key]===true;toggle.textContent=body.hidden?'展开':'收起';toggle.setAttribute('aria-expanded',String(!body.hidden));if(title)title.setAttribute('aria-expanded',String(!body.hidden));};
    const flip=async()=>{moduleCollapsed[key]=!moduleCollapsed[key];sync();if(installed)await chrome.storage.local.set({moduleCollapsed});};
    toggle.addEventListener('click',event=>{event.stopPropagation();void flip();});
    header.addEventListener('click',event=>{if(event.target.closest('button,a,input,textarea,select,summary'))return;void flip();});
    if(title){title.tabIndex=0;title.setAttribute('role','button');title.setAttribute('aria-expanded',String(!body.hidden));title.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();void flip();}});}
    sync();
  };
  for(const panel of modules){
    const key=panel.id||`module-${modules.indexOf(panel)+1}`;
    let header=panel.querySelector(':scope > .sectionTitle');
    if(!header){
      const title=panel.querySelector(':scope > h2, :scope > div > h2');
      header=document.createElement('div');header.className='moduleHeader';
      panel.prepend(header);if(title)header.append(title);
    }
    header.classList.add('moduleHeader');
    if(panel.classList.contains('seasonPanel'))panel.querySelectorAll(':scope > .sectionTitle .collapseSeason').forEach(button=>button.remove());
    const body=document.createElement('div');body.className='moduleBody';
    for(const child of [...panel.children])if(child!==header)body.append(child);
    const toggle=element('button',moduleCollapsed[key]?'展开':'收起','secondary moduleToggle');toggle.type='button';toggle.setAttribute('aria-expanded',String(!moduleCollapsed[key]));
    header.append(toggle);panel.append(body);bindModuleToggle(panel,header,body,key,toggle);
  }
  const stats=$('statsPanel');if(stats){const heading=element('div','','moduleHeader statsHeader'),title=element('h2','采集概况'),body=element('div','','moduleBody statsBody');for(const child of [...stats.children])body.append(child);const toggle=element('button',moduleCollapsed.statsPanel?'展开':'收起','secondary moduleToggle');toggle.type='button';heading.append(title,toggle);stats.append(heading,body);bindModuleToggle(stats,heading,body,'statsPanel',toggle);}
  document.querySelectorAll('[data-modules-action]').forEach(button=>button.addEventListener('click',async()=>{const collapsed=button.dataset.modulesAction==='collapse';for(const panel of [...document.querySelectorAll('main .panel'),$('statsPanel')].filter(Boolean)){const body=panel.querySelector(':scope > .moduleBody');if(!body)continue;const toggle=panel.querySelector(':scope > .moduleHeader .moduleToggle');body.hidden=collapsed;if(toggle){toggle.textContent=collapsed?'展开':'收起';toggle.setAttribute('aria-expanded',String(!collapsed));}moduleCollapsed[panel.id||`module-${panel.dataset.moduleIndex??''}`]=collapsed;}if(installed)await chrome.storage.local.set({moduleCollapsed});}));
  document.querySelectorAll('.quickLinks a').forEach(link=>link.addEventListener('click',event=>{const target=document.querySelector(link.getAttribute('href'));if(!target||target.hidden)return;event.preventDefault();const body=target.querySelector(':scope > .moduleBody');if(body?.hidden)target.querySelector(':scope > .moduleHeader .moduleToggle')?.click();target.scrollIntoView({behavior:'smooth',block:'start'});}));
}
function loadSeasonConfigEditor(){for(const id of ['halloween','christmas']){$(`${id}Title`).value=seasonConfig[id].title;$(`${id}Asins`).value=seasonConfig[id].asins.join('\n');$(`${id}Keywords`).value=seasonConfig[id].keywords.join('\n');}}
function parseLines(value){return [...new Set(value.split(/\r?\n/).map(item=>item.trim()).filter(Boolean))];}
async function saveSeasonConfigFromForm(){
  const next={};for(const id of ['halloween','christmas']){const title=$(`${id}Title`).value.trim(),asins=parseLines($(`${id}Asins`).value).map(asin=>asin.toUpperCase()),keywords=parseLines($(`${id}Keywords`).value);if(!title||title.length>40)throw new Error('专区名称不能为空，且不能超过 40 个字符。');if(asins.length>100||asins.some(asin=>!/^[A-Z0-9]{10}$/.test(asin)))throw new Error(`${SEASONS[id]}包含无效 ASIN；请每行填写一个 10 位 ASIN。`);if(keywords.length>30||keywords.some(keyword=>keyword.length>120))throw new Error(`${SEASONS[id]}关键词最多 30 个，每个不超过 120 个字符。`);next[id]={title,asins,keywords};}
  seasonConfig=next;if(installed)await chrome.storage.local.set({seasonConfig});render();message('专区名称、ASIN 和关键词已保存。未添加到监控组的 ASIN/关键词不会自动采集。');
}
function setOptions(select,options,selected){
  select.replaceChildren();
  for(const item of options){const option=document.createElement('option');option.value=item.value;option.textContent=item.label;select.append(option);}
  if(options.some(item=>item.value===selected))select.value=selected;else if(options.length)select.value=options[0].value;
}
function populateTrendControls(){
  const products=new Map();
  for(const {asin,keyword} of configuredPairs(state.settings)){if(!products.has(asin))products.set(asin,new Set());products.get(asin).add(keyword);}
  for(const row of state.lookupRecords??[]){if(!products.has(row.asin))products.set(row.asin,new Set());products.get(row.asin).add(row.keyword);}
  const oldAsin=$('trendAsin').value,oldKeyword=$('trendKeyword').value;
  const asinOptions=[...products.keys()].sort().map(asin=>({value:asin,label:`${asin}${PRODUCT_NAMES[asin]?` · ${PRODUCT_NAMES[asin]}`:''}`}));
  setOptions($('trendAsin'),asinOptions,oldAsin);
  const asin=$('trendAsin').value,keywords=[...(products.get(asin)??[])].sort((a,b)=>a.localeCompare(b));
  setOptions($('trendKeyword'),keywords.map(keyword=>({value:keyword,label:keyword})),oldKeyword);
}
let profileSelectKey='',profileRenderedAsin='';
function profileDraftFromEditor(){
  const asin=$('profileAsin').value;
  const words=[...$('profileRows').querySelectorAll('input[type="checkbox"]:checked')].map(box=>box.value);
  const extra=$('profileExtraWords').value;
  return {asin,words,extra};
}
function rememberProfileDraft(){const draft=profileDraftFromEditor();profileDrafts.set(draft.asin,draft);$('profileDraftStatus').textContent='选词有未保存的修改。';}
function renderProfileLibrary(force=false){
  const settings=state.settings??DEFAULTS,asins=[...new Set(settings.groups.flatMap(group=>group.asins))].sort(),selectKey=asins.join('|'),old=$('profileAsin').value;
  if(selectKey!==profileSelectKey){setOptions($('profileAsin'),asins.map(asin=>({value:asin,label:`${PRODUCT_NAMES[asin]??asin} · ${asin}`})),old);profileSelectKey=selectKey;}
  const asin=$('profileAsin').value,profile=KEYWORD_PROFILES[asin],active=Object.hasOwn(settings.asinKeywords??{},asin);
  const enabledProfiles=asins.filter(code=>Object.hasOwn(settings.asinKeywords??{},code)).length;
  $('profileSummary').textContent=`当前 ${enabledProfiles}/${asins.length} 个 ASIN 使用独立词库 · ${buildKeywordTasks(settings).length}/60 个不同搜索词 · 依据 SIF UK 最近30天报告（2026-10-16导出）`;
  if(!force&&profileRenderedAsin===asin&&profileDrafts.has(asin))return;
  profileRenderedAsin=asin;
  const draft=profileDrafts.get(asin),words=draft?.words??getAsinKeywords(settings,asin),wordKeys=new Set(words.map(word=>word.toLowerCase())),known=new Set((profile?.terms??[]).map(term=>term.keyword.toLowerCase()));
  $('profileProduct').textContent=profile?`${profile.product} · ${profile.family}`:PRODUCT_NAMES[asin]??asin;
  $('profileEvidence').textContent=`${active?'当前采集使用此 ASIN 独立词库。':'当前采集使用商品组词；保存选词后启用此 ASIN 独立词库。'} ${!profile?'没有预置报告依据，可填写自定义词。':!profile.reportAvailable?'SIF 暂无该子体独立数据，候选词均待验证。':profile.needsProductCheck?'需核实商品外形，候选词暂未启用。':'报告曝光记录和产品用途共同用于选词；有曝光不等于词义精准或高转化。'}`;
  const body=$('profileRows');body.replaceChildren();
  for(const term of profile?.terms??[]){const row=document.createElement('tr'),choice=document.createElement('input'),cell=document.createElement('td'),traffic=element('td','','profileTraffic');choice.type='checkbox';choice.value=term.keyword;choice.checked=wordKeys.has(term.keyword.toLowerCase());choice.setAttribute('aria-label',`监控 ${term.keyword}`);cell.append(choice);traffic.append(trafficBadge(asin,term.keyword));row.append(cell,element('td',term.keyword),element('td',KEYWORD_TIERS[term.tier],`tier-${term.tier}`),traffic,element('td',term.basis,'profileReason'));body.append(row);}
  if(!profile?.terms.length){const tr=document.createElement('tr'),td=element('td','暂无预置词，请在下方填写每行一个的关键词。');td.colSpan=5;tr.append(td);body.append(tr);}
  $('profileExtraWords').value=draft?.extra??words.filter(word=>!known.has(word.toLowerCase())).join('\n');
  $('profileDraftStatus').textContent=draft?'选词有未保存的修改。':'修改后点击“保存此 ASIN 选词”；正在运行的一轮仍使用启动时的配置。';
  const excluded=$('profileExcluded');excluded.replaceChildren();
  for(const item of profile?.excluded??[])excluded.append(element('li',`${item.keyword}：${item.reason}`));
  if(!profile?.excluded.length)excluded.append(element('li','本次未列出额外冲突词；不代表已核实所有搜索意图。'));
  $('profileExcludedCount').textContent=`查看报告中的冲突／需核实词（${profile?.excluded.length??0}）`;
}
function svgNode(tag,attrs={},label=''){
  const node=document.createElementNS('http://www.w3.org/2000/svg',tag);
  for(const [key,value] of Object.entries(attrs))node.setAttribute(key,String(value));
  if(label)node.textContent=label;return node;
}
function renderTrend(rows){
  const box=$('trendChart'),values=rows.filter(row=>typeof row.rank==='number'&&row.rank>0),summary=$('trendSummary');
  if(!values.length){box.replaceChildren(element('div','该 ASIN 与关键词暂无已找到的排名记录。','empty'));summary.textContent=rows.length?`共有 ${rows.length} 次历史采集，但扫描范围内没有成功记录排名。`:'暂无该组合的历史采集记录。';return;}
  const minRank=Math.min(...values.map(row=>row.rank)),maxRank=Math.max(...values.map(row=>row.rank)),axisMax=Math.max(10,Math.ceil(maxRank/10)*10);
  const start=Date.parse(values[0].capturedAt),end=Date.parse(values.at(-1).capturedAt),range=end-start;
  const width=900,height=320,left=62,right=24,top=20,bottom=48,plotW=width-left-right,plotH=height-top-bottom;
  const xFor=row=>range?left+(Date.parse(row.capturedAt)-start)/range*plotW:left+plotW/2;
  const yFor=row=>top+(row.rank-1)/(axisMax-1)*plotH;
  const svg=svgNode('svg',{viewBox:`0 0 ${width} ${height}`,role:'img','aria-label':'ASIN 自然搜索排名历史曲线'});
  box.replaceChildren(svg);
  for(const rank of [1,Math.round(axisMax/2),axisMax]){const y=top+(rank-1)/(axisMax-1)*plotH;svg.append(svgNode('line',{x1:left,y1:y,x2:width-right,y2:y,class:'chartGrid'}));svg.append(svgNode('text',{x:left-12,y:y+4,'text-anchor':'end',class:'chartAxisLabel'},`#${rank}`));}
  svg.append(svgNode('line',{x1:left,y1:top,x2:left,y2:height-bottom,class:'chartAxis'}));svg.append(svgNode('line',{x1:left,y1:height-bottom,x2:width-right,y2:height-bottom,class:'chartAxis'}));
  const segments=[];let segment=[];
  for(const row of rows){if(segment.length&&environmentKey(segment.at(-1))!==environmentKey(row)){segments.push(segment);segment=[];}if(typeof row.rank==='number'&&row.rank>0)segment.push(row);else if(segment.length){segments.push(segment);segment=[];}}
  if(segment.length)segments.push(segment);
  for(const points of segments){
    if(points.length>1){const d=points.map((row,index)=>`${index?'L':'M'} ${xFor(row)} ${yFor(row)}`).join(' ');svg.append(svgNode('path',{d,class:'rankLine'}));}
  for(const row of points){
      const circle=svgNode('circle',{cx:xFor(row),cy:yFor(row),r:6,class:'rankPoint'}),tooltip=element('div',`${date(row.capturedAt)} · 自然排名 #${row.rank}`,'trendTooltip');
      circle.setAttribute('tabindex','0');circle.setAttribute('role','img');circle.setAttribute('aria-label',`${date(row.capturedAt)}，自然排名第 ${row.rank} 位`);
      circle.append(svgNode('title',{},`${date(row.capturedAt)} · 自然排名 #${row.rank} · ${environmentLabel(row)}`));
      const showTooltip=(x,y)=>{const rect=box.getBoundingClientRect();tooltip.hidden=false;tooltip.style.left=`${Math.max(8,Math.min(rect.width-210,x-rect.left+12))}px`;tooltip.style.top=`${Math.max(8,Math.min(rect.height-48,y-rect.top-36))}px`;};
      circle.addEventListener('pointerenter',event=>showTooltip(event.clientX,event.clientY));circle.addEventListener('pointermove',event=>showTooltip(event.clientX,event.clientY));circle.addEventListener('pointerleave',()=>{tooltip.hidden=true;});
      circle.addEventListener('focus',()=>{const point=circle.getBoundingClientRect();showTooltip(point.left+point.width/2,point.top);});circle.addEventListener('blur',()=>{tooltip.hidden=true;});
      svg.append(circle);box.append(tooltip);
    }
  }
  const dateTicks=[values[0],values[Math.floor((values.length-1)/2)],values.at(-1)];
  dateTicks.forEach((row,index)=>svg.append(svgNode('text',{x:xFor(row),y:height-15,'text-anchor':index===0?'start':index===2?'end':'middle',class:'chartAxisLabel'},new Date(row.capturedAt).toLocaleDateString('zh-CN'))));
  const found=values.length,best=minRank,firstDate=new Date(start).toLocaleDateString('zh-CN'),lastDate=new Date(end).toLocaleDateString('zh-CN');
  summary.textContent=`${rows.length} 次采集 · ${found} 次找到 · 最佳排名 #${best} · ${firstDate}${firstDate===lastDate?'':` 至 ${lastDate}`}（排名越靠上越好）`;
}
async function loadTrend(force=false){
  const asin=$('trendAsin').value,keyword=$('trendKeyword').value,key=asin&&keyword?`${asin}|${keyword.toLocaleLowerCase()}`:'';
  if(!key){$('trendChart').replaceChildren(element('div','请先在监控设置中添加 ASIN 和关键词。','empty'));$('trendSummary').textContent='没有可选择的监控组合。';return;}
  const runId=state.lastRun?.id??'';
  if(!force&&key===trendCacheKey&&runId===trendRunId)return;
  trendCacheKey=key;trendRunId=runId;$('trendChart').replaceChildren(element('div','正在载入排名历史…','empty'));
  try{const result=await send({type:'trend',asin,keyword});renderTrend(result.rows??[]);}catch(error){$('trendChart').replaceChildren(element('div',error.message,'empty'));}
}
function render(){
  const settings=state.settings??DEFAULTS,records=state.records??[];
  $('scheduleBadge').textContent=settings.enabled?'每小时监控中':'定时未开启';$('scheduleBadge').classList.toggle('on',settings.enabled);$('toggle').textContent=settings.enabled?'暂停定时监控':'开启每小时监控';
  $('nextRun').textContent=date(state.nextRun);$('recordCount').textContent=String(records.length);
  const storage=state.storage??{configured:false};
  $('dataStorage').textContent=storage.configured?`采集数据位置：${storage.name}（文件夹授权${storage.permission==='granted'?'正常':'需要重新授权'}）`:'尚未设置本地数据文件夹；采集记录仍在浏览器旧存储中。设置完成后会迁移并清理旧副本。';
  $('dataStorage').classList.toggle('error',!storage.configured||storage.permission!=='granted');
  $('chooseFolder').textContent=storage.configured?'授权 / 更改数据文件夹':'选择数据文件夹并迁移数据';
  populateTrendControls();
  const environmentPaused=state.job?.status==='waiting_environment';
  $('environmentStatus').textContent=`普通专用窗口${state.amazonSession?' · 本轮使用中':' · 采集时自动建立，完成后关闭'} · 校验未登录 · 目标邮编 ${settings.expectedLocation}`;
  $('environmentReason').hidden=!environmentPaused;
  $('environmentReason').textContent=environmentPaused?`已暂停：${state.job.environmentReason||state.systemError||'请点击“查看采集窗口”，确认未登录且配送邮编正确，再继续采集。'}`:'';
  $('resumeEnvironment').hidden=!environmentPaused;
  const noticeKey=environmentPaused?`${state.job.id}|${state.job.environmentReason??''}`:'';
  if(noticeKey&&noticeKey!==environmentNoticeKey){
    const panel=$('environmentPanel'),body=panel.querySelector(':scope > .moduleBody');
    if(body?.hidden)panel.querySelector(':scope > .moduleHeader .moduleToggle')?.click();
  }
  environmentNoticeKey=noticeKey;
  $('run').textContent=state.job?.status==='waiting_environment'?'继续采集':'开始记录';
  const total=buildKeywordTasks(settings).length;$('progress').textContent=state.job?.status==='waiting_environment'?(state.job.environmentCode==='server_error'?'已暂停 · 亚马逊暂时不可用':'已暂停 · 环境待处理'):state.job?.resumeAt>Date.now()&&state.job.lastErrorCode==='server_error'?'亚马逊暂时不可用 · 等待重试':state.job?`词 ${state.job.keywordIndex+1}/${state.job.keywordTasks.length} · 第 ${state.job.page} 页${state.job.pageAttempt?' · 重试':''}`:'空闲';
  const configuredAsins=new Set(settings.groups.flatMap(group=>group.asins));
  $('lastRun').textContent=state.lastRun?`最近完成：${date(state.lastRun.finishedAt)} · 用时 ${duration(runDuration(state.lastRun))}${state.lastRun.failed?` · ${state.lastRun.failed} 条未完整采集`:''}${state.lastRun.reason?` · ${state.lastRun.reason}`:''}`:`当前配置 ${configuredAsins.size} 个 ASIN · ${total} 个不同关键词`;
  updateElapsed();
  const latest=$('latest');latest.replaceChildren();
  renderHalloween(state.lookupRecords??records);
  renderChristmas(state.lookupRecords??records);
  renderProfileLibrary();
  renderTraffic();
  const resultPairs=new Map();
  for(const pair of configuredPairs(settings)){const key=`${pair.asin}|${pair.keyword.toLowerCase()}`;resultPairs.set(key,{...pair,groups:new Set(pair.groups)});}
  for(const pair of resultPairs.values()){
    const same=records.filter(r=>r.asin===pair.asin&&r.keyword.toLowerCase()===pair.keyword.toLowerCase()).sort((a,b)=>String(a.capturedAt).localeCompare(String(b.capturedAt))),row=same.at(-1),card=element('div','','resultCard');
    card.append(element('h3',pair.keyword),element('div',row?`自然 ${row.rank??'—'}`:'—','rank'));
    card.append(element('div',`${pair.asin} · ${[...pair.groups].join(' / ')} · ${row?date(row.capturedAt):'等待首次采集'}`,'meta'));
    if(row)card.append(element('div',environmentLabel(row),'meta'));
    const ad=spObservation(row),traffic=element('div','','resultTraffic');traffic.append(element('span',ad.text,`spObservation sp-${ad.kind}`),trafficBadge(pair.asin,pair.keyword));card.append(traffic);
    const info=keywordInfo(pair.asin,pair.keyword);card.append(element('div',`${KEYWORD_TIERS[info.tier]} · ${info.basis}`,'meta keywordBasis'));
    card.append(element('div',row?LABELS[row.status]??row.status:'未采集',`status ${row&&!['found','not_found'].includes(row.status)?'error':''}`));
    if(row?.reason)card.append(element('div',row.reason,'reason'));
    if(row)card.append(element('div',`已扫描 ${row.scannedPages}/${row.plannedPages} 页 · ${row.organicResults} 个自然结果`,'meta'));
    if(row&&row.rank===null){const previous=same.slice(0,-1).reverse().find(r=>typeof r.rank==='number');if(previous)card.append(element('div',`上次取得的位置：${previous.rank} · ${date(previous.capturedAt)}（历史数据）`,'previous'));}
    latest.append(card);
  }
  const body=$('historyRows');body.replaceChildren();
  for(const row of records.slice(-100).reverse()){const tr=document.createElement('tr');tr.append(element('td',date(row.capturedAt)));const item=element('td',row.keyword);item.append(element('div',row.asin,'meta'));tr.append(item);tr.append(element('td',row.rank??'—'));const status=element('td',LABELS[row.status]??row.status);if(row.reason)status.append(element('div',row.reason,'meta'));tr.append(status);tr.append(element('td',`${row.scannedPages}/${row.plannedPages} 页 · ${row.organicResults} 个`));body.append(tr);}
  if(!records.length){const tr=document.createElement('tr'),td=element('td','暂无采集记录');td.colSpan=5;tr.append(td);body.append(tr);}
  renderLookup(state.lookupRecords??records);
  const runBody=$('runHistoryRows');runBody.replaceChildren();
  for(const run of [...(state.runs??[])].slice(-30).reverse()){const tr=document.createElement('tr');tr.append(element('td',date(run.startedAt)),element('td',date(run.finishedAt)),element('td',duration(runDuration(run))),element('td',run.status==='complete'?'完成':run.status==='interrupted'?'中断':'部分失败'),element('td',String(run.total??0)));runBody.append(tr);}
  if(!(state.runs??[]).length){const tr=document.createElement('tr'),td=element('td','暂无已完成轮次');td.colSpan=5;tr.append(td);runBody.append(tr);}
}
function updateElapsed(){const run=state.job?{startedAt:state.job.startedAt}:state.lastRun;const ms=state.job?Date.now()-Date.parse(run.startedAt):runDuration(run);$('elapsed').textContent=duration(ms);}
async function refresh(first=false){if(installed)state=await send({type:'state'});if(first)loadSettings();render();if(installed)await loadTrend();if(state.systemError)message(state.systemError,true);}
async function action(fn){if(working)return;working=true;const buttons=[...document.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);try{await fn();await refresh();}catch(error){message(error.message,true);}finally{working=false;buttons.forEach(b=>b.disabled=!installed);renderTraffic();}}
async function save(){await send({type:'save',settings:settingsFromForm()});}
$('settingsForm').addEventListener('submit',event=>{event.preventDefault();action(async()=>{await save();message('设置已保存。');});});
$('addGroup').addEventListener('click',()=>addGroupEditor());
const runFromPanel=()=>action(async()=>{if(!state.job)await save();const r=await send({type:'run'});message(r.note);});
$('run').addEventListener('click',runFromPanel);
$('resumeEnvironment').addEventListener('click',runFromPanel);
$('focusEnvironment').addEventListener('click',()=>action(async()=>{await send({type:'environment-focus'});}));
$('cancelRun').addEventListener('click',()=>action(async()=>{await send({type:'cancel'});message('本轮已结束，已有结果保留。');}));
$('toggle').addEventListener('click',()=>action(async()=>{if(!state.settings.enabled)await save();const result=await send({type:'toggle',enabled:!state.settings.enabled});message(result.note);}));
$('refresh').addEventListener('click',()=>action(async()=>{await refresh();message('结果已刷新。');}));
$('lookupAsin').addEventListener('input',()=>renderLookup(state.lookupRecords??state.records??[]));
$('lookupName').addEventListener('input',()=>renderLookup(state.lookupRecords??state.records??[]));
$('lookupKeyword').addEventListener('input',()=>renderLookup(state.lookupRecords??state.records??[]));
$('lookupStatus').addEventListener('change',()=>renderLookup(state.lookupRecords??state.records??[]));
for(const id of ['trafficAsin','trafficScope','trafficSource'])$(id).addEventListener('change',()=>{trafficPage=0;renderTraffic();});
$('trafficKeyword').addEventListener('input',()=>{trafficPage=0;renderTraffic();});
$('trafficPrev').addEventListener('click',()=>{trafficPage=Math.max(0,trafficPage-1);renderTraffic();});
$('trafficNext').addEventListener('click',()=>{trafficPage++;renderTraffic();});
$('clearLookup').addEventListener('click',()=>{$('lookupAsin').value='';$('lookupName').value='';$('lookupKeyword').value='';$('lookupStatus').value='active';renderLookup(state.lookupRecords??state.records??[]);});
$('profileAsin').addEventListener('change',()=>renderProfileLibrary(true));
$('profileRows').addEventListener('change',rememberProfileDraft);
$('profileExtraWords').addEventListener('input',rememberProfileDraft);
$('profileSave').addEventListener('click',()=>action(async()=>{
  const {asin,words,extra}=profileDraftFromEditor(),settings=settingsFromForm();
  const next=validateSettings({...settings,asinKeywords:{...settings.asinKeywords,[asin]:[...words,...parseLines(extra)]}});
  await send({type:'save',settings:next});profileDrafts.delete(asin);message(`${asin} 的独立选词已保存，下一轮采集生效。`);
}));
$('profileReset').addEventListener('click',()=>{
  const asin=$('profileAsin').value,profile=KEYWORD_PROFILES[asin];
  if(!profile)return;
  profileDrafts.set(asin,{asin,words:profile.terms.filter(term=>term.enabled).map(term=>term.keyword),extra:''});renderProfileLibrary(true);
});
$('profileUseGroups').addEventListener('click',()=>action(async()=>{
  const asin=$('profileAsin').value,settings=settingsFromForm(),overrides={...settings.asinKeywords};delete overrides[asin];
  await send({type:'save',settings:validateSettings({...settings,asinKeywords:overrides})});profileDrafts.delete(asin);message(`${asin} 已改为使用商品组关键词。`);
}));
$('profileApplyAll').addEventListener('click',()=>action(async()=>{
  const settings=applyKeywordProfiles(settingsFromForm());await send({type:'save',settings});profileDrafts.clear();message('当前监控 ASIN 的校准方案已应用；待验证词保留标记，四球款暂保留原词。');
}));
$('saveSeasonConfig').addEventListener('click',()=>saveSeasonConfigFromForm().catch(error=>message(error.message,true)));
$('trendAsin').addEventListener('change',()=>{populateTrendControls();trendCacheKey='';loadTrend(true);});
$('trendKeyword').addEventListener('change',()=>{trendCacheKey='';loadTrend(true);});
$('chooseFolder').addEventListener('click',()=>action(async()=>{
  if(!window.showDirectoryPicker)throw new Error('当前 Chrome 不支持文件夹授权功能，请更新 Chrome 后重试。');
  const handle=await window.showDirectoryPicker({id:'amazon-rank-data',mode:'readwrite'});
  const local=await chrome.storage.local.get(['records','runs','lastRun']);
  const oldRecords=await getAllRecords();
  const result=await chooseExternalDirectory(handle,{runs:state.runs??local.runs??[],lastRun:state.lastRun??local.lastRun??null,legacyRecords:[...(local.records??[]),...oldRecords]});
  await send({type:'external-storage-migrated',runs:state.runs??local.runs??[],lastRun:state.lastRun??local.lastRun??null});
  await refresh();message(`已设置到 ${result.name}；迁移并校验 ${result.migratedRecords} 条排名记录，随后清理了 C 盘扩展旧副本。`);
}));
function download(contents,type,extension){const url=URL.createObjectURL(new Blob([contents],{type})),anchor=document.createElement('a');anchor.href=url;anchor.download=`Amazon_UK_关键词排名_${new Date().toISOString().replace(/[:.]/g,'-')}.${extension}`;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('csv').addEventListener('click',()=>action(async()=>{await refresh();const records=await getAllRecords();download(toCsv(records),'text/csv;charset=utf-8','csv');message(`已导出 ${records.length} 条历史记录。`);}));
$('json').addEventListener('click',()=>action(async()=>{await refresh();const records=await getAllRecords();download(JSON.stringify({exportedAt:new Date().toISOString(),settings:state.settings,lastRun:state.lastRun,runs:state.runs??[],records},null,2),'application/json','json');message(`已导出运行历史及 ${records.length} 条排名记录。`);}));
async function initialize(){await loadTrafficSnapshot();if(installed){const saved=await chrome.storage.local.get(['seasonLayout','seasonConfig','moduleCollapsed','seasonCollapsed']);if(saved.seasonLayout?.order?.length)seasonLayout={order:['halloween','christmas'].filter(id=>saved.seasonLayout.order.includes(id)).concat(['halloween','christmas'].filter(id=>!saved.seasonLayout.order.includes(id))),visible:{...seasonLayout.visible,...saved.seasonLayout.visible}};if(saved.seasonConfig)for(const id of ['halloween','christmas'])if(saved.seasonConfig[id])seasonConfig[id]={...seasonConfig[id],...saved.seasonConfig[id]};const legacyHalloweenTerms=['Halloween lights','Halloween fairy lights','Halloween string lights','Halloween decorations lights','purple and orange Halloween lights','green Halloween lights'];if(seasonConfig.halloween.keywords.length===legacyHalloweenTerms.length&&seasonConfig.halloween.keywords.every(term=>legacyHalloweenTerms.some(old=>old.toLocaleLowerCase()===term.toLocaleLowerCase())))seasonConfig.halloween.keywords=[...HALLOWEEN_GROUP.keywords];moduleCollapsed=saved.moduleCollapsed??{};for(const id of ['halloween','christmas'])if(saved.seasonCollapsed?.[id])moduleCollapsed[`${id}Panel`]=true;await chrome.storage.local.set({seasonConfig});}loadSeasonConfigEditor();initializeCollapsibleModules();renderSeasonLayout();await refresh(true);}
initialize().catch(error=>message(error.message,true));
setInterval(updateElapsed,1000);
if(installed)setInterval(()=>{if(!working)refresh().catch(error=>message(error.message,true));},15000);else{document.querySelectorAll('button').forEach(b=>b.disabled=true);message('这是界面预览。安装 Chrome 插件后，才能采集和导出实际数据。');}

