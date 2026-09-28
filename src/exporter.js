// ============================================================
//  exporter.js — 산출물 생성 (통합 대시보드 HTML 1개 + 엑셀)
//  ------------------------------------------------------------
//  책임 범위(단일 책임):
//   · 집계는 dashboard-agg.js 가 한다. 이 파일은 '파일로 떨구는 일'만 한다.
//   · 대시보드는 파일을 늘리지 않는다 — 항상 같은 이름의 HTML 1개를 덮어쓴다.
//     (기존 index.html / projects/*.html / 매뉴얼.html 을 이 한 장이 흡수)
//   · 차트는 dashboard-agg 의 인라인 SVG. 외부 라이브러리·CDN·이미지 0 →
//     브라우저로 파일만 열면 그대로 보이고, 오프라인에서도 동작한다.
//   · 엑셀은 이미 설치돼 있는 xlsx(SheetJS)로 .xlsx 를 쓴다(새 의존성 0).
// ============================================================
const fs = require('fs');
const path = require('path');
const os = require('os');
const agg = require('./dashboard-agg');

const esc = agg.esc;

// 저장 루트 (설정 미지정 시 문서\Bmail)
function defaultRoot() {
  return path.join(os.homedir(), 'Documents', 'Bmail');
}
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function resolveRoot(configuredRoot) {
  const root = String(configuredRoot || '').trim() || defaultRoot();
  return ensureDir(root);
}

const fmtTs = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fmtDay = (ts) => fmtTs(ts).slice(0, 10);

