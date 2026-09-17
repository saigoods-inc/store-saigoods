import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSandboxIsolation } from './check-sandbox-isolation.mjs';
const fixture = () => ({
  SQUARE_ENVIRONMENT: 'sandbox', SQUARE_ACCESS_TOKEN: 'fixture', SQUARE_APPLICATION_ID: 'fixture',
  SQUARE_LOCATION_ID: 'fixture', SQUARE_WEBHOOK_SIGNATURE_KEY_SANDBOX: 'fixture',
  SUPABASE_URL: 'https://test-project.supabase.co', SANDBOX_EXPECTED_DATABASE_URL: 'https://test-project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'fixture', SUPABASE_ANON_KEY: 'fixture', SHIPPO_API_TOKEN: 'shippo_test_fixture',
  CHECKOUT_QUOTE_SIGNING_SECRET: 'fixture', PUBLIC_BASE_URL: 'http://localhost:4320', VERCEL_ENV: 'preview',
});
const failed = env => checkSandboxIsolation(env).filter(row => !row.ok);
test('isolated fixture passes without exposing credentials', () => {
  assert.deepEqual(failed(fixture()), []);
  assert.equal(JSON.stringify(checkSandboxIsolation(fixture())).includes('fixture'), false);
});
test('production database is rejected even when explicitly selected', () => {
  const env = fixture();
  env.SUPABASE_URL = env.SANDBOX_EXPECTED_DATABASE_URL = 'https://dkupzkxlerlzlmzlgydg.supabase.co/';
  assert.ok(failed(env).some(row => row.name === 'Known production database excluded'));
});
test('live providers, production deployment, and email keys are rejected', () => {
  for (const patch of [{SQUARE_ENVIRONMENT:'production'}, {SHIPPO_API_TOKEN:'shippo_live_fixture'}, {RESEND_API_KEY:'fixture'}, {SENDGRID_API_KEY:'fixture'}, {VERCEL_ENV:'production'}, {PUBLIC_BASE_URL:'https://store.saigoods.com'}]) {
    assert.ok(failed({...fixture(), ...patch}).length > 0);
  }
});
test('missing or unexpected database cannot pass', () => {
  assert.ok(failed({}).length > 0);
  assert.ok(failed({...fixture(), SUPABASE_URL:'https://unexpected.supabase.co'}).length > 0);
  assert.ok(failed({...fixture(), SANDBOX_EXPECTED_DATABASE_URL:''}).length > 0);
});
