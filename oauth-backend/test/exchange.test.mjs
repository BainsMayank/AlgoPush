import worker from '../src/index.js';

const SECRET = 'super-secret';
const CLIENT = 'client-abc';
const ORIGIN = 'chrome-extension://oflhjpbehioebeaologailkkfbmleipl';
const b64u = b => Buffer.from(b).toString('base64url');

async function jwt(payload, { alg = 'HS256', secret = SECRET, badSig = false } = {}) {
  const h = b64u(JSON.stringify({ alg, typ: 'JWT' }));
  const p = b64u(JSON.stringify(payload));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${badSig ? b64u('nope') : Buffer.from(sig).toString('base64url')}`;
}

const now = Math.floor(Date.now() / 1000);
const good = { handle: 'tourist', rating: 3900, iss: 'https://codeforces.com', aud: CLIENT, exp: now + 300, iat: now, nonce: 'N1' };

let captured = null;
function mockCF(idToken, ok = true) {
  globalThis.fetch = async (url, init) => {
    captured = Object.fromEntries(new URLSearchParams(init.body));
    return new Response(JSON.stringify(ok ? { id_token: idToken } : { error: 'bad_code' }), { status: ok ? 200 : 400 });
  };
}

const env = { CF_CLIENT_SECRET: SECRET, CF_CLIENT_ID: CLIENT };
// A distinct IP per case, so one test cannot exhaust another's rate budget.
let ipSeq = 0;
const post = (body, origin = ORIGIN, e = env) => {
  const ip = `10.0.0.${++ipSeq}`;
  const headers = { 'CF-Connecting-IP': ip };
  if (origin) headers.Origin = origin;
  return worker.fetch(new Request('https://w.dev/auth/codeforces/exchange',
    { method: 'POST', headers, body: JSON.stringify(body) }), e);
};

async function check(name, res, wantStatus, wantIn) {
  const text = await res.text();
  const pass = res.status === wantStatus && (!wantIn || text.includes(wantIn));
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  [${res.status}] ${text.slice(0, 110)}`);
  if (!pass) process.exitCode = 1;
}

// happy path
mockCF(await jwt(good));
await check('valid token -> handle', await post({ code: 'c', clientId: CLIENT, nonce: 'N1' }), 200, '"handle":"tourist"');
console.log('       redirect_uri sent to CF:', captured.redirect_uri);

// redirect uri cannot be influenced by the caller
mockCF(await jwt(good));
await post({ code: 'c', clientId: CLIENT, nonce: 'N1', redirectUri: 'https://evil.test/' });
console.log(`${captured.redirect_uri.includes('chromiumapp.org') ? 'PASS' : 'FAIL'}  attacker redirectUri ignored -> ${captured.redirect_uri}`);
if (!captured.redirect_uri.includes('chromiumapp.org')) process.exitCode = 1;

// signature / alg
mockCF(await jwt(good, { badSig: true }));
await check('bad signature rejected', await post({ code: 'c', clientId: CLIENT }), 502, 'signature');
mockCF(await jwt(good, { alg: 'none' }));
await check('alg:none rejected', await post({ code: 'c', clientId: CLIENT }), 502, 'algorithm');
mockCF(await jwt(good, { secret: 'wrong-secret' }));
await check('foreign key rejected', await post({ code: 'c', clientId: CLIENT }), 502, 'signature');

// claims
const { exp, ...noExp } = good;
mockCF(await jwt(noExp));
await check('missing exp rejected', await post({ code: 'c', clientId: CLIENT }), 502, 'no expiry');
mockCF(await jwt({ ...good, exp: now - 3600 }));
await check('expired rejected', await post({ code: 'c', clientId: CLIENT }), 502, 'expired');
mockCF(await jwt({ ...good, iss: 'https://evil.test' }));
await check('bad issuer rejected', await post({ code: 'c', clientId: CLIENT }), 502, 'not Codeforces');
mockCF(await jwt({ ...good, aud: 'someone-else' }));
await check('bad audience rejected', await post({ code: 'c', clientId: CLIENT }), 502, 'not issued for this client');
mockCF(await jwt(good));
await check('nonce mismatch rejected', await post({ code: 'c', clientId: CLIENT, nonce: 'DIFFERENT' }), 502, 'replayed');

// degradation: provider that omits iss/aud/nonce must still work
const { iss, aud, nonce, ...minimal } = good;
mockCF(await jwt(minimal));
await check('minimal token still accepted', await post({ code: 'c', clientId: CLIENT, nonce: 'N1' }), 200, '"handle":"tourist"');

// origin + client pinning
mockCF(await jwt(good));
await check('foreign origin blocked', await post({ code: 'c', clientId: CLIENT }, 'https://evil.test'), 403, 'Origin not allowed');
mockCF(await jwt(good));
await check('wrong client_id blocked', await post({ code: 'c', clientId: 'other' }), 403, 'Unknown client_id');
mockCF(await jwt(good));
await check('no-origin (curl) allowed', await post({ code: 'c', clientId: CLIENT, nonce: 'N1' }, null), 200, 'tourist');

// input validation
await check('missing code', await post({ clientId: CLIENT }), 400, 'required');
mockCF(await jwt(good));
await check('non-string code', await post({ code: 123, clientId: CLIENT }), 400, 'must be strings');

// rate limit (fresh isolate-local counter for a new IP)
mockCF(await jwt(good));
let limited = null;
for (let i = 0; i < 14; i++) {
  const r = await worker.fetch(new Request('https://w.dev/auth/codeforces/exchange',
    { method: 'POST', headers: { Origin: ORIGIN, 'CF-Connecting-IP': '5.5.5.5' }, body: JSON.stringify({ code: 'c', clientId: CLIENT, nonce: 'N1' }) }), env);
  if (r.status === 429) { limited = i + 1; break; }
}
console.log(`${limited === 11 ? 'PASS' : 'FAIL'}  rate limit trips after ${limited} requests (expected 11)`);
if (limited !== 11) process.exitCode = 1;

// CORS headers
const pre = await worker.fetch(new Request('https://w.dev/auth/codeforces/exchange', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), env);
console.log(`${pre.headers.get('Vary') === 'Origin' && pre.headers.get('Access-Control-Allow-Origin') === ORIGIN ? 'PASS' : 'FAIL'}  preflight: ACAO=${pre.headers.get('Access-Control-Allow-Origin')} Vary=${pre.headers.get('Vary')}`);
const preEvil = await worker.fetch(new Request('https://w.dev/auth/codeforces/exchange', { method: 'OPTIONS', headers: { Origin: 'https://evil.test' } }), env);
console.log(`${preEvil.headers.get('Access-Control-Allow-Origin') === null ? 'PASS' : 'FAIL'}  preflight from evil origin gets no ACAO`);
