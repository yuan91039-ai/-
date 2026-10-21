// Injected into the page's isolated world. All dependencies must be local to this function.
export async function collectPage(expectedLocation, expectedKeyword, expectedPage, requireGuest=false) {
  const normalize = text => String(text ?? '').toUpperCase().replace(/\s+/g, '');
  const fail = (code, reason) => ({ok:false, code, reason, url:location.href, capturedAt:new Date().toISOString()});
  const deadline = Date.now() + 18000;
  while (Date.now() < deadline) {
    const bodyText = document.body?.innerText ?? '';
    const serverStatus=String(document.title??'').trim().match(/^(50[0234])\b/)?.[1]??bodyText.trim().match(/^(50[0234])\s*(?:[-:]|service|error)/i)?.[1];
    if(serverStatus)return fail('server_error',`亚马逊返回 ${serverStatus}（网页暂时不可用），本页没有取得有效搜索结果。`);
    if (document.querySelector('form[action*="validateCaptcha"], #captchacharacters') || /enter the characters you see below|robot check|verify you are a human/i.test(bodyText) || /validateCaptcha/.test(location.href)) return fail('captcha','亚马逊要求人工验证，请打开英国站手动处理。');
    if (/sorry! something went wrong|sorry, we just need to make sure|click the button below to continue shopping/i.test(bodyText)) return fail('blocked','亚马逊返回拦截或错误页面。');
    const cards = [...document.querySelectorAll('[data-component-type="s-search-result"][data-asin]')];
    const noResults = /no results for|did not match any products/i.test(bodyText);
    if (cards.length || noResults) {
      if(requireGuest){
        const account=document.querySelector('#nav-link-accountList-nav-line-1')?.textContent??'';
        if(document.querySelector('#nav-item-signout')||!/sign\s*in/i.test(account))return fail('account','未确认未登录状态，已暂停采集；请在专用采集窗口退出买家账号。');
      }
      const actual = new URL(location.href);
      if (actual.hostname !== 'www.amazon.co.uk' || actual.pathname !== '/s' || (actual.searchParams.get('k') ?? '').trim().toLowerCase() !== expectedKeyword.trim().toLowerCase()) return fail('redirect','页面跳转，未处于本次关键词的英国站搜索页。');
      if (expectedPage > 1 && Number(actual.searchParams.get('page') ?? 1) !== expectedPage) return fail('pagination','搜索翻页未生效，不能重复计算同一页。');
      const locationText = document.querySelector('#glow-ingress-line2')?.textContent?.trim() ?? '';
      if (!normalize(locationText).includes(normalize(expectedLocation))) return fail('location',`配送地区未确认：期望 ${expectedLocation}，页面显示 ${locationText || '未读取到'}。请先在英国站设置配送地区。`);
      // Allow late sponsored labels and result tiles to render before classification.
      await new Promise(resolve => setTimeout(resolve, 1000));
      const finalCards = [...document.querySelectorAll('[data-component-type="s-search-result"][data-asin]')];
      const items = [], sponsoredItems = []; let sponsoredCount = 0; let malformed = 0;
      for (const card of finalCards) {
        const asin = card.getAttribute('data-asin');
        if (!/^[A-Z0-9]{10}$/.test(asin ?? '')) {
          if (card.querySelector('a[href*="/dp/"], a[href*="/gp/aw/d/"]')) malformed++;
          continue;
        }
        const isAd = !!card.querySelector('.puis-sponsored-label-text, [aria-label="Sponsored"], [data-component-type="sp-sponsored-result"], [data-component-type="s-sponsored-label-info-icon"]') || /(?:^|\n)\s*Sponsored\s*(?:\n|$)/i.test(card.innerText);
        if (isAd) {
          sponsoredCount++;
          if(card.querySelector('a[href*="/dp/"], a[href*="/gp/aw/d/"]'))sponsoredItems.push({asin,title:(card.querySelector('h2')?.innerText??'').trim().slice(0,300),page:expectedPage,pagePosition:sponsoredItems.length+1,adType:'SP'});
          continue;
        }
        if (!card.querySelector('a[href*="/dp/"], a[href*="/gp/aw/d/"]')) {malformed++; continue;}
        items.push({asin, title:(card.querySelector('h2')?.innerText ?? '').trim().slice(0,300), page:expectedPage, pagePosition:items.length+1});
      }
      if (malformed) return fail('structure',`有 ${malformed} 个搜索结果结构无法确认，暂停计算以免位置错位。`);
      if (!items.length && !noResults) return fail('empty','未读到有效自然搜索结果，不能判定商品没有排名。');
      return {ok:true, url:actual.href, capturedAt:new Date().toISOString(), location:locationText, items, sponsoredItems, sponsoredCount, noResults};
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return fail('timeout','等待搜索结果超时（18秒），本次未取得有效页面。');
}

