import { pathToFileURL } from 'node:url';

// Public project reference observed on production; never permit it for test orders.
const productionDatabaseHost = 'dkupzkxlerlzlmzlgydg.supabase.co';
function host(value) {
  try { return new URL(String(value)).hostname.toLowerCase(); } catch { return ''; }
}

export function checkSandboxIsolation(env) {
  const checks = [];
  const present = key => Boolean(String(env[key] || '').trim());
  const check = (name, ok) => checks.push({ name, ok: Boolean(ok) });
  const database = host(env.SUPABASE_URL);
  const expected = host(env.SANDBOX_EXPECTED_DATABASE_URL);
  check('Explicit Square sandbox mode', env.SQUARE_ENVIRONMENT === 'sandbox');
  check('Square sandbox credentials configured', ['SQUARE_ACCESS_TOKEN', 'SQUARE_APPLICATION_ID', 'SQUARE_LOCATION_ID', 'SQUARE_WEBHOOK_SIGNATURE_KEY_SANDBOX'].every(present));
  check('Supabase test project explicitly identified', expected.endsWith('.supabase.co') && database === expected);
  check('Known production database excluded', database && database !== productionDatabaseHost);
  check('Database credentials configured', ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY'].every(present));
  check('Shippo test token', String(env.SHIPPO_API_TOKEN || '').startsWith('shippo_test_'));
  check('Shippo uses official endpoint', !present('SHIPPO_API_BASE_URL') || String(env.SHIPPO_API_BASE_URL).replace(/\/$/, '') === 'https://api.goshippo.com');
  check('Outbound email credentials absent', !['RESEND_API_KEY', 'SENDGRID_API_KEY', 'SMTP_PASSWORD'].some(present));
  check('Dedicated checkout signing secret configured', present('CHECKOUT_QUOTE_SIGNING_SECRET'));
  check('Not a Vercel production deployment', env.VERCEL_ENV !== 'production');
  const publicHost = host(env.PUBLIC_BASE_URL);
  check('Non-production public URL configured', publicHost && !['store.saigoods.com', 'saigoods.com', 'www.saigoods.com'].includes(publicHost));
  return checks;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Deliberately do not import .env: the parent checkout contains shared credentials.
  const checks = checkSandboxIsolation(process.env);
  for (const { name, ok } of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  console.log('Configuration preflight only; verify account ownership, schema, and worker isolation separately.');
  if (checks.some(check => !check.ok)) process.exitCode = 1;
}
