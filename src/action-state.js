// ============================================================
//  action-state.js — 메일별 '내 처리 상태' 정의 · 자동 제안 (순수 함수 · 의존성 0)
//  ------------------------------------------------------------
//  마스터 정의 4분류
//    todo 할 일   : 내가 액션을 해야 하는 메일
//    hold 보류    : 지금은 못 하거나 상대 회신을 기다리는 중
//    done 처리    : 끝난 것
//    fyi  확인만  : 내용만 알면 되는 통보성 (액션 없음)
//    (미지정)     : 아직 분류 안 함
//
//  🔴 원칙
//   · **수동 지정이 정본**이다. 이 파일의 자동 판정은 '제안'일 뿐이며 절대 덮어쓰지 않는다.
//   · 색만으로 구분하지 않는다 — 항상 한글 라벨을 함께 표시한다(색맹 8% 대응).
//   · 대비 실측(WCAG 2.1): 아래 COLORS 주석 참조. 전부 4.5:1 이상.
// ============================================================

// 상태 정의 (순서 = 화면 표시 순서)
const STATES = ['todo', 'hold', 'done', 'fyi'];

const META = {
  todo: { key: 'todo', label: '할 일', short: '할일', order: 1, hotkey: '1',
    desc: '내가 처리해야 하는 메일' },
  hold: { key: 'hold', label: '보류', short: '보류', order: 2, hotkey: '2',
    desc: '지금은 못 하거나 상대 회신을 기다리는 중' },
  done: { key: 'done', label: '처리', short: '처리', order: 3, hotkey: '3',
    desc: '처리가 끝난 메일' },
  fyi: { key: 'fyi', label: '확인', short: '확인', order: 4, hotkey: '4',
    desc: '내용만 알면 되는 통보성 메일' }
};

// 대비 실측(계산기 검증):
//   할일 #b91c1c on #fef2f2 = 5.91:1 · on #ffffff 6.47:1 · 선택행 #cce4f7 4.93:1
//   보류 #854d0e on #fefce8 = 6.62:1 · on #ffffff 6.85:1
//   처리 #166534 on #f0fdf4 = 6.81:1 · on #ffffff 7.13:1 · 선택행 #cce4f7 5.44:1
//   확인 #374151 on #f3f4f6 = 9.37:1 · on #ffffff 10.31:1
const COLORS = {
  todo: { fg: '#b91c1c', bg: '#fef2f2', bd: '#fecaca' },
  hold: { fg: '#854d0e', bg: '#fefce8', bd: '#fde68a' },
  done: { fg: '#166534', bg: '#f0fdf4', bd: '#bbf7d0' },
  fyi: { fg: '#374151', bg: '#f3f4f6', bd: '#d1d5db' }
};

const isState = (s) => STATES.includes(String(s || ''));
const normalizeState = (s) => (isState(s) ? String(s) : null);
const labelOf = (s) => (META[s] ? META[s].label : '미지정');
const colorOf = (s) => COLORS[s] || { fg: '#4b5563', bg: '#ffffff', bd: '#e5e7eb' };
// '내가 아직 할 일이 남은' 상태 = 회신대기 등에서 계속 보여야 하는 것
const isOpen = (s) => s === 'todo' || s === 'hold' || !isState(s);
// '내 손을 떠난' 상태 = 회신대기 목록에서 빼도 되는 것
const isClosed = (s) => s === 'done' || s === 'fyi';

// ------------------------------------------------------------
//  자동 제안 (수동 지정이 없을 때만 화면에 '추천'으로 표시)
//  근거를 함께 돌려줘서 사용자가 납득하고 누를 수 있게 한다.
// ------------------------------------------------------------
const NOREPLY_RE = /(no-?reply|do-?not-?reply|donotreply|noreply|mailer-daemon|postmaster|newsletter|notifications?@|alert@|auto(mated)?@)/i;
const NEWSLETTER_RE = /(뉴스레터|newsletter|구독\s*해지|unsubscribe|수신거부|광고|\[알림\]|자동\s*발송|발신전용|본\s*메일은\s*발신전용)/i;
// 나에게 뭔가를 요구하는 문구 (한국어 실무 메일 기준)
const REQUEST_RE = /(요청|요망|부탁|검토\s*(?:바랍|요망|부탁)|확인\s*(?:바랍|부탁|요망)|회신\s*(?:바랍|부탁|요망)|송부\s*(?:바랍|부탁)|제출\s*(?:바랍|부탁|요망)|승인\s*(?:바랍|부탁)|답변\s*(?:바랍|부탁)|협조\s*(?:바랍|부탁)|please\s+(?:review|confirm|advise|send|provide|reply)|kindly\s+(?:review|confirm|advise|send)|could you|we\s+(?:need|request|require))/i;
// 통보·공유성 문구
const INFORM_RE = /(참고\s*(?:바랍|하시|용)|공유\s*(?:드립|합니다)|안내\s*(?:드립|말씀)|통보|알려\s*드립|for your (?:information|reference)|\bfyi\b|공지)/i;
// 이미 끝났다는 신호
const CLOSED_RE = /(완료\s*(?:되었|했|하였|입니다)|처리\s*(?:완료|되었)|승인\s*(?:완료|되었)|확인\s*(?:완료|했습니다)|해결\s*(?:완료|되었)|closed|resolved|completed)/i;

