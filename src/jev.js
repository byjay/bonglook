// ============================================================
//  jev.js — Jev(TypeSafe AI System One) 판정 어댑터 (단일 클라이언트, SoT)
//  ------------------------------------------------------------
//  스킬 C:\Users\FREE\.claude\skills\jev-typed-decisions\SKILL.md §3·§6·§7·§10-5 규격 준수.
//
//  입력  { state, questions, config? } → 출력 { ok, answers, backend, latencyMs, error }
//  백엔드 교체형:
//    - 'local'      : JevK5 로컬(GGUF+llama-server, jev-server.js 가 수명주기 관리) — 기본값
//    - 'openrouter' : /api/alpha/decisions (typesafe/jev-1.13) — 코드만 존재, 기본 비활성
//                     (마스터 결정 2026-09-28: 잔액 음수 방지, apiKey 를 명시로 주입해야만 호출)
//
//  🔴 폴백 규율(스킬 §6): 4xx/5xx/타임아웃 → ok:false + 사유. catch 로 삼켜 ok:true 를 만들지 않는다.
//    429/529 지수 백오프 재시도, 401 은 재시도 금지(키 문제).
//
//  🔴 확률 임계값(스킬 §3): p>=0.90 use / 0.70~0.90 estimate / <0.70 escalate. 항상 확률을 함께 반환한다.
//
//  ⚠ 이번 발주(③-b)는 "측정 전용" — 이 파일은 아직 앱(main.js/renderer.js)에서 import 되지
//    않는다. scripts/jev-measure.mjs 가 유일한 호출부다(③-c 에서 앱 연결 예정, HANDOFF.md 참조).
// ============================================================

'use strict';
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------
//  설정 — 하드코딩 금지 원칙에 따라 전부 config 로 주입 가능. 기본값만 자동 탐지.
// ---------------------------------------------------------------
const DEFAULT_LOCAL_BASE = 'E:\\models\\jevk5';

function autoDetectLocalBase() {
  try { if (fs.existsSync(DEFAULT_LOCAL_BASE)) return DEFAULT_LOCAL_BASE; } catch (e) { /* noop */ }
  return null;
}

function defaultConfig() {
  const base = autoDetectLocalBase();
  return {
    backend: 'local',           // 'local' | 'openrouter'
    thresholds: { use: 0.90, estimate: 0.70 },
    local: {
      base,
      llamaServerExe: base ? path.join(base, 'llamacpp', 'bin', 'llama-server.exe') : null,
      modelPath: base ? path.join(base, 'models', 'jevk5-4b-v0.3-Q5_K_M.gguf') : null,
      pythonExe: base ? path.join(base, '.venv', 'Scripts', 'python.exe') : null,
      wrapperScript: base ? path.join(base, 'systemone_gguf_server.py') : null,
      llamaHost: '127.0.0.1',
      llamaPort: 8080,
      systemoneHost: '127.0.0.1',
      systemonePort: 8090,
      ctxSize: 8192,
      gpuLayers: 99,
      parallelSlots: 1,          // 순차 호출뿐이라 슬롯 1개로 VRAM(KV캐시) 절약
      idleTimeoutMs: 5 * 60 * 1000,   // 마지막 요청 후 5분 유휴 시 자동 종료
      vramFreeMinMb: 4000,       // 이 미만이면 GPU 기동 금지(마스터 CAD 사용 보호)
      gpuFallback: 'cpu',        // 'cpu'(=-ngl 0) | 'skip'(기동 자체 포기)
      startupTimeoutMs: 120000,
      requestTimeoutMs: 60000,
    },
    openrouter: {
      url: 'https://openrouter.ai/api/alpha/decisions',
      model: 'typesafe/jev-1.13',
      apiKey: null,              // SoT: outlook-ai-config.json apiKeysByProvider.openrouter (호출자가 주입)
      requestTimeoutMs: 30000,
    },
  };
}

function mergeConfig(overrides) {
  const base = defaultConfig();
  if (!overrides) return base;
  return {
    ...base,
    ...overrides,
    thresholds: { ...base.thresholds, ...(overrides.thresholds || {}) },
    local: { ...base.local, ...(overrides.local || {}) },
    openrouter: { ...base.openrouter, ...(overrides.openrouter || {}) },
  };
}

// ---------------------------------------------------------------
//  🔴 확률 임계값 헬퍼 — 확률을 버리지 않고 항상 함께 반환한다(스킬 §3)
// ---------------------------------------------------------------
function classifyProbability(p, thresholds) {
  const t = thresholds || defaultConfig().thresholds;
  if (typeof p !== 'number' || Number.isNaN(p)) return 'escalate';
  if (p >= t.use) return 'use';
  if (p >= t.estimate) return 'estimate';
  return 'escalate';
}

