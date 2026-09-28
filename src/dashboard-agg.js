// ============================================================
//  dashboard-agg.js — 통합 대시보드 집계 (순수 함수 · 의존성 0)
//  ------------------------------------------------------------
//  · 입력: DB에서 읽은 메일 배열(평범한 객체). DB/Electron/DOM 을 전혀 모른다.
//  · 출력: 화면·HTML·엑셀이 공통으로 쓰는 집계 결과.
//  · 3축: 날짜별 / 프로젝트별 / 테마별(범주·조직·상대)
//  · 팔레트는 SEcMS DashboardTab.tsx 의 VIZ_PALETTE 12색을 그대로 이식하되,
//    WCAG 대비를 맞추기 위해 '채우기 / 테두리 / 글자' 3계열로 분리했다(아래 실측 주석).
//  · 차트는 인라인 SVG 로 직접 그린다(chart.js 등 외부 라이브러리 금지).
//
//  셀프체크: node src/dashboard-agg.js
// ============================================================

// ---- 팔레트 (대비 실측치는 계산기로 검증. contrast() 로 언제든 재검증 가능) ----
//  VIZ_FILL   : 도형 채우기(SEcMS 원본 12색)
//  VIZ_STROKE : 도형 테두리 — 흰 배경 대비 3.04~4.70:1 (WCAG 그래픽 객체 3:1 충족)
//  VIZ_TEXT   : 라벨 글자 — 흰 배경 대비 4.63~5.09:1 (WCAG 본문 4.5:1 충족)
const VIZ_FILL   = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316', '#84cc16', '#6366f1', '#e11d48', '#14b8a6', '#a855f7'];
const VIZ_STROKE = ['#3b82f6', '#0ea674', '#c47e09', '#8b5cf6', '#ec4899', '#059bb4', '#ed6d15', '#6aa312', '#6366f1', '#e11d48', '#12a695', '#a855f7'];
const VIZ_TEXT   = ['#326ed1', '#0b815a', '#9f6707', '#8457ea', '#c93d82', '#047f94', '#bb5610', '#4f7a0d', '#5e61e5', '#e11d48', '#0e8174', '#974cde'];
const pick = (arr, i) => arr[((i % arr.length) + arr.length) % arr.length];
const fillOf = (i) => pick(VIZ_FILL, i);
const strokeOf = (i) => pick(VIZ_STROKE, i);
const textOf = (i) => pick(VIZ_TEXT, i);

