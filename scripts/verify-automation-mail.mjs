// Isolated HTTP fixtures. No provider or database credentials required.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
registerHooks({resolve(specifier, context, next) {
  const base = specifier.startsWith('@/') ? new URL(specifier.slice(2),root)
    : specifier.startsWith('.') && context.parentURL?.startsWith(root.href+'lib/') ? new URL(specifier,context.parentURL) : null;
  if (base && existsSync(fileURLToPath(base)+'.ts')) return next(base.href+'.ts',context);
  return next(specifier,context);
}});
process.env.SUPABASE_URL='https://test-db.invalid';
process.env.SUPABASE_SECRET_KEY='fixture';
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.CAFE_MAIL_MODE;
const facts = {receipt:'short',kind:'short',reference:'SIM-TEST',ingredient:'Milk',ordered:'5000',received:'4000',difference:'1000',unit:'ml',supplier:'Demo Dairy'};
const fresh = () => ({event_id:'test-event',payload:null,channel:null,status:'queued',started_at:null,facts});
let job=fresh(), fail=false;
const requests=[];
globalThis.fetch=async (input,init)=>{
  const req=new Request(input,init), u=new URL(req.url);
  if(u.hostname==='api.resend.com'){
    requests.push({key:req.headers.get('Idempotency-Key'),body:await req.text()});
    return fail ? new Response(null,{status:503}) : Response.json({id:'mock-ack'});
  }
  assert.equal(u.hostname,'test-db.invalid');
  if(u.pathname.endsWith('/delivery_shortage_drafts'))
    return Response.json({receipt_id:'short',approach:null,facts:{...facts,missing:'1000',stockAfter:'4000',minimum:'5000'}});
  if(u.pathname.endsWith('/rpc/prepare_cafe_test_mail')){
    const args=await req.json();
    if(!job.payload) Object.assign(job,{channel:args.p_channel,payload:args.p_payload,started_at:new Date().toISOString()});
    return Response.json(job);
  }
  assert.ok(u.pathname.endsWith('/cafe_test_mail'));
  if(req.method==='PATCH'){Object.assign(job,await req.json());return new Response(null,{status:204});}
  return Response.json(job);
};
const {deliverTestMail}=await import('../lib/automation/mail.ts');
assert.equal(await deliverTestMail('test-event'),'delivered_to_demo');
assert.match(job.payload.text,/received 4000 ml in total/); assert.match(job.payload.subject,/SIM-TEST/); assert.equal(requests.length,0);
job=fresh(); job.facts={...facts,kind:'extra',received:'6000'};
Object.assign(process.env,{CAFE_MAIL_MODE:'resend',RESEND_API_KEY:'fixture',CAFE_TEST_MAIL_FROM:'demo@from.invalid',CAFE_TEST_MAIL_TO:'tester@to.invalid'});
fail=true; assert.equal(await deliverTestMail('test-event'),'queued');
fail=false; assert.equal(await deliverTestMail('test-event'),'provider_accepted');
assert.equal(await deliverTestMail('test-event'),'provider_accepted');
assert.equal(requests.length,2); assert.deepEqual(requests[1],requests[0]);
assert.equal(JSON.parse(requests[0].body).to,'tester@to.invalid');
job.status='queued'; job.started_at='2000-01-01T00:00:00Z';
assert.equal(await deliverTestMail('test-event'),'check_delivery'); assert.equal(requests.length,2);
console.log('PASS in-app test mailbox, shortage message, fixed test recipient, provider retry, duplicate suppression and expired key');
