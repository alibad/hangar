import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {readVideoRequestJournal} from '../src/lib/video-request-journal.ts';
test('durable video traces deduplicate heartbeats and retain terminal records after restart',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'hangar-journal-'));
  try {
    await mkdir(path.join(root,'private-run'));
    const e={service:'football-video',rid:'attempt-1',ts:100,pending:true};
    await writeFile(path.join(root,'private-run','hangar-events.jsonl'),[
      JSON.stringify(e),JSON.stringify({...e,ts:200,pending:false,status:206}),JSON.stringify({...e,ts:300}),'{incomplete'].join('\n'));
    const results=await readVideoRequestJournal(root);
    assert.equal(results.length,1);assert.equal(results[0].status,206);assert.equal(results[0].pending,false);
  } finally {assert.equal(path.dirname(root),os.tmpdir());await rm(root,{recursive:true,force:true});}
});
