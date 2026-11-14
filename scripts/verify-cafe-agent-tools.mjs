// Run on Node 24 with --conditions=react-server. All HTTP responses are local fixtures.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
registerHooks({resolve(specifier, context, next) {
  const base = specifier.startsWith('@/') ? new URL(specifier.slice(2),root)
    : specifier.startsWith('.') && context.parentURL?.startsWith(root.href + 'lib/')
      ? new URL(specifier,context.parentURL) : null;
  if (base && existsSync(fileURLToPath(base)+'.ts')) return next(base.href+'.ts',context);
  return next(specifier,context);
}});
process.env.SUPABASE_URL='https://test-db.invalid';
process.env.SUPABASE_SECRET_KEY='fixture';
process.env.GOOGLE_GENERATIVE_AI_API_KEY='fixture';
process.env.GEMINI_MODEL='gemini-fixture';
const row={receipt_id:'demo',facts:{reference:'PO-7',supplier:'Demo Dairy',ingredient:'Milk',unit:'ml',received:'4000',ordered:'5000',missing:'1000',stockAfter:'4800',minimum:'5000'},approach:null};
let modelCalls=0,chosen='replacement_eta';
const logs=[];
globalThis.fetch=async (input, init) => {
  const request=new Request(input,init),url=new URL(request.url);
  const json=value=>Response.json(value);
  if(url.hostname==='generativelanguage.googleapis.com') {
    modelCalls++;
    return json({candidates:[{content:{role:'model',parts:[{text:JSON.stringify({result:chosen})}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:20,candidatesTokenCount:8,totalTokenCount:28}});
  }
  assert.equal(url.hostname,'test-db.invalid');
  if(url.pathname.endsWith('/rpc/drink_capacity')) {
    assert.deepEqual(await request.json(),{p_product:'Flat White'});
    return json({status:'ready',wholeDrinks:'123',limitingIngredients:[{name:'Milk'}]});
  }
  if(url.pathname.endsWith('/agent_activity')) {
    if(request.method==='POST'){logs.push((await request.json()).tool);return json({id:logs.length});}
    return new Response(null,{status:204});
  }
  assert.ok(url.pathname.endsWith('/delivery_shortage_drafts'));
  if(request.method==='PATCH'){
    assert.equal(url.searchParams.get('approach'),'is.null');
    row.approach=(await request.json()).approach;
    return new Response(null,{status:204});
  }
  return json(url.searchParams.has('receipt_id')?row:[row]);
};
const { tailorSupplierDraft }=await import('../lib/inventory-deliveries/followups.ts');
const { drinkCapacityTool,supplierDraftsTool }=await import('../lib/agent/tools/cafe-operations.ts');
assert.equal((await drinkCapacityTool.execute({product:'Flat White'},{})).wholeDrinks,'123');
await tailorSupplierDraft('demo');
assert.equal(row.approach,'replacement_eta');
await tailorSupplierDraft('demo');
assert.equal(modelCalls,1);
const drafts=await supplierDraftsTool.execute({},{});
assert.match(drafts[0].body,/received 4000 ml in total/);
assert.equal(drafts[0].source,'Agent-assisted draft');
row.approach=null; chosen='invented_option';
await assert.rejects(tailorSupplierDraft('demo'));
assert.equal((await supplierDraftsTool.execute({},{}))[0].source,'Standard draft');
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
await tailorSupplierDraft('demo');
assert.equal(modelCalls,2);
assert.deepEqual(logs,['get_drink_capacity','get_supplier_drafts','get_supplier_drafts']);
console.log('PASS both chat tools, actual AI SDK choice parser with stubbed provider, cached choice, invalid choice and missing-key standard draft');
