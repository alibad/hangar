/** MCP delegates to the private Lab; no second model server or video upload. */
export function videoAnalysisTools(baseUrl = process.env.FOOTBALL_LAB_URL || 'http://127.0.0.1:3100', fetcher = fetch) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' || !['localhost','127.0.0.1','[::1]'].includes(url.hostname) || url.username || url.password)
    throw new Error('FOOTBALL_LAB_URL must be loopback HTTP');
  const validId = id => typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id);
  const call = async (path, body, extra = {}) => {
    const res = await fetcher(`${url.origin}${path}`, {method:body ? 'POST':'GET',
      headers:{'Content-Type':'application/json','X-Source':'hangar-mcp',...extra},
      ...(body ? {body:JSON.stringify(body)} : {}),signal:AbortSignal.timeout(15000)});
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || `Video Lab returned ${res.status}`);
    return result;
  };
  return [{name:'video_analysis',
    description:'Inspect or run local football video experiments using RF-DETR + ByteTrack and official SAM 3.1. Actions list/status/report are read-only; create/cancel/retry change a specific authorized experiment. Create requires an already registered local source and explicit bounded config; no remote URLs, uploads or identity recognition. GPU admission, renewable shared leases and Requests traces are handled by the worker. Both models run sequentially. Results are provisional pixel observations, not full-game accuracy or calibrated speed. Requires the private local Video Lab on port 3100. Full recording continuation uses retry on its existing job, not a new duplicate run. For integration checks, smoke runs or anything else that is not a real review, create with purpose "test": the Lab then marks the run as a test and hides it from its clip library.',
    inputSchema:{type:'object',properties:{action:{type:'string',enum:['list','status','report','create','cancel','retry']},
      id:{type:'string'},config:{type:'object',properties:{source:{type:'string'},offset_s:{type:'number'},duration_s:{type:'number'},sample_fps:{type:'number'},engines:{type:'array',items:{type:'string',enum:['rfdetr','sam31']}}},required:['source','offset_s','duration_s','sample_fps','engines']},
      purpose:{type:'string',enum:['test'],description:'create only: "test" marks an integration check or smoke run, hidden from the Lab clip library'}},required:['action']},
    run:async args => {
      try {
        let result;
        if (args.action==='list') {
          const data=await call('/api/match/lab');
          result={runs:data.runs.map(r=>({id:r.id,title:r.title,engines:r.engines,test:!!data.library?.[r.id]?.test})),sources:data.sources,
            jobs:(await call('/api/match/lab/jobs')).jobs};
        } else if (args.action==='create') {
          if (!args.config) throw new Error('Explicit bounded config required');
          if (args.purpose!==undefined && args.purpose!=='test') throw new Error('purpose must be "test" when given');
          // the Lab stores purpose "test" on the job (header x-lab-purpose) and keeps it out of its clip library
          result=await call('/api/match/lab/jobs',{action:'create',config:args.config},
            args.purpose==='test' ? {'X-Lab-Purpose':'test'} : {});
        } else {
          if (!validId(args.id)) throw new Error('Valid run/job id required');
          if (['cancel','retry'].includes(args.action)) result=await call('/api/match/lab/jobs',{action:args.action,id:args.id});
          else if (args.action==='status') {
            const m=await call(`/api/match/lab?run=${args.id}`);
            result={id:m.id,full_game:m.full_game,sample_count:m.samples.length,sample_fps:m.sample_fps,
              timing:m.timing,recovery:m.recovery,comparison:m.comparison,accuracy:m.accuracy,attempts:m.attempts,
              artifact_recovery:m.artifact_recovery,artifact_notes:m.artifact_notes,
              engines:Object.fromEntries(Object.entries(m.engines).map(([k,e])=>[k,{...e,summary:e.summary ? {...e.summary,counts:undefined}:undefined}])),
              lab:`${url.origin}/match/lab?run=${args.id}`};
          } else if (args.action==='report') {
            const m=await call(`/api/match/lab?run=${args.id}`);
            if (!m.full_game) {
              result={id:m.id,scope:'bounded-clip',offset_s:m.offset_s,duration_s:m.duration_s,
                accuracy:m.accuracy,comparison:m.comparison,
                engines:Object.fromEntries(Object.entries(m.engines).map(([k,e])=>[k,{...e,summary:e.summary ? {...e.summary,counts:undefined}:undefined}]))};
              return {text:JSON.stringify(result)};
            }
            const c=await call(`/api/match/lab?run=${args.id}&asset=coverage.json`);
            result={audit:c.audit,coverage:Object.fromEntries(['rfdetr','sam31'].map(engine=>{
              const rows=c[engine]||[];
              return [engine,{ready_class_windows:rows.filter(r=>r.status==='ready').length,
                failed:rows.filter(r=>r.status==='failed').map(r=>({class:r.class,start_sample:r.start_sample,end_sample:r.end_sample,error:r.error})),
                candidates:rows.reduce((all,r)=>{for(const f of r.flags||[]) all[f.kind]=(all[f.kind]||0)+1;return all;},{})}];
            }))};
          } else throw new Error('Unknown action');
        }
        return {text:JSON.stringify(result)};
      } catch(e) {return {error:e.message};}
    }}];
}
