#!/usr/bin/env node
// ============================================================
//  test-config-keys.cjs — API 키 렌더러 노출 차단 회귀 테스트 (의존성 0)
//  ------------------------------------------------------------
//  A) 단위: src/config-keys.js (sanitize / merge / resolveKeyArg)
//  B) IPC : src/main.js 를 electron·DB·Outlook 스텁 위에 실제로 로드해 핸들러를 호출한다.
//           등록된 모든 핸들러도 한 번씩 호출해 응답 직렬화에 키 원문이 없는지 훑는다.
//  C) 정적: 렌더러 소스에 키 필드 직접 접근·기본 키 리터럴이 남아 있지 않은지.
//  가짜 키는 패턴만 맞춘 문자열이고, 소스 키 패턴 grep(CLAUDE.md #4)=0 을 지키려고 조립한다.
//  사용: node scripts/test-config-keys.cjs   (실패 있으면 exit 1)
// ============================================================
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const CK = require(path.join(SRC, 'config-keys.js'));

const PFX = { or: 'sk' + '-' + 'or-v1-', gq: 'gs' + 'k_', cs: 'cs' + 'k-' };
const PATTERN = new RegExp(['sk' + '-', PFX.gq, PFX.cs].join('|'));
const OR = PFX.or + 'TESTONLY00000000aaaa';
const OR2 = PFX.or + 'TESTONLY00000000bbbb';
const GQ = PFX.gq + 'TESTONLY0000000000cccc';
const GQ_NEW = PFX.gq + 'TESTONLY0000000000eeee';
const CS = PFX.cs + 'TESTONLY000000000dddd';
const BM = 'BM-TEST-ONLY-S009';
const TWIN_A = PFX.gq + 'TESTONLY00000AAAA0same';
const TWIN_B = PFX.gq + 'TESTONLY00000BBBB0same';
const RAW = [OR, OR2, GQ, CS, BM];
const MASK_CHARS = /[•…]/;

const fixture = () => ({
  aiProvider: 'openrouter', model: 'm', maxMails: 5000, bigmailKey: BM,
  apiKeys: [CS],
  apiKeysByProvider: { openrouter: [OR, OR2], groq: [GQ], cerebras: [CS] },
  aiChain: [
    { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'a:free', keys: [OR, OR2], enabled: true },
    { provider: 'groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'g', keys: [GQ], enabled: true }
  ]
});
const noRaw = (obj, raws = RAW) => {
  const s = JSON.stringify(obj) || '';
  assert.ok(!PATTERN.test(s), '직렬화에 키 패턴이 남음');
  for (const r of raws) assert.ok(!s.includes(r), '직렬화에 키 원문이 남음');
};
const noMaskStored = (obj) => assert.ok(!MASK_CHARS.test(JSON.stringify(obj)), '마스킹 토큰이 저장 대상에 들어감');
const row = (cfg, p) => cfg.aiChain.find(e => e.provider === p);

let failed = 0, passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  PASS ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' — ' + String(e.message || e).split('\n')[0]); }
}