// mail: DB 행(또는 그에 준하는 객체)
// 반환: { state, reason, confidence } — state 는 제안값(null 가능)
function suggest(mail, opts = {}) {
  const m = mail || {};
  const folder = String(m.folder || '');
  const sender = String(m.sender_email || '').toLowerCase();
  const subject = String(m.subject || '');
  const text = `${subject}\n${String(m.preview || m.body || '').slice(0, 1500)}`;

  // 내가 보낸 메일은 '내가 할 일'이 아니다 → 상대 회신 대기 = 보류
  if (folder === 'Sent') return { state: 'hold', reason: '내가 보낸 메일 — 상대 회신 대기', confidence: 0.5 };

  // ① 자동발송·뉴스레터·발신전용 → 확인만
  if (NOREPLY_RE.test(sender)) return { state: 'fyi', reason: '발신전용 주소에서 온 자동 메일', confidence: 0.9 };
  if (NEWSLETTER_RE.test(text)) return { state: 'fyi', reason: '뉴스레터·자동 발송 문구가 있음', confidence: 0.75 };

  // ② Outlook 에서 깃발을 단 메일 = 내가 챙기겠다고 표시한 것 → 할 일
  if (Number(m.flag_status) === 2) return { state: 'todo', reason: 'Outlook 에서 후속 작업(깃발)으로 표시함', confidence: 0.95 };
  if (Number(m.flag_status) === 1) return { state: 'done', reason: 'Outlook 에서 후속 작업을 완료 처리함', confidence: 0.9 };

  // ③ 저장된 AI 분석에 '내가 할 일'이 잡혔으면 할 일
  if (Number(opts.actionCount) > 0) {
    return { state: 'todo', reason: `분석에서 해야 할 일 ${opts.actionCount}건이 확인됨`, confidence: 0.8 };
  }

  // ④ 이미 끝났다는 문구
  if (CLOSED_RE.test(subject)) return { state: 'done', reason: '제목에 완료·처리 표현이 있음', confidence: 0.6 };

  // ⑤ To/CC 판정 + 요청 문구
  const toMe = m.to_me;           // 1=직접 수신(To) · 0=참조(CC)
  const asked = REQUEST_RE.test(text);
  const inform = INFORM_RE.test(text);
  if (toMe === 0) {
    // 참조로만 받았는데 요청 문구까지 없으면 거의 확실히 통보성
    if (!asked) return { state: 'fyi', reason: '참조(CC)로만 받았고 요청 문구가 없음', confidence: 0.85 };
    return { state: 'todo', reason: '참조(CC)지만 요청 문구가 있음', confidence: 0.5 };
  }
  if (toMe === 1) {
    if (asked) return { state: 'todo', reason: '내가 받는사람(To)이고 요청 문구가 있음', confidence: 0.85 };
    if (inform) return { state: 'fyi', reason: '내가 받는사람(To)이지만 공유·참고성 문구임', confidence: 0.6 };
    return { state: 'todo', reason: '내가 받는사람(To)인 메일', confidence: 0.4 };
  }

  // ⑥ To/CC 판정이 없을 때는 문구만으로
  if (asked) return { state: 'todo', reason: '요청 문구가 있음', confidence: 0.55 };
  if (inform) return { state: 'fyi', reason: '공유·참고성 문구임', confidence: 0.5 };
  return { state: null, reason: '판단할 근거가 부족함', confidence: 0 };
}

// 화면 문구: "추천: 확인 — 참조(CC)로만 받았고 요청 문구가 없음"
function suggestText(s) {
  if (!s || !s.state) return '';
  return `추천: ${labelOf(s.state)} — ${s.reason}`;
}

// 상태별 건수 배열을 화면 표시 순서대로 정렬 (미지정은 항상 마지막)
function orderCounts(counts) {
  const c = counts || {};
  return [...STATES.map(k => ({ key: k, label: labelOf(k), count: Number(c[k]) || 0 })),
    { key: 'none', label: '미지정', count: Number(c.none) || 0 }];
}

module.exports = {
  STATES, META, COLORS,
  isState, normalizeState, labelOf, colorOf, isOpen, isClosed,
  suggest, suggestText, orderCounts
};

