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
  searchMails: (query, limit) => ipcRenderer.invoke('outlook:search', { query, limit }),
  getMail: (entryId) => ipcRenderer.invoke('outlook:getMail', { entryId }),
  saveAttachments: (entryId) => ipcRenderer.invoke('outlook:saveAttachments', { entryId }),
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
  dbRecentMails: (limit, offset) => ipcRenderer.invoke('db:recentMails', { limit, offset }),
  dbGetMail: (id) => ipcRenderer.invoke('db:getMail', { id }),
  dbStats: () => ipcRenderer.invoke('db:stats'),

  // === AI 분석 ===
  aiBriefing: (mode) => ipcRenderer.invoke('ai:briefing', { mode }),
  aiTranslate: (id) => ipcRenderer.invoke('ai:translate', { id }),
  aiDraftReply: (id, instruction, tone, replyLang) => ipcRenderer.invoke('ai:draftReply', { id, instruction, tone, replyLang }),
  aiChatMails: (question, history) => ipcRenderer.invoke('ai:chatMails', { question, history }),

  // === 주소록 / 설정 ===
  contactsImport: () => ipcRenderer.invoke('contacts:import'),
  contactsList: (query, limit) => ipcRenderer.invoke('contacts:list', { query, limit }),
  outlookGetSettings: () => ipcRenderer.invoke('outlook:getSettings'),

  // === 파일/탐색기 ===
  showItem: (p) => ipcRenderer.invoke('shell:showItem', { path: p }),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', { path: p }),

  // 앱/업데이트
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  checkUpdate: () => ipcRenderer.invoke('app:checkUpdate'),

  // 이벤트 수신
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_e, data) => cb(data)),
  onNewMails: (cb) => ipcRenderer.on('new-mails', (_e, mails) => cb(mails)),
  onRealtimeError: (cb) => ipcRenderer.on('realtime-error', (_e, err) => cb(err)),
  onSyncProgress: (cb) => ipcRenderer.on('sync-progress', (_e, data) => cb(data))
});
