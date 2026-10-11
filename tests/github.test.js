import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createStore } from '../server/store.js';
import { createAppServer } from '../server/index.js';
import { seedAccount, loginRequest } from './helpers/accounts.mjs';
import { mergeAgentPullRequest, requiredJobs } from '../scripts/merge-agent-pr.mjs';

const repository = 'flo91360/PlaniFiKateur', sha = 'a'.repeat(40), nextSha = 'b'.repeat(40), secret = 'webhook-test-secret';
async function fixture(t, configured = true) {
 const store = createStore(':memory:'), user = seedAccount(store), project = store.read().projects[0], card = project.cards[0];
 store.workflows.configureGithub(project.id, repository, user);
 const { agent, token } = store.workflows.configureAgent({ name: 'Agent', projectIds: [project.id] }, user);
 const server = createAppServer({ store, config: { readToken: 'read-only', githubWebhookSecret: configured ? secret : '' } });
 await new Promise(resolve => server.listen(0,'127.0.0.1',resolve)); const base = `http://127.0.0.1:${server.address().port}/api/v1`;
 const login = await loginRequest(base.replace('/api/v1','')); const cookie = login.headers.get('set-cookie').split(';')[0];
 t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
 const post = (path,data,headers={Cookie:cookie}) => fetch(base+path,{ method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(data) });
 const webhook = (event,data,signingSecret=secret) => { const raw=JSON.stringify(data); return fetch(base+'/github/webhook',{method:'POST',headers:{'Content-Type':'application/json','X-GitHub-Event':event,'X-Hub-Signature-256':'sha256='+createHmac('sha256',signingSecret).update(raw).digest('hex')},body:raw}); };
 const submit = (run,headSha=sha) => store.workflows.agentAction(project.id,card.id,run.id,'submit',{version:run.version,leaseToken:run.leaseToken,summary:'Menu modifié',checks:'Tests lancés sur GitHub',links:[],pullRequest:{url:`https://github.com/${repository}/pull/7`,headSha}},agent);
 const prepare = () => { const r=store.workflows.prepare(project.id,card.id,{objective:'Menu',criteria:'Tests réussis',delivery:'github'},user); return store.workflows.agentAction(project.id,card.id,r.id,'claim',{version:r.version},agent); };
 const merged = (headSha=sha) => ({ action:'closed',repository:{full_name:repository},pull_request:{number:7,merged:true,merged_at:new Date().toISOString(),merge_commit_sha:'c'.repeat(40),head:{sha:headSha,repo:{full_name:repository}},base:{ref:'main'}} });
 const check = conclusion => ({action:'completed',repository:{full_name:repository},workflow_run:{id:42,run_attempt:1,name:'Tests',event:'pull_request',status:'completed',conclusion,head_sha:sha,head_repository:{full_name:repository},html_url:'https://github.com/test'}});
 return {store,user,project,card,agent,token,base,cookie,post,webhook,submit,prepare,merged,check};
}

test('only a signed GitHub merge closes a code task, with idempotency and history',async t=>{
 const f=await fixture(t), run=f.submit(f.prepare()); assert.equal(run.state,'merging');
 assert.throws(()=>f.store.workflows.human(f.project.id,f.card.id,run.id,'accept',{version:run.version},f.user),{code:'invalid_transition'});
 assert.equal((await f.webhook('pull_request',f.merged(),'wrong')).status,401);
 const check=await f.webhook('workflow_run',f.check('success')); assert.equal(check.status,200);
 assert.equal(f.store.workflows.list(f.project.id,f.card.id)[0].state,'merging');
 const eligibility=await fetch(f.base+`/github/merge-eligibility?repository=${repository}&number=7&sha=${sha}`,{headers:{Authorization:`Bearer ${f.token}`}}); assert.equal((await eligibility.json()).data.eligible,true);
 assert.equal((await f.webhook('pull_request',f.merged(nextSha))).status,200); assert.equal(f.store.workflows.list(f.project.id,f.card.id)[0].state,'merging');
 const payload=f.merged(); payload.pull_request.merged_at = new Date(Math.floor(Date.now()/1000)*1000).toISOString(); assert.equal((await f.webhook('pull_request',payload)).status,200);
 const done=f.store.workflows.list(f.project.id,f.card.id)[0]; assert.equal(done.state,'done'); assert.equal(done.submissions[0].decision.automatic,true);
 assert.equal(f.store.read().projects[0].cards[0].status,'done');
 const revision=f.store.getRevision(); await f.webhook('pull_request',payload); assert.equal(f.store.getRevision(),revision);
 assert.equal(f.store.activity({cardId:f.card.id}).filter(e=>e.action==='work.merged').length,1);
});

