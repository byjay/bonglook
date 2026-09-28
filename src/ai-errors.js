// ============================================================
//  ai-errors.js — AI 호출 실패를 '사람이 읽는 문구'로 바꾸는 단일 책임 모듈
//  ------------------------------------------------------------
//  왜 필요한가 (2026-08-14 실측 장애)
//   Cerebras 키 7개가 전부 HTTP 402 payment_required 였는데 화면에는
//   AI 오류(HTTP 402): {"message":"Payment required...","type":"..."}
//   처럼 raw JSON 이 그대로 떴다. 사용자는 무엇을 해야 할지 알 수 없다.
//   → 상태코드·본문을 여기 한 곳에서 판정해 제목/설명/행동으로 바꾼다.
//
//  이 모듈은 순수 함수만 갖는다(네트워크·DOM·파일 접근 0).
//  main(백엔드)과 renderer(화면)가 같은 판정을 쓰도록 kind 를 함께 넘긴다.
//  셀프체크: node src/ai-errors.js
// ============================================================

//  kind: quota | key | rate | server | network | nokey | length | empty | unknown
const KINDS = {
  quota: {
    title: 'AI 사용량이 소진되었습니다',
    body: 'Cerebras 계정의 사용 한도가 끝났거나 결제가 필요합니다. cloud.cerebras.ai → Billing 에서 상태를 확인하거나, 설정에서 새 API 키를 등록하세요.',
    action: 'settings'
  },
  key: {
    title: 'API 키가 올바르지 않습니다',
    body: '키가 만료됐거나 권한이 없습니다. 설정에서 키를 다시 확인해 주세요.',
    action: 'settings'
  },
  rate: {
    title: '요청이 몰려 잠시 대기가 필요합니다',
    body: '분당 요청 한도에 걸렸습니다. 잠시 후 다시 시도하면 됩니다(키를 여러 개 넣으면 자동으로 번갈아 씁니다).',
    action: 'retry'
  },
  server: {
    title: 'AI 서버가 응답하지 않습니다',
    body: '제공자 쪽 일시적인 오류입니다. 잠시 후 다시 시도해 주세요.',
    action: 'retry'
  },
  network: {
    title: '네트워크에 연결하지 못했습니다',
    body: '인터넷 연결이나 사내 방화벽·프록시 설정을 확인해 주세요.',
    action: 'retry'
  },
  nokey: {
    title: 'API 키가 등록되지 않았습니다',
    body: '설정 화면에서 Cerebras API 키를 입력하면 AI 기능을 쓸 수 있습니다.',
    action: 'settings'
  },
  length: {
    title: '내용이 너무 길어 결과를 만들지 못했습니다',
    body: '대상 메일 수나 기간을 줄여서 다시 시도해 주세요.',
    action: 'retry'
  },
  toolarge: {
    title: '입력이 너무 커서 요청이 거부되었습니다',
    body: '스레드·본문·첨부 목록을 줄여 자동으로 다시 시도합니다.',
    action: 'retry'
  },
  empty: {
    title: 'AI가 빈 응답을 보냈습니다',
    body: '같은 요청을 한 번 더 시도해 보세요. 반복되면 설정에서 모델을 바꿔 보세요.',
    action: 'retry'
  },
  unknown: {
    title: 'AI 요청을 처리하지 못했습니다',
    body: '잠시 후 다시 시도해 주세요. 계속되면 설정에서 키와 모델을 확인하세요.',
    action: 'retry'
  }
};

// HTTP 상태코드 → kind
function kindFromStatus(status) {
  const s = Number(status) || 0;
  if (s === 402) return 'quota';
  if (s === 401 || s === 403) return 'key';
  if (s === 429) return 'rate';
  if (s === 413) return 'toolarge';
  if (s >= 500 && s <= 599) return 'server';
  if (s === 400 || s === 404 || s === 422) return 'unknown';
  return '';
}

// 응답 본문/에러 문자열에서 kind 추정 (상태코드를 잃어버린 경로용)
function kindFromText(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return '';
  if (/payment[_ ]?required|insufficient|quota|billing|credit/.test(t)) return 'quota';
  if (/invalid[_ ]?api[_ ]?key|unauthorized|forbidden|authentication/.test(t)) return 'key';
  if (/rate[_ ]?limit|too many requests/.test(t)) return 'rate';
  if (/request too large|payload too large|too large|entity too large|context[_ ]?length|maximum context/.test(t)) return 'toolarge';
  if (/timeout|시간 초과|econn|enotfound|network|fetch failed|getaddrinfo/.test(t)) return 'network';
  if (/bad gateway|service unavailable|internal server/.test(t)) return 'server';
  return '';
}