// ============================================================
//  1) 통합 대시보드 HTML (단일 파일 · 의존성 0)
// ============================================================
//  대비 실측(WCAG 2.1):
//    본문 #1a1a1a on #ffffff = 16.63:1 · 보조 #4b5563 on #ffffff = 7.56:1
//    카드 #1a1a1a on #f8fafc = 15.93:1 · 링크 #1d4ed8 on #ffffff = 7.06:1
//    표 헤더 #1a1a1a on #eef2f7 = 14.66:1 · 강조 #0b4f8a on #eef6fd = 7.60:1
//   → 전부 본문 기준 4.5:1 이상. 팔레트는 dashboard-agg 셀프체크가 매 빌드 검증한다.
const DASH_CSS = `
:root{--bg:#ffffff;--surface:#f8fafc;--text:#1a1a1a;--muted:#4b5563;--line:#e5e7eb;--accent:#1d4ed8;--chip:#eef6fd;--chipfg:#0b4f8a;}
*{box-sizing:border-box;}
body{margin:0;background:var(--bg);color:var(--text);font-size:14px;line-height:1.6;
  font-family:'Malgun Gothic','맑은 고딕','Noto Sans KR','Microsoft YaHei',system-ui,sans-serif;}
.wrap{max-width:1180px;margin:0 auto;padding:24px 20px 60px;}
h1{font-size:22px;margin:0 0 4px;}
h2{font-size:16px;margin:30px 0 10px;padding-bottom:6px;border-bottom:2px solid var(--line);}
h3{font-size:13.5px;margin:0 0 8px;color:var(--muted);}
.sub{color:var(--muted);font-size:12.5px;margin:0 0 18px;}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:10px;margin:14px 0 6px;}
.kpi{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:12px 14px;}
.kpi b{display:block;font-size:21px;line-height:1.25;font-variant-numeric:tabular-nums;}
.kpi span{font-size:11.5px;color:var(--muted);}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:16px;}
.card{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:14px 16px;overflow:auto;}
.card.wide{grid-column:1/-1;}
table{border-collapse:collapse;width:100%;font-size:12.5px;}
th,td{border:1px solid var(--line);padding:5px 8px;text-align:left;vertical-align:top;}
th{background:#eef2f7;font-weight:700;position:sticky;top:0;z-index:1;}
/* 행이 많은 표는 표 안에서만 스크롤시켜 페이지 길이를 일정하게 유지한다 */
.tbl-scroll{max-height:420px;overflow:auto;border:1px solid var(--line);border-radius:6px;}
.tbl-scroll table{border-collapse:separate;border-spacing:0;}
.tbl-scroll th,.tbl-scroll td{border:0;border-bottom:1px solid var(--line);}
/* 목차 — 3축 사이를 바로 오갈 수 있게 */
.toc{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);
  padding:8px 0;margin:0 0 6px;display:flex;gap:8px;flex-wrap:wrap;z-index:5;}
.toc a{color:var(--accent);text-decoration:none;font-size:12.5px;font-weight:700;
  background:var(--surface);border:1px solid var(--line);border-radius:5px;padding:4px 10px;}
.toc a:hover{background:#eef6fd;text-decoration:underline;}
h2{scroll-margin-top:52px;}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;}
tbody tr:nth-child(even){background:#fbfcfd;}
.dash-empty{color:var(--muted);font-size:12.5px;padding:14px 0;}
.dash-svg{display:block;max-width:100%;}
.dash-lbl{font-size:11px;fill:var(--text);}
.dash-val{font-size:11px;fill:var(--muted);font-variant-numeric:tabular-nums;}
.dash-axis{font-size:10px;fill:var(--muted);}
.dash-cell{font-size:10.5px;fill:var(--text);font-variant-numeric:tabular-nums;}
.dash-grid{stroke:var(--line);stroke-width:1;}
.dash-donut-total{font-size:19px;font-weight:800;fill:var(--text);}
.dash-donut-cap{font-size:10px;fill:var(--muted);}
.dash-donut-wrap{display:flex;gap:16px;align-items:center;flex-wrap:wrap;}
.dash-legend{list-style:none;margin:0;padding:0;font-size:12px;flex:1;min-width:170px;}
.dash-legend li{display:flex;align-items:center;gap:6px;padding:1.5px 0;}
.dash-swatch{width:11px;height:11px;border-radius:2px;border:1px solid;flex:0 0 auto;}
.dash-lg-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dash-lg-pct{color:var(--muted);font-variant-numeric:tabular-nums;}
.chip{display:inline-block;background:var(--chip);color:var(--chipfg);font-size:11px;font-weight:700;
  padding:1px 7px;border-radius:3px;margin-right:5px;}
.toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:10px 0 4px;}
.toolbar input,.toolbar select{font:inherit;font-size:12.5px;padding:5px 8px;border:1px solid var(--line);
  border-radius:5px;background:var(--bg);color:var(--text);}
.toolbar input{min-width:220px;}
.hitcount{color:var(--muted);font-size:12px;}
.foot{margin-top:34px;padding-top:12px;border-top:1px solid var(--line);color:var(--muted);font-size:11.5px;}
tr.hidden-row{display:none;}
@media print{.toolbar{display:none;} .card{break-inside:avoid;} body{font-size:11px;}}
@media (max-width:640px){.dash-donut-wrap{flex-direction:column;align-items:flex-start;}}
`;

// 필터·검색 (의존성 0 · 인라인 스크립트). 표의 행을 텍스트로 걸러낸다.
const DASH_JS = `
(function(){
  function bind(box){
    var q = box.querySelector('[data-q]');
    var table = box.querySelector('table');
    var out = box.querySelector('[data-hits]');
    if(!q || !table) return;
    function run(){
      var v = q.value.trim().toLowerCase();
      var rows = table.tBodies[0] ? table.tBodies[0].rows : [];
      var n = 0;
      for (var i=0;i<rows.length;i++){
        var hit = !v || rows[i].textContent.toLowerCase().indexOf(v) !== -1;
        rows[i].classList.toggle('hidden-row', !hit);
        if (hit) n++;
      }
      if (out) out.textContent = n.toLocaleString() + '건 표시';
    }
    q.addEventListener('input', run);
    run();
  }
  document.querySelectorAll('[data-filterbox]').forEach(bind);
  // 표 헤더 클릭 정렬 (숫자열은 수치, 그 외는 문자열). 기본은 서버 정렬(날짜/최근활동)을 그대로 둔다.
  document.querySelectorAll('table[data-sortable] th').forEach(function(th, idx){
    th.style.cursor='pointer'; th.title='클릭하면 이 열로 정렬합니다';
    th.addEventListener('click', function(){
      var t = th.closest('table'), tb = t.tBodies[0];
      var rows = Array.prototype.slice.call(tb.rows);
      var num = th.classList.contains('num');
      var dir = th.dataset.dir === 'asc' ? -1 : 1;
      t.querySelectorAll('th').forEach(function(x){ delete x.dataset.dir; });
      th.dataset.dir = dir === 1 ? 'asc' : 'desc';
      rows.sort(function(a,b){
        var x=a.cells[idx]?a.cells[idx].textContent.trim():'', y=b.cells[idx]?b.cells[idx].textContent.trim():'';
        if(num){ return (parseFloat(x.replace(/[^0-9.\\-]/g,''))||0) - (parseFloat(y.replace(/[^0-9.\\-]/g,''))||0) === 0 ? 0
          : ((parseFloat(x.replace(/[^0-9.\\-]/g,''))||0) < (parseFloat(y.replace(/[^0-9.\\-]/g,''))||0) ? -dir : dir); }
        return x.localeCompare(y,'ko') * dir;
      });
      rows.forEach(function(r){ tb.appendChild(r); });
    });
  });
})();
`;

