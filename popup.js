document.getElementById('open').addEventListener('click',()=>chrome.runtime.openOptionsPage());
try {
  const state=await chrome.runtime.sendMessage({type:'state'});
  if(!state?.ok) throw new Error(state?.error??'扩展未响应');
  document.getElementById('summary').textContent=[state.settings.enabled?'每小时监控已开启':'每小时监控未开启',state.job?`正在采集：第 ${state.job.keywordIndex+1} 个关键词、第 ${state.job.page} 页`:'当前没有运行中的采集',`已保存 ${(state.records??[]).length} 条记录`,state.lastRun?.reason??''].filter(Boolean).join('\n');
} catch(error){document.getElementById('summary').textContent=error.message;}

