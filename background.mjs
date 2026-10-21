import {DEFAULTS, validateSettings, ensureHalloweenGroup, migrateKeywordProfiles, searchUrl, makeJob, buildKeywordTasks, finishKeyword, interruptedRows} from './core.mjs';
import {collectPage} from './collector.mjs';
import {ensureSession,closeSession,prepareSearchEnvironment} from './environment.mjs';
import {putRecords,getDashboardRecords,getRecordsForRun,getHistoryForPair,deleteRecordsBefore,getStorageInfo,getRunHistory,appendRunHistory,saveRunHistory} from './recordsDb.mjs';

const HOURLY = 'rank-hourly';
const STEP = 'rank-page-step';
const KEYWORD_GAP_MS = 350;
const STEP_BUDGET_MS = 90000;
const RETRY_DELAY_MS = 30000;
let busy = false;
let starting = null;
let stepTimer = null;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function badge(text, color = '#155e75') {
  await chrome.action.setBadgeText({text});
  await chrome.action.setBadgeBackgroundColor({color});
}
async function appendRows(rows) {
  await putRecords(rows);
}
async function appendRun(run) {
  const info=await getStorageInfo();
  if(info.configured&&info.permission==='granted'){
    await appendRunHistory(run);return;
  }
  const {runs=[]}=await chrome.storage.local.get('runs');
  const byId=new Map(runs.map(item=>[item.id,item]));byId.set(run.id,run);
  await chrome.storage.local.set({runs:[...byId.values()].slice(-200),lastRun:run});
}
function summarizeRows(id, rows, prior = null) {
  const starts=rows.map(row=>Date.parse(row.startedAt)).filter(Number.isFinite), ends=rows.map(row=>Date.parse(row.capturedAt)).filter(Number.isFinite);
  const startedAt=prior?.startedAt??(starts.length?new Date(Math.min(...starts)).toISOString():null);
  const finishedAt=prior?.finishedAt??(ends.length?new Date(Math.max(...ends)).toISOString():null);
  if(!startedAt||!finishedAt)return null;
  const failed=rows.filter(row=>!['found','not_found'].includes(row.status)).length;
  return {...prior,id,startedAt,finishedAt,durationMs:Math.max(0,Date.parse(finishedAt)-Date.parse(startedAt)),status:prior?.status??(failed?'partial':'complete'),total:prior?.total??rows.length,failed:prior?.failed??failed};
}
function matchesExpectedSearch(tabUrl, expectedUrl) {
  if (!expectedUrl) return false;
  try {
    const actual=new URL(tabUrl), expected=new URL(expectedUrl);
    return actual.origin==='https://www.amazon.co.uk' && actual.pathname==='/s'
      && (actual.searchParams.get('k')??'').trim().toLowerCase()===(expected.searchParams.get('k')??'').trim().toLowerCase()
      && Number(actual.searchParams.get('page')??1)===Number(expected.searchParams.get('page')??1);
  } catch { return false; }
}
async function closeOwnedTab(id, jobId, expectedUrl = '') {
  if (typeof id !== 'number') return;
  try {
    const tab = await chrome.tabs.get(id);
    // Amazon may strip the fragment marker, so also verify the exact UK search query/page.
    // A tab id alone is never enough to close an unrelated tab.
    if (new URL(tab.url).hash === `#amz-rank-job=${jobId}` || matchesExpectedSearch(tab.url,expectedUrl)) await chrome.tabs.remove(id);
  } catch { /* Already closed, navigated away, or no longer accessible. */ }
}
async function syncHourly(settings) {
  const current = await chrome.alarms.get(HOURLY);
  if (!settings.enabled) {if(current) await chrome.alarms.clear(HOURLY); return;}
  if (!current || current.periodInMinutes !== 60) await chrome.alarms.create(HOURLY,{periodInMinutes:60, delayInMinutes:60});
}
async function nextStep(delayMs = 1000) {
  if (stepTimer !== null) clearTimeout(stepTimer);
  // A short timer handles the normal path; an alarm can wake a suspended worker.
  await chrome.alarms.create(STEP,{delayInMinutes:0.5,periodInMinutes:0.5});
  stepTimer=setTimeout(() => {
    stepTimer=null;
    step().catch(console.error);
  },Math.max(0,delayMs));
}
async function pauseStep(job, delayMs) {
  job.status='waiting'; job.resumeAt=Date.now()+delayMs;
  await chrome.storage.local.set({job});
  await nextStep(delayMs);
}
async function initialize() {
  const stored = await chrome.storage.local.get(['settings','job','amazonSession','records','lastRun','runs']);
  let settings = stored.settings?.groups ? validateSettings(stored.settings) : stored.settings ? validateSettings({...DEFAULTS,enabled:stored.settings.enabled===true}) : validateSettings(DEFAULTS);
  settings=ensureHalloweenGroup(settings);
  settings=migrateKeywordProfiles(settings);
  if (!stored.settings || !stored.settings.groups) await chrome.storage.local.set({settings,records:stored.records ?? []});
  else if(JSON.stringify(stored.settings)!==JSON.stringify(settings))await chrome.storage.local.set({settings});
  const recordsByRun=new Map();
  for(const row of stored.records??[]){if(!row.jobId||row.jobId===stored.job?.id)continue;if(!recordsByRun.has(row.jobId))recordsByRun.set(row.jobId,[]);recordsByRun.get(row.jobId).push(row);}
  const runById=new Map((stored.runs??[]).map(run=>[run.id,run]));
  for(const [id,rows] of recordsByRun){const summary=summarizeRows(id,rows,runById.get(id)??(stored.lastRun?.id===id?stored.lastRun:null));if(summary)runById.set(id,summary);}
  const runHistory=[...runById.values()].slice(-200);
  if(runHistory.length!==(stored.runs??[]).length || (stored.lastRun && Number.isFinite(stored.lastRun.durationMs)===false && runById.has(stored.lastRun.id))) {
    const lastRun=stored.lastRun?.id?runById.get(stored.lastRun.id)??stored.lastRun:stored.lastRun;
    await chrome.storage.local.set({runs:runHistory,lastRun});
  }
  if (stored.job && !stored.job.keywordTasks) {
    const old=stored.job, migratedSettings=validateSettings(old.settings);
    old.settings=migratedSettings; old.keywordTasks=buildKeywordTasks(migratedSettings);
    old.keywordIndex=Math.min(old.keywordIndex ?? 0,old.keywordTasks.length-1);
    await chrome.storage.local.set({job:old});
  }
  await syncHourly(settings);
  if (stored.job?.status === 'collecting') {
    const task=stored.job.keywordTasks?.[stored.job.keywordIndex];
    await closeOwnedTab(stored.job.tabId, stored.job.id,task?searchUrl(task.keyword,stored.job.page,stored.job.settings.expectedLocation):'');
    const storage=await getStorageInfo();
    if(!storage.configured||storage.permission!=='granted'){
      stored.job.status='waiting_storage';stored.job.tabId=null;
      await chrome.storage.local.set({job:stored.job,systemError:'本轮任务等待本地数据文件夹授权；设置数据位置后会继续。'});
      await badge('!', '#b45309');
    }else{
      await appendRows(interruptedRows(stored.job));
      const finishedAt=new Date().toISOString();
      const summary={id:stored.job.id,startedAt:stored.job.startedAt,finishedAt,durationMs:Math.max(0,Date.parse(finishedAt)-Date.parse(stored.job.startedAt)),status:'interrupted',reason:'浏览器或扩展重启，本次采集未完成；已保留此前结果。'};
      await appendRun(summary);await chrome.storage.local.set({job:null});await badge('!', '#b45309');
      await closeSession(stored.job.environment?stored.job:{...stored.job,environment:stored.amazonSession});
      await chrome.storage.local.remove('amazonSession');
    }
  } else if (stored.job?.status==='waiting_environment') {
    await badge('!', '#b45309');
  } else if (stored.job) await nextStep(Math.max(0,(stored.job.resumeAt??0)-Date.now()));
}
const ready = initialize().catch(async error => {
  console.error(error);
  await chrome.storage.local.set({systemError:error.message});
  await badge('!', '#b91c1c');
});
async function startRunOnce() {
  await ready;
  const storage=await getStorageInfo();
  if(!storage.configured||storage.permission!=='granted')throw new Error('请先设置本地数据文件夹：打开监控面板，点击“选择数据文件夹并迁移数据”。完成后才能开始采集。');
  const {job, settings} = await chrome.storage.local.get(['job','settings']);
  if(job?.status==='waiting_environment'){
    await closeOwnedTab(job.reviewTabId,job.id,searchUrl(job.keywordTasks[job.keywordIndex].keyword,job.page,job.settings.expectedLocation));
    delete job.reviewTabId;delete job.resumeAt;delete job.environmentCode;delete job.environmentReason;delete job.lastErrorCode;job.pageAttempt=0;job.status='waiting';
    await chrome.storage.local.set({job,systemError:null});await nextStep(0);
    return {ok:true,note:'已继续采集，将重新校验专用窗口、未登录状态和配送邮编。',jobId:job.id};
  }
  if (job) return {ok:true,note:'本次采集仍在进行，未重复创建任务。',jobId:job.id};
  const newJob = makeJob(validateSettings(settings));
  await chrome.storage.local.set({job:newJob,systemError:null});
  await badge('RUN'); await nextStep(0);
  return {ok:true,note:'已启动连续采集，正在读取第一页；完成每个词后保存结果。',jobId:newJob.id};
}
function startRun() {
  if (!starting) starting = startRunOnce().finally(() => {starting=null;});
  return starting;
}
async function waitForDocument(id) {
  const deadline=Date.now()+15000;
  while(Date.now()<deadline){
    const tab=await chrome.tabs.get(id);
    let url;try{url=new URL(tab.pendingUrl||tab.url);}catch{}
    if(url?.origin==='https://www.amazon.co.uk'&&(url.pathname==='/s'||url.pathname==='/ap/signin')&&!tab.pendingUrl)return tab;
    await sleep(150);
  }
  const tab=await chrome.tabs.get(id);
  throw new Error(`搜索页导航超时（15秒）：${tab.title||'无标题'}；${tab.url||'无法读取地址'}`);
}
async function readPage(job) {
  let tabId = null;
  let keepForReview=false;
  const keyword = job.keywordTasks[job.keywordIndex].keyword;
  let expectedUrl = searchUrl(keyword,job.page,job.settings.expectedLocation);
  try {
    let session;try{session=await ensureSession(job);}catch(error){return {ok:false,code:'environment',reason:error.message,url:expectedUrl};}
    expectedUrl=searchUrl(keyword,job.page,job.settings.expectedLocation);
    const pageUrl = new URL(expectedUrl);
    pageUrl.hash = `amz-rank-job=${job.id}`;
    const tab = await chrome.tabs.create({windowId:session.windowId,url:pageUrl.href,active:false});
    tabId = tab.id; job.tabId = tab.id;
    if(tab.incognito||tab.windowId!==session.windowId)return {ok:false,code:'environment',reason:'采集页不在插件创建的普通专用窗口，已拒绝读取。'};
    await chrome.storage.local.set({job});
    await waitForDocument(tab.id);
    // Amazon may finish one navigation and immediately redirect the tab.
    // Retry only when injection returns no result; keep normal-page latency low.
    const postcodeAlreadyVerified=job.environment?.postcodeVerified===job.settings.expectedLocation;
    let environment=null,observedTab=null,lastInjectionError='';
    for(let attempt=0;attempt<3&&!environment;attempt++){
      observedTab=await chrome.tabs.get(tab.id);
      let observedUrl;try{observedUrl=new URL(observedTab.url);}catch{}
      if(observedUrl?.hostname==='www.amazon.co.uk'&&observedUrl.pathname==='/ap/signin'){
        environment={ok:false,code:'account_unknown',reason:'亚马逊把搜索页跳转到了登录页，当前没有可采集的搜索结果。请在专用窗口确认未登录状态和邮编后，再继续采集。',postcodeVerified:postcodeAlreadyVerified};
        break;
      }
      try{
        const prepared=await chrome.scripting.executeScript({target:{tabId:tab.id},func:prepareSearchEnvironment,args:[job.settings.expectedLocation,postcodeAlreadyVerified],injectImmediately:true});
        environment=prepared[0]?.result??null;
      }catch(error){lastInjectionError=error.message;}
      if(!environment&&attempt<2){await sleep(300);await waitForDocument(tab.id);}
    }
    if(!environment){
      observedTab=await chrome.tabs.get(tab.id);
      environment={ok:false,code:'environment',reason:`未收到亚马逊环境校验结果。${lastInjectionError?`注入提示：${lastInjectionError}。`:''}当前页面：${observedTab.title||'无标题'}；地址：${observedTab.url||'无法读取'}。搜索结果未采集。`};
    }
    if((environment?.postcodeVerified||environment?.environment?.postcodeVerified)&&!postcodeAlreadyVerified){
      job.environment.postcodeVerified=job.settings.expectedLocation;
      await chrome.storage.local.set({job,amazonSession:job.environment});
    }
    if(!environment?.ok){
      keepForReview=['environment','location','account','account_unknown'].includes(environment?.code)||(environment?.code==='server_error'&&job.pageAttempt===1);
      if(keepForReview)job.reviewTabId=tab.id;
      return environment??{ok:false,code:'environment',reason:'未收到采集环境校验结果。'};
    }
    const results = await chrome.scripting.executeScript({target:{tabId:tab.id},func:collectPage,args:[job.settings.expectedLocation,keyword,job.page,true],injectImmediately:true});
    if (!results[0]?.result) throw new Error('未收到页面采集结果。');
    const result=results[0].result;
    if(result.ok)result.environment=environment.environment;
    else if(['location','account','account_unknown'].includes(result.code)||(result.code==='server_error'&&job.pageAttempt===1)){keepForReview=true;job.reviewTabId=tab.id;}
    return result;
  } catch (error) {
    return {ok:false,code:'transport',reason:error.message,url:expectedUrl};
  } finally {
    if(!keepForReview)await closeOwnedTab(tabId, job.id,expectedUrl); job.tabId = null;
  }
}
async function finishJob(job, reason = '') {
  await closeOwnedTab(job.reviewTabId,job.id,searchUrl(job.keywordTasks[job.keywordIndex]?.keyword??'',job.page,job.settings.expectedLocation));
  const {amazonSession}=await chrome.storage.local.get('amazonSession');
  await closeSession(job.environment?job:{...job,environment:amazonSession});
  await chrome.storage.local.remove('amazonSession');
  const rows = await getRecordsForRun(job.id);
  const failed = rows.filter(row => !['found','not_found'].includes(row.status)).length;
  const finishedAt=new Date().toISOString();
  const summary={id:job.id,startedAt:job.startedAt,finishedAt,durationMs:Math.max(0,Date.parse(finishedAt)-Date.parse(job.startedAt)),status:failed?'partial':'complete',reason,total:rows.length,failed};
  await appendRun(summary);
  const storage=await getStorageInfo();await chrome.storage.local.set(storage.configured&&storage.permission==='granted'?{job:null}:{job:null,lastRun:summary});
  try {await deleteRecordsBefore(new Date(Date.now()-30*24*60*60*1000).toISOString());}
  catch(error){console.warn('排名历史过期清理失败：',error);}
  if (stepTimer !== null) {clearTimeout(stepTimer);stepTimer=null;}
  await chrome.alarms.clear(STEP);
  await badge(failed ? '!' : 'OK',failed?'#b45309':'#047857');
}
async function step() {
  await ready;
  if (busy) return;
  if (stepTimer !== null) {clearTimeout(stepTimer);stepTimer=null;}
  busy = true;
  const stepStartedAt=Date.now();
  let job;
  try {
    ({job} = await chrome.storage.local.get('job'));
    if (!job) {await chrome.alarms.clear(STEP);return;}
    if(job.status==='waiting_environment'){await chrome.alarms.clear(STEP);return;}
    if(!job.environment&&job.pages.length){
      await appendRows(interruptedRows(job,'采集环境已升级，本轮旧会话到此结束；请重新开始采集。'));await finishJob(job,'采集环境升级，避免混用旧会话。');return;
    }
    if (job.resumeAt>Date.now()) {await nextStep(job.resumeAt-Date.now());return;}
    const storage=await getStorageInfo();
    if(!storage.configured||storage.permission!=='granted'){
      job.status='waiting_storage';
      await chrome.storage.local.set({job,systemError:'本轮任务等待本地数据文件夹授权；在监控面板设置数据位置后会继续。'});return;
    }
    delete job.resumeAt;
    await chrome.storage.local.set({systemError:null});
    while (job.keywordIndex < job.keywordTasks.length) {
      job.status = 'collecting';
      await chrome.storage.local.set({job});
      let result;
      while (true) {
        result = await readPage(job);
        if(!result.ok&&(['environment','location','account','account_unknown'].includes(result.code)||(result.code==='server_error'&&job.pageAttempt===1))){
          job.status='waiting_environment';job.environmentCode=result.code;job.environmentReason=result.reason+(result.code==='server_error'?' 已延后重试一次仍失败，请稍后点击“继续采集”。':'');
          await chrome.storage.local.set({job,systemError:result.reason});
          await chrome.alarms.clear(STEP);await badge('!', '#b45309');return;
        }
        if (!result.ok && ['transport','timeout','server_error'].includes(result.code) && !job.pageAttempt) {
          job.pageAttempt = 1; job.lastError = result.reason;job.lastErrorCode=result.code;
          await pauseStep(job,RETRY_DELAY_MS); return;
        }
        if (!result.ok && ['captcha','blocked','location','redirect'].includes(result.code)) {
          await appendRows(interruptedRows(job,result.reason));
          await finishJob(job,result.reason); return;
        }
        if (result.ok) job.pages.push(result);
        if (!result.ok || job.page >= job.settings.pages || result.noResults) break;
        // Read the next page for the same keyword immediately.
        job.page++; job.pageAttempt = 0; job.status = 'collecting';
        await chrome.storage.local.set({job});
        // Yield at a persisted page boundary instead of keeping one request alive for a full run.
        if(Date.now()-stepStartedAt>=STEP_BUDGET_MS){await pauseStep(job,1000);return;}
      }
      await appendRows(finishKeyword(job,result.ok?null:result.reason));
      job.keywordIndex++;
      if (job.keywordIndex >= job.keywordTasks.length) {await finishJob(job); return;}
      job.page = 1; job.pageAttempt = 0; job.pages = [];
      if(Date.now()-stepStartedAt>=STEP_BUDGET_MS){await pauseStep(job,KEYWORD_GAP_MS);return;}
      await chrome.storage.local.set({job});
      await sleep(KEYWORD_GAP_MS);
    }
  } catch (error) {
    if (job) {
      await appendRows(interruptedRows(job,error.message));
      await finishJob(job,error.message);
    }
    await chrome.storage.local.set({systemError:error.message}); await badge('!', '#b91c1c');
  } finally {busy = false;}
}
chrome.alarms.onAlarm.addListener(alarm => {
  const operation = alarm.name === HOURLY ? async () => {
    await ready;
    const {settings,job} = await chrome.storage.local.get(['settings','job']);
    if (settings?.enabled&&job?.status!=='waiting_environment') await startRun();
  } : alarm.name === STEP ? step : null;
  if (operation) operation().catch(console.error);
});
chrome.runtime.onStartup.addListener(() => ready.catch(console.error));
chrome.runtime.onInstalled.addListener(() => ready.catch(console.error));
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
chrome.runtime.onMessage.addListener((message,sender,sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  (async () => {
    await ready;
    if (message.type === 'state') {
      const data = await chrome.storage.local.get(['settings','job','amazonSession','lastRun','runs','systemError']);
      const alarm = await chrome.alarms.get(HOURLY);
      const storage=await getStorageInfo();
      let externalHistory=null;
      if(storage.configured&&storage.permission==='granted')externalHistory=await getRunHistory();
      const {records,lookupRecords,asinTitles}=await getDashboardRecords(5000);
      return {ok:true,...data,environment:{mode:'regular',allowed:true},runs:externalHistory?.runs??data.runs??[],lastRun:externalHistory?.lastRun??data.lastRun,storage,records,lookupRecords,asinTitles,nextRun:alarm?.scheduledTime ?? null};
    }
    if(message.type==='search-overlay-config'){
      const {settings}=await chrome.storage.local.get('settings');
      return {ok:true,asins:[...new Set((settings?.groups??[]).flatMap(group=>group.asins??[]))]};
    }
    if(message.type==='trend'){
      const asin=String(message.asin??'').trim().toUpperCase(),keyword=String(message.keyword??'').trim();
      if(!/^[A-Z0-9]{10}$/.test(asin)||!keyword||keyword.length>120)throw new Error('请选择有效的 ASIN 和关键词。');
      return {ok:true,rows:await getHistoryForPair(asin,keyword)};
    }
    if (message.type === 'run') return startRun();
    if(message.type==='environment-focus'){
      const {job,amazonSession}=await chrome.storage.local.get(['job','amazonSession']);
      const environment=job?.environment??amazonSession;
      if(!environment)throw new Error('当前没有专用采集窗口。请先开始记录。');
      const tab=await chrome.tabs.get(job?.reviewTabId??environment.anchorTabId);
      if(tab.windowId!==environment.windowId||tab.incognito)throw new Error('采集窗口已关闭；开始下一轮时会自动重建并设置邮编。');
      await chrome.tabs.update(tab.id,{active:true});await chrome.windows.update(tab.windowId,{focused:true});return {ok:true};
    }
    if(message.type==='cancel'){
      if(busy)throw new Error('正在读取页面，请稍后再结束本轮。');
      const {job}=await chrome.storage.local.get('job');
      if(job){await appendRows(interruptedRows(job,'用户结束本轮采集。'));await finishJob(job,'用户结束本轮采集。');}
      return {ok:true};
    }
    if (message.type === 'save') {
      const current = await chrome.storage.local.get(['settings','job']);
      if (current.job) throw new Error('请等待本次采集结束后再修改配置。');
      const settings = validateSettings({...message.settings,enabled:current.settings?.enabled === true});
      await chrome.storage.local.set({settings}); await syncHourly(settings); return {ok:true};
    }
    if (message.type === 'toggle') {
      const storage=await getStorageInfo();
      if(message.enabled===true&&(!storage.configured||storage.permission!=='granted'))throw new Error('请先设置并授权本地数据文件夹，再开启每小时监控。');
      const {settings} = await chrome.storage.local.get('settings');
      const updated = {...settings,enabled:message.enabled === true};
      await chrome.storage.local.set({settings:updated}); await syncHourly(updated);
      return {ok:true,note:updated.enabled?'每小时监控已开启；可以点“立即试采”检查首批结果。':'定时监控已暂停；当前已开始的采集会继续完成。'};
    }
    if(message.type==='external-storage-migrated'){
      const local=await chrome.storage.local.get(['records','runs','lastRun']);
      await saveRunHistory(message.runs??local.runs??[],message.lastRun??local.lastRun??null);
      await chrome.storage.local.remove(['records','runs','lastRun']);
      const {job}=await chrome.storage.local.get('job');if(job)await nextStep(Math.max(0,(job.resumeAt??0)-Date.now()));
      return {ok:true};
    }
    throw new Error('未知操作。');
  })().then(sendResponse,error => sendResponse({ok:false,error:error.message}));
  return true;
});
export {ready, startRun, step};

