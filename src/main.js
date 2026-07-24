// ============================================================
//  Outlook AI 어시스턴트 - 메인 프로세스 (Electron main)
//  - 창 생성 / 자동 업데이트
//  - Outlook(COM, 실시간) 또는 PST(파일 직접) 연동
//  - 날짜 필터(기본 6개월 / 전체 / 기간)
//  - 실시간 새 메일 폴링
//  - 첨부파일 분석 + Cerebras 호출 (키 5개 폴백)
// ============================================================
const { app, BrowserWindow, ipcMain, dialog, shell, Notification } = require('electron');
const path = require('path');
const Store = require('electron-store');
const { autoUpdater } = require('electron-updater');

const outlook = require('./outlook');       // Outlook COM (실시간)
const pst = require('./pst');               // PST 파일 직접 파싱
const attachments = require('./attachments'); // 첨부 분석
const cerebras = require('./cerebras');     // Cerebras (키 5개 폴백)
const db = require('./db');                 // 로컬 SQLite DB (색인/저장)
const sync = require('./sync');             // 동기화 엔진
const analyzer = require('./analyzer');     // AI 분석(브리핑/번역/답장)

// 로컬 설정 저장 (PIN/인증 없음 — 로컬 전용)
const store = new Store({
  name: 'outlook-ai-config',
  defaults: {
    apiKeys: ['', '', '', '', ''],
    model: 'llama-3.3-70b',
    maxMails: 2000,
    // 연동 방식: 'outlook'(COM,실시간) | 'pst'(파일직접)
    source: 'outlook',
    pstPath: '',
    // 날짜 필터: mode '6months'(기본) | 'all' | 'range'
    dateFilter: { mode: '6months', start: '', end: '' },
    // 실시간 새 메일 확인
    realtime: true,
    realtimeIntervalSec: 60,
    // 동기화 시 첨부(도면 등) 자동 저장
    saveAttachmentsOnSync: true
  }
});

// DB 초기화 상태
let dbReady = false;
let dbInitError = '';

let mainWindow = null;
let realtimeTimer = null;
let lastCheckIso = new Date().toISOString();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 860, minWidth: 980, minHeight: 640,
    title: 'Outlook',
    icon: path.join(__dirname, 'renderer', 'assets', 'icon.ico'),
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });
  // 한글 깨짐 방지: 로컬 파일 응답에 UTF-8 charset 강제
  try {
    const ses = mainWindow.webContents.session;
    ses.webRequest.onHeadersReceived((details, cb) => {
      const h = details.responseHeaders || {};
      const ctKey = Object.keys(h).find(k => k.toLowerCase() === 'content-type');
      if (ctKey) {
        const v = String(h[ctKey][0] || '');
        if (/text\/html/i.test(v) && !/charset/i.test(v)) h[ctKey] = ['text/html; charset=utf-8'];
        else if (/javascript/i.test(v) && !/charset/i.test(v)) h[ctKey] = ['text/javascript; charset=utf-8'];
        else if (/text\/css/i.test(v) && !/charset/i.test(v)) h[ctKey] = ['text/css; charset=utf-8'];
      }
      cb({ responseHeaders: h });
    });
  } catch (e) { console.error('charset 헤더 설정 실패:', e); }

  // charset을 명시하여 로드 (일부 환경에서 meta 인식 실패 대비)
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'), { });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url); return { action: 'deny' };
  });
  // mainWindow.webContents.openDevTools();
}

app.whenReady().then(() => {
  // DB 초기화 (userData 하위)
  try {
    const userData = app.getPath('userData');
    db.init(userData);
    sync.setAttachRoot(path.join(userData, 'attachments'));
    dbReady = true;
  } catch (e) {
    dbInitError = String(e && e.message ? e.message : e);
    console.error('DB 초기화 실패:', dbInitError);
  }

  createWindow();
  try { autoUpdater.autoDownload = true; autoUpdater.checkForUpdatesAndNotify(); }
  catch (e) { console.error('업데이트 체크 실패:', e); }

  startRealtimeIfNeeded();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (realtimeTimer) clearInterval(realtimeTimer);
  try { db.close(); } catch (_) {}
  if (process.platform !== 'darwin') app.quit();
});

