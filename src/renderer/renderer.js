// ============================================================
//  renderer.js - UI 로직 (window.api 를 통해 메인 프로세스와 통신)
//  Outlook 스타일 3단 레이아웃 버전
// ============================================================

// ---------- 상태 ----------
let config = {
  apiKeys: ['', '', '', '', ''], model: 'gpt-oss-120b', maxMails: 5000,
  source: 'outlook', pstPath: '',
  dateFilter: { mode: '6months', start: '', end: '' },
  realtime: true, realtimeIntervalMin: 3, syncNewOnStart: true, notifyNewMail: true, saveAttachmentsOnSync: true,
  includeSubfolders: true, includeArchiveStores: false, autoImportContacts: true,
  autoAnalyzeOnOpen: false, aiConcurrency: 3, autoDailyBriefing: false,
  useOutlookSignature: true, signatureName: '', sentViewMode: 'grouped', crossValidate: true
};
let pendingFiles = [];          // 첨부 대기 파일 경로 (최대 5)
let chatHistory = [];           // {role, content} - AI 대화 맥락
let mailCache = [];             // 최근 검색된 메일 목록
let sentMailCache = [];         // 지금 보낸편지함 목록에 그려진 메일 (엑셀 내보내기용)
let followupCache = [];         // 지금 회신 대기 목록에 그려진 메일 (엑셀 내보내기용)
let briefMode = 'week';         // 브리핑 기간
let currentFolder = 'all';      // 현재 폴더 필터 (실폴더 이름 또는 all/__attach)
let currentVFolder = null;      // 현재 로컬 가상 폴더 id (선택 시 실폴더 필터 무시)
let selectedMail = null;        // 읽기창에 표시 중인 메일
let readTab = 'all';            // 'all' | 'unread'
let toMeTab = null;             // 1=직접 수신(To) · 0=참조(CC) · null=전체
let sortBy = 'date';            // date | sender | subject | attach
let sortDir = 'desc';
let collapsedGroups = new Set();// 접힌 날짜 그룹

// ★ 4탭(마스터 지시: "정렬·검토하면 무조건 타임라인으로 정리·요약") — 검색/대화 결과 집합의 탭 상태.
//   구조 데이터(timeline/person/keyword)는 main.js buildResultTabs() 가 검색 응답에 이미 실어 보낸다.
//   AI 요약(날짜별 한줄+종합)만 비동기(ai:summarizeGroups)로 별도 채운다 — 리스트를 기다리게 하지 않는다.
let resultTabsData = null;      // { timeline, person, keyword } (구조 집계, 동기)
let activeResultTab = 'timeline';
let resultTabsLabel = '';       // 엑셀 파일명/캐시 라벨용
let resultTabsSummary = null;   // { overall:[], byDate:Map } — AI 생성, 아직이면 null(스켈레톤)
let resultTabsSummaryFailed = false;

// ---------- DOM ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ============================================================
//  공용 아이콘 세트 (인라인 SVG 1곳 집중 — 중복 정의·고아 금지)
//  16/20px 그리드, Outlook 색감. 이모지·□ 문자 사용 금지 규율 준수.
//  사용: icon('group') / icon('clip', 14)
// ============================================================
const ICONS = {
  person: '<circle cx="12" cy="8" r="3.4"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
  group: '<circle cx="9" cy="8" r="3"/><path d="M2.5 19a6.5 6.5 0 0 1 13 0"/><circle cx="17.5" cy="9.5" r="2.4"/><path d="M15 19a5.5 5.5 0 0 1 6.5-4.6"/>',
  mailSearch: '<rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  clip: '<path d="M21.4 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.85-4.25 4.15 1 5.85L12 16.9l-5.25 2.75 1-5.85L3.5 9.65l5.9-.85z"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/>',
  flag: '<path d="M5 21V4M5 4h11l-1.6 3.5L16 11H5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  check: '<path d="M4 12.5l5 5 11-11"/>',
  reply: '<path d="M9 17l-6-5 6-5"/><path d="M3 12h11a6 6 0 0 1 6 6v1"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  chart: '<path d="M18 20V10M12 20V4M6 20v-6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.2"/>',
  refresh: '<path d="M20.5 4.5v5h-5M3.5 19.5v-5h5"/><path d="M4.2 9.6a8 8 0 0 1 13.2-3L20.5 9.5M3.5 14.5l3.1 2.9a8 8 0 0 0 13.2-3"/>',
  download: '<path d="M12 3.5v11M7.5 10L12 14.5 16.5 10"/><path d="M4.5 19.5h15"/>',
  inbox: '<path d="M21.5 12h-5l-1.6 2.6H9.1L7.5 12h-5"/><path d="M5.6 5.1L2.5 12v5.5a2 2 0 0 0 2 2h15a2 2 0 0 0 2-2V12l-3.1-6.9a2 2 0 0 0-1.8-1.1H7.4a2 2 0 0 0-1.8 1.1z"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  mail: '<rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.3a2.5 2.5 0 1 1 3.6 2.3c-.7.4-1.2 1-1.2 1.8v.4M12 16.6v.2"/>',
  plug: '<path d="M9 3v6M15 3v6"/><path d="M6.5 9h11v3a5.5 5.5 0 0 1-11 0z"/><path d="M12 17.5V21"/>',
  save: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 5.5v15"/>',
  chat: '<path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.5 8.5 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  send: '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/>'
};

// ------------------------------------------------------------
//  버튼 아이콘 주입 (HTML 에 SVG 를 중복 작성하지 않고 헬퍼 1곳에서 공급)
//  ★ 새 버튼을 추가하면 이 표에만 등록하면 된다.
// ------------------------------------------------------------
const BUTTON_ICONS = {
  // 파일 탭
  'rbf-settings': 'settings', 'rbf-diag': 'info', 'rbf-attachdir': 'folder', 'rbf-update': 'download',
  // 보내기/받기 탭
  'rbs-sync': 'refresh', 'rbs-checknew': 'inbox',
  // 폴더 탭
  'rbd-toggletree': 'panel', 'rbd-reload': 'refresh', 'rbd-stats': 'chart',
  // 보기 탭
  'rbv-mail': 'mail', 'rbv-dashboard': 'chart', 'rbv-chat': 'search', 'rbv-contacts': 'group',
  // 도움말 탭
  'rbh-open': 'help', 'rbh-diag': 'plug',
  // 대시보드 / 업무일지 / 회신대기 / 주소록 / 설정
  'btn-briefing': 'chart', 'btn-worklog': 'book', 'btn-worklog-copy': 'file', 'btn-worklog-history': 'clock',
  'btn-fu-refresh': 'refresh', 'btn-contact-search': 'search', 'btn-contact-import': 'download',
  'btn-save-settings': 'save', 'btn-check-update': 'download',
  'btn-admin-testconn': 'plug', 'btn-admin-openattach': 'folder', 'btn-admin-refresh': 'refresh',
  'btn-send': 'send', 'btn-pick-pst': 'folder'
};
function applyButtonIcons() {
  for (const [id, name] of Object.entries(BUTTON_ICONS)) {
    const el = document.getElementById(id);
    if (!el || el.querySelector('.ico')) continue;   // 이미 아이콘 있으면 건너뜀(중복 방지)
    el.insertAdjacentHTML('afterbegin', icon(name, 14));
    el.classList.add('has-ico');
  }
}
function icon(name, size = 15, cls = '') {
  const body = ICONS[name];
  if (!body) return '';
  return `<svg class="ico ${cls}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none"
    stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true" focusable="false">${body}</svg>`;
}

// 아바타 색상 팔레트
const AV_COLORS = ['#0a84ff','#11b37a','#e0663f','#8e5cff','#e0a800','#d63384','#00a7a7','#5a8f00'];
function avatarColor(str){ let h=0; for(const c of String(str||'?')) h=(h*31+c.charCodeAt(0))>>>0; return AV_COLORS[h%AV_COLORS.length]; }
function initials(str){ const s=String(str||'?').trim(); return s ? s.slice(0,1).toUpperCase() : '?'; }

// ============================================================
//  초기화
// ============================================================
window.addEventListener('DOMContentLoaded', async () => {
  try { $('#app-version').textContent = 'v' + (await window.api.getVersion()); } catch {}

  config = await window.api.getConfig();
  applyConfigToUI();
  updateKeyStatus();

  // ----- 폴더 트리 (뷰 전환 + 폴더 필터 모두 여기서) -----
  $$('.fld-item').forEach(btn => btn.addEventListener('click', () => {
    if (btn.dataset.nav) { switchView(btn.dataset.nav); return; }
    // ★ 폴더 선택은 selectRealFolder 한 곳으로 통일한다.
    //   (예전에는 여기서 별도 로직을 돌려 '보낸 편지함 → 분류 보기' 분기가 무시됐다)
    const label = btn.textContent.replace(/\[\d+\]|\d+$/g, '').trim();
    selectRealFolder(btn.dataset.folder, label);
    btn.classList.add('active');
  }));

  // ----- 메뉴 탭: 탭별 리본 교체 (DOM 재생성 없이 show/hide → 기존 바인딩 유지) -----
  $$('.menu-tab').forEach(tab => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));

  // ----- 파일 탭 -----
  $('#rbf-settings').addEventListener('click', () => switchView('settings'));
  $('#rbf-diag').addEventListener('click', () => { switchView('settings'); refreshAdminInfo(); });
  $('#rbf-attachdir').addEventListener('click', openAttachDir);

  // ----- 보내기/받기 탭 -----
  $('#rbs-sync').addEventListener('click', runSync);
  $('#rbs-checknew').addEventListener('click', checkNewMails);
  $('#rbs-attach').addEventListener('change', async (e) => {
    config = await window.api.setConfig({ ...config, saveAttachmentsOnSync: e.target.checked });
    if ($('#save-attach-toggle')) $('#save-attach-toggle').checked = e.target.checked;
  });
  $('#rbs-archive').addEventListener('change', async (e) => {
    config = await window.api.setConfig({ ...config, includeArchiveStores: e.target.checked });
    if ($('#archive-toggle')) $('#archive-toggle').checked = e.target.checked;
  });

  // ----- 폴더 탭 -----
  $('#rbd-toggletree').addEventListener('click', () => {
    const folders = $('#folders');
    const collapsed = folders.classList.toggle('collapsed');
    $('#rbd-toggletree').querySelector('.rb-tx').textContent = collapsed ? '폴더 창 펼치기' : '폴더 창 접기';
  });
  $('#rbd-reload').addEventListener('click', () => loadFolderTree(true));
  $('#rbd-stats').addEventListener('click', showFolderStats);

  // ----- 보기 탭 -----
  $('#rbv-mail').addEventListener('click', () => switchView('mail'));
  $('#rbv-dashboard').addEventListener('click', () => switchView('dashboard'));
  $('#rbv-chat').addEventListener('click', () => switchView('chat'));
  $('#rbv-contacts').addEventListener('click', () => switchView('contacts'));
  $('#rbv-thread').addEventListener('change', (e) => {
    $('#filter-thread').checked = e.target.checked;
    switchView('mail');
    renderMailList(mailCache);
  });
  $('#rbv-attach').addEventListener('change', (e) => {
    $('#filter-attach').checked = e.target.checked;
    switchView('mail');
    loadMails($('#global-search').value);
  });

  // ----- 도움말 탭 -----
  $('#rbh-open').addEventListener('click', openHelp);
  $('#rbh-diag').addEventListener('click', refreshConnectionStatus);
  $('#help-close').addEventListener('click', closeHelp);
  $('#help-modal').addEventListener('click', (e) => { if (e.target.id === 'help-modal') closeHelp(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeHelp(); });

  // ----- 리본 버튼 -----
  $('#rb-new').addEventListener('click', () => composeNew());
  $('#rb-sync').addEventListener('click', runSync);
  $('#rb-checknew').addEventListener('click', checkNewMails);
  // 요약: 화면만 바꾸지 말고 실제로 요약을 생성한다(마스터 기대 동작)
  // 리본 '요약' = 오늘 일일 브리핑 (통합)
  $('#rb-brief').addEventListener('click', () => {
    switchView('dashboard');
    if ($('#daily-date')) $('#daily-date').value = todayStr();
    runDailyBriefing(false);
  });
  // 답장/번역: 메일 미선택 시 조용히 무시하지 않고 안내
    // ★ 답장/전달/새 메일은 AI 를 거치지 않고 곧바로 Outlook 작성창을 연다(마스터 지시).
  //   AI 초안이 필요할 때만 '#rb-aidraft'(AI 작성 도움) 를 누른다.
  $('#rb-reply').addEventListener('click', () => { switchView('mail'); composeReply('reply'); });
  $('#rb-forward').addEventListener('click', () => { switchView('mail'); composeReply('forward'); });
  $('#rb-aidraft').addEventListener('click', () => { switchView('mail'); rpDraftReply(); });
  // 대용량 첨부 진입점 3곳: 홈 리본 · 보내기/받기 탭 · 읽기창 답장 옆(renderReadingPane 에서 위임 바인딩)
  $('#rb-bigmail').addEventListener('click', openBigmailDialog);
  $('#rbs-bigmail').addEventListener('click', openBigmailDialog);
  $('#btn-bm-history-refresh').addEventListener('click', loadBigmailHistory);
  if ($('#btn-org-history-refresh')) $('#btn-org-history-refresh').addEventListener('click', loadOrganizeHistoryPanel);
  $('#btn-attach-reclassify').addEventListener('click', reclassifyAttachments);
  $('#btn-rules-import').addEventListener('click', importOutlookRules);
  $('#btn-extras-import').addEventListener('click', () => importOutlookExtras(false));
  $('#btn-extras-refresh').addEventListener('click', loadExtrasStats);
  $('#btn-extras-retry').addEventListener('click', () => importOutlookExtras(true));
  $('#btn-action-clear-auto').addEventListener('click', async () => {
    const r0 = await window.api.actionSourceCounts();
    const c0 = r0.ok ? r0.counts : { manual: 0, flag: 0 };
    if (!c0.flag) { alert('Outlook 깃발에서 자동 매핑된 항목이 없습니다.'); return; }
    if (!confirm(`Outlook 깃발에서 자동으로 지정된 ${c0.flag}건의 처리 상태를 지웁니다.

직접 지정하신 ${c0.manual}건은 그대로 유지됩니다.

계속할까요?`)) return;
    const r = await window.api.actionClearAuto();
    await refreshActionCounts();
    await loadActionSourceInfo();
    alert(r.ok ? `${r.cleared}건을 초기화했습니다.` : '실패: ' + r.error);
  });

  $('#rbs-refreshall').addEventListener('click', manualRefresh);

  // ----- 로컬 정리 -----
  $('#btn-cleanup-scan').addEventListener('click', cleanupScanUI);
  $('#btn-cleanup-apply').addEventListener('click', cleanupApplyUI);
  window.api.onCleanupReport(renderCleanupReport);   // 자동 점검 결과 실시간 반영

  // ----- 내보내기 (대시보드 HTML · 엑셀) -----
  $('#btn-dash-html').addEventListener('click', exportDashboardHtml);
  $('#btn-dash-xls').addEventListener('click', exportDashboardExcel);
  $('#btn-export-root').addEventListener('click', pickExportRoot);
  $('#btn-export-open').addEventListener('click', () => window.api.exportOpenRoot());
  // 각 목록의 [엑셀] — 지금 화면의 필터·정렬 그대로
  $('#btn-xls-mail').addEventListener('click', () => exportListToExcel(mailCache, '메일목록', '메일목록'));
  $('#btn-xls-sent').addEventListener('click', () => exportListToExcel(sentMailCache, '보낸메일', '보낸메일'));
  $('#btn-xls-fu').addEventListener('click', () => exportListToExcel(followupCache, '회신대기', '회신대기'));
  window.api.onAttachProgress(({ done, remain }) => {
    const el = $('#attach-stats');
    if (el) el.textContent = `분류 중... ${done.toLocaleString()}건 처리 · 남은 ${remain.toLocaleString()}건`;
  });
  bindBigmailProgress();
  $('#rb-translate').addEventListener('click', () => { switchView('mail'); rpTranslate(); });

  // ----- 리본 소스 토글 (Outlook / PST) -----
  $('#rb-src-outlook').addEventListener('click', () => setSource('outlook'));
  $('#rb-src-pst').addEventListener('click', () => setSourcePst());

  // ----- 전역 검색 -----
  $('#global-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const v = $('#global-search').value;
      if (v.trim()) runSearch(v); else clearSearch();
      $('#global-search').select();
    }
    if (e.key === 'Escape') clearSearch();
  });
  // Ctrl+E / Ctrl+F → 검색바 포커스 (Outlook 과 동일 단축키)
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'e' || e.key === 'E' || e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      const el = $('#global-search');
      el.focus(); el.select();
    }
  });

  // ----- 채팅 -----
  $('#btn-send').addEventListener('click', sendChat);
  $('#chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  $('#chat-input').addEventListener('input', autoGrow);
  $('#btn-attach').addEventListener('click', pickFiles);

  // ----- 메일 목록 필터 -----
  $('#filter-attach').addEventListener('change', () => loadMails($('#global-search').value));
  $('#filter-thread').addEventListener('change', () => renderMailList(mailCache));

  // ----- Outlook 폴더 계층 트리 -----
  $('#btn-tree-reload').addEventListener('click', (e) => { e.stopPropagation(); loadFolderTree(true); });
  $('#btn-pst-refresh').addEventListener('click', (e) => { e.stopPropagation(); loadPstStores(); });
  $('#btn-org-rebuild').addEventListener('click', async (e) => { e.stopPropagation(); const r = await window.api.orgDict({ action: 'rebuild' }); if (r.ok) loadOrgDict(); });

  // ----- 모든 항목 / 읽지 않음 탭 -----
  //  ★ '모든 항목' = 모든 축의 필터를 완전히 초기화한다.
  //    (예전에는 읽음 축만 바뀌어서, 다른 축 필터가 남은 채 계속 0건이 나왔다 — 실사용 사고)
  $$('.mlp-tab[data-readtab]').forEach(t => t.addEventListener('click', () => {
    if (t.dataset.readtab === 'all') { resetAllFilters(); return; }
    readTab = t.dataset.readtab;
    syncFilterUI();
    loadMails($('#global-search').value);
  }));
  // To/CC 필터 (같은 버튼을 다시 누르면 해제)
  $$('.mlp-tab[data-tometab]').forEach(t => t.addEventListener('click', () => {
    const v = parseInt(t.dataset.tometab, 10);
    toMeTab = (toMeTab === v) ? null : v;
    syncFilterUI();
    loadMails($('#global-search').value);
  }));

  // ----- 정렬 -----
  //  ★ 검색 결과(4탭) 화면에서는 재검색 대신 이미 받은 mailCache 를 클라이언트에서
  //    다시 정렬해 갱신한다(resultTabs 구조는 그대로 — 정렬은 '목록' 탭에만 영향).
  $('#sort-by').addEventListener('change', (e) => {
    sortBy = e.target.value;
    if (resultTabsData) renderActiveResultTab(); else loadMails($('#global-search').value);
  });
  $('#sort-dir').addEventListener('click', () => {
    sortDir = sortDir === 'desc' ? 'asc' : 'desc';
    const b = $('#sort-dir');
    b.dataset.dir = sortDir;
    b.textContent = sortDir === 'desc' ? '▼' : '▲';
    b.title = sortDir === 'desc' ? '내림차순 (최신/큰 값 먼저)' : '오름차순 (오래된/작은 값 먼저)';
    if (resultTabsData) renderActiveResultTab(); else loadMails($('#global-search').value);
  });

  // ----- ★ 4탭(마스터 지시): 검색/대화 결과 정리 탭 -----
  $$('.rt-tab').forEach(b => b.addEventListener('click', () => {
    activeResultTab = b.dataset.tab;
    renderActiveResultTab();
  }));
  $('#rt-xls').addEventListener('click', exportActiveResultTab);

  // ----- 로컬 가상 폴더 -----
  $('#btn-vf-new').addEventListener('click', (e) => { e.stopPropagation(); createVFolderPrompt(); });

  // ----- 즐겨찾기 대상: 기본 폴더 항목 우클릭 -----
  $$('.fld-item[data-folder]').forEach(b => b.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const name = b.dataset.folder;
    if (name === 'all' || name === '__attach') return;
    showFolderMenu(e, { kind: 'real', name, key: `real:${name}` });
  }));

  // ----- 컨텍스트 메뉴 닫기 -----
  document.addEventListener('click', hideContextMenu);
  document.addEventListener('contextmenu', (e) => { if (!e.target.closest('.fld-item,.tree-item,.mail-item,.fav-item,.vf-item')) hideContextMenu(); });
  window.addEventListener('blur', hideContextMenu);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideContextMenu(); });

  // ----- 설정 -----
  $('#btn-save-settings').addEventListener('click', saveSettings);
  $$('input[name="source"]').forEach(r => r.addEventListener('change', () => {
    const val = document.querySelector('input[name="source"]:checked').value;
    $('#pst-row').classList.toggle('hidden', val !== 'pst');
  }));
  $('#btn-pick-pst').addEventListener('click', async () => {
    const p = await window.api.pickPst();
    if (p) $('#pst-path').value = p;
  });
  $$('input[name="dateMode"]').forEach(r => r.addEventListener('change', () => {
    const val = document.querySelector('input[name="dateMode"]:checked').value;
    $('#range-row').classList.toggle('hidden', val !== 'range');
  }));

  // ----- 대시보드 / 브리핑 -----
  $$('.brief-btn').forEach(b => b.addEventListener('click', () => {
    $$('.brief-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active'); briefMode = b.dataset.mode;
  }));
  $('#btn-briefing').addEventListener('click', generateBriefing);
  $('#btn-unanswered-refresh').addEventListener('click', loadUnanswered);

  // ----- 일일 메일 브리핑 -----
  if ($('#daily-date')) $('#daily-date').value = todayStr();
  $('#btn-daily-run').addEventListener('click', () => runDailyBriefing(false));
  $('#btn-daily-refresh').addEventListener('click', () => runDailyBriefing(true));
  $('#btn-daily-today').addEventListener('click', () => { $('#daily-date').value = todayStr(); runDailyBriefing(false); });
  $('#btn-daily-prev').addEventListener('click', () => { $('#daily-date').value = shiftDate($('#daily-date').value || todayStr(), -1); runDailyBriefing(false); });
  $('#btn-daily-next').addEventListener('click', () => { $('#daily-date').value = shiftDate($('#daily-date').value || todayStr(), 1); runDailyBriefing(false); });
  $('#daily-date').addEventListener('change', () => runDailyBriefing(false));

  // ----- 일정 달력 -----
  $('#btn-cal-prev').addEventListener('click', () => calShiftMonth(-1));
  $('#btn-cal-next').addEventListener('click', () => calShiftMonth(1));
  $('#btn-cal-today').addEventListener('click', () => { calCursor = new Date(); loadCalendar(); });
  $('#btn-cal-collect').addEventListener('click', async () => {
    showLoading('저장된 분석에서 일정 모으는 중...');
    const r = await window.api.schedCollect();
    hideLoading();
    if (!r.ok) return alert('일정 수집 실패: ' + r.error);
    await loadCalendar();
    alert(`분석 ${r.scanned}건에서 기한 ${r.candidates}건을 찾아 ${r.added}건 추가했습니다. (총 ${r.total}건)`);
  });
  $('#cal-pop-close').addEventListener('click', () => $('#cal-popover').classList.add('hidden'));
  $('#cal-pop-save').addEventListener('click', saveDaySchedule);
  $('#cal-pop-title').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveDaySchedule(); });

  // ----- 보낸메일 프로젝트 트리 -----
  $('#btn-sent-recompute').addEventListener('click', () => recomputeProjectsUI(false));
  $('#btn-proj-recompute-all').addEventListener('click', () => recomputeProjectsUI(true));
  $('#btn-sent-grouped').addEventListener('click', () => setSentViewMode('grouped'));
  $('#btn-sent-list').addEventListener('click', () => setSentViewMode('list'));
  // 분류 축 3종 (프로젝트별 / 날짜별 / 이벤트·테마별)
  $$('.sent-axis-btn').forEach(b => b.addEventListener('click', () => setSentAxis(b.dataset.axis)));

  // ----- 전역 AI 대화 패널 -----
  $('#btn-gchat').addEventListener('click', () => openGlobalChat());
  $('#gchat-close').addEventListener('click', () => setGchatCollapsed(true));
  $('#gchat-ctx-clear').addEventListener('click', () => {
    if (gchatPinned) { gchatPinned = null; gchatCtxOn = true; }   // 고정 맥락부터 푼다
    else gchatCtxOn = !gchatCtxOn;
    updateGchatCtx();
  });
  $('#gchat-clear').addEventListener('click', () => { chatHistory = []; $('#chat-log').innerHTML = ''; });
  // 대화 배치 모드(패널 ↔ 메인) · 폭 드래그 조절
  $('#gchat-dock').addEventListener('click', () => setGchatDock(gchatDock === 'main' ? 'panel' : 'main', true));
  bindGchatResize();
  bindAttachPreviewPanel();
  bindRightStack();                 // 바둑판 레이아웃(접기·리사이저·탭)
  try { setGchatDock(localStorage.getItem('bmail.gchatDock.v2') === 'main' ? 'main' : 'panel', false); } catch (e) { setGchatDock('panel', false); }
  // 첫 안내 문구 접기/펴기 (마지막 선택 기억)
  const introToggle = $('#chat-intro-toggle');
  if (introToggle) {
    const applyIntro = (folded) => {
      const body = $('#chat-intro-body');
      if (body) body.classList.toggle('hidden', folded);
      introToggle.textContent = folded ? '안내 보기' : '접기';
      try { localStorage.setItem('bmail.chatIntro', folded ? '0' : '1'); } catch (e) {}
    };
    introToggle.addEventListener('click', () => applyIntro(!$('#chat-intro-body').classList.contains('hidden')));
    try { if (localStorage.getItem('bmail.chatIntro') === '0') applyIntro(true); } catch (e) {}
  }
  // AI 상태 배지 · 키 점검
  $('#ai-state-pill').addEventListener('click', () => { switchView('settings'); const c = $('#ai-chain'); if (c) c.scrollIntoView({ block: 'center' }); });
  $('#btn-chain-add').addEventListener('click', () => addProviderRow());
  $('#btn-chain-test').addEventListener('click', () => runChainTest());
  $('#btn-usage-refresh').addEventListener('click', () => refreshAiUsage());
  // 제공자 프리셋·등록된 체인을 받아 설정 화면에 그린다
  window.api.aiProviders().then(r => {
    if (r && r.ok) {
      providerPresets = r.presets || [];
      providerChain = (r.chain || []).map(e => ({
        provider: e.provider, baseUrl: e.baseUrl, model: e.model,
        keys: e.keys || [], accountId: e.accountId || '', enabled: e.enabled !== false
      }));
      renderProviderChain();
      updateKeyStatus();
      refreshAiUsage();
    }
  }).catch(() => {});
  refreshAiState();
  window.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if ((e.ctrlKey || e.metaKey) && (e.key === '/' || e.key === 'k' || e.key === 'K')) {
      e.preventDefault(); setGchatCollapsed(!gchatCollapsed); return;
    }
    if (e.key === 'Escape' && !typing) {
      const ap = $('#att-preview');
      if (ap && !ap.classList.contains('hidden')) { closeAttachPreview(); return; }   // 미리보기 먼저
      if (!gchatCollapsed) setGchatCollapsed(true);
    }
  });
  // 접힘 상태 복원 — 대화창 자체는 항상 우하단에 떠 있다
  try {
    const saved = localStorage.getItem('bmail.gchatCollapsed.v2');
    const narrow = window.innerWidth < 900;
    setTimeout(() => setGchatCollapsed(saved === null ? (narrow ? true : false) : (narrow ? true : saved === '1')), 250);
  } catch (e) { setTimeout(() => setGchatCollapsed(true), 250); }
  // 접힌 헤더를 누르면 펼친다
  document.querySelector('#gchat .gchat-head').addEventListener('click', (e) => {
    if (gchatCollapsed && !e.target.closest('button')) setGchatCollapsed(false);
  });
  window.addEventListener('resize', () => { applyGchatReserve(); applyStackRows(); });
  // 분류 상태에서도 정렬 변경 — 트리·읽기창은 유지한 채 중앙 목록만 다시 그린다
  $('#sent-sort-by').addEventListener('change', () => { sentSort.by = $('#sent-sort-by').value; reloadSentList(); });
  $('#sent-sort-dir').addEventListener('click', () => {
    const b = $('#sent-sort-dir');
    sentSort.dir = sentSort.dir === 'desc' ? 'asc' : 'desc';
    b.dataset.dir = sentSort.dir;
    b.textContent = sentSort.dir === 'desc' ? '▼' : '▲';
    b.title = sentSort.dir === 'desc' ? '정렬 방향 (내림차순 = 최신 위)' : '정렬 방향 (오름차순 = 오래된 것 위)';
    reloadSentList();
  });

  // ----- 회신 대기 -----
  //  ★ [data-fu] 로 한정한다. '.fu-btn' 전체로 잡으면 새로고침·정렬 버튼까지 기간 필터로 오인해
  //    followupMinDays 가 NaN→3 으로 초기화되고 active 표시가 엉킨다(실측 결함).
  $$('.fu-btn[data-fu]').forEach(b => b.addEventListener('click', () => {
    $$('.fu-btn[data-fu]').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    followupMinDays = parseInt(b.dataset.fu, 10) || 3;
    loadFollowup();
  }));
  $('#btn-fu-refresh').addEventListener('click', loadFollowup);

  // ----- 처리 상태 필터 탭 (메일 목록) -----
  //  ★ 이 버튼들은 '필터 전용'이다. 상태 지정은 우클릭 메뉴·읽기창 버튼·단축키로만 한다.
  //    같은 축(처리 상태) 안에서는 여러 개를 골라 합집합으로 볼 수 있다.
  $$('.as-chip').forEach(b => b.addEventListener('click', () => {
    const v = b.dataset.astab;
    const i = actionTab.indexOf(v);
    if (i >= 0) actionTab.splice(i, 1); else actionTab.push(v);
    syncFilterUI();
    loadMails($('#global-search').value);
  }));
  $('#btn-filter-reset').addEventListener('click', resetAllFilters);

  // ----- 할 일 뷰 -----
  $$('.fu-btn[data-tdstate]').forEach(b => b.addEventListener('click', () => {
    $$('.fu-btn[data-tdstate]').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    todoState = b.dataset.tdstate;
    loadTodoView();
  }));
  $('#btn-todo-refresh').addEventListener('click', loadTodoView);
  $('#btn-xls-todo').addEventListener('click', () => exportListToExcel(todoCache, '할일목록', '할일목록'));
  $('#btn-fu-sort').addEventListener('click', (e) => {
    followupSort = followupSort === 'date' ? 'waiting' : 'date';
    const b = e.currentTarget;
    b.dataset.fusort = followupSort;
    b.textContent = followupSort === 'date' ? '날짜순' : '대기순';
    loadFollowup();
  });
  $('#fu-sender').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadFollowup(); });

  // ----- 업무일지 -----
  $$('.wl-btn').forEach(b => b.addEventListener('click', () => {
    $$('.wl-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    workLogMode = b.dataset.wl;
  }));
  $('#btn-worklog').addEventListener('click', generateWorkLog);
  $('#btn-worklog-history').addEventListener('click', showWorkLogHistory);
  $('#btn-worklog-copy').addEventListener('click', async () => {
    if (!lastWorkLogText) { alert('먼저 업무일지를 생성하세요.'); return; }
    const ok = await copyText(lastWorkLogText);
    const b = $('#btn-worklog-copy'); const t = b.textContent;
    b.textContent = ok ? '복사됨' : '복사 실패';
    setTimeout(() => { b.textContent = t; }, 1500);
  });

  // ----- 주소록 -----
  $('#btn-contact-import').addEventListener('click', importContacts);
  $('#btn-contact-search').addEventListener('click', () => loadContacts($('#contact-search').value));
  $('#contact-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadContacts($('#contact-search').value); });
  $('#btn-contact-sort').addEventListener('click', (e) => {
    contactSort = contactSort === 'recent' ? 'name' : 'recent';
    const b = e.currentTarget;
    b.dataset.csort = contactSort;
    b.textContent = contactSort === 'recent' ? '최근 연락순' : '이름순';
    loadContacts($('#contact-search').value);
  });

  // ----- 관리자 진단 -----
  $('#btn-admin-refresh').addEventListener('click', refreshAdminInfo);
  $('#btn-admin-testconn').addEventListener('click', refreshConnectionStatus);
  $('#btn-admin-openattach').addEventListener('click', openAttachDir);   // 파일 탭과 동일 동작 공유

  // ----- 이벤트 수신 -----
  window.api.onNewMails((mails) => { handleNewMails(mails); handleNewMailsLive(mails); });
  window.api.onRealtimeStatus(handleRealtimeStatus);
  window.api.onOpenMail(({ id }) => { if (id) { switchView('mail'); openMailDetail({ id }); } });
  // ----- 본문 링크: 앱 안에서 열지 않고 main 이 분류(파일·대용량첨부 → 우하단 다운로드 팝업 / 그 외 → 브라우저) -----
  //   읽기창은 4곳(rpTargets)에 같은 구조(.rp-body)로 그려지므로 문서 1곳에서 위임한다.
  //   진행·완료·자동 불가 표시는 팝업 창이 맡는다. 여기서는 팝업이 못 뜨는 경우만 알린다(조용한 실패 금지).
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('.rp-body a[href]');
    if (!a) return;
    e.preventDefault();
    window.api.openLink(a.getAttribute('href'))
      .then(r => {
        if (r && r.action === 'queued') showAiToast('다운로드 창이 가득 차 대기열에 넣었습니다 — 하나가 닫히면 이어서 뜹니다');
        else if (r && r.action === 'error') showAiToast('링크 열기 실패: ' + r.reason);
      })
      .catch(err => showAiToast('링크 열기 실패: ' + err.message));
  });
  // Outlook 폴더 구조 변경 감지 → 트리·배지 자동 갱신 (전체 동기화 없이)
  // 주기 갱신(동기화 폴링): 폴더 트리 + Outlook 즐겨찾기를 함께 최신화
  window.api.onFolderTreeStale(() => {
    loadFolderTree(true);
    refreshUnreadBadges();
    syncOutlookFavorites(true).then(() => loadFavorites());
  });
  // ★ 이미 있던 메일이 Outlook 에서 바뀐 경우(읽음·이동·범주·깃발·삭제) — 화면을 조용히 최신화
  window.api.onMailsUpdated(handleMailsUpdated);
  window.api.onSyncProgress(handleSyncProgress);
  window.api.onAiProgress(handleAiProgress);

  // 수동 새로고침: F5 · Ctrl+R
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R'))) {
      e.preventDefault();
      manualRefresh();
    }
  });

  // ★ 처리 상태 단축키 1~4 지정 · 0 해제 · Ctrl+Z 되돌리기
  //   입력칸에 글을 쓰는 중에는 절대 가로채지 않는다.
  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (!selectedMail || !selectedMail.id) return;
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault(); undoActionFor([selectedMail.id]); return;
    }
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const map = { '1': 'todo', '2': 'hold', '3': 'done', '4': 'fyi', '0': null };
    if (!(e.key in map)) return;
    e.preventDefault();
    const want = map[e.key];
    const now = selectedMail.action_state || null;
    const next = (want && want === now) ? null : want;
    selectedMail.action_state = next;
    setActionFor([selectedMail.id], next);
  });
  // '사용자 조작 중' 신호 — 조작 중에는 본체가 무거운 갱신을 다음 주기로 미룬다
  bindUiBusySignals();
  // 앱을 다시 열었을 때 직전 갱신 상태를 툴팁에 복원
  window.api.refreshInfo().then(r => { if (r && r.ok && r.info) { lastRefreshDetail = r.info; updateRealtimeDot(); } }).catch(() => {});

  refreshConnectionStatus();
  refreshDbStatus();
  refreshAdminInfo();
  loadStats();
  loadMails('');       // 시작 시 메일 뷰 자동 로드
  // 즐겨찾기: Outlook 탐색 창을 정본으로 먼저 가져온 뒤 렌더
  syncOutlookFavorites(true).then(() => loadFavorites());
  loadVFolders();      // 내 로컬 폴더
  refreshUnreadBadges();
  loadFollowup();      // 회신 대기 배지
  refreshActionCounts();                              // 처리 상태 배지
  syncFilterUI();                                     // 필터 버튼 상태 = 실제 필터와 일치
  window.api.actionSeedFromFlags().catch(() => {});   // Outlook 깃발 → 최초 1회 할 일/처리 매핑
  loadDailyDates();
  loadCalendar();      // 일정 달력 (대시보드 상시)
  if (config.autoDailyBriefing === true) setTimeout(() => runDailyBriefing(false), 4000);
  applyButtonIcons();  // 전 버튼 아이콘 주입 (공용 헬퍼 1곳)
  loadFolderTree();    // Outlook 폴더 계층 트리 (백그라운드)
});

// ============================================================
//  관리자 진단 정보 채우기
// ============================================================
async function refreshAdminInfo() {
  try { $('#admin-version').textContent = 'v' + (await window.api.getVersion()); } catch {}
  try {
    const s = await window.api.dbStatus();
    const dbEl = $('#admin-db'), ftsEl = $('#admin-fts'), pathEl = $('#admin-db-path');
    if (s.ready) {
      dbEl.textContent = '정상'; dbEl.className = 'admin-v ok';
      ftsEl.textContent = s.fts ? '사용' : '미사용(LIKE 검색)'; ftsEl.className = 'admin-v' + (s.fts ? ' ok' : '');
    } else {
      dbEl.textContent = '초기화 실패'; dbEl.className = 'admin-v bad';
      ftsEl.textContent = '-';
    }
    pathEl.textContent = s.path || '-';
    pathEl.title = s.path || '';
  } catch {}
  try {
    const r = await window.api.dbStats();
    if (r.ok) {
      $('#admin-mailcount').textContent = (r.stats.total || 0).toLocaleString() + '건';
      $('#admin-lastsync').textContent = r.lastSyncAt ? new Date(r.lastSyncAt).toLocaleString('ko-KR') : '없음';
    }
  } catch {}
  // To/CC 구분 현황 (진단) — 클릭하면 다시 계산
  try {
    const r = await window.api.dbToMeStats();
    const el = $('#admin-tome');
    if (el && r.ok) {
      el.innerHTML = `직접 수신 <b>${r.stats.direct.toLocaleString()}</b> · 참조 <b>${r.stats.cc.toLocaleString()}</b> · 미판정 ${r.stats.unknown.toLocaleString()}
        <button class="link-btn" id="btn-tome-recalc">다시 계산</button>`;
      el.title = '판정 기준: ' + (r.me || []).join(', ');
      const btn = $('#btn-tome-recalc');
      if (btn) btn.addEventListener('click', async () => {
        btn.textContent = '계산 중...';
        const rr = await window.api.dbToMeBackfill();
        btn.textContent = rr.ok ? '완료' : '실패';
        refreshAdminInfo();
      });
    }
  } catch {}

  // 메일 서명 (원본 HTML 진단 + 목록 채우기)
  try {
    const sg = await window.api.composeSignatureHtml('');
    const info = $('#sig-info');
    const sel = $('#sig-select');
    if (sel && sg && sg.ok) {
      const cur = sel.value || config.signatureName || '';
      sel.innerHTML = '<option value="">Outlook 기본 서명 따름</option>' +
        (sg.list || []).map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
      sel.value = cur;
    }
    if (info) {
      info.textContent = (sg && sg.ok)
        ? `적용 서명 "${sg.name}" · ${sg.encoding} · HTML ${sg.length.toLocaleString()}자 · 이미지 ${sg.imageCount}개 · 맑은고딕 ${sg.hasMalgun ? 'O' : 'X'} · 색 ${(sg.colors || []).join(' ')}`
        : `서명을 찾지 못했습니다: ${(sg && sg.error) || '알 수 없음'}`;
      if (sg && sg.ok) info.title = sg.textPreview || '';
    }
  } catch {}

  // Outlook 계정 목록 (진단)
  try {
    const st = await window.api.outlookGetSettings();
    const el = $('#admin-accounts');
    if (el) {
      if (st && st.ok) {
        const accts = (st.accounts || []).map(a => a.smtpAddress || a.displayName).filter(Boolean);
        const stores = (st.stores || []).map(x => x.name).filter(Boolean);
        el.textContent = accts.length ? `${accts.join(', ')} · 데이터 파일 ${stores.length}개` : '계정 정보 없음';
        el.title = (st.stores || []).map(x => `${x.name}: ${x.path || ''}`).join('; ');
      } else el.textContent = '확인 실패';
    }
  } catch {}

  // Outlook 서명 (답장/새 메일 작성 시 Outlook 이 자동 삽입하는 서명)
  try {
    const sg = await window.api.composeSignature('');
    const el = $('#admin-signature');
    if (el) {
      if (sg && sg.ok) {
        const lines = String(sg.text || '').replace(/\r/g, '').split('\n');
        const first = lines.find(x => x.trim()) || '';
        el.textContent = sg.name ? `${sg.name} (${(sg.list || []).length}개) - ${first.slice(0, 40)}` : '설정된 서명 없음';
        el.title = sg.text || '';
      } else el.textContent = '확인 실패';
    }
  } catch {}
}

// ============================================================
//  소스(Outlook/PST) 전환 - 리본에서 즉시
// ============================================================
async function setSource(src) {
  config.source = src;
  await window.api.setConfig(config);
  syncSourceUI();
  refreshConnectionStatus();
  updateRealtimeDot();
}
async function setSourcePst() {
  // PST 경로가 없으면 파일 선택
  let p = config.pstPath;
  if (!p) {
    p = await window.api.pickPst();
    if (!p) return;
    config.pstPath = p;
  }
  config.source = 'pst';
  await window.api.setConfig(config);
  syncSourceUI();
  refreshConnectionStatus();
  updateRealtimeDot();
}
function syncSourceUI() {
  const src = config.source || 'outlook';
  $('#rb-src-outlook').classList.toggle('active', src === 'outlook');
  $('#rb-src-pst').classList.toggle('active', src === 'pst');
  const pn = $('#rb-pst-name');
  if (src === 'pst' && config.pstPath) {
    pn.textContent = '' + config.pstPath.split(/[\\/]/).pop();
    pn.classList.remove('hidden');
  } else {
    pn.classList.add('hidden');
  }
  // 설정 화면 라디오도 동기화
  const srcRadio = document.querySelector(`input[name="source"][value="${src}"]`);
  if (srcRadio) srcRadio.checked = true;
  if ($('#pst-path')) $('#pst-path').value = config.pstPath || '';
  $('#pst-row') && $('#pst-row').classList.toggle('hidden', src !== 'pst');
}

// ============================================================
//  DB 상태 / 통계
// ============================================================
async function refreshDbStatus() {
  try {
    const s = await window.api.dbStatus();
    if (!s.ready) {
      const el = $('#sync-info');
      el.textContent = 'DB 초기화 실패 (재빌드 필요)';
      el.title = s.error || '';
    }
  } catch (_) {}
}

async function loadStats() {
  try {
    const r = await window.api.dbStats();
    if (!r.ok) return;
    const s = r.stats;
    $('#stat-total').textContent = s.total;
    $('#stat-unread').textContent = s.unread;
    $('#stat-attach').textContent = s.withAttach;
    $('#stat-contacts').textContent = s.contacts;

    // 폴더 카운트
    $('#cnt-all').textContent = s.total;
    $('#cnt-attach').textContent = s.withAttach;
    if (s.byFolder) {
      $('#cnt-inbox').textContent = s.byFolder.Inbox || 0;
      $('#cnt-sent').textContent = s.byFolder.Sent || 0;
    }

    const senders = $('#top-senders');
    senders.innerHTML = (s.topSenders || []).map(t =>
      `<div class="sender-row"><span>${escapeHtml(t.sender_name || t.sender_email)}</span><span class="badge">${t.c}</span></div>`
    ).join('') || '<div class="empty-sm">데이터 없음</div>';

    const langNames = { ko: '한국어', en: '영어', zh: '중국어', ja: '일본어', unknown: '기타' };
    const dist = $('#lang-dist');
    dist.innerHTML = (s.byLang || []).map(l =>
      `<div class="sender-row"><span>${langNames[l.lang] || l.lang}</span><span class="badge">${l.c}</span></div>`
    ).join('') || '<div class="empty-sm">데이터 없음</div>';

    if (r.lastSyncAt) {
      const d = new Date(r.lastSyncAt);
      $('#sync-info').textContent = `마지막 동기화: ${d.toLocaleString('ko-KR')}`;
    }
  } catch (_) {}
}

// ============================================================
//  동기화
// ============================================================
async function runSync() {
  const btn = $('#rb-sync');
  btn.disabled = true;
  showLoading('메일 동기화 시작...');
  try {
    const res = await window.api.syncRun();
    hideLoading();
    if (res.ok) {
      $('#sync-info').textContent = `${res.fetched}건 동기화 완료 (첨부 ${res.attachSaved || 0}개 저장)`;
      loadStats();
      loadMails($('#global-search').value);
      alert(`동기화 완료!\n\n• 메일 ${res.fetched}건 저장/색인\n• 첨부 ${res.attachSaved || 0}개 로컬 저장${res.attachFail ? ' ('+res.attachFail+'개 실패)' : ''}${res.attachSkipped ? `\n• 이미 저장된 메일 ${res.attachSkipped}건은 첨부 재저장 생략` : ''}\n• 주소록 자동 연동: Outlook ${res.contactsImported || 0}건 · 발신자 파생 ${res.contactsDerived || 0}건`);
      loadContacts($('#contact-search') ? $('#contact-search').value : '');
    } else {
      alert('동기화 실패: ' + res.error);
      $('#sync-info').textContent = '동기화 실패';
    }
  } catch (err) {
    hideLoading();
    alert('동기화 오류: ' + String(err));
  } finally {
    btn.disabled = false;
  }
}

function handleSyncProgress({ phase, cur, total, msg }) {
  const t = total ? ` (${cur}/${total})` : '';
  showLoading((msg || '동기화 중') + t);
  $('#sync-info').textContent = (msg || '동기화 중') + t;
}

// ============================================================
//  AI 브리핑
// ============================================================
async function generateBriefing() {
  if (needKey()) return;
  const box = $('#briefing-result');
  box.innerHTML = '<div class="empty">메일을 분석하는 중입니다...</div>';
  showLoading('요약 생성 중...');
  try {
    const res = await window.api.aiBriefing(briefMode);
    hideLoading();
    if (res.ok) {
      box.innerHTML = `<div class="briefing-meta">${res.period} · 분석 메일 ${res.count}건 · 키#${res.usedKeyIndex}</div>` +
        `<div class="briefing-body">${formatAnswer(res.content)}</div>`;
    } else {
      noteAiResult(res); box.innerHTML = aiErrorHtml(res); bindAiErrorActions(box);
    }
  } catch (err) {
    hideLoading();
    box.innerHTML = `<div class="empty">${escapeHtml(String(err))}</div>`;
  }
}

// ------------------------------------------------------------
//  AI 대량 처리 진행 표시 (청크 map-reduce)
// ------------------------------------------------------------
function handleAiProgress({ kind, phase, cur, total, msg }) {
  // 🔴 회신 필요성 백그라운드 배치 판정은 전체화면 로딩(#loading, z-index:999)을 띄우면 안 된다
  //   (사용자 조작 방해 없음이 설계 전제 — HANDOFF 7번). 회신대기 뷰의 작은 텍스트로만 표시한다.
  if (kind === 'replyNeeded') {
    const el = $('#fu-classify-progress');
    if (!el) return;
    if (phase === 'done') { el.classList.add('hidden'); el.textContent = ''; return; }
    el.textContent = `${cur}/${total}건 판정 중`;
    el.classList.remove('hidden');
    return;
  }
  const label = phase === 'wait' ? msg
    : (phase === 'reduce' ? `종합 중... (${total}개 묶음)`
      : (phase === 'done' ? '정리 완료' : `묶음 ${cur}/${total} 처리 중...`));
  showLoading(label);
  const box = kind === 'worklog' ? $('#worklog-result') : $('#briefing-result');
  if (box) {
    const pct = total ? Math.round((cur / total) * 100) : 0;
    box.innerHTML = `<div class="ai-progress">
        <div class="aip-label">${escapeHtml(label)}</div>
        <div class="aip-bar"><div class="aip-fill" style="width:${pct}%"></div></div>
        <div class="aip-hint">분당 토큰 한도를 넘지 않도록 나눠서 처리합니다. 창을 닫지 마세요.</div>
      </div>`;
  }
  if (phase === 'done') hideLoading();
}

// 클립보드 복사 (포커스 없을 때 폴백)
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch (_) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      const ok = document.execCommand('copy');
      ta.remove(); return ok;
    } catch (_) { return false; }
  }
}

// ============================================================
//  보낸메일 프로젝트 트리 (프로젝트 → 수신인 → 메일)
//  ★ 집계는 전부 SQL GROUP BY(main/db) 결과를 받아 쓴다. 렌더러 전건 루프 없음.
//  ★ 수신인 노드는 클릭 시(지연 로드) 채운다.
// ============================================================
let sentTreeCache = [];
let sentSel = { project: null, toFirst: undefined };

// 분류 뷰 상단 요약 칩 (프로젝트 수 · 수신인 수 · 기간)
async function renderSentSummary() {
  const box = $('#sent-summary');
  if (!box) return;
  try {
    const st = await window.api.dbStats();
    const total = (st.ok && st.stats.byFolder) ? (st.stats.byFolder.Sent || 0) : 0;
    const projects = sentTreeCache.length;
    // 수신인 수는 트리 펼침 없이도 알 수 있게 프로젝트별 집계 합으로 근사하지 않고,
    // 실제 값은 선택된 프로젝트에서 채운다(전체는 프로젝트 수만 표시).
    const span = sentPeriod.from && sentPeriod.to ? `${sentPeriod.from} ~ ${sentPeriod.to}` : '기간 확인 중';
    box.innerHTML =
      `<span class="ss-chip">${icon('folder', 12)}프로젝트 <b>${projects}</b></span>` +
      `<span class="ss-chip">${icon('send', 12)}보낸 메일 <b>${total.toLocaleString()}</b></span>` +
      (sentRecipCount !== null ? `<span class="ss-chip">${icon('person', 12)}수신인 <b>${sentRecipCount}</b></span>` : '') +
      `<span class="ss-chip ss-dim">${icon('clock', 12)}${escapeHtml(span)}</span>`;
  } catch (_) {}
}

// 보기 모드 전환 (분류 ↔ 목록) — config 에 기억
async function setSentViewMode(mode) {
  config = await window.api.setConfig({ ...config, sentViewMode: mode });
  applySentViewMode(mode);
}

// ★ 보기 전환은 '같은 화면 안에서' 처리한다(뷰 이동 없음).
//   분류 보기 = 트리+목록+읽기창 / 목록 보기 = 트리 숨김 + 전체 보낸메일 평면 목록
function applySentViewMode(mode) {
  const grouped = mode !== 'list';
  const gb = $('#btn-sent-grouped'), lb = $('#btn-sent-list');
  if (gb) gb.classList.toggle('active', grouped);
  if (lb) lb.classList.toggle('active', !grouped);
  const tp = document.querySelector('.sent-tree-pane');
  if (tp) tp.classList.toggle('hidden', !grouped);
  const rc = $('#btn-sent-recompute');
  // '다시 분류'는 프로젝트 축에서만 의미가 있다
  if (rc) rc.classList.toggle('hidden', !grouped || sentAxisMode !== 'project');
  // 축 버튼은 분류 보기일 때만 노출
  $$('.sent-axis-btn').forEach(b => {
    b.classList.toggle('hidden', !grouped);
    b.classList.toggle('active', b.dataset.axis === sentAxisMode);
  });
  if (grouped) { loadSentAxis(); }
  else { loadSentFlatList(); }
}

// ------------------------------------------------------------
//  분류 축 3종 — 프로젝트별 / 날짜별(연·월) / 이벤트·테마별
//   마스터 요구(2026-08-04). 축 선택은 마지막 상태를 기억한다.
// ------------------------------------------------------------
let sentAxisMode = 'project';
try { sentAxisMode = localStorage.getItem('bmail.sentAxis') || 'project'; } catch (_) {}
let sentAxisCache = { axis: '', groups: [] };

function setSentAxis(axis) {
  sentAxisMode = axis;
  try { localStorage.setItem('bmail.sentAxis', axis); } catch (_) {}
  $$('.sent-axis-btn').forEach(b => b.classList.toggle('active', b.dataset.axis === axis));
  const rc = $('#btn-sent-recompute');
  if (rc) rc.classList.toggle('hidden', axis !== 'project');
  const head = $('.sent-tree-pane .mlp-head span');
  if (head) head.innerHTML = axis === 'project'
    ? '프로젝트 <span id="sent-proj-count" class="fld-count">0</span>'
    : (axis === 'date' ? '연도 · 월' : '이벤트 · 테마');
  loadSentAxis(true);
}

async function loadSentAxis(force = false) {
  if (sentAxisMode === 'project') { loadSentTree(force); return; }
  const box = $('#sent-tree');
  if (!box) return;
  if (!force && sentAxisCache.axis === sentAxisMode && sentAxisCache.groups.length) { renderSentAxisTree(); return; }
  box.innerHTML = '<div class="empty-sm">보낸메일을 집계 중…</div>';
  try {
    const t0 = Date.now();
    const res = await window.api.sentAxis(sentAxisMode, force);
    if (!res || !res.ok) { box.innerHTML = `<div class="empty-sm">집계 실패: ${escapeHtml((res && res.error) || '알 수 없음')}</div>`; return; }
    sentAxisCache = { axis: sentAxisMode, groups: res.groups || [], total: res.total || 0, ms: Date.now() - t0 };
    renderSentAxisTree();
  } catch (err) {
    box.innerHTML = `<div class="empty-sm">${escapeHtml(String(err))}</div>`;
  }
}

function renderSentAxisTree() {
  const box = $('#sent-tree');
  if (!box) return;
  const groups = sentAxisCache.groups || [];
  if (!groups.length) { box.innerHTML = '<div class="empty-sm">보낸 메일이 없습니다.</div>'; return; }
  let html = '';
  if (sentAxisCache.axis === 'date') {
    for (const y of groups) {
      html += `<div class="st-group">
        <button class="st-proj" type="button" data-yr="${y.year}">
          ${icon('folder', 13, 'st-ic')}<span class="st-name">${y.year}년</span>
          <span class="st-cnt">${y.cnt}</span></button>
        <div class="st-children">${y.months.map(m => `
          <button class="st-org" type="button" data-yr="${m.year}" data-mo="${m.month}">
            <span class="st-name">${m.month}월</span><span class="st-cnt">${m.cnt}</span></button>`).join('')}</div>
      </div>`;
    }
  } else {
    for (const g of groups) {
      html += `<div class="st-group">
        <button class="st-proj" type="button" data-ev="${escapeHtml(g.key)}">
          ${icon('flag', 13, 'st-ic')}<span class="st-name">${escapeHtml(g.label)}</span>
          <span class="st-cnt">${g.cnt}</span></button>
      </div>`;
    }
  }
  box.innerHTML = html;
  // 클릭 → 가운데 목록에 해당 메일을 뿌린다 (기존 renderSentMails 재사용)
  box.querySelectorAll('[data-ev]').forEach(b => b.addEventListener('click', () => {
    const g = (sentAxisCache.groups || []).find(x => x.key === b.dataset.ev);
    if (!g) return;
    box.querySelectorAll('.st-proj,.st-org').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    sentCurrent = { mode: 'axis', mails: g.mails };
    $('#sent-list-title').textContent = `${g.label} · ${g.cnt}건`;
    renderSentMails(sortSentArray(g.mails));
  }));
  box.querySelectorAll('[data-mo]').forEach(b => b.addEventListener('click', () => {
    const y = (sentAxisCache.groups || []).find(x => String(x.year) === b.dataset.yr);
    const m = y && y.months.find(x => String(x.month) === b.dataset.mo);
    if (!m) return;
    box.querySelectorAll('.st-proj,.st-org').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    sentCurrent = { mode: 'axis', mails: m.mails };
    $('#sent-list-title').textContent = `${m.year}년 ${m.month}월 · ${m.cnt}건`;
    renderSentMails(sortSentArray(m.mails));
  }));
  box.querySelectorAll('[data-yr]:not([data-mo])').forEach(b => b.addEventListener('click', () => {
    const y = (sentAxisCache.groups || []).find(x => String(x.year) === b.dataset.yr);
    if (!y) return;
    const mails = y.months.flatMap(m => m.mails);
    box.querySelectorAll('.st-proj,.st-org').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    sentCurrent = { mode: 'axis', mails };
    $('#sent-list-title').textContent = `${y.year}년 · ${y.cnt}건`;
    renderSentMails(sortSentArray(mails));
  }));
  const sum = $('#sent-summary');
  if (sum) {
    sum.innerHTML =
      `<span class="ss-chip">${icon(sentAxisCache.axis === 'date' ? 'clock' : 'flag', 12)}${sentAxisCache.axis === 'date' ? '연도' : '이벤트'} <b>${groups.length}</b></span>` +
      `<span class="ss-chip">${icon('send', 12)}보낸 메일 <b>${(sentAxisCache.total || 0).toLocaleString()}</b></span>` +
      `<span class="ss-chip ss-dim">${icon('clock', 12)}집계 ${sentAxisCache.ms}ms</span>`;
  }
}

// ------------------------------------------------------------
//  보낸편지함 정렬 상태 + 현재 선택 (분류 뷰에서도 시간순 정렬을 쓰기 위함)
// ------------------------------------------------------------
let sentSort = { by: 'date', dir: 'desc' };
// 지금 중앙 목록이 무엇을 보여 주는지 — 정렬을 바꾸면 이 기준으로 다시 불러온다
let sentCurrent = { mode: 'none' };

function sortSentArray(mails) {
  const arr = [...(mails || [])];
  const dir = sentSort.dir === 'asc' ? 1 : -1;
  const txt = (v) => String(v || '').toLowerCase();
  arr.sort((a, b) => {
    if (sentSort.by === 'recipient') return txt(a.recipients).localeCompare(txt(b.recipients), 'ko') * dir;
    if (sentSort.by === 'subject') return txt(a.subject).localeCompare(txt(b.subject), 'ko') * dir;
    return ((a.received_ts || 0) - (b.received_ts || 0)) * dir;
  });
  return arr;
}

// 현재 선택을 정렬만 바꿔 다시 그린다 (트리·읽기창은 그대로 유지)
async function reloadSentList() {
  const c = sentCurrent;
  if (c.mode === 'all') return selectSentAll();
  if (c.mode === 'org') return selectSentByOrg(c.project, c.org);
  if (c.mode === 'project') return selectSent(c.project, c.toFirst, c.title);
  if (c.mode === 'thread' && c.mails) return renderSentMails(c.mails);
  if (c.mode === 'axis' && c.mails) return renderSentMails(sortSentArray(c.mails));
  if (c.mode === 'flat') return loadSentFlatList();
}

// 트리 최상단 '전체 보낸 메일' — 분류 뷰를 벗어나지 않고 전체를 시간순으로 본다
async function selectSentAll() {
  sentCurrent = { mode: 'all' };
  const list = $('#sent-mail-list');
  if (!list) return;
  list.innerHTML = '<div class="empty">불러오는 중...</div>';
  $('#sent-list-title').textContent = '전체 보낸 메일';
  $$('#sent-tree .st-proj.active, #sent-tree .st-org.active').forEach(x => x.classList.remove('active'));
  const allBtn = $('#sent-all-node');
  if (allBtn) allBtn.classList.add('active');
  try {
    const res = await window.api.dbSearchMails({
      query: '', limit: 500, folder: 'Sent',
      sortBy: sentSort.by === 'recipient' ? 'sender' : sentSort.by,   // DB 정렬 키 매핑
      sortDir: sentSort.dir
    });
    if (!res.ok) { list.innerHTML = `<div class="empty">${escapeHtml(res.error)}</div>`; return; }
    renderSentMails(res.mails || []);
  } catch (err) { list.innerHTML = `<div class="empty">${escapeHtml(String(err))}</div>`; }
}

// 보낸 편지함 전체 평면 목록 (날짜순)
async function loadSentFlatList() {
  sentCurrent = { mode: 'flat' };
  const list = $('#sent-mail-list');
  if (!list) return;
  list.innerHTML = '<div class="empty">불러오는 중...</div>';
  $('#sent-list-title').textContent = '보낸 편지함 (전체)';
  try {
    const res = await window.api.dbSearchMails({ query: '', limit: 300, folder: 'Sent', sortBy: 'date', sortDir: 'desc' });
    if (!res.ok) { list.innerHTML = `<div class="empty">${escapeHtml(res.error)}</div>`; return; }
    renderSentMails(res.mails || []);
    renderSentSummary();
  } catch (err) { list.innerHTML = `<div class="empty">${escapeHtml(String(err))}</div>`; }
}

let sentPeriod = { from: '', to: '' };
let sentRecipCount = null;

async function loadSentTree(force = false) {
  const box = $('#sent-tree');
  if (!box) return;
  if (sentTreeCache.length && !force) { renderSentTree(); return; }
  box.innerHTML = '<div class="empty-sm">프로젝트를 집계 중...</div>';
  try {
    const res = await window.api.projectTree();
    if (!res.ok) { box.innerHTML = `<div class="empty-sm">${escapeHtml(res.error)}</div>`; return; }
    sentTreeCache = res.projects || [];
    const cnt = $('#sent-proj-count');
    if (cnt) cnt.textContent = sentTreeCache.length;
    // 기간: 프로젝트별 최신 시각의 최소~최대
    const ts = sentTreeCache.map(p => p.lastTs).filter(Boolean);
    if (ts.length) {
      const f = new Date(Math.min(...ts)), t = new Date(Math.max(...ts));
      const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      sentPeriod = { from: fmt(f), to: fmt(t) };
    }
    renderSentTree();
    renderSentSummary();
  } catch (err) {
    box.innerHTML = `<div class="empty-sm">${escapeHtml(String(err))}</div>`;
  }
}

function fmtLastDay(ts) {
  if (!ts) return '';
  const d = new Date(ts), now = new Date();
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`;
  return `${String(d.getFullYear()).slice(2)}/${d.getMonth() + 1}/${d.getDate()}`;
}

// 그룹(프로젝트·조직·스레드)의 활동성 구간 — 마스터: "2년 전 프로젝트가 앞에 오면 안 된다. 진행 중이 최우선"
//  live  = 최근 projectActiveDays(기본 90일) 안에 활동 → 최상단·강조
//  recent= projectRecentDays(기본 365일) 안에 활동 → 그 다음
//  stale = 그보다 오래됨 → 접힘 그룹 '지난 프로젝트'
function activityBand(lastTs) {
  const now = Date.now();
  const liveDays = Number(config.projectActiveDays) > 0 ? Number(config.projectActiveDays) : 90;
  const recentDays = Number(config.projectRecentDays) > 0 ? Number(config.projectRecentDays) : 365;
  const age = (now - (lastTs || 0)) / 864e5;
  if (age <= liveDays) return 'live';
  if (age <= recentDays) return 'recent';
  return 'stale';
}
// 구간 → CSS 클래스. 클래스명을 리터럴로 적어 고아 스캐너가 사용처를 찾을 수 있게 한다.
function bandClass(lastTs) {
  const b = activityBand(lastTs);
  return b === 'live' ? 'st-live' : (b === 'recent' ? 'st-recent' : 'st-stale');
}
// 모든 그룹 노드 공통 정렬 — 최근 활동일 내림차순 (건수순 금지)
function sortByLastActivity(arr) {
  return [...(arr || [])].sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
}

// ★ 트리 = 프로젝트 → 상대 조직 → 스레드(제목) → 메일
//   정렬은 전부 '최근 활동순'. 활동성 구간으로 나눠 진행 중 프로젝트를 항상 위에 둔다.
function renderSentTree() {
  const box = $('#sent-tree');
  if (!sentTreeCache.length) { box.innerHTML = '<div class="empty-sm">보낸 메일이 없습니다. 동기화를 먼저 실행하세요.</div>'; return; }
  const live = [], recent = [], stale = [];
  for (const p of sortByLastActivity(sentTreeCache)) {
    const b = activityBand(p.lastTs);
    (b === 'live' ? live : b === 'recent' ? recent : stale).push(p);
  }
  const projRow = (p) => `
    <div class="st-group" data-project="${escapeHtml(p.project)}">
      <button class="st-proj ${bandClass(p.lastTs)}" title="마지막 활동 ${escapeHtml(fmtLastDay(p.lastTs))}">
        <span class="st-caret">▶</span>
        ${icon('folder', 13, 'tree-ic')}
        <span class="st-name">${escapeHtml(p.project)}</span>
        <span class="st-last">${escapeHtml(fmtLastDay(p.lastTs))}</span>
        <span class="st-cnt">${p.cnt}</span>
      </button>
      <div class="st-orgs hidden"></div>
    </div>`;
  const section = (id, title, arr, open = false) => arr.length ? `
    <div class="st-section">
      <button class="st-sec-head" data-sec="${id}"><span class="st-caret">${open ? '▼' : '▶'}</span>${escapeHtml(title)} <span class="st-cnt">${arr.length}</span></button>
      <div class="st-sec-body${open ? '' : ' hidden'}">${arr.map(projRow).join('')}</div>
    </div>` : '';

  // ★ 최상단 '전체 보낸 메일' — 분류를 유지한 채 전체 시간 흐름으로 돌아올 수 있는 진입점.
  //   ([목록 보기] 토글로 뷰를 바꿔야만 전체를 보던 번거로움 해소)
  const totalCnt = sentTreeCache.reduce((a, p) => a + (p.cnt || 0), 0);
  const allNode = `
    <button class="st-proj st-all" id="sent-all-node" title="프로젝트 구분 없이 전체를 날짜순으로 봅니다">
      ${icon('mail', 13, 'tree-ic')}
      <span class="st-name">전체 보낸 메일</span>
      <span class="st-cnt">${totalCnt.toLocaleString()}</span>
    </button>`;

  const liveDays = Number(config.projectActiveDays) > 0 ? Number(config.projectActiveDays) : 90;
  const recentDays = Number(config.projectRecentDays) > 0 ? Number(config.projectRecentDays) : 365;
  box.innerHTML = allNode
    + live.map(projRow).join('')
    + section('recent', `최근 (${liveDays}일~${recentDays}일)`, recent, true)
    + section('stale', `지난 프로젝트 (${recentDays}일 경과)`, stale, false);

  const allBtn = box.querySelector('#sent-all-node');
  if (allBtn) allBtn.addEventListener('click', () => selectSentAll());

  // 섹션 접기/펼치기
  box.querySelectorAll('.st-sec-head').forEach(h => h.addEventListener('click', () => {
    const body = h.nextElementSibling;
    const open = !body.classList.contains('hidden');
    body.classList.toggle('hidden', open);
    h.querySelector('.st-caret').textContent = open ? '▶' : '▼';
  }));

  // 프로젝트 → 조직 지연 로드
  box.querySelectorAll('.st-group').forEach(g => {
    const project = g.dataset.project;
    const head = g.querySelector('.st-proj');
    const orgsBox = g.querySelector('.st-orgs');
    head.addEventListener('click', async () => {
      selectSent(project, undefined, project);
      box.querySelectorAll('.st-proj,.st-org,.st-thread').forEach(x => x.classList.remove('active'));
      head.classList.add('active');
      const caret = head.querySelector('.st-caret');
      if (!orgsBox.classList.contains('hidden')) { orgsBox.classList.add('hidden'); caret.textContent = '▶'; return; }
      caret.textContent = '▼'; orgsBox.classList.remove('hidden');
      if (orgsBox.dataset.loaded === '1') return;
      orgsBox.innerHTML = '<div class="empty-sm st-loading">상대 조직 집계 중...</div>';
      const r = await window.api.projectOrgs(project);
      if (!r.ok) { orgsBox.innerHTML = `<div class="empty-sm">${escapeHtml(r.error)}</div>`; return; }
      const orgs = sortByLastActivity(r.orgs || []);   // 최근 활동일 내림차순 (건수순 금지)
      orgsBox.innerHTML = orgs.map(o => `
        <div class="st-orgwrap" data-org="${escapeHtml(o.org)}">
          <button class="st-org ${bandClass(o.lastTs)}" title="마지막 활동 ${escapeHtml(fmtLastDay(o.lastTs))}">
            <span class="st-caret">▶</span>${icon('group', 12, 'tree-ic')}
            <span class="st-name">${escapeHtml(o.org)}</span>
            <span class="st-last">${escapeHtml(fmtLastDay(o.lastTs))}</span>
            <span class="st-cnt">${o.cnt}</span>
          </button>
          <div class="st-threads hidden"></div>
        </div>`).join('') || '<div class="empty-sm">상대 조직 정보가 없습니다.</div>';
      orgsBox.dataset.loaded = '1';

      // 조직 → 스레드 지연 로드
      orgsBox.querySelectorAll('.st-orgwrap').forEach(ow => {
        const org = ow.dataset.org;
        const ob = ow.querySelector('.st-org');
        const tb = ow.querySelector('.st-threads');
        ob.addEventListener('click', async (e) => {
          e.stopPropagation();
          box.querySelectorAll('.st-proj,.st-org,.st-thread').forEach(x => x.classList.remove('active'));
          ob.classList.add('active');
          selectSentByOrg(project, org);
          const c = ob.querySelector('.st-caret');
          if (!tb.classList.contains('hidden')) { tb.classList.add('hidden'); c.textContent = '▶'; return; }
          c.textContent = '▼'; tb.classList.remove('hidden');
          if (tb.dataset.loaded === '1') return;
          tb.innerHTML = '<div class="empty-sm st-loading">스레드 집계 중...</div>';
          const tr = await window.api.projectThreads(project, org);
          if (!tr.ok) { tb.innerHTML = `<div class="empty-sm">${escapeHtml(tr.error)}</div>`; return; }
          const th = sortByLastActivity(tr.threads || []);   // 스레드 대표 시각 = 그룹 내 최신
          tb.innerHTML = th.map(t => `
            <button class="st-thread ${bandClass(t.lastTs)}" data-tkey="${escapeHtml(t.tkey)}" title="마지막 활동 ${escapeHtml(fmtLastDay(t.lastTs))}">
              ${icon('mail', 11, 'tree-ic')}
              <span class="st-name">${escapeHtml(t.subject || '(제목 없음)')}</span>
              ${t.cnt > 1 ? `<span class="thread-badge">${t.cnt}</span>` : ''}
              <span class="st-last">${escapeHtml(fmtLastDay(t.lastTs))}</span>
            </button>`).join('') || '<div class="empty-sm">스레드가 없습니다.</div>';
          tb.dataset.loaded = '1';
          tb.querySelectorAll('.st-thread').forEach(b => b.addEventListener('click', async (ev) => {
            ev.stopPropagation();
            box.querySelectorAll('.st-proj,.st-org,.st-thread').forEach(x => x.classList.remove('active'));
            b.classList.add('active');
            const mr = await window.api.projectThreadMails(b.dataset.tkey, project, org);
            if (!mr.ok) return;
            $('#sent-list-title').textContent = `${project} › ${org} › ${b.querySelector('.st-name').textContent.trim().slice(0, 30)}`;
            sentCurrent = { mode: 'thread', project, org, mails: mr.mails || [] };
            renderSentMails(mr.mails || []);
          }));
        });
      });
    });
  });
}

// 조직 단위 메일 목록
async function selectSentByOrg(project, org) {
  sentCurrent = { mode: 'org', project, org };
  const list = $('#sent-mail-list');
  list.innerHTML = '<div class="empty">불러오는 중...</div>';
  $('#sent-list-title').textContent = `${project} › ${org}`;
  try {
    const r = await window.api.projectThreads(project, org);
    if (!r.ok) { list.innerHTML = `<div class="empty">${escapeHtml(r.error)}</div>`; return; }
    // 조직 단위는 스레드 전체의 메일을 합쳐 보여준다(최신순)
    const all = [];
    for (const t of (r.threads || []).slice(0, 40)) {
      const mr = await window.api.projectThreadMails(t.tkey, project, org);
      if (mr.ok) all.push(...(mr.mails || []));
    }
    all.sort((a, b) => (b.received_ts || 0) - (a.received_ts || 0));
    renderSentMails(all.slice(0, 300));
  } catch (err) { list.innerHTML = `<div class="empty">${escapeHtml(String(err))}</div>`; }
}

async function selectSent(project, toFirst, title) {
  sentSel = { project, toFirst };
  sentCurrent = { mode: 'project', project, toFirst, title };
  const list = $('#sent-mail-list');
  list.innerHTML = '<div class="empty">불러오는 중...</div>';
  $('#sent-list-title').textContent = title || project;
  try {
    const res = await window.api.projectMails(project, toFirst, 300);
    if (!res.ok) { list.innerHTML = `<div class="empty">${escapeHtml(res.error)}</div>`; return; }
    renderSentMails(res.mails || []);
  } catch (err) {
    list.innerHTML = `<div class="empty">${escapeHtml(String(err))}</div>`;
  }
}

// 보낸메일 목록 렌더 (분류/목록 보기 공용)
//  ★ 분류 뷰에서도 '시간 흐름'을 잃지 않도록 날짜 그룹 헤더를 붙인다(받은편지함과 동일 규칙).
//    날짜 정렬일 때만 의미가 있으므로 수신인·제목 정렬에서는 헤더를 생략한다.
function renderSentMails(mails) {
  const list = $('#sent-mail-list');
  const sorted = sortSentArray(mails);
  sentMailCache = sorted;              // [엑셀] 버튼이 지금 보이는 목록 그대로 내보내도록
  $('#sent-list-count').textContent = sorted.length;
  if (!sorted.length) { list.innerHTML = '<div class="empty">해당 조건의 보낸 메일이 없습니다.</div>'; return; }
  list.innerHTML = '';
  {
    const useDateHeaders = sentSort.by === 'date';
    let lastGroup = null;
    sorted.forEach(m => {
      if (useDateHeaders) {
        const g = dateGroup(m.received_at || '');
        if (g !== lastGroup) {
          lastGroup = g;
          const gh = document.createElement('div');
          gh.className = 'date-group';
          gh.innerHTML = `<span class="dg-name">${escapeHtml(g)}</span>`;
          list.appendChild(gh);
        }
      }
      const item = document.createElement('div');
      item.className = 'mail-item';
      item.innerHTML = `
        <div class="mi-row1">
          <span class="mi-sender">${escapeHtml(m.recipients || '(수신인 없음)')}</span>
          <span class="mi-right">
            ${m.has_attach ? `<span class="mi-clip" title="첨부 있음">${icon('clip', 12)}</span>` : ''}
            <span class="mi-date">${escapeHtml(shortDate(m.received_at || ''))}</span>
          </span>
        </div>
        <div class="mi-subject">${escapeHtml(m.subject || '(제목 없음)')}</div>
        <div class="mi-preview">${escapeHtml((m.preview || '').replace(/\s+/g, ' ').slice(0, 110))}
          <span class="mi-tags"><span class="vf-tag">${escapeHtml(m.project || '기타')}</span></span></div>`;
      item.addEventListener('click', () => {
        $$('#sent-mail-list .mail-item').forEach(x => x.classList.remove('selected'));
        item.classList.add('selected');
        useReadingPane('sent');          // 분류 뷰 우측 읽기창에 표시
        openMailDetail(m);
      });
      // 우클릭 → 프로젝트 지정
      item.addEventListener('contextmenu', (e) => { e.preventDefault(); showProjectMenu(e, m); });
      list.appendChild(item);
    });
  }
}

// 메일 우클릭 → 프로젝트 지정 (같은 말머리는 규칙으로 학습해 이후 자동 적용)
async function showProjectMenu(e, mail) {
  let projects = [];
  try {
    const r = await window.api.projectRules({});
    if (r.ok) projects = (r.projects || []).slice(0, 15);
  } catch (_) {}
  const items = [
    { label: `현재 프로젝트: ${mail.project || '기타'}`, disabled: true },
    { sep: true },
    ...projects.filter(p => p !== mail.project).map(p => ({
      label: `프로젝트 지정 › ${p}`,
      action: () => assignProject(mail, p)
    })),
    { sep: true },
    { label: '새 프로젝트 이름으로 지정…', action: async () => {
        const name = await inputDialog('프로젝트 지정', '프로젝트 이름', mail.project || '');
        if (name) assignProject(mail, name);
      } }
  ];
  showContextMenu(e, items);
}

async function assignProject(mail, project) {
  const res = await window.api.projectSetMail(mail.id, project, true);
  if (!res.ok) { alert('프로젝트 지정 실패: ' + res.error); return; }
  const msg = res.learned
    ? `"${project}" 로 지정했습니다.\n말머리 "${res.learned}" 규칙을 학습해 같은 패턴의 메일에 자동 적용됩니다.`
    : `"${project}" 로 지정했습니다.`;
  alert(msg);
  await loadSentTree(true);
  if (sentSel.project) selectSent(sentSel.project, sentSel.toFirst, $('#sent-list-title').textContent);
}

//  allFolders=true 면 받은메일까지 전부 분류한다(대시보드 프로젝트 축을 쓰려면 필수).
async function recomputeProjectsUI(allFolders = false) {
  const box = $('#sent-tree');
  if (box) box.innerHTML = '<div class="empty-sm">제목·폴더·스레드 기준으로 다시 분류 중...</div>';
  showLoading(allFolders ? '전체 메일 프로젝트 다시 분류 중... (30초쯤 걸립니다)' : '보낸메일 프로젝트 다시 분류 중...');
  try {
    const res = await window.api.projectRecompute(allFolders === true);
    hideLoading();
    if (!res.ok) { if (box) box.innerHTML = `<div class="empty-sm">${escapeHtml(res.error)}</div>`; return; }
    await loadSentTree(true);
    alert(`다시 분류 완료 (${res.allFolders ? '전체 메일' : '보낸메일'})\n\n• 대상 ${res.total.toLocaleString()}건\n• 프로젝트 ${res.projects}개\n• 기타 ${res.etc.toLocaleString()}건 (${res.etcRatio}%)`);
  } catch (err) {
    hideLoading();
    box.innerHTML = `<div class="empty-sm">${escapeHtml(String(err))}</div>`;
  }
}

// ============================================================
//  회신 대기 전용 뷰 (기본 3일 이상 미회신)
// ============================================================
let followupMinDays = 3;
// ★ 전역 정렬 원칙: 기본 = 날짜 최신순. 화면에서 바꾼 값은 저장하지 않아 재시작 시 복귀한다.
let followupSort = 'date';

async function loadFollowup() {
  const box = $('#followup-list');
  if (!box) return;
  box.innerHTML = '<div class="empty">확인 중...</div>';
  try {
    const senderQuery = ($('#fu-sender') && $('#fu-sender').value.trim()) || '';
    // 최근 30일 안에서 'N일 이상 경과' 대화만 추린다.
    //  (90일까지 열면 오래된 건이 상한을 다 차지해 '지금 챙길 것'이 안 보인다 — 실측 확인)
    const res = await window.api.dbUnanswered({ days: 30, limit: 200, minDays: followupMinDays, senderQuery, sort: followupSort });
    if (!res.ok) { box.innerHTML = `<div class="empty">${escapeHtml(res.error)}</div>`; return; }
    const mails = (res.mails || []).map(m => ({ ...m, fuSource: '미회신' }));

    // ★ Outlook 에서 깃발(후속 작업)을 단 메일을 같은 목록에 합친다 — 출처를 배지로 구분한다.
    //   (마스터 지시: 깃발/일정/작업은 새 화면을 만들지 말고 기존 화면에 통합)
    try {
      const fr = await window.api.extrasFlagged(false);
      if (fr.ok) {
        const seen = new Set(mails.map(m => m.id));
        const now = Date.now();
        for (const m of (fr.mails || [])) {
          if (seen.has(m.id)) {                      // 둘 다 해당하면 출처를 병기
            const t = mails.find(x => x.id === m.id);
            if (t) t.fuSource = '미회신 · Outlook 깃발';
            continue;
          }
          if (senderQuery && !`${m.sender_name || ''} ${m.sender_email || ''}`.toLowerCase().includes(senderQuery.toLowerCase())) continue;
          mails.push({
            ...m, fuSource: 'Outlook 깃발',
            daysWaiting: Math.max(0, Math.floor((now - (m.received_ts || now)) / 864e5))
          });
        }
        // 합친 뒤 다시 현재 정렬 기준으로 줄 세운다(역전 방지)
        if (followupSort === 'waiting') mails.sort((a, b) => (a.received_ts || 0) - (b.received_ts || 0));
        else mails.sort((a, b) => (b.received_ts || 0) - (a.received_ts || 0));
      }
    } catch (_) { /* 깃발 정보가 아직 없으면 미회신만 보여준다 */ }

    followupCache = mails;              // [엑셀] 버튼이 지금 보이는 목록 그대로 내보내도록
    const total = $('#fu-total'), cnt = $('#cnt-followup');
    if (!mails.length) {
      if (total) total.textContent = 0;
      if (cnt) cnt.textContent = 0;
      box.innerHTML = `<div class="empty">최근 30일 안에 ${followupMinDays}일 이상 회신 대기 중인 메일이 없습니다.${senderQuery ? ' (검색: ' + escapeHtml(senderQuery) + ')' : ''}</div>`;
      return;
    }
    // ★ 회신 필요성(의미) 버킷으로 화면을 나눈다 — SoT: db.unansweredMails() 가 붙여 준 replyBucket
    //   (reply-needed.js bucketOf() 파생). Outlook 깃발만으로 들어온 항목은 버킷이 없어 '필요'로 본다
    //   (명시적 후속작업 표시라 안전 쪽 기본값과 동일하게 취급).
    const needed = mails.filter(m => (m.replyBucket || 'needed') !== 'notneeded');
    const notNeeded = mails.filter(m => (m.replyBucket || 'needed') === 'notneeded');
    if (total) total.textContent = needed.length;
    if (cnt) cnt.textContent = needed.length;

    // 그룹 헤더는 정렬 기준을 따른다 — 날짜순이면 날짜 그룹(최신 위), 대기순이면 경과일 구간
    const bucketWait = (d) => d >= 14 ? '14일 이상 방치' : (d >= 7 ? '7~13일' : (d >= 3 ? '3~6일' : `${followupMinDays}~2일`));
    function renderItems(list) {
      let last = null, html = '';
      for (const m of list) {
        const b = followupSort === 'waiting' ? bucketWait(m.daysWaiting) : dateGroup(m.received_at);
        if (b !== last) { last = b; html += `<div class="date-group"><span class="dg-name">${escapeHtml(b)}</span></div>`; }
        const isNotNeeded = (m.replyBucket || 'needed') === 'notneeded';
        const reassignAct = isNotNeeded ? 'markNeeded' : 'markNotNeeded';
        const reassignTitle = isNotNeeded ? '회신 필요로 옮기기' : '회신 불필요로 옮기기';
        html += `<button class="fu-item" data-mid="${m.id}">
            <span class="fu-days ${m.daysWaiting >= 14 ? 'fu-hot' : ''}">${m.daysWaiting}일</span>
            <span class="fu-main">
              <span class="fu-subject">${importanceMarker(m)}${categoryDots(m)}${escapeHtml(m.subject || '(제목 없음)')}${actionBadge(m)}${m.replyUnclassified ? ' <span class="fu-unclassified-badge" title="아직 회신 필요성 판정 전 — 안전을 위해 필요 쪽에 두고 곧 자동 판정됩니다">판정 대기</span>' : (m.replyUncertain ? ' <span class="fu-uncertain-badge" title="LLM 판단 불확실(신뢰도 낮음) — 안전을 위해 필요 쪽에 둠">판단 불확실</span>' : '')}</span>
              <span class="fu-meta"><span class="fu-src">${escapeHtml(m.fuSource || '미회신')}</span>${escapeHtml(m.sender_name || m.sender_email || '')} · ${escapeHtml(m.received_at || '')} · ${escapeHtml(m.folder || '')}${m.has_attach ? ' · 첨부' : ''}${m.task_due ? ' · 기한 ' + escapeHtml(m.task_due) : ''}</span>
              <span class="fu-prev">${escapeHtml((m.preview || '').replace(/\s+/g, ' ').slice(0, 110))}</span>
              ${isNotNeeded && m.reply_needed_reason ? `<span class="fu-reason">불필요 이유: ${escapeHtml(m.reply_needed_reason)}${m.replyManual ? ' (수동 지정)' : ''}</span>` : ''}
            </span>
            <span class="fu-actions">
              <span class="fu-btn-sm" data-act="open" title="메일 열기">${icon('mailSearch', 13)}</span>
              <span class="fu-btn-sm" data-act="reply" title="Outlook 답장 열기">${icon('reply', 13)}</span>
              <span class="fu-btn-sm" data-act="${reassignAct}" title="${reassignTitle}">${isNotNeeded ? '↩' : '✕'}</span>
            </span>
          </button>`;
      }
      return html;
    }

    let html = renderItems(needed);
    if (notNeeded.length) {
      html += `<div class="fu-notneeded-toggle" id="fu-notneeded-toggle">
          <span>▸ 회신 불필요로 판단 <b>${notNeeded.length}</b>건 (펼치기)</span>
        </div>
        <div class="fu-notneeded-group hidden" id="fu-notneeded-group">${renderItems(notNeeded)}</div>`;
    }
    if (!needed.length) html = `<div class="empty">회신 필요로 판단된 메일이 없습니다.</div>` + html;
    box.innerHTML = html;

    const toggle = $('#fu-notneeded-toggle');
    if (toggle) toggle.addEventListener('click', () => {
      const grp = $('#fu-notneeded-group');
      const collapsed = grp.classList.toggle('hidden');
      toggle.querySelector('span').textContent = `${collapsed ? '▸' : '▾'} 회신 불필요로 판단 ${notNeeded.length}건 (${collapsed ? '펼치기' : '접기'})`;
    });

    box.querySelectorAll('.fu-item').forEach(b => {
      const id = parseInt(b.dataset.mid, 10);
      b.addEventListener('click', async (e) => {
        const act = e.target.closest('[data-act]');
        if (act && (act.dataset.act === 'markNeeded' || act.dataset.act === 'markNotNeeded')) {
          e.stopPropagation();
          const needsReply = act.dataset.act === 'markNeeded';
          await window.api.replySetManual(id, needsReply);
          await loadFollowup();
          return;
        }
        if (act && act.dataset.act === 'reply') {
          e.stopPropagation();
          const r = await window.api.dbGetMail(id);
          if (r.ok) { selectedMail = r.mail; await composeReply('reply'); }
          return;
        }
        // ★ 우측 읽기창에 바로 표시 (뷰 이동 없음 — 목록 위치 유지)
        box.querySelectorAll('.fu-item').forEach(x => x.classList.remove('selected'));
        b.classList.add('selected');
        useReadingPane('followup');
        await openMailDetail({ id });
      });
    });

    // ★ 회신 필요성 미분류 후보를 백그라운드로 채운다(초기 1회 + 신규 후보 증분 — 재판정 없음).
    //   결과가 생기면 목록만 조용히 새로고침한다(사용자 조작 방해 없음).
    if (mails.some(m => m.replyUnclassified)) {
      window.api.replyClassifyBatch({ days: 30, limit: 200, minDays: followupMinDays })
        .then(r => {
          const prog = $('#fu-classify-progress');
          if (prog) { prog.classList.add('hidden'); prog.textContent = ''; }
          if (r && r.ok && r.classified > 0 && $('#view-followup') && $('#view-followup').classList.contains('active')) loadFollowup();
        })
        .catch(() => { const prog = $('#fu-classify-progress'); if (prog) { prog.classList.add('hidden'); prog.textContent = ''; } });
    }
  } catch (err) {
    box.innerHTML = `<div class="empty">${escapeHtml(String(err))}</div>`;
  }
}

// ============================================================
//  일일 메일 브리핑 (날짜 선택 → 서술형 4섹션 · 날짜키 캐시)
// ============================================================
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function shiftDate(str, days) {
  const d = new Date(`${str}T12:00:00`);
  if (isNaN(d.getTime())) return todayStr();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function renderDailyBriefing(s, meta = {}) {
  const list = (arr) => arr.length
    ? `<ul class="db-list">${arr.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>`
    : '<div class="empty-sm">해당 내용이 없습니다.</div>';
  const sec = (title, iconName, inner, cls = '') =>
    `<section class="db-sec ${cls}"><h4 class="an-title">${icon(iconName, 14)}<span>${escapeHtml(title)}</span></h4>${inner}</section>`;
  const todos = s.todos.length
    ? `<ul class="an-actions">${s.todos.map(t => `<li><span class="an-task">${escapeHtml(t.task)}</span>
        ${t.owner ? `<span class="an-chip">${escapeHtml(t.owner)}</span>` : ''}
        ${t.due ? `<span class="an-chip an-due">${icon('clock', 11)}${escapeHtml(t.due)}</span>` : ''}</li>`).join('')}</ul>`
    : '<div class="empty-sm">이어서 할 일이 없습니다.</div>';
  const head = `<div class="db-head">
      <span class="an-lang">${escapeHtml(s.date || '')}</span>
      <span class="an-skip">메일 ${s.mailCount || meta.count || 0}건${meta.cached ? ' · 저장된 브리핑' : ''}${meta.createdAt ? ' · ' + escapeHtml(meta.createdAt) : ''}</span>
    </div>`;
  return `<div class="daily-card">${head}
      ${sec('요약', 'chart', list(s.summary))}
      ${sec('받은 것', 'inbox', list(s.received))}
      ${sec('보낸 것', 'send', list(s.sent))}
      ${sec('할 일', 'flag', todos, 'db-todo')}
    </div>`;
}

function dailyToText(s) {
  const L = [`[일일 브리핑] ${s.date}`, ''];
  const push = (t, arr) => { if (arr.length) { L.push(`■ ${t}`); arr.forEach(x => L.push(`  - ${x}`)); L.push(''); } };
  push('요약', s.summary); push('받은 것', s.received); push('보낸 것', s.sent);
  if (s.todos.length) { L.push('■ 할 일'); s.todos.forEach(t => L.push(`  - ${t.task}${t.owner ? ' / ' + t.owner : ''}${t.due ? ' / ' + t.due : ''}`)); }
  return L.join('\n');
}

let lastDailyText = '';
async function runDailyBriefing(force = false) {
  if (needKey()) return;
  const date = ($('#daily-date') && $('#daily-date').value) || todayStr();
  const box = $('#daily-result');
  const st = $('#daily-status');
  box.innerHTML = '<div class="empty">브리핑을 준비하는 중...</div>';
  if (st) st.textContent = '';
  showLoading(`${date} 브리핑 생성 중...`);
  try {
    const res = await window.api.aiDailyBriefing(date, force);
    hideLoading();
    if (!res.ok) { noteAiResult(res); box.innerHTML = aiErrorHtml(res); bindAiErrorActions(box); return; }
    if (res.structured) {
      lastDailyText = dailyToText(res.structured);
      box.innerHTML = renderDailyBriefing(res.structured, { cached: res.cached, createdAt: res.createdAt, count: res.count });
      if (st) st.textContent = res.cached ? '저장된 브리핑' : `새로 생성 (묶음 ${res.chunks || 1}${res.concurrency > 1 ? `, ${res.concurrency}개 동시` : ''})`;
    } else {
      lastDailyText = res.content || '';
      box.innerHTML = `<div class="briefing-body">${formatAnswer(res.content || '')}</div>`;
    }
    loadDailyDates();
  } catch (err) {
    hideLoading();
    box.innerHTML = `<div class="empty">${escapeHtml(String(err))}</div>`;
  }
}

// 브리핑이 저장된 날짜 목록 (클릭하면 즉시 조회)
async function loadDailyDates() {
  const el = $('#daily-dates');
  if (!el) return;
  try {
    const res = await window.api.aiDailyBriefingDates();
    if (!res.ok || !(res.dates || []).length) { el.textContent = '저장된 브리핑이 없습니다.'; return; }
    el.innerHTML = '저장된 브리핑: ' + res.dates.slice(0, 14).map(d =>
      `<button class="daily-chip" data-d="${escapeHtml(d.d)}">${escapeHtml(d.d)}</button>`).join(' ');
    el.querySelectorAll('.daily-chip').forEach(b => b.addEventListener('click', () => {
      $('#daily-date').value = b.dataset.d;
      runDailyBriefing(false);
    }));
  } catch (_) { el.textContent = ''; }
}

// ============================================================
//  업무일지 (메일 근거 날짜별 업무 기록)
// ============================================================
let workLogMode = 'week';
let lastWorkLogText = '';

function renderWorkLog(s) {
  const esc = escapeHtml;
  const list = (arr, cls) => arr.length
    ? `<ul class="wl-list ${cls}">${arr.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`
    : '<div class="empty-sm">없음</div>';
  // ★ 전역 정렬 원칙: 날짜 내림차순(최신 위). AI 출력 순서를 그대로 믿지 않고 여기서 강제한다.
  const days = [...(s.days || [])]
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .map(d => `
    <section class="wl-day">
      <h4 class="wl-date">${icon('clock', 13)}<span>${esc(d.date)}</span>
        ${d.projects.length ? `<span class="wl-proj">${d.projects.map(p => `<span class="wl-chip">${esc(p)}</span>`).join('')}</span>` : ''}
      </h4>
      <div class="wl-cols">
        <div class="wl-col"><h5>${icon('check', 12)}한 일</h5>${list(d.done, 'wl-done')}</div>
        <div class="wl-col"><h5>${icon('mailSearch', 12)}접수한 요청</h5>${list(d.received, 'wl-recv')}</div>
        ${d.pending.length ? `<div class="wl-col"><h5>${icon('flag', 12)}미결</h5>${list(d.pending, 'wl-pending')}</div>` : ''}
      </div>
    </section>`).join('');
  const open = s.openItems.length
    ? `<section class="wl-open"><h4>${icon('flag', 13)}<span>미결 업무 (${s.openItems.length})</span></h4>
        <ul class="an-actions">${s.openItems.map(o => `<li><span class="an-task">${esc(o.task)}</span>
          ${o.owner ? `<span class="an-chip">${esc(o.owner)}</span>` : ''}
          ${o.due ? `<span class="an-chip an-due">${icon('clock', 11)}${esc(o.due)}</span>` : ''}</li>`).join('')}</ul></section>`
    : '';
  const sum = s.summary.length
    ? `<section class="wl-summary"><h4>${icon('chart', 13)}<span>기간 총평</span></h4>${list(s.summary, '')}</section>`
    : '';
  return `<div class="worklog-card">
      <div class="wl-head"><span class="an-lang">${esc(s.period)}</span><span class="an-skip">${s.days.length}일치 기록</span></div>
      ${sum}${days}${open}
    </div>`;
}

// 복사용 평문 변환
function workLogToText(s) {
  const L = [`[업무일지] ${s.period}`, ''];
  s.summary.forEach(x => L.push(`- ${x}`));
  if (s.summary.length) L.push('');
  [...(s.days || [])].sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).forEach(d => {
    L.push(`■ ${d.date}${d.projects.length ? ' (' + d.projects.join(', ') + ')' : ''}`);
    if (d.done.length) { L.push('  [한 일]'); d.done.forEach(x => L.push(`   - ${x}`)); }
    if (d.received.length) { L.push('  [접수한 요청]'); d.received.forEach(x => L.push(`   - ${x}`)); }
    if (d.pending.length) { L.push('  [미결]'); d.pending.forEach(x => L.push(`   - ${x}`)); }
    L.push('');
  });
  if (s.openItems.length) {
    L.push('■ 미결 업무');
    s.openItems.forEach(o => L.push(`   - ${o.task}${o.owner ? ` / ${o.owner}` : ''}${o.due ? ` / ${o.due}` : ''}`));
  }
  return L.join('\n');
}

async function generateWorkLog() {
  if (needKey()) return;
  const box = $('#worklog-result');
  box.innerHTML = '<div class="empty">메일 기록을 정리하는 중입니다...</div>';
  showLoading('업무일지 생성 중...');
  try {
    const res = await window.api.aiWorkLog(workLogMode);
    hideLoading();
    if (!res.ok) { noteAiResult(res); box.innerHTML = aiErrorHtml(res); bindAiErrorActions(box); return; }
    if (res.structured) {
      lastWorkLogText = workLogToText(res.structured);
      box.innerHTML = `<div class="briefing-meta">${escapeHtml(res.period)} · 분석 메일 ${res.count}건 · 키#${res.usedKeyIndex}</div>` + renderWorkLog(res.structured);
    } else {
      lastWorkLogText = res.content || '';
      box.innerHTML = `<div class="briefing-body">${formatAnswer(res.content)}</div>`;
    }
  } catch (err) {
    hideLoading();
    box.innerHTML = `<div class="empty">${escapeHtml(String(err))}</div>`;
  }
}

async function showWorkLogHistory() {
  const box = $('#worklog-result');
  box.innerHTML = '<div class="empty">지난 기록을 불러오는 중...</div>';
  try {
    const res = await window.api.aiWorkLogHistory(10);
    if (!res.ok) { box.innerHTML = `<div class="empty">${escapeHtml(res.error)}</div>`; return; }
    const items = res.items || [];
    if (!items.length) { box.innerHTML = '<div class="empty">저장된 업무일지가 없습니다.</div>'; return; }
    box.innerHTML = items.map((a, i) => {
      let inner;
      try {
        const o = JSON.parse(a.content);
        inner = (o && o.days) ? renderWorkLog({
          period: o.period || '', days: o.days || [], summary: o.summary || [], openItems: o.openItems || []
        }) : `<div class="briefing-body">${formatAnswer(a.content)}</div>`;
      } catch (_) { inner = `<div class="briefing-body">${formatAnswer(a.content)}</div>`; }
      return `<details${i === 0 ? ' open' : ''}><summary>${escapeHtml(a.created_at)}</summary>${inner}</details>`;
    }).join('');
  } catch (err) { box.innerHTML = `<div class="empty">${escapeHtml(String(err))}</div>`; }
}

// ============================================================
//  주소록
// ============================================================
async function importContacts() {
  showLoading('Outlook 주소록 가져오는 중...');
  try {
    const res = await window.api.contactsImport();
    hideLoading();
    if (res.ok) { alert(`주소록 ${res.imported}건을 가져왔습니다.`); loadContacts(''); loadStats(); }
    else alert('주소록 가져오기 실패: ' + res.error);
  } catch (err) { hideLoading(); alert('오류: ' + String(err)); }
}

// ★ 전역 정렬 원칙: 기본 = 마지막 연락일 최신순. 저장하지 않아 재시작 시 복귀한다.
let contactSort = 'recent';

async function loadContacts(query) {
  const list = $('#contact-list');
  list.innerHTML = '<div class="empty">불러오는 중...</div>';
  try {
    const res = await window.api.contactsList(query || '', 500, contactSort);
    if (!res.ok) { list.innerHTML = `<div class="empty">${escapeHtml(res.error)}</div>`; return; }
    const contacts = res.contacts || [];
    if (!contacts.length) { list.innerHTML = `<div class="empty">${icon('group', 20)} 주소록이 비어 있습니다.</div>`; return; }
    // 상단 요약 (개인/그룹 건수)
    try {
      const st = await window.api.contactsStats();
      if (st.ok) {
        const head = document.createElement('div');
        head.className = 'contact-summary';
        head.innerHTML = `${icon('person', 14)} 개인 <b>${st.stats.persons}</b>명 · ${icon('group', 14)} 그룹 <b>${st.stats.groups}</b>개 (멤버 ${st.stats.members}명)`;
        list.innerHTML = ''; list.appendChild(head);
      } else list.innerHTML = '';
    } catch (_) { list.innerHTML = ''; }

    contacts.forEach(c => {
      const isGroup = (c.ctype || c.type) === 'group';
      const item = document.createElement('div');
      item.className = 'contact-item' + (isGroup ? ' contact-group' : '');
      item.innerHTML = `
        <div class="contact-avatar ${isGroup ? 'ca-group' : ''}" style="background:${isGroup ? '#7719aa' : avatarColor(c.name || c.email)}">
          ${isGroup ? icon('group', 16) : escapeHtml(initials(c.name || c.email))}
        </div>
        <div class="contact-info">
          <div class="contact-name">${escapeHtml(c.name || '(이름 없음)')}${isGroup ? `<span class="grp-badge">그룹 ${c.member_count || 0}명</span>` : ''}</div>
          <div class="contact-sub">
            <span class="contact-disp">${escapeHtml(c.display_name || (isGroup ? '배포 목록' : c.name || ''))}</span>
            <span class="contact-email">${escapeHtml(c.email || (isGroup ? '' : '(주소 없음)'))}</span>
            ${c.lastTs ? `<span class="contact-last" title="마지막으로 주고받은 날">최근 ${escapeHtml(fmtLastDay(c.lastTs))}</span>` : ''}
          </div>
        </div>
        <div class="contact-actions">
          ${isGroup ? `<button class="contact-btn ci-expand" title="멤버 보기">${icon('chevronDown', 14)}</button>` : ''}
          <button class="contact-btn ci-search" title="이 상대의 메일 검색">${icon('mailSearch', 14)}</button>
        </div>
        <div class="grp-members hidden"></div>`;

      item.querySelector('.ci-search').addEventListener('click', (e) => {
        e.stopPropagation();
        const q = c.email || c.name;
        switchView('mail'); $('#global-search').value = q; loadMails(q);
      });
      if (isGroup) {
        item.querySelector('.ci-expand').addEventListener('click', async (e) => {
          e.stopPropagation();
          const box = item.querySelector('.grp-members');
          if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
          box.innerHTML = '<div class="empty-sm">불러오는 중...</div>';
          box.classList.remove('hidden');
          const mr = await window.api.contactsGroupMembers(c.id);
          const ms = (mr.ok && mr.members) ? mr.members : [];
          box.innerHTML = ms.length
            ? ms.map(m => `<div class="grp-member">${icon('person', 12)}<span class="gm-name">${escapeHtml(m.name || '')}</span><span class="gm-mail">${escapeHtml(m.email || '')}</span></div>`).join('')
            : '<div class="empty-sm">멤버 정보가 없습니다.</div>';
        });
      }
      list.appendChild(item);
    });
  } catch (err) { list.innerHTML = `<div class="empty">${escapeHtml(String(err))}</div>`; }
}

// ============================================================
//  메뉴 탭 (파일/홈/보내기·받기/폴더/보기/도움말)
//  ------------------------------------------------------------
//  탭을 누르면 해당 탭의 리본 그룹만 보이게 하고(show/hide),
//  탭이 다루는 상태값을 현재 config/DB 기준으로 새로 고쳐 준다.
//  ★ DOM 을 다시 만들지 않으므로 기존 리본 버튼 바인딩이 그대로 유지된다.
// ============================================================
let currentTab = 'home';
function switchTab(tab) {
  if (!tab) return;
  currentTab = tab;
  $$('.menu-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  $$('.ribbon-group').forEach(g => g.classList.toggle('hidden', g.dataset.ribbon !== tab));
  refreshTabState(tab);
}

async function refreshTabState(tab) {
  try {
    if (tab === 'file') {
      const s = await window.api.dbStatus();
      const st = await window.api.dbStats();
      $('#rbf-info').textContent = st.ok
        ? `메일 ${(st.stats.total || 0).toLocaleString()}건 · 주소록 ${st.stats.contacts || 0} · 첨부 ${st.stats.attachments || 0} · DB ${s.ready ? '정상' : '오류'}`
        : 'DB 정보를 읽을 수 없습니다';
    } else if (tab === 'sendrecv') {
      $('#rbs-attach').checked = config.saveAttachmentsOnSync !== false;
      $('#rbs-archive').checked = config.includeArchiveStores === true;
      const st = await window.api.dbStats();
      $('#rbs-lastsync').textContent = (st.ok && st.lastSyncAt)
        ? new Date(st.lastSyncAt).toLocaleString('ko-KR') : '기록 없음';
    } else if (tab === 'folder') {
      const label = currentFolder === 'all' ? '전체 메일'
        : (currentFolder === '__attach' ? '첨부 있는 메일' : currentFolder);
      $('#rbd-info').textContent = label || '전체 메일';
    } else if (tab === 'view') {
      $('#rbv-thread').checked = !!($('#filter-thread') && $('#filter-thread').checked);
      $('#rbv-attach').checked = !!($('#filter-attach') && $('#filter-attach').checked);
    } else if (tab === 'help') {
      $('#rbh-version').textContent = 'Bmail v' + (await window.api.getVersion());
    }
  } catch (_) { /* 탭 상태 표시는 실패해도 탭 전환 자체는 유지 */ }
}

// 폴더별 통계 (기존 byFolder 데이터 재사용)
async function showFolderStats() {
  switchView('dashboard');
  const box = $('#folder-stats');
  const wrap = $('#folder-stats-box');
  wrap.classList.remove('hidden');
  box.innerHTML = '<div class="empty-sm">집계 중...</div>';
  try {
    const r = await window.api.dbStats();
    if (!r.ok) { box.innerHTML = `<div class="empty-sm">${escapeHtml(r.error)}</div>`; return; }
    const entries = Object.entries(r.stats.byFolder || {}).sort((a, b) => b[1] - a[1]);
    if (!entries.length) { box.innerHTML = '<div class="empty-sm">데이터 없음</div>'; return; }
    box.innerHTML = entries.map(([f, c]) =>
      `<button class="sender-row folder-stat-row" data-folder="${escapeHtml(f)}"><span>${escapeHtml(f)}</span><span class="badge">${c}</span></button>`
    ).join('');
    box.querySelectorAll('.folder-stat-row').forEach(b => b.addEventListener('click', () => {
      currentFolder = b.dataset.folder;
      $('#mlp-title').textContent = b.dataset.folder;
      switchView('mail');
      loadMails($('#global-search').value);
    }));
  } catch (err) { box.innerHTML = `<div class="empty-sm">${escapeHtml(String(err))}</div>`; }
}

// 첨부 저장 폴더 열기 (파일 탭 / 관리자 진단 공용)
async function openAttachDir() {
  const s = await window.api.dbStatus();
  if (s && s.path) {
    const attachDir = s.path.replace(/[\\/][^\\/]+$/, '') + '/attachments';
    const r = await window.api.openPath(attachDir);
    if (r && !r.ok) alert('첨부 폴더를 열 수 없습니다: ' + (r.error || '경로 없음'));
  } else alert('DB 경로를 확인할 수 없습니다.');
}

function openHelp() { $('#help-modal').classList.remove('hidden'); }
function closeHelp() { $('#help-modal').classList.add('hidden'); }

// ============================================================
//  뷰 전환
// ============================================================
let contactsLoadedOnce = false;
// ============================================================
//  전역 AI 대화 패널 (마스터 2026-08-06: "어느 메뉴에서든 최상단에서 바로")
//  ------------------------------------------------------------
//  ponytail: 대화 UI 를 새로 만들지 않는다. '메일 검색' 뷰의 .chat-main 노드를
//            패널 안으로 **옮겨** 담는다 → 세션·이력·핸들러·백엔드가 저절로 공유되고
//            중복 구현이 0 이다. 닫으면 원래 자리로 되돌린다.
//  지연 초기화: 패널을 열기 전에는 아무 것도 로드하지 않는다(노드 이동 외 동작 없음).
// ============================================================
let gchatOpen = false;
let gchatCtxOn = true;            // 맥락 칩 사용 여부
function gchatHome() { return document.querySelector('#view-chat'); }
function gchatNode() { return document.querySelector('.chat-main'); }

// 지금 보고 있는 화면 → 대화에 실어 보낼 맥락
let gchatPinned = null;      // 분석/초안 등 사용자가 고정한 맥락
//  대화 대상: 'mail'(선택한 메일) | 'all'(전체 검색). 기본은 선택 메일 우선.
let chatScope = 'mail';
function setChatScope(scope) {
  chatScope = (scope === 'all') ? 'all' : 'mail';
  updateGchatCtx();
}

function currentChatContext() {
  //  분석/초안을 대화로 이어갈 때는 그것이 최우선 맥락이다
  if (gchatPinned) return gchatPinned;
  if (selectedMail && selectedMail.id) {
    const who = selectedMail.sender_name || selectedMail.sender_email || '';
    return {
      label: `선택한 메일 · ${(selectedMail.subject || '(제목 없음)').slice(0, 28)}`,
      text: `[현재 화면 맥락] 사용자가 열어 둔 메일\n제목: ${selectedMail.subject || ''}\n보낸사람: ${who}\n받은시각: ${selectedMail.received_at || ''}\n본문 요약: ${String(selectedMail.body || selectedMail.preview || '').replace(/\s+/g, ' ').slice(0, 1200)}`
    };
  }
  if (searchCond) {
    return { label: `검색 조건 · ${searchChipsText()}`, text: `[현재 화면 맥락] 사용자가 보고 있는 검색 결과 조건: ${searchChipsText()}` };
  }
  const view = document.querySelector('.view.active');
  const vid = view ? view.id.replace('view-', '') : 'mail';
  if (vid === 'sent') return { label: '보낸편지함 분류 뷰', text: '[현재 화면 맥락] 사용자가 보낸편지함 분류(프로젝트·날짜·이벤트) 화면을 보고 있다.' };
  if (vid === 'followup') return { label: '회신 대기 목록', text: '[현재 화면 맥락] 사용자가 회신 대기(미회신) 목록을 보고 있다.' };
  if (vid === 'todo') return { label: '할 일 목록', text: '[현재 화면 맥락] 사용자가 처리 상태(할 일/보류/처리/확인) 목록을 보고 있다.' };
  if (vid === 'dashboard') return { label: '대시보드', text: '[현재 화면 맥락] 사용자가 대시보드(통계·요약) 화면을 보고 있다.' };
  const f = currentFolder === 'all' ? '전체 메일' : (currentFolder === '__attach' ? '첨부 있는 메일' : currentFolder);
  return { label: `폴더 · ${f}`, text: `[현재 화면 맥락] 사용자가 '${f}' 폴더 목록을 보고 있다.` };
}
function searchChipsText() {
  if (!searchCond) return '';
  return Object.entries(searchCond).filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${v}`).join(', ').slice(0, 60);
}
function updateGchatCtx() {
  const el = $('#gchat-ctx');
  if (!el) return;
  const c = currentChatContext();
  gchatCtx = c;
  const hasMail = !!(selectedMail && selectedMail.id);
  const scopeLabel = (chatScope === 'mail' && hasMail)
    ? `이 메일: ${(selectedMail.subject || '').slice(0, 20)}`
    : '전체 메일';
  el.innerHTML = gchatCtxOn
    ? `<span class="ctx-scope">대상: ${escapeHtml(scopeLabel)}</span>` +
      (hasMail ? `<button class="ctx-switch" id="ctx-switch" type="button">${chatScope === 'mail' ? '전체로' : '이 메일로'}</button>` : '') +
      `<span class="ctx-rest">${escapeHtml(c.label)}</span>`
    : '맥락 없음';
  const sw = document.getElementById('ctx-switch');
  if (sw) sw.addEventListener('click', (ev) => { ev.stopPropagation(); setChatScope(chatScope === 'mail' ? 'all' : 'mail'); });
  setRsSub('chat', gchatCtxOn ? scopeLabel : '맥락 없음');
  el.title = gchatCtxOn ? c.text : '맥락을 보내지 않습니다.';
  el.classList.toggle('gchat-ctx-off', !gchatCtxOn);
  const cb = $('#gchat-ctx-clear');
  if (cb) cb.textContent = gchatCtxOn ? '맥락 해제' : '맥락 사용';
}
let gchatCtx = null;

//  대화 배치 모드 — 'panel'(오른쪽 패널) | 'main'(메인 화면에 크게)
//   마스터 요청(2026-08-14): "대화창을 메인에 잘 보이게 배치해"
//   같은 .chat-main 노드를 옮겨 쓰므로 이력·핸들러·세션은 두 모드가 공유한다(중복 0).
let gchatDock = 'panel';
function setGchatDock(mode, moveNow) {
  gchatDock = (mode === 'main') ? 'main' : 'panel';
  try { localStorage.setItem('bmail.gchatDock.v2', gchatDock); } catch (e) {}
  const b = $('#gchat-dock');
  if (b) {
    b.textContent = gchatDock === 'main' ? '패널로' : '메인에 크게';
    b.title = gchatDock === 'main'
      ? '대화를 오른쪽 패널로 되돌립니다'
      : '대화를 메인 화면에 크게 엽니다 (다음부터도 이 방식으로 열립니다)';
  }
  const t = $('#btn-gchat');
  if (t) t.title = gchatDock === 'main'
    ? 'AI 대화 (Ctrl+/) — 메인 화면에 크게 엽니다'
    : 'AI 대화 열기/닫기 (Ctrl+/ · Ctrl+K) — 지금 보던 화면은 그대로 유지됩니다';
  //  'main' = 대화 전용 화면으로 크게 / 'corner' = 우하단 고정 카드
  //  'main' 모드여도 우하단 런처는 남긴다 — 마스터가 어디서든 대화를 시작할 수 있어야 한다.
  //  (대화 전용 화면을 보고 있을 때만 중복이라 숨긴다 → switchView 에서 처리)
  const panel = $('#gchat');
  if (panel) panel.classList.remove('hidden');
  if (moveNow) {
    if (gchatDock === 'main') { setGchatCollapsed(true); switchView('chat'); setTimeout(() => { const i = $('#chat-input'); if (i) i.focus(); }, 40); }
    else { switchView('mail'); setGchatCollapsed(false); }
  }
  applyGchatReserve();
}

// 패널 폭 — 마지막 폭을 기억한다(드래그로 조절)
const GCHAT_MIN_W = 320, GCHAT_MAX_W = 1000;
function applyGchatWidth(px) {
  const w = Math.max(GCHAT_MIN_W, Math.min(Number(px) || 0, Math.min(GCHAT_MAX_W, window.innerWidth - 240)));
  const panel = $('#gchat');
  if (panel) panel.style.width = w + 'px';
  document.documentElement.style.setProperty('--gchat-w', w + 'px');
  try { localStorage.setItem('bmail.gchatW', String(w)); } catch (e) {}
  return w;
}
function restoreGchatWidth() {
  let w = 460;                                  // 기본을 넉넉하게(기존 420 → 460)
  try { const v = parseInt(localStorage.getItem('bmail.gchatW') || '', 10); if (Number.isFinite(v)) w = v; } catch (e) {}
  applyGchatWidth(w);
}
// 왼쪽 가장자리를 끌어 폭 조절 (오른쪽 고정이므로 왼쪽으로 끌수록 넓어진다)
function bindGchatResize() {
  const handle = $('#gchat-resize'), panel = $('#gchat');
  if (!handle || !panel) return;
  let dragging = false;
  handle.addEventListener('mousedown', (e) => { dragging = true; e.preventDefault(); document.body.style.cursor = 'ew-resize'; });
  window.addEventListener('mousemove', (e) => { if (dragging) applyGchatWidth(window.innerWidth - e.clientX); });
  window.addEventListener('mouseup', () => { if (dragging) { dragging = false; document.body.style.cursor = ''; } });
}

//  접힘/펼침 — 대화창은 항상 우하단에 떠 있고, 여닫는 것은 '펼침 상태'다.
let gchatCollapsed = true;
function setGchatCollapsed(collapsed) {
  //  ★ 대화창은 이제 우측 스택의 한 칸이다(팝업 아님) → 섹션 접기/펼치기로 처리한다.
  if (document.getElementById('rs-chat')) {
    gchatCollapsed = !!collapsed;
    gchatOpen = !gchatCollapsed;
    if (!gchatCollapsed) { mountRightStackPanels(); showSideTab('chat'); updateGchatCtx(); }
    toggleRsSection('chat', gchatCollapsed);
    const b0 = $('#btn-gchat');
    if (b0) b0.classList.toggle('active', !gchatCollapsed);
    try { localStorage.setItem('bmail.gchatCollapsed.v2', gchatCollapsed ? '1' : '0'); } catch (e) {}
    if (!gchatCollapsed) setTimeout(() => { const i = $('#chat-input'); if (i) i.focus(); }, 30);
    return;
  }
  const panel = $('#gchat'), host = $('#gchat-host'), node = gchatNode();
  if (!panel || !host || !node) return;
  gchatCollapsed = !!collapsed;
  if (!gchatCollapsed) {
    // '메일 검색' 화면(대화 전용 뷰)에서는 같은 컴포넌트가 이미 크게 떠 있다
    if (document.querySelector('#view-chat.active')) {
      gchatCollapsed = true;
      panel.classList.add('collapsed');
      const i0 = $('#view-chat #chat-input'); if (i0) i0.focus();
      return;
    }
    if (node.parentElement !== host) host.appendChild(node);
    restoreGchatWidth();
    panel.classList.remove('collapsed');
    updateGchatCtx();
    setTimeout(() => { const i = $('#chat-input'); if (i) i.focus(); }, 30);
  } else {
    //  접을 때는 컴포넌트를 '메일 검색' 뷰 제자리로 돌려놓는다.
    //  (노드가 하나뿐이라, 패널에 남겨 두면 대화 전용 화면이 비어 버린다)
    const home = gchatHome();
    if (home && node.parentElement !== home) home.insertBefore(node, home.firstChild);
    panel.classList.add('collapsed');
  }
  gchatOpen = !gchatCollapsed;
  applyGchatReserve();
  const b = $('#btn-gchat');
  if (b) b.classList.toggle('active', !gchatCollapsed);
  try { localStorage.setItem('bmail.gchatCollapsed.v2', gchatCollapsed ? '1' : '0'); } catch (e) {}
}

//  본문 우측 여백 확보 — 창이 좁으면 오버레이로 둔다(가림 사고 방지)
function applyGchatReserve() {
  //  4열 레이아웃에서는 대화창이 그리드 셀 안에 있다 → 본문에 여백을 만들 필요가 없다.
  //  (옛 우하단 팝업 시절 규칙이 남아 #body 에 padding-right 426px 가 걸려 화면 우측이 비었다 — 실측)
  document.body.classList.remove('gchat-reserve');
}

//  기존 호출부 호환: openGlobalChat(true/false) = 펼치기/접기
function openGlobalChat(open) {
  const next = (open === undefined) ? gchatCollapsed : !!open;
  setGchatCollapsed(!next);
}

function switchView(view) {
  //  '메일 검색'(대화 전용) 화면에서는 우하단 런처가 중복이라 숨긴다
  const gp = $('#gchat');
  if (gp) gp.classList.toggle('hidden', view === 'chat');
  // 전역 대화 패널이 열린 채 '메일 검색' 뷰로 가면 컴포넌트를 제자리로 돌려준다(노드는 하나뿐)
  if (view === 'chat' && gchatOpen) openGlobalChat(false);
  // 폴더 트리의 nav 항목 활성화 (메일 뷰는 폴더 항목이 담당)
  $$('.fld-item[data-nav]').forEach(b => b.classList.toggle('active', b.dataset.nav === view));
  if (view !== 'mail') $$('.fld-item[data-folder]').forEach(b => b.classList.remove('active'));
  $$('.view').forEach(v => v.classList.remove('active'));
  const el = $('#view-' + view);
  if (el) el.classList.add('active');

  if (view === 'dashboard') { loadStats(); loadUnanswered(); loadDailyDates(); loadCalendar(); }
  if (view === 'followup') loadFollowup();
  if (view === 'todo') { loadTodoView(); refreshActionCounts(); }
  if (view === 'sent') applySentViewMode(config.sentViewMode || 'grouped');
  if (view === 'contacts' && !contactsLoadedOnce) { contactsLoadedOnce = true; loadContacts(''); }
}

// ============================================================
//  설정 UI 반영/저장
// ============================================================
function applyConfigToUI() {
  renderProviderChain();               // 등록된 제공자(순위·키·모델)
  $('#model-select').value = config.model || 'gpt-oss-120b';
  $('#max-mails').value = config.maxMails || 5000;
  if ($('#save-attach-toggle')) $('#save-attach-toggle').checked = config.saveAttachmentsOnSync !== false;
  if ($('#subfolder-toggle')) $('#subfolder-toggle').checked = config.includeSubfolders !== false;
  if ($('#archive-toggle')) $('#archive-toggle').checked = config.includeArchiveStores === true;
  if ($('#autocontacts-toggle')) $('#autocontacts-toggle').checked = config.autoImportContacts !== false;
  if ($('#autoanalyze-toggle')) $('#autoanalyze-toggle').checked = config.autoAnalyzeOnOpen === true;
  if ($('#ai-concurrency')) $('#ai-concurrency').value = String(config.aiConcurrency || 3);
  if ($('#reply-lang')) $('#reply-lang').value = config.replyLang || 'auto';
  if ($('#crossvalidate-toggle')) $('#crossvalidate-toggle').checked = config.crossValidate !== false;
  refreshExportRoot();
  loadCleanupLast();
  if ($('#autorefresh-toggle')) $('#autorefresh-toggle').checked = config.autoRefreshAll !== false;
  if ($('#deferbusy-toggle')) $('#deferbusy-toggle').checked = config.deferWhenBusy !== false;
  if ($('#focusrefresh-toggle')) $('#focusrefresh-toggle').checked = config.refreshOnFocus !== false;
  if ($('#cleanup-auto')) $('#cleanup-auto').checked = config.cleanupAuto !== false;
  if ($('#cleanup-keepdays')) $('#cleanup-keepdays').value = config.cleanupKeepDays || 30;
  if ($('#proj-active-days')) $('#proj-active-days').value = config.projectActiveDays || 90;
  if ($('#proj-recent-days')) $('#proj-recent-days').value = config.projectRecentDays || 365;
  if ($('#sig-toggle')) $('#sig-toggle').checked = config.useOutlookSignature !== false;
  if ($('#sig-select')) $('#sig-select').value = config.signatureName || '';
  const svm = config.sentViewMode || 'grouped';
  if ($('#btn-sent-grouped')) $('#btn-sent-grouped').classList.toggle('active', svm === 'grouped');
  if ($('#btn-sent-list')) $('#btn-sent-list').classList.toggle('active', svm === 'list');
  if ($('#autodaily-toggle')) $('#autodaily-toggle').checked = config.autoDailyBriefing === true;
  if ($('#bm-base')) $('#bm-base').value = config.bigmailBase || 'https://bigmail.sedms.app';
  if ($('#bm-key')) $('#bm-key').value = config.bigmailKey || 'BM-INT-WEAR-S001';
  if ($('#bm-expire')) $('#bm-expire').value = String(config.bigmailExpireDays || 7);
  loadBigmailHistory();
  loadOrganizeHistoryPanel();
  loadAttachStats();
  loadExtrasStats();
  loadActionSourceInfo();
  loadArchiveStores();
  loadPstStores();
  loadOrgDict();

  const df = config.dateFilter || { mode: '6months' };
  const dmRadio = document.querySelector(`input[name="dateMode"][value="${df.mode}"]`);
  if (dmRadio) dmRadio.checked = true;
  $('#date-start').value = df.start || '';
  $('#date-end').value = df.end || '';
  $('#range-row').classList.toggle('hidden', df.mode !== 'range');

  $('#realtime-toggle').checked = config.realtime !== false;
  if ($('#realtime-interval-min')) $('#realtime-interval-min').value = String(config.realtimeIntervalMin || 3);
  if ($('#startsync-toggle')) $('#startsync-toggle').checked = config.syncNewOnStart !== false;
  if ($('#notify-toggle')) $('#notify-toggle').checked = config.notifyNewMail !== false;

  syncSourceUI();
  updateRealtimeDot();
}

async function saveSettings(opts) {
  const source = document.querySelector('input[name="source"]:checked').value;
  const dateMode = document.querySelector('input[name="dateMode"]:checked').value;
  if (source === 'pst' && !$('#pst-path').value.trim()) { alert('PST 파일 경로를 선택해주세요. (찾기 버튼)'); return; }

  //  제공자 체인(순위 순)을 저장한다. 제공자별 키·모델·URL 은 각 항목 안에 독립 보관된다.
  const chain = collectProviderChain();
  const primary = chain.find(e => e.enabled !== false) || chain[0] || { provider: 'cerebras', baseUrl: '', model: '', keys: [] };
  const byProv = Object.assign({}, config.apiKeysByProvider || {});
  chain.forEach(e => { byProv[e.provider] = e.keys; });
  const newConfig = {
    aiChain: chain,
    apiKeys: (chain.find(e => e.provider === 'cerebras') || {}).keys || (config.apiKeys || []),   // 레거시 필드 보존
    apiKeysByProvider: byProv,
    aiProvider: primary.provider,
    aiBaseUrl: primary.baseUrl || '',
    model: primary.model || $('#model-select').value,
    maxMails: parseInt($('#max-mails').value, 10) || 5000,
    source, pstPath: $('#pst-path').value.trim(),
    dateFilter: { mode: dateMode, start: $('#date-start').value || '', end: $('#date-end').value || '' },
    realtime: $('#realtime-toggle').checked,
    realtimeIntervalMin: parseInt($('#realtime-interval-min') ? $('#realtime-interval-min').value : 3, 10) || 3,
    syncNewOnStart: $('#startsync-toggle') ? $('#startsync-toggle').checked : true,
    notifyNewMail: $('#notify-toggle') ? $('#notify-toggle').checked : true,
    saveAttachmentsOnSync: $('#save-attach-toggle') ? $('#save-attach-toggle').checked : true,
    includeSubfolders: $('#subfolder-toggle') ? $('#subfolder-toggle').checked : true,
    includeArchiveStores: $('#archive-toggle') ? $('#archive-toggle').checked : false,
    autoImportContacts: $('#autocontacts-toggle') ? $('#autocontacts-toggle').checked : true,
    autoAnalyzeOnOpen: $('#autoanalyze-toggle') ? $('#autoanalyze-toggle').checked : false,
    aiConcurrency: parseInt($('#ai-concurrency') ? $('#ai-concurrency').value : 3, 10) || 3,
    replyLang: ($('#reply-lang') ? $('#reply-lang').value : 'auto') || 'auto',
    crossValidate: $('#crossvalidate-toggle') ? $('#crossvalidate-toggle').checked : true,
    autoRefreshAll: $('#autorefresh-toggle') ? $('#autorefresh-toggle').checked : true,
    deferWhenBusy: $('#deferbusy-toggle') ? $('#deferbusy-toggle').checked : true,
    refreshOnFocus: $('#focusrefresh-toggle') ? $('#focusrefresh-toggle').checked : true,
    cleanupAuto: $('#cleanup-auto') ? $('#cleanup-auto').checked : true,
    cleanupKeepDays: parseInt($('#cleanup-keepdays') ? $('#cleanup-keepdays').value : 30, 10) || 30,
    projectActiveDays: parseInt($('#proj-active-days') ? $('#proj-active-days').value : 90, 10) || 90,
    projectRecentDays: parseInt($('#proj-recent-days') ? $('#proj-recent-days').value : 365, 10) || 365,
    useOutlookSignature: $('#sig-toggle') ? $('#sig-toggle').checked : true,
    signatureName: $('#sig-select') ? $('#sig-select').value : '',
    autoDailyBriefing: $('#autodaily-toggle') ? $('#autodaily-toggle').checked : false,
    bigmailBase: ($('#bm-base') ? $('#bm-base').value.trim() : '') || 'https://bigmail.sedms.app',
    bigmailKey: ($('#bm-key') ? $('#bm-key').value.trim() : '') || 'BM-INT-WEAR-S001',
    bigmailExpireDays: parseInt($('#bm-expire') ? $('#bm-expire').value : 7, 10) || 7,
    archiveStoreNames: config.archiveStoreNames === undefined ? null : config.archiveStoreNames
  };
  config = await window.api.setConfig(newConfig);
  updateKeyStatus(); updateRealtimeDot(); refreshConnectionStatus(); syncSourceUI();
  refreshAiState();                              // 제공자·키가 바뀌면 상태 배지도 갱신
  if (opts && opts.silent) return;               // 연결 테스트에서 부를 때는 알림을 띄우지 않는다
  const saved = $('#settings-saved');
  saved.classList.remove('hidden');
  setTimeout(() => saved.classList.add('hidden'), 2000);
}

// ------------------------------------------------------------
//  상대 조직 사전 (보낸메일 2차 분류 기준)
// ------------------------------------------------------------
async function loadOrgDict() {
  const box = $('#org-dict'), cov = $('#org-coverage');
  if (!box) return;
  box.innerHTML = '<div class="empty-sm">불러오는 중...</div>';
  try {
    const r = await window.api.orgDict({});
    if (!r.ok) { box.innerHTML = `<div class="empty-sm">${escapeHtml(r.error)}</div>`; return; }
    if (cov && r.coverage) {
      cov.textContent = `조직 확정 ${r.coverage.coverage}% (전체 ${r.coverage.total.toLocaleString()}건 중 미분류 ${r.coverage.unknown.toLocaleString()}건) · 상위: `
        + (r.coverage.top || []).slice(0, 5).map(t => `${t.org} ${t.cnt}`).join(' · ');
    }
    const rows = (r.map || []).slice(0, 40);
    if (!rows.length) { box.innerHTML = '<div class="empty-sm">사전이 비어 있습니다. [다시 구축]을 눌러 주세요.</div>'; return; }
    box.innerHTML = `<table class="pst-tbl"><thead><tr><th>도메인</th><th>조직명</th><th>건수</th><th>구분</th></tr></thead><tbody>` +
      rows.map(m => `<tr>
        <td class="pst-path">${escapeHtml(m.domain)}</td>
        <td><input class="org-name idlg-input" data-domain="${escapeHtml(m.domain)}" value="${escapeHtml(m.org)}" /></td>
        <td class="pst-num">${m.cnt || 0}</td>
        <td>${m.auto ? '자동' : '<span class="pst-fixed">수정</span>'}</td>
      </tr>`).join('') + '</tbody></table>';
    box.querySelectorAll('.org-name').forEach(inp => inp.addEventListener('change', async () => {
      const res = await window.api.orgDict({ action: 'set', domain: inp.dataset.domain, org: inp.value.trim() });
      if (!res.ok) alert('저장 실패: ' + res.error); else loadOrgDict();
    }));
  } catch (err) { box.innerHTML = `<div class="empty-sm">${escapeHtml(String(err))}</div>`; }
}

// ------------------------------------------------------------
//  PST · 데이터 파일 관리 (읽기 전용 진단 + 수집 대상 선택)
//  ★ PST 자체를 추가/제거/압축하지 않는다 (Outlook 원본 보호)
// ------------------------------------------------------------
let pstStoreCache = [];
async function loadPstStores() {
  const box = $('#pst-stores');
  if (!box) return;
  box.innerHTML = '<div class="empty-sm">Outlook 데이터 파일을 확인 중...</div>';
  try {
    const res = await window.api.pstStores();
    if (!res.ok) { box.innerHTML = `<div class="empty-sm">확인 실패: ${escapeHtml(res.error)}</div>`; return; }
    pstStoreCache = res.stores || [];
    if (!pstStoreCache.length) { box.innerHTML = '<div class="empty-sm">연결된 데이터 파일이 없습니다.</div>'; return; }
    box.innerHTML = `
      <table class="pst-tbl">
        <thead><tr>
          <th>수집</th><th>이름</th><th>종류</th><th>폴더</th><th>Outlook</th><th>Bmail DB</th><th>크기</th>
        </tr></thead>
        <tbody>${pstStoreCache.map(s => `
          <tr>
            <td>${s.isDefault
              ? `<span class="pst-fixed" title="기본 계정은 항상 수집합니다">항상</span>`
              : `<input type="checkbox" class="pst-inc" data-store="${escapeHtml(s.name)}" ${s.included ? 'checked' : ''} />`}</td>
            <td class="pst-name">${icon(s.isDefault ? 'mailSearch' : 'folder', 13)}<span>${escapeHtml(s.name)}</span></td>
            <td>${s.isDefault ? '기본 계정' : '아카이브'}</td>
            <td class="pst-num">${s.folderCount}</td>
            <td class="pst-num">${(s.outlookItems || 0).toLocaleString()}</td>
            <td class="pst-num">${(s.dbItems || 0).toLocaleString()}</td>
            <td class="pst-num">${s.sizeMB != null ? s.sizeMB.toLocaleString() + 'MB' : '-'}</td>
          </tr>
          <tr class="pst-path-row"><td></td><td colspan="6" class="pst-path" title="${escapeHtml(s.path)}">${escapeHtml(s.path || '(경로 정보 없음)')}</td></tr>`).join('')}
        </tbody>
      </table>`;
    box.querySelectorAll('.pst-inc').forEach(cb => cb.addEventListener('change', saveArchiveSelection));
  } catch (err) {
    box.innerHTML = `<div class="empty-sm">${escapeHtml(String(err))}</div>`;
  }
}

// 체크된 아카이브만 수집 대상으로 저장
//  ★ 의미를 명확히 한다: 항상 '명시 목록'을 저장한다.
//    빈 배열 = 아카이브 수집 안 함 (전체를 뜻하지 않음 — 과거 반전 버그 원인)
async function saveArchiveSelection() {
  const boxes = [...$$('.pst-inc')];
  const checked = boxes.filter(b => b.checked).map(b => b.dataset.store);
  config = await window.api.setConfig({ ...config, archiveStoreNames: checked });
  const info = $('#archive-stores');
  if (info) {
    info.textContent = checked.length
      ? `수집 대상 아카이브: ${checked.join(', ')}`
      : '수집 대상 아카이브 없음 (기본 계정만 수집)';
  }
}

// Outlook에 연결된 스토어 목록 → "아카이브 PST 포함" 대상 안내
async function loadArchiveStores() {
  const el = $('#archive-stores');
  if (!el) return;
  try {
    const res = await window.api.outlookListStores();
    if (!res || !res.ok) { el.textContent = '아카이브 스토어 확인 실패: ' + ((res && res.error) || '알 수 없음'); return; }
    const archives = (res.stores || []).filter(s => !s.isDefault);
    if (!archives.length) { el.textContent = '추가로 연결된 아카이브 PST가 없습니다. (기본 계정만 수집)'; return; }
    el.textContent = '수집 대상 아카이브: ' + archives.map(s => `${s.name}${s.path ? ` (${s.path})` : ''}`).join(', ');
  } catch (err) {
    el.textContent = '아카이브 스토어 확인 실패: ' + String(err);
  }
}

// ------------------------------------------------------------
//  실시간 상태 표시
//  ★ 라벨은 장식이 아니라 실제 폴링 결과를 반영한다.
//    성공 = "실시간(HH:MM)", 실패 = "대기(Outlook 꺼짐)", 꺼짐 = 숨김
// ------------------------------------------------------------
let realtimeState = { ok: null, at: null, error: '', count: null, reason: '' };

function updateRealtimeDot() {
  const enabled = config.realtime !== false && (config.source || 'outlook') === 'outlook';
  const el = $('#realtime-dot');
  if (!el) return;
  el.classList.toggle('hidden', !enabled);
  if (!enabled) return;

  if (realtimeState.ok === false) {
    // 실패 원인을 구분해 정직하게 표시 (Outlook 꺼짐 / 그 외 오류)
    const err = String(realtimeState.error || '');
    const outlookOff = /Outlook|COM|서버|호출된 개체|RPC|0x8000/i.test(err) || !err;
    el.className = 'realtime-dot rt-waiting';
    el.innerHTML = `<span class="rt-dot"></span> ${outlookOff ? '대기 (Outlook 꺼짐)' : '확인 실패'}`;
    el.title = err || 'Outlook 이 실행되지 않아 새 메일을 확인할 수 없습니다.';
  } else {
    const t = realtimeState.at ? new Date(realtimeState.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '';
    el.className = 'realtime-dot';
    el.innerHTML = `<span class="rt-dot"></span> 실시간${t ? ' ' + t : ''}`;
    const min = config.realtimeIntervalMin || 3;
    // 무엇을 얼마나 확인했는지 툴팁에 정직하게 적는다(요구: 실시간/대기/오류 + 원인)
    const d = lastRefreshDetail;
    let extra = '';
    if (d && d.ok) {
      extra = `\n폴더 ${d.scannedFolders || 0}개 점검 · 변경 ${d.changed || 0}개` +
        (d.detailMs ? ` · 상세조회 ${d.detailMs}ms` : '') +
        (d.deferred ? '\n(조작 중이라 무거운 갱신은 다음 주기로 미룸)' : '') +
        (d.baseline ? '\n(첫 실행 — 기준선만 기록)' : '');
    } else if (d && d.error) {
      extra = `\n변경 확인 실패: ${d.error}`;
    }
    const got = (typeof realtimeState.count === 'number')
      ? `\n마지막 확인 결과: 새 메일 ${realtimeState.count}건` +
        (realtimeState.reason === 'startup' ? ' (앱 시작 직후 확인)' : '')
      : '';
    el.title = `${min}분 간격으로 새 메일과 Outlook 변경(읽음·이동·범주·깃발)을 확인합니다.` +
      `${t ? '\n마지막 확인 ' + t : ''}${got}${extra}\nF5 또는 Ctrl+R 로 즉시 갱신`;
  }
}

// 폴링 결과 수신
function handleRealtimeStatus(s) {
  realtimeState = {
    ok: s.disabled ? null : s.ok, at: s.at || realtimeState.at, error: s.error || '',
    count: (typeof s.count === 'number') ? s.count : realtimeState.count,
    reason: s.reason || realtimeState.reason
  };
  lastRefreshDetail = s.refresh || lastRefreshDetail;
  updateRealtimeDot();
}

// ============================================================
//  실시간 전체 갱신 — 화면을 최신으로 유지하되 작업을 방해하지 않는다
//  ------------------------------------------------------------
//  마스터 제약: 스크롤 위치·선택 메일·펼침 상태·입력 중 텍스트를 반드시 유지하고,
//  갱신 중 로딩 스피너로 화면을 가리지 않는다(헤더에 미세 표시만).
// ============================================================
let lastRefreshDetail = null;
let uiBusyTimer = null;

// 사용자가 조작 중이라는 신호를 본체에 알린다(입력·스크롤·드래그 중 무거운 갱신 연기)
function bindUiBusySignals() {
  const mark = () => {
    if (uiBusyTimer) clearTimeout(uiBusyTimer);
    else { try { window.api.setUiBusy(true); } catch (_) { } }
    uiBusyTimer = setTimeout(() => {
      uiBusyTimer = null;
      try { window.api.setUiBusy(false); } catch (_) { }
    }, 4000);   // 마지막 조작 후 4초간 '조작 중'으로 본다
  };
  ['keydown', 'mousedown', 'wheel'].forEach(ev => window.addEventListener(ev, mark, { passive: true }));
}

// 목록의 스크롤·선택 상태를 떠 두었다가 다시 씌운다(스크롤 점프 방지의 핵심)
function captureListState(sel) {
  const el = $(sel);
  if (!el) return null;
  const selected = el.querySelector('.selected');
  return {
    sel, scrollTop: el.scrollTop, scrollHeight: el.scrollHeight,
    selectedId: selected ? (selected.dataset.mid || selected.dataset.id || '') : '',
    atTop: el.scrollTop <= 4
  };
}
function restoreListState(st) {
  if (!st) return;
  const el = $(st.sel);
  if (!el) return;
  // 위에 항목이 끼어들어 높이가 커졌으면 그만큼 내려 화면이 튀지 않게 한다.
  //  단, 원래 맨 위를 보고 있었다면 맨 위를 유지한다(새 메일을 바로 보여 주는 게 자연스럽다).
  const grew = el.scrollHeight - st.scrollHeight;
  el.scrollTop = st.atTop ? 0 : st.scrollTop + (grew > 0 ? grew : 0);
  if (st.selectedId) {
    const again = el.querySelector(`[data-mid="${st.selectedId}"], [data-id="${st.selectedId}"]`);
    if (again) again.classList.add('selected');
  }
}

// 헤더의 미세 표시 (스피너로 화면을 가리지 않는다)
function setRefreshPulse(on) {
  const dot = $('#realtime-dot');
  if (dot) dot.classList.toggle('rt-refreshing', !!on);
}

// Outlook 쪽 변경(읽음·이동·범주·깃발·삭제)이 반영됐을 때 화면을 조용히 최신화
async function handleMailsUpdated(p) {
  lastRefreshDetail = p;
  setRefreshPulse(true);
  try {
    const a = (p && p.applied) || {};
    // 지금 보고 있는 목록만 다시 그린다 — 상태는 보존한다
    if ($('#view-mail') && $('#view-mail').classList.contains('active')) {
      const st = captureListState('#mail-list');
      await loadMails($('#global-search').value, { silent: true });
      restoreListState(st);
    } else if ($('#view-followup') && $('#view-followup').classList.contains('active')) {
      const st = captureListState('#followup-list');
      await loadFollowup();
      restoreListState(st);
    }
    refreshUnreadBadges();
    // 회신대기·통계는 화면에 없더라도 배지 숫자를 맞춘다(가볍다)
    if (a.readChanged || a.movedChanged || a.removed) loadFollowup();
    if ($('#view-dashboard') && $('#view-dashboard').classList.contains('active')) { loadStats(); loadUnanswered(); }
    const info = $('#sync-info');
    if (info) {
      const parts = [];
      if (a.readChanged) parts.push(`읽음 ${a.readChanged}`);
      if (a.movedChanged) parts.push(`이동 ${a.movedChanged}`);
      if (a.metaChanged) parts.push(`범주·깃발 ${a.metaChanged}`);
      if (a.removed) parts.push(`삭제 ${a.removed}`);
      if (parts.length) info.textContent = `Outlook 변경 반영: ${parts.join(' · ')} (${new Date().toLocaleTimeString('ko-KR')})`;
    }
  } catch (_) { /* 갱신 실패는 화면을 깨뜨리지 않는다 — 상태 점으로만 알린다 */ }
  finally { setRefreshPulse(false); }
}

// 수동 새로고침 (F5 · Ctrl+R · 리본 버튼)
async function manualRefresh() {
  setRefreshPulse(true);
  const info = $('#sync-info');
  if (info) info.textContent = '최신 상태 확인 중...';
  try {
    const r = await window.api.refreshNow();
    if (r && r.ok === false && r.error) {
      if (info) info.textContent = '갱신 실패: ' + r.error;
    } else if (info) {
      info.textContent = `최신 상태로 갱신했습니다 (${new Date().toLocaleTimeString('ko-KR')})`;
    }
    await loadFolderTree(true);
    refreshUnreadBadges();
    if ($('#view-mail') && $('#view-mail').classList.contains('active')) {
      const st = captureListState('#mail-list');
      await loadMails($('#global-search').value, { silent: true });
      restoreListState(st);
    }
  } catch (e) {
    if (info) info.textContent = '갱신 오류: ' + String(e);
  } finally { setRefreshPulse(false); }
}

// 새 메일 도착 → 현재 보고 있는 목록·배지·회신대기 갱신
async function handleNewMailsLive(mails) {
  if (!mails || !mails.length) return;
  // DB 에 이미 적재됐으므로 현재 필터 기준으로 목록을 다시 읽는다(id 포함 → 클릭 가능)
  if ($('#view-mail').classList.contains('active')) {
    await loadMails($('#global-search').value);
  }
  refreshUnreadBadges();
  loadFollowup();
  loadStats();            // 폴더 건수(받은/보낸/전체/첨부) — 새 메일이 들어오면 즉시 반영
  refreshActionCounts();  // 처리 상태 배지
  const info = $('#sync-info');
  if (info) info.textContent = `새 메일 ${mails.length}건 수신 (${new Date().toLocaleTimeString('ko-KR')})`;
}

async function refreshConnectionStatus() {
  const pill = $('#conn-pill');
  const el = $('#conn-status');
  pill.innerHTML = '<span class="cp-dot"></span> 확인 중'; pill.className = 'conn-pill';
  if (el) { el.textContent = '연결 확인 중...'; el.className = 'conn-status'; }
  try {
    const r = await window.api.checkConnection();
    if (r.ok) {
      if (r.mode === 'pst') {
        pill.innerHTML = '<span class="cp-dot"></span> PST 연결됨'; pill.className = 'conn-pill ok';
        if (el) { el.textContent = `PST 파일 연결됨: ${r.pstPath}`; el.className = 'conn-status ok'; }
      } else {
        const stores = (r.stores || []).map(s => s.name).join(', ');
        pill.innerHTML = '<span class="cp-dot"></span> Outlook 연결됨'; pill.className = 'conn-pill ok';
        if (el) { el.textContent = `Outlook 연결됨 (계정/데이터: ${stores || '기본'})`; el.className = 'conn-status ok'; }
      }
    } else {
      pill.innerHTML = '<span class="cp-dot"></span> 연결 안 됨'; pill.className = 'conn-pill bad';
      if (el) { el.textContent = `${r.error || '연결되지 않음'}`; el.className = 'conn-status bad'; }
    }
  } catch (err) {
    pill.innerHTML = '<span class="cp-dot"></span> 오류'; pill.className = 'conn-pill bad';
    if (el) { el.textContent = `${String(err)}`; el.className = 'conn-status bad'; }
  }
}

async function checkNewMails() {
  showLoading('새 메일 확인 중...');
  try {
    const res = await window.api.checkNew();
    hideLoading();
    if (res.ok && res.mails && res.mails.length) { handleNewMails(res.mails); alert(`새 메일 ${res.mails.length}건을 확인했습니다.`); }
    else if (res.ok) alert('새 메일이 없습니다.');
    else alert(res.error);
  } catch (err) { hideLoading(); alert('오류: ' + String(err)); }
}

function handleNewMails(mails) {
  if (!mails || !mails.length) return;
  const existingIds = new Set(mailCache.map(m => m.entryId || m.entry_id));
  const fresh = mails.filter(m => !existingIds.has(m.entryId));
  if (!fresh.length) return;
  mailCache = [...fresh, ...mailCache];
  if ($('#view-mail').classList.contains('active')) renderMailList(mailCache);
}

function updateKeyStatus() {
  const count = currentProviderKeys().filter(k => k && String(k).trim()).length;
  const el = $('#key-status');
  if (count > 0) { el.textContent = `API 키: ${count}개 활성`; el.className = 'key-status ok'; }
  else { el.textContent = 'API 키 없음 - 설정 필요'; el.className = 'key-status bad'; }
}
function needKey() {
  if (!hasUsableProvider() && currentProviderKeys().filter(k => k && String(k).trim()).length === 0) {
    alert('AI 제공자가 설정되지 않았습니다. 설정에서 제공자를 등록하고 키를 입력하세요.');
    switchView('settings');
    return true;
  }
  return false;
}

// ============================================================
//  파일 첨부
// ============================================================
async function pickFiles() {
  const files = await window.api.pickFiles();
  for (const f of files) { if (pendingFiles.length >= 5) break; if (!pendingFiles.includes(f)) pendingFiles.push(f); }
  renderPendingFiles();
}
function renderPendingFiles() {
  const box = $('#pending-files');
  box.innerHTML = '';
  pendingFiles.forEach((f, i) => {
    const name = f.split(/[\\/]/).pop();
    const chip = document.createElement('div');
    chip.className = 'file-chip';
    chip.innerHTML = `${escapeHtml(name)} <span class="remove" data-i="${i}">×</span>`;
    chip.querySelector('.remove').addEventListener('click', () => { pendingFiles.splice(i, 1); renderPendingFiles(); });
    box.appendChild(chip);
  });
}

// ============================================================
//  대화형 채팅
// ============================================================
async function sendChat() {
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text && pendingFiles.length === 0) return;
  if (needKey()) return;

  // ★ 전역 패널에서 물으면 지금 보던 화면의 맥락을 함께 보낸다(칩으로 해제 가능).
  //   화면에 보이는 말풍선은 사용자가 친 문장 그대로 두고, 모델에만 맥락을 덧붙인다.
  const ctx = (gchatOpen && gchatCtxOn && gchatCtx) ? gchatCtx.text : '';
  const userDisplay = text + (pendingFiles.length ? `\n첨부 ${pendingFiles.length}개` : '');
  addMessage('user', escapeHtml(userDisplay));
  input.value = ''; autoGrow();
  const typingEl = addTyping();

  try {
    let contextParts = [];
    if (pendingFiles.length > 0) {
      setTyping(typingEl, '첨부파일 분석 중...');
      const results = await window.api.analyzeAttachments(pendingFiles);
      for (const r of results) {
        if (r.ok) contextParts.push(`[첨부파일: ${r.file} (${r.type}, ${r.sizeKB}KB)]\n${r.text}`);
        else contextParts.push(`[첨부파일: ${r.file}] 분석 실패: ${r.error}`);
      }
      pendingFiles = []; renderPendingFiles();
    }

    if (contextParts.length > 0) {
      setTyping(typingEl, '답변 생성 중...');
      const messages = [
        { role: 'system', content: '당신은 한국어 이메일/첨부파일 분석 비서입니다. 제공된 첨부 내용을 근거로 정확히 요약/분석하세요. 외국어는 한국어로 번역해 설명하세요.' },
        { role: 'user', content: `${contextParts.join('\n\n')}\n\n---\n사용자 질문: ${text || '위 첨부파일을 분석/요약해줘'}` }
      ];
      const res = await window.api.chat(messages);
      removeTyping(typingEl);
      if (res.ok) {
        chatHistory.push({ role: 'user', content: text || '첨부 분석' });
        chatHistory.push({ role: 'assistant', content: res.content });
        addMessage('assistant', formatAnswer(res.content), { keyIndex: res.usedKeyIndex });
      } else { noteAiResult(res); bindAiErrorActions(addMessage('assistant', aiErrorHtml(res))); }
      return;
    }

    // ★ '첨부 정리' 명령이면 AI 질의 대신 계획 카드를 띄운다(실행은 사용자가 누를 때만).
    setTyping(typingEl, '지시 확인 중...');
    const handled = await tryOrganizeCommand(text, () => removeTyping(typingEl));
    if (handled) return;

    setTyping(typingEl, '메일 검색 중...');
    //  맥락은 '앞선 대화'로 끼워 넣는다 — 검색어(text)를 오염시키면 자연어 파서가 틀어진다.
    const hist = ctx ? [{ role: 'user', content: ctx }, ...chatHistory.slice(-5)] : chatHistory.slice(-6);
    //  ★ 열어 둔 메일이 있으면 그것이 기본 대화 대상이다(맥락 칩으로 [전체]로 바꿀 수 있다)
    const focusId = (chatScope === 'mail' && selectedMail && selectedMail.id) ? selectedMail.id : null;
    const res = await window.api.aiChatMails(text, hist, focusId);
    removeTyping(typingEl);
    if (res.ok) {
      chatHistory.push({ role: 'user', content: text });
      chatHistory.push({ role: 'assistant', content: res.content || '(브리핑)' });
      noteAiResult(res);
      // ★ 4탭(마스터 지시): "사람별로 정리해줘"/"타임라인으로 보여줘" → 메일 뷰의 결과탭으로 라우팅.
      //   tab-switch 는 즉시 화면 전환, 그 외(검색/할일)는 데이터만 반영해 두고 [보기] 버튼으로 이동.
      const hasResultTabs = res.resultTabs && (res.mails || []).length;
      if (hasResultTabs) mirrorResultTabsFromChat(res, { switchNow: res.kind === 'tab-switch', requestedTab: res.requestedTab });
      //  해석된 조건을 칩으로 보여 준다 — 왜 이 결과가 나왔는지 사용자가 알 수 있게
      let chipHtml = renderCondChips(res.chips, res.contextCount) + promptReducedBadge(res.promptReduced) + attachmentChipsHtml(res.attachmentChips);
      if (hasResultTabs && res.kind !== 'tab-switch') {
        chipHtml += `<button class="rt-jump" type="button">${icon('list', 12)} 타임라인·표로 보기</button>`;
      }
      //  근거 0건이면 안내를 응답 카드 안에 함께 넣는다(별도 카드 금지 = 중복 제거)
      if (!(res.mails || []).length && res.kind !== 'briefing') {
        chipHtml += `<div class="grounded-empty">${res.dbTotal === 0
          ? '저장된 메일이 아직 없습니다. 상단 <b>동기화</b>를 먼저 실행하세요.'
          : (res.usedPrevious
              ? '직전 결과 안에서는 해당하는 메일을 찾지 못했습니다.'
              : '이 조건에 맞는 메일이 없습니다. 조건(날짜·발신자·키워드)을 바꾸거나 <b>직전 결과에서 찾을까요?</b> 라고 말씀하세요.')}</div>`;
      }
      //  브리핑 카드는 필수 배열이 갖춰졌을 때만 그린다(형식이 어긋나면 대화가 깨진다)
      let briefHtml = '';
      if (res.kind === 'briefing' && res.structured) {
        //  '브리핑/요약/정리' 의도 → 검색이 아니라 브리핑 결과 카드로 (기존 렌더 재사용)
        try {
          briefHtml = renderDailyBriefing(res.structured, { cached: res.cached, count: res.contextCount });
        } catch (e) {
          console.warn('브리핑 카드 렌더 실패 → 텍스트로 표시', e);
          briefHtml = `<div class="briefing-body">${formatAnswer(res.content || JSON.stringify(res.structured))}</div>`;
        }
      }
      let msgEl;
      if (briefHtml) {
        msgEl = addMessage('assistant', chipHtml + briefHtml, { keyIndex: res.usedKeyIndex });
      } else {
        const info = res.contextCount ? { keyIndex: res.usedKeyIndex, ctx: res.contextCount } : { keyIndex: res.usedKeyIndex };
        msgEl = addMessage('assistant', chipHtml + formatAnswer(res.content), info);
      }
      if (msgEl) {
        const jumpBtn = msgEl.querySelector('.rt-jump');
        if (jumpBtn) jumpBtn.addEventListener('click', () => {
          activeResultTab = 'timeline';
          switchView('mail');
          $('#mlp-title').textContent = resultTabsLabel || '검색 결과';
          renderActiveResultTab();
        });
      }
      // ★ 그라운딩: AI 가 근거로 삼은 실제 DB 메일을 목록으로 표시(클릭 시 열림)
      //   ‼ 0건일 때는 별도 카드를 만들지 않는다(같은 질문에 카드가 2개 뜨던 중복 제거).
      //  근거 목록은 '같은 카드 안'에 붙인다 — 한 질문에 카드가 2개 뜨던 중복 제거
      if ((res.mails || []).length && msgEl) {
        renderGroundedMails(res.mails, { chips: res.chips, dbTotal: res.dbTotal, matched: res.contextCount },
          msgEl.querySelector('.bubble'));
      }
    } else { noteAiResult(res); bindAiErrorActions(addMessage('assistant', aiErrorHtml(res))); }
  } catch (err) {
    removeTyping(typingEl);
    addMessage('assistant', `처리 중 오류: ${escapeHtml(String(err))}`);
  }
}

// ============================================================
//  ★ 즐겨찾기 / 로컬 가상 폴더 / 컨텍스트 메뉴
//  ------------------------------------------------------------
//  모든 폴더 조작은 Bmail 로컬 DB 안에서만 일어난다.
//  Outlook 원본 메일함(폴더 생성·이동·삭제)은 절대 건드리지 않는다.
// ============================================================

// 폴더 이름 정규화 — DB 는 정규키('Sent')로 저장하지만 계정 트리·Outlook 즐겨찾기는
//  로케일 표시명('보낸 편지함')을 넘긴다. 두 경로가 갈라져 분류 뷰가 안 열리던 회귀의 원인.
//  (2026-08-04 실측: 트리에서 '보낸 편지함' 클릭 시 name==='Sent' 조건에 걸리지 않아 평면 목록이 떴다)
const FOLDER_CANON = {
  '받은 편지함': 'Inbox', 'Inbox': 'Inbox',
  '보낸 편지함': 'Sent', 'Sent': 'Sent', 'Sent Items': 'Sent',
  '지운 편지함': 'Deleted', 'Deleted Items': 'Deleted',
  '임시 보관함': 'Drafts', 'Drafts': 'Drafts',
  '보낼 편지함': 'Outbox', 'Outbox': 'Outbox',
  '정크 메일': 'Junk', 'Junk Email': 'Junk'
};
function canonFolderName(name) { return FOLDER_CANON[String(name)] || name; }

// ---- 공통: 폴더 선택 ----
function selectRealFolder(name, label) {
  searchCond = null; renderSearchChips();   // 폴더를 고르면 검색 조건은 해제
  // ★ 보낸 편지함은 기본적으로 '분류 보기'(프로젝트→수신인→메일)로 들어간다.
  //   마지막 선택은 config.sentViewMode 에 기억된다.
  //   어느 경로(즐겨찾기·계정 트리·리본)로 들어와도 같게 동작하도록 이름을 먼저 정규화한다.
  if (canonFolderName(name) === 'Sent') {
    currentVFolder = null; currentFolder = 'Sent';
    $$('.fld-item').forEach(x => x.classList.remove('active'));
    $$('.tree-item').forEach(x => x.classList.remove('active'));
    switchView('sent');   // 안에서 [분류|목록] 토글로 전환 (마지막 선택 기억)
    return;
  }
  currentVFolder = null;
  currentFolder = name;
  $$('.fld-item').forEach(x => x.classList.remove('active'));
  $$('.tree-item').forEach(x => x.classList.remove('active'));
  $$('.fav-item').forEach(x => x.classList.remove('active'));
  $$('.vf-item').forEach(x => x.classList.remove('active'));
  $('#mlp-title').textContent = label || name;
  switchView('mail');
  loadMails($('#global-search').value);
}
function selectVirtualFolder(id, label) {
  currentVFolder = id;
  currentFolder = 'all';
  $$('.fld-item').forEach(x => x.classList.remove('active'));
  $$('.tree-item').forEach(x => x.classList.remove('active'));
  $$('.fav-item').forEach(x => x.classList.remove('active'));
  $$('.vf-item').forEach(x => x.classList.toggle('active', x.dataset.vfid === String(id)));
  $('#mlp-title').textContent = label;
  switchView('mail');
  loadMails($('#global-search').value);
}

// ---- 즐겨찾기 ----
let favCache = [];

// Outlook 즐겨찾기에는 마스터가 구분용으로 만든 '+++++' / '-----' 폴더가 섞여 있다.
// 같은 문자만 3자 이상 반복되면 구분선으로 그린다(클릭은 그대로 동작).
function isSeparatorLabel(s) {
  const t = String(s || '').trim();
  return t.length >= 3 && /^([+\-=_~*#.])\1+$/.test(t);
}

// Outlook 탐색 창 즐겨찾기를 그대로 가져온다(목록·순서 = Outlook 정본).
async function syncOutlookFavorites(silent = true) {
  try {
    const r = await window.api.favSyncOutlook();
    // Outlook 창이 닫혀 있으면 실패한다. 치명적이지 않으니 조용히 넘기고 기존 즐겨찾기를 유지한다.
    if (!r.ok) { console.warn('Outlook 즐겨찾기 가져오기 실패:', r.error); if (!silent) alert('Outlook 즐겨찾기 가져오기 실패: ' + (r.error || '')); }
    return r;
  } catch (e) {
    console.warn('Outlook 즐겨찾기 가져오기 실패:', e);
    if (!silent) alert('Outlook 즐겨찾기 가져오기 실패: ' + e);
    return { ok: false, error: String(e) };
  }
}

async function loadFavorites() {
  const box = $('#fav-list');
  if (!box) return;
  try {
    const res = await window.api.favList();
    favCache = (res.ok && res.favorites) ? res.favorites : [];
    if (!favCache.length) {
      box.innerHTML = '<div class="fav-empty">Outlook 즐겨찾기를 가져오는 중입니다. 폴더를 우클릭해 직접 추가할 수도 있습니다.</div>';
      return;
    }
    box.innerHTML = favCache.map(f => {
      const sep = isSeparatorLabel(f.label);
      const fromOutlook = f.source === 'outlook';
      const tip = fromOutlook ? `${f.label} — Outlook 즐겨찾기` : f.label;
      if (sep) {
        return `<button class="fld-item fav-item fav-sep" data-fav="${escapeHtml(f.key)}" data-kind="${f.kind}" title="${escapeHtml(tip)}">
          <span class="fav-sep-line"></span>
        </button>`;
      }
      return `
      <button class="fld-item fav-item${fromOutlook ? ' fav-outlook' : ''}" data-fav="${escapeHtml(f.key)}" data-kind="${f.kind}" title="${escapeHtml(tip)}">
        <span class="fld-ic fav-star">${icon('star', 13)}</span>
        <span class="fav-label">${escapeHtml(f.label)}</span>
        <span class="fld-count fav-cnt" data-favcnt="${escapeHtml(f.key)}"></span>
      </button>`;
    }).join('');
    box.querySelectorAll('.fav-item').forEach(b => {
      b.addEventListener('click', () => {
        const f = favCache.find(x => x.key === b.dataset.fav);
        if (!f) return;
        if (f.kind === 'virtual') selectVirtualFolder(parseInt(f.key.split(':')[1], 10), f.label);
        else selectRealFolder(f.key.split(':').slice(1).join(':'), f.label);
        b.classList.add('active');
      });
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        const f = favCache.find(x => x.key === b.dataset.fav);
        showFolderMenu(e, { kind: f.kind, name: f.label, key: f.key, isFavorite: true, vfId: f.kind === 'virtual' ? parseInt(f.key.split(':')[1], 10) : null });
      });
    });
    refreshUnreadBadges();
  } catch (err) {
    box.innerHTML = `<div class="fav-empty">${escapeHtml(String(err))}</div>`;
  }
}

async function toggleFavorite(target) {
  const key = target.key || (target.kind === 'virtual' ? `virtual:${target.vfId}` : `real:${target.name}`);
  const exists = favCache.some(f => f.key === key);
  if (exists) await window.api.favRemove(key);
  else await window.api.favAdd(key, target.kind, target.name);
  await loadFavorites();
}

// ---- 로컬 가상 폴더 ----
let vfCache = [];
async function loadVFolders() {
  const box = $('#vfolder-list');
  if (!box) return;
  try {
    const res = await window.api.vfList();
    vfCache = (res.ok && res.folders) ? res.folders : [];
    if (!vfCache.length) {
      box.innerHTML = '<div class="fav-empty">＋ 새 폴더로 나만의 분류를 만드세요.<br>(Outlook 원본은 바뀌지 않습니다)</div>';
      return;
    }
    box.innerHTML = vfCache.map(v => `
      <button class="fld-item vf-item" data-vfid="${v.id}" title="${escapeHtml(v.name)} · ${v.mailCount}건">
        <span class="fld-ic">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
        </span>
        <span class="vf-label">${escapeHtml(v.name)}</span>
        <span class="fld-count" data-vfcnt="${v.id}">${v.mailCount}</span>
      </button>`).join('');
    box.querySelectorAll('.vf-item').forEach(b => {
      const id = parseInt(b.dataset.vfid, 10);
      const vf = vfCache.find(v => v.id === id);
      b.addEventListener('click', () => selectVirtualFolder(id, vf ? vf.name : '로컬 폴더'));
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        showFolderMenu(e, { kind: 'virtual', name: vf ? vf.name : '', vfId: id, key: `virtual:${id}` });
      });
      // 메일 드래그 → 이 폴더로 이동
      b.addEventListener('dragover', (e) => { e.preventDefault(); b.classList.add('vf-drop'); });
      b.addEventListener('dragleave', () => b.classList.remove('vf-drop'));
      b.addEventListener('drop', async (e) => {
        e.preventDefault(); b.classList.remove('vf-drop');
        const mailId = parseInt(e.dataTransfer.getData('text/mail-id'), 10);
        if (!mailId) return;
        await window.api.vfMoveMails([mailId], id);
        await loadVFolders();
        loadMails($('#global-search').value);
      });
    });
    refreshUnreadBadges();
  } catch (err) {
    box.innerHTML = `<div class="fav-empty">${escapeHtml(String(err))}</div>`;
  }
}

async function createVFolderPrompt() {
  const name = await inputDialog('새 로컬 폴더', '폴더 이름을 입력하세요', '');
  if (!name) return;
  const res = await window.api.vfCreate(name, null);
  if (!res.ok) return alert('폴더 생성 실패: ' + res.error);
  await loadVFolders();
}

// ---- 안읽음 배지 ----
async function refreshUnreadBadges() {
  try {
    const res = await window.api.dbUnreadCounts();
    if (!res.ok) return;
    const { byFolder, byVirtual, total } = res.counts;
    const badge = $('#mlp-unread-count');
    if (badge) badge.textContent = total || 0;
    $$('[data-unread]').forEach(el => {
      const n = byFolder[el.dataset.unread] || 0;
      el.textContent = n ? `[${n}]` : '';
    });
    $$('[data-vfcnt]').forEach(el => {
      const id = parseInt(el.dataset.vfcnt, 10);
      const vf = vfCache.find(v => v.id === id);
      const u = byVirtual[id] || 0;
      el.textContent = u ? `[${u}]` : (vf ? String(vf.mailCount) : '');
    });
    $$('[data-favcnt]').forEach(el => {
      const key = el.dataset.favcnt;
      const n = key.startsWith('virtual:')
        ? (byVirtual[parseInt(key.split(':')[1], 10)] || 0)
        : (byFolder[key.split(':').slice(1).join(':')] || 0);
      el.textContent = n ? `[${n}]` : '';
    });
  } catch (_) {}
}

// ---- 컨텍스트 메뉴 엔진 ----
function showContextMenu(e, items) {
  const menu = $('#ctx-menu');
  menu.innerHTML = items.map((it, i) => {
    if (it.sep) return '<div class="ctx-sep"></div>';
    const dis = it.disabled ? ' ctx-disabled' : '';
    return `<button class="ctx-item${dis}" data-i="${i}"${it.disabled ? ' disabled aria-disabled="true"' : ''} title="${escapeHtml(it.hint || '')}">${escapeHtml(it.label)}</button>`;
  }).join('');
  menu.classList.remove('hidden');
  // 화면 밖으로 나가지 않게 보정
  const r = menu.getBoundingClientRect();
  const x = Math.min(e.clientX, window.innerWidth - r.width - 8);
  const y = Math.min(e.clientY, window.innerHeight - r.height - 8);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.querySelectorAll('.ctx-item').forEach(b => b.addEventListener('click', async () => {
    const it = items[parseInt(b.dataset.i, 10)];
    hideContextMenu();
    if (it && !it.disabled && it.action) await it.action();
  }));
}
function hideContextMenu() { const m = $('#ctx-menu'); if (m) m.classList.add('hidden'); }

// ---- 폴더 우클릭 메뉴 (Outlook 모양 유지 / 로컬 범위만 동작) ----
function showFolderMenu(e, target) {
  const isVirtual = target.kind === 'virtual';
  const favKey = target.key || (isVirtual ? `virtual:${target.vfId}` : `real:${target.name}`);
  const isFav = favCache.some(f => f.key === favKey);
  const isOutlookFav = favCache.some(f => f.key === favKey && f.source === 'outlook');
  const items = [
    { label: '새 폴더…', action: async () => {
        const name = await inputDialog('새 로컬 폴더', '폴더 이름', '');
        if (!name) return;
        const r = await window.api.vfCreate(name, isVirtual ? target.vfId : null);
        if (!r.ok) return alert('폴더 생성 실패: ' + r.error);
        await loadVFolders();
      } },
    { label: '폴더 이름 바꾸기', disabled: !isVirtual,
      hint: isVirtual ? '' : 'Outlook 원본 폴더는 Bmail에서 변경하지 않습니다',
      action: async () => {
        const name = await inputDialog('폴더 이름 바꾸기', '새 이름', target.name);
        if (!name) return;
        const r = await window.api.vfRename(target.vfId, name);
        if (!r.ok) return alert('이름 변경 실패: ' + r.error);
        await loadVFolders(); await loadFavorites();
      } },
    { label: '폴더 삭제', disabled: !isVirtual,
      hint: isVirtual ? '' : 'Outlook 원본 폴더는 삭제하지 않습니다',
      action: async () => {
        if (!confirm(`로컬 폴더 "${target.name}"을(를) 삭제할까요?\n\n안에 있던 메일은 삭제되지 않고 원래 폴더 표시로 돌아갑니다.\n(Outlook 원본은 영향 없음)`)) return;
        const r = await window.api.vfDelete(target.vfId);
        if (!r.ok) return alert('삭제 실패: ' + r.error);
        if (currentVFolder === target.vfId) { currentVFolder = null; currentFolder = 'all'; $('#mlp-title').textContent = '전체 메일'; }
        await loadVFolders(); await loadFavorites();
        loadMails($('#global-search').value);
      } },
    { sep: true },
    { label: '모두 읽은 상태로 표시', action: async () => {
        const r = await window.api.mailMarkFolderRead(isVirtual ? { vfolderId: target.vfId } : { folder: target.name });
        if (!r.ok) return alert('실패: ' + r.error);
        await refreshUnreadBadges();
        loadMails($('#global-search').value);
      } },
    { label: isFav ? '즐겨찾기에서 제거' : '즐겨찾기에 추가',
      // Outlook 에서 가져온 항목은 다음 동기화 때 정본대로 되돌아온다(정직 고지).
      hint: isOutlookFav ? 'Outlook 즐겨찾기 — 지워도 동기화 때 다시 나타납니다' : undefined,
      action: () => toggleFavorite({ kind: target.kind, name: target.name, vfId: target.vfId, key: favKey }) },
    { sep: true },
    { label: '위로 이동', disabled: !target.isFavorite || isOutlookFav,
      hint: isOutlookFav ? '순서는 Outlook 탐색 창을 따릅니다' : '즐겨찾기 항목에서만 사용',
      action: async () => { await window.api.favMove(favKey, 'up'); await loadFavorites(); } },
    { label: '아래로 이동', disabled: !target.isFavorite || isOutlookFav,
      hint: isOutlookFav ? '순서는 Outlook 탐색 창을 따릅니다' : '즐겨찾기 항목에서만 사용',
      action: async () => { await window.api.favMove(favKey, 'down'); await loadFavorites(); } },
    { label: '하위 폴더를 오름차순 정렬', disabled: !isVirtual && !!target.name,
      action: async () => { await window.api.vfSortChildren(isVirtual ? target.vfId : null); await loadVFolders(); } },
    { sep: true },
    // ★ Outlook 은 사이드바의 사용자 정의 순서를 COM 으로 노출하지 않는다(실측).
    //   그래서 트리 순서는 Bmail 이 로컬에 기억한다.
    { label: '트리에서 위로 이동', disabled: !target.treePath,
      hint: target.treePath ? '' : 'Outlook 폴더 트리 항목에서만 사용',
      action: () => moveTreeFolder(target.treeStore, target.treePath, -1) },
    { label: '트리에서 아래로 이동', disabled: !target.treePath,
      hint: target.treePath ? '' : 'Outlook 폴더 트리 항목에서만 사용',
      action: () => moveTreeFolder(target.treeStore, target.treePath, 1) },
    { sep: true },
    { label: '폴더 이동', disabled: true, hint: 'Outlook 원본 보호를 위해 지원하지 않습니다' },
    { label: '폴더 복사', disabled: true, hint: 'Outlook 원본 보호를 위해 지원하지 않습니다' },
    { label: '속성', disabled: true, hint: 'Outlook 원본 보호를 위해 지원하지 않습니다' }
  ];
  showContextMenu(e, items);
}

// ---- 메일 우클릭 메뉴 ----
function showMailMenu(e, mail) {
  const unread = mailIsUnread(mail);
  const cur = mail.action_state || null;
  const sug = actionSuggestCache[mail.id];
  const items = [
    // ★ 내 처리 상태 — 같은 항목을 다시 누르면 해제(토글)
    ...AS_KEYS.map((k, i) => ({
      label: `${cur === k ? '✓ ' : ''}${AS_META[k].label}  (${i + 1})`,
      action: () => setActionFor([mail.id], cur === k ? null : k)
    })),
    ...(cur ? [{ label: '상태 해제  (0)', action: () => setActionFor([mail.id], null) }] : []),
    ...(!cur && sug ? [{ label: `← ${sug.text}`, action: () => setActionFor([mail.id], sug.state) }] : []),
    { sep: true },
    { label: unread ? '읽은 상태로 표시' : '읽지 않음으로 표시',
      action: async () => {
        await window.api.mailSetRead([mail.id], unread);
        await refreshUnreadBadges();
        loadMails($('#global-search').value);
      } },
    { sep: true },
    ...(vfCache.length
      ? vfCache.map(v => ({ label: `폴더로 이동 › ${v.name}`, action: async () => {
          await window.api.vfMoveMails([mail.id], v.id);
          await loadVFolders(); loadMails($('#global-search').value);
        } }))
      : [{ label: '폴더로 이동 (로컬 폴더 없음)', disabled: true, hint: '먼저 내 로컬 폴더를 만드세요' }]),
    ...(mail.vfolder_name ? [{ label: '원래 폴더로 되돌리기', action: async () => {
        await window.api.vfMoveMails([mail.id], null);
        await loadVFolders(); loadMails($('#global-search').value);
      } }] : []),
    { sep: true },
    { label: '삭제', disabled: true, hint: 'Outlook 원본 보호를 위해 지원하지 않습니다' }
  ];
  showContextMenu(e, items);
}

// 내가 직접 수신(To)인지 참조(CC)인지 마커 (Outlook 의 '나에게' 표시에 대응)
function toMeMarker(m) {
  if (m.to_me === 1) return `<span class="mi-tome" title="내가 받는사람(To)">${icon('chevron', 11)}</span>`;
  if (m.to_me === 0) return '<span class="mi-cc" title="참조(CC)로 받음">참조</span>';
  return '';
}

// ============================================================
//  메일별 내 처리 상태 (todo 할일 / hold 보류 / done 처리 / fyi 확인)
//  ------------------------------------------------------------
//  · 색만으로 구분하지 않는다 — 배지에 항상 한글 라벨을 함께 넣는다(색맹 대응).
//  · 대비 실측: 할일 #b91c1c/#fef2f2 5.91:1 · 보류 #854d0e/#fefce8 6.62:1
//               처리 #166534/#f0fdf4 6.81:1 · 확인 #374151/#f3f4f6 9.37:1 (전부 WCAG AA)
// ============================================================
const AS_META = {
  todo: { label: '할 일', cls: 'as-todo' },
  hold: { label: '보류', cls: 'as-hold' },
  done: { label: '처리', cls: 'as-done' },
  fyi: { label: '확인', cls: 'as-fyi' }
};
const AS_KEYS = ['todo', 'hold', 'done', 'fyi'];
// 목록의 처리 상태 필터 — 배열(같은 축 안에서는 합집합). 빈 배열 = 전체.
//  저장하지 않으므로 앱을 다시 켜면 항상 '모든 항목'으로 돌아온다.
let actionTab = [];
let actionSuggestCache = {};   // id → 제안 (표시용, 저장 안 함)

function actionBadge(m) {
  const s = m && m.action_state;
  if (!AS_META[s]) return '';
  const due = m.action_due ? ` ${m.action_due}` : '';
  return `<span class="as-badge ${AS_META[s].cls}" title="내 처리 상태: ${AS_META[s].label}${due ? ' · 기한 ' + m.action_due : ''}">${AS_META[s].label}${escapeHtml(due)}</span>`;
}

// 선택된 메일들의 상태를 바꾼다 (같은 상태를 다시 누르면 해제 = 토글)
async function setActionFor(ids, state) {
  const list = (ids || []).filter(Number.isFinite);
  if (!list.length) return;
  const r = await window.api.actionSet(list, state);
  if (!r || r.ok === false) { alert('상태 저장 실패: ' + (r && r.error)); return; }
  await refreshActionCounts();
  await refreshAfterActionChange();
  const info = $('#sync-info');
  if (info) {
    info.textContent = state
      ? `${list.length}건을 '${AS_META[state].label}'(으)로 표시했습니다${r.propagated ? ` (같은 대화 ${r.propagated}건 포함)` : ''}`
      : `${list.length}건의 상태를 해제했습니다`;
  }
}

async function undoActionFor(ids) {
  const list = (ids || []).filter(Number.isFinite);
  if (!list.length) return;
  await window.api.actionUndo(list);
  await refreshActionCounts();
  await refreshAfterActionChange();
  const info = $('#sync-info');
  if (info) info.textContent = '상태를 이전 값으로 되돌렸습니다.';
}

// 상태가 바뀌면 지금 보고 있는 화면만 조용히 다시 그린다(스크롤 유지)
async function refreshAfterActionChange() {
  if ($('#view-todo') && $('#view-todo').classList.contains('active')) { await loadTodoView(); return; }
  if ($('#view-mail') && $('#view-mail').classList.contains('active')) {
    const st = captureListState('#mail-list');
    await loadMails($('#global-search').value, { silent: true });
    restoreListState(st);
  }
  if ($('#view-followup') && $('#view-followup').classList.contains('active')) await loadFollowup();
  loadFollowup();   // 회신대기 배지(처리·확인은 목록에서 빠진다)
}

async function refreshActionCounts() {
  try {
    const r = await window.api.actionCounts();
    if (!r.ok) return;
    const c = r.counts || {};
    $$('[data-ascnt]').forEach(el => { el.textContent = (c[el.dataset.ascnt] || 0).toLocaleString(); });
    $$('[data-tdcnt]').forEach(el => { el.textContent = (c[el.dataset.tdcnt] || 0).toLocaleString(); });
    const nav = $('#cnt-todo');
    if (nav) nav.textContent = (c.todo || 0).toLocaleString();
  } catch (_) { }
}

// ============================================================
//  목록 필터 — 축 간 AND, 같은 축 안에서는 OR
//  ------------------------------------------------------------
//  🔴 실사용 사고: 서로 배타적인 필터가 AND 로 누적돼 받은편지함이 0건이 됐고
//     (읽지 않음 ∩ 받은편지함 = 0건), 안내문은 "동기화하세요"라 오진을 유발했다.
//     → '모든 항목'은 전 필터를 완전히 초기화하고, 0건일 때는 실제 원인을 보여 준다.
// ============================================================
function activeFilterLabels() {
  const out = [];
  if (readTab === 'unread') out.push('읽지 않음');
  if (toMeTab === 1) out.push('직접 수신');
  if (toMeTab === 0) out.push('참조');
  if ($('#filter-attach') && $('#filter-attach').checked) out.push('첨부 있음');
  actionTab.forEach(v => out.push(v === 'none' ? '미지정' : (AS_META[v] ? AS_META[v].label : v)));
  if (currentVFolder) out.push('내 로컬 폴더');
  return out;
}

function hasActiveFilter() { return activeFilterLabels().length > 0; }

// 모든 필터를 끄고 '모든 항목'으로 되돌린다
function resetAllFilters(reload = true) {
  readTab = 'all';
  toMeTab = null;
  actionTab = [];
  if ($('#filter-attach')) $('#filter-attach').checked = false;
  syncFilterUI();
  if (reload) loadMails($('#global-search').value);
}

// 버튼 활성 표시를 현재 필터 상태와 일치시킨다
function syncFilterUI() {
  $$('[data-readtab]').forEach(x => x.classList.toggle('active', x.dataset.readtab === readTab));
  $$('[data-tometab]').forEach(x => x.classList.toggle('active', toMeTab !== null && String(toMeTab) === x.dataset.tometab));
  $$('.as-chip').forEach(x => x.classList.toggle('active', actionTab.includes(x.dataset.astab)));
  const rb = $('#btn-filter-reset');
  if (rb) rb.classList.toggle('hidden', !hasActiveFilter());
  const sum = $('#filter-summary');
  if (sum) {
    const l = activeFilterLabels();
    sum.textContent = l.length ? `필터: ${l.join(' + ')}` : '';
    sum.classList.toggle('hidden', !l.length);
  }
}

// 지금 화면의 메일들에 대한 자동 제안을 받아 캐시 (수동 지정된 건 제안하지 않는다)
async function loadActionSuggestions(mails) {
  const ids = (mails || []).filter(m => !m.action_state).map(m => m.id).slice(0, 120);
  if (!ids.length) return;
  try {
    const r = await window.api.actionSuggest(ids);
    if (r.ok) Object.assign(actionSuggestCache, r.suggestions || {});
  } catch (_) { }
}

// ---- '할 일' 뷰 (상태별 목록, 회신대기와 같은 2분할 컴포넌트 재사용) ----
let todoState = 'todo';
let todoCache = [];

async function loadTodoView() {
  const box = $('#todo-list');
  if (!box) return;
  box.innerHTML = '<div class="empty">불러오는 중...</div>';
  try {
    const r = await window.api.actionList(todoState, 300);
    if (!r.ok) { box.innerHTML = `<div class="empty">${escapeHtml(r.error)}</div>`; return; }
    const mails = r.mails || [];
    todoCache = mails;
    const c = r.counts || {};
    $$('[data-tdcnt]').forEach(el => { el.textContent = (c[el.dataset.tdcnt] || 0).toLocaleString(); });
    const tot = $('#todo-total');
    if (tot) tot.textContent = mails.length.toLocaleString();
    if (!mails.length) {
      box.innerHTML = `<div class="empty">'${AS_META[todoState] ? AS_META[todoState].label : todoState}' 로 표시한 메일이 없습니다.<br>메일 목록에서 우클릭하거나 숫자키 1~4 로 지정하세요.</div>`;
      return;
    }
    let last = null, html = '';
    for (const m of mails) {
      const g = m.action_due ? `기한 ${m.action_due}` : dateGroup(m.received_at);
      if (g !== last) { last = g; html += `<div class="date-group"><span class="dg-name">${escapeHtml(g)}</span></div>`; }
      html += `<button class="fu-item" data-mid="${m.id}">
          <span class="fu-days ${m.action_due ? 'fu-hot' : ''}">${escapeHtml(AS_META[m.action_state] ? AS_META[m.action_state].label : '미지정')}</span>
          <span class="fu-main">
            <span class="fu-subject">${importanceMarker(m)}${categoryDots(m)}${escapeHtml(m.subject || '(제목 없음)')}</span>
            <span class="fu-meta">${escapeHtml(String(m.folder || '') === 'Sent' ? '보냄' : (m.sender_name || m.sender_email || ''))} · ${escapeHtml(m.received_at || '')} · ${escapeHtml(m.folder || '')}${m.action_note ? ' · ' + escapeHtml(m.action_note) : ''}</span>
            <span class="fu-prev">${escapeHtml((m.preview || '').replace(/\s+/g, ' ').slice(0, 110))}</span>
          </span>
        </button>`;
    }
    box.innerHTML = html;
    box.querySelectorAll('.fu-item').forEach(b => {
      b.addEventListener('click', async () => {
        box.querySelectorAll('.fu-item').forEach(x => x.classList.remove('selected'));
        b.classList.add('selected');
        useReadingPane('todo');
        await openMailDetail({ id: parseInt(b.dataset.mid, 10) });
      });
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        const m = todoCache.find(x => x.id === parseInt(b.dataset.mid, 10));
        if (m) showMailMenu(e, m);
      });
    });
  } catch (err) {
    box.innerHTML = `<div class="empty">${escapeHtml(String(err))}</div>`;
  }
}

// ---- Outlook 잔여 데이터 마커 (범주 색점 / 깃발 / 중요도) ----
//  ★ 색만으로 구분하지 않는다: 범주는 점 + title 에 이름, 깃발은 '깃발' 글자, 중요도는 '!' 기호.
let categoryColorMap = {};   // 범주명 → HEX (설정 화면 로드 시 채워짐)
function categoryDots(m) {
  const raw = String(m.categories || '').trim();
  if (!raw) return '';
  const names = raw.split(/[;,]/).map(s => s.trim()).filter(Boolean).slice(0, 4);
  if (!names.length) return '';
  return names.map(n =>
    `<span class="ml-cat-dot" style="background:${escapeHtml(categoryColorMap[n] || '#8a8886')}" title="범주: ${escapeHtml(n)}"></span>`
  ).join('');
}
function flagMarker(m) {
  const f = Number(m.flag_status) || 0;
  if (f !== 2) return '';
  const due = m.task_due ? ` (기한 ${m.task_due})` : '';
  return `<span class="ml-flag" title="Outlook 후속 작업 표시${due}">깃발${due}</span>`;
}
function importanceMarker(m) {
  return Number(m.importance) === 2 ? '<span class="ml-imp" title="중요도 높음">!</span>' : '';
}

function mailIsUnread(m) {
  if (m.eff_unread !== undefined && m.eff_unread !== null) return m.eff_unread === 1;
  if (m.read_flag !== undefined && m.read_flag !== null) return m.read_flag === 0;
  return !!m.unread;
}

// ---- 간단 입력 다이얼로그 (Electron 은 window.prompt 미지원) ----
function inputDialog(title, label, defaultValue = '') {
  return new Promise(resolve => {
    const back = document.createElement('div');
    back.className = 'modal-backdrop';
    back.innerHTML = `
      <div class="modal-box input-dialog">
        <div class="modal-head"><h2>${escapeHtml(title)}</h2></div>
        <div class="modal-body">
          <label class="idlg-label">${escapeHtml(label)}</label>
          <input type="text" class="idlg-input" value="${escapeHtml(defaultValue)}" />
          <div class="idlg-actions">
            <button class="btn-primary idlg-ok">확인</button>
            <button class="idlg-cancel">취소</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(back);
    const input = back.querySelector('.idlg-input');
    const done = (v) => { back.remove(); resolve(v); };
    back.querySelector('.idlg-ok').addEventListener('click', () => done(input.value.trim() || null));
    back.querySelector('.idlg-cancel').addEventListener('click', () => done(null));
    back.addEventListener('click', (e) => { if (e.target === back) done(null); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(input.value.trim() || null);
      if (e.key === 'Escape') done(null);
    });
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}

// ------------------------------------------------------------
//  Outlook 폴더 계층 트리 (실제 폴더 구조 그대로)
//  ponytail: DB 는 폴더 '이름'만 저장하므로 클릭 필터는 이름 기준이다.
//            서로 다른 경로에 같은 이름의 폴더가 있으면 함께 잡힌다(알려진 한계).
// ------------------------------------------------------------
//  Outlook 사이드바 '표시 순서' 복원 — 정본은 PR_SORT_POSITION(payload 의 sortPos)
//  ------------------------------------------------------------
//  실측(2026-08-04, 받은 편지함 하위 24개 · 마스터 화면 대조 24/24 일치):
//    · Outlook 은 형제 폴더 순서를 PR_SORT_POSITION(0x30200102) 가변길이 바이너리에 담는다.
//      같은 부모 안에서 '바이트열 사전식 오름차순' = 화면 순서.
//      hex 소문자 문자열 비교 = 바이트열 비교와 동일하므로 문자열 비교로 충분하다.
//    · 정렬키가 없는 폴더(한 번도 수동 이동 안 됨)는 '빈 키' = 최소값 → 형제 중 맨 앞.
//      (예: 받은 편지함의 '가스앤텍', 견적의 'HPS LPG TANK')
//    · 키가 하나도 없는 그룹은 Outlook 이 이름순으로 보여준다(예: 한화파워시스템 하위 7개).
//    · 최상위(스토어 직속) 특수 폴더는 이름 규칙(SPECIAL_ORDER)으로 Outlook 관례 순서를 맞춘다.
//  COM 열거 순번(sib)은 정렬키가 전혀 없을 때의 최후 보루로만 쓴다.
// ------------------------------------------------------------
const SPECIAL_ORDER = [
  '받은 편지함', 'Inbox', '임시 보관함', 'Drafts', '보낸 편지함', 'Sent',
  '지운 편지함', 'Deleted Items', 'RSS 피드', 'RSS Feeds',
  '보낼 편지함', 'Outbox', '정크 메일', 'Junk Email', '검색 폴더', 'Search Folders'
];
function specialRank(name) {
  const i = SPECIAL_ORDER.indexOf(String(name));
  return i === -1 ? Infinity : i;
}
// Outlook 폴더 창의 이름 정렬 = 숫자·영문 먼저, 한글 나중.
//  JS 의 localeCompare('ko') 는 한글을 앞에 놓아 화면과 어긋난다(실측: 한화파워시스템 하위).
function treeNameCompare(a, b) {
  const A = String(a || ''), B = String(b || '');
  const isKo = (s) => /^[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(s);
  const ka = isKo(A) ? 1 : 0, kb = isKo(B) ? 1 : 0;
  if (ka !== kb) return ka - kb;
  return A.localeCompare(B, 'ko');
}
let folderOrderMap = {};     // '스토어/경로' → 순번 (마스터가 우클릭으로 직접 정한 순서만)
async function loadFolderOrder() {
  try { const r = await window.api.folderOrderGet(); if (r.ok) folderOrderMap = r.order || {}; } catch (_) {}
}
function sortLikeOutlook(list) {
  // 형제 그룹 = (store + parentPath)
  const groups = new Map();
  for (const f of list) {
    const key = `${f.store} ${f.parentPath || ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  for (const arr of groups.values()) {
    // 그룹 안에 정렬키가 하나라도 있으면 sortPos 로, 하나도 없으면 이름순(Outlook 동작)
    const anyKey = arr.some(f => f.sortPos);
    arr.sort((a, b) => {
      // ① 마스터가 직접 정한 순서(로컬 저장)가 있으면 최우선
      const oa = folderOrderMap[`${a.store}/${a.path}`];
      const ob = folderOrderMap[`${b.store}/${b.path}`];
      if (oa !== undefined || ob !== undefined) {
        if (oa === undefined) return 1;
        if (ob === undefined) return -1;
        if (oa !== ob) return oa - ob;
      }
      // ② 특수 폴더 우선 (Outlook 관례 순서)
      const ra = specialRank(a.name), rb = specialRank(b.name);
      if (ra !== rb) return ra - rb;
      // ③ PR_SORT_POSITION (없으면 맨 앞)
      if (anyKey) {
        const sa = a.sortPos || '', sb = b.sortPos || '';
        if (sa !== sb) { if (!sa) return -1; if (!sb) return 1; return sa < sb ? -1 : 1; }
      }
      // ④ 이름순 → 그래도 같으면 COM 순번
      const n = treeNameCompare(a.name, b.name);
      return n !== 0 ? n : (a.sib || 0) - (b.sib || 0);
    });
  }
  // 계층 순서대로 평탄화 (부모 바로 뒤에 그 자식들)
  const out = [];
  const walk = (store, parentPath) => {
    const arr = groups.get(`${store} ${parentPath}`) || [];
    for (const f of arr) { out.push(f); walk(store, f.path); }
  };
  // ★ 스토어 순서: 기본 계정(내 메일함) → 아카이브. Outlook 도 기본 계정을 먼저 보여준다.
  const storeNames = [...new Set(list.map(f => f.store))];
  const isDefaultStore = (name) => list.some(f => f.store === name && f.isDefault);
  storeNames.sort((a, b) => (isDefaultStore(b) ? 1 : 0) - (isDefaultStore(a) ? 1 : 0));
  for (const store of storeNames) walk(store, '');
  // 혹시 누락된 항목(경로 불일치)이 있으면 뒤에 붙여 유실 방지
  if (out.length !== list.length) {
    const seen = new Set(out.map(f => `${f.store}/${f.path}`));
    list.forEach(f => { if (!seen.has(`${f.store}/${f.path}`)) out.push(f); });
  }
  return out;
}

// 트리에서 폴더 순서 이동 (형제 그룹 안에서 한 칸씩) → 로컬 저장
async function moveTreeFolder(store, path, dir) {
  if (!store || !path) return;
  const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  // 현재 렌더된 형제 목록을 화면 순서 그대로 수집
  const sibs = [...document.querySelectorAll('#folder-tree .tree-item')]
    .map(e => ({ store: e.dataset.store, path: e.dataset.path }))
    .filter(x => x.store === store &&
      (x.path.includes('/') ? x.path.slice(0, x.path.lastIndexOf('/')) : '') === parentPath);
  const i = sibs.findIndex(x => x.path === path);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= sibs.length) return;
  [sibs[i], sibs[j]] = [sibs[j], sibs[i]];
  const res = await window.api.folderOrderSet(sibs.map((x, k) => ({ store: x.store, path: x.path, ord: k })));
  if (!res.ok) { alert('순서 저장 실패: ' + res.error); return; }
  renderFolderTree(treeFolders, treeFetchedAt);
}

// ------------------------------------------------------------
//  펼침/접힘 상태 (마지막 상태 기억)
//   기본값: 스토어 + 최상위 폴더(받은 편지함 등)는 펼침, 그 아래는 접힘.
// ------------------------------------------------------------
const TREE_EXPAND_KEY = 'bmail.folderTree.expand';
let treeExpand = {};
try { treeExpand = JSON.parse(localStorage.getItem(TREE_EXPAND_KEY) || '{}') || {}; } catch (_) { treeExpand = {}; }
function saveTreeExpand() {
  try { localStorage.setItem(TREE_EXPAND_KEY, JSON.stringify(treeExpand)); } catch (_) {}
}
// 기본 펼침 규칙 — 마스터 Outlook 화면과 같게 (2026-08-04 실측 대조로 확정):
//   · 받은 편지함 줄기만 depth 1 까지 펼친다 → 프로젝트 폴더(22K FD·유일 loadout beam·한라ims·
//     중앙해양·한화파워시스템·견적)의 자식까지 열자마자 보인다.
//   · 지운 편지함·보낸 편지함·정크 메일 등 나머지 최상위 폴더는 접는다.
//     (예전엔 depth 만 보고 펼쳐서 지운 편지함 하위 30여 개가 화면을 덮었다 — 실측 166행 노출)
//   · 마스터가 직접 접거나 편 폴더는 treeExpand 에 남아 이 기본값보다 우선한다.
const TREE_DEFAULT_OPEN_DEPTH = 1;
function isInboxBranch(p) {
  const top = String(p || '').split('/')[0];
  return top === '받은 편지함' || top === 'Inbox';
}
function isTreeExpanded(key, depth, folderPath) {
  if (Object.prototype.hasOwnProperty.call(treeExpand, key)) return !!treeExpand[key];
  if (depth < 0) return true;                       // 스토어(계정) 노드는 항상 펼침
  return isInboxBranch(folderPath) && depth <= TREE_DEFAULT_OPEN_DEPTH;
}

let folderTreeLoaded = false;      // 한 번이라도 화면에 그렸는가
let treeLoading = false;           // 중복 호출 방지
let treeFolders = [];              // 마지막으로 그린 폴더 목록(순서 이동·재렌더용)
let treeFetchedAt = '';            // 마지막 Outlook 확인 시각
let activeTreeKey = '';            // 선택된 트리 항목(스토어/경로) — 재렌더 후 선택 유지

function treeIconFor(name) {
  const nm = String(name);
  return /받은 편지함|Inbox/i.test(nm) ? 'inbox'
    : (/보낸 편지함|Sent/i.test(nm) ? 'send'
      : (/지운 편지함|삭제|Deleted/i.test(nm) ? 'trash'
        : (/정크|스팸|Junk/i.test(nm) ? 'flag'
          : (/임시 보관함|Draft/i.test(nm) ? 'file' : 'folder'))));
}

// 폴더 목록(평탄) → 계층 DOM 문자열
function renderFolderTree(folders, at) {
  const box = $('#folder-tree');
  if (!box) return;
  treeFolders = folders || [];
  treeFetchedAt = at || treeFetchedAt;
  const sorted = sortLikeOutlook(treeFolders);
  if (!sorted.length) { box.innerHTML = '<div class="empty-sm">표시할 폴더가 없습니다.</div>'; return; }

  // 부모 → 자식 색인 (평탄 목록에서 계층 복원)
  const children = new Map();               // '스토어/부모경로' → [폴더]
  for (const f of sorted) {
    const pk = `${f.store} ${f.parentPath || ''}`;
    if (!children.has(pk)) children.set(pk, []);
    children.get(pk).push(f);
  }

  const nodeHtml = (f) => {
    const key = `${f.store}/${f.path}`;
    const kids = children.get(`${f.store} ${f.path}`) || [];
    const open = kids.length ? isTreeExpanded(key, f.depth, f.path) : false;
    const dim = f.dbCount === 0 && f.items === 0;      // 완전히 빈 폴더만 흐리게
    const special = specialRank(f.name) !== Infinity;
    const tip = `${f.path} · Outlook ${f.items}건 / 저장됨 ${f.dbCount}건`;
    return `<div class="tree-node${kids.length && !open ? ' collapsed' : ''}" data-key="${escapeHtml(key)}">
      <div class="tree-row" style="padding-left:${4 + Math.max(0, f.depth) * 13}px">
        ${kids.length
        ? `<button class="tree-tog" type="button" data-tog="${escapeHtml(key)}" aria-expanded="${open}" aria-label="${escapeHtml(f.name)} 하위 폴더 ${kids.length}개 ${open ? '접기' : '펼치기'}" title="하위 폴더 ${kids.length}개">${open ? '▾' : '▸'}</button>`
        : '<span class="tree-tog tree-tog-empty" aria-hidden="true"></span>'}
        <button class="tree-item${dim ? ' tree-dim' : ''}${special ? ' tree-special' : ''}${activeTreeKey === key ? ' active' : ''}"
          type="button" data-folder="${escapeHtml(f.name)}" data-store="${escapeHtml(f.store)}"
          data-path="${escapeHtml(f.path)}" data-key="${escapeHtml(key)}" title="${escapeHtml(tip)}">
          ${icon(treeIconFor(f.name), 13, 'tree-ic')}
          <span class="tree-name">${escapeHtml(f.name)}</span>
          <span class="tree-unread" data-unread="${escapeHtml(f.name)}"></span>
          <span class="tree-count">${f.dbCount}</span>
        </button>
      </div>
      ${kids.length ? `<div class="tree-children">${kids.map(nodeHtml).join('')}</div>` : ''}
    </div>`;
  };

  // 스토어(계정)별 묶음 — 스토어 자체도 접을 수 있다
  const storeNames = [...new Set(sorted.map(f => f.store))];
  let html = '';
  for (const store of storeNames) {
    const tops = children.get(`${store} `) || [];
    const isDef = sorted.some(f => f.store === store && f.isDefault);
    const skey = `store::${store}`;
    const open = isTreeExpanded(skey, -1);
    html += `<div class="tree-node tree-node-store${open ? '' : ' collapsed'}" data-key="${escapeHtml(skey)}">
      <div class="tree-row tree-store-row">
        <button class="tree-tog" type="button" data-tog="${escapeHtml(skey)}" aria-expanded="${open}"
          aria-label="${escapeHtml(store)} 계정 ${open ? '접기' : '펼치기'}">${open ? '▾' : '▸'}</button>
        <span class="tree-store">${escapeHtml(store)}${isDef ? '' : ' <span class="tree-arch">아카이브</span>'}</span>
      </div>
      <div class="tree-children">${tops.map(nodeHtml).join('')}</div>
    </div>`;
  }
  const scroll = box.scrollTop;
  box.innerHTML = html;
  box.scrollTop = scroll;
  updateTreeStatus();
  refreshUnreadBadges();
}

function updateTreeStatus(msg) {
  const el = $('#tree-status');
  if (!el) return;
  if (msg) { el.textContent = msg; el.title = msg; return; }
  const n = treeFolders.length;
  const t = treeFetchedAt ? new Date(treeFetchedAt) : null;
  const hhmm = t && !isNaN(t) ? `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}` : '-';
  el.textContent = `폴더 ${n}개 · ${hhmm} 기준`;
  el.title = `Outlook 폴더 ${n}개 · 마지막 확인 ${t && !isNaN(t) ? t.toLocaleString() : '없음'}`;
}

// 트리 클릭·우클릭은 위임 1곳에서 처리 (폴더 200개+ 에 리스너를 붙이지 않는다)
function bindFolderTreeEvents() {
  const box = $('#folder-tree');
  if (!box || box.dataset.bound === '1') return;
  box.dataset.bound = '1';
  box.addEventListener('click', (e) => {
    const tog = e.target.closest('.tree-tog[data-tog]');
    if (tog) {
      const node = tog.closest('.tree-node');
      const open = node.classList.toggle('collapsed') === false;
      tog.textContent = open ? '▾' : '▸';
      tog.setAttribute('aria-expanded', String(open));
      treeExpand[tog.dataset.tog] = open;
      saveTreeExpand();
      return;
    }
    const item = e.target.closest('.tree-item');
    if (!item) return;
    activeTreeKey = item.dataset.key || '';
    selectRealFolder(item.dataset.folder, item.dataset.folder);
    item.classList.add('active');
  });
  // 우클릭: 즐겨찾기 추가/제거, 모두 읽음 등 (Outlook 원본 변경 항목은 비활성)
  box.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.tree-item');
    if (!item) return;
    e.preventDefault(); e.stopPropagation();
    showFolderMenu(e, {
      kind: 'real', name: item.dataset.folder, key: `real:${item.dataset.folder}`,
      treeStore: item.dataset.store, treePath: item.dataset.path
    });
  });
}

// ------------------------------------------------------------
//  트리 로드 — 캐시 즉시 렌더 → Outlook 실측으로 교체
//   COM 열거는 244폴더 기준 9.4초가 걸린다. 캐시를 먼저 그려 시작 직후에도 트리가 보인다.
// ------------------------------------------------------------
async function loadFolderTree(force = false) {
  const box = $('#folder-tree');
  if (!box) return;
  if (treeLoading) return;
  if (folderTreeLoaded && !force) return;
  treeLoading = true;
  bindFolderTreeEvents();
  try {
    await loadFolderOrder();
    if (!folderTreeLoaded) {
      try {
        const c = await window.api.outlookFolderTree({ cached: true });
        if (c && c.ok && (c.folders || []).length) { renderFolderTree(c.folders, c.at); folderTreeLoaded = true; }
      } catch (_) {}
    }
    if (!folderTreeLoaded) box.innerHTML = '<div class="empty-sm">Outlook 폴더 구조를 읽는 중…</div>';
    updateTreeStatus(folderTreeLoaded ? 'Outlook 확인 중…' : '읽는 중…');
    const res = await window.api.outlookFolderTree();
    if (!res || !res.ok) {
      const msg = (res && res.error) || '알 수 없음';
      if (!folderTreeLoaded) box.innerHTML = `<div class="empty-sm">폴더 구조 확인 실패: ${escapeHtml(msg)}</div>`;
      else updateTreeStatus(`갱신 실패: ${msg}`);
      return;
    }
    // ★ Outlook 사이드바와 1:1 이 되도록 '빈 폴더도 그대로' 표시한다.
    renderFolderTree(res.folders || [], res.at);
    folderTreeLoaded = true;
  } catch (err) {
    if (!folderTreeLoaded) box.innerHTML = `<div class="empty-sm">${escapeHtml(String(err))}</div>`;
    else updateTreeStatus(`갱신 실패: ${String(err)}`);
  } finally {
    treeLoading = false;
  }
}

// ------------------------------------------------------------
//  검색 그라운딩: AI 답변의 근거가 된 실제 메일을 채팅에 목록으로 첨부
//  (AI 텍스트만 나오고 실제 메일이 안 보이던 문제 해결)
// ------------------------------------------------------------
//  해석된 검색 조건 칩 (날짜·발신자·키워드 …) — 왜 이 결과인지 보이게 한다
function renderCondChips(chips, count) {
  if (!chips || !chips.length) return '';
  return `<div class="cond-chips">해석한 조건: ${chips.map(c =>
    `<span class="cond-chip">${escapeHtml(c.label)}</span>`).join('')}${
    count != null ? `<span class="cond-count">해당 ${Number(count).toLocaleString()}건</span>` : ''}</div>`;
}

//  target 이 주어지면 그 말풍선 안에 붙인다(응답 카드와 근거 목록을 하나로 = 중복 카드 제거)
function renderGroundedMails(mails, meta, target) {
  const log = $('#chat-log');
  const div = target || document.createElement('div');
  if (!target) div.className = 'msg assistant';
  if (!mails.length) {
    if (target) return;                 // 안내 문구는 응답 카드가 이미 갖고 있다
    //  ★ 정직한 안내: 정말 0건일 때만 '없다'고 하고, DB 가 비었을 때만 동기화를 권한다.
    const m = meta || {};
    const chips = renderCondChips(m.chips, 0);
    const empty = (m.dbTotal === 0)
      ? '저장된 메일이 아직 없습니다. 상단 <b>동기화</b>를 먼저 실행하세요.'
      : '이 조건에 맞는 메일이 없습니다. 조건(날짜·발신자·키워드)을 바꿔 보세요.';
    div.innerHTML = `<div class="bubble">${chips}
      <div class="grounded-head">근거 메일 0건</div>
      <div class="grounded-empty">${empty}</div></div>`;
    log.appendChild(div); log.scrollTop = log.scrollHeight;
    return;
  }
  const listHtml = `<div class="grounded-head">근거 메일 ${mails.length}건 (클릭하면 오른쪽에 내용이 표시됩니다)</div>
    <div class="grounded-list">${mails.map(m => `
      <button class="grounded-item" data-mid="${m.id}" title="클릭: 오른쪽에 표시 · 더블클릭: 전체 메일 화면에서 열기">
        <span class="gi-subject">${escapeHtml(m.subject || '(제목 없음)')}</span>
        <span class="gi-meta">${escapeHtml(m.sender_name || m.sender_email || '')} · ${escapeHtml(m.received_at || '')}${m.has_attach ? ' · 첨부' : ''}</span>
      </button>`).join('')}</div>`;
  if (target) {
    const holder = document.createElement('div');
    holder.className = 'grounded-inline';
    holder.innerHTML = listHtml;
    target.appendChild(holder);
  } else {
    div.innerHTML = `<div class="bubble">${listHtml}</div>`;
  }
  // 클릭 = 검색 화면을 유지한 채 오른쪽 읽기창만 갱신 (연속 클릭 가능)
  div.querySelectorAll('.grounded-item').forEach(b => {
    b.addEventListener('click', () => openMailInChatPane(parseInt(b.dataset.mid, 10), b));
    // 더블클릭 = 기존 동작(전체 메일 뷰로 이동)
    b.addEventListener('dblclick', () => {
      useReadingPane('mail');
      switchView('mail');
      openMailDetail({ id: parseInt(b.dataset.mid, 10) });
    });
  });
  if (!target) log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

// ============================================================
//  대화로 첨부 정리 — 계획 카드 → [실행]/[취소] → 진행률 → 결과
//  ------------------------------------------------------------
//  🔴 [실행]을 누르기 전에는 파일이 단 1개도 만들어지지 않는다.
//     계획 단계(organize:plan)는 첨부 '속성'만 읽는다.
//  후속 대화("PDF만", "날짜별로")는 직전 계획을 수정해 다시 확인을 받는다.
// ============================================================
let organizeLastPlan = null;       // 후속 수정의 기준이 되는 직전 계획
let organizeProgressEl = null;     // 진행률을 표시할 현재 카드의 요소
let organizeProgressBound = false;

// 대화 입력이 '정리 명령' 또는 '정리 이력' 이면 여기서 처리하고 true 를 돌려준다.
//  beforeOutput: 말풍선을 그리기 직전에 호출(진행 중 표시 제거용)
async function tryOrganizeCommand(text, beforeOutput) {
  const done = () => { if (typeof beforeOutput === 'function') beforeOutput(); };
  if (/^\s*(?:첨부\s*)?정리\s*이력|^\s*저장\s*이력/.test(text)) {
    done();
    await showOrganizeHistory();
    return true;
  }
  let res;
  try {
    res = await window.api.organizePlan(text, organizeLastPlan);
  } catch (err) {
    done();
    addMessage('assistant', `정리 계획 오류: ${escapeHtml(String(err))}`);
    return true;
  }
  if (!res || !res.isOrganize) return false;      // 정리 명령이 아니면 평소대로 AI 질의
  done();
  if (!res.ok) {
    addMessage('assistant', `<div class="org-head">첨부 정리를 시작할 수 없습니다</div>
      <div class="org-error">${escapeHtml(res.error || '알 수 없는 오류')}</div>`);
    return true;
  }
  organizeLastPlan = res.plan;
  renderOrganizePlanCard(res);
  return true;
}

function renderOrganizePlanCard(res) {
  const s = res.summary, plan = res.plan;
  const log = $('#chat-log');
  const div = document.createElement('div');
  div.className = 'msg assistant';
  const chips = (s.chips || []).map(c => `<span class="org-chip">${escapeHtml(c.label)}</span>`).join('');
  const sample = plan.mails.slice(0, 5).map(m => {
    const names = m.files.slice(0, 3).map(f => escapeHtml(f.name)).join(', ');
    const more = m.files.length > 3 ? ` 외 ${m.files.length - 3}개` : '';
    return `<div class="org-row"><span class="org-subj">${escapeHtml((m.subject || '(제목 없음)').slice(0, 60))}</span>
      <span class="org-files">${names || '(실행 시 확인)'}${more}</span></div>`;
  }).join('');
  const warn = [];
  if (!s.destExists) warn.push(`폴더가 아직 없습니다 — 실행하면 <b>새로 만듭니다</b>.`);
  if (s.truncated) warn.push(`조건에 맞는 메일이 ${s.matchedMails}건이라 최근 ${s.mailCount}건까지만 처리합니다.`);
  if (s.unknownMails) warn.push(`${s.unknownMails}건은 첨부 목록을 미리 못 읽어 실제 개수가 실행 때 확정됩니다.`);
  //  같은 폴더로 이미 정리한 이력 — 구조가 바뀌었으면 파일이 한 벌 더 생길 수 있음을 미리 알린다.
  if (s.priorHistory) {
    const ph = s.priorHistory;
    const when = String(ph.lastAt || '').replace('T', ' ').slice(0, 16);
    warn.push(ph.structureChanged
      ? `이 대상은 이미 <b>${ph.totalSaved}건</b> 정리됨(최근 ${when} · 구조: ${escapeHtml(ph.lastStructure)}) — <b>구조가 달라 중복 생성 주의</b>.`
      : `이 대상은 이미 <b>${ph.totalSaved}건</b> 정리됨(최근 ${when} · 구조: ${escapeHtml(ph.lastStructure)}) — 같은 파일은 자동으로 건너뜁니다.`);
  }

  div.innerHTML = `<div class="bubble">
    <div class="org-head">첨부 정리 계획 — 확인 후 실행하세요</div>
    <div class="org-grid">
      <div class="org-k">대상 메일</div><div class="org-v"><b>${s.mailCount}</b>건 ${chips}</div>
      <div class="org-k">첨부</div><div class="org-v"><b>${s.fileCount}</b>개 · 약 ${fmtBytes(s.bytes)} · ${escapeHtml(s.kindsLabel)}</div>
      <div class="org-k">저장 위치</div><div class="org-v org-path">${escapeHtml(plan.dest)}</div>
      <div class="org-k">정리 구조</div><div class="org-v">${escapeHtml(s.structureLabel)} · ${escapeHtml(s.nameRuleLabel)}</div>
    </div>
    ${sample ? `<div class="org-sample">${sample}</div>` : ''}
    ${warn.length ? `<div class="org-warn">${warn.join('<br>')}</div>` : ''}
    <div class="org-note">복사만 합니다. Outlook 원본과 기존 파일은 바꾸지 않고, 같은 파일이 이미 있으면 건너뜁니다.</div>
    <div class="org-actions">
      <button class="btn-primary btn-sm org-run">실행</button>
      <button class="org-cancel">취소</button>
      <span class="org-status"></span>
    </div>
  </div>`;
  log.appendChild(div); log.scrollTop = log.scrollHeight;

  const runBtn = div.querySelector('.org-run');
  const cancelBtn = div.querySelector('.org-cancel');
  const status = div.querySelector('.org-status');
  if (!s.mailCount) {
    runBtn.disabled = true;
    status.textContent = '조건에 맞는 첨부 메일이 없습니다.';
  }
  runBtn.addEventListener('click', () => runOrganizePlan(plan, div));
  cancelBtn.addEventListener('click', () => {
    runBtn.disabled = true; cancelBtn.disabled = true;
    status.textContent = '취소했습니다. 파일은 하나도 만들지 않았습니다.';
    organizeLastPlan = plan;   // 후속 대화로 조건만 바꿔 다시 시도할 수 있게 남겨 둔다
  });
}

async function runOrganizePlan(plan, card) {
  const runBtn = card.querySelector('.org-run');
  const cancelBtn = card.querySelector('.org-cancel');
  const status = card.querySelector('.org-status');
  runBtn.disabled = true; cancelBtn.disabled = true;
  status.textContent = '첨부를 꺼내는 중...';
  organizeProgressEl = status;
  if (!organizeProgressBound) {
    organizeProgressBound = true;
    window.api.onOrganizeProgress((p) => {
      if (organizeProgressEl) {
        organizeProgressEl.textContent = `진행 ${p.done}/${p.total}건 · 저장 ${p.saved}개${p.skipped ? ` · 건너뜀 ${p.skipped}` : ''}`;
      }
    });
  }
  try {
    const r = await window.api.organizeRun(plan);
    organizeProgressEl = null;
    if (!r.ok) { status.innerHTML = `<span class="org-error">실패: ${escapeHtml(r.error || '')}</span>`; return; }
    status.innerHTML = `<b>${r.saved}개 저장</b>${r.skipped ? ` · 이미 있어 건너뜀 ${r.skipped}` : ''}${r.failed ? ` · 실패 ${r.failed}` : ''} · ${fmtBytes(r.bytes)}
      <button class="link-btn org-open">폴더 열기</button>`;
    card.querySelector('.org-open').addEventListener('click', () => window.api.openPath(r.dest));
    if (r.errors && r.errors.length) {
      const box = document.createElement('div');
      box.className = 'org-error';
      box.textContent = r.errors.slice(0, 5).join(' / ');
      card.querySelector('.bubble').appendChild(box);
    }
  } catch (err) {
    organizeProgressEl = null;
    status.innerHTML = `<span class="org-error">오류: ${escapeHtml(String(err))}</span>`;
  }
}

//  이력 항목 1건 렌더 — 일시·조건(구조/종류)·경로·건수·소요 + [폴더 열기]/[실패 재시도]
//  idPrefix 로 챗 로그/설정 패널 어디서 그려도 버튼 id 충돌이 없게 한다.
function organizeHistoryRowHtml(h, idx, idPrefix) {
  const when = escapeHtml(String(h.at || '').replace('T', ' ').slice(0, 16));
  const sec = h.ms ? ` · ${(h.ms / 1000).toFixed(1)}초` : '';
  const failBadge = h.failed ? ` · <span class="org-fail-badge">실패 ${h.failed}</span>` : '';
  return `<div class="org-row" data-idx="${idx}">
    <span class="org-subj">${when} · ${escapeHtml(h.structureLabel || h.structure || '')} · ${escapeHtml(h.kindsLabel || '')} ·
      대상 ${h.mails || 0}건 · 저장 ${h.saved || 0}개${h.skipped ? ` · 건너뜀 ${h.skipped}` : ''}${failBadge}${sec}</span>
    <span class="org-files">${escapeHtml(h.dest || '')}
      <button type="button" class="link-btn org-hist-open" data-idx="${idx}">폴더 열기</button>
      ${h.failed ? `<button type="button" class="link-btn org-hist-retry" data-idx="${idx}">실패 재시도</button>` : ''}
    </span></div>`;
}

function bindOrganizeHistoryRows(root, items) {
  root.querySelectorAll('.org-hist-open').forEach(btn => {
    btn.addEventListener('click', () => window.api.openPath(items[Number(btn.dataset.idx)].dest));
  });
  root.querySelectorAll('.org-hist-retry').forEach(btn => {
    btn.addEventListener('click', async () => {
      const h = items[Number(btn.dataset.idx)];
      btn.disabled = true; btn.textContent = '재시도 준비 중...';
      try {
        //  같은 원문 지시를 다시 계획한다 — 이미 저장된 파일은 멱등 판정으로 자동 건너뛰고
        //  실패했던 것만 다시 시도된다. [실행]을 눌러야 실제로 복사된다(안전장치 유지).
        const res = await window.api.organizePlan(h.text, null);
        if (!res || !res.isOrganize || !res.ok) { alert('재시도 계획을 만들 수 없습니다: ' + (res && res.error || '원문 지시를 다시 해석하지 못했습니다.')); return; }
        organizeLastPlan = res.plan;
        renderOrganizePlanCard(res);
        //  카드는 AI 대화 패널에만 그려진다 — 설정 패널에서 눌렀어도 확인할 수 있게 열어준다.
        if (typeof setGchatCollapsed === 'function') setGchatCollapsed(false);
        showAiToast('재시도 계획을 AI 대화 패널에 띄웠습니다 — 확인 후 [실행]을 누르세요.');
      } finally { btn.disabled = false; btn.textContent = '실패 재시도'; }
    });
  });
}

async function showOrganizeHistory() {
  const r = await window.api.organizeHistory();
  if (!r.ok) { addMessage('assistant', `이력 조회 실패: ${escapeHtml(r.error || '')}`); return; }
  if (!r.items.length) { addMessage('assistant', '첨부 정리 이력이 아직 없습니다.'); return; }
  const rows = r.items.map((h, i) => organizeHistoryRowHtml(h, i, 'chat')).join('');
  const div = document.createElement('div');
  div.className = 'msg assistant';
  div.innerHTML = `<div class="bubble"><div class="org-head">첨부 정리 이력 ${r.items.length}건</div><div class="org-sample">${rows}</div></div>`;
  const log = $('#chat-log');
  log.appendChild(div); log.scrollTop = log.scrollHeight;
  bindOrganizeHistoryRows(div, r.items);
}

// ------------------------------------------------------------
//  대용량 첨부 (bigmail) — 업로드 후 Outlook 작성창 본문에 링크 블록 삽입
//   ★ 발송하지 않는다. 본문에 넣어 주기만 하고 마스터가 Outlook 에서 직접 보낸다.
// ------------------------------------------------------------
function fmtBytes(b) {
  const n = Number(b) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

async function openBigmailDialog() {
  const pick = await window.api.bigmailPick();
  if (!pick.ok) return alert('파일 선택 실패: ' + pick.error);
  if (!pick.files.length) return;                       // 취소

  const total = pick.files.reduce((a, f) => a + (f.size || 0), 0);
  const limit = pick.limit || 100 * 1024 * 1024;
  const box = document.createElement('div');
  box.className = 'modal-backdrop';
  box.innerHTML = `
    <div class="modal-box bm-dialog">
      <div class="modal-head"><h2>대용량 첨부</h2></div>
      <div class="modal-body">
        <div class="bm-files">
          ${pick.files.map(f => `<div class="bm-file"><span class="bm-fname">${escapeHtml(f.name)}</span><span class="bm-fsize">${fmtBytes(f.size)}</span></div>`).join('')}
        </div>
        <div class="bm-total">합계 ${pick.files.length}개 · <b>${fmtBytes(total)}</b> / 한 번에 ${fmtBytes(limit)}까지</div>
        ${total > limit ? `<div class="bm-warn">총 용량이 한도를 넘습니다. 파일을 나눠서 올려 주세요.</div>` : ''}
        <label class="bm-row">메일 제목(선택) <input id="bm-subject" type="text" placeholder="예) 도면 송부" /></label>
        <label class="bm-row">다운로드 비밀번호(선택) <input id="bm-password" type="password" placeholder="비우면 비밀번호 없음" /></label>
        <div class="bm-progress hidden" id="bm-progress">
          <div class="bm-bar"><div class="bm-bar-fill" id="bm-bar-fill"></div></div>
          <div class="bm-pct" id="bm-pct">0%</div>
        </div>
        <div id="bm-result" class="bm-result hidden"></div>
      </div>
      <div class="modal-foot">
        <button id="bm-cancel">닫기</button>
        <button id="bm-go" class="btn-primary"${total > limit ? ' disabled' : ''}>업로드 후 본문에 넣기</button>
      </div>
    </div>`;
  document.body.appendChild(box);

  const close = () => box.remove();
  box.querySelector('#bm-cancel').addEventListener('click', close);
  box.addEventListener('click', (e) => { if (e.target === box) close(); });

  box.querySelector('#bm-go').addEventListener('click', async () => {
    const go = box.querySelector('#bm-go');
    go.disabled = true;
    box.querySelector('#bm-progress').classList.remove('hidden');
    const res = await window.api.bigmailUpload({
      files: pick.files.map(f => f.path),
      subject: box.querySelector('#bm-subject').value.trim(),
      password: box.querySelector('#bm-password').value
    });
    if (!res.ok) {
      box.querySelector('#bm-result').classList.remove('hidden');
      box.querySelector('#bm-result').innerHTML =
        `<div class="bm-warn">업로드 실패: ${escapeHtml(res.error || '')}<br>잠시 후 다시 시도하거나 파일을 나눠서 올려 주세요.</div>`;
      go.disabled = false;
      return;
    }
    const ins = await window.api.bigmailInsert(res.html);
    const rbox = box.querySelector('#bm-result');
    rbox.classList.remove('hidden');
    rbox.innerHTML = `
      <div class="bm-ok">업로드 완료 — ${ins.ok ? (ins.reused ? '열려 있던 Outlook 작성창 본문에 넣었습니다.' : '새 Outlook 작성창을 열어 본문에 넣었습니다.') : '본문 삽입 실패: ' + escapeHtml(ins.error || '')}</div>
      <div class="bm-link"><a href="${escapeHtml(res.downloadUrl)}" target="_blank" rel="noopener">${escapeHtml(res.downloadUrl)}</a></div>
      <div class="bm-exp">다운로드 기한 ${escapeHtml(String(res.expiresAt || '').slice(0, 10))}</div>`;
    go.textContent = '완료';
    loadBigmailHistory();
  });
}

// 업로드 진행률(메인 프로세스에서 실제 전송량 기준으로 보내 준다)
function bindBigmailProgress() {
  window.api.onBigmailProgress(({ percent }) => {
    const fill = $('#bm-bar-fill'), pct = $('#bm-pct');
    if (fill) fill.style.width = percent + '%';
    if (pct) pct.textContent = percent + '%';
  });
}

// ---- 첨부 분류 현황 / 재분류 ----
// Outlook 규칙을 읽어 프로젝트 판정에 반영 (읽기 전용)
async function importOutlookRules() {
  const box = $('#rules-info');
  showLoading('Outlook 규칙 읽는 중...');
  try {
    const r = await window.api.rulesImport();
    hideLoading();
    if (!r.ok) { if (box) box.textContent = '가져오기 실패: ' + r.error; return; }
    const msg = `규칙 ${r.rules}개 반영 (제목조건 ${r.imported.contains} · 발신자조건 ${r.imported.senders}) · ` +
      `보낸메일 '기타' ${r.before.etc}건(${r.before.etcRatio}%) → ${r.after.etc}건(${r.after.etcRatio}%)`;
    if (box) box.textContent = msg;
    alert('Outlook 규칙 반영 완료' + String.fromCharCode(10,10) + msg);
    loadSentTree(true);
  } catch (e) { hideLoading(); if (box) box.textContent = '오류: ' + e; }
}

// ============================================================
//  내보내기 — 통합 대시보드 HTML 1장 · 엑셀(.xlsx)
//  ------------------------------------------------------------
//  ★ '지금 화면이 보고 있는 목록'을 그대로 넘긴다(필터·정렬 반영).
//    id 목록만 넘기면 본체가 DB 에서 전체 필드를 다시 읽어 컬럼을 채운다.
// ============================================================
function currentMailIds(arr) {
  return (arr || []).map(m => m.id).filter(v => Number.isFinite(v));
}

async function exportListToExcel(mails, sheetName, fileHint) {
  const ids = currentMailIds(mails);
  if (!ids.length) { alert('내보낼 메일이 없습니다.'); return; }
  showLoading(`엑셀 만드는 중... (${ids.length.toLocaleString()}건)`);
  try {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const r = await window.api.exportExcel({ kind: 'mails', ids, sheetName, fileName: `${fileHint}-${stamp}.xlsx` });
    hideLoading();
    if (!r.ok) { alert('엑셀 내보내기 실패: ' + r.error); return; }
    setExportInfo(`엑셀 ${r.totalRows.toLocaleString()}행 저장 완료 · ${r.file}`);
  } catch (e) { hideLoading(); alert('엑셀 내보내기 오류: ' + e); }
}

async function exportDashboardHtml() {
  const g = $('#dash-granularity') ? $('#dash-granularity').value : 'day';
  showLoading('통합 대시보드 만드는 중...');
  try {
    const r = await window.api.exportDashboard({ granularity: g, scopeLabel: '전체 메일' });
    hideLoading();
    if (!r.ok) { alert('대시보드 생성 실패: ' + r.error); return; }
    setExportInfo(`대시보드 생성 완료 · 메일 ${r.mails.toLocaleString()}건 · ${Math.round(r.bytes / 1024).toLocaleString()}KB · ${r.file}`);
  } catch (e) { hideLoading(); alert('대시보드 오류: ' + e); }
}

async function exportDashboardExcel() {
  showLoading('집계표 엑셀 만드는 중...');
  try {
    const r = await window.api.exportExcel({ kind: 'dashboard' });
    hideLoading();
    if (!r.ok) { alert('엑셀 내보내기 실패: ' + r.error); return; }
    setExportInfo(`집계표 엑셀 완료 · 시트 ${r.sheets.length}개(${r.sheets.map(s => s.name).join(', ')}) · ${r.file}`);
  } catch (e) { hideLoading(); alert('엑셀 오류: ' + e); }
}

function setExportInfo(msg) {
  const el = $('#export-info');
  if (el) el.textContent = msg;
}

// 저장 위치 표시 (config 값이 비어 있으면 기본값 안내)
function refreshExportRoot() {
  const root = (config && config.exportRoot) ? config.exportRoot : '문서\\Bmail (기본값)';
  setExportInfo(`저장 위치: ${root}`);
}

async function pickExportRoot() {
  const r = await window.api.exportPickRoot();
  if (!r.ok) { alert('폴더 선택 실패: ' + r.error); return; }
  if (!r.canceled) config = { ...config, exportRoot: r.root };
  refreshExportRoot();
}

// ============================================================
//  로컬 저장물 정리 — 점검은 안전(아무것도 안 지움) · 정리 실행은 확인 후에만
// ============================================================
function renderCleanupReport(r) {
  const box = $('#cleanup-report');
  if (!box) return;
  if (!r) { box.textContent = '아직 점검하지 않았습니다.'; return; }
  if (!r.ok) { box.innerHTML = `<span class="ex-warn">${escapeHtml(r.error || '점검 실패')}</span>`; return; }
  const mb = (n) => (Number(n) || 0) / 1048576;
  const of_ = r.orphanFiles || {}, oe = r.oldExports || {}, dr = r.danglingRows || {};
  const total = mb(of_.bytes) + mb(oe.bytes);
  box.innerHTML = `
    ${r.apply ? '<b class="ex-ok">정리 완료</b>' : '<b>점검 결과 (아무것도 지우지 않았습니다)</b>'} ·
    검사한 파일 ${(r.scannedFiles || 0).toLocaleString()}개 · 참조 중 ${(r.referenced || 0).toLocaleString()}개 ·
    ${(r.durationMs || 0).toLocaleString()}ms<br>
    · 쓰이지 않는 첨부 사본 <b>${(of_.count || 0).toLocaleString()}개 (${mb(of_.bytes).toFixed(1)}MB)</b>${r.apply ? ` → ${of_.deleted || 0}개 삭제` : ''}<br>
    · 오래된 내보내기 파일 <b>${(oe.count || 0).toLocaleString()}개 (${mb(oe.bytes).toFixed(1)}MB)</b>${r.apply ? ` → ${oe.deleted || 0}개 삭제` : ''}<br>
    · 파일이 사라진 첨부 기록 <b>${(dr.count || 0).toLocaleString()}건</b>${r.apply ? ` → ${dr.deleted || 0}건 정리` : ''}<br>
    · 회수 가능 용량 <b>${total.toFixed(1)}MB</b> ·
      정리 프로세스 메모리 최대 ${r.peakRssMb || 0}MB / 상한 ${r.rssLimitMb || 400}MB
      ${r.stopReason ? `<span class="ex-warn"> · 중단: ${escapeHtml(r.stopReason)}</span>` : ''}
    ${(r.errors && r.errors.length) ? `<br><span class="ex-warn">오류 ${r.errors.length}건: ${escapeHtml(r.errors[0])}</span>` : ''}`;
}

async function cleanupScanUI() {
  const box = $('#cleanup-report');
  if (box) box.textContent = '별도 프로세스에서 점검 중... (앱 성능에 영향을 주지 않습니다)';
  const r = await window.api.cleanupScan();
  renderCleanupReport(r);
}

async function cleanupApplyUI() {
  const r0 = await window.api.cleanupLast();
  const last = r0.ok ? r0.report : null;
  const n = last ? ((last.orphanFiles?.count || 0) + (last.oldExports?.count || 0)) : 0;
  if (!last) { alert('먼저 [지금 점검]을 눌러 무엇을 지울지 확인해 주세요.'); return; }
  if (!n) { alert('지울 것이 없습니다.'); return; }
  const mb = ((last.orphanFiles?.bytes || 0) + (last.oldExports?.bytes || 0)) / 1048576;
  if (!confirm(`파일 ${n}개(${mb.toFixed(1)}MB)를 삭제합니다.\n\n지우는 대상은 이 앱이 만든 로컬 사본과 오래된 내보내기 파일뿐이며,\nOutlook 원본과 메일 데이터는 건드리지 않습니다.\n\n계속할까요?`)) return;
  const box = $('#cleanup-report');
  if (box) box.textContent = '정리 중...';
  renderCleanupReport(await window.api.cleanupApply());
}

async function loadCleanupLast() {
  try {
    const r = await window.api.cleanupLast();
    if (r.ok && r.report) renderCleanupReport(r.report);
  } catch (_) { }
}

// ------------------------------------------------------------
//  Outlook 잔여 데이터 (범주 / 깃발 / 캘린더 / 작업 / 검색폴더) — 읽기 전용 수집
// ------------------------------------------------------------
async function importOutlookExtras(retryUnreachable = false) {
  const box = $('#extras-report');
  if (!box) return;
  showLoading('Outlook 범주·깃발·일정·작업 읽는 중... (원본은 변경하지 않습니다)');
  try {
    const r = await window.api.extrasImport(1500, retryUnreachable === true);
    hideLoading();
    if (!r.ok) { box.innerHTML = `<div class="empty-sm">가져오기 실패: ${escapeHtml(r.error)}</div>`; return; }
    renderExtrasReport(r);
  } catch (e) { hideLoading(); box.innerHTML = `<div class="empty-sm">오류: ${escapeHtml(String(e))}</div>`; }
}

function renderExtrasReport(r) {
  const box = $('#extras-report');
  if (!box) return;
  const s = r.stats || {};
  const oc = r.outlookCounts || {};
  // 항목별 Outlook 개수 vs DB 개수 대조표
  const rows = (r.steps || []).map(x => `
    <div class="admin-row">
      <span class="admin-k">${escapeHtml(x.name)}</span>
      <span class="admin-v">Outlook ${Number(x.outlook).toLocaleString()} → DB ${Number(x.db).toLocaleString()}
        <b class="${x.match ? 'ex-ok' : 'ex-warn'}">${x.error ? '오류' : (x.match ? '일치' : '차이')}</b>
        ${x.error ? `<span class="ex-warn"> ${escapeHtml(x.error).slice(0, 90)}</span>` : ''}</span>
    </div>`).join('');
  box.innerHTML = `
    <div class="admin-grid">${rows}</div>
    <div class="hint-text" style="margin-top:8px;">
      범주 ${s.categories || 0}종 · 범주 붙은 메일 ${(s.mailsWithCategory || 0).toLocaleString()}건 ·
      깃발(미완료) ${(s.flagged || 0).toLocaleString()}건 / 완료 ${(s.flagDone || 0).toLocaleString()}건 ·
      기한 지정 ${(s.taskDue || 0).toLocaleString()}건<br>
      중요도 높음 ${(s.highImportance || 0).toLocaleString()}건 · 낮음 ${(s.lowImportance || 0).toLocaleString()}건 ·
      메타 수집 ${(s.metaFilled || 0).toLocaleString()} / 전체 ${(s.totalMails || 0).toLocaleString()}건
      (남은 ${(s.metaMissing || 0).toLocaleString()}건은 [가져오기]를 다시 누르면 이어서 처리${s.metaUnreachable ? ` · 원본 조회 불가 ${(s.metaUnreachable).toLocaleString()}건 제외` : ''})<br>
      캘린더 일정 ${(s.appointments || 0).toLocaleString()}건${oc.appointments ? ` (Outlook 폴더 총 ${Number(oc.appointments).toLocaleString()}건)` : ''} ·
      작업 ${(s.tasks || 0).toLocaleString()}건${oc.tasks ? ` (Outlook ${Number(oc.tasks).toLocaleString()}건)` : ''} ·
      AI 추출 일정 ${(s.aiSchedules || 0).toLocaleString()}건 · 검색 폴더 ${(s.searchFolders || 0).toLocaleString()}개
    </div>`;
}

async function loadActionSourceInfo() {
  const box = $('#action-source-info');
  if (!box) return;
  try {
    const r = await window.api.actionSourceCounts();
    if (!r.ok) { box.textContent = ''; return; }
    const c = r.counts || {};
    box.innerHTML = `직접 지정 <b>${(c.manual || 0).toLocaleString()}</b>건 · ` +
      `Outlook 깃발에서 자동 매핑 <b>${(c.flag || 0).toLocaleString()}</b>건` +
      `${c.unknown ? ` · 출처 미상 ${c.unknown.toLocaleString()}건` : ''}<br>` +
      `<span class="hint-text">AI 자동 추천은 저장하지 않습니다. 화면에 “추천”으로만 보여 주고, 저장되는 값은 직접 지정하신 것과 Outlook 깃발 매핑분뿐입니다.</span>`;
  } catch (_) { box.textContent = ''; }
}

async function loadExtrasStats() {
  const box = $('#extras-report');
  if (!box) return;
  try {
    const r = await window.api.extrasStats();
    if (!r.ok) { box.innerHTML = `<div class="empty-sm">${escapeHtml(r.error)}</div>`; return; }
    const s = r.stats || {};
    if (!s.metaFilled && !s.categories) { box.innerHTML = '<div class="empty-sm">아직 가져오지 않았습니다. [가져오기]를 누르세요.</div>'; return; }
    // 목록의 범주 색점이 Outlook 색과 같게 — 범주명→HEX 맵을 갱신
    categoryColorMap = {};
    (r.categories || []).forEach(c => { categoryColorMap[c.name] = c.hex || '#8a8886'; });
    const cats = (r.categories || []).slice(0, 20).map(c =>
      `<span class="cat-chip" style="border-left:4px solid ${escapeHtml(c.hex || '#8a8886')}">${escapeHtml(c.name)} <b>${c.mailCount || 0}</b></span>`).join('');
    box.innerHTML = `
      <div class="hint-text">
        범주 ${s.categories || 0}종 · 범주 붙은 메일 ${(s.mailsWithCategory || 0).toLocaleString()}건 ·
        깃발(미완료) ${(s.flagged || 0).toLocaleString()}건 · 기한 지정 ${(s.taskDue || 0).toLocaleString()}건 ·
        중요도 높음 ${(s.highImportance || 0).toLocaleString()}건<br>
        캘린더 일정 ${(s.appointments || 0).toLocaleString()}건 · 작업 ${(s.tasks || 0).toLocaleString()}건 ·
        검색 폴더 ${(s.searchFoldersUser || 0).toLocaleString()}개(내 것) / 전체 ${(s.searchFolders || 0).toLocaleString()}개 ·
        메타 수집 ${(s.metaFilled || 0).toLocaleString()} / ${(s.totalMails || 0).toLocaleString()}건
      </div>
      ${cats ? `<div class="cat-chips">${cats}</div>` : ''}
      ${(r.searchFolders || []).length
        ? `<div class="hint-text" style="margin-top:6px;">검색 폴더: ${
            (r.searchFolders || []).map(f => escapeHtml(f.name) + `(${Number(f.items).toLocaleString()})`).join(' · ')}</div>`
        : `<div class="hint-text" style="margin-top:6px;">사용자가 만든 검색 폴더가 없습니다. (Outlook 이 내부적으로 쓰는 MS-OLK-* 폴더 ${
            ((s.searchFolders || 0) - (s.searchFoldersUser || 0)).toLocaleString()}개는 제외했습니다)</div>`}`;
  } catch (e) { box.innerHTML = `<div class="empty-sm">${escapeHtml(String(e))}</div>`; }
}

async function loadAttachStats() {
  const box = $('#attach-stats');
  if (!box) return;
  const res = await window.api.attachStats();
  //  통계가 비어 오는 경우(DB 미초기화 등)에도 콘솔 예외를 내지 않는다
  if (!res || !res.ok || !res.stats) { box.textContent = '확인 실패: ' + ((res && res.error) || '첨부 통계를 읽지 못했습니다'); return; }
  const s = res.stats;
  box.innerHTML = `저장된 첨부 ${s.attachRows}건 중 <b>진짜 첨부 ${s.attachReal}건</b> · 본문 이미지 ${s.attachInline}건<br>
    '첨부 있는 메일': 분류 전 ${s.rawWithAttach.toLocaleString()}건 → <b>진짜 첨부 기준 ${s.realWithAttach.toLocaleString()}건</b>
    ${s.pending ? ` · 미판정 ${s.pending.toLocaleString()}건 (다시 분류를 누르면 이어서 처리)` : ' · 판정 완료'}`;
}

async function reclassifyAttachments() {
  const btn = $('#btn-attach-reclassify');
  if (btn) { btn.disabled = true; btn.textContent = '분류 중...'; }
  showLoading('첨부 다시 분류 중... (Outlook 조회라 시간이 걸립니다)');
  try {
    const r = await window.api.attachReclassify(40);
    hideLoading();
    if (!r.ok) return alert('재분류 실패: ' + r.error);
    await loadAttachStats();
    const s = r.stats;
    alert(`첨부 재분류 완료\n\n저장 첨부 ${s.attachRows}건 → 진짜 ${s.attachReal} / 본문 이미지 ${s.attachInline}\n'첨부 있는 메일' ${s.rawWithAttach.toLocaleString()} → ${s.realWithAttach.toLocaleString()}건`
      + (s.pending ? `\n\n아직 ${s.pending.toLocaleString()}건이 남았습니다. 다시 눌러 이어서 처리하세요.` : ''));
    loadMails($('#global-search').value);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '다시 분류'; }
  }
}

async function loadBigmailHistory() {
  const box = $('#bm-history');
  if (!box) return;
  const res = await window.api.bigmailHistory();
  const items = (res.ok && res.items) ? res.items : [];
  if (!items.length) { box.innerHTML = '<div class="empty-sm">아직 대용량 전송 이력이 없습니다.</div>'; return; }
  const now = Date.now();
  box.innerHTML = items.map(x => {
    const exp = x.expires_at ? new Date(x.expires_at) : null;
    const leftDays = exp ? Math.ceil((exp.getTime() - now) / 864e5) : null;
    const state = leftDays === null ? '' : (leftDays < 0 ? '만료됨' : (leftDays <= 2 ? `만료 임박 D-${leftDays}` : `D-${leftDays}`));
    const cls = leftDays === null ? '' : (leftDays < 0 ? ' expired' : (leftDays <= 2 ? ' soon' : ''));
    return `<div class="bm-hist-item${cls}">
      <div class="bm-hist-main">
        <a href="${escapeHtml(x.download_url)}" target="_blank" rel="noopener">${escapeHtml(x.download_url)}</a>
        <div class="bm-hist-meta">${x.file_count}개 · ${fmtBytes(x.total_size)} · ${escapeHtml(x.file_names || '')}</div>
      </div>
      <span class="bm-hist-exp">${escapeHtml(state)}</span>
      <button class="link-btn" data-bmcopy="${escapeHtml(x.download_url)}">링크 복사</button>
      <button class="link-btn cal-del" data-bmdel="${x.id}">삭제</button>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-bmcopy]').forEach(b => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.bmcopy); b.textContent = '복사됨'; setTimeout(() => { b.textContent = '링크 복사'; }, 1500); }
    catch (_) { alert('복사 실패'); }
  }));
  box.querySelectorAll('[data-bmdel]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('이 이력을 목록에서 지울까요? (업로드된 파일은 만료일까지 그대로 유지됩니다)')) return;
    await window.api.bigmailHistoryDelete(parseInt(b.dataset.bmdel, 10));
    loadBigmailHistory();
  }));
}

// 설정 패널의 첨부 정리 이력 (일시·구조·경로·건수·소요 + 폴더 열기·실패 재시도)
async function loadOrganizeHistoryPanel() {
  const box = $('#org-history');
  if (!box) return;
  const r = await window.api.organizeHistory();
  const items = (r.ok && r.items) ? r.items : [];
  if (!items.length) { box.innerHTML = '<div class="empty-sm">첨부 정리 이력이 아직 없습니다.</div>'; return; }
  box.innerHTML = items.map((h, i) => organizeHistoryRowHtml(h, i, 'settings')).join('');
  bindOrganizeHistoryRows(box, items);
}

// ------------------------------------------------------------
//  일정 달력 (대시보드 상시 표시)
//   데이터는 저장된 분석·업무일지에서 모은 schedules 테이블 하나만 본다.
// ------------------------------------------------------------
let calCursor = new Date();          // 보고 있는 달
let calItems = [];                   // 이번 달 범위의 일정
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function loadCalendar() {
  const grid = $('#cal-grid');
  if (!grid) return;
  const y = calCursor.getFullYear(), mo = calCursor.getMonth() + 1;
  $('#cal-title').textContent = `${y}년 ${mo}월`;
  try {
    const res = await window.api.schedMonth(y, mo);
    calItems = (res.ok && res.items) ? res.items : [];
    if (res.ok && res.stats) $('#cal-stats').textContent = `${res.stats.total}건 · 완료 ${res.stats.done}`;
    renderCalendar();
    loadUpcoming();
  } catch (err) {
    grid.innerHTML = `<div class="empty-sm">${escapeHtml(String(err))}</div>`;
  }
}

// 일정의 출처 구분 (마스터: 새 화면을 만들지 말고 기존 일정 화면에 합치되 출처를 표시)
//  ★ 색이 아니라 '글자'로 구분한다 — 색맹 대응 + 흑백 인쇄에서도 읽힌다.
function schedSourceLabel(x) {
  const k = String(x && x.source_kind || '');
  if (k === 'outlook-cal') return 'Outlook 일정';
  if (k === 'outlook-task') return 'Outlook 작업';
  return '메일에서 추출';
}
function schedSourceMark(x) {
  const k = String(x && x.source_kind || '');
  if (k === 'outlook-cal') return '일정';
  if (k === 'outlook-task') return '작업';
  return '메일';
}

function renderCalendar() {
  const grid = $('#cal-grid');
  const y = calCursor.getFullYear(), m = calCursor.getMonth();
  const first = new Date(y, m, 1);
  const start = new Date(first.getTime() - first.getDay() * 864e5);   // 그 주 일요일부터
  const todayIso = isoDay(new Date());

  const byDate = new Map();
  calItems.forEach(it => {
    if (!byDate.has(it.date)) byDate.set(it.date, []);
    byDate.get(it.date).push(it);
  });

  let html = ['일', '월', '화', '수', '목', '금', '토']
    .map((d, i) => `<div class="cal-dow${i === 0 ? ' cal-sun' : (i === 6 ? ' cal-sat' : '')}">${d}</div>`).join('');

  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getTime() + i * 864e5);
    const iso = isoDay(d);
    const out = d.getMonth() !== m;
    const list = byDate.get(iso) || [];
    const overdue = list.some(x => !x.done && iso < todayIso);
    const cls = ['cal-cell'];
    if (out) cls.push('cal-out');
    if (iso === todayIso) cls.push('cal-today');
    if (d.getDay() === 0) cls.push('cal-sun');
    if (d.getDay() === 6) cls.push('cal-sat');
    if (overdue) cls.push('cal-overdue');

    const chips = list.slice(0, 3).map(x => `
      <span class="cal-chip${x.done ? ' done' : ''}${!x.done && iso < todayIso ? ' late' : ''}" title="${escapeHtml(schedSourceLabel(x))} · ${escapeHtml(x.title)}${x.location ? ' @ ' + escapeHtml(x.location) : ''}">
        <span class="cal-src">${escapeHtml(schedSourceMark(x))}</span>${x.time ? `<b>${escapeHtml(x.time)}</b> ` : ''}${escapeHtml(x.title)}
      </span>`).join('');
    const more = list.length > 3 ? `<span class="cal-more">+${list.length - 3}</span>` : '';

    html += `<div class="${cls.join(' ')}" data-day="${iso}">
      <div class="cal-daynum">${d.getDate()}</div>
      <div class="cal-chips">${chips}${more}</div>
    </div>`;
  }
  grid.innerHTML = html;

  grid.querySelectorAll('.cal-cell').forEach(c => {
    c.addEventListener('click', () => openDayPopover(c.dataset.day));
    c.addEventListener('dblclick', () => openDayPopover(c.dataset.day, true));
  });
}

// 날짜 팝오버 — 그 날짜 일정 목록 + 완료 체크 + 출처 메일 열기 + 수동 추가
function openDayPopover(dayIso, focusAdd) {
  const pop = $('#cal-popover');
  const list = calItems.filter(x => x.date === dayIso);
  const todayIso = isoDay(new Date());
  $('#cal-pop-date').textContent = dayIso;
  pop.dataset.day = dayIso;
  $('#cal-pop-list').innerHTML = list.length ? list.map(x => `
    <div class="cal-pop-item${x.done ? ' done' : ''}">
      <label class="cal-pop-chk">
        <input type="checkbox" data-done="${x.id}" ${x.done ? 'checked' : ''} />
        <span class="cal-pop-title">${x.time ? `<b>${escapeHtml(x.time)}</b> ` : ''}${escapeHtml(x.title)}</span>
      </label>
      <div class="cal-pop-meta">
        ${!x.done && x.date < todayIso ? '<span class="cal-late-tag">기한 지남</span>' : ''}
        <span class="fu-src">${escapeHtml(x.source_kind === 'manual' ? '직접 등록' : schedSourceLabel(x))}</span>
        ${x.location ? `<span>${escapeHtml(x.location)}</span>` : ''}
        ${x.end_date && x.end_date !== x.date ? `<span>~ ${escapeHtml(x.end_date)}</span>` : ''}
        ${x.percent ? `<span>진행 ${x.percent}%</span>` : ''}
        ${x.mail_id ? `<button class="link-btn" data-openmail="${x.mail_id}">출처 메일</button>` : ''}
        <button class="link-btn" data-edit="${x.id}">수정</button>
        <button class="link-btn cal-del" data-del="${x.id}">삭제</button>
      </div>
    </div>`).join('') : '<div class="empty-sm">이 날짜에 등록된 일정이 없습니다.</div>';

  pop.classList.remove('hidden');
  $('#cal-pop-title').value = '';
  $('#cal-pop-time').value = '';
  if (focusAdd) $('#cal-pop-title').focus();

  $('#cal-pop-list').querySelectorAll('[data-done]').forEach(cb => {
    cb.addEventListener('change', async () => {
      await window.api.schedDone(parseInt(cb.dataset.done, 10), cb.checked);
      await loadCalendar();
      openDayPopover(dayIso);
    });
  });
  $('#cal-pop-list').querySelectorAll('[data-del]').forEach(b => {
    b.addEventListener('click', async () => {
      if (!confirm('이 일정을 삭제할까요?')) return;
      await window.api.schedDelete(parseInt(b.dataset.del, 10));
      await loadCalendar();
      openDayPopover(dayIso);
    });
  });
  // 수정: 제목·날짜·시각을 팝오버 입력칸으로 올려 고치고 저장한다
  $('#cal-pop-list').querySelectorAll('[data-edit]').forEach(b => {
    b.addEventListener('click', async () => {
      const it = list.find(x => x.id === parseInt(b.dataset.edit, 10));
      if (!it) return;
      const title = await inputDialog('일정 수정', '제목', it.title);
      if (title === null) return;
      const date = await inputDialog('일정 수정', '날짜 (YYYY-MM-DD)', it.date);
      if (date === null) return;
      const time = await inputDialog('일정 수정', '시각 (HH:MM, 비우면 종일)', it.time || '');
      if (time === null) return;
      const r = await window.api.schedUpdate({ id: it.id, title, date, time: time.trim() || null });
      if (!r.ok) return alert('수정 실패: ' + r.error);
      await loadCalendar();
      openDayPopover(date);
    });
  });
  $('#cal-pop-list').querySelectorAll('[data-openmail]').forEach(b => {
    b.addEventListener('click', () => {
      pop.classList.add('hidden');
      useReadingPane('mail');
      switchView('mail');
      openMailDetail({ id: parseInt(b.dataset.openmail, 10) });
    });
  });
}

async function saveDaySchedule() {
  const pop = $('#cal-popover');
  const title = $('#cal-pop-title').value.trim();
  if (!title) { $('#cal-pop-title').focus(); return; }
  const r = await window.api.schedAdd({ date: pop.dataset.day, time: $('#cal-pop-time').value || null, title });
  if (!r.ok) return alert('추가 실패: ' + r.error);
  await loadCalendar();
  openDayPopover(pop.dataset.day);
}

async function loadUpcoming() {
  const box = $('#cal-upcoming-list');
  if (!box) return;
  const res = await window.api.schedUpcoming(7);
  const items = (res.ok && res.items) ? res.items.filter(x => !x.done) : [];
  $('#cal-up-count').textContent = items.length;
  if (!items.length) { box.innerHTML = '<div class="empty-sm">다가오는 마감이 없습니다.</div>'; return; }
  const todayIso = isoDay(new Date());
  box.innerHTML = items.slice(0, 15).map(x => `
    <div class="cal-up-item${x.date < todayIso ? ' late' : ''}">
      <span class="cal-up-date">${escapeHtml(x.date.slice(5))}${x.time ? ' ' + escapeHtml(x.time) : ''}</span>
      <span class="cal-up-title">${escapeHtml(x.title)}</span>
      ${x.date < todayIso ? '<span class="cal-late-tag">지남</span>' : ''}
      <button class="link-btn" data-upday="${escapeHtml(x.date)}">보기</button>
    </div>`).join('');
  box.querySelectorAll('[data-upday]').forEach(b =>
    b.addEventListener('click', () => openDayPopover(b.dataset.upday)));
}

function calShiftMonth(delta) {
  calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() + delta, 1);
  loadCalendar();
}

// ------------------------------------------------------------
//  미회신 감지 경고 (대시보드)
// ------------------------------------------------------------
async function loadUnanswered() {
  const box = $('#unanswered-box');
  if (!box) return;
  box.innerHTML = '<div class="empty-sm">확인 중...</div>';
  try {
    const res = await window.api.dbUnanswered({ days: 14, limit: 20, minDays: 1 });
    if (!res.ok) { box.innerHTML = `<div class="empty-sm">${escapeHtml(res.error)}</div>`; return; }
    // ★ SoT: replyBucket(reply-needed.js bucketOf() 파생) 기준으로 "회신 필요"만 위젯에 보여준다.
    const mails = (res.mails || []).filter(m => (m.replyBucket || 'needed') !== 'notneeded');
    const badge = $('#unanswered-count');
    if (badge) badge.textContent = mails.length;
    if (!mails.length) { box.innerHTML = '<div class="empty-sm">최근 14일 내 회신 필요한 메일이 없습니다.</div>'; return; }
    box.innerHTML = mails.map(m => `
      <button class="unans-item" data-mid="${m.id}">
        <span class="ua-days">${m.daysWaiting}일</span>
        <span class="ua-main">
          <span class="ua-subject">${escapeHtml(m.subject || '(제목 없음)')}</span>
          <span class="ua-meta">${escapeHtml(m.sender_name || m.sender_email || '')} · ${escapeHtml(m.received_at || '')}</span>
        </span>
      </button>`).join('');
    box.querySelectorAll('.unans-item').forEach(b => b.addEventListener('click', () => {
      // 대시보드 위젯 → 회신 대기 뷰의 2분할로 이동해 바로 읽기
      switchView('followup');
      setTimeout(async () => {
        useReadingPane('followup');
        await openMailDetail({ id: parseInt(b.dataset.mid, 10) });
      }, 300);
    }));
  } catch (err) {
    box.innerHTML = `<div class="empty-sm">${escapeHtml(String(err))}</div>`;
  }
}

// ============================================================
//  전역 자연어 검색 (복합 조건 + 조건 칩 + 후속 질문 AND 결합)
//  ★ AI 키 없이도 동작한다(로컬 파서). 조건은 모두 AND 로 결합된다.
// ============================================================
let searchCond = null;     // 현재 적용된 조건 (null = 조건 없음)

function renderSearchChips() {
  const box = $('#search-chips');
  if (!box) return;
  const chips = (searchCond && searchCond.chips) || [];
  if (!chips.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  box.innerHTML = `<span class="sc-label">조건</span>` + chips.map((c, i) =>
    `<button class="sc-chip" data-i="${i}" title="클릭하면 이 조건을 제거합니다">
       ${escapeHtml(c.label)}<span class="sc-x">×</span>
     </button>`).join('') +
    `<button class="sc-clear" title="모든 조건 지우기">조건 초기화</button>`;
  box.querySelectorAll('.sc-chip').forEach(b => b.addEventListener('click', () => removeSearchChip(parseInt(b.dataset.i, 10))));
  box.querySelector('.sc-clear').addEventListener('click', clearSearch);
}

// 칩 제거 → 해당 조건만 빼고 재검색
function removeSearchChip(idx) {
  if (!searchCond || !searchCond.chips[idx]) return;
  const c = searchCond.chips[idx];
  if (c.kind === 'sender') searchCond.sender = '';
  else if (c.kind === 'recipient') searchCond.recipient = '';
  else if (c.kind === 'attach') searchCond.hasAttach = null;
  else if (c.kind === 'unread') searchCond.unreadOnly = false;
  else if (c.kind === 'folder') searchCond.folder = '';
  else if (c.kind === 'date') { searchCond.sinceTs = null; searchCond.untilTs = null; }
  else if (c.kind === 'keyword') searchCond.keywords = (searchCond.keywords || []).filter(k => k !== c.value);
  searchCond.chips.splice(idx, 1);
  runSearch(null);
}

function clearSearch() {
  searchCond = null;
  $('#global-search').value = '';
  renderSearchChips();
  hideResultTabs();
  loadMails('');
}

// 조건 병합 (후속 질문 = 기존 조건에 AND 추가)
function mergeCond(base, next) {
  if (!base) return next;
  const out = { ...base };
  if (next.sender) out.sender = next.sender;
  if (next.recipient) out.recipient = next.recipient;
  if (next.hasAttach === true) out.hasAttach = true;
  if (next.unreadOnly) out.unreadOnly = true;
  if (next.folder) out.folder = next.folder;
  if (next.sinceTs) { out.sinceTs = next.sinceTs; out.untilTs = next.untilTs || null; }
  out.keywords = [...new Set([...(base.keywords || []), ...(next.keywords || [])])];
  // 칩도 병합 (같은 종류는 교체, 키워드는 누적)
  const keep = (base.chips || []).filter(c => c.kind === 'keyword'
    ? out.keywords.includes(c.value)
    : !(next.chips || []).some(n => n.kind === c.kind));
  const added = (next.chips || []).filter(n => !keep.some(k => k.kind === n.kind && k.value === n.value));
  out.chips = [...keep, ...added];
  return out;
}

// 검색 실행: text 가 있으면 파싱해 기존 조건과 AND 결합, null 이면 현재 조건으로 재실행
async function runSearch(text) {
  const list = $('#mail-list');
  list.innerHTML = '<div class="empty">검색 중...</div>';
  try {
    if (text && text.trim()) {
      const p = await window.api.searchParse(text.trim());
      if (!p.ok) { list.innerHTML = `<div class="empty">${escapeHtml(p.error)}</div>`; return; }
      searchCond = mergeCond(searchCond, p.cond);
    }
    if (!searchCond) { loadMails(''); return; }
    const res = await window.api.searchRun('', searchCond, 300);
    if (!res.ok) { list.innerHTML = `<div class="empty">${escapeHtml(res.error)}</div>`; return; }
    renderSearchChips();
    $('#mlp-title').textContent = '검색 결과';
    switchView('mail');
    const label = (searchCond.chips || []).map(c => c.label).join(' · ') || '검색 결과';
    if (!(res.mails || []).length) {
      hideResultTabs();
      mailCache = [];
      list.innerHTML = `<div class="empty">조건에 맞는 메일이 없습니다.<br>
        <span style="font-size:11.5px;color:var(--muted)">조건 칩을 눌러 일부 조건을 제거해 보세요.</span></div>`;
      return;
    }
    // ★ 4탭(마스터 지시): 결과가 생기면 기본은 타임라인 — resultTabs 구조는 검색 응답에 이미 실려 있다.
    showResultTabs(res.mails, res.resultTabs, label);
  } catch (err) {
    list.innerHTML = `<div class="empty">${escapeHtml(String(err))}</div>`;
  }
}

// ============================================================
//  ★ 4탭(마스터 지시): "정렬하고 검토하면 무조건 타임라인으로 정리·요약"
//  ------------------------------------------------------------
//  구조 집계(timeline/person/keyword)는 main.js buildResultTabs() 가 검색·대화 응답에
//  이미 동기로 실어 보낸다(즉시 렌더). 날짜별 AI 한줄+종합 요약만 비동기(ai:summarizeGroups)로
//  별도 요청해 리스트를 기다리게 하지 않는다(스켈레톤 → 완료 시 교체, 실패해도 목록은 유지).
//  ponytail: 타임라인 항목의 '요지'는 timeline-agg 가 만든 본문 발췌(oneLiner)를 그대로 쓴다
//    (메일 1건마다 AI 를 부르면 비용·시간이 폭증하므로 — 날짜구간 요약만 AI, 항목은 발췌).
// ============================================================
let resultTabsSummaryLoading = false;

function showResultTabs(mails, tabs, label) {
  mailCache = mails || [];
  resultTabsData = tabs && !tabs.error ? tabs : { timeline: [], person: [], keyword: [] };
  resultTabsLabel = label || '';
  resultTabsSummary = null;
  resultTabsSummaryFailed = false;
  resultTabsSummaryLoading = false;
  activeResultTab = 'timeline';
  $('#result-tabs').classList.remove('hidden');
  renderActiveResultTab();
}

// 대화창 응답(resultTabs 포함)을 메일 뷰의 결과탭에 반영한다.
//  switchNow=true(kind==='tab-switch') 면 즉시 메일 뷰로 전환해 요청한 탭을 보여준다.
//  그 외(검색/할일 브리핑 등)는 데이터만 채워 두고, 대화 카드의 [타임라인·표로 보기] 버튼으로 이동한다.
const RESULT_TAB_KEYS = ['timeline', 'list', 'person', 'keyword'];
function mirrorResultTabsFromChat(res, { switchNow = false, requestedTab = '' } = {}) {
  mailCache = res.mails || [];
  resultTabsData = res.resultTabs;
  resultTabsLabel = (res.chips || []).map(c => c.label).join(' · ') || resultTabsLabel;
  //  ★ search-grouped 는 같은 왕복에서 이미 AI 날짜별 요약을 만들어 왔다 — 재요청(비용 이중) 금지.
  resultTabsSummary = (res.dateGroups && res.dateGroups.some(g => g.summary))
    ? { overall: res.overall || [], byDate: new Map(res.dateGroups.filter(g => g.summary).map(g => [g.date, g.summary])) }
    : null;
  resultTabsSummaryFailed = false;
  resultTabsSummaryLoading = false;
  $('#result-tabs').classList.remove('hidden');
  activeResultTab = RESULT_TAB_KEYS.includes(requestedTab) ? requestedTab : 'timeline';
  if (switchNow) {
    switchView('mail');
    $('#mlp-title').textContent = resultTabsLabel || '검색 결과';
    renderActiveResultTab();
  }
}

function hideResultTabs() {
  resultTabsData = null;
  resultTabsSummary = null;
  resultTabsSummaryFailed = false;
  const bar = $('#result-tabs');
  if (bar) bar.classList.add('hidden');
}

// 목록 탭에서만 쓰는 클라이언트 정렬(재조회 없이 sort-by/sort-dir 를 즉시 반영)
function sortMailsClient(mails, by, dir) {
  const arr = [...(mails || [])];
  const tsOf = (m) => m.received_ts || Date.parse(String(m.received_at || '').replace(' ', 'T')) || 0;
  const cmp = {
    date: (a, b) => tsOf(a) - tsOf(b),
    sender: (a, b) => String(a.sender_name || a.sender_email || '').localeCompare(String(b.sender_name || b.sender_email || '')),
    subject: (a, b) => String(a.subject || '').localeCompare(String(b.subject || '')),
    attach: (a, b) => (Number(a.real_attach_count || a.attach_count) || 0) - (Number(b.real_attach_count || b.attach_count) || 0)
  }[by] || ((a, b) => (a.received_ts || 0) - (b.received_ts || 0));
  arr.sort(cmp);
  if (dir === 'desc') arr.reverse();
  return arr;
}

function renderActiveResultTab() {
  $$('.rt-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === activeResultTab));
  if (activeResultTab === 'list') renderMailList(sortMailsClient(mailCache, sortBy, sortDir));
  else if (activeResultTab === 'person') renderPersonTab();
  else if (activeResultTab === 'keyword') renderKeywordTab();
  else renderTimelineTab();
}

// ---- 타임라인 탭 ----
function tlDateLabel(dateKey) {
  if (!dateKey || dateKey === '(날짜미상)') return '날짜 미상';
  return `${dateKey} (${dateGroup(dateKey)})`;
}

function renderTimelineRow(r) {
  const isSent = r.dir === 'sent';
  const dirIcon = isSent ? '▶' : '◀';
  const dirLabel = isSent ? '보냄' : '받음';
  const attachBadge = r.attachCount > 0
    ? `<span class="tl-badge tl-badge-attach">${icon('paperclip', 11)} ${r.attachCount}</span>` : '';
  const as = r.actionState && AS_META[r.actionState];
  const stateBadge = as ? `<span class="as-chip ${as.cls} tl-badge-state">${escapeHtml(as.label)}</span>` : '';
  return `<div class="tl-row mail-item${r.sameThread ? ' tl-indent' : ''}" data-id="${r.id}">
      <div class="mi-row1">
        <span class="tl-dir ${isSent ? 'tl-dir-sent' : 'tl-dir-recv'}" title="${dirLabel}">${dirIcon}</span>
        <span class="mi-sender">${escapeHtml(r.counterpart || '(상대 없음)')}</span>
        <span class="mi-date">${escapeHtml(shortDate(r.receivedAt))}</span>
      </div>
      <div class="mi-subject">${escapeHtml(r.subject)}${attachBadge}${stateBadge}</div>
      <div class="mi-preview">${escapeHtml(r.oneLiner || '')}</div>
    </div>`;
}

function renderTimelineTab() {
  const list = $('#mail-list');
  const rows = (resultTabsData && resultTabsData.timeline) || [];
  if (!rows.length) { list.innerHTML = '<div class="empty">표시할 메일이 없습니다.</div>'; return; }

  const CAP = 60;
  const groups = [];
  let cur = null;
  for (const r of rows) {
    const key = r.dateKey || '(날짜미상)';
    if (!cur || cur.date !== key) { cur = { date: key, rows: [] }; groups.push(cur); }
    cur.rows.push(r);
  }

  const overallHtml = resultTabsSummary
    ? `<div class="tl-overall">${(resultTabsSummary.overall || []).map(s => `<p>${escapeHtml(s)}</p>`).join('') || `<p>${rows.length}건을 시간순으로 정리했습니다.</p>`}</div>`
    : (resultTabsSummaryFailed
        ? `<div class="tl-overall cv-badge cv-warn">${icon('flag', 12)} 요약을 생성하지 못했습니다 — 목록은 정상입니다.</div>`
        : `<div class="tl-overall tl-skeleton"><span class="tl-sk-line"></span><span class="tl-sk-line short"></span></div>`);
  const truncNote = rows.length > CAP
    ? `<div class="tl-trunc">${rows.length}건 중 상위 ${CAP}건 요약${resultTabsSummary ? '' : ' 준비 중'}</div>` : '';

  const body = groups.map(g => {
    const gSummary = resultTabsSummary && resultTabsSummary.byDate ? resultTabsSummary.byDate.get(g.date) : '';
    const head = `<div class="tl-date-head">
        <span class="tl-date-label">${escapeHtml(tlDateLabel(g.date))}</span>
        <span class="tl-date-count">${g.rows.length}건</span>
        ${gSummary ? `<span class="tl-date-sum">${escapeHtml(gSummary)}</span>` : ''}
      </div>`;
    return head + g.rows.map(renderTimelineRow).join('');
  }).join('');

  list.innerHTML = overallHtml + truncNote + body;
  list.querySelectorAll('.tl-row').forEach(el => el.addEventListener('click', () => {
    const id = parseInt(el.dataset.id, 10);
    const m = mailCache.find(x => x.id === id);
    if (m) openMailDetail(m);
  }));

  if (!resultTabsSummary && !resultTabsSummaryFailed && !resultTabsSummaryLoading) requestTimelineSummary();
}

// 날짜별 AI 요약(비동기) — 같은 결과 id 조합은 main.js 쪽 캐시(30분)가 재요약을 막는다.
async function requestTimelineSummary() {
  const ids = currentMailIds(mailCache);
  if (!ids.length) return;
  resultTabsSummaryLoading = true;
  try {
    const res = await window.api.aiSummarizeGroups(ids, resultTabsLabel, 60);
    resultTabsSummaryLoading = false;
    if (!res.ok) { resultTabsSummaryFailed = true; if (activeResultTab === 'timeline') renderTimelineTab(); return; }
    resultTabsSummary = { overall: res.overall || [], byDate: new Map((res.perDate || []).map(x => [x.date, x.summary])) };
    if (activeResultTab === 'timeline') renderTimelineTab();
  } catch (e) {
    resultTabsSummaryLoading = false;
    resultTabsSummaryFailed = true;
    if (activeResultTab === 'timeline') renderTimelineTab();
  }
}

// ---- 사람별 탭 ----
function mailsForPersonKey(mails, key) {
  return (mails || []).filter(m => {
    const isSent = String(m.folder || '') === 'Sent';
    if (isSent) return String(m.recipients || '').toLowerCase().split(/[;,]/).map(s => s.trim()).includes(key);
    return (m.sender_email || '').toLowerCase() === key || (m.sender_name || '').toLowerCase() === key;
  });
}

function renderPersonTab() {
  const list = $('#mail-list');
  const rows = (resultTabsData && resultTabsData.person) || [];
  if (!rows.length) { list.innerHTML = '<div class="empty">집계할 메일이 없습니다.</div>'; return; }
  list.innerHTML = `<table class="pt-table">
    <thead><tr><th>이름/조직</th><th>받은</th><th>보낸</th><th>최초</th><th>최근</th><th>미회신</th><th>주요 주제</th></tr></thead>
    <tbody>${rows.map(r => `
      <tr class="pt-row" data-key="${escapeHtml(r.key)}">
        <td class="pt-name">${escapeHtml(r.name)}${r.org ? `<span class="pt-org">${escapeHtml(r.org)}</span>` : ''}</td>
        <td>${r.recv}</td><td>${r.sent}</td>
        <td>${escapeHtml(shortDate(r.firstTs ? new Date(r.firstTs).toISOString().slice(0, 16).replace('T', ' ') : ''))}</td>
        <td>${escapeHtml(shortDate(r.lastTs ? new Date(r.lastTs).toISOString().slice(0, 16).replace('T', ' ') : ''))}</td>
        <td>${r.unanswered ? `<span class="pt-unanswered">${r.unanswered}</span>` : '0'}</td>
        <td>${(r.topics || []).map(t => `<span class="pt-topic">${escapeHtml(t)}</span>`).join('')}</td>
      </tr>`).join('')}</tbody></table>`;
  list.querySelectorAll('.pt-row').forEach(el => el.addEventListener('click', () => {
    const key = el.dataset.key;
    const scoped = mailsForPersonKey(mailCache, key);
    if (!scoped.length) return;
    const r = rows.find(x => x.key === key);
    resultTabsData = { timeline: timelineRowsClient(scoped), person: rows, keyword: resultTabsData.keyword };
    resultTabsLabel = (r ? r.name : key) + ' 왕복';
    resultTabsSummary = null; resultTabsSummaryFailed = false;
    mailCache = scoped;
    activeResultTab = 'timeline';
    renderActiveResultTab();
  }));
}

// ---- 키워드별 탭 ----
function renderKeywordTab() {
  const list = $('#mail-list');
  const rows = (resultTabsData && resultTabsData.keyword) || [];
  if (!rows.length) { list.innerHTML = '<div class="empty">추출된 키워드가 없습니다.</div>'; return; }
  list.innerHTML = `<table class="kt-table">
    <thead><tr><th>키워드</th><th>건수</th><th>관련 인물</th><th>기간</th><th>대표 메일</th></tr></thead>
    <tbody>${rows.map((r, i) => `
      <tr class="kt-row" data-i="${i}">
        <td class="kt-word">${escapeHtml(r.keyword)}</td>
        <td>${r.count}</td>
        <td>${(r.people || []).slice(0, 3).map(p => escapeHtml(p)).join(', ')}${(r.people || []).length > 3 ? ' 외' : ''}</td>
        <td>${escapeHtml(r.firstTs ? new Date(r.firstTs).toISOString().slice(0, 10) : '')} ~ ${escapeHtml(r.lastTs ? new Date(r.lastTs).toISOString().slice(0, 10) : '')}</td>
        <td class="kt-rep">${escapeHtml(r.repSubject || '')}</td>
      </tr>`).join('')}</tbody></table>`;
  list.querySelectorAll('.kt-row').forEach(el => el.addEventListener('click', () => {
    const r = rows[parseInt(el.dataset.i, 10)];
    if (!r || !r.repId) return;
    const m = mailCache.find(x => x.id === r.repId);
    openMailDetail(m || { id: r.repId });
  }));
}

// 사람별 표에서 '왕복' 전환할 때 클라이언트에서 즉시 타임라인 행을 만든다(재조회 없음).
function timelineRowsClient(mails) {
  const dirOf = (m) => (String(m.folder || '') === 'Sent' ? 'sent' : 'recv');
  const list = [...mails].sort((a, b) => (b.received_ts || 0) - (a.received_ts || 0));
  let prevThread = null;
  return list.map(m => {
    const threadKey = m.thread_key || '';
    const sameThread = !!threadKey && threadKey === prevThread;
    prevThread = threadKey || null;
    return {
      id: m.id, dir: dirOf(m),
      dateKey: (m.received_at || '').slice(0, 10),
      receivedAt: m.received_at || '',
      counterpart: dirOf(m) === 'sent' ? (m.recipients || '') : (m.sender_name || m.sender_email || ''),
      subject: m.subject || '(제목 없음)',
      oneLiner: String(m.preview || '').replace(/\s+/g, ' ').trim().slice(0, 90),
      hasAttach: !!m.has_attach,
      attachCount: Number(m.real_attach_count != null ? m.real_attach_count : (m.attach_count || 0)) || 0,
      actionState: m.action_state || '', threadKey, sameThread
    };
  });
}

// ---- 4탭 엑셀 내보내기 ----
async function exportActiveResultTab() {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const labelSafe = (resultTabsLabel || '결과').slice(0, 20);
  if (activeResultTab === 'list') { await exportListToExcel(mailCache, '목록', `${labelSafe}-목록-${stamp}`); return; }
  let rows = [], sheetName = '';
  if (activeResultTab === 'timeline') {
    sheetName = '타임라인';
    rows = ((resultTabsData && resultTabsData.timeline) || []).map(r => ({
      방향: r.dir === 'sent' ? '보냄' : '받음', 날짜: r.receivedAt, 상대: r.counterpart,
      제목: r.subject, 요지: r.oneLiner, 첨부: r.attachCount, 상태: (AS_META[r.actionState] || {}).label || ''
    }));
  } else if (activeResultTab === 'person') {
    sheetName = '사람별';
    rows = ((resultTabsData && resultTabsData.person) || []).map(r => ({
      '이름/조직': r.org ? `${r.name} (${r.org})` : r.name, 받은: r.recv, 보낸: r.sent,
      최초: r.firstTs ? new Date(r.firstTs).toISOString().slice(0, 10) : '',
      최근: r.lastTs ? new Date(r.lastTs).toISOString().slice(0, 10) : '',
      미회신: r.unanswered, 주요주제: (r.topics || []).join(', ')
    }));
  } else if (activeResultTab === 'keyword') {
    sheetName = '키워드별';
    rows = ((resultTabsData && resultTabsData.keyword) || []).map(r => ({
      키워드: r.keyword, 건수: r.count, 관련인물: (r.people || []).join(', '),
      최초: r.firstTs ? new Date(r.firstTs).toISOString().slice(0, 10) : '',
      최근: r.lastTs ? new Date(r.lastTs).toISOString().slice(0, 10) : '',
      대표메일: r.repSubject || ''
    }));
  }
  if (!rows.length) { alert('내보낼 데이터가 없습니다.'); return; }
  showLoading(`엑셀 만드는 중... (${rows.length.toLocaleString()}건)`);
  try {
    const r = await window.api.exportExcel({ rows, sheetName, fileName: `${labelSafe}-${sheetName}-${stamp}.xlsx` });
    hideLoading();
    if (!r.ok) { alert('엑셀 내보내기 실패: ' + r.error); return; }
    setExportInfo(`엑셀 ${r.totalRows.toLocaleString()}행 저장 완료 · ${r.file}`);
  } catch (e) { hideLoading(); alert('엑셀 내보내기 오류: ' + e); }
}

// ============================================================
//  메일 목록
// ============================================================
//  opts.silent = true 면 '불러오는 중...'으로 화면을 비우지 않는다.
//   (자동 갱신 때 목록이 잠깐 비면 스크롤이 튀고 읽던 자리를 잃는다 — 마스터 제약)
async function loadMails(query, opts = {}) {
  const list = $('#mail-list');
  hideResultTabs();   // 폴더/필터 탭 목록은 4탭 구조와 무관 — 결과탭 바를 숨겨 mailCache 불일치를 막는다
  if (!opts.silent) list.innerHTML = '<div class="empty">불러오는 중...</div>';
  try {
    let hasAttach = ($('#filter-attach') && $('#filter-attach').checked) ? true : null;
    let folder = null;
    if (currentVFolder) { /* 로컬 가상 폴더 선택 시 실폴더 필터 미적용 */ }
    else if (currentFolder === '__attach') hasAttach = true;
    else if (currentFolder && currentFolder !== 'all') folder = currentFolder;   // 폴더 트리의 임의 폴더명 지원

    const res = await window.api.dbSearchMails({
      query: (query || '').trim(), limit: 300, hasAttach, folder,
      vfolderId: currentVFolder, unreadOnly: readTab === 'unread', toMe: toMeTab, sortBy, sortDir,
      actionState: actionTab.length ? actionTab : null
    });
    if (!res.ok) { list.innerHTML = `<div class="empty">${escapeHtml(res.error)}</div>`; return; }
    mailCache = res.mails;
    renderMailList(mailCache);
    // 상태 배지 건수 + 자동 제안(수동 지정 없는 건만) — 화면 표시용, 저장하지 않음
    refreshActionCounts();
    loadActionSuggestions(mailCache);
  } catch (err) {
    list.innerHTML = `<div class="empty">${escapeHtml(String(err))}</div>`;
  }
}

// ------------------------------------------------------------
//  대화 스레드 그룹핑
//  제목의 RE:/FW:/[말머리] 를 제거한 정규화 제목으로 같은 대화를 묶는다.
//  (db.js 의 normalizeSubject 와 동일 규칙 — 서버/클라 동작 일치)
// ------------------------------------------------------------
function normalizeSubjectClient(s) {
  return String(s || '')
    .replace(/^(\s*(re|fw|fwd|답장|전달)\s*(\[\d+\])?\s*:)+/gi, '')
    .replace(/\[[^\]]{1,20}\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function groupIntoThreads(mails) {
  const map = new Map();
  for (const m of mails) {
    const key = normalizeSubjectClient(m.subject) || `__id${m.id}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(m);
  }
  const groups = [...map.values()].map(items => {
    items.sort((a, b) => (b.received_ts || 0) - (a.received_ts || 0));
    return { latest: items[0], items, count: items.length };
  });
  groups.sort((a, b) => (b.latest.received_ts || 0) - (a.latest.received_ts || 0));
  return groups;
}

function renderThreadList(mails) {
  const list = $('#mail-list');
  const groups = groupIntoThreads(mails);
  list.innerHTML = `<div class="date-group">대화 ${groups.length}개 · 메일 ${mails.length}건</div>`;
  groups.forEach(g => {
    const m = g.latest;
    const wrap = document.createElement('div');
    wrap.className = 'thread-group';
    const head = document.createElement('div');
    head.className = 'mail-item thread-head';
    head.innerHTML = `
      <div class="mi-row1">
        <span class="mi-sender">${escapeHtml(m.sender_name || m.sender_email || '(발신자)')}</span>
        <span class="mi-date">${escapeHtml(shortDate(m.received_at || ''))}</span>
      </div>
      <div class="mi-subject">${escapeHtml(m.subject || '(제목 없음)')}
        ${g.count > 1 ? `<span class="thread-badge">${g.count}</span>` : ''}</div>
      <div class="mi-preview">${escapeHtml((m.preview || '').replace(/\s+/g, ' ').slice(0, 120))}</div>`;
    const children = document.createElement('div');
    children.className = 'thread-children hidden';
    g.items.forEach(it => {
      const ci = document.createElement('div');
      ci.className = 'thread-child';
      ci.innerHTML = `<span class="tc-date">${escapeHtml(shortDate(it.received_at || ''))}</span>
        <span class="tc-sender">${escapeHtml(it.sender_name || it.sender_email || '')}</span>
        <span class="tc-folder">${escapeHtml(it.folder || '')}</span>`;
      ci.addEventListener('click', (e) => { e.stopPropagation(); openMailDetail(it); });
      children.appendChild(ci);
    });
    head.addEventListener('click', () => {
      if (g.count > 1) children.classList.toggle('hidden');
      $$('.mail-item').forEach(x => x.classList.remove('selected'));
      head.classList.add('selected');
      openMailDetail(m);
    });
    wrap.appendChild(head); wrap.appendChild(children);
    list.appendChild(wrap);
  });
}

function renderMailList(mails) {
  const list = $('#mail-list');
  if (!mails || mails.length === 0) {
    // 🔴 0건 원인을 정직하게 알린다. 필터 때문인데 '동기화하세요'라고 하면 오진을 부른다(실사용 사고).
    const f = activeFilterLabels();
    list.innerHTML = f.length
      ? `<div class="empty">현재 필터에 해당하는 메일이 없습니다.<br>
           <span class="empty-filters">활성 필터: ${escapeHtml(f.join(' + '))}</span><br>
           <button class="btn-primary" id="empty-reset">필터 초기화</button></div>`
      : '<div class="empty">저장된 메일이 없습니다.<br>상단 <b>동기화</b>를 먼저 실행하세요.</div>';
    const er = $('#empty-reset');
    if (er) er.addEventListener('click', () => resetAllFilters());
    return;
  }
  if ($('#filter-thread') && $('#filter-thread').checked) { renderThreadList(mails); return; }
  list.innerHTML = '';
  let lastGroup = null;
  mails.forEach(m => {
    const subject = m.subject || '(제목 없음)';
    const sender = (m.sender_name !== undefined ? m.sender_name : m.sender) || '(발신자)';
    const received = (m.received_at !== undefined ? m.received_at : m.received) || '';
    const hasAttach = m.has_attach !== undefined ? m.has_attach : m.hasAttach;
    // 진짜 첨부 수 우선 (인라인 이미지는 세지 않는다)
    const attachCount = (m.real_attach_count !== undefined && m.real_attach_count !== null)
      ? m.real_attach_count : (m.attach_count !== undefined ? m.attach_count : m.attachCount);
    const unread = mailIsUnread(m);
    const preview = (m.preview || '').replace(/\s+/g, ' ');
    const lang = m.lang || '';
    const langTag = lang === 'en' ? 'EN' : (lang === 'zh' ? 'ZH' : (lang === 'ja' ? 'JA' : ''));

    // 날짜 그룹 헤더 (오늘/어제/요일/지난 주/2주 전/그 이전) + 접기
    const group = dateGroup(received);
    if (group !== lastGroup) {
      lastGroup = group;
      const gh = document.createElement('div');
      gh.className = 'date-group dg-toggle';
      const isCollapsed = collapsedGroups.has(group);
      gh.innerHTML = `<span class="dg-caret">${isCollapsed ? '▶' : '▼'}</span><span class="dg-name">${escapeHtml(group)}</span>`;
      gh.addEventListener('click', () => {
        if (collapsedGroups.has(group)) collapsedGroups.delete(group); else collapsedGroups.add(group);
        renderMailList(mailCache);
      });
      list.appendChild(gh);
    }
    if (collapsedGroups.has(group)) return;   // 접힌 그룹은 항목 숨김

    const item = document.createElement('div');
    // 🔴 상태는 '행 왼쪽 색 띠'로 보여 준다(배지가 제목을 밀어내지 않게).
    //   색만으로 구분하지 않는다 — title 툴팁·읽기창 상단 라벨·필터 칩 라벨로 글자 정보를 유지한다.
    const asKey = AS_META[m.action_state] ? m.action_state : '';
    const asStripe = { todo: 'mi-as-todo', hold: 'mi-as-hold', done: 'mi-as-done', fyi: 'mi-as-fyi' }[asKey] || '';
    item.className = 'mail-item' + (unread ? ' mi-unread' : '') + (asStripe ? ' mi-as ' + asStripe : '');
    if (asKey) item.title = `내 처리 상태: ${AS_META[asKey].label}${m.action_due ? ' · 기한 ' + m.action_due : ''}`;
    item.draggable = true;
    item.innerHTML = `
      ${unread ? '<span class="mi-unread-bar"></span>' : ''}
      <div class="mi-row1">
        <span class="mi-sender">${escapeHtml(sender)}</span>
        <span class="mi-right">
          ${hasAttach ? `<span class="mi-clip" title="첨부 있음">${icon('clip', 12)}</span>` : ''}
          <span class="mi-date">${escapeHtml(shortDate(received))}</span>
        </span>
      </div>
      <div class="mi-subject ${unread ? 'unread' : ''}">${toMeMarker(m)}${importanceMarker(m)}${categoryDots(m)}${escapeHtml(subject)}${flagMarker(m)}</div>
      <div class="mi-preview">${escapeHtml(preview)}${(langTag || hasAttach || m.vfolder_name) ? `<span class="mi-tags">${m.vfolder_name ? `<span class="vf-tag">${escapeHtml(m.vfolder_name)}</span>` : ''}${langTag ? `<span class="lang-tag">${langTag}</span>` : ''}${hasAttach ? `<span class="attach-tag">첨부${attachCount ? ' ' + attachCount : ''}</span>` : ''}</span>` : ''}</div>`;
    item.addEventListener('click', () => {
      $$('.mail-item').forEach(x => x.classList.remove('selected'));
      item.classList.add('selected');
      useReadingPane('mail');
      openMailDetail(m);
    });
    item.addEventListener('contextmenu', (e) => { e.preventDefault(); showMailMenu(e, m); });
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/mail-id', String(m.id));
      e.dataTransfer.effectAllowed = 'move';
    });
    list.appendChild(item);
  });
}

// 날짜 그룹: 오늘 / 어제 / 요일명(이번 주) / 지난 주 / 2주 전 / 그 이전 (Outlook 방식)
const WEEKDAY_KO = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
function dateGroup(s) {
  if (!s) return '그 이전';
  const m = String(s).match(/(\d{4})[-/](\d{2})[-/](\d{2})/);
  if (!m) return '그 이전';
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.floor((today - d) / 86400000);
  if (diffDays <= 0) return '오늘';
  if (diffDays === 1) return '어제';
  if (diffDays < 7) return WEEKDAY_KO[d.getDay()];   // 이번 주는 요일명으로
  if (diffDays < 14) return '지난 주';
  if (diffDays < 21) return '2주 전';
  return '그 이전';
}

function shortDate(s) {
  if (!s) return '';
  // "2026-01-24 07:13" 형태 → 오늘이면 시간, 아니면 날짜
  const str = String(s);
  const m = str.match(/(\d{4})[-/](\d{2})[-/](\d{2})[ T]?(\d{2})?:?(\d{2})?/);
  if (!m) return str.slice(0, 16);
  const now = new Date();
  const y = +m[1], mo = +m[2], d = +m[3];
  if (y === now.getFullYear() && mo === now.getMonth() + 1 && d === now.getDate()) return `${m[4] || ''}:${m[5] || ''}`;
  if (y === now.getFullYear()) return `${mo}/${d}`;
  return `${y.toString().slice(2)}/${mo}/${d}`;
}

// ============================================================
//  메일 상세 → 읽기창(reading pane)
// ============================================================
async function openMailDetail(m) {
  let id = m.id;
  if (!id) { alert('이 메일은 아직 DB에 색인되지 않았습니다. 동기화 후 확인하세요.'); return; }
  showLoading('메일 불러오는 중...');
  try {
    const res = await window.api.dbGetMail(id);
    hideLoading();
    if (!res.ok) { alert(res.error); return; }
    selectedMail = res.mail;
    $('#rb-reply').disabled = false;
    $('#rb-translate').disabled = false;
    renderReadingPane(res.mail, res.attachments, res.analyses, res.inlineAttachments);
    // 회신 대기 뷰에서 열었으면 그 뷰에 머문다
    if (rpTargets.content === '#rp-content' && !$('#view-mail').classList.contains('active')) switchView('mail');
    // 메일을 열면 로컬 읽음 처리 (Outlook 원본 상태는 변경하지 않음)
    if (mailIsUnread(res.mail)) {
      try {
        await window.api.mailSetRead([res.mail.id], true);
        const cached = mailCache.find(x => x.id === res.mail.id);
        if (cached) { cached.read_flag = 1; cached.eff_unread = 0; }
        renderMailList(mailCache);
        refreshUnreadBadges();
      } catch (_) {}
    }
  } catch (err) { hideLoading(); alert('오류: ' + String(err)); }
}

// ============================================================
//  4열 레이아웃 제어 (마스터 정정 지시 2026-08-20)
//  ------------------------------------------------------------
//  트리 | 목록 | [메일 본문 단독 열] | 도구 패널(분석/대화/미리보기 세로 3단)
//   · 본문은 세로로 쪼개지 않는다 — 항상 가장 넓은 영역.
//   · 도구 패널 각 섹션은 내용이 없으면 헤더(36px)만 차지한다.
//   · 도구 패널 전체를 접으면 본문이 그 폭을 회수한다.
// ============================================================
//  v2: 이전 버전에서 저장된 과도한 목록 폭(700px 등) 때문에 본문이 좁아지던 문제를 끊는다
//  v3: 이전 버전의 불균등 비율·과도한 폭 저장값을 끊는다(균등 분할 기본)
const RS_KEYS = { list: 'bmail.gridListW.v3', side: 'bmail.gridSideW.v3', ai: 'bmail.gridAiH.v3', chat: 'bmail.gridChatH.v3', prev: 'bmail.gridPrevH.v3' };
const rsCollapsed = { ai: true, chat: false, prev: true };

function sideRoot() { return document.getElementById('side-stack'); }
function mailSplit() { return document.querySelector('#view-mail.mail-split'); }

function restoreGridSizes() {
  try {
    const lw = parseInt(localStorage.getItem(RS_KEYS.list) || '', 10);
    if (Number.isFinite(lw)) document.documentElement.style.setProperty('--list-w', Math.max(260, Math.min(lw, 560)) + 'px');
    const sw = parseInt(localStorage.getItem(RS_KEYS.side) || '', 10);
    if (Number.isFinite(sw)) document.documentElement.style.setProperty('--side-w', Math.max(260, Math.min(sw, 560)) + 'px');
    for (const k of ['ai', 'chat', 'prev']) {
      const v = localStorage.getItem('bmail.rsCollapsed.' + k);
      if (v !== null) toggleRsSection(k, v === '1');
    }
    if (localStorage.getItem('bmail.sideCollapsed') === '1') toggleSidePanel(true);
  } catch (e) { /* 저장값이 깨져도 기본 레이아웃으로 동작 */ }
}

//  섹션 접기/펼치기 — 접히면 헤더 36px만 차지한다
function toggleRsSection(key, force) {
  const sec = document.getElementById('rs-' + key);
  if (!sec) return;
  const next = (force === undefined) ? !sec.classList.contains('collapsed') : !!force;
  sec.classList.toggle('collapsed', next);
  rsCollapsed[key] = next;
  const caret = sec.querySelector('.rs-caret');
  if (caret) caret.textContent = next ? '\u25B8' : '\u25BE';
  try { localStorage.setItem('bmail.rsCollapsed.' + key, next ? '1' : '0'); } catch (e) {}
  applyStackRows();
}

//  접힘 상태를 반영해 도구 패널 행 높이 재계산
function applyStackRows() {
  const root = sideRoot();
  if (!root) return;
  const openKeys = ['ai', 'chat', 'prev'].filter(k => !rsCollapsed[k]);
  //  펼쳐진 섹션은 기본 '균등'. 저장된 비율이 있으면 그 비율대로 하되 합을 정규화한다.
  const saved = {};
  let sum = 0;
  for (const k of openKeys) {
    let v = NaN;
    try { v = parseFloat(localStorage.getItem(RS_KEYS[k]) || ''); } catch (e) {}
    saved[k] = (Number.isFinite(v) && v > 0) ? v : 0;
    sum += saved[k];
  }
  const useSaved = openKeys.length > 0 && openKeys.every(k => saved[k] > 0);
  const rowOf = (k) => {
    if (rsCollapsed[k]) return '36px';
    const fr = useSaved ? (saved[k] / sum) * openKeys.length : 1;
    return 'minmax(80px, ' + fr.toFixed(3) + 'fr)';
  };
  //  ★ display:none 인 요소는 그리드 아이템에서 제외된다.
  //    좁은 창 전용 탭바가 숨겨지면 행이 한 칸씩 밀려 대화 영역이 6px 로 찌그러졌다(실측).
  //    → 탭바가 실제로 보일 때만 'auto' 행을 넣는다.
  //  도구 패널이 320px 미만으로 좁아지면 3단 대신 탭 1개로(문구가 깨지지 않게)
  const narrowSide = root.getBoundingClientRect().width > 0 && root.getBoundingClientRect().width < 320;
  root.classList.toggle('side-narrow', narrowSide);
  if (narrowSide) {
    const active = ['chat', 'ai', 'prev'].find(k => !rsCollapsed[k]) || 'chat';
    showSideTab(active);
  }
  const tabs = document.getElementById('side-tabs');
  const tabsVisible = !!(tabs && getComputedStyle(tabs).display !== 'none');
  const rows = [];
  if (tabsVisible) rows.push('auto');
  rows.push(rowOf('ai'), '6px', rowOf('chat'), '6px', rowOf('prev'));
  root.style.gridTemplateRows = rows.join(' ');
}

//  도구 패널 전체 접기 — 본문이 폭을 회수한다
function toggleSidePanel(force) {
  const sp = mailSplit();
  if (!sp) return;
  const narrow = window.innerWidth <= 1100;
  if (narrow) {
    const open = (force === undefined) ? !sp.classList.contains('side-open') : !force;
    sp.classList.toggle('side-open', open);
  } else {
    const next = (force === undefined) ? !sp.classList.contains('side-collapsed') : !!force;
    sp.classList.toggle('side-collapsed', next);
    try { localStorage.setItem('bmail.sideCollapsed', next ? '1' : '0'); } catch (e) {}
  }
  const btn = document.getElementById('rs-side-toggle');
  if (btn) {
    const hidden = narrow ? !sp.classList.contains('side-open') : sp.classList.contains('side-collapsed');
    btn.textContent = hidden ? '\uB3C4\uAD6C \u25C2' : '\uB3C4\uAD6C \u25B8';
  }
}

//  세로 리사이저(목록 폭 · 도구 패널 폭)
function bindGridResizers() {
  const bindV = (id, cssVar, key, fromRight) => {
    const rz = document.getElementById(id);
    if (!rz) return;
    let on = false;
    rz.addEventListener('mousedown', (e) => { on = true; rz.classList.add('dragging'); e.preventDefault(); document.body.style.cursor = 'col-resize'; });
    window.addEventListener('mousemove', (e) => {
      if (!on) return;
      const sp = mailSplit();
      if (!sp) return;
      const r = sp.getBoundingClientRect();
      const w = fromRight
        ? Math.max(260, Math.min(r.right - e.clientX, 560))
        : Math.max(260, Math.min(e.clientX - r.left, 560));
      document.documentElement.style.setProperty(cssVar, Math.round(w) + 'px');
      try { localStorage.setItem(key, String(Math.round(w))); } catch (er) {}
    });
    window.addEventListener('mouseup', () => { if (on) { on = false; rz.classList.remove('dragging'); document.body.style.cursor = ''; } });
  };
  bindV('rz-list', '--list-w', RS_KEYS.list, false);
  bindV('rz-side', '--side-w', RS_KEYS.side, true);

  const bindH = (rzId, upper, lower) => {
    const rz = document.getElementById(rzId);
    if (!rz) return;
    let on = false;
    rz.addEventListener('mousedown', (e) => { on = true; rz.classList.add('dragging'); e.preventDefault(); document.body.style.cursor = 'row-resize'; });
    window.addEventListener('mousemove', (e) => {
      if (!on) return;
      const up = document.getElementById('rs-' + upper), lo = document.getElementById('rs-' + lower);
      if (!up || !lo || rsCollapsed[upper] || rsCollapsed[lower]) return;
      const top = up.getBoundingClientRect().top, bottom = lo.getBoundingClientRect().bottom;
      const total = bottom - top;
      if (total < 160) return;
      const ratio = Math.max(0.15, Math.min((e.clientY - top) / total, 0.85));
      try {
        localStorage.setItem(RS_KEYS[upper], (ratio * 2).toFixed(3));
        localStorage.setItem(RS_KEYS[lower], ((1 - ratio) * 2).toFixed(3));
      } catch (er) {}
      applyStackRows();
    });
    window.addEventListener('mouseup', () => { if (on) { on = false; rz.classList.remove('dragging'); document.body.style.cursor = ''; } });
  };
  bindH('rz-chat', 'ai', 'chat');
  bindH('rz-prev', 'chat', 'prev');
}

//  좁은 창(<=1400)에서 쓰는 탭 — 한 번에 한 섹션만
function showSideTab(which) {
  ['ai', 'chat', 'prev'].forEach(k => {
    const sec = document.getElementById('rs-' + k);
    if (sec) sec.classList.toggle('side-active', k === which);
  });
  document.querySelectorAll('#side-tabs .rs-tab').forEach(b => b.classList.toggle('active', b.dataset.side === which));
  if (rsCollapsed[which]) toggleRsSection(which, false);
}

//  대화·미리보기 노드를 도구 패널 안으로 이동(팝업 제거)
function mountRightStackPanels() {
  const chatPane = document.getElementById('rs-pane-chat');
  const prevPane = document.getElementById('rs-pane-prev');
  const gchat = document.getElementById('gchat');
  const att = document.getElementById('att-preview');
  if (chatPane && gchat && gchat.parentElement !== chatPane) {
    gchat.classList.remove('hidden', 'collapsed');
    chatPane.appendChild(gchat);
  }
  if (prevPane && att && att.parentElement !== prevPane) {
    att.classList.remove('hidden');
    prevPane.appendChild(att);
  }
  const host = document.getElementById('gchat-host');
  const node = document.querySelector('.chat-main');
  if (host && node && node.parentElement !== host) host.appendChild(node);
}

//  섹션 헤더 우측 부제
function setRsSub(key, text) {
  const el = document.getElementById('rs-' + key + '-sub');
  if (el) { el.textContent = text || ''; el.title = text || ''; }
}

function bindRightStack() {
  document.querySelectorAll('#view-mail .rs-head').forEach(h => {
    h.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      if (h.dataset.sec === 'read') return;         // 본문은 접지 않는다(항상 최대)
      toggleRsSection(h.dataset.sec);
    });
  });
  document.querySelectorAll('#side-tabs .rs-tab').forEach(b =>
    b.addEventListener('click', () => showSideTab(b.dataset.side)));
  const st = document.getElementById('rs-side-toggle');
  if (st) st.addEventListener('click', (e) => { e.stopPropagation(); toggleSidePanel(); });
  const back = document.getElementById('rs-back');
  if (back) back.addEventListener('click', (e) => {
    e.stopPropagation();
    const sp = mailSplit();
    if (sp) sp.classList.remove('show-right');
  });
  bindGridResizers();
  mountRightStackPanels();
  restoreGridSizes();
  applyStackRows();
  showSideTab('chat');
}

// 읽기창 컨테이너 전환: 메일 뷰와 회신 대기 뷰가 같은 컴포넌트를 공유한다(중복 구현 금지)
let rpTargets = { empty: '#rp-empty', content: '#rp-content' };
//  ai: 분석 결과를 그릴 컨테이너. 메일 뷰만 '우측 스택의 별도 셀'을 쓰고,
//      나머지 뷰는 예전처럼 읽기창 안(#rp-ai-result)에 그린다(회귀 0).
const RP_PANES = {
  followup: { empty: '#fu-rp-empty', content: '#fu-rp-content' },
  todo: { empty: '#todo-rp-empty', content: '#todo-rp-content' },
  sent: { empty: '#sent-rp-empty', content: '#sent-rp-content' },
  chat: { empty: '#chat-rp-empty', content: '#chat-rp-content' },
  mail: { empty: '#rp-empty', content: '#rp-content', ai: '#rs-ai-body' }
};
function useReadingPane(which) {
  rpTargets = RP_PANES[which] || RP_PANES.mail;
}

// 🔴 읽기창은 4곳(메일/보낸메일/회신대기/검색)에 '같은 id' 로 렌더된다.
//   document.querySelector 를 쓰면 언제나 문서의 첫 번째(= 메일 패널)만 잡혀
//   보낸메일 읽기창의 버튼·결과 영역이 통째로 무반응이 된다(실측 결함).
//   → 읽기창 내부 요소는 반드시 이 헬퍼로 '지금 쓰는 패널 안에서만' 찾는다.
function rpq(sel) {
  const cont = document.querySelector(rpTargets.content);
  return cont ? cont.querySelector(sel) : null;
}

// 검색(대화) 화면을 벗어나지 않고 오른쪽 읽기창에만 메일을 띄운다.
//  좌측 결과 목록은 그대로 유지 → 연속 클릭·후속 질문이 가능하다.
async function openMailInChatPane(mailId, btn) {
  if (!mailId) return;
  $('#chat-log').querySelectorAll('.grounded-item.selected').forEach(x => x.classList.remove('selected'));
  if (btn) btn.classList.add('selected');
  // ★ 전역 패널로 대화 중이면 '메일 검색' 뷰의 읽기창은 화면에 없다(숨은 뷰).
  //   그대로 그리면 사용자는 아무 변화도 못 본다 → 메일 화면의 읽기창에 연다(패널은 열린 채 유지).
  if (gchatOpen) {
    switchView('mail');
    useReadingPane('mail');
    await openMailDetail({ id: mailId });
    updateGchatCtx();      // 방금 연 메일이 곧 새 맥락이 된다
    return;
  }
  useReadingPane('chat');
  await openMailDetail({ id: mailId });
}

// ============================================================
//  첨부 미리보기 (앱 안에서 열기 — 외부 프로그램 실행 없음)
//  ------------------------------------------------------------
//  마스터 요구(2026-08-20): 첨부를 클릭하면 옆 패널에서 바로 본다.
//   · PDF  : Chromium 내장 뷰어(iframe file://) — 페이지 이동·확대 지원
//   · 이미지: <img>
//   · 텍스트/CSV: 파일을 읽어 <pre> (용량 상한 512KB)
//   · 그 외 : 미리보기 미지원 안내 + [기본 프로그램으로 열기]
//  저장 안 된 첨부는 클릭 시 자동으로 가져온 뒤 표시한다.
// ============================================================
let attPreview = { mailId: null, items: [], idx: -1 };

const AP_IMG = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'];
const AP_TXT = ['txt', 'csv', 'log', 'md', 'json', 'xml', 'html', 'htm'];
const apExt = (n) => (String(n || '').split('.').pop() || '').toLowerCase();
const apSize = (kb) => (kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB' : (kb || 0) + ' KB');

//  현재 읽기창 첨부 목록을 미리보기 대상으로 등록한다
function setAttachPreviewList(mailId, items) {
  attPreview = { mailId, items: (items || []).filter(a => !a.inline), idx: -1 };
}

//  첨부 목록 <li> — 파일명이 곧 미리보기 버튼
function attachItemHtml(a, i) {
  return `<li><button class="att-name" data-apidx="${i}" title="클릭하면 옆에서 미리봅니다">${escapeHtml(a.name)}</button>
    <span style="color:var(--muted)">(${apSize(a.sizeKB)})</span>${
      a.savedPath ? ` <button class="link-btn" data-folder="${escapeHtml(a.savedPath)}">폴더</button>` : ''}</li>`;
}

function bindAttachPreviewClicks(root) {
  if (!root) return;
  root.querySelectorAll('[data-apidx]').forEach(b =>
    b.addEventListener('click', () => openAttachPreview(parseInt(b.dataset.apidx, 10))));
}

async function openAttachPreview(idx) {
  const panel = $('#att-preview');
  if (!panel || !attPreview.items.length) return;
  if (idx < 0 || idx >= attPreview.items.length) return;
  attPreview.idx = idx;
  panel.classList.remove('hidden');
  //  우측 스택의 '미리보기' 탭으로 전환(팝업 없이 같은 칸에서 본다)
  if (document.getElementById('rs-prev')) { mountRightStackPanels(); toggleRsSection('prev', false); showSideTab('prev'); }

  let item = attPreview.items[idx];
  const body = $('#ap-body');
  $('#ap-title').textContent = item.name;
  $('#ap-title').title = item.name;
  $('#ap-meta').textContent = `${apSize(item.sizeKB)} · ${idx + 1}/${attPreview.items.length}`;
  $('#ap-prev').disabled = idx <= 0;
  $('#ap-next').disabled = idx >= attPreview.items.length - 1;

  // 아직 로컬에 없으면 지금 가져온다
  if (!item.savedPath) {
    body.innerHTML = `<div class="ap-loading">첨부를 가져오는 중입니다... (${escapeHtml(item.name)})</div>`;
    const f = await window.api.mailAttachFetch(attPreview.mailId);
    if (!f.ok) {
      body.innerHTML = `<div class="ap-note"><b>첨부를 가져오지 못했습니다.</b><br>${escapeHtml(f.error || '')}</div>`;
      return;
    }
    // 가져온 결과로 경로를 채운다(이름 기준 매칭)
    for (const got of f.items || []) {
      const t = attPreview.items.find(x => x.name === got.name);
      if (t) t.savedPath = got.savedPath;
    }
    item = attPreview.items[idx];
    if (!item.savedPath) {
      body.innerHTML = `<div class="ap-note"><b>이 첨부는 파일로 받을 수 없습니다.</b><br>본문에 삽입된 이미지일 수 있습니다.</div>`;
      return;
    }
    // 읽기창 목록도 갱신(폴더 버튼이 생기도록)
    const lazy = rpq('#rp-atts-lazy') || rpq('.rp-atts');
    if (lazy) {
      lazy.innerHTML = `<b>첨부파일 (${attPreview.items.length})</b><ul>${
        attPreview.items.map((a, i) => attachItemHtml(a, i)).join('')}</ul>`;
      bindAttachPreviewClicks(lazy);
      bindAttachOpenButtons(lazy);
    }
  }

  renderAttachPreview(item);
}

function renderAttachPreview(item) {
  const body = $('#ap-body');
  const ext = apExt(item.name);
  const url = 'file:///' + String(item.savedPath).replace(/\\/g, '/').replace(/^\/+/, '');
  if (ext === 'pdf') {
    body.innerHTML = `<div class="ap-loading">PDF 를 여는 중...</div>`;
    const f = document.createElement('iframe');
    f.src = encodeURI(url);
    f.addEventListener('load', () => { const l = body.querySelector('.ap-loading'); if (l) l.remove(); });
    body.innerHTML = '';
    body.appendChild(f);
    return;
  }
  if (AP_IMG.includes(ext)) {
    body.innerHTML = `<img src="${encodeURI(url)}" alt="${escapeHtml(item.name)}" />`;
    return;
  }
  if (AP_TXT.includes(ext)) {
    body.innerHTML = `<div class="ap-loading">파일을 읽는 중...</div>`;
    window.api.filePreview(item.savedPath).then(r => {
      if (!r.ok) { body.innerHTML = `<div class="ap-note">${escapeHtml(r.error || '읽기 실패')}</div>`; return; }
      body.innerHTML = `<pre>${escapeHtml(r.text || '')}</pre>${
        r.truncated ? '<div class="ap-note">파일이 커서 앞부분만 표시했습니다.</div>' : ''}`;
    });
    return;
  }
  body.innerHTML = `<div class="ap-note">
    <b>이 형식은 앱 안에서 미리볼 수 없습니다.</b> (${escapeHtml(ext || '알 수 없음')})<br>
    아래 <b>기본 프로그램</b> 버튼을 누르면 연결된 프로그램에서 열립니다.<br>
    <span style="font-size:11.5px">미리보기 지원: PDF · 이미지(png·jpg·gif·bmp) · 텍스트/CSV</span></div>`;
}

function closeAttachPreview() {
  const p = $('#att-preview');
  if (p) p.classList.add('hidden');
}

function bindAttachPreviewPanel() {
  const cur = () => attPreview.items[attPreview.idx] || null;
  $('#ap-close').addEventListener('click', closeAttachPreview);
  $('#ap-prev').addEventListener('click', () => openAttachPreview(attPreview.idx - 1));
  $('#ap-next').addEventListener('click', () => openAttachPreview(attPreview.idx + 1));
  $('#ap-open').addEventListener('click', () => { const c = cur(); if (c && c.savedPath) window.api.openPath(c.savedPath); });
  $('#ap-folder').addEventListener('click', () => { const c = cur(); if (c && c.savedPath) window.api.showItem(c.savedPath); });
  $('#ap-save').addEventListener('click', async () => {
    const c = cur();
    if (!c || !c.savedPath) return;
    const r = await window.api.fileSaveAs(c.savedPath);
    if (r.ok && r.saved) $('#ap-meta').textContent = '저장했습니다';
    else if (!r.ok) alert('저장 실패: ' + (r.error || ''));
  });
}

//  저장 전 첨부 목록 채우기 — 이름·크기만 먼저 보여주고 [가져오기]로 실제 저장한다.
async function loadLazyAttachments(box, mailId) {
  try {
    const r = await window.api.mailAttachMeta(mailId);
    if (!r || !r.ok) { box.querySelector('.rp-att-loading').textContent = '첨부 목록을 읽지 못했습니다: ' + ((r && r.error) || ''); return; }
    const real = (r.items || []).filter(a => !a.inline);
    const inline = (r.items || []).filter(a => a.inline);
    if (!real.length) {
      box.querySelector('.rp-att-loading').textContent = r.unavailable
        ? '첨부 목록은 Outlook 연동(실시간) 모드에서 확인할 수 있습니다.'
        : '이 메일의 첨부는 본문 이미지뿐입니다.';
      return;
    }
    setAttachPreviewList(mailId, real);
    const li = (a, i) => attachItemHtml(a, i);
    box.innerHTML = `<b>첨부파일 (${real.length})</b>
      <ul>${real.map((a, i) => li(a, i)).join('')}</ul>
      ${r.saved ? '' : `<div class="rp-att-note">아직 로컬에 저장되지 않은 첨부입니다.
        <button class="btn-primary btn-sm" id="rp-att-fetch">가져오기</button></div>`}
      ${inline.length ? `<div class="rp-att-note">본문 이미지 ${inline.length}개는 목록에서 제외했습니다.</div>` : ''}`;
    bindAttachOpenButtons(box);
    bindAttachPreviewClicks(box);
    const fetchBtn = box.querySelector('#rp-att-fetch');
    if (fetchBtn) fetchBtn.addEventListener('click', async () => {
      fetchBtn.disabled = true; fetchBtn.textContent = '가져오는 중...';
      const f = await window.api.mailAttachFetch(mailId);
      if (!f.ok) { fetchBtn.disabled = false; fetchBtn.textContent = '가져오기'; alert('첨부 가져오기 실패: ' + f.error); return; }
      setAttachPreviewList(mailId, f.items);
      box.innerHTML = `<b>첨부파일 (${f.items.length})</b><ul>${f.items.map((a, i) => li(a, i)).join('')}</ul>
        <div class="rp-att-note">로컬에 저장했습니다.</div>`;
      bindAttachOpenButtons(box);
      bindAttachPreviewClicks(box);
    });
  } catch (e) {
    const l = box.querySelector('.rp-att-loading');
    if (l) l.textContent = '첨부 목록 오류: ' + String(e);
  }
}

//  [열기]/[폴더] 버튼 바인딩 (읽기창 첨부 공용)
function bindAttachOpenButtons(root) {
  root.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => window.api.openPath(b.dataset.open)));
  root.querySelectorAll('[data-folder]').forEach(b => b.addEventListener('click', () => window.api.showItem(b.dataset.folder)));
}

function renderReadingPane(mail, atts, analyses, inlineAtts) {
  const emptyEl = $(rpTargets.empty);
  if (emptyEl) emptyEl.classList.add('hidden');
  const rp = $(rpTargets.content);
  rp.classList.remove('hidden');
  const langNames = { ko: '한국어', en: '영어', zh: '중국어', ja: '일본어', unknown: '기타' };
  // folder 는 로케일 독립 정규 키(Inbox/Sent)로 저장됨 → 표시용 한글 라벨로 변환
  const folderLabels = { Inbox: '받은 편지함', Sent: '보낸 편지함', Drafts: '임시 보관함', Deleted: '지운 편지함', Outbox: '보낼 편지함', Junk: '정크 메일' };
  const folderLabel = folderLabels[mail.folder] || mail.folder || '';

  let html = `
    <div class="rp-subject">${escapeHtml(mail.subject || '(제목 없음)')}</div>
    <div class="rp-from">
      <div class="rp-from-av" style="background:${avatarColor(mail.sender_name || mail.sender_email)}">${escapeHtml(initials(mail.sender_name || mail.sender_email))}</div>
      <div>
        <div class="rp-from-name">${escapeHtml(mail.sender_name || '')}</div>
        <div class="rp-from-mail">${escapeHtml(mail.sender_email || '')}</div>
      </div>
    </div>
    <div class="rp-meta">받는사람: ${escapeHtml(mail.recipients || '')}</div>
    ${mail.cc ? `<div class="rp-meta">참조: ${escapeHtml(mail.cc)}</div>` : ''}
    <div class="rp-meta">${escapeHtml(mail.received_at || '')} · ${langNames[mail.lang] || mail.lang} · ${escapeHtml(folderLabel)}</div>`;

  // ★ 첨부 = '진짜 첨부'만 기본 표시.
  //   서명 로고·본문에 박힌 그림(cid 인라인)은 아래 접힘 목록으로 분리한다.
  //   (숨기기만 하면 정작 필요할 때 못 찾으므로 펼쳐서 열 수 있게 남긴다)
  //  파일명을 누르면 외부 프로그램이 아니라 옆 미리보기 패널에서 연다
  setAttachPreviewList(mail.id, (atts || []).map(a => ({
    name: a.file_name, sizeKB: a.size_kb, savedPath: a.saved_path || '', inline: false
  })));
  const attLi = (a, i) => attachItemHtml({ name: a.file_name, sizeKB: a.size_kb, savedPath: a.saved_path || '' }, i);
  //  ★ 회귀 수정(2026-08-20): DB 에 첨부 행이 없어도(동기화 때 미저장) 클립 아이콘이
  //    뜨는 메일은 목록을 반드시 보여준다. 자리를 먼저 만들고 Outlook 속성으로 채운다.
  const expectedAtt = Number(mail.real_attach_count != null ? mail.real_attach_count : mail.attach_count) || 0;
  if (atts && atts.length) {
    html += `<div class="rp-atts"><b>첨부파일 (${atts.length})</b><ul>` +
      atts.map(attLi).join('') + `</ul></div>`;
  } else if (expectedAtt > 0) {
    html += `<div class="rp-atts" id="rp-atts-lazy" data-mid="${mail.id}">
      <b>첨부파일 (${expectedAtt})</b>
      <div class="rp-att-loading">목록을 불러오는 중...</div></div>`;
  }
  if (inlineAtts && inlineAtts.length) {
    html += `<div class="rp-inline-atts">
      <button class="rp-inline-toggle" id="rp-inline-toggle" type="button" aria-expanded="false">
        <span class="rp-inline-caret">▸</span> 본문 이미지 ${inlineAtts.length}개 (서명 로고·본문 삽입 그림)
      </button>
      <ul class="rp-inline-list hidden" id="rp-inline-list">${inlineAtts.map(a =>
        `<li>${escapeHtml(a.file_name)} <span style="color:var(--muted)">(${a.size_kb}KB)</span></li>`).join('')}</ul>
    </div>`;
  }

  html += `<div class="rp-actions">
    <button class="btn-primary" id="rp-translate-btn">${icon('search', 13)}<span>번역/분석</span></button>
    <button class="btn-primary" id="rp-reply-btn" title="AI가 답장 초안을 만들어 줍니다">${icon('reply', 13)}<span>AI 작성 도움</span></button>
    <button id="rp-ask-btn">${icon('mailSearch', 13)}<span>이 메일로 질문</span></button>
    <button id="rp-ask-clear" class="link-btn" title="이 메일의 저장된 대화 이력을 지웁니다">대화 초기화</button>
    <span class="rp-divider"></span>
    <button id="rp-outlook-reply" title="Outlook 답장 창 열기">${icon('reply', 13)}<span>답장</span></button>
    <button id="rp-outlook-replyall" title="Outlook 전체 답장 창 열기">${icon('group', 13)}<span>전체 답장</span></button>
    <button id="rp-outlook-forward" title="Outlook 전달 창 열기">${icon('chevron', 13)}<span>전달</span></button>
    <button id="rp-bigmail" title="대용량 파일을 올려 다운로드 링크를 지금 열려 있는 메일 본문에 넣습니다">${icon('clip', 13)}<span>대용량 첨부</span></button>
    <span class="rp-divider"></span>
    <span class="rp-as-group" role="group" aria-label="내 처리 상태">
      <span class="rp-as-label">내 처리:</span>${actionBadge(mail)}
      ${AS_KEYS.map((k, i) => `<button class="rp-as-btn ${AS_META[k].cls}${mail.action_state === k ? ' active' : ''}" data-asset="${k}" title="${AS_META[k].label} (단축키 ${i + 1}) — 다시 누르면 해제">${AS_META[k].label}</button>`).join('')}
      <button class="rp-as-btn rp-as-clear" data-asset="" title="상태 해제 (단축키 0)">해제</button>
      <button class="rp-as-btn rp-as-undo" id="rp-as-undo" title="직전 상태로 되돌리기 (Ctrl+Z)">되돌리기</button>
    </span>
    <span class="rp-as-suggest" id="rp-as-suggest"></span>
    <input id="rp-reply-instruction" type="text" class="rp-instr" placeholder="답장 지시사항(선택): 예) 일정 다음 주로 조정 요청" />
  </div>`;

  html += `<div class="rp-body">${linkifyText((mail.body || '').slice(0, 12000))}</div>`;

  // ★ 읽기창 세로 2분할: 좌측 본문 / 우측 AI 분석 패널(기본 표시)
  //   AI 결과를 본문에 끼워 넣으면 긴 메일에서 화면 밖으로 밀려 "반응 없음"처럼 보인다.
  //   → 결과는 항상 우측 패널에 렌더한다.
  rp.innerHTML = `
    <div class="rp-left" id="rp-left">${html}</div>
    <div class="rp-resizer" id="rp-resizer" title="드래그하여 너비 조절"></div>
    <div class="rp-right" id="rp-right">
      <div class="rp-panel-head">
        <span>AI 분석</span>
        <button id="rp-panel-collapse" class="link-btn" title="분석 패널 접기">접기</button>
      </div>
      <div id="rp-ai-result" class="rp-ai-result">
        <div class="rp-panel-hint">위의 <b>번역/분석</b>·<b>AI 작성 도움</b> 버튼을 누르면 결과가 여기에 표시됩니다.</div>
      </div>
    </div>`;
  // 🔴 읽기창은 메일/보낸메일/회신대기/검색 네 곳에 같은 id 로 렌더된다.
  //   document.querySelector 로 바인딩하면 항상 '문서의 첫 번째'(= 메일 패널)에만 핸들러가 붙어
  //   보낸메일 읽기창의 [번역/분석]·[AI 작성 도움]이 무반응이었다(실측 결함).
  //   → 모든 조회를 현재 패널(rp) 안으로 한정한다.
  const $rp = (sel) => rp.querySelector(sel);
  const leftEl = $rp('#rp-left');
  if (leftEl) leftEl.scrollTop = 0;
  applyRpSplit();
  bindRpResizer();
  const collapseBtn = $rp('#rp-panel-collapse');
  if (collapseBtn) collapseBtn.addEventListener('click', toggleRpPanel);
  setRsSub('read', (mail.subject || '(제목 없음)').slice(0, 40));
  chatScope = 'mail'; updateGchatCtx();      // 메일을 열면 대화 대상도 그 메일로
  //  좁은 창에서는 목록 대신 본문을 보여 준다(단일 열 폴백)
  const splitEl = document.querySelector('#view-mail.mail-split');
  if (splitEl && window.innerWidth <= 900) splitEl.classList.add('show-right');
  bindAttachPreviewClicks(rp);          // 첨부 파일명 → 미리보기
  //  저장 전 첨부 목록을 Outlook 에서 읽어와 채운다(파일은 아직 만들지 않는다)
  const lazyBox = $rp('#rp-atts-lazy');
  if (lazyBox) loadLazyAttachments(lazyBox, parseInt(lazyBox.dataset.mid, 10));

  const inlineToggle = $rp('#rp-inline-toggle');
  if (inlineToggle) inlineToggle.addEventListener('click', () => {
    const list = $rp('#rp-inline-list');
    const open = list.classList.toggle('hidden') === false;
    inlineToggle.setAttribute('aria-expanded', String(open));
    inlineToggle.querySelector('.rp-inline-caret').textContent = open ? '▾' : '▸';
  });

  rp.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => window.api.openPath(b.dataset.open)));
  rp.querySelectorAll('[data-folder]').forEach(b => b.addEventListener('click', () => window.api.showItem(b.dataset.folder)));
  const on = (sel, fn) => { const el = $rp(sel); if (el) el.addEventListener('click', fn); };
  on('#rp-translate-btn', rpTranslate);
  on('#rp-reply-btn', rpDraftReply);
  on('#rp-outlook-reply', () => composeReply('reply'));
  on('#rp-outlook-replyall', () => composeReply('replyAll'));
  on('#rp-outlook-forward', () => composeReply('forward'));
  on('#rp-bigmail', openBigmailDialog);
  // 내 처리 상태 4버튼 + 해제 + 되돌리기 (현재 패널 안에서만 바인딩)
  rp.querySelectorAll('[data-asset]').forEach(btn => btn.addEventListener('click', async () => {
    const want = btn.dataset.asset || null;
    const now = selectedMail && selectedMail.action_state ? selectedMail.action_state : null;
    const next = (want && want === now) ? null : want;     // 같은 걸 다시 누르면 해제
    if (selectedMail) selectedMail.action_state = next;
    rp.querySelectorAll('[data-asset]').forEach(x => x.classList.toggle('active', !!next && x.dataset.asset === next));
    await setActionFor([mail.id], next);
  }));
  const undoBtn = $rp('#rp-as-undo');
  if (undoBtn) undoBtn.addEventListener('click', () => undoActionFor([mail.id]));
  // 자동 제안 — 아직 수동 지정이 없을 때만 '추천'을 보여 준다(저장하지 않음)
  if (!mail.action_state) {
    window.api.actionSuggest([mail.id]).then(r => {
      const sg = r && r.ok ? (r.suggestions || {})[mail.id] : null;
      const box = $rp('#rp-as-suggest');
      if (!sg || !box) return;
      actionSuggestCache[mail.id] = sg;
      box.innerHTML = `${escapeHtml(sg.text)} <button class="link-btn" id="rp-as-apply">이대로 지정</button>`;
      const ap = box.querySelector('#rp-as-apply');
      if (ap) ap.addEventListener('click', () => setActionFor([mail.id], sg.state));
    }).catch(() => {});
  }
  on('#rp-ask-btn', async () => {
    // ★ 마스터 지시: "각 메일 안에서 '대화하기'" — 기존 gchat 패널(같은 chatCtx·연속대화 경로)을 그대로 쓴다.
    //   서버(ai:chatMails focus 분기)가 이 메일 본문·첨부·스레드 맥락을 이미 채워 넣으므로
    //   여기서 원문을 다시 밀어넣지 않는다(중복·토큰낭비 방지).
    chatScope = 'mail'; updateGchatCtx();
    openGlobalChat(true);
    let resumed = false;
    try {
      const h = await window.api.chatHistory(mail.id);
      if (h.ok && h.turns && h.turns.length) {
        const log = $('#chat-log');
        if (log) log.innerHTML = '';
        chatHistory = h.turns.map(t => ({ role: t.role, content: t.content }));
        h.turns.forEach(t => addMessage(t.role, t.role === 'assistant' ? formatAnswer(t.content) : escapeHtml(t.content)));
        addMessage('assistant', `이전 대화 ${h.turns.length}턴을 이어봅니다. 계속 질문하세요.`);
        resumed = true;
      }
    } catch (_) { /* 이력 복구 실패해도 새 대화는 가능 */ }
    if (!resumed) {
      addMessage('assistant', `"<b>${escapeHtml(mail.subject || '')}</b>" 메일 내용을 기반으로 대화합니다. 무엇이든 물어보세요.`);
    }
    const gi = $('#chat-input');
    if (gi) gi.focus();
  });
  on('#rp-ask-clear', async () => {
    try { await window.api.chatHistoryClear(mail.id); } catch (_) {}
    chatHistory = [];
    const log = $('#chat-log');
    if (log) log.innerHTML = '';
    addMessage('assistant', `"<b>${escapeHtml(mail.subject || '')}</b>" 메일의 대화 이력을 지웠습니다.`);
  });

  // 한국어 메일 판정 (번역 표시 차단용) — 저장 기록/새 분석 모두에 적용
  const mailIsKorean = isKoreanMailClient(mail);

  // 저장된 분석 기록이 있으면 메일을 열자마자 우측 패널에 자동 표시
  if (analyses && analyses.length) {
    //  메일 뷰는 rpq('#rp-ai-result')가 아니라 aiBoxEl()이 돌려주는 우측 AI 칸이 실제로 보이는 곳이다
    //  (그대로 쓰면 저장된 분석이 화면에 없는 숨은 박스에 그려진다 — 동일 패턴 회귀).
    const box = aiBoxEl();
    if (!box) return;
    const kindName = { translate: '번역/분석', reply: '답장초안', summary: '요약' };
    box.innerHTML = `<div class="prev-analyses"><b>이전 분석 기록</b>` +
      analyses.slice(0, 3).map((a, i) => `<details${i === 0 ? ' open' : ''}><summary>${kindName[a.kind] || a.kind} (${a.created_at})</summary>${renderStoredAnalysis(a.content, mailIsKorean)}</details>`).join('') +
      `</div>`;
  } else if (config.autoAnalyzeOnOpen === true) {
    // 설정에서 켠 경우에만 자동 분석 (기본 OFF — 토큰 소모)
    rpTranslate();
  }
}

// ------------------------------------------------------------
//  읽기창 분할 제어 (비율 유지 / 접기 / 드래그 리사이저 / 좁은 창 폴백)
// ------------------------------------------------------------
let rpSplitRatio = 60;        // 좌측(본문) 비율 %
let rpPanelCollapsed = false;

function applyRpSplit() {
  const left = rpq('#rp-left'), right = rpq('#rp-right'), rz = rpq('#rp-resizer');
  if (!left || !right) return;
  const narrow = window.innerWidth < 1100;      // 좁으면 상하 분할로 폴백
  const contEl = $(rpTargets.content);
  if (contEl) contEl.classList.toggle('rp-stacked', narrow);
  if (rpPanelCollapsed) {
    right.classList.add('hidden'); if (rz) rz.classList.add('hidden');
    left.style.flex = '1 1 100%';
    return;
  }
  right.classList.remove('hidden'); if (rz) rz.classList.remove('hidden');
  if (narrow) { left.style.flex = '1 1 auto'; right.style.flex = '1 1 auto'; }
  else { left.style.flex = `0 0 ${rpSplitRatio}%`; right.style.flex = '1 1 0'; }
}

function toggleRpPanel() {
  rpPanelCollapsed = !rpPanelCollapsed;
  const btn = rpq('#rp-panel-collapse');
  if (btn) btn.textContent = rpPanelCollapsed ? '펼치기' : '접기';
  applyRpSplit();
}

function bindRpResizer() {
  const rz = rpq('#rp-resizer');
  const cont = $(rpTargets.content);
  if (!rz || !cont) return;
  let dragging = false;
  rz.addEventListener('mousedown', (e) => { dragging = true; e.preventDefault(); document.body.style.cursor = 'col-resize'; });
  const onMove = (e) => {
    if (!dragging || window.innerWidth < 1100) return;
    const r = cont.getBoundingClientRect();
    const pct = ((e.clientX - r.left) / r.width) * 100;
    rpSplitRatio = Math.min(80, Math.max(25, pct));   // 25~80% 제한: 한쪽이 사라지는 사고 방지
    applyRpSplit();
  };
  const onUp = () => { if (dragging) { dragging = false; document.body.style.cursor = ''; } };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

window.addEventListener('resize', () => { if (rpq('#rp-left')) applyRpSplit(); });

// 🔴 AI 결과가 실제로 그려지는 컨테이너를 찾는 단일 지점.
//   메일 뷰는 우측 스택의 별도 셀(rpTargets.ai)에 그리고, 나머지 뷰는 읽기창 안(#rp-ai-result)에 그린다.
//   rpq()는 rpTargets.content(본문영역)만 보므로 이 박스 안에 그린 요소(#copy-reply 등)는 못 찾는다
//   — 반드시 이 헬퍼(aiq) 또는 revealAiBox()가 돌려준 box.querySelector 로 조회한다.
//   (회귀: 답장 초안 버튼 addEventListener null, renderer.js:6267 등, 2026-09-28)
function aiBoxEl() {
  if (rpTargets.ai) {
    const cell = document.querySelector(rpTargets.ai);
    if (cell) return cell;
  }
  return rpq('#rp-ai-result');
}

// box 파라미터가 없는 호출부(버전 라벨 갱신 등)에서 AI 박스 안 요소를 조회할 때 쓴다.
function aiq(sel) {
  const box = aiBoxEl();
  return box ? box.querySelector(sel) : null;
}

// AI 결과 영역을 사용자가 보고 있는 위치로 끌어온다 (반응 없음처럼 보이는 것 방지)
// 결과는 우측 분석 패널에 렌더되므로, 패널이 접혀 있으면 먼저 펼친다.
function revealAiBox() {
  const box = aiBoxEl();
  if (!box) return null;
  //  메일 뷰: 우측 스택의 'AI 분석' 셀(접혀 있으면 펼친다)
  if (rpTargets.ai && box === document.querySelector(rpTargets.ai)) {
    const sec = box.closest('.rs-sec');
    if (sec && sec.classList.contains('collapsed')) toggleRsSection('ai', false);
    box.scrollTop = 0;
    return box;
  }
  if (rpPanelCollapsed) toggleRpPanel();
  const right = rpq('#rp-right');
  if (right) right.scrollTop = 0;
  try { box.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (_) {}
  return box;
}

// 메일 미선택 시 조용히 무시하지 않고 사용자에게 알린다
function requireSelectedMail() {
  if (!selectedMail) { alert('먼저 왼쪽 목록에서 메일을 선택하세요.'); return false; }
  return true;
}

// ------------------------------------------------------------
//  분석 결과 구조화 렌더링 (번역/요약/액션/핵심정보/답장참고)
//  한국어 메일은 번역 섹션을 아예 그리지 않는다.
// ------------------------------------------------------------
// ------------------------------------------------------------
//  한국어 메일 판정 (analyzer.js 와 동일 규칙 — 렌더 단계 이중 방어)
//  ★ 서버 판정이 틀려 번역이 와도, 한국어 메일이면 화면에 표시하지 않는다.
// ------------------------------------------------------------
function stripQuotedClient(text) {
  const s = String(text || '');
  const markers = [
    /-{2,}\s*(?:Original Message|원본 메시지|이전 메시지|아래 원문)\s*-{2,}/i,
    /_{10,}/,
    /^\s*(?:From|Sent|To|Subject)\s*:\s.+$/m,
    /^\s*(?:보낸 사람|보낸사람|보낸 날짜|받는 사람|받는사람|제목)\s*:\s.+$/m,
    /^\s*>{1,}\s?\S/m,
    /^\s*On .{5,60}\bwrote:\s*$/m,
    /-{2,}\s*(?:回复的原邮件|原始邮件|轉寄郵件|元のメッセージ)\s*-{2,}/,
    /^\s*(?:发件人|發件人|差出人|送信者)\s*[:：]\s*\S/m
  ];
  let cut = s.length;
  for (const re of markers) {
    const m = s.match(re);
    if (m && typeof m.index === 'number' && m.index > 0 && m.index < cut) cut = m.index;
  }
  return s.slice(0, cut);
}
// ★ src/analyzer.js 의 langScore()/looksKorean() 과 반드시 같은 규칙이어야 한다.
//   (렌더러는 require 를 쓸 수 없어 불가피하게 복제 — 한쪽만 고치면 화면과 AI 판정이 어긋난다)
const KO_ENDINGS_CLIENT = /(습니다|입니다|합니다|십니다|드립니다|하세요|주세요|바랍니다|였습|겠습|니까|드림|올림)/g;
function isKoreanMailClient(mail) {
  if (!mail) return false;
  const bodyRaw = String(mail.body || mail.preview || '');
  if (!bodyRaw.trim()) return String(mail.lang || '') === 'ko';
  const full = bodyRaw.slice(0, 20000);
  const head = stripQuotedClient(full);
  const letters = (head.match(/[가-힣A-Za-z]/g) || []).length;
  const target = letters >= 5 ? head : full;
  const hangul = (target.match(/[가-힣]/g) || []).length;
  const latin = (target.match(/[A-Za-z]/g) || []).length;
  const koEnd = (target.match(KO_ENDINGS_CLIENT) || []).length;
  if (hangul === 0) return false;
  if (latin === 0) return true;
  if (koEnd >= 2) return true;
  if (koEnd >= 1 && hangul >= 15) return true;
  return hangul * 3 >= latin;
}

// 구포맷(마크다운) 분석 기록에서 번역 섹션 제거
//  ★ 구버전 제목에는 이모지가 붙어 있다("## 📝 전문 번역 (한국어)").
//    제목 줄에 '번역'이 들어가면 그 섹션 전체를 다음 제목 앞까지 잘라낸다.
function stripTranslationSection(text) {
  const s = String(text || '');
  return s
    .replace(/^#{1,6}[^\n]*번역[^\n]*\n[\s\S]*?(?=^#{1,6}[^\n]*$|\s*$)/gmi, '')
    .replace(/^#{1,6}[^\n]*원문\s*언어[^\n]*\n(?:[^\n#]*\n)*/gmi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
// 제거 후에도 번역 흔적이 남았는지 (남으면 본문을 감춘다)
function hasTranslationTrace(text) {
  return /^#{1,6}[^\n]*번역/mi.test(String(text || ''));
}

function renderAnalysisCard(a, forceHideTranslation = false) {
  if (forceHideTranslation) a = { ...a, translated: '', translationSkipped: true };
  const sec = (title, iconName, inner, extraCls = '') => inner
    ? `<section class="an-sec ${extraCls}"><h4 class="an-title">${icon(iconName, 14)}<span>${escapeHtml(title)}</span></h4>${inner}</section>`
    : '';
  const langLabel = { ko: '한국어', en: '영어', zh: '중국어', ja: '일본어' }[a.lang] || a.lang || '알 수 없음';

  const head = `<div class="an-head">
      <span class="an-lang">원문 ${escapeHtml(langLabel)}</span>
      ${a.translationSkipped ? '<span class="an-skip">한국어 메일이라 번역은 생략했습니다</span>' : ''}
    </div>`;

  const translated = (!a.translationSkipped && a.translated)
    ? sec('한국어 번역', 'mailSearch', `<div class="an-translated">${escapeHtml(a.translated)}</div>`)
    : '';

  const summary = a.summary.length
    ? sec('핵심 요약', 'check', `<ul class="an-list">${a.summary.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ul>`)
    : '';

  const actions = a.actions.length
    ? sec('할 일 · 기한', 'flag', `<ul class="an-actions">${a.actions.map(t => `
        <li><span class="an-task">${escapeHtml(t.task)}</span>
          ${t.owner ? `<span class="an-chip">${escapeHtml(t.owner)}</span>` : ''}
          ${t.due ? `<span class="an-chip an-due">${icon('clock', 11)}${escapeHtml(t.due)}</span>` : ''}</li>`).join('')}</ul>`, 'an-actions-sec')
    : '';

  const facts = a.keyFacts.length
    ? sec('핵심 정보', 'chart', `<table class="an-facts">${a.keyFacts.map(k => `
        <tr><th>${escapeHtml(k.label || '-')}</th><td>${escapeHtml(k.value)}</td></tr>`).join('')}</table>`)
    : '';

  const tips = a.replyTips.length
    ? sec('답장 참고', 'reply', `<ul class="an-list">${a.replyTips.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ul>`)
    : '';

  const body = translated + summary + actions + facts + tips;
  return `<div class="analysis-card">${head}${body || '<div class="empty-sm">추출된 항목이 없습니다.</div>'}</div>`;
}

// 저장된 분석(문자열)이 구조화 JSON 이면 카드로, 아니면 기존 텍스트로 렌더
function renderStoredAnalysis(content, isKo = false) {
  try {
    const o = JSON.parse(content);
    if (o && typeof o === 'object' && (o.summary || o.translated !== undefined)) {
      // 저장 당시 판정이 틀려 번역이 들어 있어도, 한국어 메일이면 표시하지 않는다
      const hadTranslation = isKo && String(o.translated || '').trim().length > 0;
      const card = renderAnalysisCard({
        lang: o.lang || 'unknown', translationSkipped: !!o.translationSkipped,
        translated: o.translated || '', summary: o.summary || [], actions: o.actions || [],
        keyFacts: o.keyFacts || [], replyTips: o.replyTips || []
      }, isKo);
      return hadTranslation
        ? `<div class="an-legacy">이전 분석에 포함돼 있던 번역은 한국어 메일이라 숨겼습니다.</div>${card}`
        : card;
    }
  } catch (_) {}
  // 구포맷(마크다운) — 한국어 메일이면 번역 섹션을 잘라내고 안내를 붙인다
  if (isKo) {
    const cleaned = stripTranslationSection(content);
    const changed = cleaned.length !== String(content || '').trim().length;
    // 잘라내도 번역 흔적이 남으면(예상 못한 구버전 포맷) 본문 자체를 감춘다 — 노출 0 보장
    if (hasTranslationTrace(cleaned)) {
      return `<div class="an-legacy">구버전 분석 기록이라 번역이 섞여 있습니다. 한국어 메일이므로 표시하지 않습니다 —
        <b>번역/분석</b>을 다시 누르면 번역 없는 최신 형식으로 정리됩니다.</div>`;
    }
    return `${changed ? '<div class="an-legacy">구버전 분석 기록입니다. 한국어 메일이라 번역 부분은 숨겼습니다 — 정확한 결과는 <b>번역/분석</b>을 다시 눌러 주세요.</div>' : ''}<div class="briefing-body">${formatAnswer(cleaned || content)}</div>`;
  }
  return `<div class="briefing-body">${formatAnswer(content)}</div>`;
}

async function rpTranslate() {
  if (!requireSelectedMail() || needKey()) return;
  const box = revealAiBox();
  if (!box) return;
  box.innerHTML = '<div class="empty">번역/분석 중...</div>';
  showLoading('번역/분석 중...');
  try {
    const res = await window.api.aiTranslate(selectedMail.id);
    if (res.ok && res.structured) analysisState = { mailId: selectedMail.id, current: res.structured, history: [res.structured] };
    setRsSub('ai', res.ok ? '번역/분석 결과' : '분석 실패');
    //  AI 가 준 구조가 예상과 달라도 화면이 깨지지 않게 감싼다(형식 편차 방어)
    box.innerHTML = res.ok ? safeAnalysisHtml(res) : aiErrorHtml(res);
    if (!res.ok) noteAiResult(res);
    if (res.ok && res.structured) appendAnalysisChatBar(box);   // 렌더가 폴백돼도 대화는 이어갈 수 있다
    bindAiErrorActions(box);
    bindCrossValidationToggle(box);
  } catch (err) {
    box.innerHTML = `<div class="empty">번역/분석 오류: ${escapeHtml(String(err))}</div>`;
  } finally {
    hideLoading();
    revealAiBox();
  }
}

//  분석 결과 HTML — 구조가 어긋나면 텍스트로 폴백한다
function safeAnalysisHtml(res) {
  const badge = crossValidationBadge(res.crossValidation) + promptReducedBadge(res.promptReduced) + attachmentChipsHtml(res.attachmentChips);
  if (res.structured) {
    try { return badge + renderAnalysisCard(res.structured, isKoreanMailClient(selectedMail || {})); }
    catch (e) { console.warn('분석 카드 렌더 실패 → 텍스트로 표시', e); }
  }
  const t = res.content || (res.structured ? JSON.stringify(res.structured, null, 2) : '');
  return badge + `<div class="briefing-body">${formatAnswer(isKoreanMailClient(selectedMail || {}) ? stripTranslationSection(t) : t)}</div>`;
}

// ============================================================
//  교차 검증 배지 — 마스터 지시(분석 신뢰도): 등록된 제공자 2경로로 병렬 호출한 결과를
//  핵심 필드만 대조해 "N/N 일치" 또는 "확인 필요"로 보여준다. 실패 시 조용히 넘어가지
//  않고 배지로 알린다(단일 결과로는 정상 폴백).
// ============================================================
//  ★ 임무1(마스터 지시): 프롬프트가 토큰 상한을 넘어 자동 축소됐을 때 조용히 넘어가지 않고 알린다.
function promptReducedBadge(reduced) {
  if (!reduced) return '';
  return `<div class="cv-badge cv-warn">${icon('flag', 12)} 입력이 커서 축소 분석함(스레드/본문 일부만 사용)</div>`;
}

function crossValidationBadge(cv) {
  if (!cv || !cv.enabled) return '';
  if (cv.failed) {
    return `<div class="cv-badge cv-warn">${icon('flag', 12)} 교차검증 실패 — 단일 결과로 표시${cv.reason ? ' · ' + escapeHtml(cv.reason) : ''}</div>`;
  }
  if (cv.match) {
    return `<div class="cv-badge cv-ok">${icon('check', 12)} 교차검증 ${escapeHtml(cv.votes || '2/2')} 일치${cv.tokensUsed ? ` · 검증용 토큰 +${cv.tokensUsed}` : ''}</div>`;
  }
  const diffRows = (cv.diffs || []).map(d => `<div class="cv-diff"><b>${escapeHtml(d.field)}</b>: A=${escapeHtml(d.a)} / B=${escapeHtml(d.b)}</div>`).join('');
  return `<div class="cv-badge cv-warn">${icon('flag', 12)} 확인 필요 — 두 결과가 달랐습니다(${escapeHtml(cv.votes || '')})
    <button type="button" class="link-btn cv-toggle">차이 보기</button>
    <div class="cv-diffs hidden">${diffRows}</div></div>`;
}

// ============================================================
//  「반영한 첨부」 칩 — 마스터 지시(첨부 분석 1단계): 분석·대화가 어떤 첨부 내용을
//  얼마나 반영했는지(또는 왜 못 했는지) 조용히 삼키지 않고 보여준다.
//  ok=true: 반영됨(초록) / ok=false: 실패·미지원(회색, 사유 노출) / ok=null: 이미지(2단계 대상, 회색)
// ============================================================
function attachmentChipsHtml(chips) {
  if (!chips || !chips.length) return '';
  const items = chips.map(c => {
    const cls = c.ok === true ? 'ac-chip ac-ok' : 'ac-chip ac-skip';
    return `<span class="${cls}">${icon('clip', 11)}${escapeHtml(c.name)}<i>${escapeHtml(c.note || '')}</i></span>`;
  }).join('');
  return `<div class="ac-chips">${items}</div>`;
}

function bindCrossValidationToggle(root) {
  if (!root) return;
  root.querySelectorAll('.cv-toggle').forEach(btn => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      const box = btn.nextElementSibling;
      if (box) box.classList.toggle('hidden');
    });
  });
}

// ============================================================
//  분석·초안을 '대화로' 다듬기 (마스터 핵심 요구 2026-08-20)
//  ------------------------------------------------------------
//  일회성 출력으로 끝내지 않는다. 결과 아래 입력줄에 지시를 쓰면
//  같은 카드가 그 자리에서 갱신되고, 이전 버전으로 되돌릴 수 있다.
//  백엔드는 기존 analyzer(translateAnalyze/draftReply)를 그대로 쓴다(중복 구현 0).
// ============================================================
let analysisState = null;   // { mailId, current, history[] }
let draftState = null;      // { mailId, current, history[] }

// ============================================================
//  다듬기 액션바 — [더 짧게][더 자세히][정중하게][강하게][영어로/한국어로][되돌리기]
//  ------------------------------------------------------------
//  클릭 시 기존 iter-bar 입력창에 정형 지시문을 채워 넣고 그대로 refineAnalysis/
//  refineDraft 를 호출한다(신규 백엔드 경로 0 — 마스터 지시: 중복 구현 금지).
//  언어 토글은 현재 표시 텍스트에 한글이 있으면 '영어로', 없으면 '한국어로'.
// ============================================================
function hasHangul(s) { return /[가-힣]/.test(String(s || '')); }

function actionBarPresets(currentText) {
  const toEn = hasHangul(currentText);
  return [
    { act: 'shorter', label: '더 짧게', instr: '더 짧고 간결하게 요약해서 다시 써줘' },
    { act: 'longer', label: '더 자세히', instr: '더 자세하고 구체적으로 보강해서 다시 써줘' },
    { act: 'polite', label: '정중하게', instr: '더 정중하고 격식 있는 어조로 다시 써줘' },
    { act: 'strong', label: '강하게', instr: '더 강하고 단호한 어조로 다시 써줘' },
    { act: 'lang', label: toEn ? '영어로' : '한국어로', instr: toEn ? '영어로 번역해서 다시 써줘' : '한국어로 번역해서 다시 써줘' }
  ];
}

//  disabled=true 로 처리 중 상태 표시(중복 클릭 방지). run(instr) 은 호출부가 넘긴다.
function renderActionBar(currentText, onRun, onUndo) {
  const wrap = document.createElement('div');
  wrap.className = 'act-bar';
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', '결과 다듬기');
  const presets = actionBarPresets(currentText);
  wrap.innerHTML = presets.map(p => `<button type="button" class="act-btn" data-act="${p.act}">${escapeHtml(p.label)}</button>`).join('')
    + `<button type="button" class="act-btn act-undo" data-act="undo" title="직전 버전으로 되돌립니다">되돌리기</button>
       <span class="act-spinner hidden" id="act-spinner-${Date.now()}"></span>`;
  const spinner = wrap.querySelector('.act-spinner');
  const setBusy = (b) => {
    wrap.querySelectorAll('.act-btn').forEach(btn => { btn.disabled = b; });
    spinner.classList.toggle('hidden', !b);
  };
  wrap.querySelectorAll('.act-btn:not(.act-undo)').forEach((btn, i) => {
    btn.addEventListener('click', async () => {
      if (wrap.dataset.busy === '1') return;    // 중복 클릭 방지
      wrap.dataset.busy = '1'; setBusy(true);
      try { await onRun(presets[i].instr); }
      finally { wrap.dataset.busy = '0'; setBusy(false); }
    });
  });
  wrap.querySelector('.act-undo').addEventListener('click', () => {
    if (wrap.dataset.busy === '1') return;
    onUndo();
  });
  return wrap;
}

//  분석 카드 하단 입력줄
function appendAnalysisChatBar(box) {
  const bar = document.createElement('div');
  bar.className = 'iter-bar';
  bar.innerHTML = `
    <input class="iter-input" id="iter-analysis-input" type="text"
      placeholder="이 분석을 고쳐 말해 보세요 — 예: 핵심 정보에 선급 승인 일자 추가 / 할 일 3번 빼줘" />
    <button class="btn-primary btn-sm" id="iter-analysis-go">수정</button>
    <button id="iter-analysis-chat" title="이 분석 내용을 맥락으로 대화창을 엽니다">대화로 이어가기</button>
    <button id="iter-analysis-undo" class="link-btn" title="직전 버전으로 되돌립니다">원래대로</button>
    <span class="iter-ver" id="iter-analysis-ver"></span>`;
  const curText = analysisState ? JSON.stringify(analysisState.current) : '';
  const actBar = renderActionBar(curText,
    (instr) => refineAnalysis(box, instr),
    () => undoAnalysis(box));
  box.appendChild(actBar);
  box.appendChild(bar);
  updateIterVersionLabel();
  const run = () => refineAnalysis(box);
  bar.querySelector('#iter-analysis-go').addEventListener('click', run);
  bar.querySelector('#iter-analysis-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); run(); }
  });
  bar.querySelector('#iter-analysis-chat').addEventListener('click', () => openChatWithAnalysis());
  bar.querySelector('#iter-analysis-undo').addEventListener('click', () => undoAnalysis(box));
}

function updateIterVersionLabel() {
  //  #iter-analysis-ver/#iter-draft-ver 는 AI 박스 안에 그려진다 → rpq 대신 aiq(동일 패턴 회귀 방지).
  const el = aiq('#iter-analysis-ver');
  if (el && analysisState) el.textContent = `버전 ${analysisState.history.length}`;
  const d = aiq('#iter-draft-ver');
  if (d && draftState) d.textContent = `버전 ${draftState.history.length}`;
}

//  분석 재생성 — 기존 스키마 유지 + 수정 지시 반영
//  instrOverride 가 있으면(액션바 클릭) 입력창 값 대신 그 지시문을 쓴다.
//  ★ 실패해도 원본 카드를 지우지 않는다(마스터 지시: 실패 시 원본 유지) — 토스트로만 알린다.
async function refineAnalysis(box, instrOverride) {
  //  #iter-analysis-input/go 는 box(AI 박스) 안에 그려진다 → rpq(본문영역) 대신 box.querySelector.
  const input = box.querySelector('#iter-analysis-input');
  const instruction = instrOverride || (input ? input.value.trim() : '');
  if (!instruction || !analysisState) return;
  const go = box.querySelector('#iter-analysis-go');
  if (go) { go.disabled = true; go.textContent = '수정 중...'; }
  try {
    const res = await window.api.aiTranslate(analysisState.mailId, {
      instruction, previous: analysisState.current
    });
    if (!res.ok) { noteAiResult(res); showAiToast('수정 실패 — 기존 분석을 유지합니다: ' + (res.error || '')); return; }
    if (res.structured) {
      analysisState.history.push(res.structured);
      analysisState.current = res.structured;
      box.innerHTML = safeAnalysisHtml(res);
      appendAnalysisChatBar(box);
      const inp = box.querySelector('#iter-analysis-input');
      if (inp && !instrOverride) inp.focus();
    }
  } catch (e) {
    showAiToast('수정 오류 — 기존 분석을 유지합니다: ' + String(e));
  } finally {
    const g = box.querySelector('#iter-analysis-go');
    if (g) { g.disabled = false; g.textContent = '수정'; }
  }
}

function undoAnalysis(box) {
  if (!analysisState || analysisState.history.length < 2) return;
  analysisState.history.pop();
  analysisState.current = analysisState.history[analysisState.history.length - 1];
  box.innerHTML = safeAnalysisHtml({ structured: analysisState.current });
  appendAnalysisChatBar(box);
}

//  분석 결과를 맥락으로 대화창 열기
function openChatWithAnalysis() {
  if (!analysisState) return;
  gchatPinned = {
    label: `분석 결과 · ${(selectedMail && selectedMail.subject ? selectedMail.subject : '').slice(0, 24)}`,
    text: `[분석 결과 맥락] 아래는 지금 열어 둔 메일의 AI 분석 결과다. 이어지는 질문·수정 요청은 이 결과를 기준으로 답하라.${String.fromCharCode(10)}${JSON.stringify(analysisState.current).slice(0, 3000)}`
  };
  setGchatCollapsed(false);
  updateGchatCtx();
  const i = $('#chat-input');
  if (i) i.focus();
}

//  초안 하단 입력줄
function appendDraftChatBar(box) {
  const bar = document.createElement('div');
  bar.className = 'iter-bar';
  bar.innerHTML = `
    <input class="iter-input" id="iter-draft-input" type="text"
      placeholder="초안을 고쳐 말해 보세요 — 예: 더 짧게 / 더 정중하게 / 일정 다음 주로 조정 요청 추가 / 영어로" />
    <button class="btn-primary btn-sm" id="iter-draft-go">고치기</button>
    <button id="iter-draft-prev" title="이전 버전 보기">이전 버전</button>
    <span class="iter-ver" id="iter-draft-ver"></span>`;
  const actBar = renderActionBar(draftState ? draftState.current : '',
    (instr) => refineDraft(box, instr),
    () => showPrevDraft(box));
  box.appendChild(actBar);
  box.appendChild(bar);
  updateIterVersionLabel();
  const run = () => refineDraft(box);
  bar.querySelector('#iter-draft-go').addEventListener('click', run);
  bar.querySelector('#iter-draft-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); run(); }
  });
  bar.querySelector('#iter-draft-prev').addEventListener('click', () => showPrevDraft(box));
}

//  초안 갱신 — 새 말풍선으로 쌓지 않고 초안 본문을 대체한다
//  instrOverride 가 있으면(액션바 클릭) 입력창 값 대신 그 지시문을 쓴다.
//  ★ 실패해도 기존 초안(pre)을 지우지 않는다(마스터 지시: 실패 시 원본 유지) — 토스트로만 알린다.
async function refineDraft(box, instrOverride) {
  //  #iter-draft-input/go, .reply-draft pre 는 box(AI 박스) 안에 그려진다 → box.querySelector.
  const input = box.querySelector('#iter-draft-input');
  const instruction = instrOverride || (input ? input.value.trim() : '');
  if (!instruction || !draftState) return;
  const go = box.querySelector('#iter-draft-go');
  if (go) { go.disabled = true; go.textContent = '고치는 중...'; }
  try {
    const res = await window.api.aiDraftReply(
      draftState.mailId, instruction, 'formal', config.replyLang || 'auto', draftState.current);
    if (!res.ok) { noteAiResult(res); showAiToast('초안 수정 실패 — 기존 초안을 유지합니다: ' + (res.error || '')); return; }
    draftState.history.push(res.content);
    draftState.current = res.content;
    const pre = box.querySelector('.reply-draft pre');
    if (pre) pre.textContent = res.content;          // 그 자리에서 대체
    updateIterVersionLabel();
    // 언어가 바뀌었을 수 있으니 액션바(영어로/한국어로 토글 라벨)를 새로 그린다
    const oldBar = box.querySelector('.act-bar');
    if (oldBar) oldBar.replaceWith(renderActionBar(draftState.current, (instr) => refineDraft(box, instr), () => showPrevDraft(box)));
    const inp = box.querySelector('#iter-draft-input');
    if (inp && !instrOverride) { inp.value = ''; inp.focus(); }
  } catch (e) {
    showAiToast('초안 수정 오류 — 기존 초안을 유지합니다: ' + String(e));
  } finally {
    const g = box.querySelector('#iter-draft-go');
    if (g) { g.disabled = false; g.textContent = '고치기'; }
  }
}

//  이전 버전 보기 (되돌리기 포함)
function showPrevDraft(box) {
  if (!draftState || draftState.history.length < 2) { alert('이전 버전이 없습니다.'); return; }
  const prev = draftState.history[draftState.history.length - 2];
  if (!confirm('이전 버전으로 되돌릴까요?' + String.fromCharCode(10) + String.fromCharCode(10) + prev.slice(0, 300))) return;
  draftState.history.pop();
  draftState.current = draftState.history[draftState.history.length - 1];
  const pre = box.querySelector('.reply-draft pre');
  if (pre) pre.textContent = draftState.current;
  updateIterVersionLabel();
}

// ============================================================
//  메일 작성 브리지 (Outlook 작성창 열기)
//  ★ 이 앱은 메일을 발송하지 않는다. Outlook 작성창을 띄워 주기만 한다.
// ============================================================
async function openCompose(opts, label) {
  showLoading((label || '작성창') + ' 여는 중...');
  try {
    const res = await window.api.composeOpen(opts);
    if (!res.ok) { alert((label || '작성창') + ' 열기 실패:\n' + res.error); return false; }
    return true;
  } catch (err) {
    alert('오류: ' + String(err));
    return false;
  } finally { hideLoading(); }
}

async function composeNew() {
  await openCompose({ mode: 'new', useSignature: true }, '새 메일');
}

// 읽기창에서 답장/전체답장/전달 — 원문 인용과 서명은 Outlook 이 채운다
async function composeReply(mode) {
  if (!requireSelectedMail()) return;
  const entryId = selectedMail.entry_id || selectedMail.entryId;
  if (!entryId) { alert('이 메일의 Outlook 식별자를 찾을 수 없습니다. 동기화 후 다시 시도하세요.'); return; }
  const label = mode === 'forward' ? '전달' : (mode === 'replyAll' ? '전체 답장' : '답장');
  await openCompose({ mode, entryId, useSignature: true }, label);
}

// AI 초안을 본문에 넣은 채로 Outlook 답장 작성창 열기
async function composeReplyWithDraft(draftText) {
  if (!requireSelectedMail()) return;
  const entryId = selectedMail.entry_id || selectedMail.entryId;
  if (!entryId) { alert('이 메일의 Outlook 식별자를 찾을 수 없습니다.'); return; }
  // "제목: ...\n---\n본문" 형식이면 본문만 추출
  let body = String(draftText || '');
  const m = body.match(/^\s*제목\s*:\s*(.+?)\s*\n-{2,}\s*\n([\s\S]*)$/);
  if (m) body = m[2];
  await openCompose({ mode: 'reply', entryId, body, useSignature: true }, '답장');
}

async function rpDraftReply() {
  if (!requireSelectedMail() || needKey()) return;
  // ★ Electron 렌더러는 window.prompt() 를 지원하지 않는다(호출 시 예외).
  //   기존 코드는 여기서 죽어 '답장 초안' 버튼이 완전히 무반응이었다.
  //   → 페이지 내 입력창(#rp-reply-instruction)에서 지시사항을 읽는다(없으면 빈 값).
  const instrEl = rpq('#rp-reply-instruction');
  const instruction = instrEl ? instrEl.value.trim() : '';
  const box = revealAiBox();
  if (!box) return;
  box.innerHTML = '<div class="empty">답장 초안 작성 중...</div>';
  showLoading('답장 초안 작성 중...');
  try {
    // 설정의 'AI 답장 언어'를 그대로 넘긴다(auto = 원문 따름). 지시사항의 언어 지정이 그보다 우선.
    const res = await window.api.aiDraftReply(selectedMail.id, instruction, 'formal', config.replyLang || 'auto');
    if (res.ok) { draftState = { mailId: selectedMail.id, current: res.content, history: [res.content] }; }
    setRsSub('ai', res.ok ? '답장 초안' : '초안 실패');
    if (res.ok) {
      box.innerHTML = `<div class="reply-draft">
        <div class="reply-head">답장 초안
          <button class="link-btn" id="copy-reply">복사</button>
          <button class="btn-primary btn-sm" id="open-in-outlook">Outlook에서 답장 열기</button>
        </div>
        <pre>${escapeHtml(res.content)}</pre>
        <div class="reply-note">이 앱은 메일을 보내지 않습니다. 버튼을 누르면 초안이 들어간 Outlook 답장 창이 열리고, 발송은 직접 확인 후 하시면 됩니다.</div>
      </div>`;
      //  #copy-reply/#open-in-outlook 는 box(AI 박스) 안에 그려진다. box 는 revealAiBox()가 돌려준
      //  실제 렌더 대상(메일 뷰=우측 AI 칸)이므로 rpq(본문영역 전용)로 찾으면 항상 null 이다
      //  (실측 결함: "답장 초안 오류: TypeError: Cannot read properties of null (reading 'addEventListener')").
      const copyBtn = box.querySelector('#copy-reply');
      if (copyBtn) copyBtn.addEventListener('click', async () => {
        const ok = await copyText(res.content);
        const b = box.querySelector('#copy-reply');
        if (b) b.textContent = ok ? '복사됨' : '복사 실패';
      });
      const openBtn = box.querySelector('#open-in-outlook');
      if (openBtn) openBtn.addEventListener('click', () => composeReplyWithDraft(draftState.current || res.content));
      appendDraftChatBar(box);
    } else { noteAiResult(res); box.innerHTML = aiErrorHtml(res); bindAiErrorActions(box); }
  } catch (err) {
    box.innerHTML = `<div class="empty">답장 초안 오류: ${escapeHtml(String(err))}</div>`;
  } finally {
    hideLoading();
    revealAiBox();
  }
}

// ============================================================
//  AI 오류 안내 · AI 상태 배지 · 키 점검
//  ------------------------------------------------------------
//  🔴 raw JSON 을 화면에 그대로 내보내지 않는다.
//     백엔드(ai-errors.js)가 만든 title/message/action 만 보여주고,
//     설정으로 바로 갈 수 있는 버튼을 함께 준다.
// ============================================================
let aiState = 'unknown';

//  res = { ok:false, error, errorKind, errorInfo:{title,message,action,detail} }
function aiErrorHtml(res) {
  const info = (res && res.errorInfo) || null;
  if (!info) {
    // AI 가 아닌 일반 실패 — 문구만 그대로(이 경우도 JSON 을 만들지 않는다)
    return `<div class="ai-err"><div class="ai-err-title">요청을 처리하지 못했습니다</div>
      <div class="ai-err-msg">${escapeHtml(String((res && res.error) || '알 수 없는 오류'))}</div></div>`;
  }
  const btn = info.action === 'settings'
    ? `<button class="btn-primary btn-sm ai-err-settings" type="button">설정 열기</button>` : '';
  return `<div class="ai-err">
    <div class="ai-err-title">${escapeHtml(info.title)}</div>
    <div class="ai-err-msg">${escapeHtml(info.message)}</div>
    ${info.detail ? `<div class="ai-err-detail">${escapeHtml(info.detail)}</div>` : ''}
    ${btn ? `<div class="ai-err-actions">${btn}</div>` : ''}
  </div>`;
}

// 오류 카드를 넣은 뒤 [설정 열기] 버튼을 살린다(고아 방지)
function bindAiErrorActions(root) {
  if (!root) return;
  root.querySelectorAll('.ai-err-settings').forEach(b => {
    if (b.dataset.bound) return;
    b.dataset.bound = '1';
    b.addEventListener('click', () => { switchView('settings'); const k = $('#key-check-summary'); if (k) k.scrollIntoView({ block: 'center' }); });
  });
}

// 제공자 자동 전환 등 짧은 알림 (5초 후 사라진다)
let aiToastTimer = null;
function showAiToast(text) {
  const el = $('#ai-toast');
  if (!el) return;
  el.textContent = text;
  el.classList.remove('hidden');
  if (aiToastTimer) clearTimeout(aiToastTimer);
  aiToastTimer = setTimeout(() => el.classList.add('hidden'), 5000);
}

// AI 응답 결과를 상태 배지에 반영 (성공/실패 모두)
function noteAiResult(res) {
  // 1순위 제공자가 막혀 다음 순위로 자동 전환된 경우 알린다(마스터 요구)
  if (res && res.switched && res.switchedToLabel) {
    showAiToast(`AI 제공자가 자동으로 전환됐습니다 → ${res.switchedToLabel}`);
  }
  if (res && res.limitNear) {
    showAiToast(`${res.limitLabel || 'AI'} 무료 한도의 ${Math.round((res.limitRatio || 0) * 100)}% 를 썼습니다. 곧 다음 순위 제공자로 전환됩니다.`);
  }
  if (res && res.allProvidersFailed) {
    showAiToast('등록된 AI 제공자가 모두 실패했습니다. 설정에서 다른 제공자를 등록하세요.');
  }
  const kind = res && !res.ok ? (res.errorKind || 'error') : '';
  setAiState(res && res.ok ? 'ok' : (kind === 'quota' ? 'quota' : (kind === 'key' ? 'key' : (kind === 'nokey' ? 'nokey' : (kind === 'rate' ? 'rate' : 'error')))));
}

const AI_STATE_TEXT = { ok: 'AI 정상', quota: 'AI 한도 소진', key: 'AI 키 오류', rate: 'AI 대기 중', error: 'AI 오류', nokey: 'AI 키 없음', unknown: 'AI 확인 중' };
function setAiState(state, tip) {
  aiState = state || 'unknown';
  const el = $('#ai-state-pill');
  if (!el) return;
  el.className = 'ai-pill ' + aiState;
  el.innerHTML = `<span class="cp-dot"></span> ${escapeHtml(AI_STATE_TEXT[aiState] || AI_STATE_TEXT.unknown)}`;
  el.title = tip || (aiState === 'quota'
    ? 'Cerebras 사용 한도가 소진됐습니다. 클릭하면 설정에서 키를 점검할 수 있습니다.'
    : 'AI 상태 — 클릭하면 설정에서 키를 점검합니다.');
}

async function refreshAiState() {
  try {
    const r = await window.api.aiStatus();
    setAiState(r && r.state ? r.state : 'unknown', r && r.info ? (r.info.title + ' — ' + r.info.message) : '');
  } catch (e) { setAiState('unknown'); }
}

// ============================================================
//  AI 제공자 체인 (Cerebras 무료 티어 402 → 다른 제공자로 자동 전환)
//  ------------------------------------------------------------
//  프리셋을 고르면 베이스 URL·기본 모델이 자동으로 채워진다(마스터는 키만 입력).
//  키는 제공자별로 따로 저장되므로 전환해도 기존 키가 지워지지 않는다.
// ============================================================
let providerPresets = [];
let providerChain = [];          // 화면에 그려진 제공자 목록(순위 = 배열 순서)

function presetOf(id) { return providerPresets.find(p => p.id === id) || null; }

//  현재 1순위(활성·키 있음) 제공자의 키 — 키 개수 표시·판정에 쓴다
function currentProviderKeys() {
  const usable = providerChain.filter(e => e.enabled !== false && (e.keys || []).some(k => k && k.trim()));
  if (usable.length) return usable[0].keys.filter(k => k && k.trim());
  //  ★ 폴백: 제공자 목록(IPC)이 아직 안 왔거나 실패해도 설정의 체인으로 판단한다.
  //    이게 없으면 키가 있는데도 "제공자가 설정되지 않았습니다"로 막힌다(실측).
  const chainCfg = (config.aiChain || []).filter(e => e && e.enabled !== false);
  for (const e of chainCfg) {
    const ks = (e.keys || []).filter(k => k && String(k).trim());
    if (ks.length) return ks;
  }
  const p = config.aiProvider || 'cerebras';
  const map = config.apiKeysByProvider || {};
  const set = (map[p] || []).filter(k => k && String(k).trim());
  if (set.length) return set;
  return p === 'cerebras' ? (config.apiKeys || []).filter(k => k && String(k).trim()) : [];
}

//  키가 필요 없는 제공자(Ollama 등)까지 포함해 '쓸 수 있는 제공자'가 있는지
function hasUsableProvider() {
  //  설정 체인에 키가 있으면(=백엔드가 쓸 수 있으면) 사용 가능으로 본다
  if ((config.aiChain || []).some(e => e && e.enabled !== false && (e.keys || []).some(k => k && String(k).trim()))) return true;
  return providerChain.some(e => {
    if (e.enabled === false) return false;
    const preset = presetOf(e.provider);
    const noKeyNeeded = preset && preset.needsKey === false;
    return (e.baseUrl || (preset && preset.baseUrl)) && (noKeyNeeded || (e.keys || []).some(k => k && k.trim()));
  });
}

// ------------------------------------------------------------
//  제공자 체인 그리기 (순위 ↑↓·드래그 · 사용 토글 · 키 여러 개)
//   마스터 요구(2026-08-14): "각 종류별 API를 동시에 2개씩 등록 — 한 서비스가
//   문제 생겨도 대안 가능하게" → 순위대로 등록하고 실패 시 자동 전환한다.
// ------------------------------------------------------------
function renderProviderChain() {
  const box = $('#ai-chain');
  if (!box) return;
  if (!providerChain.length) {
    box.innerHTML = '<div class="chain-empty">등록된 제공자가 없습니다. [+ 제공자 추가]를 누르세요.</div>';
    return;
  }
  box.innerHTML = providerChain.map((e, i) => {
    const preset = presetOf(e.provider) || {};
    const opts = providerPresets.map(p =>
      `<option value="${escapeHtml(p.id)}"${p.id === e.provider ? ' selected' : ''}>${escapeHtml(p.label)}</option>`).join('');
    const keysText = (e.keys || []).join('\n');
    const trainWarn = /학습/.test(preset.training || '');
    return `<div class="chain-row${e.enabled === false ? ' off' : ''}" data-i="${i}" draggable="true">
      <div class="chain-head">
        <span class="chain-rank" title="우선순위 — 위에 있을수록 먼저 씁니다">${i + 1}순위</span>
        <select class="chain-provider" title="제공자 선택">${opts}</select>
        ${preset.recommended ? '<span class="chain-badge rec">권장</span>' : ''}
        ${preset.privacy === 'local' ? '<span class="chain-badge safe">메일이 PC 밖으로 안 나감</span>' : ''}
        ${trainWarn ? '<span class="chain-badge warn">학습에 쓰일 수 있음</span>' : ''}
        <label class="chain-on" title="끄면 이 제공자는 사용하지 않습니다"><input type="checkbox" class="chain-enabled"${e.enabled === false ? '' : ' checked'} /> 사용</label>
        <span class="chain-move">
          <button type="button" class="chain-up" title="순위 올리기"${i === 0 ? ' disabled' : ''}>위로</button>
          <button type="button" class="chain-down" title="순위 내리기"${i === providerChain.length - 1 ? ' disabled' : ''}>아래로</button>
          <button type="button" class="chain-del" title="이 제공자 삭제">삭제</button>
        </span>
      </div>
      <div class="chain-fields">
        <label class="chain-url">베이스 URL
          <input type="text" class="chain-baseurl" value="${escapeHtml(e.baseUrl || preset.baseUrl || '')}" placeholder="https://api.example.com/v1" />
        </label>
        <label class="chain-model">모델
          <input type="text" class="chain-modelname" list="ai-model-list" value="${escapeHtml(e.model || preset.model || '')}" placeholder="모델 이름" />
        </label>
        <button type="button" class="chain-models" title="이 제공자의 모델 목록을 불러옵니다">모델 조회</button>
        ${preset.needsAccountId ? `<label class="chain-acct">계정 ID
          <input type="text" class="chain-accountid" value="${escapeHtml(e.accountId || '')}" placeholder="Cloudflare 계정 ID" /></label>` : ''}
      </div>
      <div class="chain-fields">
        <label class="chain-keys">API 키 (한 줄에 하나 · 2개 이상 권장)
          <textarea class="chain-keytext" rows="2" placeholder="${preset.needsKey === false ? '키가 필요 없습니다(아무 값이나 가능)' : '발급받은 API 키를 한 줄에 하나씩 붙여넣으세요'}">${escapeHtml(keysText)}</textarea>
        </label>
      </div>
      <div class="chain-meta">무료: ${escapeHtml(preset.free || '-')} · 카드: ${escapeHtml(preset.card || '-')} · 학습: ${escapeHtml(preset.training || '-')}
        ${preset.keyUrl ? ` · <button type="button" class="link-btn chain-keylink" data-url="${escapeHtml(preset.keyUrl)}">키 발급 페이지</button>` : ''}</div>
      <div class="chain-note">${escapeHtml(preset.note || '')}</div>
    </div>`;
  }).join('');
  bindProviderChainRows();
}

//  화면 입력값을 providerChain 에 반영(저장·테스트 전 항상 호출)
function collectProviderChain() {
  const box = $('#ai-chain');
  if (!box) return providerChain;
  const rows = [...box.querySelectorAll('.chain-row')];
  if (!rows.length) return providerChain;
  providerChain = rows.map(row => ({
    provider: row.querySelector('.chain-provider').value,
    baseUrl: (row.querySelector('.chain-baseurl') || {}).value || '',
    model: (row.querySelector('.chain-modelname') || {}).value || '',
    accountId: (row.querySelector('.chain-accountid') || {}).value || '',
    enabled: row.querySelector('.chain-enabled').checked,
    keys: ((row.querySelector('.chain-keytext') || {}).value || '').split(/\r?\n/).map(k => k.trim()).filter(Boolean)
  }));
  return providerChain;
}

function bindProviderChainRows() {
  const box = $('#ai-chain');
  if (!box) return;
  box.querySelectorAll('.chain-row').forEach(row => {
    const i = parseInt(row.dataset.i, 10);
    row.querySelector('.chain-provider').addEventListener('change', (ev) => {
      collectProviderChain();
      const preset = presetOf(ev.target.value);
      providerChain[i].provider = ev.target.value;
      providerChain[i].baseUrl = preset ? preset.baseUrl : '';
      providerChain[i].model = preset ? preset.model : '';
      renderProviderChain();
    });
    row.querySelector('.chain-up').addEventListener('click', () => moveProvider(i, -1));
    row.querySelector('.chain-down').addEventListener('click', () => moveProvider(i, 1));
    row.querySelector('.chain-del').addEventListener('click', () => {
      collectProviderChain();
      providerChain.splice(i, 1);
      renderProviderChain();
    });
    row.querySelector('.chain-enabled').addEventListener('change', () => collectProviderChain());
    row.querySelector('.chain-models').addEventListener('click', () => loadProviderModels(i));
    const kl = row.querySelector('.chain-keylink');
    if (kl) kl.addEventListener('click', () => window.api.openPath(kl.dataset.url));
    // 드래그로 순위 변경
    row.addEventListener('dragstart', (ev) => { ev.dataTransfer.setData('text/plain', String(i)); row.classList.add('dragging'); });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
    row.addEventListener('dragover', (ev) => ev.preventDefault());
    row.addEventListener('drop', (ev) => {
      ev.preventDefault();
      const from = parseInt(ev.dataTransfer.getData('text/plain'), 10);
      if (Number.isFinite(from) && from !== i) {
        collectProviderChain();
        const moved = providerChain.splice(from, 1)[0];
        providerChain.splice(i, 0, moved);
        renderProviderChain();
      }
    });
  });
}

function moveProvider(i, dir) {
  collectProviderChain();
  const j = i + dir;
  if (j < 0 || j >= providerChain.length) return;
  const t = providerChain[i]; providerChain[i] = providerChain[j]; providerChain[j] = t;
  renderProviderChain();
}

function addProviderRow() {
  collectProviderChain();
  const used = new Set(providerChain.map(e => e.provider));
  const next = (providerPresets.find(p => p.recommended && !used.has(p.id))
    || providerPresets.find(p => !used.has(p.id) && p.id !== 'custom')
    || providerPresets[0]);
  if (!next) return;
  providerChain.push({ provider: next.id, baseUrl: next.baseUrl, model: next.model, keys: [], accountId: '', enabled: true });
  renderProviderChain();
}

// 제공자의 모델 목록을 불러와 자동완성(datalist)에 채운다
async function loadProviderModels(rowIndex) {
  const sum = $('#key-check-summary'), list = $('#ai-model-list');
  collectProviderChain();
  const e = providerChain[rowIndex] || providerChain[0];
  if (!e) return;
  if (sum) { sum.textContent = '모델 목록을 불러오는 중...'; sum.className = 'key-check-summary'; }
  const r = await window.api.aiModels(e.provider, e.baseUrl, (e.keys || [])[0] || '');
  if (!r.ok) {
    if (sum) { sum.textContent = '모델 조회 실패 — ' + (r.errorInfo ? r.errorInfo.title : (r.error || '')); sum.className = 'key-check-summary bad'; }
    return;
  }
  list.innerHTML = r.models.map(m => `<option value="${escapeHtml(m)}"></option>`).join('');
  if (sum) { sum.textContent = `모델 ${r.models.length}개를 불러왔습니다. 모델 칸을 클릭하면 목록이 나옵니다.`; sum.className = 'key-check-summary ok'; }
}

// 오늘 사용량 — 무료 한도 대비 얼마나 썼는지(하루 요청·토큰)
//  Groq 무료 한도 실측: 30 RPM · 1,000 RPD · 8K TPM · 200K TPD.
//  대량 배치는 하루 토큰(TPD)이 먼저 걸리므로 그 비율을 막대로 보여 준다.
async function refreshAiUsage() {
  const box = $('#ai-usage');
  if (!box) return;
  try {
    const r = await window.api.aiUsage();
    if (!r || !r.ok) { box.textContent = '사용량을 읽지 못했습니다.'; return; }
    const rows = (r.chain || []).filter(c => c.usedReq || c.usedTokens || c.limits);
    if (!rows.length) { box.textContent = '아직 호출 기록이 없습니다.'; return; }
    box.innerHTML = rows.map(c => {
      const lim = c.limits || {};
      const pct = Math.min(100, Math.round((c.ratio || 0) * 100));
      const state = c.over ? 'over' : (c.near ? 'near' : 'ok');
      const limTxt = lim.rpd
        ? `요청 ${c.usedReq.toLocaleString()}/${lim.rpd.toLocaleString()} · 토큰 ${c.usedTokens.toLocaleString()}/${lim.tpd.toLocaleString()}`
        : `요청 ${c.usedReq.toLocaleString()} · 토큰 ${c.usedTokens.toLocaleString()} (한도 정보 없음)`;
      return `<div class="usage-row">
        <span class="usage-name">${escapeHtml(c.label || c.provider)}</span>
        <span class="usage-bar"><i class="${state}" style="width:${pct}%"></i></span>
        <span class="usage-num">${pct}%</span>
        <span class="usage-detail">${escapeHtml(limTxt)}${c.cooling ? ' · 잠시 쉬는 중' : ''}</span>
      </div>`;
    }).join('');
    if (r.limitWarning) {
      box.innerHTML += `<div class="usage-warn">${escapeHtml(r.limitWarning.label)} 사용량이 무료 한도의 ${Math.round(r.limitWarning.ratio * 100)}% 에 도달해 다음 순위 제공자로 전환됩니다.</div>`;
    }
  } catch (e) { box.textContent = '사용량 조회 오류: ' + String(e); }
}

// [전체 연결 테스트] — 등록된 모든 제공자·키를 실호출해 표로 보여준다
async function runChainTest() {
  const sum = $('#key-check-summary'), rows = $('#key-check-rows'), btn = $('#btn-chain-test');
  if (!sum || !rows) return;
  btn.disabled = true;
  sum.textContent = '등록된 제공자를 하나씩 호출하는 중...';
  sum.className = 'key-check-summary';
  rows.innerHTML = '';
  try {
    await saveSettings({ silent: true });          // 화면 입력값을 먼저 저장하고 테스트한다
    const r = await window.api.aiChainTest();
    if (!r.ok) { sum.textContent = '테스트 실패: ' + (r.error || ''); sum.className = 'key-check-summary bad'; return; }
    sum.textContent = `사용 가능 ${r.usable}/${r.total}`;
    sum.className = 'key-check-summary ' + (r.usable ? 'ok' : 'bad');
    rows.innerHTML = `<div class="key-row key-row-head">
        <span class="key-row-no">제공자</span><span class="key-row-tail">키</span>
        <span class="key-row-state">상태</span><span class="key-row-ms">응답</span>
        <span class="key-row-detail">모델 · 상세</span></div>` +
      r.rows.map(k => `<div class="key-row">
        <span class="key-row-no">${escapeHtml(k.label || k.provider)}</span>
        <span class="key-row-tail">${escapeHtml(k.key || '-')}</span>
        <span class="key-row-state ${k.ok ? 'ok' : (k.state || 'error')}">${escapeHtml(k.ok ? '정상' : (AI_STATE_TEXT[k.state] || '오류'))}</span>
        <span class="key-row-ms">${k.ms}ms</span>
        <span class="key-row-detail">${escapeHtml(k.model || '')}${k.detail ? ' · ' + escapeHtml(k.detail) : ''}</span>
      </div>`).join('');
    setAiState(r.usable ? 'ok' : 'quota');
    refreshAiState();
    refreshAiUsage();
  } catch (err) {
    sum.textContent = '테스트 중 오류: ' + String(err);
    sum.className = 'key-check-summary bad';
  } finally { btn.disabled = false; }
}

// ============================================================
//  채팅 메시지 헬퍼
// ============================================================
function addMessage(role, html, opts = {}) {
  const log = $('#chat-log');
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  let extra = '';
  if (opts.keyIndex) extra = `<div style="font-size:10px;opacity:.5;margin-top:6px;">키#${opts.keyIndex} 사용${opts.ctx ? ` · 참고메일 ${opts.ctx}건` : ''}</div>`;
  div.innerHTML = `<div class="bubble">${html}${extra}</div>`;
  log.appendChild(div); log.scrollTop = log.scrollHeight;
  return div;
}
function addTyping() {
  const log = $('#chat-log');
  const div = document.createElement('div');
  div.className = 'msg assistant typing';
  div.innerHTML = `<div class="bubble">처리 중...</div>`;
  log.appendChild(div); log.scrollTop = log.scrollHeight;
  return div;
}
function setTyping(el, text) { if (el) el.querySelector('.bubble').textContent = text; $('#chat-log').scrollTop = $('#chat-log').scrollHeight; }
function removeTyping(el) { if (el && el.parentNode) el.parentNode.removeChild(el); }

function formatAnswer(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/^### (.+)$/gm, '<b>$1</b>')
    .replace(/^## (.+)$/gm, '<b>$1</b>')
    .replace(/^- (.+)$/gm, '• $1');
}
function autoGrow() {
  const el = $('#chat-input');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 140) + 'px';
}


// ============================================================
//  유틸
// ============================================================
function showLoading(text) { $('#loading-text').textContent = text || '처리 중...'; $('#loading').classList.remove('hidden'); }
function hideLoading() { $('#loading').classList.add('hidden'); }
// 본문(평문) 속 http(s) 주소를 클릭 가능한 링크로 — 조각마다 escapeHtml 을 거친다(본문 HTML 주입 없음).
//  끝의 문장부호는 링크에서 뺀다. 비ASCII(한글 등)·따옴표·꺾쇠에서 주소가 끝난다(Outlook 평문의 <URL> 표기).
//  🔴 i 플래그 금지: /iu 에서는 K·S 가 켈빈 기호(U+212A)·긴 s(U+017F)로 대소문자 접힘돼 비ASCII 제외 범위에 걸린다
//     (실측 2026-10-06: naver bigfile 링크가 ...fid=DQ+qWz05+B 에서 잘림 — 다음 글자가 K)
const LINK_RE_CLIENT = /[Hh][Tt][Tt][Pp][Ss]?:\/\/[^\s<>"'`\P{ASCII}]+/gu;
function linkifyText(raw) {
  const s = String(raw || '');
  let out = '', last = 0;
  for (const m of s.matchAll(LINK_RE_CLIENT)) {
    const url = m[0].replace(/[.,;:!?)\]}]+$/, '');
    if (!/^https?:\/\/./i.test(url)) continue;
    out += escapeHtml(s.slice(last, m.index)) + `<a class="rp-link" href="${escapeHtml(url)}" title="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
    last = m.index + url.length;
  }
  return out + escapeHtml(s.slice(last));
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
