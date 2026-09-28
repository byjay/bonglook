// ============================================================
//  보낸편지함 분류 축 (순수 로직 · 의존성 0)
//  ------------------------------------------------------------
//  마스터 요구(2026-08-04): 보낸메일을 세 축으로 본다.
//    ① 프로젝트별 (기존 sentProjectTree)
//    ② 날짜별      — 연 > 월 트리
//    ③ 이벤트·테마별 — 도면/견적/승인/회의/발주 … 제목 키워드로 분류
//
//  ponytail: 제목 키워드 규칙은 단순 우선순위 매칭이다(첫 일치 승).
//            정확도가 더 필요해지면 본문·첨부명까지 보는 규칙으로 넓히면 된다.
//            주의: 'RE:'/'FW:' 접두사와 대괄호 태그는 먼저 걷어낸다.
// ============================================================

// 순서 = 우선순위. 앞에 있을수록 강한 신호.
const EVENT_RULES = [
  { key: 'quote', label: '견적', re: /견적|quotation|\bquote\b|\bQTN\b|단가|price\s*list/i },
  { key: 'order', label: '발주·계약', re: /발주|구매\s*요청|\bPO\b|purchase\s*order|계약|contract|낙찰/i },
  { key: 'approval', label: '승인·검토', re: /승인|approval|approve|검토\s*요청|comment|코멘트|review|확인\s*요청|회신\s*요청/i },
  { key: 'drawing', label: '도면·출도', re: /도면|출도|drawing|\bDWG\b|\bPOS\b|도번|설계도|figure/i },
  // '검사·시운전'은 '회의·일정'보다 강한 신호로 둔다 (예: 'FAT 검사 일정' → 검사)
  { key: 'test', label: '검사·시운전', re: /검사|시운전|\bFAT\b|\bSAT\b|test|inspection|승선|방선/i },
  { key: 'meeting', label: '회의·일정', re: /회의|미팅|meeting|일정|schedule|킥오프|kick[-\s]?off|화상|zoom|teams\s*회의/i },
  { key: 'report', label: '보고·주간', re: /보고|report|주간|월간|weekly|monthly|현황|실적/i },
  { key: 'spec', label: '사양·자료', re: /사양|스펙|\bspec\b|매뉴얼|manual|데이터\s*시트|datasheet|자료\s*송부|기술\s*자료/i },
  { key: 'ship', label: '납기·출하', re: /납기|출하|배송|delivery|shipment|선적|packing/i },
  { key: 'claim', label: '문제·클레임', re: /클레임|claim|하자|불량|이슈|issue|문제\s*점|지연/i }
];
const EVENT_ETC = { key: 'etc', label: '기타', re: null };

// 제목 정규화 — RE:/FW: 접두사, [태그], 공백 정리
function normalizeSubject(subject) {
  let s = String(subject || '');
  // 여러 번 붙은 RE:/FW:/답장:/전달: 를 반복 제거
  for (let i = 0; i < 6; i++) {
    const before = s;
    s = s.replace(/^\s*(?:\[[^\]]{0,20}\]\s*)?(?:re|fw|fwd|답장|전달|회신)\s*[:：]\s*/i, '');
    if (s === before) break;
  }
  return s.replace(/\s+/g, ' ').trim();
}

// 제목 → 이벤트 분류 (첫 일치 승, 없으면 기타)
function classifyEvent(subject) {
  const s = normalizeSubject(subject);
  if (!s) return EVENT_ETC;
  for (const r of EVENT_RULES) if (r.re.test(s)) return r;
  return EVENT_ETC;
}

// 메일 배열 → 이벤트별 묶음 (건수·최근활동 내림차순)
//  rows: [{ id, subject, received_ts, ... }]
function groupByEvent(rows) {
  const map = new Map();
  for (const r of (rows || [])) {
    const e = classifyEvent(r.subject);
    if (!map.has(e.key)) map.set(e.key, { key: e.key, label: e.label, cnt: 0, lastTs: 0, mails: [] });
    const g = map.get(e.key);
    g.cnt++;
    if ((r.received_ts || 0) > g.lastTs) g.lastTs = r.received_ts || 0;
    g.mails.push(r);
  }
  const out = [...map.values()];
  out.forEach(g => g.mails.sort((a, b) => (b.received_ts || 0) - (a.received_ts || 0)));
  // 기타는 항상 마지막, 나머지는 최근 활동순
  out.sort((a, b) => (a.key === 'etc') - (b.key === 'etc') || (b.lastTs || 0) - (a.lastTs || 0));
  return out;
}