test('failed checks requeue work; obsolete commits, cancelled work and unmerged closure cannot finish it',async t=>{
 const f=await fixture(t); let run=f.submit(f.prepare());
 const closed=f.merged(); closed.pull_request.merged=false; await f.webhook('pull_request',closed); assert.equal(f.store.workflows.list(f.project.id,f.card.id)[0].state,'merging');
 await f.webhook('workflow_run',f.check('failure')); run=f.store.workflows.list(f.project.id,f.card.id)[0]; assert.equal(run.state,'ready');
 run=f.store.workflows.agentAction(f.project.id,f.card.id,run.id,'claim',{version:run.version},f.agent); run=f.submit(run,nextSha);
 await f.webhook('pull_request',f.merged()); assert.equal(f.store.workflows.list(f.project.id,f.card.id)[0].state,'merging');
 assert.equal(f.store.workflows.mergeEligible(repository,7,sha,f.agent).eligible,false);
 run=f.store.workflows.human(f.project.id,f.card.id,run.id,'cancel',{version:run.version,message:'Demande retirée'},f.user);
 assert.equal(f.store.workflows.mergeEligible(repository,7,nextSha,f.agent).eligible,false);
 await f.webhook('pull_request',f.merged(nextSha)); assert.equal(f.store.workflows.list(f.project.id,f.card.id)[0].state,'cancelled');
});

test('PR identity and commit are mandatory and GitHub delivery requires configuration',async t=>{
 const f=await fixture(t,false), run=f.prepare();
 const path=`/projects/${f.project.id}/cards/${f.card.id}/work`;
 assert.equal((await f.post(path,{objective:'A',criteria:'B',delivery:'github'})).status,503);
 assert.equal((await f.webhook('pull_request',f.merged())).status,503);
 const data={version:run.version,leaseToken:run.leaseToken,summary:'Result',checks:'Tests',links:[],pullRequest:{url:'https://github.com/wrong/repo/pull/7',headSha:sha}};
 assert.throws(()=>f.store.workflows.agentAction(f.project.id,f.card.id,run.id,'submit',data,f.agent),{code:'invalid_pull_request'});
 data.pullRequest.url=`https://github.com/${repository}/pull/7`; delete data.pullRequest.headSha;
 assert.throws(()=>f.store.workflows.agentAction(f.project.id,f.card.id,run.id,'submit',data,f.agent),{code:'invalid_pull_request'});
});

function mergeFixture(change={}) {
 const run={workflow_id:2,id:12,event:'pull_request',status:'completed',conclusion:'success',head_repository:{full_name:repository},head_sha:sha,head_branch:'agent/menu',run_attempt:1,...change.run};
 const pr={number:7,state:'open',draft:false,head:{sha,repo:{full_name:repository}},base:{ref:'main'},labels:[{name:'planifikateur-agent'}],...change.pr};
 const jobs=change.jobs||requiredJobs.map(name=>({name,status:'completed',conclusion:'success',run_attempt:1})); const calls=[];
 const request=async(path,method='GET',data)=>{calls.push({path,method,data}); if(path.includes('/merge'))return {merged:true,sha:'c'.repeat(40)};if(path.includes('/jobs?'))return {jobs,total_count:jobs.length};if(path.endsWith('/ci.yml'))return {id:2};if(path.includes('/actions/runs/'))return run;if(path.includes('/pulls?'))return [pr];if(path.endsWith('/pulls/7'))return pr;if(path.endsWith('/branches/main'))return {commit:{sha:'d'.repeat(40)}};if(path.includes('/compare/'))return {status:change.comparison||'ahead'};throw new Error(path);};
 return {run,pr,calls,request};
}
test('automatic merger checks both suites and merges exactly the tested head commit',async()=>{
 const f=mergeFixture(); const result=await mergeAgentPullRequest({repository,runId:12,request:f.request,eligible:async()=>true}); assert.equal(result.merged,true);
 assert.deepEqual(f.calls.find(c=>c.method==='PUT').data,{sha,merge_method:'squash'});
});
test('automatic merger rejects absent, skipped, failed, unfinished or ambiguous required suites',async()=>{
 for(const jobs of [[],[{name:'Tests serveur',status:'completed',conclusion:'success',run_attempt:1}],...['skipped','failure','cancelled',null].map(conclusion=>requiredJobs.map(name=>({name,status:'completed',conclusion,run_attempt:1}))),requiredJobs.map(name=>({name,status:'in_progress',conclusion:'success',run_attempt:1})),[...requiredJobs.map(name=>({name,status:'completed',conclusion:'success',run_attempt:1})),{name:'Tests serveur',status:'completed',conclusion:'success',run_attempt:1}]]){
  const f=mergeFixture({jobs}); assert.equal((await mergeAgentPullRequest({repository,runId:12,request:f.request,eligible:async()=>true})).merged,false); assert.equal(f.calls.some(c=>c.method==='PUT'),false);
 }
});
test('automatic merger rejects forks, other workflows, stale heads, drafts, missing labels and outdated bases',async()=>{
 for(const change of [{run:{workflow_id:99}},{run:{head_repository:{full_name:'fork/repo'}}},{run:{run_attempt:2}},{pr:{head:{sha:nextSha,repo:{full_name:repository}}}},{pr:{draft:true}},{pr:{labels:[]}},{comparison:'diverged'}]){
  const f=mergeFixture(change); assert.equal((await mergeAgentPullRequest({repository,runId:12,request:f.request,eligible:async()=>true})).merged,false); assert.equal(f.calls.some(c=>c.method==='PUT'),false);
 }
 const f=mergeFixture(); assert.equal((await mergeAgentPullRequest({repository,runId:12,request:f.request,eligible:async()=>false})).reason,'task_not_eligible');
});


