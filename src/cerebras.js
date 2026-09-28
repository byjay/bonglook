// ============================================================
//  cerebras.js - AI 추론 API 호출 (제공자 중립 · OpenAI 호환)
//  ※ 파일명은 유지하되 내부는 일반화됐다. baseUrl/model 을 인자로 받는다.
//    Cerebras · Groq · Gemini(OpenAI 호환) · OpenRouter · 사용자 지정 모두 같은 코드로 호출한다.
//  ------------------------------------------------------------
//  ★ OpenAI 호환 API (https://api.cerebras.ai/v1/chat/completions)
//  ★ 안정성 핵심: API 키 풀(최대 7개) 라운드로빈 + 키별 쿨다운
//     - 평시: 호출마다 다음 키로 순환해 특정 키만 닳지 않게 분산
//     - 429: 그 키만 retry-after 만큼 쿨다운, 다른 키로 즉시 계속
//     - 대량 처리(mapReduce): 동시성 3, 워커마다 다른 키 고정 배정
//  ------------------------------------------------------------
//  참고: Cerebras 는 텍스트 모델입니다. 이미지는 attachments.js 에서
//        메타/텍스트로 변환하여 프롬프트에 포함됩니다.
// ============================================================

const aiErrors = require('./ai-errors');   // 실패 → 사람이 읽는 문구(raw JSON 노출 금지)
const aiProviders = require('./ai-providers');   // isFreeModelId — OpenRouter 무료 원천 보장(SoT 공유)

// 현재 활성 엔드포인트. main 이 설정을 읽어 setEndpoint() 로 주입한다.
//  ponytail: 이 앱은 한 번에 제공자 하나만 쓴다 → 호출부 시그니처를 전부 바꾸는 대신
//            모듈 단일 기본값을 갱신한다(호출자가 url 을 넘기면 그쪽이 우선).
let DEFAULT_CHAT_URL = 'https://api.cerebras.ai/v1/chat/completions';
let activeProvider = 'cerebras';
// ============================================================
//  제공자 체인 (마스터 요구: 여러 제공자를 순위대로 등록 → 자동 폴백)
//  ------------------------------------------------------------
//  activeChainList[i] = { provider, label, chatUrl, model, keys[] }
//  한 제공자가 402/401/403/5xx 로 막히면 그 제공자를 쿨다운시키고
//  다음 순위 제공자로 같은 요청을 다시 시도한다(429 는 기존 키 백오프 유지).
// ============================================================
let activeChainList = [];
// ============================================================
//  제공자별 사용량 (무료 한도 방어)
//  ------------------------------------------------------------
//  Groq 무료 한도 실측(2026-08-20): 30 RPM · 1,000 RPD · 8K TPM · 200K TPD.
//  대량 배치(업무일지·브리핑)는 '하루 토큰(TPD)'이 먼저 걸린다(메일 100여 건 수준).
//   → 호출마다 usage.total_tokens 를 누적하고, 한도의 85% 를 넘으면
//     그 제공자를 쿨다운시켜 다음 순위로 자동 전환한다.
//  usageState[provider] = { day:'YYYY-MM-DD', req, tokens, minute:{ ts, req, tokens } }
// ============================================================
const usageState = new Map();
// ============================================================
//  reasoning 토큰 방어 (2026-08-20 실측 사고)
//  ------------------------------------------------------------
//  gpt-oss 계열은 추론(reasoning) 토큰을 먼저 소비한다. 실측에서 짧은 프롬프트에도
//  reasoning 655 토큰이 나갔고, 업무일지 map(maxTokens 1600)에서는 추론이 예산을
//  다 먹어 본문이 "[2026-08-19] 한일: " 17자로 잘렸다.
//   → gpt-oss 모델에는 reasoning_effort:'low' 를 붙인다(실측: 추론 655→55,
//     응답 2.4s→1.1s, 본문은 오히려 완전해짐).
//   → 이 파라미터를 모르는 제공자가 400 을 내면 그 엔드포인트는 기억해 두고 빼고 재시도한다.
// ============================================================
const effortUnsupported = new Set();
let usagePersist = null;            // main 이 주입: (obj) => void  (userData 에 저장)
const NEAR_LIMIT_RATIO = 0.85;      // 한도의 85% 를 넘으면 '근접'으로 본다

