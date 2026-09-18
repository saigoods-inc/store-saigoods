import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContactHandler } from './contact-inquiry.js';
import { __resetPublicApiGuardForTests } from '../lib/public-api-guard.js';
const valid = { name:'Test', company:'Example', email:'test@example.com', org_type:'Other', products:'Gloves', message:'Bulk inquiry' };
async function request(body=valid, options={}) {
  __resetPublicApiGuardForTests();
  let code; let payload;
  const res={setHeader(){},status(value){code=value;return this;},json(value){payload=value;return this;}};
  await createContactHandler(options)({method:'POST',headers:{'content-type':'application/json'},body},res);
  return {code,payload};
}
test('missing dedicated configuration never uses live credentials',async()=>{
 const result=await request(valid,{env:{RESEND_API_KEY:'live',RESEND_FROM:'live@example.com'},send:()=>{throw Error('must not send');}});
 assert.equal(result.code,503);
});
test('successful inquiry sends to configured inbox with customer reply-to',async()=>{
 let sent;
 const result=await request(valid,{env:{CONTACT_RESEND_API_KEY:'test',CONTACT_FROM:'sender@example.com',CONTACT_TO:'review@example.com'},send:async(key,message)=>{sent=message;return {data:{id:'test'}};}});
 assert.equal(result.code,200);assert.deepEqual(sent.to,['review@example.com']);assert.equal(sent.replyTo,valid.email);assert.match(sent.text,/Bulk inquiry/);
});
test('invalid and oversized fields are rejected',async()=>{
 assert.equal((await request({...valid,email:'invalid'})).code,400);
 assert.equal((await request({...valid,message:'x'.repeat(5001)})).code,400);
});
test('provider failure does not report success',async()=>{
 const result=await request(valid,{env:{CONTACT_RESEND_API_KEY:'test',CONTACT_FROM:'sender@example.com',CONTACT_TO:'review@example.com'},send:async()=>({error:{message:'failed'}})});
 assert.equal(result.code,502);
});
test('honeypot never sends email',async()=>{
 assert.equal((await request({...valid,website:'spam'},{send:()=>{throw Error('must not send');}})).code,200);
});