test('revise rotates reservations and blocks merging while the agent updates the PR', async t => {
 const f = await fixture(t), submitted = f.submit(f.prepare());
 const response = await f.post(`/projects/${f.project.id}/cards/${f.card.id}/work/${submitted.id}/revise`, { version: submitted.version }, { Authorization: `Bearer ${f.token}` });
 assert.equal(response.status, 200); const revised = (await response.json()).data;
 assert.equal(revised.state, 'running'); assert.match(revised.leaseToken, /^[a-f0-9]{64}$/);
 assert.equal(f.store.workflows.mergeEligible(repository, 7, sha, f.agent).eligible, false);
 await f.webhook('pull_request', f.merged()); assert.equal(f.store.workflows.list(f.project.id, f.card.id)[0].state, 'running');
 const newSubmission = f.submit(revised, nextSha); assert.equal(newSubmission.state, 'merging');
 assert.equal(f.store.workflows.mergeEligible(repository, 7, nextSha, f.agent).eligible, true);
});


test('new tasks inherit their project repository and always use automatic GitHub delivery', async t => {
 const f = await fixture(t), path = `/projects/${f.project.id}/cards/${f.card.id}/work`;
 const invalid = await f.post(path, { delivery: 'manual' });
 assert.equal(invalid.status, 400); assert.equal(f.store.workflows.list(f.project.id, f.card.id).length, 0);
 const response = await f.post(path, {}); assert.equal(response.status, 201);
 const run = (await response.json()).data; assert.equal(run.delivery, 'github'); assert.equal(run.repository, repository);
 const snapshot = f.store.read(), other = structuredClone(f.project);
 other.id = 'other-project'; other.lists.forEach((list, i) => { list.id = `other-list-${i}`; });
 other.cards.forEach((card, i) => { card.id = `other-card-${i}`; card.listId = other.lists[0].id; card.comments = []; card.checklist = []; });
 snapshot.projects.push(other); f.store.write(snapshot.projects, snapshot.revision, f.user);
 assert.throws(() => f.store.workflows.prepare(other.id, other.cards[0].id, {}, f.user), { code: 'github_not_configured' });
 f.store.workflows.configureGithub(other.id, 'flo91360/Klaviflo', f.user);
 const otherRun = f.store.workflows.prepare(other.id, other.cards[0].id, {}, f.user);
 assert.equal(otherRun.repository, 'flo91360/Klaviflo'); assert.equal(otherRun.delivery, 'github');
 f.store.workflows.configureGithub(f.project.id, 'flo91360/NewRepository', f.user);
 assert.equal(f.store.workflows.list(f.project.id, f.card.id)[0].repository, repository);
});

test('preparation without a delivery choice still requires the server webhook secret', async t => {
 const f = await fixture(t, false);
 assert.equal((await f.post(`/projects/${f.project.id}/cards/${f.card.id}/work`, {})).status, 503);
 assert.equal(f.store.workflows.list(f.project.id, f.card.id).length, 0);
});
