// ============================================================
//  timeline-agg.js — 검색/대화 결과 집합을 4탭(타임라인/목록/사람별/키워드별)으로
//  정리하기 위한 순수 집계 함수 (DB/Electron/DOM 을 전혀 모른다)
//  ------------------------------------------------------------
//  마스터 지시: "정렬하고 검토하면 무조건 타임라인으로 정리하고 요약".
//  · timelineRows()  : 시간순(최신 먼저) 표시용 행 — 같은 스레드는 연속되면 들여쓰기 플래그.
//  · personTable()   : 이름/조직 | 받은 | 보낸 | 최초 | 최근 | 미회신 | 주요주제
//  · keywordTable()  : analyzer.extractProjectCodes 재사용 — 키워드 | 건수 | 관련인물 | 기간 | 대표메일
//  대화형 자연어 요약(날짜별 한줄·종합)은 AI 가 만든다 — 이 파일은 순수 집계만 담당한다.
//
//  ponytail: 스레드 들여쓰기는 "직전 행과 thread_key 가 같으면 들여쓴다"는 단순 휴리스틱이다.
//    (완전한 트리 재구성은 안 한다 — 결과가 항상 시간순 1줄 리스트라 UI 가 단순해야 하기 때문)
//    같은 스레드가 시간상 멀리 떨어져 다시 등장하면 다시 들여쓰기 없이 새로 시작한다.
//
//  셀프체크: node src/timeline-agg.js
// ============================================================

const dirOf = (m) => (String(m.folder || '') === 'Sent' ? 'sent' : 'recv');
const isoDay = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d)) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const oneLine = (s, n = 90) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const counterpartOf = (m) => (dirOf(m) === 'sent' ? (m.recipients || '') : (m.sender_name || m.sender_email || ''));

// ------------------------------------------------------------
//  타임라인 행 — 최신 먼저. 같은 thread_key 가 바로 앞 행과 같으면 sameThread=true(들여쓰기).
// ------------------------------------------------------------
function timelineRows(mails) {
  const list = [...(mails || [])].sort((a, b) => (b.received_ts || 0) - (a.received_ts || 0));
  let prevThread = null;
  return list.map((m) => {
    const threadKey = m.thread_key || '';
    const sameThread = !!threadKey && threadKey === prevThread;
    prevThread = threadKey || null;
    return {
      id: m.id,
      dir: dirOf(m),
      dateKey: isoDay(m.received_ts) || String(m.received_at || '').slice(0, 10),
      receivedAt: m.received_at || '',
      counterpart: counterpartOf(m),
      subject: m.subject || '(제목 없음)',
      oneLiner: oneLine(m.preview || m.body || ''),
      hasAttach: !!m.has_attach,
      attachCount: Number(m.real_attach_count != null ? m.real_attach_count : (m.attach_count || 0)) || 0,
      actionState: m.action_state || '',
      threadKey,
      sameThread
    };
  });
}

