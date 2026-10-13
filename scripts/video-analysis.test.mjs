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
  const tools=videoAnalysisTools(undefined,async(url,opts)=>{captured={url,headers:opts.headers,body:JSON.parse(opts.body)};return {ok:true,json:async()=>({id:'lab-1',status:'queued'})};});
  const config={source:'existing-private-source',offset_s:900,duration_s:6,sample_fps:5,engines:['rfdetr','sam31']};
  assert.equal(JSON.parse((await tools[0].run({action:'create',config})).text).status,'queued');
  assert.match(captured.url,/\/api\/match\/lab\/jobs$/);
  assert.deepEqual(captured.body,{action:'create',config});
  assert.equal(captured.headers['X-Lab-Purpose'],undefined);
});

test('integration checks mark their runs as tests so the Lab hides them',async()=>{
  const sent=[];
  const tools=videoAnalysisTools(undefined,async(url,opts)=>{sent.push({url,headers:opts.headers,body:opts.body && JSON.parse(opts.body)});
    return {ok:true,json:async()=>(String(url).endsWith('/api/match/lab')
      ? {runs:[{id:'lab-a',title:'t',engines:{}},{id:'lab-b',title:'t',engines:{}}],sources:[],library:{'lab-a':{test:true}}}
      : {id:'lab-2',status:'queued',purpose:'test',jobs:[]})};});
  const config={source:'existing-private-source',offset_s:900,duration_s:2,sample_fps:5,engines:['rfdetr','sam31']};
  assert.equal(JSON.parse((await tools[0].run({action:'create',config,purpose:'test'})).text).purpose,'test');
  assert.equal(sent[0].headers['X-Lab-Purpose'],'test');
  assert.equal(sent[0].headers['X-Source'],'hangar-mcp');
  assert.deepEqual(sent[0].body,{action:'create',config});
  assert.match((await tools[0].run({action:'create',config,purpose:'demo'})).error,/purpose/);
  assert.equal(sent.length,1,'an unknown purpose is refused before any request');
  const list=JSON.parse((await tools[0].run({action:'list'})).text);
  assert.deepEqual(list.runs.map(r=>[r.id,r.test]),[['lab-a',true],['lab-b',false]]);
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