// ============================================================
//  셀프체크 — `node src/action-state.js`
// ============================================================
if (require.main === module) {
  const assert = require('assert');

  // 상태 정의 무결성
  assert.strictEqual(STATES.length, 4);
  STATES.forEach(s => {
    assert.ok(META[s] && META[s].label, `META 누락: ${s}`);
    assert.ok(COLORS[s] && COLORS[s].fg, `COLORS 누락: ${s}`);
  });
  assert.strictEqual(normalizeState('todo'), 'todo');
  assert.strictEqual(normalizeState('nope'), null);
  assert.strictEqual(normalizeState(''), null);
  assert.strictEqual(labelOf(null), '미지정');

  // 열림/닫힘 판정 — 회신대기 연동의 기준이므로 정확해야 한다
  assert.strictEqual(isOpen('todo'), true);
  assert.strictEqual(isOpen('hold'), true);
  assert.strictEqual(isOpen(null), true, '미지정은 아직 열린 것으로 봐야 한다');
  assert.strictEqual(isClosed('done'), true);
  assert.strictEqual(isClosed('fyi'), true);
  assert.strictEqual(isClosed('todo'), false);
  assert.strictEqual(isOpen('done'), false);

  // 대비 (색만으로 구분 금지 + 4.5:1)
  const lum = (h) => {
    const c = h.replace('#', '');
    const v = [0, 2, 4].map(i => parseInt(c.substr(i, 2), 16) / 255)
      .map(x => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)));
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  let minC = 99;
  for (const s of STATES) {
    const c = COLORS[s];
    minC = Math.min(minC, ratio(c.fg, c.bg), ratio(c.fg, '#ffffff'), ratio(c.fg, '#cce4f7'));
    assert.ok(META[s].label && META[s].label.length, `${s} 라벨 없음 — 색만으로 구분 금지 위반`);
  }
  assert.ok(minC >= 4.5, `배지 대비 미달: ${minC.toFixed(2)}:1`);

  // ---- 자동 제안 회귀 케이스 ----
  const C = [
    ['발신전용 자동메일 → 확인', { sender_email: 'noreply@bank.co.kr', subject: '거래 알림', to_me: 1 }, 'fyi'],
    ['뉴스레터 → 확인', { sender_email: 'news@x.com', subject: '주간 소식', preview: '수신거부 하시려면 아래 링크', to_me: 1 }, 'fyi'],
    ['깃발 표시 → 할 일', { sender_email: 'a@b.com', subject: '도면', flag_status: 2, to_me: 1 }, 'todo'],
    ['깃발 완료 → 처리', { sender_email: 'a@b.com', subject: '도면', flag_status: 1, to_me: 1 }, 'done'],
    ['CC + 요청없음 → 확인', { sender_email: 'a@b.com', subject: '진행현황 공유', preview: '아래와 같이 진행되고 있습니다.', to_me: 0 }, 'fyi'],
    ['CC + 요청 → 할 일', { sender_email: 'a@b.com', subject: '검토 요청 건', preview: '검토 바랍니다.', to_me: 0 }, 'todo'],
    ['To + 요청 → 할 일', { sender_email: 'a@b.com', subject: '도면 확인 요청', preview: '확인 부탁드립니다.', to_me: 1 }, 'todo'],
    ['To + 공유성 → 확인', { sender_email: 'a@b.com', subject: '자료 공유', preview: '참고 바랍니다. 공유드립니다.', to_me: 1 }, 'fyi'],
    ['보낸메일 → 보류', { folder: 'Sent', subject: '회신드립니다', to_me: null }, 'hold'],
    ['제목에 완료 → 처리', { sender_email: 'a@b.com', subject: '[처리완료] 도면 승인 완료되었습니다', to_me: 1 }, 'done'],
    ['분석에 할일 있음 → 할 일', { sender_email: 'a@b.com', subject: '무제', to_me: 1 }, 'todo', { actionCount: 3 }],
    ['근거 없음 → 제안 없음', { sender_email: 'a@b.com', subject: '', preview: '', to_me: null }, null]
  ];
  let pass = 0;
  for (const [name, mail, want, opts] of C) {
    const got = suggest(mail, opts || {});
    assert.strictEqual(got.state, want, `제안 실패: ${name} → ${got.state}(${got.reason}) / 기대 ${want}`);
    if (want) assert.ok(got.reason && got.reason.length > 3, `${name}: 근거 문구 없음`);
    pass++;
  }
  // 제안 문구
  assert.ok(suggestText(suggest(C[0][1])).includes('추천: 확인'), '제안 문구 형식 오류');
  assert.strictEqual(suggestText({ state: null }), '');

  // 집계 정렬 — 미지정은 항상 마지막
  const oc = orderCounts({ todo: 5, hold: 1, done: 9, fyi: 2, none: 100 });
  assert.deepStrictEqual(oc.map(x => x.key), ['todo', 'hold', 'done', 'fyi', 'none']);
  assert.strictEqual(oc[0].count, 5);
  assert.strictEqual(orderCounts({}).every(x => x.count === 0), true);

  console.log(`action-state 셀프체크 OK — 상태정의·열림닫힘·대비(최소 ${minC.toFixed(2)}:1)·자동제안 ${pass}건·집계 통과`);
}
