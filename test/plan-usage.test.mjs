import test from 'node:test';
import assert from 'node:assert/strict';
import { usageView, USAGE_MAX_AGE } from '../web/plan-usage.js';
const now=1800000000000;
test('usage is provider-scoped, timestamped and not a live claim',()=>{
 const row={engine:'claude',at:now,fiveHour:0.51,sevenDay:0.77};
 assert.equal(usageView(row,'claude',now).fiveHour,51);
 assert.match(usageView(row,'claude',now).note,/not live/);
 for(const invalid of [null,{...row,engine:'codex'},{...row,engine:undefined},{...row,at:now-USAGE_MAX_AGE},{...row,at:now+1}])assert.equal(usageView(invalid,'claude',now).fiveHour,null);
});
test('unknown and invalid usage never become zero; a true zero is retained',()=>{
 for(const value of [null,undefined,NaN,Infinity,-1,51,'0.5'])assert.equal(usageView({engine:'claude',at:now,fiveHour:value},'claude',now).fiveHour,null);
 const v=usageView({engine:'claude',at:now,fiveHour:0},'claude',now);assert.equal(v.fiveHour,0);assert.equal(v.sevenDay,null);
});

import { claudeUsage } from '../server/plan-usage.mjs';
test('Claude current single-window and legacy window events preserve fractions',()=>{
 assert.deepEqual(claudeUsage({rateLimitType:'five_hour',utilization:0.42},now),{engine:'claude',at:now,fiveHour:0.42,sevenDay:null});
 assert.equal(claudeUsage({rateLimitType:'seven_day',utilization:0},now).sevenDay,0);
 assert.equal(claudeUsage({unifiedWindows:{five_hour:{utilization:0.51},seven_day:{utilization:0.77}}},now).sevenDay,0.77);
 for(const info of [{rateLimitType:'seven_day_opus',utilization:0.5},{rateLimitType:'five_hour'},{rateLimitType:'five_hour',utilization:51},{status:'allowed'},null])assert.equal(claudeUsage(info,now),null);
});
