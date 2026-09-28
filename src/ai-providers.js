// ============================================================
//  ai-providers.js — AI 제공자 프리셋 · 다중 제공자 체인 (단일 책임)
//  ------------------------------------------------------------
//  왜 필요한가 (2026-08-14 실측 장애)
//   Cerebras 무료 티어가 막혔다 — 서로 다른 계정의 키 9개 전부 HTTP 402
//   (param:"quota"), 반면 /v1/models 는 200(키 인증은 정상).
//   즉 '키 문제'가 아니라 '무료 호출 자체가 결제 요구' 상태다.
//   → ① 제공자를 갈아탈 수 있어야 하고
//     ② 마스터 요구(2026-08-14): "각 종류별 API를 동시에 2개씩 등록 — 한 서비스가
//        문제 생겨도 대안 가능하게" → 여러 제공자를 순위대로 등록하고 자동 폴백한다.
//
//  이 모듈은 순수 데이터·순수 함수만 갖는다(네트워크·DOM·파일 접근 0).
//   · 프리셋(베이스 URL·기본 모델·무료 한도·카드 필요 여부·학습 사용 여부)
//   · 제공자 체인 정규화 (순위 · 활성 · 제공자별 키/모델/URL 독립 저장)
//   · URL 조립 (baseUrl → /chat/completions · /models)
//  실제 호출·폴백 실행은 cerebras.js(제공자 중립 클라이언트)가 한다.
//  셀프체크: node src/ai-providers.js
// ============================================================

