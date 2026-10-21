(() => {
  if (location.hostname !== 'www.amazon.co.uk' || location.pathname !== '/s') return;
  const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const isSponsored = card => !!card.querySelector('.puis-sponsored-label-text, [aria-label="Sponsored"], [data-component-type="sp-sponsored-result"], [data-component-type="s-sponsored-label-info-icon"]') || /(?:^|\n)\s*Sponsored\s*(?:\n|$)/i.test(card.innerText);
  const styleId = 'amazon-rank-monitor-overlay-style';
  if (!document.getElementById(styleId)) {
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = '.arm-rank-chip{display:flex;flex-wrap:wrap;gap:5px;margin:4px 0 8px;font:600 11px/1.3 system-ui,sans-serif;position:relative;z-index:2}.arm-rank-chip span{display:inline-block;border-radius:999px;padding:4px 8px;background:#e5f3ed;color:#145d47}.arm-rank-chip .arm-ad{background:#fff0d9;color:#94530e}.arm-rank-chip .arm-keyword{color:#526b79;background:#edf2f5;font-weight:500}';
    (document.head ?? document.documentElement).append(style);
  }
  let asinSet = new Set(), scheduled = false;
  function render() {
    scheduled = false;
    const cards = [...document.querySelectorAll('[data-component-type="s-search-result"][data-asin]')];
    if (!cards.length) return;
    let organic = 0, sponsored = 0;
    for (const card of cards) {
      const asin = String(card.getAttribute('data-asin') ?? '').toUpperCase();
      if (!/^[A-Z0-9]{10}$/.test(asin)) continue;
      const ad = isSponsored(card);
      const position = ad ? ++sponsored : ++organic;
      if (!asinSet.has(asin)) continue;
      const title = card.querySelector('h2'), host = title?.parentElement ?? card;
      let chip = host.querySelector(':scope > .arm-rank-chip');
      if (!chip) { chip = document.createElement('div'); chip.className = 'arm-rank-chip'; if(title)title.insertAdjacentElement('afterend',chip);else host.prepend(chip); }
      const keyword = new URL(location.href).searchParams.get('k') ?? '';
      const signature = `${ad ? 'ad' : 'organic'}|${position}|${keyword}`;
      if (chip.dataset.signature === signature) continue;
      chip.dataset.signature = signature;
      chip.replaceChildren();
      if (ad) {
        const label = document.createElement('span'); label.className = 'arm-ad'; label.textContent = `SP广告 · 本页第 ${position} 位`;
        chip.append(label);
      } else {
        const label = document.createElement('span'); label.textContent = `自然位 · 本页第 ${position} 位`;
        chip.append(label);
      }
      if (keyword) { const term = document.createElement('span'); term.className = 'arm-keyword'; term.textContent = keyword; chip.append(term); }
      chip.title = '仅根据当前 Amazon UK 搜索页可见商品卡片计算，不代表流量份额或跨页总排名。';
    }
  }
  function schedule() { if (scheduled) return; scheduled = true; setTimeout(render, 300); }
  chrome.runtime.sendMessage({type:'search-overlay-config'}).then(result => {
    if (!result?.ok) return;
    asinSet = new Set(result.asins ?? []);
    if (!asinSet.size) return;
    schedule();
    new MutationObserver(schedule).observe(document.body, {childList:true,subtree:true});
  }).catch(() => {});
})();

