import test from 'node:test';
import assert from 'node:assert/strict';
import {videoAnalysisTools} from './video-analysis.mjs';

test('video tools reject remote routing and invalid ids before any request',async()=>{
  assert.throws(()=>videoAnalysisTools('https://example.com'),/loopback/);
  let calls=0;const tools=videoAnalysisTools(undefined,()=>{calls++;});
  assert.match((await tools[0].run({action:'cancel',id:'../outside'})).error,/id/);
  assert.equal(calls,0);
});
test('video MCP dispatches explicit sequential engine jobs through the existing queue',async()=>{
  let captured;
  const tools=videoAnalysisTools(undefined,async(url,opts)=>{captured={url,body:JSON.parse(opts.body)};return {ok:true,json:async()=>({id:'lab-1',status:'queued'})};});
  const config={source:'existing-private-source',offset_s:900,duration_s:6,sample_fps:5,engines:['rfdetr','sam31']};
  assert.equal(JSON.parse((await tools[0].run({action:'create',config})).text).status,'queued');
  assert.match(captured.url,/\/api\/match\/lab\/jobs$/);
  assert.deepEqual(captured.body,{action:'create',config});
});

test('short experiment reports remain usable without full-recording coverage assets',async()=>{
  let calls=0;
  const tools=videoAnalysisTools(undefined,async()=>{
    calls++;return {ok:true,json:async()=>({id:'lab-short',duration_s:2,offset_s:900,engines:{rfdetr:{status:'ready',summary:{sample_count:10,counts:[1,2]}}}})};
  });
  const report=JSON.parse((await tools[0].run({action:'report',id:'lab-short'})).text);
  assert.equal(report.scope,'bounded-clip');assert.equal(calls,1);
  assert.equal(report.engines.rfdetr.summary.sample_count,10);
  assert.equal(report.engines.rfdetr.summary.counts,undefined);
});
