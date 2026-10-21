const DB_NAME='amazon-uk-rank-monitor';
const DATA_FILE='amazon-uk-rank-data';
let opening;
function openDb(){
  if(opening)return opening;
  opening=new Promise((resolve,reject)=>{
    const request=indexedDB.open(DB_NAME,2);
    request.onupgradeneeded=()=>{
      const db=request.result;
      if(!db.objectStoreNames.contains('records')){
        const store=db.createObjectStore('records',{keyPath:'id'});
        store.createIndex('capturedAt','capturedAt');
        store.createIndex('jobId','jobId');
      }
      if(!db.objectStoreNames.contains('meta'))db.createObjectStore('meta');
    };
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>{opening=null;reject(request.error??new Error('无法打开数据目录信息。'));};
    request.onblocked=()=>{opening=null;reject(new Error('数据目录升级被其他打开的监控面板阻塞，请关闭重复的面板后重试。'));};
  });
  return opening;
}
function keyOf(row){return `${row.jobId}|${String(row.keyword??'').toLowerCase()}|${row.asin}`;}
async function getHandle(){
  const db=await openDb();
  return new Promise((resolve,reject)=>{
    const request=db.transaction('meta','readonly').objectStore('meta').get('directory');
    request.onsuccess=()=>resolve(request.result??null);
    request.onerror=()=>reject(request.error??new Error('读取本地目录设置失败。'));
  });
}
async function setHandle(handle){
  const db=await openDb();
  await new Promise((resolve,reject)=>{
    const tx=db.transaction('meta','readwrite');tx.objectStore('meta').put(handle,'directory');
    tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error??new Error('保存本地目录设置失败。'));
  });
}
async function checkPermission(handle,request=false){
  if(!handle)throw new Error('请先在面板中选择本地数据文件夹。');
  let permission=await handle.queryPermission({mode:'readwrite'});
  if(permission!=='granted'&&request)permission=await handle.requestPermission({mode:'readwrite'});
  if(permission!=='granted')throw new Error('数据文件夹尚未授权。请在监控面板中点击“授权/更改数据文件夹”。');
  return handle;
}
async function dataDirectory({requestPermission=false}={}){
  const handle=await checkPermission(await getHandle(),requestPermission);
  return handle;
}
function parseJsonl(text){return text.split(/\r?\n/).filter(Boolean).map(line=>{try{return JSON.parse(line);}catch{return null;}}).filter(Boolean);}
async function listRecordFiles(directory){
  const names=[];
  for await(const [name,handle] of directory.entries())if(handle.kind==='file'&&/^records-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))names.push(name);
  return names.sort();
}
async function readFile(directory,name){
  try{const handle=await directory.getFileHandle(name);return await (await handle.getFile()).text();}
  catch(error){if(error.name==='NotFoundError')return '';throw error;}
}
async function replaceFile(directory,name,text){
  const handle=await directory.getFileHandle(name,{create:true}),writer=await handle.createWritable();
  try{await writer.write(text);await writer.close();}catch(error){await writer.abort().catch(()=>{});throw error;}
}
async function appendFile(directory,name,text){
  const handle=await directory.getFileHandle(name,{create:true}),file=await handle.getFile(),writer=await handle.createWritable({keepExistingData:true});
  try{await writer.seek(file.size);await writer.write(text);await writer.close();}catch(error){await writer.abort().catch(()=>{});throw error;}
}
async function readRuns(directory){
  const raw=await readFile(directory,'runs.json');
  if(!raw)return {runs:[],lastRun:null};
  try{const parsed=JSON.parse(raw);return {runs:Array.isArray(parsed.runs)?parsed.runs:[],lastRun:parsed.lastRun??null};}
  catch{throw new Error('runs.json 格式异常；原文件已保留，请先备份后再处理。');}
}
async function writeRuns(directory,runs,lastRun){await replaceFile(directory,'runs.json',JSON.stringify({version:1,runs:runs.slice(-200),lastRun},null,2));}
async function readRecordsInDirectory(directory){
  const byKey=new Map();
  for(const name of await listRecordFiles(directory))for(const row of parseJsonl(await readFile(directory,name)))byKey.set(keyOf(row),row);
  return [...byKey.values()].sort((a,b)=>String(a.capturedAt).localeCompare(String(b.capturedAt)));
}
async function readAllExternal(){return readRecordsInDirectory(await dataDirectory());}
async function readLegacyRecords(){
  const db=await openDb();
  return new Promise((resolve,reject)=>{
    const request=db.transaction('records','readonly').objectStore('records').getAll();
    request.onsuccess=()=>resolve(request.result.map(({id,...row})=>row));
    request.onerror=()=>reject(request.error??new Error('读取迁移前的排名历史失败。'));
  });
}
async function clearLegacyRecords(){
  const db=await openDb();
  await new Promise((resolve,reject)=>{
    const tx=db.transaction('records','readwrite');tx.objectStore('records').clear();
    tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error??new Error('清理 C 盘旧排名副本失败。'));
  });
}
async function storeRowsExternal(rows){
  if(!rows?.length)return;
  const directory=await dataDirectory(),byDay=new Map();
  for(const row of rows){
    const day=String(row.capturedAt??new Date().toISOString()).slice(0,10);
    if(!byDay.has(day))byDay.set(day,new Map());
    byDay.get(day).set(keyOf(row),row);
  }
  for(const [day,rowsByKey] of byDay){
    const name=`records-${day}.jsonl`,existing=parseJsonl(await readFile(directory,name)),mergedByKey=new Map(existing.map(row=>[keyOf(row),row]));
    for(const [key,row] of rowsByKey)mergedByKey.set(key,row);
    const merged=[...mergedByKey.values()];
    // Daily files are rewritten on update to keep retries idempotent and prevent duplicates.
    await replaceFile(directory,name,merged.map(row=>JSON.stringify(row)).join('\n')+(merged.length?'\n':''));
  }
}
export async function getStorageInfo(){
  const handle=await getHandle();
  if(!handle)return {configured:false,name:null,permission:'missing'};
  let permission='denied';try{permission=await handle.queryPermission({mode:'readwrite'});}catch{}
  return {configured:true,name:handle.name,permission};
}
export async function chooseExternalDirectory(handle,{runs=[],lastRun=null,legacyRecords=[]}={}){
  if(!handle||handle.kind!=='directory')throw new Error('没有取得有效的文件夹。');
  await checkPermission(handle,true);
  const oldHandle=await getHandle();
  let priorExternal=[],priorHistory={runs:[],lastRun:null};
  if(oldHandle){
    await checkPermission(oldHandle,true);
    let same=false;try{same=await oldHandle.isSameEntry(handle);}catch{}
    if(!same){priorExternal=await readRecordsInDirectory(oldHandle);priorHistory=await readRuns(oldHandle);}
  }
  await setHandle(handle);
  const legacy=[...priorExternal,...await readLegacyRecords(),...legacyRecords];
  const legacyByKey=new Map(legacy.map(row=>[keyOf(row),row]));
  const uniqueLegacy=[...legacyByKey.values()];
  const directory=await dataDirectory();
  // Copy and verify before clearing the old browser database.
  await storeRowsExternal(uniqueLegacy);
  const external=await readAllExternal(),externalKeys=new Set(external.map(keyOf));
  const missing=uniqueLegacy.filter(row=>!externalKeys.has(keyOf(row)));
  if(missing.length)throw new Error(`迁移校验未通过：${missing.length} 条记录未在目标文件夹中找到，旧数据仍保留。`);
  const priorRuns=await readRuns(directory);
  const runById=new Map([...priorHistory.runs,...priorRuns.runs,...runs].map(run=>[run.id,run]));
  const migratedRuns=[...runById.values()].slice(-200),migratedLast=lastRun??priorHistory.lastRun??priorRuns.lastRun;
  await writeRuns(directory,migratedRuns,migratedLast);
  await clearLegacyRecords();
  return {ok:true,migratedRecords:uniqueLegacy.length,migratedRuns:migratedRuns.length,name:handle.name};
}
export async function putRecords(rows){await storeRowsExternal(rows);}
export async function getRecentRecords(limit=5000){
  const rows=await getAllRecords();return rows.slice(-limit).reverse();
}
export async function getAllRecords(){
  const info=await getStorageInfo();return info.configured?readAllExternal():readLegacyRecords();
}
export async function getDashboardRecords(limit=5000){
  const rows=await getAllRecords(),latest=new Map(),titles=new Map();
  for(const row of rows){
    const key=`${row.asin}|${String(row.keyword??'').toLocaleLowerCase()}`,prior=latest.get(key);
    if(!prior||String(row.capturedAt)>String(prior.capturedAt))latest.set(key,row);
    if(row.title?.trim()){
      const priorTitle=titles.get(row.asin);
      if(!priorTitle||String(row.capturedAt)>String(priorTitle.capturedAt))titles.set(row.asin,{title:row.title.trim(),capturedAt:row.capturedAt});
    }
  }
  return {records:rows.slice(-limit).reverse(),lookupRecords:[...latest.values()],asinTitles:Object.fromEntries(titles)};
}
export async function getRecordsForRun(jobId){return (await getAllRecords()).filter(row=>row.jobId===jobId);}
export async function getHistoryForPair(asin,keyword){
  const normalized=String(keyword??'').toLocaleLowerCase();
  return (await getAllRecords()).filter(row=>row.asin===asin&&String(row.keyword??'').toLocaleLowerCase()===normalized).sort((a,b)=>String(a.capturedAt).localeCompare(String(b.capturedAt)));
}
export async function deleteRecordsBefore(cutoff){
  const directory=await dataDirectory(),limit=Date.parse(cutoff);
  for(const name of await listRecordFiles(directory)){
    const retained=parseJsonl(await readFile(directory,name)).filter(row=>Date.parse(row.capturedAt)>=limit);
    if(retained.length)await replaceFile(directory,name,retained.map(row=>JSON.stringify(row)).join('\n')+'\n');
    else await directory.removeEntry(name);
  }
}
export async function getRunHistory(){const directory=await dataDirectory();return readRuns(directory);}
export async function appendRunHistory(run){
  const directory=await dataDirectory(),history=await readRuns(directory),byId=new Map(history.runs.map(item=>[item.id,item]));
  byId.set(run.id,run);await writeRuns(directory,[...byId.values()],run);
  return {runs:[...byId.values()].slice(-200),lastRun:run};
}
export async function saveRunHistory(runs,lastRun){const directory=await dataDirectory();await writeRuns(directory,runs,lastRun);}