//  모두 OpenAI 호환(/chat/completions, /models) 엔드포인트다.
//  free      : 무료 사용 가능 여부·한도 요약
//  card      : 신용카드 등록 필요 여부
//  training  : 입력 데이터가 학습에 쓰일 수 있는지 (메일 내용이 나가므로 중요)
//  privacy   : 'local' 이면 데이터가 PC 밖으로 나가지 않는다
const PRESETS = {
  ollama: {
    id: 'ollama', label: 'Ollama (내 PC · 권장)',
    baseUrl: 'http://localhost:11434/v1',
    model: 'exaone3.5:7.8b',
    keyUrl: 'https://ollama.com/download',
    needsKey: false, privacy: 'local', recommended: true,
    free: '완전 무료(내 PC에서 실행)', card: '불필요', training: '없음 — 데이터가 PC 밖으로 나가지 않음',
    note: '🔒 메일 내용이 PC 밖으로 나가지 않습니다. Ollama 를 설치하고 모델을 받아두면 인터넷 없이도 동작합니다. 키는 아무 값이나 넣어도 됩니다.'
  },
  nvidia: {
    id: 'nvidia', label: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    model: 'z-ai/glm-5.2',
    keyUrl: 'https://build.nvidia.com',
    free: '무료 크레딧(가입만)', card: '불필요', training: '없음(문서 기준)',
    note: '카드 등록 없이 무료로 쓸 수 있고 처리량이 가장 좋은 편입니다.'
  },
  cerebras: {
    id: 'cerebras', label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    model: 'gpt-oss-120b',
    keyUrl: 'https://cloud.cerebras.ai',
    free: '무료 한도 있음(현재 소진 시 402)', card: '한도 초과 시 필요', training: '없음(문서 기준)',
    note: '무료 한도가 소진되면 402(결제 필요)가 납니다. Billing 확인 또는 다른 제공자로 전환하세요.'
  },
  groq: {
    id: 'groq', label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    // 실측(2026-08-20): 한국어 업무 메일 요약 품질 비교에서 gpt-oss-120b 압승(849ms).
    //  qwen3.6-27b 는 영어 <think> 장문만 내고 답을 못 맺어 부적합했다.
    //  Cerebras 에서 쓰던 모델과 같은 계열이라 기존 프롬프트가 그대로 호환된다.
    model: 'openai/gpt-oss-120b',
    keyUrl: 'https://console.groq.com/keys',
    free: '무료: 30 RPM · 1,000 RPD · 8K TPM · 200K TPD', card: '불필요', training: '없음(문서 기준)',
    // 실측 무료 한도 — 대량 배치(업무일지·브리핑)는 하루 토큰(TPD)이 먼저 걸린다.
    limits: { rpm: 30, rpd: 1000, tpm: 8000, tpd: 200000 },
    note: '무료 한도: 분당 30요청 · 하루 1,000요청 · 분당 8천토큰 · 하루 20만토큰. 하루 토큰이 한도에 가까워지면 다음 순위 제공자로 자동 전환됩니다.'
  },
  gemini: {
    id: 'gemini', label: 'Google Gemini',
    // Google 이 제공하는 OpenAI 호환 엔드포인트
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-3-flash',
    keyUrl: 'https://aistudio.google.com/apikey',
    free: '무료 등급 있음', card: '불필요', training: '⚠ 무료 등급은 학습에 사용될 수 있음',
    note: '⚠ 무료 등급에서는 보낸 내용이 서비스 개선(학습)에 쓰일 수 있습니다. 업무 메일에는 주의하세요.'
  },
  openrouter: {
    id: 'openrouter', label: 'OpenRouter (무료 전용)',
    baseUrl: 'https://openrouter.ai/api/v1',
    // 실측(2026-09-28, 한국어 업무메일 요약1 + JSON구조화1 실호출 비교 — RECON.md):
    //  nemotron-3-ultra-550b-a55b 1위(품질+안정), nemotron-3-super-120b-a12b 2위(최속),
    //  cohere/north-mini-code 3위. gemma-4-31b/26b·qwen3.8-27b 는 업스트림 429 상시 발생,
    //  nemotron-3.5-lightning 은 사고과정(thinking) 유출로 제외.
    model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    // OpenRouter 는 요청 본문의 models[] 로 최대 3개까지 자체 폴백한다(실측 확인, 4개째는 400).
    models: ['nvidia/nemotron-3-ultra-550b-a55b:free', 'nvidia/nemotron-3-super-120b-a12b:free', 'cohere/north-mini-code:free'],
    keyUrl: 'https://openrouter.ai/keys',
    preferFree: true,
    freeOnly: true,   // ★ 마스터 지시: 절대 무료로만 — :free 로 끝나지 않는 모델은 코드 레벨에서 거부
    // 실측(2026-09-28 /api/v1/key): free_model_daily_requests.limit = 1000/일. rpm/tpm 은
    //  문서/실측으로 확인되지 않아 넣지 않는다(추정치를 사실처럼 쓰지 않는다 — 하드코딩 금지 원칙).
    limits: { rpd: 1000 },
    free: '무료 모델(:free) 일 1,000회(실측)', card: '불필요', training: '⚠ 무료 모델은 학습에 사용될 수 있음',
    note: '⚠ :free 모델은 제공자가 데이터를 학습에 쓸 수 있습니다. 이 앱은 :free 가 아닌 모델은 호출 자체를 거부합니다.'
  },
  zai: {
    id: 'zai', label: 'Z.ai (GLM)',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    model: 'glm-4.7-flash',
    keyUrl: 'https://z.ai',
    free: 'flash 계열 무료', card: '불필요', training: '제공자 정책 확인 필요',
    note: 'GLM 계열 모델을 제공합니다. flash 모델이 무료입니다.'
  },
  cloudflare: {
    id: 'cloudflare', label: 'Cloudflare Workers AI',
    // 계정 ID 가 URL 에 들어간다 → accountId 입력칸이 필요하다
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1',
    model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    keyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    needsAccountId: true,
    free: '하루 무료 뉴런 제공', card: '불필요', training: '없음(문서 기준)',
    note: '계정 ID 를 함께 입력해야 합니다(대시보드 우측에서 확인).'
  },
  custom: {
    id: 'custom', label: '사용자 지정',
    baseUrl: '', model: '', keyUrl: '',
    free: '해당 서버 정책', card: '-', training: '-',
    note: 'OpenAI 호환 서버의 베이스 URL(끝에 /v1)과 모델 이름을 직접 입력하세요.'
  }
};

//  화면 드롭다운 순서 — 프라이버시 우선(내 PC) → 무료·카드 불필요 → 나머지
const PROVIDER_IDS = ['ollama', 'nvidia', 'cerebras', 'groq', 'zai', 'cloudflare', 'gemini', 'openrouter', 'custom'];
const DEFAULT_PROVIDER = 'cerebras';

function getPreset(id) {
  return PRESETS[String(id || '').toLowerCase()] || PRESETS[DEFAULT_PROVIDER];
}
function listPresets() {
  return PROVIDER_IDS.map(id => {
    const p = PRESETS[id];
    return {
      id, label: p.label, baseUrl: p.baseUrl, model: p.model, keyUrl: p.keyUrl, note: p.note,
      free: p.free, card: p.card, training: p.training, limits: p.limits || null,
      privacy: p.privacy || '', recommended: !!p.recommended,
      needsKey: p.needsKey !== false, needsAccountId: !!p.needsAccountId
    };
  });
}

