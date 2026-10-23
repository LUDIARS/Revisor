import assert from 'node:assert/strict';
import test from 'node:test';
import { deliverCompletionNotice } from '../src/completion-notice-delivery.mjs';

function fixture() {
  const record = { id:'pr', jobId:'job1', headSha:'a', checkStatus:'test_ok', status:'merged', mergeCommitSha:'b' };
  const events = [];
  const store = {
    updatePullRequestWith(id, patch) { Object.assign(record, patch(structuredClone(record))); return structuredClone(record); },
    appendPullRequestEvent(id, event) { events.push(event); },
  };
  return {record, events, store};
}

test('claim is durable before I/O; concurrent and repeated callbacks send once', async () => {
  const {store, record, events}=fixture();
  let finish;
  let sends=0;
  const send=async()=>{sends++;assert.equal(record.completionNotice.state,'sending');return new Promise(resolve=>{finish=resolve;});};
  const first=deliverCompletionNotice({store,pullRequest:structuredClone(record),send});
  assert.equal(await deliverCompletionNotice({store,pullRequest:structuredClone(record),send}),false);
  finish(true);assert.equal(await first,true);
  assert.equal(await deliverCompletionNotice({store,pullRequest:structuredClone(record),send}),false);
  assert.equal(sends,1);assert.equal(record.completionNotice.state,'accepted');
  assert.equal(events[0].event,'completion_notice_accepted');
});

test('failed or thrown delivery remains unconfirmed and is never blindly replayed',async()=>{
  for(const throws of [false,true]){
    const {store,record,events}=fixture();let sends=0;
    const send=async()=>{sends++;if(throws)throw new Error('secret transport response');return false;};
    await deliverCompletionNotice({store,pullRequest:structuredClone(record),send});
    await deliverCompletionNotice({store,pullRequest:structuredClone(record),send});
    assert.equal(record.completionNotice.state,'unconfirmed');assert.equal(sends,1);
    assert.equal(record.checkStatus,'test_ok');assert.doesNotMatch(JSON.stringify(events),/secret/);
  }
});

test('a new review can notify and a late previous response cannot overwrite it',async()=>{
  const {store,record,events}=fixture();let finish;
  const old=deliverCompletionNotice({store,pullRequest:structuredClone(record),send:()=>new Promise(resolve=>{finish=resolve;})});
  record.jobId='job2';record.headSha='c';
  await deliverCompletionNotice({store,pullRequest:structuredClone(record),send:async()=>true});
  const evidence=structuredClone(record.completionNotice);
  finish(false);await old;
  assert.deepEqual(record.completionNotice,evidence);assert.equal(events.length,1);
});

test('process interruption retains sending evidence and does not restart transport',async()=>{
  const {store,record}=fixture();
  void deliverCompletionNotice({store,pullRequest:structuredClone(record),send:()=>new Promise(()=>{})});
  let sends=0;
  await deliverCompletionNotice({store,pullRequest:structuredClone(record),send:async()=>{sends++;return true;}});
  assert.equal(record.completionNotice.state,'sending');assert.equal(sends,0);
});
