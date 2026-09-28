// ============================================================
//  reply-needed.js — "회신이 필요한가"(의미) LLM 판정, 기존 미회신 후보 위에 얹는 층
//  ------------------------------------------------------------
//  기존 db.js unansweredMails() 는 "내가 이미 답장을 보냈는가"만 본다(사실 판정, 제목 정규화+
//  발신시각 비교). 이 모듈은 그 후보들 중 "정말 내가 회신해야 하는가"(의미 판정)를 무료 LLM
//  1건 1호출로 가린다 — 수정 통보·참고 도면처럼 답이 필요 없는 메일까지 미회신으로 쌓이는 문제
//  대응(2026-09-28 발주, 사례 #6729).
//
//  Jev 미적용 사유(전역 CLAUDE.md §1-B·스킬 jev-typed-decisions §4):
//    reply_needed Jev 실측 78.3% 일치율·37.5% 폴백(40건, RECON.md 2026-09-28) — 90%/폴백 문턱 미달 → LLM.
//
//  캐시: mails.reply_needed / reply_needed_confidence / reply_needed_reason / reply_needed_source /
//        reply_needed_at (db.js migrate() 참조). 재판정 금지(메일 내용은 변하지 않음) — 단 manual
//        지정은 LLM 재판정이 절대 덮지 않는다(db.setReplyNeeded 참조).
// ============================================================

const cerebras = require('./cerebras');

function extractJson(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : null;
  } catch (_) { return null; }
}

const SYSTEM = [
  '당신은 한국 조선/해양 엔지니어링 회사의 이메일 "회신 필요성" 판정기입니다.',
  '이 메일의 수신자(나)가 이 메일에 "직접" 회신해야 하는지만 판정하세요.',
  '기준: 나에게 던져진 질문·요청·기한·확인 요구가 있으면 true.',
  '단순 통보·공지·참고 공유·자료/도면 송부·광고·뉴스레터·자동발송이면 false.',
  '수신역할이 참조(CC)이고 나를 직접 지목한 요청이 없으면 대개 false 입니다.',
  '같은 스레드에서 이미 누군가 답했거나 결론이 났으면 false 에 가깝습니다.',
  '반드시 아래 JSON 스키마로만 답하세요. 설명·마크다운 금지:',
  '{"needs_reply": true|false, "confidence": 0.0~1.0, "reason": "판단 한 줄 이유"}',
  '메일이 한국어면 reason 도 한국어로 쓰세요.'
].join('\n');

function buildUserContent({ mail, roleLabel, threadPrev, attachNames }) {
  const body = String(mail.body || mail.preview || '').replace(/\s+/g, ' ').slice(0, 1200);
  const lines = [
    `수신역할: ${roleLabel}`,
    `제목: ${mail.subject || ''}`,
    `발신: ${mail.sender_name || ''} <${mail.sender_email || ''}>`,
    (attachNames && attachNames.length) ? `진짜 첨부: ${attachNames.join(', ')}` : '첨부: 없음'
  ];
  if (threadPrev) lines.push(`[같은 스레드 직전 메일 요지]\n${threadPrev}`);
  lines.push(`본문:\n${body}`);
  return lines.join('\n');
}

// ------------------------------------------------------------
//  단건 판정 — 무료 LLM 1건 1호출 (mode:'batch' → 배치 체인, Groq 우선)
// ------------------------------------------------------------
async function classifyMail(mail, { keys, model, threadPrev = '', attachNames = [] } = {}) {
  if (!mail) return { ok: false, error: '메일 없음' };
  const roleLabel = mail.to_me === 1 ? '직접수신(To)' : (mail.to_me === 0 ? '참조(CC)' : '알수없음');
  const content = buildUserContent({ mail, roleLabel, threadPrev, attachNames });
  const res = await cerebras.chat({
    keys, model, mode: 'batch',
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content }],
    // 🔴 400 이면 잘림(RECON 2026-09-28 "OpenRouter LLM 200 maxTokens 함정" — nemotron 계열이 reasoning
    //   토큰 200~250개를 먼저 소비해 JSON이 중간 절단된다) — 실측(이번 발주 real-measure3, #138971)으로
    //   재확인. 900 유지.
    temperature: 0.1, maxTokens: 900
  });
  if (!res.ok) return { ok: false, error: res.error };
  const parsed = extractJson(res.content);
  if (!parsed || typeof parsed.needs_reply !== 'boolean') {
    return { ok: false, error: `JSON 파싱 실패: ${String(res.content || '').slice(0, 200)}` };
  }
  const confidence = Number(parsed.confidence);
  return {
    ok: true,
    needsReply: !!parsed.needs_reply,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5,
    reason: String(parsed.reason || '').slice(0, 300)
  };
}