// 베이스 URL 정규화 — 끝 슬래시 제거. 사용자가 전체 경로를 붙여 넣어도 살려 준다.
function normalizeBaseUrl(url) {
  let u = String(url || '').trim().replace(/\s+/g, '');
  if (!u) return '';
  u = u.replace(/\/+$/, '');
  u = u.replace(/\/chat\/completions$/i, '');
  return u;
}
//  {accountId} 자리표시자를 실제 값으로 채운다(Cloudflare)
function fillTemplate(url, vars) {
  let u = String(url || '');
  const v = vars || {};
  u = u.replace(/\{accountId\}/gi, String(v.accountId || '').trim());
  return u;
}
function chatUrl(baseUrl) {
  const b = normalizeBaseUrl(baseUrl);
  return b ? b + '/chat/completions' : '';
}
function modelsUrl(baseUrl) {
  const b = normalizeBaseUrl(baseUrl);
  return b ? b + '/models' : '';
}

const cleanKeys = (arr) => (arr || []).map(k => String(k == null ? '' : k).trim()).filter(Boolean);

// ------------------------------------------------------------
//  무료 원천 보장 (마스터 지시: "절대 무료로만") — OpenRouter 는 :free 로 끝나지
//  않는 모델을 코드 레벨에서 거부한다. 이 판정 함수 하나를 설정 UI·저장(normalizeEntry)·
//  실호출(cerebras.js) 세 곳에서 공유한다(SoT — 판정을 두 곳에 베끼지 않는다).
// ------------------------------------------------------------
const FREE_SUFFIX_RE = /:free$/i;
function isFreeModelId(id) { return FREE_SUFFIX_RE.test(String(id || '').trim()); }
//  OpenRouter models[] 폴백은 최대 3개까지만 허용된다(실측: 4개째부터 400 에러).
const OPENROUTER_MODELS_MAX = 3;

// ------------------------------------------------------------
//  제공자 1개(체인 항목) 정규화
//   entry = { provider, baseUrl, model, models[](OpenRouter 전용 폴백), keys[], enabled, accountId }
// ------------------------------------------------------------
function normalizeEntry(entry) {
  const e = entry || {};
  const id = PRESETS[e.provider] ? e.provider : DEFAULT_PROVIDER;
  const preset = getPreset(id);
  const rawBase = e.baseUrl || preset.baseUrl;
  const base = normalizeBaseUrl(fillTemplate(rawBase, { accountId: e.accountId }));
  const keys = cleanKeys(e.keys);
  let model = String(e.model || preset.model || '').trim();
  let models = null;
  if (preset.freeOnly) {
    // :free 가 아닌 모델은 요청 자체를 거부 — 프리셋 기본 무료 모델로 강제 대체한다.
    if (!isFreeModelId(model)) model = preset.model;
    const rawModels = Array.isArray(e.models) && e.models.length ? e.models : (preset.models || [model]);
    models = [...new Set(rawModels.map(m => String(m || '').trim()).filter(isFreeModelId))].slice(0, OPENROUTER_MODELS_MAX);
    if (!models.length) models = [preset.model];
    if (!models.includes(model)) model = models[0];
  }
  return {
    provider: id, label: preset.label,
    baseUrl: base, rawBaseUrl: rawBase,
    chatUrl: chatUrl(base), modelsUrl: modelsUrl(base),
    model,
    models,   // null(일반 제공자) | ['a:free','b:free',...](OpenRouter 폴백 배열)
    keys,
    // Ollama 는 키가 필요 없다 — 빈 값이어도 사용 가능으로 본다
    keyCount: keys.length,
    usable: !!base && (preset.needsKey === false || keys.length > 0),
    enabled: e.enabled !== false,
    accountId: String(e.accountId || '').trim(),
    needsKey: preset.needsKey !== false,
    needsAccountId: !!preset.needsAccountId,
    keyUrl: preset.keyUrl, note: preset.note,
    free: preset.free, card: preset.card, training: preset.training, limits: preset.limits || null,
    privacy: preset.privacy || '', recommended: !!preset.recommended,
    freeOnly: !!preset.freeOnly
  };
}