function kpi(label, value, hint) {
  return `<div class="kpi"><b>${typeof value === 'number' ? value.toLocaleString() : esc(value)}</b>
    <span>${esc(label)}${hint ? ` · ${esc(hint)}` : ''}</span></div>`;
}

// 집계 표 (검색 + 열 정렬 포함)
//  ★ 행이 많으면 표 안에서만 스크롤시킨다. 그렇게 하지 않으면 날짜별 1,925행이 페이지를 삼켜
//    프로젝트·테마 축까지 스크롤이 수십 페이지가 된다(실측 확인).
function aggTable(id, rows, cols, { searchable = true, scrollAfter = 25 } = {}) {
  if (!rows || !rows.length) return '<div class="dash-empty">데이터가 없습니다.</div>';
  const head = cols.map(c => `<th class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`).join('');
  const body = rows.map(r => `<tr>${cols.map(c => {
    const v = c.get(r);
    return `<td class="${c.num ? 'num' : ''}">${esc(typeof v === 'number' ? v.toLocaleString() : v)}</td>`;
  }).join('')}</tr>`).join('');
  const bar = searchable
    ? `<div class="toolbar"><input data-q type="search" placeholder="이 표에서 검색 (이름·프로젝트·조직)" />
       <span class="hitcount" data-hits>${rows.length.toLocaleString()}건 표시</span></div>` : '';
  const tbl = `<table data-sortable><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  const wrapped = rows.length > scrollAfter ? `<div class="tbl-scroll">${tbl}</div>` : tbl;
  return `<div data-filterbox id="${esc(id)}">${bar}${wrapped}</div>`;
}

// ---- 대시보드 HTML 본문 ----
function dashboardHtml(data, meta = {}) {
  const s = data.summary;
  const gname = { day: '일별', week: '주별', month: '월별' }[data.date.granularity] || '일별';
  const period = s.total
    ? `${fmtDay(s.firstTs)} ~ ${fmtDay(s.lastTs)} (${s.spanDays.toLocaleString()}일 · 활동 ${s.activeDays.toLocaleString()}일)`
    : '데이터 없음';

  const dateCols = [
    { label: '날짜', get: r => r.key }, { label: '전체', num: true, get: r => r.count },
    { label: '받음', num: true, get: r => r.recv }, { label: '보냄', num: true, get: r => r.sent },
    { label: '첨부', num: true, get: r => r.attach }, { label: '프로젝트', num: true, get: r => r.projectCount }
  ];
  const projCols = [
    { label: '프로젝트', get: r => r.key }, { label: '마지막 활동', get: r => fmtDay(r.lastTs) },
    { label: '전체', num: true, get: r => r.count }, { label: '받음', num: true, get: r => r.recv },
    { label: '보냄', num: true, get: r => r.sent }, { label: '첨부', num: true, get: r => r.attach },
    { label: '깃발', num: true, get: r => r.flagged }, { label: '조직', num: true, get: r => r.orgCount }
  ];
  const themeCols = (name) => [
    { label: name, get: r => r.key }, { label: '마지막 활동', get: r => fmtDay(r.lastTs) },
    { label: '건수', num: true, get: r => r.count }, { label: '받음', num: true, get: r => r.recv },
    { label: '보냄', num: true, get: r => r.sent }, { label: '프로젝트', num: true, get: r => r.projectCount }
  ];

  const matrixTable = data.matrix.rows.length ? `
    <table data-sortable><thead><tr><th>프로젝트</th>${data.matrix.cols.map(c => `<th class="num">${esc(c)}</th>`).join('')}<th class="num">합계</th></tr></thead>
    <tbody>${data.matrix.rows.map(r => `<tr><td>${esc(r.key)}</td>${
      r.values.map(v => `<td class="num">${v ? v.toLocaleString() : ''}</td>`).join('')}<td class="num">${r.count.toLocaleString()}</td></tr>`).join('')}</tbody></table>`
    : '<div class="dash-empty">데이터가 없습니다.</div>';

  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Bmail 통합 대시보드 — ${esc(fmtDay(Date.now()))}</title>
<style>${DASH_CSS}</style></head>
<body><div class="wrap">
<h1>Bmail 통합 대시보드</h1>
<p class="sub">생성 ${esc(fmtTs(Date.now()))} · 대상 ${s.total.toLocaleString()}건 · 기간 ${esc(period)}
${meta.scopeLabel ? ` · 범위 <span class="chip">${esc(meta.scopeLabel)}</span>` : ''}</p>
<nav class="toc" aria-label="대시보드 목차">
  <a href="#ax-date">축 ① 날짜별</a>
  <a href="#ax-project">축 ② 프로젝트별</a>
  <a href="#ax-theme">축 ③ 테마별</a>
</nav>

<div class="kpis">
  ${kpi('전체 메일', s.total)}
  ${kpi('받은 메일', s.recv)}
  ${kpi('보낸 메일', s.sent)}
  ${kpi('진행 중 프로젝트', s.activeProjects, `전체 ${s.projects}`)}
  ${kpi('상대 조직', s.orgs)}
  ${kpi('첨부 있는 메일', s.attach)}
  ${kpi('깃발(후속 작업)', s.flagged)}
  ${kpi('중요도 높음', s.high)}
  ${kpi('하루 평균', s.perDay)}
  ${kpi('내 할 일', (s.action && s.action.todo) || 0, `보류 ${(s.action && s.action.hold) || 0}`)}
  ${kpi('처리 완료', (s.action && s.action.done) || 0, `확인만 ${(s.action && s.action.fyi) || 0}`)}
</div>

<h2 id="ax-date">축 ① 날짜별 — ${esc(gname)} 추이</h2>
<div class="cards">
  <div class="card wide"><h3>${esc(gname)} 메일 건수 (왼쪽이 과거)</h3>
    ${agg.svgTrend(data.date.series, { title: `${gname} 추이` })}</div>
  <div class="card wide"><h3>${esc(gname)} 상세 (최신순)</h3>
    ${aggTable('t-date', data.date.rows, dateCols)}</div>
</div>

<h2 id="ax-project">축 ② 프로젝트별 — 최근 활동순</h2>
<div class="cards">
  <div class="card"><h3>프로젝트 비중 (상위)</h3>${agg.svgDonut(data.projectByCount.rows.slice(0, 10), { title: '프로젝트 비중' })}</div>
  <div class="card"><h3>프로젝트 건수 (상위)</h3>${agg.svgBars(data.projectByCount.rows.slice(0, 10), { title: '프로젝트 건수' })}</div>
  <div class="card wide"><h3>프로젝트 상세 — 마지막 활동이 최근인 순서</h3>
    ${aggTable('t-proj', data.project.rows, projCols)}</div>
  <div class="card wide"><h3>프로젝트 × 상대 조직 교차표</h3>
    ${agg.svgMatrix(data.matrix)}
    ${matrixTable}</div>
</div>

<h2 id="ax-theme">축 ③ 테마별 — 범주 · 조직 · 상대 · 폴더</h2>
<div class="cards">
  <div class="card"><h3>범주(Outlook Categories)</h3>${agg.svgDonut(data.category.rows.slice(0, 10), { title: '범주 비중' })}</div>
  <div class="card"><h3>상대 조직</h3>${agg.svgBars(data.org.rows.slice(0, 10), { title: '상대 조직' })}</div>
  <div class="card wide"><h3>범주 상세</h3>${aggTable('t-cat', data.category.rows, themeCols('범주'))}</div>
  <div class="card wide"><h3>상대 조직 상세</h3>${aggTable('t-org', data.org.rows, themeCols('조직'))}</div>
  <div class="card wide"><h3>주고받은 상대 상세</h3>${aggTable('t-person', data.person.rows, themeCols('상대'))}</div>
  <div class="card wide"><h3>폴더 상세</h3>${aggTable('t-folder', data.folder.rows, themeCols('폴더'))}</div>
</div>

<div class="foot">
  Bmail 통합 대시보드 · 이 파일 하나만 있으면 브라우저에서 그대로 열립니다(외부 라이브러리·인터넷 연결 불필요).<br>
  차트는 인라인 SVG 이며, 각 표는 검색어 입력과 열 제목 클릭 정렬을 지원합니다. 인쇄하면 검색창은 빠집니다.<br>
  Outlook 원본 데이터는 읽기만 했고 어떤 변경도 하지 않았습니다.
</div>
</div><script>${DASH_JS}</script></body></html>`;
}

