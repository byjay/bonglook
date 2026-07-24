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

  // AI
  chat: (messages) => ipcRenderer.invoke('ai:chat', { messages }),

  // 앱/업데이트
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  checkUpdate: () => ipcRenderer.invoke('app:checkUpdate'),

  // 이벤트 수신
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_e, data) => cb(data)),
  onNewMails: (cb) => ipcRenderer.on('new-mails', (_e, mails) => cb(mails)),
  onRealtimeError: (cb) => ipcRenderer.on('realtime-error', (_e, err) => cb(err))
});