// ============================================================
//  실시간 새 메일 폴링 (Outlook COM 모드에서만)
// ============================================================
function startRealtimeIfNeeded() {
  if (realtimeTimer) { clearInterval(realtimeTimer); realtimeTimer = null; }
  const realtime = store.get('realtime');
  const source = store.get('source');
  if (!realtime || source !== 'outlook') return;

  const intervalMs = (store.get('realtimeIntervalSec') || 60) * 1000;
  lastCheckIso = new Date().toISOString();

  realtimeTimer = setInterval(async () => {
    try {
      const newMails = await sync.syncNew(lastCheckIso, 50); // DB 저장 포함
      lastCheckIso = new Date().toISOString();
      if (newMails && newMails.length > 0) {
        // 렌더러에 알림
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('new-mails', newMails);
        }
        // 시스템 알림
        if (Notification.isSupported()) {
          const first = newMails[0];
          new Notification({
            title: `새 메일 ${newMails.length}건`,
            body: `${first.sender}: ${first.subject}`.slice(0, 120)
          }).show();
        }
      }
    } catch (e) {
      // Outlook 미실행 등 - 조용히 무시 (렌더러에 상태만)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('realtime-error', String(e));
      }
    }
  }, intervalMs);
}

// ============================================================
//  자동 업데이트 → 렌더러 전달
// ============================================================
function sendUpdateStatus(status, info) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-status', { status, info });
  }
}
autoUpdater.on('checking-for-update', () => sendUpdateStatus('checking'));
autoUpdater.on('update-available', (info) => sendUpdateStatus('available', info));
autoUpdater.on('update-not-available', () => sendUpdateStatus('none'));
autoUpdater.on('error', (err) => sendUpdateStatus('error', String(err)));
autoUpdater.on('download-progress', (p) => sendUpdateStatus('downloading', p));
autoUpdater.on('update-downloaded', (info) => {
  sendUpdateStatus('downloaded', info);
  dialog.showMessageBox(mainWindow, {
    type: 'info', buttons: ['지금 재시작', '나중에'], defaultId: 0,
    title: '업데이트 준비 완료',
    message: '새 버전이 다운로드되었습니다. 지금 재시작하여 적용할까요?'
  }).then((res) => { if (res.response === 0) autoUpdater.quitAndInstall(); });
});

// ============================================================
//  IPC 핸들러
// ============================================================

// --- 설정 ---
ipcMain.handle('config:get', () => store.store);
ipcMain.handle('config:set', (_e, newConfig) => {
  store.set(newConfig);
  startRealtimeIfNeeded(); // 실시간/소스 설정 변경 즉시 반영
  return store.store;
});

// --- PST 파일 선택 다이얼로그 ---
ipcMain.handle('dialog:pickPst', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'PST 파일 선택',
    properties: ['openFile'],
    filters: [{ name: 'Outlook 데이터 파일', extensions: ['pst', 'ost'] }]
  });
  if (res.canceled || !res.filePaths.length) return '';
  return res.filePaths[0];
});

// --- 연결 상태 확인 (Outlook 계정/스토어 목록) ---
ipcMain.handle('outlook:checkConnection', async () => {
  const source = store.get('source');
  if (source === 'pst') {
    const p = store.get('pstPath');
    const fs = require('fs');
    if (p && fs.existsSync(p)) return { ok: true, mode: 'pst', pstPath: p };
    return { ok: false, mode: 'pst', error: 'PST 파일이 설정되지 않았거나 존재하지 않습니다.' };
  }
  const r = await outlook.checkConnection();
  return { ...r, mode: 'outlook' };
});

// --- 메일 검색 (소스에 따라 Outlook COM 또는 PST) ---
ipcMain.handle('outlook:search', async (_e, { query, limit }) => {
  const max = limit || store.get('maxMails') || 50;
  const dateFilter = store.get('dateFilter') || { mode: '6months' };
  const source = store.get('source');
  if (source === 'pst') {
    const pstPath = store.get('pstPath');
    return await pst.searchMails(pstPath, query, max, dateFilter);
  }
  return await outlook.searchMails(query, max, dateFilter);
});

// --- 메일 상세 ---
ipcMain.handle('outlook:getMail', async (_e, { entryId }) => {
  const source = store.get('source');
  if (source === 'pst') {
    const pstPath = store.get('pstPath');
    const { mail } = await pst.getMailDetailAndAttachments(pstPath, entryId, false);
    return mail;
  }
  return await outlook.getMailDetail(entryId);
});