// 대시보드 저장 — 항상 같은 파일 1개를 덮어쓴다(산출물 개수 증가 0)
function writeDashboard(mails, { root, granularity = 'day', activeDays = 90, topN = 12, scopeLabel = '', fileName = '대시보드.html' } = {}) {
  const dir = resolveRoot(root);
  const data = agg.buildDashboard(mails, { granularity, activeDays, topN });
  const html = dashboardHtml(data, { scopeLabel });
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, html, 'utf8');
  return { ok: true, file, dir, bytes: Buffer.byteLength(html, 'utf8'), mails: (mails || []).length, summary: data.summary };
}

// ============================================================
//  2) 엑셀 내보내기 (.xlsx · 여러 시트 · 새 의존성 0)
// ============================================================
//  메일 목록 표준 컬럼 — 마스터 지정 순서 그대로.
const MAIL_COLUMNS = [
  { key: '날짜', get: m => m.received_at || fmtTs(m.received_ts) },
  { key: '방향', get: m => (String(m.folder || '') === 'Sent' ? '보냄' : '받음') },
  { key: '발신자', get: m => m.sender_name || m.sender_email || '' },
  { key: '수신자', get: m => m.recipients || '' },
  { key: '제목', get: m => m.subject || '' },
  { key: '프로젝트', get: m => m.project || '기타' },
  { key: '조직', get: m => m.to_org || '' },
  { key: '폴더', get: m => m.folder || '' },
  { key: '첨부수', get: m => Number(m.real_attach_count != null ? m.real_attach_count : (m.attach_count || 0)) || 0 },
  { key: '회신여부', get: m => (m.replied === undefined ? '' : (m.replied ? '회신함' : '미회신')) },
  { key: '범주', get: m => m.categories || '' },
  { key: '중요도', get: m => (Number(m.importance) === 2 ? '높음' : (Number(m.importance) === 0 ? '낮음' : '')) },
  { key: '깃발', get: m => (Number(m.flag_status) === 2 ? '표시됨' : (Number(m.flag_status) === 1 ? '완료' : '')) },
  { key: '기한', get: m => m.task_due || '' },
  // 내 처리 상태 (할일/보류/처리/확인)
  { key: '내처리', get: m => ({ todo: '할 일', hold: '보류', done: '처리', fyi: '확인' })[m.action_state] || '' },
  { key: '처리메모', get: m => m.action_note || '' },
  { key: '처리기한', get: m => m.action_due || '' }
];

