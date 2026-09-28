// ============================================================
//  일정 추출 엔진 (단일 책임: 텍스트 → 날짜 · 저장된 분석 → 일정 후보)
//   ★ 새 AI 호출을 하지 않는다. 이미 저장된 analyses 결과에서만 수집한다.
//   DB 접근·저장은 db.js 가 담당하고, 이 파일은 순수 함수만 제공한다.
// ============================================================

// AI 응답에는 유니코드 하이픈(‑ ‒ – — ―)과 전각 숫자가 섞여 들어온다.
// 정규화하지 않으면 '2026‑08‑04' 같은 날짜를 통째로 놓친다(실측).
function normalizeText(s) {
  return String(s || '')
    .replace(/[‐‑‒–—―﹘﹣－]/g, '-')
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/ /g, ' ')
    .trim();
}

const pad2 = (n) => String(n).padStart(2, '0');
const toISO = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

function parseAnchor(anchor) {
  if (anchor instanceof Date) return new Date(anchor.getTime());
  const s = normalizeText(anchor);
  const m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  const d = s ? new Date(s) : new Date();
  return isNaN(d.getTime()) ? new Date() : d;
}

function addDays(d, n) { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }

// 시각 추출: '11:00', '11시', '오후 3시'
function parseTime(s) {
  const pm = /오후|저녁|PM/i.test(s), am = /오전|아침|AM/i.test(s);
  let m = s.match(/(\d{1,2})\s*:\s*(\d{2})/);
  if (!m) {
    const h = s.match(/(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?/);
    if (h) m = [h[0], h[1], h[2] || '00'];
  }
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (hh > 23 || mm > 59) return null;
  if (pm && hh < 12) hh += 12;
  if (am && hh === 12) hh = 0;
  return `${pad2(hh)}:${pad2(mm)}`;
}

// ------------------------------------------------------------
//  기한 문자열 → { date:'YYYY-MM-DD', time:'HH:MM'|null }
//   anchor = 그 분석이 만들어진 기준일. '내일'·'금주' 같은 상대 표현에 필요하다.
//   해석 불가면 null (억지로 오늘 날짜를 붙이지 않는다 — 달력이 오염된다).
// ------------------------------------------------------------
function parseDue(text, anchor) {
  const s = normalizeText(text);
  if (!s) return null;
  const base = parseAnchor(anchor);
  const time = parseTime(s);
  const mk = (d) => ({ date: toISO(d), time });

  // 1) 절대 날짜: 2026-08-04 / 2026.8.4 / 2026/8/4
  let m = s.match(/(\d{4})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})/);
  if (m) return mk(new Date(+m[1], +m[2] - 1, +m[3]));

  // 2) 한국어 절대: 2026년 8월 4일 / 8월 4일
  m = s.match(/(?:(\d{4})\s*년\s*)?(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  if (m) {
    const y = m[1] ? +m[1] : base.getFullYear();
    const d = new Date(y, +m[2] - 1, +m[3]);
    // 연도 생략 + 이미 지난 달이면 내년으로 (예: 12월 기준 '1월 5일')
    if (!m[1] && d.getTime() < base.getTime() - 180 * 864e5) d.setFullYear(y + 1);
    return mk(d);
  }

  // 3) 연도 없는 슬래시: 7/31
  //  ponytail: '수량 1/2' 같은 분수와 구분이 필요하다. 일자가 13 이상이거나
  //  문장에 기한을 뜻하는 낱말이 있을 때만 날짜로 본다(그 외는 버린다 — 달력 오염 방지).
  m = s.match(/(?:^|[\s(])(\d{1,2})\s*\/\s*(\d{1,2})(?![\d/])/);
  if (m) {
    const mo = +m[1], dd = +m[2];
    const dateish = dd >= 13 || /까지|마감|기한|제출|납기|예정|일자|회의|미팅|due|deadline/i.test(s);
    if (dateish && mo >= 1 && mo <= 12 && dd >= 1 && dd <= 31) {
      const d = new Date(base.getFullYear(), mo - 1, dd);
      if (d.getTime() < base.getTime() - 180 * 864e5) d.setFullYear(base.getFullYear() + 1);
      return mk(d);
    }
  }

  // 4) 상대 표현
  if (/오늘|금일|당일/.test(s)) return mk(base);
  if (/내일|익일|명일/.test(s)) return mk(addDays(base, 1));
  if (/모레|내일모레/.test(s)) return mk(addDays(base, 2));
  if (/이번\s*주|금주|주중/.test(s)) {                    // 이번 주 금요일로 본다
    const dow = base.getDay();                            // 0=일
    const toFri = ((5 - dow) + 7) % 7;
    return mk(addDays(base, toFri || (dow === 5 ? 0 : 7)));
  }
  if (/다음\s*주|차주|내주/.test(s)) return mk(addDays(base, 7));
  if (/이번\s*달|금월|월말/.test(s)) return mk(new Date(base.getFullYear(), base.getMonth() + 1, 0));
  m = s.match(/(\d{1,2})\s*일\s*(?:후|뒤|내)/);
  if (m) return mk(addDays(base, +m[1]));

  return null;
}

// 제목 정규화 — 같은 일정이 표현만 달리해 중복 저장되는 것을 막는다
function normalizeTitle(t) {
  return normalizeText(t).toLowerCase()
    .replace(/[\s·,.:;!?~"'`()[\]{}<>/\\|-]+/g, '')
    .slice(0, 60);
}

function clean(v) { return normalizeText(v).replace(/\s+/g, ' ').slice(0, 300); }

// AI 가 빈 항목 자리에 넣는 상투어 — 달력에 올리면 소음만 된다
function isEmptyTask(t) {
  const x = String(t || '').trim();
  if (x.length < 3) return true;
  // ★ 상투어가 '단독'일 때만 버린다. 접두 매칭으로 하면 '미확정 사양 확정 회신' 같은
  //   실제 업무까지 사라진다(실측). 뒤에는 괄호 주석·마침표 정도만 허용.
  return /^(없음|미정|미확정|해당\s*없음|없습니다|특이사항\s*없음|n\/?a|none|tbd)\s*(\([^)]*\))?\s*[.!]?$/i.test(x);
}

// ------------------------------------------------------------
//  저장된 analyses 한 행 → 일정 후보 목록
//   rows: { id, kind, mail_id, content, json, created_at }
//   지원: translate(actions) · daily(todos) · worklog(openItems/days.pending)
// ------------------------------------------------------------
function extractFromAnalysis(row) {
  const out = [];
  if (!row || !row.content) return out;
  let data;
  try { data = JSON.parse(row.content); } catch (_) { return out; }   // 마크다운 브리핑은 대상 아님
  if (!data || typeof data !== 'object') return out;

  let meta = {};
  try { meta = row.json ? JSON.parse(row.json) : {}; } catch (_) {}
  // 기준일: 분석 메타의 date > 분석 생성일
  const anchor = meta.date || data.date || row.created_at || new Date();

  const push = (task, due, owner, kind) => {
    const title = clean(task);
    if (!title || isEmptyTask(title)) return;
    const d = parseDue(due, anchor);
    if (!d) return;                       // 날짜를 못 읽으면 달력에 올리지 않는다
    out.push({
      title, date: d.date, time: d.time || null,
      owner: clean(owner), source_kind: kind, source_id: row.id,
      mail_id: row.mail_id || null, raw_due: clean(due)
    });
  };

  // 메일 분석의 할 일
  (Array.isArray(data.actions) ? data.actions : []).forEach(a => push(a.task, a.due, a.owner, 'action'));
  // 일일 요약의 할 일
  (Array.isArray(data.todos) ? data.todos : []).forEach(t => push(t.task, t.due, t.owner, 'todo'));
  // 업무일지 미결
  (Array.isArray(data.openItems) ? data.openItems : []).forEach(o => push(o.task, o.due, o.owner, 'open'));
  // 업무일지 일자별 미결(그 날짜가 곧 기한)
  (Array.isArray(data.days) ? data.days : []).forEach(d => {
    (Array.isArray(d.pending) ? d.pending : []).forEach(p => {
      const t = clean(p);
      if (!t || /^없음/.test(t)) return;      // AI 가 '없음 (skip)' 을 넣는 경우가 있다
      push(t, d.date, '', 'open');
    });
  });
  // 메일 분석의 핵심 사실 중 날짜성 항목(납기일·마감일 등)
  (Array.isArray(data.keyFacts) ? data.keyFacts : []).forEach(f => {
    const label = clean(f && f.label);
    if (!/납기|마감|기한|제출|완료일|예정일|due|deadline/i.test(label)) return;
    push(label, f && f.value, '', 'fact');
  });
  return out;
}

// 중복 병합: 같은 메일·같은 날짜·유사 제목이면 1건
function dedupe(items) {
  const seen = new Map();
  for (const it of items) {
    const key = `${it.mail_id || 0}|${it.date}|${normalizeTitle(it.title)}`;
    const prev = seen.get(key);
    // 시각 정보가 있는 쪽을 남긴다
    if (!prev || (!prev.time && it.time)) seen.set(key, it);
  }
  return [...seen.values()];
}

// --- 셀프체크: 파서가 깨지면 즉시 실패한다(프레임워크 없음) ---
function selfTest() {
  const A = '2026-07-30';
  const eq = (got, want, label) => {
    const g = got ? `${got.date}${got.time ? ' ' + got.time : ''}` : 'null';
    if (g !== want) throw new Error(`parseDue 회귀: ${label} → ${g} (기대 ${want})`);
  };
  eq(parseDue('내일 11:00까지 제출', A), '2026-07-31 11:00', '내일+시각');
  eq(parseDue('2026‑08‑04', A), '2026-08-04', '유니코드 하이픈');
  eq(parseDue('8월 4일 오후 3시', A), '2026-08-04 15:00', '한국어 날짜+오후');
  eq(parseDue('7/31', A), '2026-07-31', '슬래시');
  eq(parseDue('금주 내', A), '2026-07-31', '금주=이번주 금요일');
  eq(parseDue('', A), 'null', '빈 값');
  eq(parseDue('수량 1/2 확인', A), 'null', '분수 오탐 방지');
  eq(parseDue('8/4 까지 제출', A), '2026-08-04', '슬래시+기한 낱말');
  return true;
}

module.exports = { parseDue, parseTime, normalizeText, normalizeTitle, extractFromAnalysis, dedupe, selfTest };