// choice: 최고 확률(confidence) / noul: max(p, 1-p) — "모른다(0.5 근접)"를 escalate 로 잡기 위함
// score: confidence 필드를 그대로 사용
function answerProbability(answer) {
  if (!answer || typeof answer !== 'object') return 0;
  if (answer.type === 'noul') {
    const n = Number(answer.noul);
    if (Number.isNaN(n)) return 0;
    return Math.max(n, 1 - n);
  }
  if (answer.type === 'choice') {
    if (typeof answer.confidence === 'number') return answer.confidence;
    const probs = Object.values(answer.probabilities || {});
    return probs.length ? Math.max(...probs) : 0;
  }
  if (answer.type === 'score') {
    return typeof answer.confidence === 'number' ? answer.confidence : 0;
  }
  return 0;
}

function annotateAnswers(answers, thresholds) {
  const out = {};
  for (const [key, a] of Object.entries(answers || {})) {
    const probability = answerProbability(a);
    out[key] = { ...a, probability, decision: classifyProbability(probability, thresholds) };
  }
  return out;
}

// ---------------------------------------------------------------
//  HTTP — 4xx/5xx/타임아웃 → ok:false. 429/529 지수 백오프. 401 재시도 금지.
// ---------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function safeText(resp) {
  try { return (await resp.text()).slice(0, 500); } catch (e) { return ''; }
}

async function postWithBackoff(url, body, { headers = {}, timeoutMs = 30000, maxRetries = 3 } = {}) {
  let attempt = 0;
  let delay = 500;
  for (;;) {
    attempt++;
    let timer = null;
    try {
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), timeoutMs);
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (resp.status === 401) {
        return { ok: false, error: `401 인증 실패(재시도 안 함): ${await safeText(resp)}` };
      }
      if ((resp.status === 429 || resp.status === 529) && attempt <= maxRetries) {
        await sleep(delay); delay *= 2; continue;
      }
      if (!resp.ok) {
        return { ok: false, error: `HTTP ${resp.status}: ${await safeText(resp)}` };
      }
      const json = await resp.json();
      return { ok: true, body: json };
    } catch (e) {
      if (timer) clearTimeout(timer);
      const isAbort = e && (e.name === 'AbortError');
      if (isAbort && attempt <= maxRetries) { await sleep(delay); delay *= 2; continue; }
      return { ok: false, error: `요청 실패: ${String((e && e.message) || e)}` };
    }
  }
}

// ---------------------------------------------------------------
//  백엔드 A: JevK5 로컬(온디맨드 기동은 jev-server.js 가 담당)
// ---------------------------------------------------------------
async function callLocal(state, questions, cfg) {
  const c = cfg.local;
  if (!c.base) {
    return { ok: false, error: `JevK5 로컬 경로 미탐지(${DEFAULT_LOCAL_BASE} 없음) — config.local.base 로 직접 지정 필요` };
  }
  // 순환 require 회피 겸, jev-server 를 못 쓰는 환경(measure 스크립트 밖)에서도 jev.js 단독 로드는 되게 지연 require
  const jevServer = require('./jev-server');
  const ensure = await jevServer.ensureServer(cfg);
  if (!ensure.ok) return { ok: false, error: ensure.error };
  const url = `http://${c.systemoneHost}:${c.systemonePort}/v1/systemone`;
  const result = await postWithBackoff(url, { state, questions }, { timeoutMs: c.requestTimeoutMs });
  jevServer.noteRequest(cfg);
  if (!result.ok) return result;
  return {
    ok: true,
    answers: result.body.answers,
    usage: result.body.usage || null,
    model: result.body.model || null,
    coldStartMs: ensure.coldStartMs || null,
    mode: ensure.mode || null,
  };
}

// ---------------------------------------------------------------
//  백엔드 B: OpenRouter Jev API — 코드만 존재, 기본 비활성(apiKey 없으면 즉시 ok:false)
// ---------------------------------------------------------------
async function callOpenRouter(state, questions, cfg) {
  const c = cfg.openrouter;
  if (!c.apiKey) {
    return { ok: false, error: 'openrouter apiKey 미설정 — 기본 비활성(마스터 결정: 잔액 음수 방지). 측정 목적이면 config.openrouter.apiKey 로 명시 주입' };
  }
  const result = await postWithBackoff(
    c.url,
    { model: c.model, state, questions },
    { headers: { Authorization: `Bearer ${c.apiKey}` }, timeoutMs: c.requestTimeoutMs }
  );
  if (!result.ok) return result;
  return { ok: true, answers: result.body.answers, usage: result.body.usage || null, model: result.body.model || null };
}

