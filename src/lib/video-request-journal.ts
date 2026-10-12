import { open, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** Bounded aggregate-only traces survive a console restart; never read footage. */
export async function readVideoRequestJournal(root = process.env.FOOTBALL_VIDEO_LAB_ROOT || path.resolve(process.cwd(),'..','football-ai-lab','data','video_lab')) {
  const events = new Map<string, Record<string, unknown>>();
  let names;
  try { names = await readdir(root,{withFileTypes:true}); } catch { return []; }
  for (const entry of names.filter(e=>(e.isDirectory()||e.isSymbolicLink())&&/^[a-z0-9][a-z0-9_-]{0,63}$/.test(e.name)).sort((a,b)=>b.name.localeCompare(a.name)).slice(0,30)) {
    let file;
    try {
      const checkpoint=path.join(root,entry.name,'hangar-requests.json');
      if ((await stat(checkpoint)).size<1024*1024) {
        for (const event of Object.values(JSON.parse(await readFile(checkpoint,'utf8'))) as Record<string,unknown>[]) {
          if(event.service==='football-video'&&typeof event.rid==='string'&&typeof event.ts==='number')events.set(event.rid,{...event,source:'live'});
        }
      }
    } catch { /* Older producers provide only the append journal. */ }
    try {
      file = await open(path.join(root,entry.name,'hangar-events.jsonl'),'r');
      const size=(await file.stat()).size,start=Math.max(0,size-256*1024);
      const buffer=Buffer.alloc(size-start);
      await file.read(buffer,0,buffer.length,start);
      const lines=buffer.toString('utf8').split('\n');
      if(start) lines.shift();
      for(const line of lines) {
        try {
          const event=JSON.parse(line);
          if(event.service!=='football-video'||typeof event.rid!=='string'||typeof event.ts!=='number')continue;
          const previous=events.get(event.rid);
          if(previous && previous.pending===false && event.pending===true)continue;
          events.set(event.rid,{...event,source:'live'});
        } catch { /* A partial last line cannot erase completed events. */ }
      }
    } catch { /* Most runs have no Hangar journal. */ }
    finally { await file?.close(); }
  }
  return [...events.values()].sort((a,b)=>Number(b.ts)-Number(a.ts)).slice(0,500);
}