// 메일 배열 → 연/월 트리 (최신 연·월 먼저)
function groupByDate(rows) {
  const years = new Map();
  for (const r of (rows || [])) {
    const ts = Number(r.received_ts || 0);
    if (!ts) continue;
    const d = new Date(ts);
    const y = d.getFullYear(), m = d.getMonth() + 1;
    if (!years.has(y)) years.set(y, { year: y, cnt: 0, lastTs: 0, months: new Map() });
    const Y = years.get(y);
    Y.cnt++; if (ts > Y.lastTs) Y.lastTs = ts;
    if (!Y.months.has(m)) Y.months.set(m, { year: y, month: m, cnt: 0, lastTs: 0, mails: [] });
    const M = Y.months.get(m);
    M.cnt++; if (ts > M.lastTs) M.lastTs = ts;
    M.mails.push(r);            // 월을 클릭하면 바로 목록에 뿌릴 수 있게 원본을 달아 둔다
  }
  return [...years.values()]
    .sort((a, b) => b.year - a.year)
    .map(Y => ({
      ...Y,
      months: [...Y.months.values()]
        .sort((a, b) => b.month - a.month)
        .map(M => ({ ...M, mails: M.mails.sort((a, b) => (b.received_ts || 0) - (a.received_ts || 0)) }))
    }));
}

module.exports = { EVENT_RULES, EVENT_ETC, normalizeSubject, classifyEvent, groupByEvent, groupByDate };

// ------------------------------------------------------------
//  셀프체크 — node src/sent-axis.js
// ------------------------------------------------------------
if (require.main === module) {
  const fails = [];
  const eq = (got, want, name) => { if (got !== want) fails.push(`${name}: ${got} ≠ ${want}`); };

  eq(normalizeSubject('RE: [RE]RE: 22K F/D 도면 송부'), '22K F/D 도면 송부', '제목 정규화');
  eq(normalizeSubject('FW: 견적 요청'), '견적 요청', 'FW 제거');
  eq(classifyEvent('RE: 22K F/D 도면 출도 건').key, 'drawing', '도면 분류');
  eq(classifyEvent('견적 요청드립니다').key, 'quote', '견적 분류');
  eq(classifyEvent('PO 발행 건').key, 'order', '발주 분류');
  eq(classifyEvent('코멘트 회신 부탁드립니다').key, 'approval', '승인·검토 분류');
  eq(classifyEvent('킥오프 미팅 일정 안내').key, 'meeting', '회의 분류');
  eq(classifyEvent('주간보고 7월 5주차').key, 'report', '보고 분류');
  eq(classifyEvent('FAT 검사 일정').key, 'test', '검사 분류');   // 검사·시운전이 회의보다 우선인지
  eq(classifyEvent('안녕하세요').key, 'etc', '기타 분류');
  eq(classifyEvent('').key, 'etc', '빈 제목');

  const rows = [
    { id: 1, subject: '견적 요청', received_ts: Date.parse('2026-07-01T00:00:00Z') },
    { id: 2, subject: 'RE: 도면 출도', received_ts: Date.parse('2026-08-01T00:00:00Z') },
    { id: 3, subject: '안부 인사', received_ts: Date.parse('2025-12-01T00:00:00Z') },
    { id: 4, subject: 'FW: 도면 송부', received_ts: Date.parse('2026-08-02T00:00:00Z') }
  ];
  const ev = groupByEvent(rows);
  eq(ev[0].key, 'drawing', '이벤트 묶음 최근순');
  eq(ev[0].cnt, 2, '도면 건수');
  eq(ev[ev.length - 1].key, 'etc', '기타는 마지막');
  eq(ev[0].mails[0].id, 4, '묶음 안 메일 최신순');

  const dt = groupByDate(rows);
  eq(dt[0].year, 2026, '연도 내림차순');
  eq(dt[0].cnt, 3, '2026 건수');
  eq(dt[0].months[0].month, 8, '월 내림차순');
  eq(dt[0].months[0].cnt, 2, '8월 건수');
  eq(dt[0].months[0].mails[0].id, 4, '월 안 메일 최신순');
  eq(dt[1].year, 2025, '이전 연도');
  eq(groupByDate([]).length, 0, '빈 입력');

  if (fails.length) { console.error('sent-axis 셀프체크 실패:\n - ' + fails.join('\n - ')); process.exit(1); }
  console.log(`sent-axis 셀프체크 OK — 제목정규화·이벤트 ${EVENT_RULES.length}종 분류·연월 트리·빈입력 통과`);
}