function mailsToRows(mails) {
  return (mails || []).map(m => {
    const o = {};
    for (const c of MAIL_COLUMNS) o[c.key] = c.get(m);
    return o;
  });
}

// 시트 하나 만들기 (헤더 순서 고정 + 열 너비 자동)
function makeSheet(XLSX, rows, header) {
  const cols = header || (rows.length ? Object.keys(rows[0]) : ['(데이터 없음)']);
  const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{}], { header: cols });
  ws['!cols'] = cols.map(c => {
    const maxLen = rows.reduce((n, r) => Math.max(n, String(r[c] == null ? '' : r[c]).length), String(c).length);
    return { wch: Math.min(60, Math.max(8, maxLen + 2)) };
  });
  ws['!autofilter'] = { ref: ws['!ref'] };
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  return ws;
}

// 엑셀 시트명 제약: 31자 이내 · : \ / ? * [ ] 금지 · 중복 불가
function safeSheetName(name, used) {
  let s = String(name || 'Sheet').replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || 'Sheet';
  let n = 1;
  const base = s;
  while (used.has(s)) { const suf = `(${++n})`; s = base.slice(0, 31 - suf.length) + suf; }
  used.add(s);
  return s;
}

//  sheets: [{ name, rows, header? }]
function writeExcel(sheets, { root, fileName } = {}) {
  const XLSX = require('xlsx');
  const dir = resolveRoot(root);
  const wb = XLSX.utils.book_new();
  const used = new Set();
  let totalRows = 0;
  const added = [];
  for (const sh of (sheets || [])) {
    const rows = sh.rows || [];
    totalRows += rows.length;
    const name = safeSheetName(sh.name, used);
    XLSX.utils.book_append_sheet(wb, makeSheet(XLSX, rows, sh.header), name);
    added.push({ name, rows: rows.length });
  }
  if (!added.length) {
    XLSX.utils.book_append_sheet(wb, makeSheet(XLSX, [], ['(데이터 없음)']), '데이터없음');
    added.push({ name: '데이터없음', rows: 0 });
  }
  const stamp = fmtTs(Date.now()).replace(/[: ]/g, '-');
  const file = path.join(dir, fileName || `Bmail-내보내기-${stamp}.xlsx`);
  XLSX.writeFile(wb, file);
  return { ok: true, file, dir, sheets: added, totalRows, bytes: fs.statSync(file).size };
}

