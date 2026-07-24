// ============================================================
//  cerebras.js - Cerebras Inference API 호출
//  ------------------------------------------------------------
//  ★ OpenAI 호환 API (https://api.cerebras.ai/v1/chat/completions)
//  ★ 안정성 핵심: API 키 최대 5개 자동 폴백
//     - 1번 키가 rate limit / 오류나면 → 자동으로 2, 3, 4, 5번 키 순차 시도
//     - 하나라도 성공하면 그 응답 반환
//  ------------------------------------------------------------
//  참고: Cerebras 는 텍스트 모델입니다. 이미지는 attachments.js 에서
//        메타/텍스트로 변환하여 프롬프트에 포함됩니다.
// ============================================================

const CEREBRAS_URL = 'https://api.cerebras.ai/v1/chat/completions';

// 재시도 가치가 있는(=다음 키로 넘어갈) HTTP 상태
const FALLBACK_STATUSES = new Set([401, 403, 429, 500, 502, 503, 504]);

async function chat({ keys, model, messages, temperature = 0.3, maxTokens = 4096 }) {
  const validKeys = (keys || []).filter(k => k && k.trim());
  if (validKeys.length === 0) {
    return { ok: false, error: 'API 키가 없습니다.' };
  }

  const errors = [];

  for (let i = 0; i < validKeys.length; i++) {
    const key = validKeys[i].trim();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 90000); // 90초 타임아웃

      const resp = await fetch(CEREBRAS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`
        },
        body: JSON.stringify({
          model: model || 'llama-3.3-70b',
          messages,
          temperature,
          max_tokens: maxTokens,
          stream: false
        }),
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (!resp.ok) {
        const errText = await safeText(resp);
        errors.push(`키#${i + 1}: HTTP ${resp.status} ${errText.slice(0, 120)}`);
        // 폴백 대상 상태면 다음 키로, 아니면 즉시 중단
        if (FALLBACK_STATUSES.has(resp.status)) {
          continue;
        } else {
          return { ok: false, error: `AI 오류(HTTP ${resp.status}): ${errText.slice(0, 200)}` };
        }
      }

      const data = await resp.json();
      const content = data?.choices?.[0]?.message?.content || '';
      return {
        ok: true,
        content,
        usedKeyIndex: i + 1,      // 몇 번째 키가 사용됐는지 (UI 표시용)
        model: data?.model || model,
        usage: data?.usage || null
      };

    } catch (err) {
      const msg = err.name === 'AbortError' ? '요청 시간 초과(90초)' : String(err);
      errors.push(`키#${i + 1}: ${msg}`);
      continue; // 네트워크 오류 → 다음 키 시도
    }
  }

  // 모든 키 실패
  return {
    ok: false,
    error: '모든 API 키 시도 실패:\n' + errors.join('\n')
  };
}

async function safeText(resp) {
  try { return await resp.text(); } catch { return ''; }
}

module.exports = { chat };