// ------------------------------------------------------------
//  B) main.js 를 스텁 위에 로드
// ------------------------------------------------------------
function noopProxy() {
  const fn = function () {};
  return new Proxy(fn, {
    get(_t, k) { return (k === 'then' || typeof k === 'symbol' || k === 'toJSON') ? undefined : noopProxy(); },
    apply() { return noopProxy(); },
    construct() { return noopProxy(); }
  });
}
function overridable(over) {
  return new Proxy(over, { get(t, k) { return k in t ? t[k] : ((k === 'then' || typeof k === 'symbol') ? undefined : noopProxy()); } });
}
function loadMain() {
  const handlers = {};
  const STORE = {};
  const SANDBOX = path.join(process.env.TEMP || 'E:\\tmp', 'cfgkeys-test');
  class FakeStore {
    constructor(opts) { Object.assign(STORE, JSON.parse(JSON.stringify((opts && opts.defaults) || {}))); }
    get store() { return JSON.parse(JSON.stringify(STORE)); }
    get(k) { return STORE[k] === undefined ? undefined : JSON.parse(JSON.stringify(STORE[k])); }
    set(k, v) {
      if (k && typeof k === 'object') { for (const [a, b] of Object.entries(k)) this.set(a, b); return; }
      if (v === undefined) throw new TypeError('undefined 저장 금지(conf 동작 재현): ' + k);
      STORE[k] = JSON.parse(JSON.stringify(v));
    }
    has(k) { return k in STORE; }
    delete(k) { delete STORE[k]; }
  }
  const electronStub = overridable({
    app: overridable({
      getPath: () => SANDBOX, setPath() {}, setName() {}, getVersion: () => '0.0.0', getName: () => 'Bmail',
      whenReady: () => new Promise(() => {}), on() {}, once() {}, requestSingleInstanceLock: () => true,
      isPackaged: false, quit() {}, exit() {}, relaunch() {}, commandLine: overridable({})
    }),
    ipcMain: overridable({ handle: (ch, fn) => { handlers[ch] = fn; }, on() {}, removeHandler() {} })
  });
  const REAL_LOCAL = new Set(['config-keys', 'ai-providers', 'ai-errors', 'cerebras']);
  const safeFs = new Proxy(fs, {
    get(t, k) { return (typeof k === 'string' && /^(write|mkdir|rm|unlink|copy|rename|append|create|open|truncate)/.test(k)) ? () => undefined : t[k]; }
  });
  const origLoad = Module._load;
  const mainPath = path.join(SRC, 'main.js');
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub;
    if (request === 'electron-store') return FakeStore;
    if (parent && parent.filename === mainPath) {
      if (request === 'child_process') return { spawn: () => noopProxy(), exec: () => noopProxy(), execFile: () => noopProxy() };
      if (request === 'fs') return safeFs;
      if (request.startsWith('./')) {
        if (!REAL_LOCAL.has(request.slice(2).replace(/\.js$/, ''))) return noopProxy();
      }
    }
    return origLoad.apply(this, arguments);
  };
  global.fetch = async () => { throw new Error('테스트 중 네트워크 금지'); };
  require(mainPath);
  Module._load = origLoad;
  return { handlers, STORE, cerebras: require(path.join(SRC, 'cerebras.js')) };
}