// 메일 목록 하나를 바로 엑셀로 (현재 화면의 필터·정렬 그대로 넘어온 배열을 그대로 쓴다)
function writeMailsExcel(mails, { root, fileName, sheetName = '메일목록' } = {}) {
  return writeExcel([{ name: sheetName, rows: mailsToRows(mails), header: MAIL_COLUMNS.map(c => c.key) }], { root, fileName });
}

// 대시보드 집계표 전체를 엑셀 여러 시트로
function writeDashboardExcel(mails, { root, fileName, granularity = 'day', activeDays = 90, topN = 500 } = {}) {
  const d = agg.buildDashboard(mails, { granularity, activeDays, topN });
  const s = d.summary;
  const sheets = [
    {
      name: '요약', rows: [
        { 항목: '전체 메일', 값: s.total }, { 항목: '받은 메일', 값: s.recv }, { 항목: '보낸 메일', 값: s.sent },
        { 항목: '프로젝트 수', 값: s.projects }, { 항목: '진행 중 프로젝트', 값: s.activeProjects },
        { 항목: '상대 조직 수', 값: s.orgs }, { 항목: '주고받은 상대 수', 값: s.people },
        { 항목: '첨부 있는 메일', 값: s.attach }, { 항목: '깃발(후속 작업)', 값: s.flagged },
        { 항목: '중요도 높음', 값: s.high }, { 항목: '범주 붙은 메일', 값: s.withCat },
        { 항목: '내 처리 - 할 일', 값: (s.action && s.action.todo) || 0 },
        { 항목: '내 처리 - 보류', 값: (s.action && s.action.hold) || 0 },
        { 항목: '내 처리 - 처리', 값: (s.action && s.action.done) || 0 },
        { 항목: '내 처리 - 확인', 값: (s.action && s.action.fyi) || 0 },
        { 항목: '내 처리 - 미지정', 값: (s.action && s.action.none) || 0 },
        { 항목: '기간 시작', 값: fmtDay(s.firstTs) }, { 항목: '기간 종료', 값: fmtDay(s.lastTs) },
        { 항목: '활동한 날', 값: s.activeDays }, { 항목: '하루 평균', 값: s.perDay }
      ], header: ['항목', '값']
    },
    {
      name: '날짜별', header: ['날짜', '전체', '받음', '보냄', '첨부', '프로젝트수'],
      rows: d.date.rows.map(r => ({ 날짜: r.key, 전체: r.count, 받음: r.recv, 보냄: r.sent, 첨부: r.attach, 프로젝트수: r.projectCount }))
    },
    {
      name: '프로젝트별', header: ['프로젝트', '마지막활동', '전체', '받음', '보냄', '첨부', '깃발', '조직수', '상대수'],
      rows: d.project.rows.map(r => ({
        프로젝트: r.key, 마지막활동: fmtDay(r.lastTs), 전체: r.count, 받음: r.recv, 보냄: r.sent,
        첨부: r.attach, 깃발: r.flagged, 조직수: r.orgCount, 상대수: r.peopleCount
      }))
    }
  ];
  const themeSheet = (name, res) => ({
    name, header: [name, '마지막활동', '건수', '받음', '보냄', '프로젝트수'],
    rows: res.rows.map(r => ({ [name]: r.key, 마지막활동: fmtDay(r.lastTs), 건수: r.count, 받음: r.recv, 보냄: r.sent, 프로젝트수: r.projectCount }))
  });
  sheets.push(themeSheet('범주', d.category), themeSheet('조직', d.org), themeSheet('상대', d.person), themeSheet('폴더', d.folder));
  // 교차표
  sheets.push({
    name: '프로젝트x조직',
    header: ['프로젝트', ...d.matrix.cols, '합계'],
    rows: d.matrix.rows.map(r => {
      const o = { 프로젝트: r.key };
      d.matrix.cols.forEach((c, i) => { o[c] = r.values[i]; });
      o['합계'] = r.count;
      return o;
    })
  });
  return writeExcel(sheets, { root, fileName });
}