// ---- WCAG 상대휘도 / 대비비 (의존성 0, 자가검증용) ----
function relLuminance(hex) {
  const c = String(hex).replace('#', '');
  const v = [0, 2, 4].map(i => parseInt(c.substr(i, 2), 16) / 255)
    .map(x => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function contrast(fg, bg) {
  const a = relLuminance(fg), b = relLuminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// ------------------------------------------------------------
//  공통 헬퍼
// ------------------------------------------------------------
const isoDay = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d)) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const isoMonth = (ts) => isoDay(ts).slice(0, 7);
// ISO 주차(월요일 시작) — 주별 추이용
function isoWeek(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return '';
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const wk = Math.ceil(((t - y0) / 864e5 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`;
}
const dirOf = (m) => (String(m.folder || '') === 'Sent' ? 'sent' : 'recv');
const splitCategories = (raw) => String(raw || '').split(/[;,]/).map(s => s.trim()).filter(Boolean);

// 건수 Map → 정렬된 배열. sortBy='count'(기본) | 'key' | 'last'(최근활동)
function toSorted(map, sortBy = 'count', limit = 0) {
  let arr = [...map.entries()].map(([key, v]) => (typeof v === 'number' ? { key, count: v } : { key, ...v }));
  if (sortBy === 'key') arr.sort((a, b) => String(a.key).localeCompare(String(b.key), 'ko'));
  else if (sortBy === 'last') arr.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  else arr.sort((a, b) => (b.count || 0) - (a.count || 0) || String(a.key).localeCompare(String(b.key), 'ko'));
  return limit > 0 ? arr.slice(0, limit) : arr;
}

// ------------------------------------------------------------
//  축 ①: 날짜별
//   granularity: 'day' | 'week' | 'month'
//   ★ 전역 정렬 원칙에 따라 결과는 항상 '최신이 먼저'다.
//     (SVG 추이 그래프는 시간 흐름이 왼→오른쪽이어야 하므로 series 는 오래된 순으로 따로 준다)
// ------------------------------------------------------------
function byDate(mails, granularity = 'day') {
  const keyOf = granularity === 'month' ? isoMonth : (granularity === 'week' ? isoWeek : isoDay);
  const map = new Map();
  for (const m of mails || []) {
    const k = keyOf(m.received_ts);
    if (!k) continue;
    if (!map.has(k)) map.set(k, { count: 0, sent: 0, recv: 0, attach: 0, lastTs: 0, projects: new Set() });
    const e = map.get(k);
    e.count++;
    if (dirOf(m) === 'sent') e.sent++; else e.recv++;
    if (m.has_attach) e.attach++;
    if ((m.received_ts || 0) > e.lastTs) e.lastTs = m.received_ts || 0;
    if (m.project) e.projects.add(m.project);
  }
  const rows = [...map.entries()]
    .map(([key, e]) => ({ key, count: e.count, sent: e.sent, recv: e.recv, attach: e.attach, lastTs: e.lastTs, projectCount: e.projects.size }))
    .sort((a, b) => String(b.key).localeCompare(String(a.key)));    // 최신 먼저
  return { granularity, rows, series: [...rows].reverse(), total: (mails || []).length };
}

// ------------------------------------------------------------
//  축 ②: 프로젝트별
//   정렬 기본 = 최근 활동 순(마스터: 건수순 금지 — 2년 전 대형 프로젝트가 위로 오면 안 된다)
// ------------------------------------------------------------
function byProject(mails, { sortBy = 'last', limit = 0 } = {}) {
  const map = new Map();
  for (const m of mails || []) {
    const k = m.project || '기타';
    if (!map.has(k)) map.set(k, { count: 0, sent: 0, recv: 0, attach: 0, flagged: 0, lastTs: 0, firstTs: Infinity, orgs: new Set(), people: new Set() });
    const e = map.get(k);
    e.count++;
    if (dirOf(m) === 'sent') e.sent++; else e.recv++;
    if (m.has_attach) e.attach++;
    if (Number(m.flag_status) === 2) e.flagged++;
    const ts = m.received_ts || 0;
    if (ts > e.lastTs) e.lastTs = ts;
    if (ts && ts < e.firstTs) e.firstTs = ts;
    if (m.to_org) e.orgs.add(m.to_org);
    const who = m.sender_email || m.sender_name;
    if (who) e.people.add(String(who).toLowerCase());
  }
  const rows = toSorted(map, sortBy, limit).map(r => ({
    key: r.key, count: r.count, sent: r.sent, recv: r.recv, attach: r.attach, flagged: r.flagged,
    lastTs: r.lastTs, firstTs: r.firstTs === Infinity ? 0 : r.firstTs,
    orgCount: r.orgs.size, peopleCount: r.people.size
  }));
  return { rows, total: rows.reduce((s, r) => s + r.count, 0), projectCount: map.size };
}

// ------------------------------------------------------------
//  축 ③: 테마별 (범주 / 조직 / 상대 / 폴더 중 선택)
//   theme: 'category' | 'org' | 'person' | 'folder'
//   ★ 범주는 한 메일에 여러 개가 붙을 수 있어 '건수 합 > 메일 수' 가 정상이다.
// ------------------------------------------------------------
function byTheme(mails, theme = 'category', { sortBy = 'count', limit = 0 } = {}) {
  const map = new Map();
  const add = (k, m) => {
    if (!k) return;
    if (!map.has(k)) map.set(k, { count: 0, sent: 0, recv: 0, lastTs: 0, projects: new Set() });
    const e = map.get(k);
    e.count++;
    if (dirOf(m) === 'sent') e.sent++; else e.recv++;
    if ((m.received_ts || 0) > e.lastTs) e.lastTs = m.received_ts || 0;
    if (m.project) e.projects.add(m.project);
  };
  for (const m of mails || []) {
    if (theme === 'category') {
      const cats = splitCategories(m.categories);
      if (!cats.length) add('(범주 없음)', m);
      else cats.forEach(c => add(c, m));
    } else if (theme === 'org') add(m.to_org || '(미분류 상대)', m);
    else if (theme === 'person') add(m.sender_name || m.sender_email || '(발신자 없음)', m);
    else add(m.folder || '(폴더 없음)', m);
  }
  const rows = toSorted(map, sortBy, limit).map(r => ({
    key: r.key, count: r.count, sent: r.sent, recv: r.recv, lastTs: r.lastTs, projectCount: r.projects.size
  }));
  return { theme, rows, distinct: map.size, total: rows.reduce((s, r) => s + r.count, 0) };
}

// ------------------------------------------------------------
//  요약 KPI
// ------------------------------------------------------------
function summary(mails, { activeDays = 90 } = {}) {
  const list = mails || [];
  const now = Date.now();
  let sent = 0, recv = 0, attach = 0, flagged = 0, high = 0, unread = 0, withCat = 0;
  const act = { todo: 0, hold: 0, done: 0, fyi: 0, none: 0 };   // 내 처리 상태 집계
  let first = Infinity, last = 0;
  const projects = new Set(), orgs = new Set(), people = new Set(), days = new Set();
  for (const m of list) {
    if (dirOf(m) === 'sent') sent++; else recv++;
    if (m.has_attach) attach++;
    if (Number(m.flag_status) === 2) flagged++;
    if (Number(m.importance) === 2) high++;
    if (m.eff_unread === 1 || (m.eff_unread === undefined && m.unread)) unread++;
    if (splitCategories(m.categories).length) withCat++;
    { const a = String(m.action_state || ''); act[(a === 'todo' || a === 'hold' || a === 'done' || a === 'fyi') ? a : 'none']++; }
    const ts = m.received_ts || 0;
    if (ts) { if (ts < first) first = ts; if (ts > last) last = ts; days.add(isoDay(ts)); }
    if (m.project) projects.add(m.project);
    if (m.to_org) orgs.add(m.to_org);
    const who = m.sender_email || m.sender_name;
    if (who) people.add(String(who).toLowerCase());
  }
  const activeProjects = byProject(list).rows.filter(r => now - r.lastTs <= activeDays * 864e5).length;
  const spanDays = (first === Infinity || !last) ? 0 : Math.max(1, Math.round((last - first) / 864e5) + 1);
  return {
    total: list.length, sent, recv, attach, flagged, high, unread, withCat,
    action: act, actionOpen: act.todo + act.hold,
    projects: projects.size, activeProjects, orgs: orgs.size, people: people.size,
    firstTs: first === Infinity ? 0 : first, lastTs: last,
    activeDays: days.size, spanDays,
    perDay: spanDays ? Math.round((list.length / spanDays) * 10) / 10 : 0
  };
}

// ------------------------------------------------------------
//  프로젝트 × 테마 교차표 (SEcMS systemTypeMatrix 이식)
// ------------------------------------------------------------
function matrix(mails, { rowKey = 'project', colTheme = 'org', topCols = 8, topRows = 12 } = {}) {
  const cells = new Map();      // row → Map(col → n)
  const colTotal = new Map();
  const rowMeta = new Map();    // row → {count,lastTs}
  const colOf = (m) => (colTheme === 'org' ? (m.to_org || '(미분류 상대)')
    : colTheme === 'folder' ? (m.folder || '(폴더 없음)')
      : (splitCategories(m.categories)[0] || '(범주 없음)'));
  for (const m of mails || []) {
    const r = rowKey === 'project' ? (m.project || '기타') : (m.to_org || '(미분류 상대)');
    const c = colOf(m);
    if (!cells.has(r)) cells.set(r, new Map());
    const cm = cells.get(r);
    cm.set(c, (cm.get(c) || 0) + 1);
    colTotal.set(c, (colTotal.get(c) || 0) + 1);
    if (!rowMeta.has(r)) rowMeta.set(r, { count: 0, lastTs: 0 });
    const rm = rowMeta.get(r);
    rm.count++;
    if ((m.received_ts || 0) > rm.lastTs) rm.lastTs = m.received_ts || 0;
  }
  const cols = toSorted(colTotal, 'count', topCols).map(c => c.key);
  const rows = toSorted(rowMeta, 'last', topRows).map(r => ({
    key: r.key, count: r.count, lastTs: r.lastTs,
    values: cols.map(c => (cells.get(r.key) || new Map()).get(c) || 0)
  }));
  const max = Math.max(1, ...rows.flatMap(r => r.values));
  return { rows, cols, max };
}

// ------------------------------------------------------------
//  인라인 SVG 차트 (외부 라이브러리 0 · 브라우저만으로 열리는 단일 HTML 유지)
//  ★ 색만으로 정보를 전달하지 않는다 — 값 라벨을 항상 텍스트로 함께 그린다.
// ------------------------------------------------------------
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// 가로 막대 — 라벨이 길고 항목이 많은 집계에 가장 읽기 좋다
function svgBars(rows, { width = 640, barH = 22, gap = 6, labelW = 190, valueFmt = (v) => v.toLocaleString(), title = '' } = {}) {
  const data = rows || [];
  if (!data.length) return '<div class="dash-empty">데이터가 없습니다.</div>';
  const max = Math.max(1, ...data.map(r => r.count || 0));
  const chartW = width - labelW - 70;
  const h = data.length * (barH + gap) + 8;
  const bars = data.map((r, i) => {
    const y = i * (barH + gap) + 4;
    const w = Math.max(2, Math.round((r.count / max) * chartW));
    return `<g>
      <text x="${labelW - 8}" y="${y + barH * 0.7}" text-anchor="end" class="dash-lbl">${esc(String(r.key).slice(0, 26))}</text>
      <rect x="${labelW}" y="${y}" width="${w}" height="${barH}" rx="3"
            fill="${fillOf(i)}" stroke="${strokeOf(i)}" stroke-width="1"><title>${esc(r.key)}: ${valueFmt(r.count)}</title></rect>
      <text x="${labelW + w + 6}" y="${y + barH * 0.7}" class="dash-val">${esc(valueFmt(r.count))}</text>
    </g>`;
  }).join('');
  return `<svg class="dash-svg" viewBox="0 0 ${width} ${h}" width="100%" height="${h}" role="img"
    aria-label="${esc(title || '막대 그래프')} — ${data.length}개 항목">${bars}</svg>`;
}

// 도넛 — 비중 비교용. 조각 옆에 이름·건수·비율을 글자로 병기한다.
function svgDonut(rows, { size = 200, thickness = 34, title = '' } = {}) {
  const data = (rows || []).filter(r => (r.count || 0) > 0);
  const total = data.reduce((s, r) => s + r.count, 0);
  if (!total) return '<div class="dash-empty">데이터가 없습니다.</div>';
  const cx = size / 2, cy = size / 2, R = size / 2 - 4, r0 = R - thickness;
  let acc = 0;
  const arcs = data.map((row, i) => {
    const frac = row.count / total;
    const a0 = acc * 2 * Math.PI - Math.PI / 2;
    acc += frac;
    const a1 = acc * 2 * Math.PI - Math.PI / 2;
    const large = frac > 0.5 ? 1 : 0;
    const p = (rad, ang) => `${(cx + rad * Math.cos(ang)).toFixed(2)},${(cy + rad * Math.sin(ang)).toFixed(2)}`;
    // 조각이 100% 하나뿐이면 호가 닫히지 않으므로 원 두 개로 그린다
    if (data.length === 1) {
      return `<circle cx="${cx}" cy="${cy}" r="${(R + r0) / 2}" fill="none"
        stroke="${fillOf(i)}" stroke-width="${thickness}"><title>${esc(row.key)}: ${row.count}</title></circle>`;
    }
    return `<path d="M ${p(R, a0)} A ${R} ${R} 0 ${large} 1 ${p(R, a1)} L ${p(r0, a1)} A ${r0} ${r0} 0 ${large} 0 ${p(r0, a0)} Z"
      fill="${fillOf(i)}" stroke="${strokeOf(i)}" stroke-width="1"><title>${esc(row.key)}: ${row.count} (${Math.round(frac * 100)}%)</title></path>`;
  }).join('');
  const legend = data.map((row, i) => `
    <li><span class="dash-swatch" style="background:${fillOf(i)};border-color:${strokeOf(i)}"></span>
      <span class="dash-lg-name">${esc(row.key)}</span>
      <b style="color:${textOf(i)}">${row.count.toLocaleString()}</b>
      <span class="dash-lg-pct">${Math.round((row.count / total) * 100)}%</span></li>`).join('');
  return `<div class="dash-donut-wrap">
    <svg class="dash-svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img"
      aria-label="${esc(title || '비중 도넛')} — 합계 ${total}">${arcs}
      <text x="${cx}" y="${cy - 2}" text-anchor="middle" class="dash-donut-total">${total.toLocaleString()}</text>
      <text x="${cx}" y="${cy + 14}" text-anchor="middle" class="dash-donut-cap">건</text>
    </svg>
    <ul class="dash-legend">${legend}</ul>
  </div>`;
}

// 추이 선그래프 — 시간축은 왼쪽이 과거(series 사용)
function svgTrend(series, { width = 680, height = 170, valueKey = 'count', title = '' } = {}) {
  const data = series || [];
  if (data.length < 2) return svgBars(data.map(d => ({ key: d.key, count: d[valueKey] || 0 })), { title });
  const pad = { l: 44, r: 12, t: 12, b: 26 };
  const max = Math.max(1, ...data.map(d => d[valueKey] || 0));
  const w = width - pad.l - pad.r, h = height - pad.t - pad.b;
  const x = (i) => pad.l + (data.length === 1 ? w / 2 : (i / (data.length - 1)) * w);
  const y = (v) => pad.t + h - (v / max) * h;
  const pts = data.map((d, i) => `${x(i).toFixed(1)},${y(d[valueKey] || 0).toFixed(1)}`).join(' ');
  const area = `${pad.l},${pad.t + h} ${pts} ${(pad.l + w).toFixed(1)},${pad.t + h}`;
  const ticks = [0, 0.5, 1].map(f => {
    const v = Math.round(max * f);
    return `<g><line x1="${pad.l}" y1="${y(v)}" x2="${pad.l + w}" y2="${y(v)}" class="dash-grid"/>
      <text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end" class="dash-axis">${v.toLocaleString()}</text></g>`;
  }).join('');
  const step = Math.max(1, Math.ceil(data.length / 8));
  const xlabels = data.map((d, i) => (i % step === 0 || i === data.length - 1)
    ? `<text x="${x(i)}" y="${height - 8}" text-anchor="middle" class="dash-axis">${esc(String(d.key).slice(5))}</text>` : '').join('');
  const dots = data.map((d, i) => `<circle cx="${x(i)}" cy="${y(d[valueKey] || 0)}" r="2.5" fill="${VIZ_STROKE[0]}">
      <title>${esc(d.key)}: ${(d[valueKey] || 0).toLocaleString()}</title></circle>`).join('');
  return `<svg class="dash-svg" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img"
    aria-label="${esc(title || '추이')} — ${data.length}구간, 최대 ${max}">
    ${ticks}
    <polygon points="${area}" fill="${VIZ_FILL[0]}" opacity="0.14"/>
    <polyline points="${pts}" fill="none" stroke="${VIZ_STROKE[0]}" stroke-width="2"/>
    ${dots}${xlabels}
  </svg>`;
}

// 교차표 히트맵 — 색 농도 + 숫자 병기(색만으로 판단하지 않게)
function svgMatrix(mx, { cellW = 62, cellH = 26, labelW = 150 } = {}) {
  if (!mx || !mx.rows.length || !mx.cols.length) return '<div class="dash-empty">데이터가 없습니다.</div>';
  const width = labelW + mx.cols.length * cellW + 8;
  const height = 34 + mx.rows.length * cellH + 4;
  const head = mx.cols.map((c, j) =>
    `<text x="${labelW + j * cellW + cellW / 2}" y="22" text-anchor="middle" class="dash-lbl">${esc(String(c).slice(0, 9))}</text>`).join('');
  const body = mx.rows.map((r, i) => {
    const y = 34 + i * cellH;
    const cells = r.values.map((v, j) => {
      const a = v ? 0.15 + 0.65 * (v / mx.max) : 0;
      return `<g><rect x="${labelW + j * cellW}" y="${y}" width="${cellW - 2}" height="${cellH - 2}" rx="2"
        fill="${VIZ_FILL[0]}" fill-opacity="${a.toFixed(2)}" stroke="#e5e7eb"/>
        <text x="${labelW + j * cellW + (cellW - 2) / 2}" y="${y + cellH * 0.65}" text-anchor="middle"
          class="dash-cell">${v || ''}</text><title>${esc(r.key)} × ${esc(mx.cols[j])}: ${v}</title></g>`;
    }).join('');
    return `<g><text x="${labelW - 8}" y="${y + cellH * 0.65}" text-anchor="end" class="dash-lbl">${esc(String(r.key).slice(0, 20))}</text>${cells}</g>`;
  }).join('');
  return `<svg class="dash-svg" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img"
    aria-label="프로젝트 교차표 ${mx.rows.length}행 × ${mx.cols.length}열">${head}${body}</svg>`;
}

// ------------------------------------------------------------
//  대시보드 한 판 집계 (화면 · HTML · 엑셀이 같은 결과를 쓴다)
// ------------------------------------------------------------
function buildDashboard(mails, opts = {}) {
  const { granularity = 'day', activeDays = 90, topN = 12 } = opts;
  const list = mails || [];
  return {
    summary: summary(list, { activeDays }),
    date: byDate(list, granularity),
    project: byProject(list, { sortBy: 'last', limit: topN }),
    projectByCount: byProject(list, { sortBy: 'count', limit: topN }),
    category: byTheme(list, 'category', { limit: topN }),
    org: byTheme(list, 'org', { limit: topN }),
    person: byTheme(list, 'person', { limit: topN }),
    folder: byTheme(list, 'folder', { limit: topN }),
    matrix: matrix(list, { rowKey: 'project', colTheme: 'org', topCols: 8, topRows: 12 })
  };
}

module.exports = {
  VIZ_FILL, VIZ_STROKE, VIZ_TEXT, fillOf, strokeOf, textOf,
  relLuminance, contrast,
  isoDay, isoMonth, isoWeek, splitCategories,
  byDate, byProject, byTheme, summary, matrix, buildDashboard,
  svgBars, svgDonut, svgTrend, svgMatrix, esc
};

// ============================================================
//  셀프체크 — `node src/dashboard-agg.js`
// ============================================================
if (require.main === module) {
  const assert = require('assert');
  const D = (s) => Date.parse(s + 'T09:00:00');
  const M = [
    { id: 1, folder: 'Inbox', received_ts: D('2026-08-01'), project: 'KSIT', to_org: '씨스타', sender_email: 'a@x.com', categories: 'MAKER;HULL', has_attach: 1, flag_status: 2, importance: 2 },
    { id: 2, folder: 'Sent', received_ts: D('2026-08-01'), project: 'KSIT', to_org: '씨스타', sender_email: 'me@y.com', categories: 'MAKER', has_attach: 0, flag_status: 0, importance: 1 },
    { id: 3, folder: 'Inbox', received_ts: D('2026-07-31'), project: '22K FD', to_org: '한국야나세', sender_email: 'b@z.com', categories: '', has_attach: 1, flag_status: 0, importance: 1 },
    { id: 4, folder: 'Inbox', received_ts: D('2020-01-05'), project: '옛프로젝트', to_org: '옛조직', sender_email: 'c@w.com', categories: '', has_attach: 0, flag_status: 0, importance: 1 }
  ];

  // ① 날짜 축: 최신 먼저 + series 는 과거 먼저
  const d = byDate(M, 'day');
  assert.strictEqual(d.rows[0].key, '2026-08-01', '날짜 축이 최신순이 아님');
  assert.strictEqual(d.rows[0].count, 2);
  assert.strictEqual(d.rows[0].sent, 1);
  assert.strictEqual(d.rows[0].recv, 1);
  assert.strictEqual(d.series[0].key, '2020-01-05', 'series 는 과거→현재여야 함');
  assert.strictEqual(d.rows.length, 3);

  // ② 프로젝트 축: 기본이 '최근 활동순'이어야 한다(건수순 금지)
  const p = byProject(M);
  assert.strictEqual(p.rows[0].key, 'KSIT', '프로젝트가 최근 활동순이 아님');
  assert.strictEqual(p.rows[p.rows.length - 1].key, '옛프로젝트', '오래된 프로젝트가 뒤로 가지 않음');
  assert.strictEqual(p.rows[0].count, 2);
  assert.strictEqual(p.rows[0].flagged, 1);
  assert.strictEqual(p.projectCount, 3);

  // ③ 테마 축: 범주는 다중 부여 → 합이 메일 수보다 클 수 있다
  const c = byTheme(M, 'category');
  const cMap = Object.fromEntries(c.rows.map(r => [r.key, r.count]));
  assert.strictEqual(cMap['MAKER'], 2);
  assert.strictEqual(cMap['HULL'], 1);
  assert.strictEqual(cMap['(범주 없음)'], 2, '범주 없는 메일이 집계에서 빠짐');

  // ④ 요약 KPI
  const s = summary(M, { activeDays: 90 });
  assert.strictEqual(s.total, 4);
  assert.strictEqual(s.sent, 1);
  assert.strictEqual(s.recv, 3);
  assert.strictEqual(s.flagged, 1);
  assert.strictEqual(s.high, 1);
  assert.strictEqual(s.projects, 3);
  assert.ok(s.activeProjects >= 0 && s.activeProjects <= 3);

  // ⑤ 교차표
  const mx = matrix(M, { rowKey: 'project', colTheme: 'org' });
  assert.ok(mx.cols.includes('씨스타'));
  assert.strictEqual(mx.rows[0].key, 'KSIT');
  assert.strictEqual(mx.rows[0].values[mx.cols.indexOf('씨스타')], 2);

  // ⑥ 빈 입력에서 죽지 않아야 한다
  assert.strictEqual(byDate([]).rows.length, 0);
  assert.strictEqual(summary([]).total, 0);
  assert.ok(svgBars([]).includes('데이터가 없습니다'));
  assert.ok(svgDonut([]).includes('데이터가 없습니다'));
  assert.ok(buildDashboard([]).summary.total === 0);

  // ⑦ SVG 는 외부 라이브러리 없이 문자열로 완성돼야 한다
  const bars = svgBars(p.rows);
  assert.ok(bars.startsWith('<svg') && bars.includes('</svg>'), 'svgBars 출력이 SVG 가 아님');
  assert.ok(svgDonut(c.rows).includes('<svg'), 'svgDonut 출력에 SVG 없음');
  assert.ok(svgTrend(d.series).includes('<svg'), 'svgTrend 출력에 SVG 없음');
  assert.ok(svgMatrix(mx).includes('<svg'), 'svgMatrix 출력에 SVG 없음');
  // XSS 방어: 제목에 태그가 들어가도 그대로 나가면 안 된다
  assert.ok(!svgBars([{ key: '<script>x</script>', count: 1 }]).includes('<script>'), 'SVG 라벨 이스케이프 누락');

  // ⑧ 팔레트 대비 (WCAG) — 실패하면 색을 고쳐야 한다
  let strokeMin = 99, textMin = 99;
  for (let i = 0; i < VIZ_FILL.length; i++) {
    strokeMin = Math.min(strokeMin, contrast(VIZ_STROKE[i], '#ffffff'));
    textMin = Math.min(textMin, contrast(VIZ_TEXT[i], '#ffffff'));
  }
  assert.ok(strokeMin >= 3.0, `테두리 색 대비 미달: ${strokeMin.toFixed(2)}:1 (3:1 필요)`);
  assert.ok(textMin >= 4.5, `라벨 글자 대비 미달: ${textMin.toFixed(2)}:1 (4.5:1 필요)`);
  assert.ok(contrast('#1a1a1a', '#ffffff') > 15);

  console.log(`dashboard-agg 셀프체크 OK — 집계 3축·요약·교차표·SVG 4종·빈입력·XSS·대비 통과 ` +
    `(테두리 최소 ${strokeMin.toFixed(2)}:1 · 라벨 최소 ${textMin.toFixed(2)}:1)`);
}