const todayKey = () => {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
};
function usageOf(provider) {
  const key = String(provider || 'unknown');
  let u = usageState.get(key);
  const day = todayKey();
  if (!u || u.day !== day) {        // 날짜가 바뀌면 초기화(하루 한도 기준)
    u = { day, req: 0, tokens: 0, minute: { ts: 0, req: 0, tokens: 0 } };
    usageState.set(key, u);
  }
  return u;
}
function noteUsage(provider, tokens) {
  const u = usageOf(provider);
  const now = Date.now();
  if (now - u.minute.ts > 60000) u.minute = { ts: now, req: 0, tokens: 0 };
  u.req += 1; u.minute.req += 1;
  const t = Number(tokens) || 0;
  u.tokens += t; u.minute.tokens += t;
  if (usagePersist) { try { usagePersist(usageSnapshot()); } catch (e) { /* 저장 실패는 무시 */ } }
  return u;
}
//  한도 대비 사용률 — limits 는 ai-providers 프리셋에서 체인에 실려 온다
function limitStatus(provider) {
  const node = activeChainList.find(e => e.provider === provider);
  const lim = (node && node.limits) || null;
  const u = usageOf(provider);
  if (!lim) return { near: false, over: false, ratio: 0, usage: u, limits: null };
  const r = (a, b) => (b ? a / b : 0);
  const ratios = {
    rpd: r(u.req, lim.rpd), tpd: r(u.tokens, lim.tpd),
    rpm: r(u.minute.req, lim.rpm), tpm: r(u.minute.tokens, lim.tpm)
  };
  const worst = Math.max(ratios.rpd, ratios.tpd);          // 하루 한도가 병목
  return {
    near: worst >= NEAR_LIMIT_RATIO, over: worst >= 1,
    ratio: worst, ratios, usage: u, limits: lim
  };
}
function usageSnapshot() {
  const out = {};
  for (const [k, v] of usageState.entries()) {
    const st = limitStatus(k);
    out[k] = {
      day: v.day, req: v.req, tokens: v.tokens,
      limits: st.limits, ratio: Math.round(st.ratio * 1000) / 1000, near: st.near, over: st.over
    };
  }
  return out;
}
function setUsageStore(store) {
  usagePersist = store && store.set ? store.set : null;
  try {
    const saved = store && store.get ? store.get() : null;
    if (saved && typeof saved === 'object') {
      const day = todayKey();
      for (const [k, v] of Object.entries(saved)) {
        if (v && v.day === day) usageState.set(k, { day, req: v.req || 0, tokens: v.tokens || 0, minute: { ts: 0, req: 0, tokens: 0 } });
      }
    }
  } catch (e) { /* 손상된 파일은 무시하고 새로 센다 */ }
}
let providerCooldown = new Map();       // provider id → 해제 시각(ms)
let lastSwitch = null;                  // { from, to, at } — 화면 안내용
let lastLimitWarning = null;            // { provider, label, ratio, at } — 한도 근접 경고
const PROVIDER_COOLDOWN_MS = 10 * 60 * 1000;

// ============================================================
//  대화형(interactive) / 배치(batch) 순서를 따로 둔다(마스터 지시 2026-09-28).
//   - 대화형(사용자가 직접 누른 분석·초안·대화): OpenRouter 1순위
//   - 배치·자동(업무일지·브리핑·스케줄러·교차검증 2번째 경로): Groq 1순위
//     → OpenRouter 무료 일일 한도를 대화용으로 아낀다.
//  두 목록은 '순서'만 다르고 같은 제공자 집합을 가리킨다 — 쿨다운/사용량(usageState,
//  providerCooldown)은 provider id 기준으로 공유되므로 이중 집계되지 않는다.
// ============================================================
let batchChainList = [];
function setChain(list, batchList) {
  activeChainList = (list || []).filter(e => e && e.chatUrl);   // { provider,label,chatUrl,model,models,keys,limits }
  batchChainList = (batchList && batchList.length) ? batchList.filter(e => e && e.chatUrl) : activeChainList;
  providerCooldown.clear();
  lastSwitch = null;
  lastErrorInfo = null; lastOkAt = 0; cooldownUntil.clear();
  if (activeChainList.length) {
    DEFAULT_CHAT_URL = activeChainList[0].chatUrl;
    activeProvider = activeChainList[0].provider;
  }
}
function currentChain() {
  return activeChainList.map(e => {
    const st = limitStatus(e.provider);
    return {
      provider: e.provider, label: e.label, model: e.model, keys: (e.keys || []).length,
      cooling: (providerCooldown.get(e.provider) || 0) > Date.now(),
      usedReq: st.usage.req, usedTokens: st.usage.tokens,
      limits: st.limits, ratio: Math.round(st.ratio * 1000) / 1000, near: st.near, over: st.over
    };
  });
}
function lastSwitchInfo() { return lastSwitch; }
function lastLimitInfo() { return lastLimitWarning; }

//  지금 쓸 수 있는 제공자 목록 (쿨다운 아닌 것 우선, 전부 쿨다운이면 원래 순서대로)
//  mode='batch' 면 배치용 순서(Groq 우선)를 쓴다. 기본(대화형)은 OpenRouter 우선 순서.
function usableChain(mode) {
  const base = mode === 'batch' ? batchChainList : activeChainList;
  const now = Date.now();
  const fresh = base.filter(e => (providerCooldown.get(e.provider) || 0) <= now);
  return fresh.length ? fresh : base.slice();
}