// --- 첨부파일 저장 → 경로 반환 ---
ipcMain.handle('outlook:saveAttachments', async (_e, { entryId }) => {
  const source = store.get('source');
  if (source === 'pst') {
    const pstPath = store.get('pstPath');
    const { savedPaths } = await pst.getMailDetailAndAttachments(pstPath, entryId, true);
    return savedPaths;
  }
  return await outlook.saveAttachments(entryId);
});

// --- 첨부 분석 (최대 5개) ---
ipcMain.handle('attachments:analyze', async (_e, { filePaths }) => {
  const files = (filePaths || []).slice(0, 5);
  const results = [];
  for (const fp of files) {
    try {
      const extracted = await attachments.extract(fp);
      results.push({ file: path.basename(fp), ok: true, ...extracted });
    } catch (err) {
      results.push({ file: path.basename(fp), ok: false, error: String(err) });
    }
  }
  return results;
});

// --- 사용자 직접 파일 선택 (최대 5개) ---
ipcMain.handle('dialog:pickFiles', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '분석할 첨부파일 선택 (최대 5개)',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '문서/표/이미지', extensions: ['pdf', 'xlsx', 'xls', 'csv', 'docx', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'txt'] }]
  });
  if (res.canceled) return [];
  return res.filePaths.slice(0, 5);
});

// --- Cerebras AI (키 5개 폴백) ---
ipcMain.handle('ai:chat', async (_e, { messages }) => {
  const keys = (store.get('apiKeys') || []).filter(k => k && k.trim());
  const model = store.get('model') || 'llama-3.3-70b';
  if (keys.length === 0) return { ok: false, error: 'API 키가 설정되지 않았습니다.' };
  return await cerebras.chat({ keys, model, messages });
});

// --- 수동 실시간 체크 (즉시 새 메일 가져오기) ---
ipcMain.handle('outlook:checkNew', async () => {
  const source = store.get('source');
  if (source !== 'outlook') return { ok: false, error: 'PST 모드에서는 실시간 확인이 지원되지 않습니다.' };
  try {
    const mails = await outlook.getNewMailsSince(lastCheckIso, 30);
    lastCheckIso = new Date().toISOString();
    return { ok: true, mails };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

// --- 앱 버전 / 업데이트 ---
ipcMain.handle('app:getVersion', () => app.getVersion());
ipcMain.handle('app:checkUpdate', async () => {
  try { await autoUpdater.checkForUpdates(); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e) }; }
});

// ============================================================
//  확장 IPC: DB / 동기화 / AI 분석 / 주소록 / 설정
// ============================================================
function requireDb() {
  if (!dbReady) throw new Error('DB가 초기화되지 않았습니다: ' + (dbInitError || 'better-sqlite3 재빌드 필요(npm run rebuild)'));
}
function getKeys() { return (store.get('apiKeys') || []).filter(k => k && k.trim()); }
function getModel() { return store.get('model') || 'llama-3.3-70b'; }

// --- DB 상태 ---
ipcMain.handle('db:status', () => ({ ready: dbReady, error: dbInitError, path: dbReady ? db.dbPath : '', fts: dbReady ? db.ftsEnabled : false }));

// --- 전체 동기화 (Outlook/PST → DB, 첨부 저장) ---
ipcMain.handle('sync:run', async () => {
  try {
    requireDb();
    const config = {
      source: store.get('source'),
      pstPath: store.get('pstPath'),
      dateFilter: store.get('dateFilter') || { mode: '6months' },
      maxMails: store.get('maxMails') || 2000,
      saveAttachments: store.get('saveAttachmentsOnSync') !== false
    };
    const onProgress = (phase, cur, total, msg) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sync-progress', { phase, cur, total, msg });
      }
    };
    const result = await sync.syncAll(config, onProgress);
    lastCheckIso = new Date().toISOString();
    return result;
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
});

