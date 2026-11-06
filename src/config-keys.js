// ============================================================
//  config-keys.js — API 키의 렌더러 노출 차단 (단일 책임 · 의존성 0)
//  ------------------------------------------------------------
//  main.js 의 config:get / config:set / ai:providers / ai:models 가 공유하는 유일한 지점.
//   · sanitizeConfig(store)  : 렌더러로 보내기 전 키 값을 제거한다.
//        aiChain[].keys·bigmailKey 는 마스킹 토큰으로 바꾸고, keyInfo{provider:{hasKey,count,masks}} 와
//        keysRev(저장된 키 집합의 지문)를 덧붙인다.
//   · mergeIncomingKeys(stored, incoming) : 렌더러가 돌려보낸 설정을 저장 가능한 형태로.
//        토큰 → 그 토큰을 만든 저장 키로 원복 / 새 키 → 그대로 / 전부 빈 값 → "변경 없음".
//        줄을 지운 것은 keysRev 가 현재와 같을 때만 삭제로 인정한다(낡은 화면이 새 키를 지우지 못함).
//   · resolveKeyArg(stored, provider, key) : 렌더러가 인자로 넘긴 키(토큰일 수 있음)를 실제 키로.
//  토큰 = ••••…끝4자리#sha256앞8자. 끝4자리만으로는 같은 끝자리 키 2개를 구분할 수 없어(유실 반례) 지문을 붙인다.
//  보안 모델: 렌더러에는 키 원문이 건너가지 않는다 — 키 값이 필요한 호출은 전부 main 에서.
//  모델 체크: formal/config-keys.tla
// ============================================================
const crypto = require('crypto');

const MASK_PREFIX = '••••…';
const MASK_CHARS = /[•…]/;      // 실제 API 키에는 없는 문자 — 토큰(변형 포함)을 키로 저장하지 않는 기준
const SHORT_KEY_LEN = 8;        // 이보다 짧으면 끝4자리가 키 대부분이므로 표시하지 않는다

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);
const clean = (list) => (Array.isArray(list) ? list : []).map(k => String(k == null ? '' : k).trim()).filter(Boolean);
const union = (...lists) => [...new Set(lists.flatMap(l => l || []))];

function maskKey(k) {
  const s = String(k);
  return MASK_PREFIX + (s.length > SHORT_KEY_LEN ? s.slice(-4) : '') + '#' + digest(s);
}
const isMasked = (k) => MASK_CHARS.test(String(k || ''));

//  저장 설정에서 제공자별 실제 키 풀(중복 제거, 순서 유지)
function keyPool(stored) {
  const s = stored || {};
  const pool = {};
  const add = (p, keys) => { if (p) pool[p] = union(pool[p], clean(keys)); };
  for (const [p, keys] of Object.entries(s.apiKeysByProvider || {})) add(p, keys);
  for (const e of (Array.isArray(s.aiChain) ? s.aiChain : [])) if (e) add(e.provider, e.keys);
  add('cerebras', s.apiKeys);   // 레거시 단일 필드
  return pool;
}
const revOf = (pool) => digest(JSON.stringify(Object.keys(pool).sort().map(p => [p, pool[p]])));

function chainKeysByProvider(stored) {
  const out = {};
  const chain = stored && stored.aiChain;
  for (const e of (Array.isArray(chain) ? chain : [])) if (e && e.provider) out[e.provider] = union(out[e.provider], clean(e.keys));
  return out;
}

function sanitizeConfig(stored) {
  const s = stored || {};
  const out = { ...s };
  delete out.apiKeys;
  delete out.apiKeysByProvider;
  if (Array.isArray(s.aiChain)) out.aiChain = s.aiChain.map(e => (e ? { ...e, keys: clean(e.keys).map(maskKey) } : e));
  if (s.bigmailKey) out.bigmailKey = maskKey(s.bigmailKey);
  const pool = keyPool(s);
  out.keyInfo = {};
  for (const [p, keys] of Object.entries(pool)) out.keyInfo[p] = { hasKey: keys.length > 0, count: keys.length, masks: keys.map(maskKey) };
  out.keysRev = revOf(pool);
  return out;
}