//  배치·자동 작업(업무일지·브리핑·스케줄러) 순서 — Groq 를 앞으로 당긴다(마스터 지시:
//  사용자 직접 요청은 OpenRouter 우선, 자동/배치는 Groq 우선 — OpenRouter 일일 한도를 대화용으로 아낀다).
//  다른 제공자들의 상대 순서는 그대로 둔다(Array.sort 는 안정 정렬 — ES2019+).
function reorderForBatch(chain) {
  return [...(chain || [])].sort((a, b) => (a.provider === 'groq' ? 0 : 1) - (b.provider === 'groq' ? 0 : 1));
}

// ------------------------------------------------------------
//  설정 → 제공자 체인 (순위 = 배열 순서)
//   cfg.aiChain 이 있으면 그것을, 없으면 예전 단일 제공자 설정에서 만든다(하위 호환).
// ------------------------------------------------------------
function normalizeChain(cfg) {
  const c = cfg || {};
  let raw = Array.isArray(c.aiChain) && c.aiChain.length ? c.aiChain : null;
  if (!raw) {
    // 레거시: aiProvider + apiKeysByProvider/apiKeys
    const id = PRESETS[c.aiProvider] ? c.aiProvider : DEFAULT_PROVIDER;
    const map = c.apiKeysByProvider || {};
    const keys = cleanKeys(map[id]).length ? cleanKeys(map[id])
      : (id === DEFAULT_PROVIDER ? cleanKeys(c.apiKeys) : []);
    raw = [{ provider: id, baseUrl: c.aiBaseUrl || '', model: c.model || '', keys, enabled: true }];
  }
  return raw.map(normalizeEntry);
}

//  실제 호출에 쓸 수 있는 항목만(활성 + 사용 가능), 순위 유지
function activeChain(cfg) {
  return normalizeChain(cfg).filter(e => e.enabled && e.usable);
}

//  체인 저장용 형태로 되돌린다(화면 입력값 → 설정)
function toStoredChain(list) {
  return (list || []).map(e => ({
    provider: PRESETS[e.provider] ? e.provider : DEFAULT_PROVIDER,
    baseUrl: String(e.baseUrl || '').trim(),
    model: String(e.model || '').trim(),
    keys: (e.keys || []).map(k => String(k == null ? '' : k).trim()),
    accountId: String(e.accountId || '').trim(),
    enabled: e.enabled !== false
  }));
}

//  1순위(주 제공자) — 기존 단일 제공자 코드 경로가 쓰는 값
function resolve(cfg) {
  const chain = activeChain(cfg);
  if (chain.length) return chain[0];
  const all = normalizeChain(cfg);
  return all[0] || normalizeEntry({ provider: DEFAULT_PROVIDER });
}

// 제공자별 키 세트 읽기 (레거시 apiKeys 호환)
function keysFor(cfg, providerId) {
  const c = cfg || {};
  const id = providerId || c.aiProvider || DEFAULT_PROVIDER;
  const fromChain = normalizeChain(c).find(e => e.provider === id);
  if (fromChain && fromChain.keys.length) return fromChain.keys;
  const map = c.apiKeysByProvider || {};
  if (cleanKeys(map[id]).length) return cleanKeys(map[id]);
  return id === DEFAULT_PROVIDER ? cleanKeys(c.apiKeys) : [];
}

// 제공자별 키 세트 저장 — 다른 제공자의 키는 절대 건드리지 않는다.
function withKeys(cfg, providerId, keys) {
  const c = cfg || {};
  const id = PRESETS[providerId] ? providerId : DEFAULT_PROVIDER;
  const map = Object.assign({}, c.apiKeysByProvider || {});
  const clean = (keys || []).map(k => String(k == null ? '' : k).trim());
  map[id] = clean;
  const out = Object.assign({}, c, { apiKeysByProvider: map });
  if (id === DEFAULT_PROVIDER) out.apiKeys = clean;
  return out;
}

// 모델 목록 정리 — OpenRouter 는 무료(:free)를 앞으로, 그 외는 이름순.
//  freeOnly 제공자(OpenRouter)는 마스터 지시("절대 무료로만")로 :free 가 아닌 모델을
//  화면 드롭다운에서 아예 제외한다(정렬이 아니라 차단 — 잘못 골라 유료 호출되는 사고 방지).
function sortModels(ids, providerId) {
  let list = [...new Set((ids || []).map(x => String(x || '').trim()).filter(Boolean))];
  const preset = getPreset(providerId);
  if (preset.freeOnly) list = list.filter(isFreeModelId);
  return list.sort((a, b) => {
    if (preset.preferFree) {
      const fa = isFreeModelId(a) ? 0 : 1, fb = isFreeModelId(b) ? 0 : 1;
      if (fa !== fb) return fa - fb;
    }
    return a.localeCompare(b);
  });
}