// 제공자 JSON 본문에서 사람이 읽을 한 줄만 뽑는다(없으면 빈 문자열)
function providerMessage(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  try {
    const j = JSON.parse(raw);
    const m = j.message || (j.error && (j.error.message || j.error.type)) || '';
    return String(m || '').slice(0, 160);
  } catch (e) { /* JSON 아님 */ }
  // JSON 이 아니면 중괄호·따옴표를 걷어낸 앞부분만
  return raw.replace(/[{}"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
}

// ------------------------------------------------------------
//  핵심: 실패 정보를 사람이 읽는 형태로
//   describe({ status, body, message, kind })
//   → { kind, title, message, action, detail }
//     title/message = 화면에 그대로 노출 (raw JSON 없음)
//     detail        = 진단용 원문 요약(작게 덧붙일 용도)
// ------------------------------------------------------------
function describe(opts) {
  const o = opts || {};
  const status = o.status || 0;
  const body = o.body || '';
  const message = o.message || '';
  const k = o.kind
    || kindFromStatus(status)
    || kindFromText(body)
    || kindFromText(message)
    || 'unknown';
  const def = KINDS[k] || KINDS.unknown;
  const hint = providerMessage(body);
  return {
    kind: k,
    title: def.title,
    message: def.body,
    action: def.action,
    detail: [status ? ('HTTP ' + status) : '', hint].filter(Boolean).join(' · ')
  };
}

// 한 줄 요약 (로그·툴팁용). 화면 본문에는 title/message 를 쓴다.
function shortText(info) {
  return info.title + ' — ' + info.message;
}

// AI 상태 배지용 라벨 (헤더·설정에 공통 사용)
//  state: ok | quota | key | rate | error | nokey | unknown
const STATE_LABEL = {
  ok: 'AI 정상',
  quota: 'AI 한도 소진',
  key: 'AI 키 오류',
  rate: 'AI 대기 중',
  error: 'AI 오류',
  nokey: 'AI 키 없음',
  unknown: 'AI 상태 미확인'
};
function stateFromKind(kind) {
  if (!kind) return 'ok';
  if (kind === 'quota') return 'quota';
  if (kind === 'key') return 'key';
  if (kind === 'nokey') return 'nokey';
  if (kind === 'rate') return 'rate';
  return 'error';
}

module.exports = { describe, shortText, kindFromStatus, kindFromText, providerMessage, stateFromKind, STATE_LABEL, KINDS };

// ============================================================
//  셀프체크 — node src/ai-errors.js
// ============================================================
if (require.main === module) {
  const assert = require('assert');

  // ① 실측 장애 그대로: 402 + payment_required 본문
  const real = '{"message":"Payment required. Please check your billing settings.","type":"payment_required","param":null,"code":null}';
  const d1 = describe({ status: 402, body: real });
  assert.strictEqual(d1.kind, 'quota', '402 를 quota 로 못 봄');
  assert.ok(d1.title.indexOf('사용량') >= 0, '제목이 사용자 언어가 아님');
  assert.ok(/cloud\.cerebras\.ai|Billing/.test(d1.message), '어디서 확인해야 하는지 안내가 없음');
  assert.strictEqual(d1.action, 'settings');
  // 화면 문구에 raw JSON 이 섞이면 안 된다
  assert.ok(!/[{}]|"type"/.test(d1.title + d1.message), 'raw JSON 이 화면 문구에 남았다');

  // ② 상태코드별 분류
  assert.strictEqual(describe({ status: 401 }).kind, 'key');
  assert.strictEqual(describe({ status: 403 }).kind, 'key');
  assert.strictEqual(describe({ status: 429 }).kind, 'rate');
  assert.strictEqual(describe({ status: 503 }).kind, 'server');
  assert.strictEqual(describe({ status: 500 }).kind, 'server');

  // ③ 상태코드가 없어도 본문으로 판정
  assert.strictEqual(describe({ message: 'fetch failed: getaddrinfo ENOTFOUND api.cerebras.ai' }).kind, 'network');
  assert.strictEqual(describe({ message: 'Invalid API key provided' }).kind, 'key');
  assert.strictEqual(describe({ body: '{"message":"insufficient credit"}' }).kind, 'quota');

  // ④ 명시 kind 우선
  assert.strictEqual(describe({ kind: 'nokey' }).kind, 'nokey');
  assert.strictEqual(describe({ status: 402, kind: 'length' }).kind, 'length');

  // ⑤ 알 수 없는 경우에도 문구는 항상 존재
  const d5 = describe({});
  assert.ok(d5.title && d5.message && d5.action, '기본 문구 누락');

  // ⑥ provider 메시지 추출
  assert.strictEqual(providerMessage(real), 'Payment required. Please check your billing settings.');
  assert.strictEqual(providerMessage('그냥 텍스트'), '그냥 텍스트');
  assert.strictEqual(providerMessage(''), '');

  // ⑦ 상태 배지
  assert.strictEqual(stateFromKind('quota'), 'quota');
  assert.strictEqual(stateFromKind(''), 'ok');
  assert.strictEqual(stateFromKind('server'), 'error');
  assert.ok(STATE_LABEL.quota.indexOf('한도') >= 0);

  console.log('ai-errors 셀프체크 OK — 402 실측본문/상태코드 6종/본문추정 3종/kind우선/기본문구/provider추출/상태배지 통과');
}