//  목록 1개 원복. have=토큰을 풀 수 있는 저장 키, prior=지금 이 자리에 저장된 키.
//   전부 빈 값 → undefined("변경 없음") · 토큰은 절대 결과에 들어가지 않는다.
//   삭제 불인정(canRemove=false) 또는 풀리지 않는 토큰이 섞이면 prior 를 전부 유지한다.
function resolveList(have, prior, list, canRemove) {
  if (!Array.isArray(list)) return undefined;
  const nonBlank = clean(list);
  if (!nonBlank.length) return undefined;
  const out = [];
  let unknown = false;
  for (const k of nonBlank) {
    if (!isMasked(k)) { out.push(k); continue; }
    const hits = have.filter(h => maskKey(h) === k);
    if (hits.length === 1) out.push(hits[0]); else unknown = true;
  }
  return union(out, (canRemove && !unknown) ? [] : prior);
}

function mergeIncomingKeys(stored, incoming) {
  const s = stored || {}, inc = { ...(incoming || {}) };
  const pool = keyPool(s);
  const canRemove = inc.keysRev === revOf(pool);
  delete inc.keyInfo;
  delete inc.keysRev;
  const hasChain = Array.isArray(inc.aiChain);
  const hasByProv = !!inc.apiKeysByProvider && typeof inc.apiKeysByProvider === 'object';
  if (!hasChain) delete inc.aiChain;
  const incomingByProv = hasByProv ? inc.apiKeysByProvider : {};
  delete inc.apiKeysByProvider;

  const byProv = {};
  for (const [p, keys] of Object.entries(s.apiKeysByProvider || {})) byProv[p] = clean(keys);
  const storedLegacy = clean(s.apiKeys);
  let legacy = storedLegacy;

  if (hasChain) {
    const before = chainKeysByProvider(s);
    const received = {};
    inc.aiChain = inc.aiChain.map(e => {
      if (!e) return e;
      const prior = before[e.provider] || pool[e.provider] || [];
      const r = resolveList(pool[e.provider] || [], prior, e.keys, canRemove);
      const keys = r === undefined ? prior : r;
      received[e.provider] = union(received[e.provider], keys);
      return { ...e, keys };
    });
    //  체인 변경분만 다른 저장 필드에 반영 — 체인에 없던 키(비전용 등)는 건드리지 않는다.
    for (const p of union(Object.keys(before), Object.keys(received))) {
      const was = before[p] || [];
      const now = received[p];
      if (!now) { byProv[p] = union(byProv[p], was); continue; }   // 줄이 사라져도 키는 보존
      const removed = was.filter(k => !now.includes(k));
      const drop = (l) => (l || []).filter(k => !removed.includes(k));
      byProv[p] = union(drop(byProv[p]), now);
      if (p === 'cerebras') legacy = union(drop(legacy), now);
    }
  }
  for (const [p, keys] of Object.entries(incomingByProv)) {
    const r = resolveList(pool[p] || [], byProv[p] || pool[p] || [], keys, canRemove);
    if (r !== undefined) byProv[p] = r;
  }
  if (hasChain || hasByProv) inc.apiKeysByProvider = byProv;

  if ('apiKeys' in inc) {
    const r = resolveList(pool.cerebras || [], legacy, inc.apiKeys, canRemove);
    if (r !== undefined) legacy = r;
  }
  delete inc.apiKeys;
  if (legacy.join('\n') !== storedLegacy.join('\n')) inc.apiKeys = legacy;

  if ('bigmailKey' in inc) {
    const k = String(inc.bigmailKey == null ? '' : inc.bigmailKey).trim();
    if (!k || isMasked(k)) delete inc.bigmailKey; else inc.bigmailKey = k;
  }
  return inc;
}

function resolveKeyArg(stored, provider, key) {
  const k = String(key || '').trim();
  if (!k) return '';
  if (!isMasked(k)) return k;
  const hits = (keyPool(stored)[provider] || []).filter(h => maskKey(h) === k);
  return hits.length === 1 ? hits[0] : '';
}

module.exports = { sanitizeConfig, mergeIncomingKeys, resolveKeyArg, maskKey };