module.exports = {
  PRESETS, PROVIDER_IDS, DEFAULT_PROVIDER,
  getPreset, listPresets, resolve, keysFor, withKeys,
  normalizeBaseUrl, fillTemplate, chatUrl, modelsUrl, sortModels,
  normalizeEntry, normalizeChain, activeChain, toStoredChain,
  isFreeModelId, reorderForBatch, OPENROUTER_MODELS_MAX
};

// ============================================================
//  셀프체크 — node src/ai-providers.js
// ============================================================
if (require.main === module) {
  const assert = require('assert');

  // ① 프리셋 — 베이스 URL·기본 모델이 채워져 있어야 '키만 입력'이 가능하다
  for (const id of ['ollama', 'nvidia', 'cerebras', 'groq', 'gemini', 'openrouter', 'zai', 'cloudflare']) {
    const p = getPreset(id);
    assert.ok(p.baseUrl && p.model, id + ' 프리셋에 URL/모델이 없다');
    assert.ok(p.free && p.card && p.training, id + ' 에 무료/카드/학습 안내가 없다');
  }
  assert.strictEqual(getPreset('custom').baseUrl, '', '사용자 지정은 비어 있어야 한다');
  assert.strictEqual(listPresets().length, 9, '프리셋 9종이 아니다');
  // 프라이버시 우선: 목록 첫 번째가 로컬(Ollama)이고 추천 표시가 있어야 한다
  const first = listPresets()[0];
  assert.strictEqual(first.id, 'ollama', '로컬 제공자가 첫 번째가 아니다');
  assert.strictEqual(first.privacy, 'local');
  assert.strictEqual(first.recommended, true);
  assert.ok(/PC 밖으로 나가지 않/.test(first.note), '프라이버시 안내 문구가 없다');
  assert.strictEqual(first.needsKey, false, 'Ollama 는 키가 필요 없어야 한다');
  // 학습 경고 표기 (실측 지시)
  assert.ok(/학습/.test(getPreset('gemini').training), 'gemini 학습 경고 누락');
  assert.ok(/학습/.test(getPreset('openrouter').training), 'openrouter 학습 경고 누락');
  // 실측 정정 반영
  assert.notStrictEqual(getPreset('openrouter').model, 'meta-llama/llama-3.3-70b-instruct:free', '존재하지 않는 모델이 그대로다');
  assert.ok(/:free$/.test(getPreset('openrouter').model), 'openrouter 기본 모델이 무료 모델이 아니다');
  assert.notStrictEqual(getPreset('gemini').model, 'gemini-2.0-flash', 'gemini 모델이 갱신되지 않았다');
  // Groq 실측 반영: 한국어 품질 1위 모델 + 무료 한도 수치
  assert.strictEqual(getPreset('groq').model, 'openai/gpt-oss-120b', 'groq 기본 모델이 실측 결과와 다르다');
  const gl = getPreset('groq').limits;
  assert.ok(gl && gl.rpm === 30 && gl.rpd === 1000 && gl.tpm === 8000 && gl.tpd === 200000, 'groq 무료 한도 수치 누락');
  assert.ok(listPresets().find(x => x.id === 'groq').limits, '프리셋 목록에 limits 가 실리지 않는다');

  // ② URL 조립 — 끝 슬래시·중복 경로 방어 + Cloudflare 계정ID 치환
  assert.strictEqual(chatUrl('https://api.groq.com/openai/v1'), 'https://api.groq.com/openai/v1/chat/completions');
  assert.strictEqual(chatUrl('https://api.groq.com/openai/v1/'), 'https://api.groq.com/openai/v1/chat/completions');
  assert.strictEqual(chatUrl('https://x.y/v1/chat/completions'), 'https://x.y/v1/chat/completions', '전체 경로를 붙여 넣어도 살려야 한다');
  assert.strictEqual(modelsUrl('https://openrouter.ai/api/v1/'), 'https://openrouter.ai/api/v1/models');
  assert.strictEqual(chatUrl(''), '');
  assert.strictEqual(fillTemplate('https://a/{accountId}/ai/v1', { accountId: 'ACC1' }), 'https://a/ACC1/ai/v1');

  // ③ 레거시 설정 → 체인 1개 (기존 사용자 보호)
  const legacy = normalizeChain({ apiKeys: ['k1', 'k2'] });
  assert.strictEqual(legacy.length, 1);
  assert.strictEqual(legacy[0].provider, 'cerebras');
  assert.deepStrictEqual(legacy[0].keys, ['k1', 'k2'], '레거시 apiKeys 를 못 읽는다');
  assert.strictEqual(legacy[0].chatUrl, 'https://api.cerebras.ai/v1/chat/completions');

  // ④ 다중 제공자 체인 — 순위·활성·독립 저장 (마스터 요구)
  const cfg = {
    aiChain: [
      { provider: 'cerebras', keys: ['cs-1', 'cs-2'], enabled: true },
      { provider: 'groq', keys: ['gq-1', 'gq-2'], enabled: true },
      { provider: 'gemini', keys: ['gm-1'], enabled: false },
      { provider: 'custom', baseUrl: '', keys: ['x'], enabled: true }        // URL 없음 → 사용 불가
    ]
  };
  const chain = normalizeChain(cfg);
  assert.strictEqual(chain.length, 4);
  const act = activeChain(cfg);
  assert.deepStrictEqual(act.map(e => e.provider), ['cerebras', 'groq'], '활성·사용가능 판정이 틀렸다');
  assert.strictEqual(act[0].keys.length, 2, '제공자마다 키 2개 이상 등록이 안 된다');
  assert.strictEqual(act[1].chatUrl, 'https://api.groq.com/openai/v1/chat/completions');
  assert.strictEqual(resolve(cfg).provider, 'cerebras', '1순위가 주 제공자여야 한다');
  // 순위를 바꾸면 주 제공자도 바뀐다
  const swapped = { aiChain: [cfg.aiChain[1], cfg.aiChain[0]] };
  assert.strictEqual(resolve(swapped).provider, 'groq');
  // 제공자별 설정이 서로 독립 — groq 를 지워도 cerebras 키는 남는다
  const removed = { aiChain: cfg.aiChain.filter(e => e.provider !== 'groq') };
  assert.deepStrictEqual(resolve(removed).keys, ['cs-1', 'cs-2']);

  // ⑤ Ollama — 키 없이도 사용 가능 판정
  const oll = normalizeEntry({ provider: 'ollama', keys: [] });
  assert.strictEqual(oll.usable, true, '로컬 제공자는 키 없이도 사용 가능해야 한다');
  assert.strictEqual(oll.chatUrl, 'http://localhost:11434/v1/chat/completions');
  // 키가 필요한 제공자는 키가 없으면 사용 불가
  assert.strictEqual(normalizeEntry({ provider: 'groq', keys: [] }).usable, false);

  // ⑥ Cloudflare — 계정 ID 가 URL 에 채워진다
  const cf = normalizeEntry({ provider: 'cloudflare', accountId: 'ACC9', keys: ['t'] });
  assert.ok(cf.chatUrl.indexOf('/accounts/ACC9/ai/v1/chat/completions') > 0, 'accountId 치환 실패: ' + cf.chatUrl);
  assert.strictEqual(cf.needsAccountId, true);
  assert.strictEqual(normalizeEntry({ provider: 'cloudflare', accountId: '', keys: ['t'] }).chatUrl.indexOf('{accountId}'), -1);

  // ⑦ 저장 왕복 — 화면 입력값 → 설정 → 다시 체인
  const stored = toStoredChain([{ provider: 'groq', keys: ['a', ''], model: '', enabled: true }]);
  assert.deepStrictEqual(stored[0].keys, ['a', ''], '입력 슬롯(빈 칸 포함)을 그대로 보존해야 한다');
  assert.deepStrictEqual(normalizeChain({ aiChain: stored })[0].keys, ['a'], '빈 키는 사용 시 걸러져야 한다');

  // ⑧ 알 수 없는 제공자는 안전 폴백
  assert.strictEqual(normalizeEntry({ provider: '없는제공자' }).provider, 'cerebras');

  // ⑨ 모델 정렬 — OpenRouter 는 무료 우선
  const sorted = sortModels(['b/model', 'a/model:free', 'c/model', 'a/model'], 'openrouter');
  assert.ok(/:free$/.test(sorted[0]), '무료 모델이 앞에 오지 않는다');
  assert.deepStrictEqual(sortModels(['b', 'a'], 'groq'), ['a', 'b']);
  assert.deepStrictEqual(sortModels(['a', 'a', ''], 'groq'), ['a'], '중복·빈값 정리 실패');

  // ⑩ 제공자별 키 조회(레거시 호환)
  assert.deepStrictEqual(keysFor({ aiChain: cfg.aiChain }, 'groq'), ['gq-1', 'gq-2']);
  assert.deepStrictEqual(keysFor({ apiKeys: ['old'] }, 'cerebras'), ['old']);

  // ⑪ OpenRouter 무료 원천 보장 (마스터 지시: "절대 무료로만") — 2026-09-28
  //   :free 가 아닌 모델을 넣으면 호출 자체를 거부하고 무료 기본 모델로 강제 대체한다.
  const paidAttempt = normalizeEntry({ provider: 'openrouter', model: 'openai/gpt-5-pro', keys: ['or-1'] });
  assert.ok(isFreeModelId(paidAttempt.model), '유료 모델 차단 실패: ' + paidAttempt.model);
  assert.strictEqual(paidAttempt.model, getPreset('openrouter').model, '무료 기본 모델로 대체되지 않았다');
  // models[] 폴백도 :free 아닌 항목은 걸러지고, 3개 초과는 잘린다(실측: 4개째부터 400)
  const overModels = normalizeEntry({
    provider: 'openrouter', keys: ['or-1'],
    models: ['a:free', 'b-paid', 'c:free', 'd:free', 'e:free']
  });
  assert.deepStrictEqual(overModels.models, ['a:free', 'c:free', 'd:free'], 'models[] 필터·상한(3개) 실패: ' + JSON.stringify(overModels.models));
  assert.strictEqual(overModels.models.length <= OPENROUTER_MODELS_MAX, true);
  // 일반 제공자는 models 필드가 없다(null) — OpenRouter 전용 개념을 다른 제공자로 새지 않게
  assert.strictEqual(normalizeEntry({ provider: 'groq', keys: ['g-1'] }).models, null);
  assert.strictEqual(isFreeModelId('nvidia/nemotron-3-ultra-550b-a55b:free'), true);
  assert.strictEqual(isFreeModelId('openai/gpt-5-pro'), false);
  // 실측(2026-09-28 /api/v1/key): 일일 요청 한도 1000 — 설정화면 사용량 표시(refreshAiUsage)가 쓴다
  assert.strictEqual(getPreset('openrouter').limits.rpd, 1000, 'OpenRouter 실측 일일 한도가 전제와 다르다');
  assert.strictEqual(getPreset('openrouter').freeOnly, true);

  // ⑫ 배치(업무일지·브리핑·스케줄러) 우선순위 — Groq 를 앞으로 당긴다
  const forInteractive = normalizeChain({
    aiChain: [{ provider: 'openrouter', keys: ['or-1'] }, { provider: 'groq', keys: ['gq-1'] }]
  });
  assert.deepStrictEqual(forInteractive.map(e => e.provider), ['openrouter', 'groq'], '대화형 기본 순서(OpenRouter 우선)가 틀렸다');
  const forBatch = reorderForBatch(forInteractive);
  assert.deepStrictEqual(forBatch.map(e => e.provider), ['groq', 'openrouter'], '배치 순서(Groq 우선) 재배치 실패');
  // 3개 이상이어도 groq 만 앞으로 오고 나머지 상대 순서는 유지된다
  const three = reorderForBatch(normalizeChain({
    aiChain: [{ provider: 'openrouter', keys: ['a'] }, { provider: 'gemini', keys: ['b'] }, { provider: 'groq', keys: ['c'] }]
  }));
  assert.deepStrictEqual(three.map(e => e.provider), ['groq', 'openrouter', 'gemini'], '3개 이상일 때 상대 순서 보존 실패');

  console.log('ai-providers 셀프체크 OK — 프리셋 9종(로컬우선·무료/카드/학습 안내·모델 정정) + URL조립/계정ID + 체인(순위·활성·독립저장·폴백대상) + Ollama 무키 + 저장왕복 + 모델정렬 + OpenRouter 무료전용 강제(모델차단·models[]상한3·일일1000) + 배치우선순위(Groq) 통과');
}