// ------------------------------------------------------------
async function main() {
  console.log('[A] config-keys 단위');
  const { sanitizeConfig: san, mergeIncomingKeys: merge, resolveKeyArg, maskKey } = CK;

  await t('sanitize — 직렬화에 키 패턴·원문 0 (bigmailKey 포함), 비밀 아닌 필드 유지', () => {
    const v = san(fixture());
    noRaw(v);
    assert.strictEqual(v.apiKeys, undefined);
    assert.strictEqual(v.apiKeysByProvider, undefined);
    assert.strictEqual(v.maxMails, 5000);
    assert.strictEqual(v.keyInfo.openrouter.count, 2);
    assert.strictEqual(v.keyInfo.cerebras.hasKey, true);
    assert.ok(row(v, 'openrouter').keys[0].includes('aaaa'), '끝4자리 표시');
    assert.ok(v.bigmailKey.includes('S009') && v.bigmailKey !== BM, 'bigmailKey 는 끝4자리 마스킹');
  });
  await t('마스킹 토큰이 돌아오면 원 키 유지 (전 필드)', () => {
    const s = fixture();
    const m = merge(s, san(s));
    assert.deepStrictEqual(row(m, 'openrouter').keys, [OR, OR2]);
    assert.deepStrictEqual(row(m, 'groq').keys, [GQ]);
    assert.ok(!('bigmailKey' in m), '마스킹 bigmailKey 는 저장 대상에서 제외(기존 유지)');
    assert.strictEqual(m.keyInfo, undefined);
    assert.strictEqual(m.keysRev, undefined);
    noMaskStored(m);
  });
  await t('새 키는 저장, 기존 토큰과 함께 보내면 합쳐짐', () => {
    const s = fixture(), v = san(s);
    const inc = { ...v, aiChain: v.aiChain.map(e => e.provider === 'groq' ? { ...e, keys: [...e.keys, GQ_NEW] } : e) };
    const m = merge(s, inc);
    assert.deepStrictEqual(row(m, 'groq').keys, [GQ, GQ_NEW]);
    assert.deepStrictEqual(m.apiKeysByProvider.groq, [GQ, GQ_NEW], 'apiKeysByProvider 도 함께 갱신');
    const m2 = merge(s, { bigmailKey: 'BM-NEW-KEY-0001' });
    assert.strictEqual(m2.bigmailKey, 'BM-NEW-KEY-0001');
  });
  await t('빈 값은 "변경 없음" (chain·byProvider·apiKeys·bigmailKey)', () => {
    const s = fixture();
    const m = merge(s, { keysRev: san(s).keysRev, aiChain: [{ provider: 'openrouter', keys: ['', ' '] }, { provider: 'groq', keys: [] }], apiKeysByProvider: { groq: [] }, apiKeys: [], bigmailKey: '  ' });
    assert.deepStrictEqual(row(m, 'openrouter').keys, [OR, OR2], '빈 값이 기존 키를 지움');
    assert.deepStrictEqual(row(m, 'groq').keys, [GQ]);
    assert.deepStrictEqual(m.apiKeysByProvider.groq, [GQ]);
    assert.ok(!('apiKeys' in m) || m.apiKeys.includes(CS), '빈 apiKeys 가 기존 키를 지움');
    assert.ok(!('bigmailKey' in m), '빈 bigmailKey 는 저장 대상 제외');
  });
  await t('한 제공자만 보내도 다른 제공자 키 보존', () => {
    const s = fixture(), v = san(s);
    const m = merge(s, { apiKeysByProvider: { openrouter: row(v, 'openrouter').keys } });
    assert.deepStrictEqual(m.apiKeysByProvider, { openrouter: [OR, OR2], groq: [GQ], cerebras: [CS] });
  });
  await t('제공자 줄을 지워도 그 키는 apiKeysByProvider 에 보존', () => {
    const s = { ...fixture(), apiKeysByProvider: { openrouter: [OR, OR2] } };   // groq 키는 체인에만 있음
    const v = san(s);
    const m = merge(s, { ...v, aiChain: v.aiChain.filter(e => e.provider !== 'groq') });
    assert.deepStrictEqual(m.apiKeysByProvider.groq, [GQ]);
  });
  await t('체인에 없고 byProvider 에만 있는 키는 토글 저장에서 유실 안 됨', () => {
    const s = { ...fixture(), apiKeysByProvider: { openrouter: [OR, OR2, 'only-in-byprov-key-0001'], groq: [GQ] } };
    const v = san(s);
    const m = merge(s, { ...v, maxMails: 1 });
    const final = m.apiKeysByProvider || s.apiKeysByProvider;
    assert.ok(final.openrouter.includes('only-in-byprov-key-0001'));
  });
  await t('마스킹 토큰 문자열이 키로 저장되는 경우 0 (정상·미상·변형·타 제공자·구형식)', () => {
    const s = fixture(), v = san(s);
    const tokens = [row(v, 'openrouter').keys[0], '••••…zzzz', '••••…', '••••…cccc', '•', '…aaaa', row(v, 'groq').keys[0] + 'x'];
    for (const tok of tokens) {
      for (const inc of [
        { keysRev: v.keysRev, aiChain: [{ provider: 'groq', keys: [tok] }] },
        { keysRev: v.keysRev, apiKeysByProvider: { groq: [tok] } },
        { keysRev: v.keysRev, apiKeys: [tok] },
        { bigmailKey: tok }
      ]) noMaskStored(merge(s, inc));
    }
  });
  await t('변형·미상 토큰이 섞이면 지운 것으로 보지 않음 (유실 0)', () => {
    const s = fixture(), v = san(s);
    const m = merge(s, { keysRev: v.keysRev, aiChain: [{ provider: 'openrouter', keys: [row(v, 'openrouter').keys[0], '••••…bbb'] }] });
    assert.deepStrictEqual(row(m, 'openrouter').keys.slice().sort(), [OR, OR2].sort());
  });
  await t('끝4자리가 같은 키 2개 — 토큰 구분·왕복 보존·올바른 쪽만 삭제·올바른 쪽 원복', () => {
    assert.strictEqual(TWIN_A.slice(-4), TWIN_B.slice(-4));
    const s = { aiChain: [{ provider: 'groq', keys: [TWIN_A, TWIN_B] }], apiKeysByProvider: { groq: [TWIN_A, TWIN_B] } };
    const v = san(s);
    const [ta, tb] = v.aiChain[0].keys;
    assert.notStrictEqual(ta, tb, '토큰이 같으면 구분 불가');
    assert.deepStrictEqual(merge(s, v).aiChain[0].keys, [TWIN_A, TWIN_B], '왕복에서 한 개 유실');
    assert.deepStrictEqual(merge(s, { keysRev: v.keysRev, aiChain: [{ provider: 'groq', keys: [tb] }] }).aiChain[0].keys, [TWIN_B], '다른 키로 원복');
    assert.strictEqual(resolveKeyArg(s, 'groq', tb), TWIN_B);
    assert.strictEqual(resolveKeyArg(s, 'groq', ta), TWIN_A);
  });
  await t('줄 삭제 = 의도된 삭제 — 체인·byProvider 모두 반영, 재등장 안 함', () => {
    const s = fixture(), v = san(s);
    const m = merge(s, { keysRev: v.keysRev, aiChain: [{ provider: 'openrouter', keys: [row(v, 'openrouter').keys[0]] }, row(v, 'groq')] });
    assert.deepStrictEqual(row(m, 'openrouter').keys, [OR]);
    assert.deepStrictEqual(m.apiKeysByProvider.openrouter, [OR]);
    const after = { ...s, ...m };
    assert.strictEqual(san(after).keyInfo.openrouter.count, 1, '삭제한 키가 keyInfo 로 재등장');
  });
  await t('오래된 화면(keysRev 불일치·누락)의 저장은 그 사이 추가된 키를 지우지 못함 (TLC 반례)', () => {
    const s0 = fixture(), stale = san(s0);
    const s1 = { ...s0, ...merge(s0, { ...stale, aiChain: stale.aiChain.map(e => e.provider === 'groq' ? { ...e, keys: [...e.keys, GQ_NEW] } : e) }) };
    assert.deepStrictEqual(row(s1, 'groq').keys, [GQ, GQ_NEW]);
    const m = merge(s1, { ...stale, maxMails: 1 });        // 낡은 스냅샷으로 토글 저장
    assert.ok(row(m, 'groq').keys.includes(GQ_NEW), '낡은 스냅샷이 새 키를 지움');
    const { keysRev: _drop, ...noRev } = stale;
    assert.ok(row(merge(s1, noRev), 'groq').keys.includes(GQ_NEW), 'keysRev 누락도 낡은 것으로 취급');
    noMaskStored(m);
  });
  await t('8자 이하 짧은 키는 끝자리도 노출 안 함', () => {
    assert.ok(!maskKey('abcd').includes('abcd'));
    assert.ok(!maskKey('local123').includes('l123'));
  });
  await t('resolveKeyArg — 마스킹→원본 / 새 키→그대로 / 빈값·미상·타 제공자 토큰→빈값', () => {
    const s = fixture(), v = san(s);
    const [t1, t2] = row(v, 'openrouter').keys;
    assert.strictEqual(resolveKeyArg(s, 'openrouter', t1), OR);
    assert.strictEqual(resolveKeyArg(s, 'openrouter', t2), OR2);
    assert.strictEqual(resolveKeyArg(s, 'openrouter', GQ_NEW), GQ_NEW);
    assert.strictEqual(resolveKeyArg(s, 'openrouter', ''), '');
    assert.strictEqual(resolveKeyArg(s, 'openrouter', '••••…zzzz'), '');
    assert.strictEqual(resolveKeyArg(s, 'groq', t1), '', '타 제공자 토큰으로 키를 꺼내면 안 됨');
  });
  await t('왕복 안정성 sanitize→merge→sanitize 동일', () => {
    const s = fixture();
    const v = san(s);
    assert.deepStrictEqual(san({ ...s, ...merge(s, v) }), v);
  });

  console.log('[B] main.js IPC (스텁 로드)');
  let M = null;
  await t('main.js 로드·핸들러 등록', () => {
    M = loadMain();
    assert.ok(M.handlers['config:get'] && M.handlers['config:set'] && M.handlers['ai:providers'] && M.handlers['ai:models']);
  });
  if (M) {
    const { handlers: H, STORE, cerebras } = M;
    const seed = () => { for (const [k, v] of Object.entries(fixture())) STORE[k] = JSON.parse(JSON.stringify(v)); };
    const calls = [];
    cerebras.listModels = async ({ url, key }) => { calls.push(key); return { ok: true, models: ['x:free'] }; };
    cerebras.probeKeys = async (keys) => { calls.push(...keys); return keys.map(() => ({ ok: true, state: 'ok', tail: '…test', detail: '' })); };
    seed();

    await t('config:get 응답 직렬화에 키 패턴·원문 0', async () => { noRaw(await H['config:get']({})); });
    await t('config:set — 응답에 키 0, 저장소는 원 키 유지, 마스킹 0', async () => {
      seed();
      const v = await H['config:get']({});
      noRaw(await H['config:set']({}, { ...v, maxMails: 777 }));
      assert.strictEqual(STORE.maxMails, 777);
      assert.deepStrictEqual(STORE.aiChain[0].keys, [OR, OR2]);
      assert.deepStrictEqual(STORE.apiKeysByProvider.groq, [GQ]);
      assert.deepStrictEqual(STORE.apiKeys, [CS]);
      assert.strictEqual(STORE.bigmailKey, BM);
      assert.strictEqual(STORE.keyInfo, undefined);
      assert.strictEqual(STORE.keysRev, undefined);
      noMaskStored(STORE);
    });
    await t('config:set — 렌더러가 키 필드 없이 보내도(설정 저장 형태) 기존 키 유지', async () => {
      seed();
      const v = await H['config:get']({});
      await H['config:set']({}, { keysRev: v.keysRev, aiChain: v.aiChain, aiProvider: 'openrouter', bigmailKey: '' });
      assert.deepStrictEqual(STORE.apiKeys, [CS]);
      assert.deepStrictEqual(STORE.apiKeysByProvider.cerebras, [CS]);
      assert.strictEqual(STORE.bigmailKey, BM);
    });
    await t('ai:providers 응답에 키 0, 등록 여부는 토큰으로 표시', async () => {
      seed();
      const r = await H['ai:providers']({});
      assert.ok(r.ok, r.error);
      noRaw(r);
      assert.strictEqual(r.chain.find(e => e.provider === 'openrouter').keys.length, 2);
    });
    await t('ai:status 응답에 키 0', async () => { seed(); noRaw(await H['ai:status']({})); });
    await t('ai:models — 토큰은 main 에서 원 키로, 토큰 자체는 절대 전송 안 함', async () => {
      seed(); calls.length = 0;
      const v = await H['config:get']({});
      const tok = row(v, 'openrouter').keys[1];
      noRaw(await H['ai:models']({}, { provider: 'openrouter', baseUrl: '', key: tok }));
      await H['ai:models']({}, { provider: 'openrouter', baseUrl: '', key: '' });
      await H['ai:models']({}, { provider: 'openrouter', baseUrl: '', key: GQ_NEW });
      await H['ai:models']({}, { provider: 'openrouter', baseUrl: '', key: '••••…zzzz' });
      assert.deepStrictEqual(calls, [OR2, OR, GQ_NEW, OR]);
    });
    await t('ai:chainTest — 호출은 실제 키, 응답엔 키 0', async () => {
      seed(); calls.length = 0;
      const r = await H['ai:chainTest']({});
      assert.ok(r.ok, r.error);
      noRaw(r);
      assert.deepStrictEqual(calls.slice().sort(), [OR, OR2, GQ].sort());
    });
    await t(`등록 핸들러 전수 호출 — 응답 직렬화에 키 원문 0`, async () => {
      seed();
      const names = Object.keys(H);
      const leaks = [];
      for (const ch of names) {
        let res;
        try {
          res = await Promise.race([
            Promise.resolve().then(() => H[ch]({}, {}, {})),
            new Promise(r => setTimeout(() => r('__timeout__'), 300))
          ]);
        } catch (_) { continue; }
        let s = '';
        try { s = JSON.stringify(res) || ''; } catch (_) { continue; }
        if (PATTERN.test(s) || RAW.some(k => s.includes(k))) leaks.push(ch);
        for (const [k, v] of Object.entries(fixture())) if (k === 'bigmailKey') STORE[k] = v;
      }
      assert.deepStrictEqual(leaks, [], '누출 채널');
      console.log(`       (핸들러 ${names.length}개 호출)`);
    });
  }

  console.log('[C] 렌더러 소스 정적 검사');
  const rsrc = fs.readFileSync(path.join(SRC, 'renderer', 'renderer.js'), 'utf8');
  const html = fs.readFileSync(path.join(SRC, 'renderer', 'index.html'), 'utf8');
  await t('renderer.js 가 키 저장 필드(apiKeys·apiKeysByProvider)를 다루지 않음', () => {
    assert.ok(!/\bapiKeys\b/.test(rsrc), 'apiKeys 참조 잔존');
    assert.ok(!/\bapiKeysByProvider\b/.test(rsrc), 'apiKeysByProvider 참조 잔존');
  });
  await t('렌더러 소스에 기본 라이선스 키 리터럴 0 (renderer.js·index.html)', () => {
    assert.ok(!/BM-INT-/.test(rsrc), 'renderer.js');
    assert.ok(!/BM-INT-/.test(html), 'index.html');
  });
  await t('설정 저장 후 체인을 다시 받아 화면을 토큰으로 교체', () => {
    const body = rsrc.slice(rsrc.indexOf('async function saveSettings'), rsrc.indexOf('//  상대 조직 사전'));
    assert.ok(/loadProviderChain\(\)/.test(body), 'saveSettings → loadProviderChain 없음');
    assert.ok(/keysRev:\s*config\.keysRev/.test(body), 'saveSettings 가 keysRev 를 보내지 않음');
  });

  console.log(`\nconfig-keys 테스트: PASS ${passed} · FAIL ${failed}`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.log('테스트 하네스 오류:', e); process.exit(2); });