//  제공자 단위 폴백이 필요한 실패인가 (429 는 제외 — 키 백오프로 처리한다)
function shouldSwitchProvider(kind) {
  return kind === 'quota' || kind === 'key' || kind === 'server' || kind === 'network' || kind === 'nokey' || kind === 'toolarge';
}

function setEndpoint(url, provider) {
  if (url && String(url).trim()) DEFAULT_CHAT_URL = String(url).trim();
  if (provider) activeProvider = String(provider);
  // 제공자가 바뀌면 이전 제공자의 실패 상태·쿨다운을 끌고 가지 않는다
  lastErrorInfo = null; lastOkAt = 0; cooldownUntil.clear();
}
function currentEndpoint() { return { url: DEFAULT_CHAT_URL, provider: activeProvider }; }

// ============================================================
//  키 풀 (라운드로빈 + 키별 쿨다운)
//  ------------------------------------------------------------
//  실측(2026-07-30):
//   · 응답 헤더 x-ratelimit-limit-tokens-minute = 30000, remaining 이 키마다 독립 감소
//     → 키별 독립 쿼터 확정
//   · 같은 키로 3동시 → 429 2건("Requests per minute limit exceeded", retry-after 60)
//     즉 제한은 TPM 이 아니라 RPM(분당 요청수) → 키를 돌려 쓰는 것이 직접적 해법
//   · 다른 키 3동시 → 3/3 성공, 순차 1720ms 대비 806ms (2.13배)
// ============================================================
let rrIndex = 0;                       // 라운드로빈 위치
const cooldownUntil = new Map();       // key 문자열 → 해제 시각(ms)
let stateStore = null;                 // { get(), set(v) } — main 이 주입(영속)
let lastOkAt = 0;                      // 마지막으로 성공한 시각(ms)
let lastErrorInfo = null;              // 마지막 실패 판정(ai-errors.describe 결과)

function setKeyStateStore(store) {
  stateStore = store;
  try {
    const v = parseInt(store && store.get ? store.get() : '', 10);
    if (Number.isFinite(v) && v >= 0) rrIndex = v;
  } catch (_) {}
}
function persistIndex() {
  try { if (stateStore && stateStore.set) stateStore.set(String(rrIndex)); } catch (_) {}
}
function isCool(key) {
  const until = cooldownUntil.get(key) || 0;
  return until <= Date.now();
}
function markCooldown(key, seconds) {
  cooldownUntil.set(key, Date.now() + Math.max(1, seconds) * 1000);
}
// 사용 가능한 키를 라운드로빈으로 하나 고른다. 전부 쿨다운이면 null + 최단 대기시간 반환.
function pickKey(validKeys, exclude = new Set()) {
  const n = validKeys.length;
  for (let i = 0; i < n; i++) {
    const idx = (rrIndex + i) % n;
    const k = validKeys[idx];
    if (exclude.has(k) || !isCool(k)) continue;
    rrIndex = (idx + 1) % n;
    persistIndex();
    return { key: k, index: idx };
  }
  let soonest = Infinity;
  for (const k of validKeys) soonest = Math.min(soonest, cooldownUntil.get(k) || 0);
  return { key: null, waitMs: Math.max(0, soonest - Date.now()) };
}
function poolStatus(keys) {
  const valid = (keys || []).filter(k => k && k.trim());
  const now = Date.now();
  return {
    total: valid.length,
    available: valid.filter(k => (cooldownUntil.get(k) || 0) <= now).length,
    cooling: valid.filter(k => (cooldownUntil.get(k) || 0) > now).length,
    nextIndex: valid.length ? rrIndex % valid.length : 0
  };
}

// 다음 키로 넘어갈 상태 (키 문제/서버 문제)
//  ★ 429 는 '키별' 분당 요청/토큰 한도다(실측 확인) → 해당 키만 쿨다운시키고
//    다른 키로 즉시 계속한다. 전 키가 쿨다운일 때만 아래 지연으로 대기한다.
//  402(결제 필요/한도 소진)도 폴백 대상이다 — 키마다 계정이 다를 수 있으므로 다음 키를 시도한다.
const FALLBACK_STATUSES = new Set([401, 402, 403, 500, 502, 503, 504]);
const RETRY_DELAYS = [5000, 15000, 30000];   // 전 키 쿨다운 시 대기 단계

