const marker='#amz-rank-environment';
function ownsAnchor(tab,job){
  try{
    const url=new URL(tab.pendingUrl||tab.url);
    const expectedIncognito=job.environment.mode==='incognito';
    return tab?.incognito===expectedIncognito&&tab.windowId===job.environment.windowId
      &&url.origin==='https://www.amazon.co.uk'&&url.pathname==='/'
      &&(!url.hash||url.hash===marker||/^#amz-rank-environment=/.test(url.hash));
  }catch{return false;}
}
export async function ensureSession(job,api=chrome){
  const {amazonSession}=await api.storage.local.get('amazonSession');
  if(!job.environment&&amazonSession)job.environment=amazonSession;
  let current=job.environment;
  if(current?.mode==='incognito'){
    // Migrate legacy paused jobs out of incognito. Only close the exact window
    // recorded by the extension, then restart the current keyword from page 1.
    await closeSession(job,api);
    delete job.environment;delete job.reviewTabId;
    await api.storage.local.remove?.('amazonSession');
    job.pages=[];job.page=1;job.pageAttempt=0;
    current=null;
  }
  if(current){
    const existing=await api.windows.get(current.windowId).catch(()=>null);
    if(existing){
      if(existing.incognito)throw new Error('当前任务记录的是普通专用窗口，但窗口类型不匹配。请结束本轮后重新开始。');
      let anchor;try{anchor=await api.tabs.get(current.anchorTabId);}catch{}
      if(!anchor)throw new Error('专用采集窗口仍在，但占位页已关闭。请结束本轮后重新开始。');
      if(!ownsAnchor(anchor,job))throw new Error('专用窗口的占位页已被改动，暂不接管该页面。请结束本轮后重新开始。');
      return current;
    }
    delete job.environment;delete job.reviewTabId;
    await api.storage.local.remove?.('amazonSession');
    job.pages=[];job.page=1;job.pageAttempt=0;
  }
  const entry=new URL('https://www.amazon.co.uk/');
  entry.searchParams.set('language','en_GB');entry.searchParams.set('currency','GBP');
  entry.searchParams.set('deliveryPostalCode',job.settings?.expectedLocation??'SW1A 1AA');entry.hash=marker;
  const window=await api.windows.create({focused:false,url:entry.href});
  if(!window||window.incognito||typeof window.tabs?.[0]?.id!=='number')throw new Error('未能建立普通专用采集窗口，未开始采集。');
  job.environment={mode:'regular',windowId:window.id,anchorTabId:window.tabs[0].id,version:3};
  await api.storage.local.set({job,amazonSession:job.environment});
  return job.environment;
}
export async function closeSession(job,api=chrome){
  if(!job?.environment)return;
  try{
    const window=await api.windows.get(job.environment.windowId,{populate:true});
    const anchor=window.tabs?.find(tab=>tab.id===job.environment.anchorTabId);
    if(window.incognito===(job.environment.mode==='incognito')&&anchor&&ownsAnchor(anchor,job))await api.windows.remove(window.id);
  }catch{}
}

// Executed in the Amazon page. Dependencies must stay inside this function.
export async function prepareSearchEnvironment(expectedPostcode,postcodeAlreadyVerified=false){
  const normalize=value=>String(value??'').toUpperCase().replace(/\s/g,'');
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const fail=(code,reason,details={})=>({ok:false,code,reason,...details});
  if(location.hostname!=='www.amazon.co.uk'||location.pathname!=='/s')return fail('environment','采集环境不在 Amazon 英国站搜索页。');
  const earlyDeadline=Date.now()+8000;
  while(Date.now()<earlyDeadline){
    const title=String(document.title??'').trim(),body=document.body?.innerText??'';
    if(/^(50[0234])\b/.test(title)||/^service unavailable\b/i.test(title)||document.querySelector('form[action*="validateCaptcha"], #captchacharacters'))break;
    if(document.querySelector('#nav-global-location-popover-link')&&document.querySelector('#nav-link-accountList-nav-line-1'))break;
    await wait(200);
  }
  const errorTitle=String(document.title??'').trim(),errorBody=String(document.body?.innerText??'').trim();
  const serverStatus=errorTitle.match(/^(50[0234])\b/)?.[1]??errorBody.match(/^(50[0234])\s*(?:[-:]|service|error)/i)?.[1];
  if(serverStatus||/^service unavailable\b/i.test(errorTitle))return fail('server_error',`亚马逊返回 ${serverStatus??'503'}（网页暂时不可用），不是账号登录失败；未取得有效搜索结果。`);
  if(document.querySelector('form[action*="validateCaptcha"], #captchacharacters'))return fail('captcha','亚马逊要求人工验证，请处理后重新开始。');
  const postal=()=>document.querySelector('#glow-ingress-line2')?.textContent?.trim()??'';
  const matches=()=>normalize(postal()).includes(normalize(expectedPostcode));
  // Set the location in Amazon's visible delivery control. URL parameters are
  // only hints; the rendered delivery label is the source of truth.
  if(!postcodeAlreadyVerified&&!matches()){
    const opener=document.querySelector('#nav-global-location-popover-link');
    opener?.click();
    let input;
    for(let i=0;i<20;i++){input=document.querySelector('#GLUXZipUpdateInput');if(input)break;await wait(250);}
    if(input){
      input.focus();input.value=expectedPostcode;input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
      const apply=document.querySelector('#GLUXZipUpdate input[type="submit"], #GLUXZipUpdate button, input#GLUXZipUpdate');
      apply?.click();
      for(let i=0;i<32&&!matches();i++)await wait(250);
      if(matches())document.querySelector('#GLUXConfirmClose, #GLUXConfirmClose-announce')?.click();
    }
  }
  if(postcodeAlreadyVerified){
    const currentPostal=postal();
    if(currentPostal&&!matches())return fail('location',`本轮已确认邮编 ${expectedPostcode}，但当前搜索页显示 ${currentPostal}；为避免记录错误排名，已暂停。请恢复本轮邮编后继续。`);
  }else if(!matches())return fail('location',`Amazon 页面实际配送地区仍未切换：期望 ${expectedPostcode}，页面当前显示“${postal()||'未读取到'}”。已暂停采集，请在专用窗口手动选择英国邮编后再继续。`);
  let account='';
  for(let i=0;i<12;i++){
    account=document.querySelector('#nav-link-accountList-nav-line-1')?.textContent?.trim()??'';
    if(document.querySelector('#nav-item-signout')||/^Hello,/i.test(account)||/sign\s*in/i.test(account))break;
    await wait(250);
  }
  if(document.querySelector('#nav-item-signout')||(/^Hello,/i.test(account)&&!/sign\s*in/i.test(account)))return fail('account','检测到买家账号已登录。请在专用采集窗口退出账号，再点“继续采集”。',{postcodeVerified:true});
  if(!/sign\s*in/i.test(account))return fail('account_unknown',`邮编 ${expectedPostcode} 已确认，但 Amazon 顶部登录提示仍未加载，暂未开始采集。请稍等后点“继续采集”。`,{postcodeVerified:true});
  return {ok:true,environment:{mode:'regular',account:'signed_out',postcode:expectedPostcode,postcodeVerified:postcodeAlreadyVerified||matches(),language:'en_GB',checkedAt:new Date().toISOString(),ipVerified:false}};
}