module.exports = {
  defaultRoot, resolveRoot,
  writeDashboard, dashboardHtml,
  writeExcel, writeMailsExcel, writeDashboardExcel,
  mailsToRows, MAIL_COLUMNS, safeSheetName
};

// ============================================================
//  셀프체크 — `node src/exporter.js`
// ============================================================
if (require.main === module) {
  const assert = require('assert');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmail-export-'));
  const D = (s) => Date.parse(s + 'T09:00:00');
  const M = [
    { id: 1, folder: 'Inbox', received_ts: D('2026-08-01'), received_at: '2026-08-01 09:00', project: 'KSIT', to_org: '씨스타', sender_name: '김정인', recipients: 'me@y.com', subject: '도면 <검토> 요청 & 회신', categories: 'MAKER;HULL', has_attach: 1, real_attach_count: 2, flag_status: 2, importance: 2, task_due: '2026-08-10' },
    { id: 2, folder: 'Sent', received_ts: D('2026-08-01'), received_at: '2026-08-01 11:00', project: 'KSIT', to_org: '씨스타', sender_name: '나', recipients: 'a@x.com', subject: 'RE: 도면 회신', categories: 'MAKER', has_attach: 0, real_attach_count: 0, flag_status: 0, importance: 1 },
    { id: 3, folder: 'Inbox', received_ts: D('2020-01-05'), received_at: '2020-01-05 09:00', project: '옛프로젝트', to_org: '옛조직', sender_name: '박', recipients: 'me@y.com', subject: '오래된 메일', categories: '', has_attach: 0, real_attach_count: 0, flag_status: 0, importance: 1 }
  ];

  // ① 대시보드 HTML — 단일 파일, 외부 의존성 0
  const r1 = writeDashboard(M, { root: tmp, scopeLabel: '셀프체크' });
  const html = fs.readFileSync(r1.file, 'utf8');
  assert.ok(fs.existsSync(r1.file), '대시보드 파일이 만들어지지 않음');
  assert.ok(html.startsWith('<!DOCTYPE html>'), 'HTML 형식이 아님');
  assert.ok(/<meta charset="utf-8"/.test(html), 'UTF-8 선언 누락 — 한글이 깨진다');
  assert.ok(html.includes('통합 대시보드'), '제목 누락');
  assert.ok(html.includes('<svg'), '인라인 SVG 차트 없음');
  // 외부 리소스 참조 0 (chart.js·CDN·이미지 금지)
  assert.ok(!/<script[^>]+src=/i.test(html), '외부 스크립트 참조가 있다 — 의존성 0 위반');
  assert.ok(!/<link[^>]+href=/i.test(html), '외부 스타일시트 참조가 있다');
  assert.ok(!/https?:\/\//i.test(html.replace(/<!--[\s\S]*?-->/g, '')), '외부 URL 참조가 있다(오프라인에서 깨짐)');
  assert.ok(!/chart\.js|cdn\./i.test(html), 'chart.js/CDN 참조 발견');
  // 3축이 모두 들어갔는지
  assert.ok(html.includes('축 ① 날짜별') && html.includes('축 ② 프로젝트별') && html.includes('축 ③ 테마별'), '3축 누락');
  assert.ok(html.includes('data-q') && html.includes('data-sortable'), '필터·정렬 UI 누락');
  // XSS: 제목의 꺾쇠가 그대로 나가면 안 된다
  assert.ok(!html.includes('도면 <검토>'), '제목 이스케이프 누락');
  // 덮어쓰기 — 두 번 실행해도 파일이 늘지 않아야 한다
  const before = fs.readdirSync(tmp).length;
  writeDashboard(M, { root: tmp, scopeLabel: '두번째' });
  assert.strictEqual(fs.readdirSync(tmp).length, before, '대시보드를 다시 만들 때 파일이 늘어남(산출물 증가 0 위반)');

  // ② 메일 목록 엑셀
  const r2 = writeMailsExcel(M, { root: tmp, fileName: '메일목록.xlsx' });
  assert.ok(fs.existsSync(r2.file), '엑셀 파일이 만들어지지 않음');
  assert.strictEqual(r2.totalRows, 3, `행 수 불일치: ${r2.totalRows}`);
  const XLSX = require('xlsx');
  const wb = XLSX.readFile(r2.file);
  const back = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
  assert.strictEqual(back.length, 3, '읽어들인 행 수가 화면 건수와 다름');
  assert.strictEqual(back[0]['제목'], '도면 <검토> 요청 & 회신', '한글·특수문자 왕복 손상');
  assert.strictEqual(back[0]['프로젝트'], 'KSIT');
  assert.strictEqual(back[0]['방향'], '받음');
  assert.strictEqual(back[1]['방향'], '보냄');
  assert.strictEqual(back[0]['범주'], 'MAKER;HULL');
  assert.strictEqual(back[0]['깃발'], '표시됨');
  assert.deepStrictEqual(Object.keys(back[0]).slice(0, 5), ['날짜', '방향', '발신자', '수신자', '제목'], '컬럼 순서가 지정과 다름');

  // ③ 대시보드 집계표 엑셀 (여러 시트)
  const r3 = writeDashboardExcel(M, { root: tmp, fileName: '대시보드집계.xlsx' });
  const wb3 = XLSX.readFile(r3.file);
  ['요약', '날짜별', '프로젝트별', '범주', '조직', '상대', '폴더', '프로젝트x조직'].forEach(n =>
    assert.ok(wb3.SheetNames.includes(n), `시트 누락: ${n}`));
  const proj = XLSX.utils.sheet_to_json(wb3.Sheets['프로젝트별']);
  assert.strictEqual(proj[0]['프로젝트'], 'KSIT', '엑셀 프로젝트 시트가 최근 활동순이 아님');

  // ④ 시트명 제약
  const used = new Set();
  assert.strictEqual(safeSheetName('a/b:c*d?e[f]g', used).includes('/'), false, '금지문자가 남음');
  assert.ok(safeSheetName('가'.repeat(50), used).length <= 31, '시트명 31자 초과');
  const u2 = new Set();
  assert.notStrictEqual(safeSheetName('같은이름', u2), safeSheetName('같은이름', u2), '시트명 중복 회피 실패');

  // ⑤ 빈 입력에서 죽지 않아야 한다
  const r4 = writeDashboard([], { root: tmp });
  assert.ok(fs.existsSync(r4.file));
  const r5 = writeExcel([], { root: tmp, fileName: '빈파일.xlsx' });
  assert.ok(fs.existsSync(r5.file));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`exporter 셀프체크 OK — 대시보드 HTML(단일·외부의존 0·3축·XSS·덮어쓰기) + 엑셀(행수/컬럼순서/한글왕복/다중시트/시트명제약/빈입력) 통과`);
}