// --- DB 메일 검색 (색인 기반) ---
ipcMain.handle('db:searchMails', (_e, opts) => {
  try { requireDb(); return { ok: true, mails: db.searchMails(opts || {}) }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// --- DB 최근 메일 ---
ipcMain.handle('db:recentMails', (_e, { limit, offset }) => {
  try { requireDb(); return { ok: true, mails: db.recentMails(limit || 100, offset || 0) }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// --- DB 메일 상세 + 첨부 ---
ipcMain.handle('db:getMail', (_e, { id }) => {
  try {
    requireDb();
    const mail = db.getMailById(id);
    if (!mail) return { ok: false, error: '메일을 찾을 수 없습니다.' };
    const atts = db.getAttachmentsByMail(id);
    const analyses = db.getAnalyses(id);
    return { ok: true, mail, attachments: atts, analyses };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// --- 통계 (대시보드) ---
ipcMain.handle('db:stats', () => {
  try { requireDb(); return { ok: true, stats: db.stats(), lastSyncAt: db.getState('lastSyncAt') }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// --- AI 브리핑 (기간 내 메일 종합) ---
ipcMain.handle('ai:briefing', async (_e, { mode }) => {
  try {
    requireDb();
    const keys = getKeys();
    if (!keys.length) return { ok: false, error: 'API 키가 설정되지 않았습니다.' };
    // 기간 결정
    let sinceTs, label;
    const now = Date.now();
    if (mode === 'week') { sinceTs = now - 7 * 864e5; label = '최근 7일'; }
    else if (mode === 'today') { const d = new Date(); d.setHours(0,0,0,0); sinceTs = d.getTime(); label = '오늘'; }
    else { sinceTs = now - 30 * 864e5; label = '최근 30일'; }
    const mails = db.mailsInRange(sinceTs, null, 300);
    const res = await analyzer.briefing({ keys, model: getModel(), mails, periodLabel: label });
    if (res.ok) db.addAnalysis(null, 'briefing', res.content, 'ko', { mode, count: mails.length });
    return { ...res, count: mails.length, period: label };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// --- AI 번역/분석 (특정 메일) ---
ipcMain.handle('ai:translate', async (_e, { id }) => {
  try {
    requireDb();
    const keys = getKeys();
    if (!keys.length) return { ok: false, error: 'API 키가 설정되지 않았습니다.' };
    const mail = db.getMailById(id);
    if (!mail) return { ok: false, error: '메일을 찾을 수 없습니다.' };
    const res = await analyzer.translateAnalyze({ keys, model: getModel(), mail });
    if (res.ok) db.addAnalysis(id, 'translate', res.content, mail.lang || '');
    return res;
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// --- AI 답장 초안 ---
ipcMain.handle('ai:draftReply', async (_e, { id, instruction, tone, replyLang }) => {
  try {
    requireDb();
    const keys = getKeys();
    if (!keys.length) return { ok: false, error: 'API 키가 설정되지 않았습니다.' };
    const mail = db.getMailById(id);
    if (!mail) return { ok: false, error: '메일을 찾을 수 없습니다.' };
    const res = await analyzer.draftReply({ keys, model: getModel(), mail, instruction, tone, replyLang });
    if (res.ok) db.addAnalysis(id, 'reply', res.content, replyLang || mail.lang || '');
    return res;
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// --- AI 대화형 질의 (DB 검색결과를 근거로) ---
ipcMain.handle('ai:chatMails', async (_e, { question, history }) => {
  try {
    requireDb();
    const keys = getKeys();
    if (!keys.length) return { ok: false, error: 'API 키가 설정되지 않았습니다.' };
    // 질문에서 키워드로 관련 메일 검색
    const contextMails = db.searchMails({ query: question, limit: 12 });
    const res = await analyzer.chatOverMails({ keys, model: getModel(), question, contextMails, history: history || [] });
    return { ...res, contextCount: contextMails.length };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// --- 주소록 가져오기 (Outlook → DB) ---
ipcMain.handle('contacts:import', async () => {
  try {
    requireDb();
    if (store.get('source') !== 'outlook') {
      return { ok: false, error: '주소록 가져오기는 Outlook 연동 모드에서만 지원됩니다.' };
    }
    const contacts = await outlook.getContacts(5000);
    const n = db.upsertContactsBatch(contacts);
    return { ok: true, imported: n, total: db.listContacts(1).length ? db.stats().contacts : n };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// --- 주소록 목록 (DB) ---
ipcMain.handle('contacts:list', (_e, { query, limit }) => {
  try { requireDb(); return { ok: true, contacts: db.listContacts(limit || 500, query || '') }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// --- Outlook 계정/설정 정보 가져오기 ---
ipcMain.handle('outlook:getSettings', async () => {
  try {
    const s = await outlook.getAccountSettings();
    return s;
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// --- 저장된 첨부/파일을 탐색기에서 열기 ---
ipcMain.handle('shell:showItem', (_e, { path: p }) => {
  try { shell.showItemInFolder(p); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
});
ipcMain.handle('shell:openPath', async (_e, { path: p }) => {
  try { const r = await shell.openPath(p); return { ok: !r, error: r }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
});
