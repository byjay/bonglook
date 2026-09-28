// ============================================================
//  attach-vision.js — 이미지 첨부 무료 비전 분석 (마스터 지시: 첨부 분석 2단계)
//  ------------------------------------------------------------
//  OpenRouter 무료(:free) 비전 모델 체인으로 이미지에 "무엇이 그려져/적혀 있는지"를
//  한국어로 요약한다. 비전 전용 체인(텍스트 체인과 분리) — 실측(2026-09-28, 실이미지
//  1장, 엔진 호스 사진)으로 골라낸 순위. 전부 실패하면 지어내지 않고 정직하게 실패로 답한다.
//
//  실측 비교표(2026-09-28, KakaoTalk_gen engine flex hose.jpg 420KB, OpenRouter 실호출):
//   순위 모델                                              결과                지연     비고
//   1위  nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free OK(상세·정확)       1,316ms  채택
//   -    nvidia/nemotron-3.5-content-safety:free           OK(그러나 "User Safety: safe"만 반환 —
//                                                            콘텐츠 모더레이션 모델이라 캡션 불가) 제외
//   -    dots-studio/dots-3-note-preview:free              200 이나 finish_reason=length·본문 없음 제외
//   -    thinkingmachines/inkling(-small):free              403 "agentic harness 전용"(구조적 불가) 제외
//   2위  google/gemma-4-31b-it:free                        429(업스트림 상시, RECON 기록과 일치)  폴백 후보
//   3위  qwen/qwen3.8-27b:free                              429(업스트림 상시)                     폴백 후보
// ============================================================
const cerebras = require('./cerebras');
const aiProviders = require('./ai-providers');

const OPENROUTER_CHAT_URL = aiProviders.chatUrl('https://openrouter.ai/api/v1');

// 최대 3개(마스터 지시) — 1위만 실측상 안정적으로 성공, 2·3위는 구조적으로는 맞는 비전 모델이라
// 업스트림이 풀리면 쓸 수 있는 폴백으로 남긴다(agentic-only·content-safety 류는 영구 제외).
const VISION_CHAIN = [
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'google/gemma-4-31b-it:free',
  'qwen/qwen3.8-27b:free'
];

function buildMessages(dataUrl, fileName) {
  return [
    {
      role: 'system',
      content: '당신은 업무 이메일 첨부 이미지를 설명하는 비전 분석가입니다. 이미지에 실제로 보이는 것만 한국어로 설명하세요. '
        + '글자·숫자·모델명이 보이면 그대로 옮겨 적으세요. 보이지 않는 것을 지어내지 마세요.'
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: `첨부 이미지(${fileName || '이미지'})에 무엇이 그려져 있거나 적혀 있는지 한국어로 3~6문장으로 설명해줘.` },
        { type: 'image_url', image_url: { url: dataUrl } }
      ]
    }
  ];
}

// chatFn 주입 가능(셀프체크가 네트워크 없이 폴백 순서를 검증하기 위함) — 기본은 실제 OpenRouter 호출.
async function describeImage({ keys, dataUrl, fileName = '' }, { chatFn = null, chain = VISION_CHAIN } = {}) {
  if (!keys || !keys.length) return { ok: false, error: 'OpenRouter 키가 없습니다.', tried: [] };
  if (!dataUrl) return { ok: false, error: '이미지 데이터가 없습니다.', tried: [] };
  const messages = buildMessages(dataUrl, fileName);
  const call = chatFn || ((model) => cerebras.chatOnce({
    keys, model, messages, provider: 'openrouter', url: OPENROUTER_CHAT_URL, temperature: 0.2, maxTokens: 500
  }));
  const tried = [];
  for (const model of chain) {
    let res;
    try { res = await call(model); } catch (e) { res = { ok: false, error: String(e.message || e) }; }
    tried.push({ model, ok: !!(res && res.ok), error: res && !res.ok ? res.error : '' });
    if (res && res.ok && res.content && res.content.trim()) {
      return { ok: true, model, text: res.content.trim(), tried };
    }
  }
  return { ok: false, error: '이미지 분석 불가(무료 비전 모델 응답 없음)', tried };
}

module.exports = { describeImage, VISION_CHAIN };

// ============================================================
//  셀프체크 — `node src/attach-vision.js` (네트워크 없이 chatFn 주입으로 폴백 순서만 검증)
// ============================================================
if (require.main === module) {
  const assert = require('assert');
  (async () => {
    let pass = 0;

    // 1) 1위 성공 → 그 결과를 즉시 반환(뒤 모델 호출 안 함)
    let calls1 = [];
    const r1 = await describeImage({ keys: ['k'], dataUrl: 'data:image/png;base64,AA==', fileName: 'a.png' }, {
      chatFn: async (model) => { calls1.push(model); return { ok: true, content: '엔진 사진입니다.' }; }
    });
    assert.strictEqual(r1.ok, true); pass++;
    assert.strictEqual(r1.model, VISION_CHAIN[0]); pass++;
    assert.strictEqual(calls1.length, 1, '1위가 성공했는데 2위까지 호출함(불필요한 호출)'); pass++;

    // 2) 1위 실패(429) → 2위로 폴백해 성공
    let calls2 = [];
    const r2 = await describeImage({ keys: ['k'], dataUrl: 'data:image/png;base64,AA==', fileName: 'b.png' }, {
      chatFn: async (model) => { calls2.push(model); return model === VISION_CHAIN[1] ? { ok: true, content: '도면입니다.' } : { ok: false, error: '429' }; }
    });
    assert.strictEqual(r2.ok, true); pass++;
    assert.strictEqual(r2.model, VISION_CHAIN[1]); pass++;
    assert.strictEqual(r2.tried.length, 2); pass++;

    // 3) 전부 실패 → 지어내지 않고 정직한 실패 메시지(거짓 성공 금지)
    const r3 = await describeImage({ keys: ['k'], dataUrl: 'data:image/png;base64,AA==', fileName: 'c.png' }, {
      chatFn: async () => ({ ok: false, error: '429' })
    });
    assert.strictEqual(r3.ok, false); pass++;
    assert.ok(/이미지 분석 불가/.test(r3.error)); pass++;
    assert.strictEqual(r3.tried.length, VISION_CHAIN.length); pass++;

    // 4) 키 없음 / dataUrl 없음 — 호출 자체를 안 하고 즉시 실패(조용히 성공 처리 금지)
    const r4 = await describeImage({ keys: [], dataUrl: 'x' });
    assert.strictEqual(r4.ok, false); pass++;
    const r5 = await describeImage({ keys: ['k'], dataUrl: '' });
    assert.strictEqual(r5.ok, false); pass++;

    console.log(`attach-vision.js 셀프체크 OK — ${pass}건 통과(1위성공 조기반환·폴백순서·전체실패 정직표시·키/데이터없음)`);
  })().catch((e) => { console.error('attach-vision.js 셀프체크 FAIL:', e.message); process.exit(1); });
}