// ------------------------------------------------------------
//  프롬프트 토큰 추정 (문자수/3 근사) — Groq 무료 티어 8K TPM 방어용.
//  호출부(analyzer.js)가 요청 전에 크기를 가늠해 스스로 축소하도록 노출한다.
// ------------------------------------------------------------
function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 3);
}
function messagesTokens(messages) {
  return (messages || []).reduce((sum, m) => sum + estimateTokens(m && m.content), 0);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

//  pinKey: mapReduce 워커가 특정 키를 고정 배정받을 때 사용 (키 충돌 방지)
//  models: OpenRouter 전용 자체 폴백 배열(최대 3개) — 1순위가 막히면 OpenRouter 서버가 알아서 다음으로 넘어간다.
async function chatOnce({ keys, model, messages, temperature = 0.3, maxTokens = 4096, onRetry = null, pinKey = null, url = null, provider = '', models = null }) {
  const endpoint = url || DEFAULT_CHAT_URL;
  const validKeys = (keys || []).filter(k => k && k.trim()).map(k => k.trim());
  if (validKeys.length === 0) {
    const info = aiErrors.describe({ kind: 'nokey' });
    return { ok: false, errorKind: info.kind, errorInfo: info, error: aiErrors.shortText(info) };
  }
  // ★ 무료 원천 보장(마스터 지시: "절대 무료로만") — OpenRouter 인데 모델이 :free 가 아니면
  //   네트워크 호출 자체를 하지 않는다. 설정 화면(ai-providers.normalizeEntry)에서도 이미 막지만,
  //   여기가 실제 과금 호출이 나가는 최종 지점이라 한 번 더 막는다(단일 지점 방어의 마지막 관문).
  const isOpenRouter = String(provider || '').toLowerCase() === 'openrouter';
  if (isOpenRouter && !aiProviders.isFreeModelId(model)) {
    const info = aiErrors.describe({ message: `무료(:free) 모델이 아니라 호출을 거부했습니다: ${model}` });
    return { ok: false, errorKind: 'blocked_paid_model', errorInfo: info, error: '무료 모델이 아니라 호출을 차단했습니다: ' + model };
  }

  const errors = [];
  let lastFailure = null;           // 마지막으로 판정된 실패 원인(사람 문구)
  let rateWait = 0;                 // 전 키가 쿨다운일 때의 대기 횟수
  const tried = new Set();          // 이번 호출에서 이미 실패한 키
  const maxAttempts = validKeys.length + RETRY_DELAYS.length;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // 키 선택: 고정 배정(pinKey)이 있으면 그것을, 없으면 라운드로빈으로
    let key, keyIdx;
    if (pinKey && isCool(pinKey) && !tried.has(pinKey)) {
      key = pinKey; keyIdx = validKeys.indexOf(pinKey);
    } else {
      const p = pickKey(validKeys, tried);
      if (!p.key) {
        // 전 키가 쿨다운 → 가장 빨리 풀리는 키까지 대기 후 재시도
        if (rateWait >= RETRY_DELAYS.length) {
          const coolInfo = aiErrors.describe({ kind: 'rate' });
          lastFailure = coolInfo; lastErrorInfo = coolInfo;
          return {
            ok: false, rateLimited: true,
            errorKind: coolInfo.kind, errorInfo: coolInfo,
            error: aiErrors.shortText(coolInfo)
          };
        }
        const waitMs = Math.min(Math.max(p.waitMs || 0, 1000), 61000);
        if (onRetry) onRetry({ status: 429, waitMs, attempt: ++rateWait, allCooling: true });
        await sleep(waitMs);
        tried.clear();
        continue;
      }
      key = p.key; keyIdx = p.index;
    }
    const i = keyIdx;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 90000); // 90초 타임아웃

      //  gpt-oss 계열은 추론 토큰이 본문 예산을 먹는다 → 추론을 'low' 로 낮춘다.
      const useEffort = /gpt-oss/i.test(String(model || '')) && !effortUnsupported.has(endpoint);
      const payload = {
        model: model || 'gpt-oss-120b',
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false
      };
      if (useEffort) payload.reasoning_effort = 'low';
      if (isOpenRouter) {
        // OpenRouter 자체 모델 폴백(실측: 최대 3개, 4개째부터 400) — 1순위가 막히면 서버가 다음으로 넘어간다.
        if (Array.isArray(models) && models.length > 1) payload.models = models.slice(0, 3);
        // 가격 상한 0 라우팅(실측 확인: provider.max_price 가 수용됨) — 무료 원천을 한 번 더 못박는다.
        payload.provider = { max_price: { prompt: 0, completion: 0 } };
      }
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (!resp.ok) {
        const errText = await safeText(resp);
        // ★ 429 = 이 키의 분당 요청/토큰 한도. 해당 키만 쿨다운 처리하고 다른 키로 즉시 계속.
        if (resp.status === 429) {
          const ra = parseInt(resp.headers.get('retry-after') || '', 10);
          markCooldown(key, Number.isFinite(ra) ? ra : 60);
          tried.add(key);
          //  전 키가 429 로 끝나도 원인이 '한도 대기'로 남게 한다(마지막 실패 판정)
          lastFailure = aiErrors.describe({ kind: 'rate' });
          errors.push(`키#${i + 1}: 429 (${Number.isFinite(ra) ? ra : 60}초 쿨다운)`);
          if (onRetry) onRetry({ status: 429, key: i + 1, cooldownSec: Number.isFinite(ra) ? ra : 60 });
          continue;               // 다음 키로
        }
        //  이 제공자가 reasoning_effort 를 모르면(400) 그 옵션만 빼고 같은 키로 다시 시도한다
        if (resp.status === 400 && useEffort && /reasoning_effort/i.test(errText)) {
          effortUnsupported.add(endpoint);
          attempt--;                       // 이번 시도는 무효 처리(키를 소모하지 않는다)
          continue;
        }
        // ★ raw JSON 을 화면에 그대로 내보내지 않는다. 상태코드+본문을 사람 문구로 바꾼다.
        const info = aiErrors.describe({ status: resp.status, body: errText });
        lastFailure = info; lastErrorInfo = info;
        errors.push(`키#${i + 1}: ${info.detail || 'HTTP ' + resp.status}`);
        // 폴백 대상 상태면 다음 키로, 아니면 즉시 중단
        if (FALLBACK_STATUSES.has(resp.status)) {
          tried.add(key);
          continue;
        } else {
          return { ok: false, errorKind: info.kind, errorInfo: info, error: aiErrors.shortText(info) };
        }
      }

      const data = await resp.json();
      const choice = data?.choices?.[0] || {};
      const msg = choice.message || {};
      let content = msg.content || '';

      // ★ gpt-oss-120b 등 reasoning 모델 방어:
      //   추론 토큰이 max_tokens 를 소진하면 content 가 비고 reasoning 만 채워진다.
      //   그대로 ok:true 로 돌려주면 화면에 빈칸이 떠서 "분석이 안 된다"로 보인다.
      if (!content) {
        const reasoning = msg.reasoning || msg.reasoning_content || '';
        if (reasoning) {
          content = reasoning;   // 최소한 추론 내용이라도 보여준다
        } else {
          errors.push(`키#${i + 1}: 빈 응답(finish_reason=${choice.finish_reason || '알수없음'})`);
          if (choice.finish_reason === 'length') {
            const info = aiErrors.describe({ kind: 'length' });
            lastFailure = info; lastErrorInfo = info;
            return { ok: false, errorKind: info.kind, errorInfo: info, error: aiErrors.shortText(info) };
          }
          tried.add(key);
          continue;   // 다음 키로 재시도
        }
      }

      // ★ 무료 원천 보장의 마지막 관문 — 응답에 비용(usage.cost)이 0 초과로 찍히면
      //   (라우팅이 유료 변형으로 샜다는 뜻) 성공으로 돌려주지 않고 즉시 차단한다.
      //   조용히 삼키지 않는다 — 콘솔에 경고를 남긴다(마스터 실사용 중 조용한 과금 방지).
      const cost = Number(data?.usage?.cost);
      if (isOpenRouter && Number.isFinite(cost) && cost > 0) {
        console.error(`[cerebras] OpenRouter 무료 호출인데 비용 발생 감지(cost=${cost}) — 응답을 차단합니다. model=${data?.model || model}`);
        const info = aiErrors.describe({ message: `무료 모델 호출인데 비용이 발생해 차단했습니다(cost=${cost})` });
        return { ok: false, errorKind: 'blocked_paid_model', errorInfo: info, error: info.message || '유료 호출이 감지되어 차단했습니다.' };
      }

      lastOkAt = Date.now(); lastErrorInfo = null;
      return {
        ok: true,
        content,
        truncated: choice.finish_reason === 'length',
        usedKeyIndex: i + 1,      // 몇 번째 키가 사용됐는지 (UI 표시용)
        model: data?.model || model,
        usage: data?.usage || null
      };

    } catch (err) {
      const msg = err.name === 'AbortError' ? '요청 시간 초과(90초)' : String(err);
      lastFailure = aiErrors.describe({ kind: 'network', message: msg }); lastErrorInfo = lastFailure;
      errors.push(`키#${i + 1}: ${msg}`);
      tried.add(key);
      continue; // 네트워크 오류 → 다음 키 시도
    }
  }

  // 모든 키 실패
  // 모든 키 실패 — 마지막으로 판정된 원인을 사람 문구로 돌려준다(raw JSON·키별 나열 금지)
  const failInfo = lastFailure || aiErrors.describe({ message: errors.join(' ') });
  return {
    ok: false,
    errorKind: failInfo.kind,
    errorInfo: failInfo,
    error: aiErrors.shortText(failInfo),
    attempts: errors.slice(0, validKeys.length)
  };
}

