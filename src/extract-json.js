// ============================================================
//  extract-json.js — LLM 응답에서 JSON 객체만 안전하게 추출 (코드펜스·앞뒤 설명문 복구)
//  SoT: analyzer.js · reply-needed.js 가 공유(2026-10-09 창고 22-electron-desktop-mail 에서 역수입). 의존 0.
//  후보 3종(```json 펜스 → 전체 → 첫'{'~끝'}') 순서 시도 + 배열/원시값 거부. 깨진 JSON → null.
// ============================================================
function extractJson(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fence) candidates.push(fence[1]);
  candidates.push(s);
  const first = s.indexOf('{'), last = s.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(s.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const o = JSON.parse(c.trim());
      if (o && typeof o === 'object' && !Array.isArray(o)) return o;
    } catch (_) {}
  }
  return null;
}

module.exports = { extractJson };

// ---- 셀프체크 : node extract-json.js ----
if (require.main === module) {
  const assert = require('assert');
  assert.deepStrictEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 }, '코드펜스 복구 실패');
  // 펜스 밖에 중괄호가 더 있으면 첫'{'~끝'}' 후보는 깨진다 → 펜스 후보만 살린다(robustJsonParse 가 실패하는 경우)
  assert.deepStrictEqual(extractJson('형식 {예시}\n```json\n{"a":1}\n```\n끝}'), { a: 1 }, '펜스 밖 중괄호에 섞여 복구 실패');
  assert.deepStrictEqual(extractJson('판정합니다.\n{"a":2}\n이상.'), { a: 2 }, '앞뒤 설명문 복구 실패');
  assert.deepStrictEqual(extractJson('{"a":{"b":3}}'), { a: { b: 3 } });
  assert.strictEqual(extractJson('[1,2]'), null, '배열을 객체로 통과시킴');
  assert.strictEqual(extractJson('JSON 없음'), null);
  assert.strictEqual(extractJson('{"a":1,}'), null, '깨진 JSON 을 통과시킴');
  assert.strictEqual(extractJson('```json\n{"a":\n```'), null, '깨진 펜스 JSON 을 통과시킴');
  assert.deepStrictEqual(extractJson('  ```\n{"k":"v"}\n```  '), { k: 'v' }, '언어 표기 없는 펜스 복구 실패');
  assert.strictEqual(extractJson(''), null);
  console.log('extract-json 셀프체크 OK — 펜스·펜스밖중괄호·설명문·중첩·배열거부·깨진JSON·없음·빈값');
}