// ------------------------------------------------------------
//  후보 목록 순차 판정 (1건 1호출 — 동시 호출로 제공자 무료 한도를 태우지 않는다)
//   items[i] = { mail, threadPrev, attachNames }
// ------------------------------------------------------------
async function classifyBatch(items, { keys, model, onProgress = () => {} } = {}) {
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const r = await classifyMail(it.mail, { keys, model, threadPrev: it.threadPrev, attachNames: it.attachNames });
    out.push({ id: it.mail.id, ...r });
    try { onProgress({ cur: i + 1, total: items.length, id: it.mail.id, ok: r.ok }); } catch (_) {}
  }
  return out;
}

// ------------------------------------------------------------
//  최종 표시 버킷 — SoT: 화면(회신대기)·대시보드 위젯·아침 브리핑이 전부 이 함수 하나에서 파생한다.
//   'needed'    : 회신 필요(기본 펼침) — 미분류 상태(source 없음)도 여기 포함한다(안전 쪽, 스킬 §4).
//   'notneeded' : 회신 불필요로 판단(접힘, 이유 표시)
//   confidence < 0.70 인 LLM 판정은 놓치는 쪽보다 과잉이 안전하므로 'needed' + uncertain=true.
//   manual 지정은 LLM 재판정이 절대 덮지 않는다(db.setReplyNeeded 에서 보장) — 여기서는 그 결과만 읽는다.
// ------------------------------------------------------------
function bucketOf(mail) {
  const source = mail.reply_needed_source;
  if (source === 'manual') {
    return { bucket: mail.reply_needed ? 'needed' : 'notneeded', uncertain: false, manual: true, unclassified: false };
  }
  if (source === 'llm') {
    const conf = mail.reply_needed_confidence;
    if (conf !== null && conf !== undefined && conf < 0.70) {
      return { bucket: 'needed', uncertain: true, manual: false, unclassified: false };
    }
    return { bucket: mail.reply_needed ? 'needed' : 'notneeded', uncertain: false, manual: false, unclassified: false };
  }
  return { bucket: 'needed', uncertain: false, manual: false, unclassified: true };
}

module.exports = { classifyMail, classifyBatch, bucketOf, SYSTEM, extractJson };

// ---- 셀프체크 (순수 로직만 — 네트워크 호출 없음) ----
if (require.main === module) {
  const assert = require('assert');
  let pass = 0;

  // 1) 미분류(source 없음) → 항상 'needed'(안전 쪽 기본값)
  assert.deepStrictEqual(bucketOf({ reply_needed: null, reply_needed_source: null, reply_needed_confidence: null }).bucket, 'needed'); pass++;
  assert.strictEqual(bucketOf({ reply_needed_source: null }).unclassified, true); pass++;

  // 2) LLM 판정, 고신뢰(>=0.70) → 값 그대로 따른다
  assert.strictEqual(bucketOf({ reply_needed: 1, reply_needed_source: 'llm', reply_needed_confidence: 0.9 }).bucket, 'needed'); pass++;
  assert.strictEqual(bucketOf({ reply_needed: 0, reply_needed_source: 'llm', reply_needed_confidence: 0.9 }).bucket, 'notneeded'); pass++;

  // 3) LLM 판정, 저신뢰(<0.70) → false 라도 'needed'+uncertain (놓치는 쪽보다 과잉이 안전)
  const low = bucketOf({ reply_needed: 0, reply_needed_source: 'llm', reply_needed_confidence: 0.5 });
  assert.strictEqual(low.bucket, 'needed'); pass++;
  assert.strictEqual(low.uncertain, true); pass++;

  // 4) manual 지정 — LLM 판정과 반대여도 manual 이 이긴다(재판정이 덮지 않음 — 이 함수는 최종 source 만 읽으므로
  //    "재판정이 manual 을 덮지 않는다"는 보장은 db.setReplyNeeded 쪽 책임이지만, 여기서는 manual 소스가 오면
  //    confidence 와 무관하게 그 값을 그대로 따르는지 확인한다).
  assert.strictEqual(bucketOf({ reply_needed: 1, reply_needed_source: 'manual', reply_needed_confidence: 0.1 }).bucket, 'needed'); pass++;
  assert.strictEqual(bucketOf({ reply_needed: 0, reply_needed_source: 'manual', reply_needed_confidence: null }).bucket, 'notneeded'); pass++;
  assert.strictEqual(bucketOf({ reply_needed: 0, reply_needed_source: 'manual' }).manual, true); pass++;

  // 5) extractJson — 설명 텍스트가 앞뒤에 붙어도 JSON 추출
  assert.deepStrictEqual(extractJson('네, 판정합니다.\n{"needs_reply":true,"confidence":0.8,"reason":"질문 있음"}'),
    { needs_reply: true, confidence: 0.8, reason: '질문 있음' }); pass++;
  assert.strictEqual(extractJson('설명만 있고 JSON 없음'), null); pass++;

  console.log(`reply-needed.js 셀프체크 OK — ${pass}건 통과(버킷 SoT·미분류 안전값·저신뢰 과잉안전·manual 우선·JSON 추출)`);
}
