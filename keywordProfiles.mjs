// No private ASINs, keyword profiles or SIF exports are bundled.
export const KEYWORD_PROFILE_VERSION='user-configured-v1';
export const KEYWORD_PROFILES=Object.freeze({});
export const KEYWORD_TIERS=Object.freeze({core:'核心',secondary:'辅助',advertising:'广告曝光依据',pending:'待验证',custom:'自定义'});
export function keywordInfo(asin,keyword){return {keyword,tier:'custom',basis:'用户手动设置的关键词。'};}