// ------------------------------------------------------------
//  chat() — 제공자 체인을 따라가며 호출한다(기존 호출부는 그대로 쓴다).
//   · url 을 직접 넘기면(연결 테스트 등) 체인을 쓰지 않고 그 주소만 호출한다.
//   · 체인이 비어 있으면 예전처럼 전달받은 keys/model 로 기본 엔드포인트를 호출한다.
// ------------------------------------------------------------
async function chat(opts) {
  const o = opts || {};
  const chain = usableChain(o.mode);
  if (o.url || !chain.length) return chatOnce(o);

  let lastRes = null;
  const startedProvider = chain[0].provider;
  for (let i = 0; i < chain.length; i++) {
    const node = chain[i];
    // 하루 한도(요청·토큰)에 근접한 제공자는 건너뛰고 다음 순위로 — 막히기 '전에' 전환한다
    const lim = limitStatus(node.provider);
    if (lim.near && chain.length > 1 && i < chain.length - 1) {
      lastLimitWarning = { provider: node.provider, label: node.label, ratio: lim.ratio, at: Date.now() };
      providerCooldown.set(node.provider, Date.now() + PROVIDER_COOLDOWN_MS);
      continue;
    }
    DEFAULT_CHAT_URL = node.chatUrl;
    activeProvider = node.provider;
    const res = await chatOnce(Object.assign({}, o, {
      url: node.chatUrl,
      keys: (node.keys && node.keys.length) ? node.keys : o.keys,
      model: node.model || o.model,
      models: node.models || null,   // OpenRouter 전용 자체 폴백 배열(최대 3개)
      provider: node.provider
    }));
    if (res.ok) {
      noteUsage(node.provider, res.usage && res.usage.total_tokens);
      const after = limitStatus(node.provider);
      if (after.near) {
        res.limitNear = true; res.limitRatio = after.ratio;
        res.limitLabel = node.label;
        lastLimitWarning = { provider: node.provider, label: node.label, ratio: after.ratio, at: Date.now() };
      }
      if (node.provider !== startedProvider) {
        lastSwitch = { from: startedProvider, to: node.provider, toLabel: node.label, at: Date.now() };
        res.switched = true; res.switchedTo = node.provider; res.switchedToLabel = node.label;
      }
      res.provider = node.provider; res.providerLabel = node.label;
      return res;
    }
    noteUsage(node.provider, 0);
    lastRes = res;
    lastRes.provider = node.provider; lastRes.providerLabel = node.label;
    if (!shouldSwitchProvider(res.errorKind)) return res;      // 429 등은 폴백 대상이 아니다
    // 이 제공자는 당분간 건너뛴다 → 다음 순위로
    providerCooldown.set(node.provider, Date.now() + PROVIDER_COOLDOWN_MS);
    if (i + 1 < chain.length && typeof o.onRetry === 'function') {
      o.onRetry({ providerSwitch: true, from: node.label, to: chain[i + 1].label });
    }
  }
  // 전부 실패 — 마지막 원인 + '다른 제공자로 전환하세요' 안내
  if (lastRes && lastRes.errorInfo) {
    lastRes.allProvidersFailed = true;
    lastRes.error = lastRes.errorInfo.title + ' — ' + lastRes.errorInfo.message
      + ' (등록된 제공자 ' + chain.length + '곳 모두 실패했습니다. 설정에서 다른 제공자를 등록하세요.)';
  }
  return lastRes || { ok: false, error: '호출할 제공자가 없습니다.' };
}