// ------------------------------------------------------------
//  날짜별 그룹 골격(요약 문구는 비워 둠 — 호출부가 AI 요약을 채운다)
// ------------------------------------------------------------
function dateGroups(mails) {
  const map = new Map();
  for (const m of mails || []) {
    const d = isoDay(m.received_ts) || String(m.received_at || '').slice(0, 10) || '(날짜미상)';
    if (!map.has(d)) map.set(d, []);
    map.get(d).push(m);
  }
  return [...map.entries()]
    .map(([date, ms]) => ({ date, count: ms.length, summary: '' }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

// ------------------------------------------------------------
//  사람별 표 — 이름/조직 | 받은 | 보낸 | 최초 | 최근 | 미회신 | 주요주제
//   식별 키 = 이메일(없으면 이름). 보낸 메일은 수신자 각각을 상대로 집계.
// ------------------------------------------------------------
function personTable(mails, { extractCodes = null, topicLimit = 3 } = {}) {
  const map = new Map();   // key(lower email or name) -> entry
  const touch = (key, name, org, m, role) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, { name, org: org || '', recv: 0, sent: 0, unanswered: 0, firstTs: Infinity, lastTs: 0, topics: new Map() });
    const e = map.get(key);
    if (name && (!e.name || e.name.length < name.length)) e.name = name;
    if (org) e.org = org;
    if (role === 'recv') e.recv++; else e.sent++;
    if (role === 'recv' && m.replied === false) e.unanswered++;
    const ts = m.received_ts || 0;
    if (ts) { if (ts < e.firstTs) e.firstTs = ts; if (ts > e.lastTs) e.lastTs = ts; }
    if (typeof extractCodes === 'function') {
      const codes = extractCodes(`${m.subject || ''} ${m.preview || ''}`);
      for (const c of codes) e.topics.set(c.value, (e.topics.get(c.value) || 0) + 1);
    }
  };
  for (const m of mails || []) {
    if (dirOf(m) === 'sent') {
      // 보낸 메일 — 받는사람 각각을 상대로 집계(간단 파싱: 콤마/세미콜론 구분)
      const to = String(m.recipients || '').split(/[;,]/).map(s => s.trim()).filter(Boolean);
      if (!to.length) touch('(수신자 미상)', '(수신자 미상)', '', m, 'sent');
      else to.forEach(name => touch(name.toLowerCase(), name, m.to_org || '', m, 'sent'));
    } else {
      const key = (m.sender_email || m.sender_name || '').toLowerCase();
      touch(key, m.sender_name || m.sender_email || '(발신자 없음)', m.to_org || '', m, 'recv');
    }
  }
  const rows = [...map.entries()].map(([key, e]) => ({
    key, name: e.name, org: e.org, recv: e.recv, sent: e.sent, unanswered: e.unanswered,
    firstTs: e.firstTs === Infinity ? 0 : e.firstTs, lastTs: e.lastTs,
    topics: [...e.topics.entries()].sort((a, b) => b[1] - a[1]).slice(0, topicLimit).map(([k]) => k)
  })).sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  return rows;
}

// ------------------------------------------------------------
//  키워드별 표 — extractCodes(regex 기반, LLM 미경유)를 주입받아 재사용한다.
//   키워드 | 건수 | 관련인물 | 기간(최초~최근) | 대표메일(가장 최근 1건)
// ------------------------------------------------------------
function keywordTable(mails, extractCodes) {
  if (typeof extractCodes !== 'function') return [];
  const map = new Map();
  for (const m of mails || []) {
    const codes = extractCodes(`${m.subject || ''} ${m.preview || ''}`);
    for (const c of codes) {
      const key = c.value;
      if (!map.has(key)) map.set(key, { count: 0, people: new Set(), firstTs: Infinity, lastTs: 0, rep: null });
      const e = map.get(key);
      e.count++;
      const who = m.sender_name || m.sender_email;
      if (who) e.people.add(who);
      const ts = m.received_ts || 0;
      if (ts) { if (ts < e.firstTs) e.firstTs = ts; if (ts > e.lastTs) e.lastTs = ts; }
      if (!e.rep || ts > (e.rep.received_ts || 0)) e.rep = m;
    }
  }
  return [...map.entries()].map(([keyword, e]) => ({
    keyword, count: e.count, people: [...e.people],
    firstTs: e.firstTs === Infinity ? 0 : e.firstTs, lastTs: e.lastTs,
    repId: e.rep ? e.rep.id : null, repSubject: e.rep ? (e.rep.subject || '') : ''
  })).sort((a, b) => b.count - a.count);
}

module.exports = { timelineRows, dateGroups, personTable, keywordTable, dirOf, isoDay, oneLine };

// ============================================================
//  셀프체크 — `node src/timeline-agg.js`
// ============================================================
if (require.main === module) {
  const assert = require('assert');
  const D = (s) => Date.parse(s + 'T09:00:00');
  const extractCodes = (text) => {
    const out = [];
    if (/hole/i.test(text)) out.push({ value: 'HOLE' });
    if (/2710\/11/.test(text)) out.push({ value: '2710/11' });
    return out;
  };
  const M = [
    { id: 1, folder: 'Inbox', thread_key: 'panopi', received_ts: D('2026-08-03'), received_at: '2026-08-03 09:00', subject: 'hole 관련 문의', preview: 'hole 위치 확인 부탁드립니다', sender_name: '설병헌', sender_email: 'seol@x.com', to_org: '씨스타', has_attach: 1, real_attach_count: 1, replied: false },
    { id: 2, folder: 'Inbox', thread_key: 'panopi', received_ts: D('2026-08-02'), received_at: '2026-08-02 10:00', subject: '2710/11 도면', preview: '2710/11 도면 확인 요청', sender_name: '설병헌', sender_email: 'seol@x.com', to_org: '씨스타', has_attach: 0, real_attach_count: 0, replied: true },
    { id: 3, folder: 'Sent', thread_key: 'panopi', received_ts: D('2026-08-02'), received_at: '2026-08-02 11:00', subject: 'RE: 2710/11 도면', preview: '확인했습니다', recipients: '설병헌', to_org: '씨스타', has_attach: 0, real_attach_count: 0 },
    { id: 4, folder: 'Inbox', thread_key: 'other', received_ts: D('2026-08-01'), received_at: '2026-08-01 08:00', subject: '일반 문의', preview: '문의드립니다', sender_name: '김정인', sender_email: 'kim@y.com', to_org: '한국야나세', has_attach: 0, real_attach_count: 0, replied: false }
  ];

  // ① 타임라인 행: 최신 먼저 + 같은 스레드 연속이면 들여쓰기 플래그
  const rows = timelineRows(M);
  assert.strictEqual(rows[0].id, 1, '타임라인이 최신순이 아님');
  assert.strictEqual(rows[3].id, 4);
  assert.strictEqual(rows[0].sameThread, false, '첫 행은 들여쓰기 없어야 함');
  assert.strictEqual(rows[1].sameThread, true, '연속 같은 스레드(2번)가 들여쓰기 안 됨');
  assert.strictEqual(rows[2].sameThread, true, '연속 같은 스레드(3번)가 들여쓰기 안 됨');
  assert.strictEqual(rows[3].sameThread, false, '스레드가 바뀐 4번이 들여쓰기됨');
  assert.strictEqual(rows[0].dir, 'recv');
  assert.strictEqual(rows[2].dir, 'sent');

  // ② 날짜 그룹 골격
  const dg = dateGroups(M);
  assert.strictEqual(dg[0].date, '2026-08-03');
  assert.strictEqual(dg[1].count, 2, '2026-08-02 에 2건이 있어야 함(받음1+보냄1)');

  // ③ 사람별 표: 받음/보냄/미회신/최초·최근
  const pt = personTable(M, { extractCodes });
  const seol = pt.find(r => r.key === 'seol@x.com');
  assert.ok(seol, '설병헌이 사람별 표에 없음');
  assert.strictEqual(seol.recv, 2, '설병헌 받은 건수 불일치');
  assert.strictEqual(seol.unanswered, 1, '미회신 집계 결함(1건이어야 함)');
  assert.strictEqual(seol.firstTs, D('2026-08-02'));
  assert.strictEqual(seol.lastTs, D('2026-08-03'));
  assert.ok(seol.topics.includes('HOLE'), '주요주제에 HOLE 누락: ' + JSON.stringify(seol.topics));
  const kim = pt.find(r => r.key === 'kim@y.com');
  assert.strictEqual(kim.unanswered, 1);

  // ④ 키워드별 표: 건수·관련인물·대표메일
  const kt = keywordTable(M, extractCodes);
  const hole = kt.find(r => r.keyword === 'HOLE');
  assert.ok(hole, 'HOLE 키워드 누락');
  assert.strictEqual(hole.count, 1);
  assert.ok(hole.people.includes('설병헌'));
  assert.strictEqual(hole.repId, 1);
  const code2710 = kt.find(r => r.keyword === '2710/11');
  assert.strictEqual(code2710.count, 2, '2710/11 은 메일2(받음)+메일3(보낸 RE:제목)에 나와 2건이어야 함');

  // ⑤ 빈 입력에서 죽지 않아야 한다
  assert.deepStrictEqual(timelineRows([]), []);
  assert.deepStrictEqual(dateGroups([]), []);
  assert.deepStrictEqual(personTable([]), []);
  assert.deepStrictEqual(keywordTable([], extractCodes), []);
  assert.deepStrictEqual(keywordTable(M, null), [], 'extractCodes 없으면 빈 배열이어야 함(고장 방지)');

  console.log('timeline-agg 셀프체크 OK — 타임라인 행(들여쓰기)·날짜그룹·사람별표·키워드별표·빈입력 통과');
}