// ---------------------------------------------------------------
//  공개 API
// ---------------------------------------------------------------
async function decide({ state, questions, config } = {}) {
  const cfg = mergeConfig(config);
  const started = Date.now();
  if (!state || !questions || typeof questions !== 'object' || Object.keys(questions).length === 0) {
    return { ok: false, error: 'state/questions 필수', backend: cfg.backend, latencyMs: Date.now() - started };
  }
  let raw;
  try {
    raw = cfg.backend === 'openrouter'
      ? await callOpenRouter(state, questions, cfg)
      : await callLocal(state, questions, cfg);
  } catch (e) {
    // 🔴 catch 로 삼켜 ok:true 를 만들지 않는다 — 거짓 성공 금지(스킬 §7-5)
    return { ok: false, error: `예외: ${String((e && e.message) || e)}`, backend: cfg.backend, latencyMs: Date.now() - started };
  }
  const latencyMs = Date.now() - started;
  if (!raw.ok) return { ok: false, error: raw.error, backend: cfg.backend, latencyMs };
  return {
    ok: true,
    answers: annotateAnswers(raw.answers, cfg.thresholds),
    backend: cfg.backend,
    latencyMs,
    usage: raw.usage || null,
    model: raw.model || null,
    coldStartMs: raw.coldStartMs || null,
    mode: raw.mode || null,
  };
}

module.exports = {
  decide,
  classifyProbability,
  answerProbability,
  annotateAnswers,
  defaultConfig,
  mergeConfig,
};

// ================================================================
//  셀프체크 — 순수 함수(임계값 분기·확률 보존) + 폴백(ok:false) 검증. 네트워크 불필요.
//  실행: node src/jev.js   (또는 electron.exe --run-as-node)
// ================================================================
if (require.main === module) {
  (async () => {
    const assert = require('assert');
    let pass = 0;

    // 1) 임계값 분기 — p>=0.90 use / 0.70~0.90 estimate / <0.70 escalate
    assert.strictEqual(classifyProbability(0.95, { use: 0.90, estimate: 0.70 }), 'use'); pass++;
    assert.strictEqual(classifyProbability(0.90, { use: 0.90, estimate: 0.70 }), 'use'); pass++;   // 경계값 포함
    assert.strictEqual(classifyProbability(0.80, { use: 0.90, estimate: 0.70 }), 'estimate'); pass++;
    assert.strictEqual(classifyProbability(0.70, { use: 0.90, estimate: 0.70 }), 'estimate'); pass++; // 경계값 포함
    assert.strictEqual(classifyProbability(0.10, { use: 0.90, estimate: 0.70 }), 'escalate'); pass++;
    assert.strictEqual(classifyProbability(NaN, { use: 0.90, estimate: 0.70 }), 'escalate'); pass++;

    // 2) 확률 보존 — annotateAnswers 는 라벨만 남기지 않고 probability/decision 을 항상 붙인다
    const rawAnswers = {
      action: { type: 'choice', choice: 'todo', confidence: 0.95, probabilities: { todo: 0.95, fyi: 0.03, hold: 0.02 } },
      reply_needed: { type: 'noul', noul: 0.12 },            // max(0.12, 0.88) = 0.88 → estimate
      theme: { type: 'choice', choice: 'other', confidence: 0.40, probabilities: { drawing: 0.40, other: 0.35 } },
    };
    const annotated = annotateAnswers(rawAnswers, { use: 0.90, estimate: 0.70 });
    assert.strictEqual(annotated.action.probability, 0.95); pass++;
    assert.strictEqual(annotated.action.decision, 'use'); pass++;
    assert.ok(Math.abs(annotated.reply_needed.probability - 0.88) < 1e-9, 'noul 확률 계산(max(p,1-p)) 오류'); pass++;
    assert.strictEqual(annotated.reply_needed.decision, 'estimate'); pass++;
    assert.strictEqual(annotated.theme.decision, 'escalate'); pass++;
    // 원본 필드(choice/noul 등)가 지워지지 않고 그대로 남아있어야 한다(라벨만 쓰고 확률 버리는 것 금지)
    assert.strictEqual(annotated.action.choice, 'todo'); pass++;

    // 3) 폴백 규율 — state/questions 누락, local base 미탐지 → ok:false (네트워크 없이 즉시 판정)
    const r1 = await decide({ state: '', questions: {} });
    assert.strictEqual(r1.ok, false); pass++;
    assert.ok(typeof r1.error === 'string' && r1.error.length > 0); pass++;

    const r2 = await decide({
      state: 'x', questions: { a: { type: 'noul', instructions: 'x' } },
      config: { backend: 'local', local: { base: null } },
    });
    assert.strictEqual(r2.ok, false, 'base 미탐지인데 ok:true 가 나오면 거짓 성공'); pass++;
    assert.ok(/경로 미탐지/.test(r2.error)); pass++;

    const r3 = await decide({
      state: 'x', questions: { a: { type: 'noul', instructions: 'x' } },
      config: { backend: 'openrouter', openrouter: { apiKey: null } },
    });
    assert.strictEqual(r3.ok, false, 'apiKey 없는데 ok:true 가 나오면 거짓 성공(기본 비활성 위반)'); pass++;

    console.log(`jev.js 셀프체크 OK — ${pass}건 통과(임계값 분기·확률 보존·폴백 ok:false)`);
  })().catch((e) => { console.error('jev.js 셀프체크 FAIL:', e.message); process.exit(1); });
}
