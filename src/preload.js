// ============================================================
//  preload.js - 렌더러 ↔ 메인 프로세스 보안 다리
// ============================================================
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 설정
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (cfg) => ipcRenderer.invoke('config:set', cfg),

  // 연결/소스
  checkConnection: () => ipcRenderer.invoke('outlook:checkConnection'),
  pickPst: () => ipcRenderer.invoke('dialog:pickPst'),

  // 메일
  checkNew: () => ipcRenderer.invoke('outlook:checkNew'),

  // 첨부 분석
  analyzeAttachments: (filePaths) => ipcRenderer.invoke('attachments:analyze', { filePaths }),
  pickFiles: () => ipcRenderer.invoke('dialog:pickFiles'),

  // AI (기본 챗)
  chat: (messages) => ipcRenderer.invoke('ai:chat', { messages }),

  // === DB / 동기화 ===
  dbStatus: () => ipcRenderer.invoke('db:status'),
  syncRun: () => ipcRenderer.invoke('sync:run'),
  dbSearchMails: (opts) => ipcRenderer.invoke('db:searchMails', opts),
  dbGetMail: (id) => ipcRenderer.invoke('db:getMail', { id }),
  // 읽기창 첨부: 저장 전이면 Outlook 에서 이름·크기만 읽어오고, [가져오기]로 그때 저장한다
  mailAttachMeta: (id) => ipcRenderer.invoke('mail:attachMeta', { id }),
  mailAttachFetch: (id) => ipcRenderer.invoke('mail:attachFetch', { id }),
  // 첨부 미리보기(앱 안에서 열기) — 텍스트 읽기 · 다른 이름으로 저장
  filePreview: (p) => ipcRenderer.invoke('file:preview', { path: p }),
  fileSaveAs: (p) => ipcRenderer.invoke('file:saveAs', { path: p }),
  dbStats: () => ipcRenderer.invoke('db:stats'),
  searchParse: (query) => ipcRenderer.invoke('search:parse', { query }),
  searchRun: (query, cond, limit) => ipcRenderer.invoke('search:run', { query, cond, limit }),
  // ★ 4탭(마스터 지시): 타임라인/사람별/키워드별 표는 검색 응답에 이미 포함(resultTabs).
  //   AI 자동요약(날짜별 한줄+종합)만 비동기로 별도 요청한다(리스트를 기다리게 하지 않음).
  aiSummarizeGroups: (ids, queryLabel, capLimit) => ipcRenderer.invoke('ai:summarizeGroups', { ids, queryLabel, capLimit }),
  // 메일별 대화 이력(마스터 지시: 메일 다시 열면 이전 대화 이어보기)
  chatHistory: (id) => ipcRenderer.invoke('chat:history', { id }),
  chatHistoryClear: (id) => ipcRenderer.invoke('chat:historyClear', { id }),
  dbUnanswered: (opts) => ipcRenderer.invoke('db:unanswered', opts || {}),

  // === 로컬 가상 폴더 / 즐겨찾기 / 읽음 (Outlook 원본 불변) ===
  vfList: () => ipcRenderer.invoke('vf:list'),
  vfCreate: (name, parentId) => ipcRenderer.invoke('vf:create', { name, parentId }),
  vfRename: (id, name) => ipcRenderer.invoke('vf:rename', { id, name }),
  vfDelete: (id) => ipcRenderer.invoke('vf:delete', { id }),
  vfSortChildren: (parentId) => ipcRenderer.invoke('vf:sortChildren', { parentId }),
  vfMoveMails: (mailIds, vfolderId) => ipcRenderer.invoke('vf:moveMails', { mailIds, vfolderId }),
  favList: () => ipcRenderer.invoke('fav:list'),
  folderOrderGet: () => ipcRenderer.invoke('folderOrder:get'),
  folderOrderSet: (list) => ipcRenderer.invoke('folderOrder:set', { list }),
  favAdd: (key, kind, label) => ipcRenderer.invoke('fav:add', { key, kind, label }),
  favRemove: (key) => ipcRenderer.invoke('fav:remove', { key }),
  favMove: (key, dir) => ipcRenderer.invoke('fav:move', { key, dir }),
  favSyncOutlook: () => ipcRenderer.invoke('fav:syncOutlook'),
  // 일정(달력)
  schedMonth: (year, month) => ipcRenderer.invoke('sched:month', { year, month }),
  schedUpcoming: (days) => ipcRenderer.invoke('sched:upcoming', { days }),
  schedCollect: () => ipcRenderer.invoke('sched:collect'),
  schedAdd: (payload) => ipcRenderer.invoke('sched:add', payload),
  schedUpdate: (payload) => ipcRenderer.invoke('sched:update', payload),
  schedDone: (id, done) => ipcRenderer.invoke('sched:done', { id, done }),
  schedDelete: (id) => ipcRenderer.invoke('sched:delete', { id }),
  // 대용량 첨부 (bigmail)
  bigmailPick: () => ipcRenderer.invoke('bigmail:pick'),
  bigmailUpload: (payload) => ipcRenderer.invoke('bigmail:upload', payload),
  bigmailInsert: (html) => ipcRenderer.invoke('bigmail:insert', { html }),
  bigmailHistory: () => ipcRenderer.invoke('bigmail:history'),
  bigmailHistoryDelete: (id) => ipcRenderer.invoke('bigmail:historyDelete', { id }),
  onBigmailProgress: (cb) => ipcRenderer.on('bigmail-progress', (_e, d) => cb(d)),
  // 첨부 재분류 (서명 로고·본문 이미지 분리)
  attachStats: () => ipcRenderer.invoke('attach:stats'),
  rulesImport: () => ipcRenderer.invoke('rules:import'),
  // Outlook 잔여 데이터 (범주/플래그/캘린더/작업/검색폴더) — 읽기 전용
  extrasImport: (metaBatch, retryUnreachable) => ipcRenderer.invoke('extras:import', { metaBatch, retryUnreachable }),
  extrasStats: () => ipcRenderer.invoke('extras:stats'),
  extrasFlagged: (includeDone) => ipcRenderer.invoke('extras:flagged', { includeDone }),
  // 내보내기 — 통합 대시보드 HTML 1개 · 엑셀(.xlsx)
  exportDashboard: (opts) => ipcRenderer.invoke('export:dashboard', opts || {}),
  exportExcel: (opts) => ipcRenderer.invoke('export:excel', opts || {}),
  exportPickRoot: () => ipcRenderer.invoke('export:pickRoot'),
  exportOpenRoot: () => ipcRenderer.invoke('export:openRoot'),
  // 대화로 첨부 정리 — 계획 → 사용자 확인 → 실행 (계획 단계는 파일을 쓰지 않는다)
  organizePlan: (text, prev) => ipcRenderer.invoke('organize:plan', { text, prev }),
  organizeRun: (plan) => ipcRenderer.invoke('organize:run', { plan }),
  organizeHistory: () => ipcRenderer.invoke('organize:history'),
  onOrganizeProgress: (cb) => ipcRenderer.on('organize-progress', (_e, p) => cb(p)),
  // 로컬 정리 (스캔은 안전 · 삭제는 명시 요청 시에만)
  cleanupScan: () => ipcRenderer.invoke('cleanup:scan'),
  cleanupApply: () => ipcRenderer.invoke('cleanup:apply'),
  cleanupLast: () => ipcRenderer.invoke('cleanup:last'),
  onCleanupReport: (cb) => ipcRenderer.on('cleanup:report', (_e, r) => cb(r)),
  // 실시간 전체 갱신
  refreshNow: () => ipcRenderer.invoke('realtime:refreshNow'),
  setUiBusy: (busy) => ipcRenderer.invoke('realtime:setBusy', { busy }),
  refreshInfo: () => ipcRenderer.invoke('realtime:info'),
  onMailsUpdated: (cb) => ipcRenderer.on('mails-updated', (_e, p) => cb(p)),
  // 메일별 내 처리 상태 (할일/보류/처리/확인)
  actionSet: (ids, state, note, due) => ipcRenderer.invoke('action:set', { ids, state, note, due }),
  actionUndo: (ids) => ipcRenderer.invoke('action:undo', { ids }),
  actionCounts: (folder) => ipcRenderer.invoke('action:counts', { folder }),
  actionList: (state, limit) => ipcRenderer.invoke('action:list', { state, limit }),
  actionSuggest: (ids) => ipcRenderer.invoke('action:suggest', { ids }),
  actionSeedFromFlags: () => ipcRenderer.invoke('action:seedFromFlags'),
  actionSourceCounts: () => ipcRenderer.invoke('action:sourceCounts'),
  actionClearAuto: () => ipcRenderer.invoke('action:clearAuto'),
  attachReclassify: (maxBatches) => ipcRenderer.invoke('attach:reclassify', { maxBatches }),
  onAttachProgress: (cb) => ipcRenderer.on('attach-progress', (_e, d) => cb(d)),
  mailSetRead: (mailIds, read) => ipcRenderer.invoke('mail:setRead', { mailIds, read }),
  mailMarkFolderRead: (opts) => ipcRenderer.invoke('mail:markFolderRead', opts),
  dbUnreadCounts: () => ipcRenderer.invoke('db:unreadCounts'),
  dbToMeStats: () => ipcRenderer.invoke('db:toMeStats'),
  dbToMeBackfill: () => ipcRenderer.invoke('db:toMeBackfill'),

  // === 보낸메일 프로젝트 트리 (읽기 전용 뷰 · 로컬 판정) ===
  projectTree: () => ipcRenderer.invoke('project:tree'),
  // 보낸메일 분류 축: axis='date'(연·월) | 'event'(도면·견적·승인…)
  sentAxis: (axis, force) => ipcRenderer.invoke('sent:axis', { axis, force }),
  projectOrgs: (project) => ipcRenderer.invoke('project:orgs', { project }),
  projectThreads: (project, org) => ipcRenderer.invoke('project:threads', { project, org }),
  projectThreadMails: (tkey, project, org) => ipcRenderer.invoke('project:threadMails', { tkey, project, org }),
  orgDict: (opts) => ipcRenderer.invoke('org:dict', opts || {}),
  projectMails: (project, toFirst, limit) => ipcRenderer.invoke('project:mails', { project, toFirst, limit }),
  projectRecompute: (allFolders) => ipcRenderer.invoke('project:recompute', { allFolders }),
  projectSetMail: (mailId, project, learn) => ipcRenderer.invoke('project:setMail', { mailId, project, learn }),
  projectRules: (opts) => ipcRenderer.invoke('project:rules', opts || {}),

  // === AI 분석 ===
  aiBriefing: (mode) => ipcRenderer.invoke('ai:briefing', { mode }),
  aiDailyBriefing: (date, force) => ipcRenderer.invoke('ai:dailyBriefing', { date, force }),
  aiDailyBriefingDates: () => ipcRenderer.invoke('ai:dailyBriefingDates'),
  aiWorkLog: (mode, start, end) => ipcRenderer.invoke('ai:workLog', { mode, start, end }),
  aiWorkLogHistory: (limit) => ipcRenderer.invoke('ai:workLogHistory', { limit }),
  // refine = { instruction, previous } — 대화로 분석을 고칠 때
  aiTranslate: (id, refine) => ipcRenderer.invoke('ai:translate', { id, refine }),
  // previousDraft 가 있으면 새로 쓰지 않고 그 초안을 지시대로 고친다
  aiDraftReply: (id, instruction, tone, replyLang, previousDraft) => ipcRenderer.invoke('ai:draftReply', { id, instruction, tone, replyLang, previousDraft }),
  aiChatMails: (question, history, focusMailId) => ipcRenderer.invoke('ai:chatMails', { question, history, focusMailId }),
  // AI 상태(정상/한도소진/키오류) · 키 7개 점검
  aiStatus: () => ipcRenderer.invoke('ai:status'),
  aiProviders: () => ipcRenderer.invoke('ai:providers'),
  aiModels: (provider, baseUrl, key) => ipcRenderer.invoke('ai:models', { provider, baseUrl, key }),
  aiChainTest: () => ipcRenderer.invoke('ai:chainTest'),
  aiUsage: () => ipcRenderer.invoke('ai:usage'),

  // === 주소록 / 설정 ===
  contactsImport: () => ipcRenderer.invoke('contacts:import'),
  contactsList: (query, limit, sort) => ipcRenderer.invoke('contacts:list', { query, limit, sort }),
  contactsStats: () => ipcRenderer.invoke('contacts:stats'),
  contactsGroupMembers: (groupId) => ipcRenderer.invoke('contacts:groupMembers', { groupId }),
  outlookGetSettings: () => ipcRenderer.invoke('outlook:getSettings'),
  outlookListStores: () => ipcRenderer.invoke('outlook:listStores'),
  // opts.cached=true 면 Outlook 을 건드리지 않고 마지막 캐시를 즉시 반환한다(첫 화면용)
  outlookFolderTree: (opts) => ipcRenderer.invoke('outlook:folderTree', opts || {}),
  pstStores: () => ipcRenderer.invoke('pst:stores'),

  // === 메일 작성 브리지 (발송은 Outlook 에서 마스터가 직접) ===
  composeOpen: (opts) => ipcRenderer.invoke('compose:open', opts),
  composeSignature: (name) => ipcRenderer.invoke('compose:signature', { name }),
  composeSignatureHtml: (name) => ipcRenderer.invoke('compose:signatureHtml', { name }),

  // === 파일/탐색기 ===
  showItem: (p) => ipcRenderer.invoke('shell:showItem', { path: p }),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', { path: p }),

  // 앱 정보
  getVersion: () => ipcRenderer.invoke('app:getVersion'),

  // 이벤트 수신
  onNewMails: (cb) => ipcRenderer.on('new-mails', (_e, mails) => cb(mails)),
  onRealtimeStatus: (cb) => ipcRenderer.on('realtime-status', (_e, s) => cb(s)),
  onOpenMail: (cb) => ipcRenderer.on('open-mail', (_e, d) => cb(d)),
  onFolderTreeStale: (cb) => ipcRenderer.on('folder-tree-stale', (_e, d) => cb(d)),
  onSyncProgress: (cb) => ipcRenderer.on('sync-progress', (_e, data) => cb(data)),
  onAiProgress: (cb) => ipcRenderer.on('ai-progress', (_e, data) => cb(data))
});
