import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULTS,validateSettings,ensureHalloweenGroup,makeJob,buildKeywordTasks,finishKeyword} from '../core.mjs';
import {PRODUCT_NAMES} from '../productNames.mjs';
import {KEYWORD_PROFILES} from '../keywordProfiles.mjs';
import {trafficIndex,getTrafficInfo,spObservation,percent} from '../traffic.mjs';

test('first run contains no products, presets or collection tasks',()=>{
  const settings=validateSettings(DEFAULTS);assert.deepEqual(settings.groups,[]);assert.equal(settings.enabled,false);
  assert.equal(Object.keys(PRODUCT_NAMES).length,0);assert.equal(Object.keys(KEYWORD_PROFILES).length,0);
  assert.deepEqual(ensureHalloweenGroup(settings).groups,[]);assert.deepEqual(buildKeywordTasks(settings),[]);
  assert.throws(()=>makeJob(settings),/添加 ASIN 和关键词/);
});
test('user configuration deduplicates keywords and maps only requested products',()=>{
  const settings=validateSettings({groups:[{name:'示例组',asins:['TESTASIN01','TESTASIN02'],keywords:['example keyword']}],asinKeywords:{TESTASIN01:['shared example','first example'],TESTASIN02:['shared example']},pages:1,expectedLocation:'SW1A 1AA'});
  const tasks=buildKeywordTasks(settings);assert.equal(tasks.length,2);assert.deepEqual(tasks[0].asins,['TESTASIN01','TESTASIN02']);
  const job=makeJob(settings);job.pages=[{items:[{asin:'TESTASIN02',page:1,pagePosition:1}],sponsoredItems:[],location:'SW1A 1AA',capturedAt:new Date().toISOString(),url:'https://www.amazon.co.uk/s?k=shared+example'}];
  const rows=finishKeyword(job);assert.equal(rows[0].rank,null);assert.equal(rows[1].rank,1);assert.equal(rows[1].status,'found');
});
test('unknown advertising observations and absent reports do not become zero',()=>{
  assert.equal(getTrafficInfo(trafficIndex(null),'TESTASIN01','example keyword').status,'unavailable');
  assert.equal(percent(null),'—');assert.equal(percent(0),'0.0%');assert.equal(spObservation(null).kind,'pending');assert.equal(spObservation({status:'failed',sponsoredRank:null}).kind,'unknown');
});