async function safeText(resp) {
  try { return await resp.text(); } catch { return ''; }
}

// ============================================================
//  대량 처리 공용 엔진 (map-reduce)
//  ------------------------------------------------------------
//  긴 메일 목록을 한 번에 밀어넣으면 분당 토큰(TPM) 한도로 429 가 난다.
//   → ① 항목을 요약 텍스트로 바꾼 뒤
//     ② 청크(기본 15,000자 ≈ 5k 토큰)로 나눠 순차 호출(map)
//     ③ 부분 결과를 모아 마지막 1회로 종합(reduce)
//  부분 실패는 버리지 않고 성공분만으로 종합한다.
//  chunkChars: 회당 입력 문자 상한 (토큰 ≈ 문자/3 가정)
// ============================================================
function chunkTexts(texts, chunkChars) {
  const chunks = [];
  let cur = [], len = 0;
  for (const t of texts) {
    const s = String(t || '');
    if (len + s.length > chunkChars && cur.length) { chunks.push(cur); cur = []; len = 0; }
    cur.push(s); len += s.length;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

async function mapReduce({
  keys, model, texts, url = null, provider = '',
  mapSystem, reduceSystem,
  mapHeader = '', reduceHeader = '',
  chunkChars = 15000, temperature = 0.2,
  mapMaxTokens = 1500, reduceMaxTokens = 4096,
  gapMs = 1500, onProgress = () => {},
  concurrency = 3,           // 동시 처리 워커 수 (키 개수·청크 수로 자동 제한)
  forceReduce = false,       // true = 청크 1개여도 종합 단계 수행(JSON 구조화가 reduce 담당인 경우)
  mode = ''                  // 'batch' = 배치·자동 작업(업무일지·브리핑·스케줄러) → Groq 우선 순서
}) {
  const chunks = chunkTexts(texts || [], chunkChars);
  if (!chunks.length) return { ok: false, error: '분석할 내용이 없습니다.' };

  // ---- map: 청크 병렬 처리 (동시성 N, 워커마다 다른 키 고정 배정) ----
  //  실측 근거: 키별 독립 쿼터 + 같은 키 동시 호출은 RPM 429
  //             → 워커에 서로 다른 키를 배정하면 동시성 이득이 실제로 난다(2.13배 측정).
  const validKeys = (keys || []).filter(k => k && k.trim()).map(k => k.trim());
  let conc = Math.max(1, Math.min(Number(concurrency) || 1, validKeys.length || 1, chunks.length));
  const results = new Array(chunks.length).fill(null);   // 원순서 보존
  const failed = [];
  let done = 0;
  let concDowngraded = false;
  let next = 0;

  const runWorker = async (workerNo) => {
    while (true) {
      const i = next++;
      if (i >= chunks.length) return;
      // 워커별 키 고정 배정: 라운드마다 순환 (키1·2·3 → 키4·5·6 → …)
      const round = Math.floor(i / Math.max(conc, 1));
      const pinKey = validKeys.length
        ? validKeys[(workerNo + round * conc) % validKeys.length]
        : null;
      onProgress('map', done + 1, chunks.length,
        `묶음 ${done + 1}/${chunks.length}${conc > 1 ? ` (${conc}개 동시)` : ''} 정리 중...`);
      let hit429 = false;
      const res = await chat({
        keys, model, temperature, maxTokens: mapMaxTokens, pinKey, url, provider, mode,
        messages: [
          { role: 'system', content: mapSystem },
          { role: 'user', content: `${mapHeader}\n\n${chunks[i].join('\n')}` }
        ],
        onRetry: (r) => {
          hit429 = true;
          onProgress('wait', done + 1, chunks.length,
            r.allCooling
              ? `모든 키가 한도 대기 중 — ${Math.round((r.waitMs || 0) / 1000)}초 후 재시도`
              : `키#${r.key} 한도 초과 → 다른 키로 전환 (${r.cooldownSec}초 쿨다운)`);
        }
      });
      if (res.ok && res.content) results[i] = res.content;
      else failed.push({ chunk: i + 1, error: res.error || '빈 응답' });
      done++;
      // 병렬 상태에서 429 가 계속 나오면 동시성 1로 강등 (무한 429 루프 방지)
      if (hit429 && conc > 1 && !concDowngraded) {
        concDowngraded = true;
        conc = 1;
        onProgress('wait', done, chunks.length, '한도 신호가 반복돼 동시 처리를 1개로 낮춥니다.');
      }
      if (next < chunks.length) await sleep(conc > 1 ? Math.min(gapMs, 400) : gapMs);
    }
  };

  await Promise.all(Array.from({ length: conc }, (_, w) => runWorker(w)));
  const partials = results.filter(Boolean);   // 원순서 유지

  if (!partials.length) {
    return { ok: false, error: '모든 묶음 처리가 실패했습니다.\n' + failed.map(f => `- ${f.chunk}: ${f.error}`).join('\n') };
  }

  // reduceSystem 이 없으면 부분 결과를 그대로 돌려준다
  // (호출자가 코드로 병합·구조화하는 경우 — AI 종합 호출을 아예 없애 토큰 절약)
  if (!reduceSystem) {
    onProgress('done', chunks.length, chunks.length, '부분 정리 완료');
    return { ok: true, partials, chunks: chunks.length, failedChunks: failed.length, concurrency: conc, downgraded: concDowngraded };
  }

  // 청크가 1개면 종합 단계를 생략(불필요한 호출 방지)
  //  단 forceReduce=true 면 생략하지 않는다 — reduce 가 JSON 구조화를 담당하는 호출자
  //  (일일 브리핑)에서 생략하면 평문이 그대로 나와 섹션이 뭉친다.
  if (partials.length === 1 && chunks.length === 1 && !forceReduce) {
    onProgress('done', 1, 1, '정리 완료');
    return { ok: true, content: partials[0], chunks: chunks.length, failedChunks: failed.length,
             usedKeyIndex: 1, concurrency: conc, downgraded: concDowngraded };
  }

  // ---- reduce: 부분 결과 종합 ----
  onProgress('reduce', chunks.length, chunks.length, `${partials.length}개 부분 결과를 종합 중...`);
  await sleep(gapMs);
  const red = await chat({
    keys, model, temperature, maxTokens: reduceMaxTokens, url, provider, mode,
    messages: [
      { role: 'system', content: reduceSystem },
      { role: 'user', content: `${reduceHeader}\n\n${partials.map((p, i) => `[부분 ${i + 1}]\n${p}`).join('\n\n')}` }
    ],
    onRetry: (r) => onProgress('wait', chunks.length, chunks.length,
      `분당 토큰 한도로 ${Math.round(r.waitMs / 1000)}초 대기 후 종합 재시도`)
  });
  if (!red.ok) {
    // 종합만 실패 → 부분 결과라도 돌려준다(전부 버리지 않음)
    return {
      ok: true, partialOnly: true,
      content: partials.map((p, i) => `[부분 ${i + 1}]\n${p}`).join('\n\n'),
      chunks: chunks.length, failedChunks: failed.length,
      warning: '부분 정리는 됐지만 종합 단계가 실패했습니다: ' + red.error
    };
  }
  onProgress('done', chunks.length, chunks.length, '정리 완료');
  return {
    ok: true, content: red.content, chunks: chunks.length,
    failedChunks: failed.length, usedKeyIndex: red.usedKeyIndex, usage: red.usage,
    concurrency: conc, downgraded: concDowngraded
  };
}

// ============================================================
//  AI 상태 / 키 점검 (설정·헤더의 'AI 상태' 표시용)
// ============================================================
//  마지막 호출 결과 기준 상태. 화면은 이 값을 그대로 배지로 보여준다.
function healthStatus(keys) {
  const valid = (keys || []).filter(k => k && k.trim());
  //  체인에 '호출 가능한 제공자'가 하나라도 있으면 키가 없어도(Ollama 등) 미설정이 아니다
  const chainUsable = activeChainList.length > 0;
  if (!valid.length && !chainUsable) {
    return { state: 'nokey', label: aiErrors.STATE_LABEL.nokey, info: aiErrors.describe({ kind: 'nokey' }), lastOkAt };
  }
  if (lastErrorInfo) {
    const st = aiErrors.stateFromKind(lastErrorInfo.kind);
    return { state: st, label: aiErrors.STATE_LABEL[st] || aiErrors.STATE_LABEL.error, info: lastErrorInfo, lastOkAt };
  }
  if (!lastOkAt) return { state: 'unknown', label: aiErrors.STATE_LABEL.unknown, info: null, lastOkAt };
  return { state: 'ok', label: aiErrors.STATE_LABEL.ok, info: null, lastOkAt };
}

//  키 유효성 점검 — 키마다 가장 작은 요청 1회로 상태를 확인한다.
//  반환: [{ index, tail, ok, state, label, detail }]
async function probeKeys(keys, model, url) {
  const endpoint = url || DEFAULT_CHAT_URL;
  const valid = (keys || []).map(k => String(k || '').trim());
  const out = [];
  for (let i = 0; i < valid.length; i++) {
    const key = valid[i];
    const tail = key ? '…' + key.slice(-4) : '';
    if (!key) { out.push({ index: i + 1, tail: '', ok: false, state: 'nokey', label: '비어 있음', detail: '' }); continue; }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({ model: model || 'gpt-oss-120b', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
        signal: controller.signal
      });
      clearTimeout(timer);
      if (resp.ok) { lastOkAt = Date.now(); lastErrorInfo = null; out.push({ index: i + 1, tail, ok: true, state: 'ok', label: '정상', detail: '' }); continue; }
      const body = await safeText(resp);
      const info = aiErrors.describe({ status: resp.status, body });
      lastErrorInfo = info;                       // 헤더 'AI 상태' 배지에 그대로 반영
      const st = aiErrors.stateFromKind(info.kind);
      out.push({ index: i + 1, tail, ok: false, state: st, label: aiErrors.STATE_LABEL[st] || info.title, detail: info.detail });
    } catch (e) {
      const info = aiErrors.describe({ kind: 'network', message: String(e) });
      out.push({ index: i + 1, tail, ok: false, state: 'error', label: info.title, detail: info.detail });
    }
  }
  return out;
}

//  제공자의 모델 목록 조회 (OpenAI 호환 /models). 키 1개만 있으면 된다.
//  ★ 실측(2026-08-14): Cerebras 는 /v1/models 가 200 인데 /chat/completions 는 402 였다.
//    즉 이 조회가 성공해도 '호출 가능'을 뜻하지는 않는다 → 연결 테스트와 별개로 취급한다.
async function listModels({ url, key }) {
  const endpoint = String(url || '').trim();
  if (!endpoint) return { ok: false, error: '모델 목록 주소가 없습니다.' };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const resp = await fetch(endpoint, {
      headers: key ? { 'Authorization': 'Bearer ' + String(key).trim() } : {},
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!resp.ok) {
      const info = aiErrors.describe({ status: resp.status, body: await safeText(resp) });
      return { ok: false, errorKind: info.kind, errorInfo: info, error: aiErrors.shortText(info) };
    }
    const data = await resp.json();
    const arr = (data && (data.data || data.models)) || [];
    const ids = arr.map(m => (typeof m === 'string' ? m : (m.id || m.name || ''))).filter(Boolean);
    return { ok: true, models: ids };
  } catch (e) {
    const info = aiErrors.describe({ kind: 'network', message: String(e) });
    return { ok: false, errorKind: info.kind, errorInfo: info, error: aiErrors.shortText(info) };
  }
}

module.exports = { chat, chatOnce, mapReduce, chunkTexts, setKeyStateStore, poolStatus, healthStatus, probeKeys, listModels, setEndpoint, currentEndpoint, setChain, currentChain, lastSwitchInfo, lastLimitInfo, usageSnapshot, setUsageStore, limitStatus, estimateTokens, messagesTokens };
