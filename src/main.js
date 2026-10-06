// ============================================================
//  Bmail - 메인 프로세스 (Electron main)
//  - 창 생성 / 자동 업데이트
//  - Outlook(COM, 실시간) 또는 PST(파일 직접) 연동
//  - 날짜 필터(기본 6개월 / 전체 / 기간)
//  - 실시간 새 메일 폴링
//  - 첨부파일 분석 + Cerebras 호출 (키 5개 폴백)
// ============================================================
// ============================================================
//  ★ 로그 파이프 방어 (2026-08-14 실측 사고)
//  ------------------------------------------------------------
//  앱을 스크립트로 띄운 뒤 부모 프로세스가 먼저 끝나면 stdout 파이프가 닫힌다.
//  그 상태에서 console.log 가 호출되면 EPIPE 가 uncaught 로 터져
//  "A JavaScript error occurred in the main process" 대화상자가 마스터 화면에 뜬다.
//   → ① 스트림 error 를 삼키고 ② 콘솔 출력을 안전 래퍼로 감싸고
//     ③ uncaughtException 에서 EPIPE 만 무시한다(그 외는 기록).
// ============================================================
for (const stream of [process.stdout, process.stderr]) {
  try { stream.on('error', () => { /* EPIPE 등 — 앱은 계속 돈다 */ }); } catch (e) { /* noop */ }
}
for (const m of ['log', 'error', 'warn', 'info', 'debug']) {
  const orig = console[m] ? console[m].bind(console) : null;
  if (!orig) continue;
  console[m] = (...args) => { try { orig(...args); } catch (e) { /* 파이프가 닫혔다 — 무시 */ } };
}
process.on('uncaughtException', (err) => {
  const code = err && (err.code || '');
  if (code === 'EPIPE' || /EPIPE/i.test(String(err && err.message))) return;   // 대화상자 노출 금지
  try { console.error('[uncaughtException]', err); } catch (e) { /* noop */ }
});
process.on('unhandledRejection', (reason) => {
  try { console.error('[unhandledRejection]', reason); } catch (e) { /* noop */ }
});

const { app, BrowserWindow, WebContentsView, ipcMain, dialog, shell, Notification, session, screen } = require('electron');
const path = require('path');
const fsMain = require('fs');   // PST 파일 크기 등 진단용
const { spawn } = require('child_process');   // 정리 작업 별도 프로세스 실행
const Store = require('electron-store');

const outlook = require('./outlook');       // Outlook COM (실시간)
const pst = require('./pst');               // PST 파일 직접 파싱
const attachments = require('./attachments'); // 첨부 분석
const cerebras = require('./cerebras');     // Cerebras (키 5개 폴백)
const db = require('./db');                 // 로컬 SQLite DB (색인/저장)
const sync = require('./sync');             // 동기화 엔진
const analyzer = require('./analyzer');     // AI 분석(브리핑/번역/답장)
const bigmail = require('./bigmail');       // 대용량 첨부 업로드(bigmail 연동)
const exporter = require('./exporter');     // 통합 대시보드 HTML · 엑셀 내보내기
const timelineAgg = require('./timeline-agg');   // 검색/대화 결과 4탭(타임라인/목록/사람별/키워드별) 집계
const actionState = require('./action-state');
const attachClassify = require('./attach-classify');   // 진짜 첨부 vs 인라인 이미지 판정
const attachContent = require('./attach-content');      // 첨부 '내용' 추출→캐시→분석 프롬프트 주입(1단계)
const organizeAttach = require('./attach-organize');   // 대화로 첨부 정리(계획·안전·실행)
const aiErrors = require('./ai-errors');               // AI 실패 → 사람이 읽는 문구
const aiProviders = require('./ai-providers');          // AI 제공자 프리셋(Cerebras/Groq/Gemini/OpenRouter/사용자지정)
const sentAxis = require('./sent-axis');   // 보낸메일 분류 축(날짜별·이벤트별) 순수 집계 // 메일별 내 처리 상태(할일/보류/처리/확인) 정의·자동제안
const linkDownload = require('./link-download');   // 본문 링크 클릭 → 파일/대용량첨부는 숨김창에서 바로 다운로드
const replyNeeded = require('./reply-needed');   // 회신 필요성(의미) LLM 판정층 — 기존 미회신(사실) 후보 위에 얹는다

// ============================================================
//  ★ 데이터 경로 고정 (절대 변경 금지)
//  ------------------------------------------------------------
//  Electron 의 userData 는 앱 이름(package.json name / productName)에서
//  파생된다. 따라서 앱 이름을 바꾸면(예: Outlook → Bmail) 경로가 바뀌어
//  기존 메일 DB·설정·첨부가 통째로 "사라진 것처럼" 보인다.
//  → 이름과 무관하게 항상 이 경로를 쓰도록 고정한다.
//  ※ electron-store 는 생성 시점에 userData 를 읽으므로 store 선언보다 먼저 실행해야 한다.
// ============================================================
const FIXED_USER_DATA_DIR = 'outlook-ai-assistant';
try {
  app.setPath('userData', path.join(app.getPath('appData'), FIXED_USER_DATA_DIR));
  app.setName('Bmail');   // 표시 이름만 변경 (경로는 위에서 이미 고정됨)
} catch (e) {
  console.error('userData 경로 고정 실패:', e);
}

// ============================================================
//  기본 AI 제공자 체인(순위 순) — 앞이 막히면 뒤로 자동 전환
//  ★ 2026-09-28 마스터 지시: "절대 무료로만" — Cerebras(유료 전환, 잔액 $0)는 체인에서 제거.
//    1순위 OpenRouter(:free 모델만, 코드 레벨에서 강제), 2순위 Groq(무료, 최후 폴백).
//    실측(RECON.md): OpenRouter 무료 모델 실호출 비교로 상위 3개(models[] 폴백)를 골랐다.
//  ⚠ 키는 여기에 절대 하드코딩하지 않는다 — userData 설정(electron-store)에만 저장한다
//    (마스터가 준 키는 1회성 마이그레이션 스크립트로 그 파일에 직접 써 넣었다, 소스 무관).
//    새 설치 등으로 store 가 비어 있으면 키 없이 시작하고, 설정 화면에서 등록해야 한다.
//  ※ store.store 는 '저장된 값'이 기본값을 이긴다 → 복구용으로는 이 상수를 쓴다.
// ============================================================
const DEFAULT_AI_CHAIN = [
      {
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
        models: ['nvidia/nemotron-3-ultra-550b-a55b:free', 'nvidia/nemotron-3-super-120b-a12b:free', 'cohere/north-mini-code:free'],
        keys: [],
        enabled: true
      },
      {
        provider: 'groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        model: 'openai/gpt-oss-120b',
        keys: [],
        enabled: true
      }
];

// 로컬 설정 저장 (PIN/인증 없음 — 로컬 전용)
const store = new Store({
  name: 'outlook-ai-config',
  defaults: {
    // 레거시 필드 — 실제 호출에 쓰이는 정본은 아래 aiChain(제공자 체인)이다.
    //  ★ 2026-09-28: 키 하드코딩 제거(마스터 지시) — 소스에는 절대 키를 두지 않는다.
    //    실제 키는 userData/outlook-ai-config.json(electron-store)에만 있다.
    apiKeys: [],
    // 기본 모델 = 1순위 제공자(OpenRouter)의 무료 모델
    model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    // AI 제공자 (설정 화면에서 전환·추가 가능)
    aiProvider: 'openrouter',
    aiBaseUrl: '',
    apiKeysByProvider: {},
    // 제공자 체인(순위 순) — 기본값은 위 DEFAULT_AI_CHAIN 상수
    aiChain: DEFAULT_AI_CHAIN,
    maxMails: 5000,
    // 연동 방식: 'outlook'(COM,실시간) | 'pst'(파일직접)
    source: 'outlook',
    pstPath: '',
    // 날짜 필터: mode '6months'(기본) | 'all' | 'range'
    dateFilter: { mode: '6months', start: '', end: '' },
    // 실시간 새 메일 확인
    realtime: true,
    realtimeIntervalSec: 60,          // 구버전 호환
    realtimeIntervalMin: 3,           // 새 메일 확인 주기(분): 1/3/5/10
    syncNewOnStart: true,             // 앱 시작 시 증분 1회
    notifyNewMail: true,              // 새 메일 데스크톱 알림
    // 답장·새 메일에 Outlook 서명(.htm 원본)을 그대로 적용
    useOutlookSignature: true,
    // 사용할 서명 이름 (빈 값 = Outlook 첫 서명 = 기본 서명 따름)
    signatureName: '',
    // 보낸 편지함 기본 보기: 'grouped'(프로젝트 분류) | 'list'(평면 목록)
    sentViewMode: 'grouped',
    // 대용량 첨부(bigmail) — 마스터 소유 파일 공유 서비스
    //  링크는 '요청을 보낸 주소' 기준으로 만들어지므로 기본값을 커스텀 도메인으로 둔다.
    bigmailBase: 'https://bigmail.sedms.app',
    bigmailKey: 'BM-INT-WEAR-S001',     // 내부 무제한 슬롯 (S001~S010)
    bigmailExpireDays: 7,
    bigmailUsePassword: false,
    // 동기화 시 첨부(도면 등) 자동 저장
    saveAttachmentsOnSync: true,
    // 받은편지함/보낸편지함의 하위 폴더까지 수집 (업무별로 분류해 둔 메일 포함)
    includeSubfolders: true,
    subfolderDepth: 5,          // Outlook 실측 최대 깊이 4 → 여유 5
    includeDeleted: false,      // 지운 편지함 수집 (기본 OFF)
    // Outlook 에 추가로 마운트된 아카이브 PST(예: 백업.pst)까지 수집 (기본 OFF - 용량/시간 큼)
    includeArchiveStores: false,
    archiveDepth: 6,
    // 수집 대상 아카이브 스토어 이름 목록
    //  null(미설정) = 연결된 아카이브 전부 / 배열 = 그 목록만 / 빈 배열 = 아카이브 수집 안 함
    archiveStoreNames: null,
    // 동기화할 때 Outlook 주소록을 자동으로 가져오기
    autoImportContacts: true,
    // 메일을 열 때 자동으로 번역/분석 실행 (기본 OFF - AI 사용량)
    autoAnalyzeOnOpen: false,
    // AI 답장 초안 언어: 'auto'(원문 따름·기본) | 'ko'(항상 한국어) | 'en'(항상 영어)
    replyLang: 'auto',
    // 프로젝트·조직 그룹의 활동성 구간(일). 진행 중 프로젝트가 항상 위로 오게 하는 기준.
    projectActiveDays: 90,     // 이 기간 안에 활동 = '진행 중'
    projectRecentDays: 365,    // 이 기간 안에 활동 = '최근' / 초과 = '지난 프로젝트'(접힘)
    // 내보내기(대시보드 HTML·엑셀) 저장 루트. 빈 값 = 문서\Bmail
    exportRoot: '',
    // 로컬 정리 — 자동 스캔은 '보고만' 한다(삭제는 사용자가 누를 때만)
    cleanupAuto: true,
    cleanupFromHour: 9,
    cleanupToHour: 18,
    cleanupKeepDays: 30,        // 내보내기 산출물 보관 기간
    cleanupRssLimitMb: 400,     // 정리 프로세스 메모리 상한(넘으면 즉시 중단)
    // 실시간 전체 갱신 — 새 메일뿐 아니라 읽음·이동·범주·깃발 변경까지 같은 주기로 반영
    autoRefreshAll: true,
    deferWhenBusy: true,        // 사용자가 조작 중이면 무거운 갱신을 다음 주기로 미룸
    refreshOnFocus: true,       // 창을 다시 볼 때 1회 즉시 갱신
    // 메일별 처리 상태
    actionPropagateThread: false,   // 같은 스레드의 과거 메일까지 함께 지정 (기본 OFF)
    followupExcludeClosed: true,    // '처리'·'확인' 표시한 메일을 회신대기에서 제외
    // 분석 결과 교차 검증 — 등록된 제공자가 2개 이상이면 2경로로 병렬 호출해 핵심 필드를 대조한다.
    crossValidate: true
  }
});

// DB 초기화 상태
let dbReady = false;
let dbInitError = '';

let mainWindow = null;
let realtimeTimer = null;
let lastCheckIso = new Date().toISOString();
let pollCount = 0;             // 폴더 트리 갱신 주기 계산용

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 860, minWidth: 980, minHeight: 640,
    title: 'Bmail',
    icon: path.join(__dirname, 'renderer', 'assets', 'icon.ico'),
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      //  첨부 미리보기: Chromium 내장 PDF 뷰어(iframe file://)를 쓰기 위해 필요
      plugins: true
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
  // 링크는 앱 창 안에서 열지 않는다 — 새 창 요청·페이지 이동 모두 openLink(분류: 다운로드/외부/무시) 한 곳으로
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { openLink(url); return { action: 'deny' }; });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (/^(https?|mailto):/i.test(url)) { e.preventDefault(); openLink(url); }
  });

  // ★ 창을 다시 볼 때 1회 즉시 갱신 — 자리를 비운 사이 바뀐 내용을 바로 반영한다.
  //   너무 잦은 호출을 막기 위해 최소 간격(30초)을 둔다.
  let lastFocusRefresh = 0;
  mainWindow.on('focus', () => {
    if (store.get('refreshOnFocus') === false) return;
    if (store.get('source') !== 'outlook' || store.get('realtime') === false) return;
    const now = Date.now();
    if (now - lastFocusRefresh < 30000) return;
    lastFocusRefresh = now;
    setTimeout(() => { pollNewMails('focus').catch(() => {}); }, 400);
  });
  // mainWindow.webContents.openDevTools();
}

app.whenReady().then(() => {
  // DB 초기화 (userData 하위)
  try {
    const userData = app.getPath('userData');
    db.init(userData);
    // API 키 라운드로빈 위치를 DB 에 영속 (앱 재시작에도 특정 키 편중 방지)
    cerebras.setKeyStateStore({
      get: () => db.getState('cerebrasKeyIdx'),
      set: (v) => db.setState('cerebrasKeyIdx', v)
    });
    sync.setAttachRoot(path.join(userData, 'attachments'));
    dbReady = true;
  } catch (e) {
    dbInitError = String(e && e.message ? e.message : e);
    console.error('DB 초기화 실패:', dbInitError);
  }

  migrateAiChain();         // 제공자 체인이 비어 있으면 기본값(Groq 1순위)으로 채운다
  //  하루 사용량은 재시작해도 이어져야 한다(무료 한도는 하루 단위)
  cerebras.setUsageStore({
    get: () => store.get('aiUsage'),
    set: (v) => store.set('aiUsage', v)
  });
  applyAiConfig();          // 저장된 AI 제공자로 엔드포인트 세팅
  createWindow();
  // ★ 로컬 전용 앱이라 업데이트 서버가 없다 → 확인 자체를 끈다.
  //   (좌하단에 '업데이트 확인 실패' 빨간 문구가 상시 노출되던 원인)

  startRealtimeIfNeeded();
  scheduleNextCleanup();      // 자동 정리 스캔 예약 (업무시간 매시 정각 · 삭제 안 함)

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
const send = (channel, payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
};

// 폴링 기준 시각: 앱이 꺼져 있던 동안 도착한 메일도 받도록 DB 에 저장해 둔 시각을 쓴다
function getRealtimeSince() {
  try {
    const saved = db.getState('lastRealtimeAt') || db.getState('lastSyncAt');
    if (saved) return saved;
  } catch (_) {}
  return new Date(Date.now() - 3600000).toISOString();   // 정보 없으면 1시간 전부터
}
function setRealtimeSince(iso) {
  lastCheckIso = iso;
  try { db.setState('lastRealtimeAt', iso); } catch (_) {}
}

// ============================================================
//  변경된 폴더만 골라 상태를 반영 (읽음·이동·범주·깃발·삭제)
//  ------------------------------------------------------------
//  비용 통제
//   · 1단계: 폴더 지문(건수·안읽음·최신시각)만 읽는다 — Items 열거 없음.
//   · 2단계: 지문이 달라진 폴더만, 그것도 최대 MAX_FOLDERS 개까지만 상세 조회.
//   · 사용자가 조작 중이면(uiBusy) 무거운 2단계를 건너뛴다.
// ============================================================
const MAX_REFRESH_FOLDERS = 6;      // 한 주기에 상세 조회할 폴더 수 상한
let uiBusy = false;                 // 렌더러가 알려 주는 '사용자 조작 중' 플래그
let lastRefreshInfo = null;

async function refreshChangedFolders(reason = 'poll') {
  if (store.get('source') !== 'outlook') return { ok: false, skipped: 'pst' };
  if (store.get('autoRefreshAll') === false) return { ok: false, skipped: 'off' };

  const t0 = Date.now();
  const fp = await outlook.folderFingerprints({ maxDepth: Number(store.get('subfolderDepth')) || 5 });
  if (!fp.ok) return { ok: false, error: fp.error };
  const diff = db.diffFolderFingerprints(fp.folders || []);
  const out = {
    ok: true, reason, scannedFolders: diff.total,
    changed: diff.changed.length, gone: diff.gone.length,
    treeStale: diff.gone.length > 0 || diff.total !== (lastRefreshInfo ? lastRefreshInfo.scannedFolders : diff.total),
    fingerprintMs: Date.now() - t0
  };
  // 첫 실행은 기준선만 잡는다(전 폴더가 '변경'으로 잡히므로 상세 조회하지 않는다)
  if (diff.firstRun) { out.baseline = true; lastRefreshInfo = out; return out; }
  if (!diff.changed.length) { lastRefreshInfo = out; return out; }
  // 사용자가 조작 중이면 무거운 2단계는 다음 주기로 미룬다(마스터 제약: 작업 방해 금지)
  if (uiBusy && store.get('deferWhenBusy') !== false) { out.deferred = true; lastRefreshInfo = out; return out; }

  // 변경이 큰 폴더부터 (최신시각이 바뀐 폴더가 우선)
  const targets = diff.changed.slice(0, MAX_REFRESH_FOLDERS);
  const t1 = Date.now();
  const st = await outlook.folderItemStates(targets.map(t => t.path), { limit: 400 });
  if (!st.ok) { out.error = st.error; lastRefreshInfo = out; return out; }
  out.detailMs = Date.now() - t1;
  out.changedFolders = targets.map(t => t.name);
  // 삭제 반영은 '폴더 전체를 다 본 경우'에만 안전하다 → 400건 상한에 걸리지 않은 폴더만 대상
  const fullyScanned = targets.filter(t => Number(t.items) > 0 && Number(t.items) <= 400).map(t => t.name);
  out.applied = db.applyItemStates(st.items || [], {
    markMissingAsRemoved: fullyScanned.length > 0,
    scannedFolders: fullyScanned
  });
  out.totalMs = Date.now() - t0;
  lastRefreshInfo = out;
  return out;
}

ipcMain.handle('realtime:refreshNow', async () => {
  try { return await pollNewMails('manual'); }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
});
ipcMain.handle('realtime:setBusy', (_e, { busy } = {}) => { uiBusy = !!busy; return { ok: true, busy: uiBusy }; });
ipcMain.handle('realtime:info', () => ({ ok: true, info: lastRefreshInfo }));

// 새 메일 1회 확인 (폴링/시작 시 공용)
//  ★ 시작·수동 확인은 '따라잡기' 창을 넓게 잡는다 (2026-08-04).
//    이전에 DASL 날짜 오차(9시간)로 놓친 메일은 lastRealtimeAt 이 이미 앞서 있어
//    좁은 창(마지막 확인 이후)만 보면 영원히 복구되지 않는다.
//    같은 entry_id 는 upsert 로 합쳐지므로 중복 저장 위험은 없다.
const CATCHUP_HOURS = 72;
async function pollNewMails(reason = 'poll') {
  let since = lastCheckIso || getRealtimeSince();
  let limit = 50;
  if (reason === 'startup' || reason === 'manual') {
    const floor = new Date(Date.now() - CATCHUP_HOURS * 3600 * 1000).toISOString();
    if (!since || since > floor) since = floor;
    limit = 300;
  }
  const startedAt = new Date().toISOString();
  try {
    const scanned = await sync.syncNew(since, limit);    // DB 저장 + id 부여
    // 따라잡기 창에는 이미 저장된 메일도 섞여 들어온다 → 진짜 신규만 UI·알림에 쓴다
    const newMails = scanned.filter(m => m.isNew);
    console.log(`[poll:${reason}] since=${since} 조회 ${scanned.length}건 · 신규 ${newMails.length}건`);
    if (newMails.length) { try { db.backfillToMe({ force: false }); } catch (_) {} }
    setRealtimeSince(startedAt);

    pollCount++;
    // ★ 새 메일뿐 아니라 '이미 있던 메일의 변화'(읽음·이동·범주·깃발)까지 같은 주기로 반영한다.
    //   폴더 지문을 먼저 떠서 **바뀐 폴더만** 상세 조회한다(전량 스캔 금지).
    let refresh = null;
    try { refresh = await refreshChangedFolders(reason); } catch (e) { refresh = { ok: false, error: String(e.message || e) }; }

    // 폴더 트리·즐겨찾기 갱신 신호
    //  ★ 즐겨찾기 변경은 폴더 건수를 바꾸지 않아 지문으로 잡히지 않는다.
    //    → 구조 변화가 감지될 때 + 3회 주기마다(기본 9분) 한 번은 반드시 다시 읽는다.
    if (reason === 'startup' || reason === 'manual' || reason === 'focus' ||
        (refresh && refresh.treeStale) || pollCount % 3 === 0) {
      send('folder-tree-stale', { reason });
    }
    send('realtime-status', { ok: true, at: startedAt, count: newMails.length, reason, refresh });
    if (refresh && refresh.ok && refresh.applied &&
        (refresh.applied.readChanged || refresh.applied.movedChanged || refresh.applied.metaChanged || refresh.applied.removed)) {
      send('mails-updated', { reason, applied: refresh.applied, folders: refresh.changedFolders });
    }
    if (newMails.length) {
      send('new-mails', newMails);
      if (store.get('notifyNewMail') !== false && Notification.isSupported()) {
        const first = newMails[0];
        const n = new Notification({
          title: newMails.length > 1 ? `새 메일 ${newMails.length}건` : '새 메일',
          body: `${first.sender_name || first.sender || ''}: ${first.subject || ''}`.slice(0, 120)
        });
        // 알림 클릭 → 해당 메일 열기
        n.on('click', () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
            if (first.id) send('open-mail', { id: first.id });
          }
        });
        n.show();
      }
    }
    return { ok: true, count: newMails.length, mails: newMails };
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    // Outlook 미실행 등 — 조용히 삼키지 않고 상태를 정직하게 알린다(라벨이 '대기'로 바뀜)
    send('realtime-status', { ok: false, at: startedAt, error: msg, reason });
    return { ok: false, error: msg };
  }
}

function startRealtimeIfNeeded() {
  if (realtimeTimer) { clearInterval(realtimeTimer); realtimeTimer = null; }
  const realtime = store.get('realtime');
  const source = store.get('source');
  if (!realtime || source !== 'outlook') {
    send('realtime-status', { ok: false, disabled: true, error: source !== 'outlook' ? 'PST 모드에서는 실시간 수신이 없습니다.' : '실시간 확인이 꺼져 있습니다.' });
    return;
  }

  // 분 단위 설정 (1/3/5/10분, 기본 3분). 구버전의 초 단위 값도 계속 지원.
  const min = Number(store.get('realtimeIntervalMin'));
  const intervalMs = (min > 0 ? min * 60 : (store.get('realtimeIntervalSec') || 180)) * 1000;

  lastCheckIso = getRealtimeSince();

  // 앱 시작 시 증분 1회 — 첫 폴링을 3분 기다리지 않는다(창이 뜨자마자 최신분을 당겨온다).
  //  1.2초만 늦추는 이유: 렌더러가 첫 화면을 그린 뒤 new-mails 이벤트를 받게 하기 위함.
  if (store.get('syncNewOnStart') !== false) {
    setTimeout(() => pollNewMails('startup'), 1200);
  }
  realtimeTimer = setInterval(() => pollNewMails('poll'), intervalMs);
}

// 자동 업데이트 없음 — 사내 로컬 전용 앱이라 배포 채널이 없다.
//  (예전에는 autoUpdater 가 좌하단에 '업데이트 확인 실패'를 상시 노출했다.
//   호출부만 지우면 이벤트 핸들러가 고아로 남으므로 경로 전체를 제거했다.)

// ============================================================
//  IPC 핸들러
// ============================================================

// --- 설정 ---
ipcMain.handle('config:get', () => store.store);
ipcMain.handle('config:set', (_e, newConfig) => {
  store.set(newConfig);
  startRealtimeIfNeeded(); // 실시간/소스 설정 변경 즉시 반영
  applyAiConfig();         // AI 제공자/URL/모델 변경 즉시 반영
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
  const model = store.get('model') || 'gpt-oss-120b';
  if (keys.length === 0) return { ok: false, error: 'API 키가 설정되지 않았습니다.' };
  return await cerebras.chat({ keys, model, messages });
});

// --- 수동 실시간 체크 (즉시 새 메일 가져오기) ---
ipcMain.handle('outlook:checkNew', async () => {
  const source = store.get('source');
  if (source !== 'outlook') return { ok: false, error: 'PST 모드에서는 실시간 확인이 지원되지 않습니다.' };
  const r = await pollNewMails('manual');
  return r.ok ? { ok: true, mails: r.mails } : { ok: false, error: r.error };
});

// --- 앱 버전 ---
ipcMain.handle('app:getVersion', () => app.getVersion());

// ============================================================
//  확장 IPC: DB / 동기화 / AI 분석 / 주소록 / 설정
// ============================================================
// ============================================================
//  자연어 질문 → 검색 그라운딩
//  ------------------------------------------------------------
//  "선급에서 온 메일 찾아줘" 를 그대로 FTS 에 넣으면
//  '선급에서'(조사 포함) 토큰이 매칭되지 않아 0건이 된다.
//  → 불용어 제거 + 한국어 조사 제거 후 검색하고,
//    키워드 적중 수로 재정렬해 상위 N건을 근거로 넘긴다.
// ============================================================
const NL_STOPWORDS = new Set([
  '메일', '이메일', '메세지', '메시지', '내용', '관련', '관련된', '대해', '대한', '좀', '것', '거',
  '찾아줘', '찾아', '찾기', '검색', '검색해줘', '보여줘', '보여', '알려줘', '알려', '해줘', '줘',
  '목록', '리스트', '전부', '모두', '어떤', '무슨', '뭐', '뭔', '있어', '있나', '있는', '왔어', '왔나',
  '온', '오는', '받은', '보낸', '누가', '언제', '어디', '어제', '오늘', '요약', '정리', '해', '및', '그리고'
]);
const KO_PARTICLES = [
  '에서는', '에서도', '에서', '에게서', '에게는', '에게', '한테서', '한테', '께서', '으로는', '으로',
  '이랑', '하고', '에는', '에도', '부터', '까지', '이나', '라도', '보다', '처럼', '만큼',
  '을', '를', '이', '가', '은', '는', '의', '와', '과', '도', '만', '로', '에'
];

function stripParticle(token) {
  for (const p of KO_PARTICLES) {
    if (token.length > p.length + 1 && token.endsWith(p)) return token.slice(0, -p.length);
  }
  return token;
}

function extractKeywords(question) {
  const raw = String(question || '')
    .replace(/["'`?!.,~]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const out = [];
  for (const t of raw) {
    if (NL_STOPWORDS.has(t)) continue;
    const s = /[가-힣]/.test(t) ? stripParticle(t) : t;
    if (!s || s.length < 2) continue;
    if (NL_STOPWORDS.has(s)) continue;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

// ============================================================
//  ★ 자연어 복합 조건 파서 (로컬 전용 — AI 키 없이도 동작)
//  ------------------------------------------------------------
//  "설병헌이 보낸 TRANSFORMER 관련 메일 찾아줘"
//    → { sender:'설병헌', keywords:['TRANSFORMER'] }
//  지원 조건: 보낸사람 / 받는사람 / 키워드 / 첨부 / 기간 / 폴더 / 안읽음
// ============================================================
const KO_UNITS = { 오늘: 0, 어제: 1, 그제: 2, 그저께: 2 };

// ------------------------------------------------------------
//  날짜 표현 → {sinceTs, untilTs, label, matched} (자연어 파서·필드문법(기간:) 공용)
//  ★ 2026-09 확장: 필드 문법 "기간:2026-08"(연-월) 지원을 위해 기존 로직에서 추출.
// ------------------------------------------------------------
function parseDateExpr(str) {
  const q = ` ${String(str || '')} `;
  const now = new Date();
  const dayStart = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
  const dayEnd = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x.getTime(); };
  let dm;
  if ((dm = q.match(/(오늘|어제|그제|그저께)/))) {
    const d = new Date(now); d.setDate(d.getDate() - KO_UNITS[dm[1]]);
    return { sinceTs: dayStart(d), untilTs: dayEnd(d), label: dm[1], matched: dm[0] };
  } else if ((dm = q.match(/(?:최근|지난)\s*(\d{1,3})\s*(일|주|개월|달)/))) {
    const n = parseInt(dm[1], 10);
    const mult = dm[2] === '일' ? 1 : (dm[2] === '주' ? 7 : 30);
    return { sinceTs: now.getTime() - n * mult * 864e5, untilTs: null, label: `최근 ${n}${dm[2]}`, matched: dm[0] };
  } else if (/지난\s*주|저번\s*주/.test(q)) {
    const mondayThis = new Date(now);
    const dow = (mondayThis.getDay() + 6) % 7;
    mondayThis.setDate(mondayThis.getDate() - dow);
    const mondayLast = new Date(mondayThis); mondayLast.setDate(mondayLast.getDate() - 7);
    const sundayLast = new Date(mondayThis); sundayLast.setDate(sundayLast.getDate() - 1);
    return { sinceTs: dayStart(mondayLast), untilTs: dayEnd(sundayLast), label: '지난 주', matched: q.match(/지난\s*주|저번\s*주/)[0] };
  } else if (/이번\s*주|금주/.test(q)) {
    const monday = new Date(now);
    const dow2 = (monday.getDay() + 6) % 7;
    monday.setDate(monday.getDate() - dow2);
    return { sinceTs: dayStart(monday), untilTs: null, label: '이번 주', matched: q.match(/이번\s*주|금주/)[0] };
  } else if ((dm = q.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/))) {
    let y = now.getFullYear();
    let d = new Date(y, +dm[1] - 1, +dm[2]);
    if (d.getTime() - now.getTime() > 7 * 864e5) d = new Date(y - 1, +dm[1] - 1, +dm[2]);
    return { sinceTs: dayStart(d), untilTs: dayEnd(d), label: `${d.getFullYear()}-${String(+dm[1]).padStart(2, '0')}-${String(+dm[2]).padStart(2, '0')}`, matched: dm[0] };
  } else if (/지난\s*달|저번\s*달|전\s*달/.test(q)) {
    //  ★ "지난달 김정인이 보낸 도면 메일" — 지난달 1일~말일
    const y = now.getFullYear(); const mo = now.getMonth() - 1;
    const start = new Date(y, mo, 1), end = new Date(y, mo + 1, 0);
    return { sinceTs: dayStart(start), untilTs: dayEnd(end), label: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`, matched: q.match(/지난\s*달|저번\s*달|전\s*달/)[0] };
  } else if (/이번\s*달|이달/.test(q)) {
    return { sinceTs: dayStart(new Date(now.getFullYear(), now.getMonth(), 1)), untilTs: null, label: '이번 달', matched: q.match(/이번\s*달|이달/)[0] };
  } else if ((dm = q.match(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/))) {
    const d = new Date(+dm[1], +dm[2] - 1, +dm[3]);
    return { sinceTs: dayStart(d), untilTs: dayEnd(d), label: `${dm[1]}-${String(dm[2]).padStart(2, '0')}-${String(dm[3]).padStart(2, '0')}`, matched: dm[0] };
  } else if ((dm = q.match(/(\d{4})[-./](\d{1,2})(?![\d\/.])/))) {
    //  ★ "기간:2026-08" — 연-월 단위(그 달 전체)
    const y = +dm[1], mo = +dm[2] - 1;
    const start = new Date(y, mo, 1), end = new Date(y, mo + 1, 0);
    return { sinceTs: dayStart(start), untilTs: dayEnd(end), label: `${dm[1]}-${String(dm[2]).padStart(2, '0')}`, matched: dm[0] };
  } else if ((dm = q.match(/(\d{1,2})\s*[\/.]\s*(\d{1,2})\s*[~\-]\s*(\d{1,2})\s*[\/.]\s*(\d{1,2})(?![\d\/.])/))) {
    //  ★ "8/1~8/20" 범위(같은 해, 미래면 작년으로)
    let y = now.getFullYear();
    let start = new Date(y, +dm[1] - 1, +dm[2]);
    let end = new Date(y, +dm[3] - 1, +dm[4]);
    if (start.getTime() - now.getTime() > 7 * 864e5) { y -= 1; start = new Date(y, +dm[1] - 1, +dm[2]); end = new Date(y, +dm[3] - 1, +dm[4]); }
    return {
      sinceTs: dayStart(start), untilTs: dayEnd(end),
      label: `${start.getFullYear()}-${String(+dm[1]).padStart(2, '0')}-${String(+dm[2]).padStart(2, '0')}~${String(+dm[3]).padStart(2, '0')}-${String(+dm[4]).padStart(2, '0')}`,
      matched: dm[0]
    };
  } else if ((dm = q.match(/(\d{1,2})\s*[\/.]\s*(\d{1,2})(?![\d\/.])/))) {
    let d = new Date(now.getFullYear(), +dm[1] - 1, +dm[2]);
    if (d.getTime() - now.getTime() > 7 * 864e5) d = new Date(now.getFullYear() - 1, +dm[1] - 1, +dm[2]);
    return { sinceTs: dayStart(d), untilTs: dayEnd(d), label: `${d.getFullYear()}-${String(+dm[1]).padStart(2, '0')}-${String(+dm[2]).padStart(2, '0')}`, matched: dm[0] };
  } else if ((dm = q.match(/(\d{1,2})\s*월(?!\s*\d)/))) {
    //  ★ "8월에" — 일자 없이 달 전체 (올해 기준, 미래면 작년)
    let y = now.getFullYear();
    let start = new Date(y, +dm[1] - 1, 1), end = new Date(y, +dm[1], 0);
    if (start.getTime() - now.getTime() > 31 * 864e5) { y -= 1; start = new Date(y, +dm[1] - 1, 1); end = new Date(y, +dm[1], 0); }
    return { sinceTs: dayStart(start), untilTs: dayEnd(end), label: `${y}-${String(+dm[1]).padStart(2, '0')}`, matched: dm[0] };
  }
  return null;
}

// ------------------------------------------------------------
//  ★ 필드 지정 문법 (마스터 지시: "제목:도면", "보낸사람:설병헌" 등)
//  ------------------------------------------------------------
//  한글/영문 별칭 → 표준 필드. 값은 "따옴표 문구" 또는 공백 없는 토큰.
//  같은 필드가 여러 번 나오면 그 필드 안에서는 OR(리스트에 누적),
//  서로 다른 필드끼리는 AND(모두 만족해야 함).
// ------------------------------------------------------------
const FIELD_ALIASES = {
  '제목': 'subject', 'subject': 'subject',
  '보낸사람': 'sender', '발신': 'sender', '발신자': 'sender', 'from': 'sender',
  '받는사람': 'to', '수신': 'to', 'to': 'to',
  '참조': 'cc', 'cc': 'cc',
  '본문': 'body', '내용': 'body', 'body': 'body',
  '첨부': 'attach', 'has': 'attach',
  '폴더': 'folder', 'folder': 'folder',
  '기간': 'date', 'date': 'date'
};
//  긴 별칭이 먼저 매칭되도록 길이 내림차순 정렬
const FIELD_TOKEN_RE = new RegExp(
  '(' + Object.keys(FIELD_ALIASES).sort((a, b) => b.length - a.length)
    .map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') +
  ')\\s*[:：]\\s*(?:"([^"]+)"|\'([^\']+)\'|(\\S+))',
  'gi'
);

const ATTACH_EXT_SET = new Set(['pdf', 'xlsx', 'xls', 'docx', 'doc', 'dwg', 'zip', 'pptx', 'ppt', 'jpg', 'jpeg', 'png', 'txt', 'csv', 'hwp']);

function parseFieldSyntax(q, cond, chip) {
  let out = q;
  out = out.replace(FIELD_TOKEN_RE, (whole, aliasRaw, dq, sq, bare) => {
    const field = FIELD_ALIASES[aliasRaw.toLowerCase()] || FIELD_ALIASES[aliasRaw];
    const value = (dq || sq || bare || '').trim();
    if (!field || !value) return whole;
    switch (field) {
      case 'subject':
        cond.subjectList.push(value); chip('subject', `제목: ${value}`, value); break;
      case 'sender':
        cond.senderList.push(value); chip('sender', `보낸사람: ${value}`, value); break;
      case 'to':
        cond.toList.push(value); chip('to', `받는사람: ${value}`, value); break;
      case 'cc':
        cond.ccList.push(value); chip('cc', `참조: ${value}`, value); break;
      case 'body':
        cond.bodyList.push(value); chip('body', `본문: ${value}`, value); break;
      case 'folder':
        cond.folder = value; chip('folder', `폴더: ${value}`, value); break;
      case 'attach': {
        const low = value.toLowerCase().replace(/^\./, '');
        if (ATTACH_EXT_SET.has(low) || /^[a-z0-9]{1,6}$/.test(low) && !/^(있음|없음|yes|no|true|false)$/.test(low)) {
          cond.attachExtList.push(low); cond.hasAttach = true; chip('attach', `첨부: ${low}`, low);
        } else if (/^(없음|no|false)$/i.test(value)) {
          cond.hasAttach = false; chip('attach', '첨부 없음', false);
        } else {
          cond.hasAttach = true; chip('attach', '첨부 있음', true);
        }
        break;
      }
      case 'date': {
        const d = parseDateExpr(value);
        if (d) { cond.sinceTs = d.sinceTs; cond.untilTs = d.untilTs || cond.untilTs; chip('date', `기간: ${d.label}`, value); }
        break;
      }
    }
    return ' ';
  });
  return out;
}

function parseSearchQuery(question) {
  let q = ` ${String(question || '').trim()} `;
  const cond = {
    sender: '', recipient: '', keywords: [], hasAttach: null, unreadOnly: false, folder: '',
    sinceTs: null, untilTs: null, chips: [],
    // ★ 필드별 값 목록(같은 필드 여러 값 = OR). 검색 실행 시 db.searchMails 로 그대로 전달된다.
    subjectList: [], senderList: [], toList: [], ccList: [], bodyList: [], attachExtList: [],
    nameAmbiguity: []
  };
  const chip = (kind, label, value) => cond.chips.push({ kind, label, value });
  const cut = (re) => { q = q.replace(re, ' '); };

  // ---- 0) 필드 지정 문법 최우선 처리(마스터 지시) — 나머지 자연어 추론보다 먼저 소비한다 ----
  q = parseFieldSyntax(q, cond, chip);

  // ---- '내가 보낸' 은 발신자 이름이 아니라 보낸편지함 ----
  if (/(?:내|제|나)\s*(?:가|는)?\s*보낸/.test(q)) {
    if (!cond.folder) { cond.folder = 'Sent'; chip('folder', '보낸 편지함', 'Sent'); }
    cut(/(?:내|제|나)\s*(?:가|는)?\s*보낸/g);
  }

  // ---- 참조: "이창희가 참조된", "OO 참조로 들어간" ----
  let cm = q.match(/([가-힣A-Za-z0-9._%+-]{2,30})\s*(?:님|씨)?\s*(?:이|가)?\s*참조(?:된|로|에|되어)?/);
  if (cm) {
    const cn = /[가-힣]/.test(cm[1]) ? stripParticle(cm[1]) : cm[1];
    if (cn && cn.length >= 2) { cond.ccList.push(cn); chip('cc', `참조: ${cn}`, cn); }
    cut(new RegExp(cm[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  // ---- 제목에: "제목에 CAMBER 들어간", "제목에 도면" ----
  let sjm = q.match(/제목에\s*([^\s]{1,30})\s*(?:들어간|포함된|있는|들어있는)?/);
  if (sjm) {
    const sv = sjm[1];
    if (sv && sv.length >= 1) { cond.subjectList.push(sv); chip('subject', `제목: ${sv}`, sv); }
    cut(new RegExp(sjm[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  // ---- 본문에: "본문에 CAMBER", "내용에 승인" ----
  let bdm = q.match(/(?:본문|내용)에\s*([^\s]{1,30})\s*(?:들어간|포함된|있는|들어있는)?/);
  if (bdm) {
    const bv = bdm[1];
    if (bv && bv.length >= 1) { cond.bodyList.push(bv); chip('body', `본문: ${bv}`, bv); }
    cut(new RegExp(bdm[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  // ---- 보낸사람: "설병헌이 보낸", "김정인님이 준", "from:xxx" ----
  let m = q.match(/([가-힣A-Za-z0-9._%+-]{2,30})\s*(?:님|씨|부장|상무|과장|차장|대리|사원)?\s*(?:이|가|께서|한테서|에게서)?\s*(?:보낸|보내온|보내준|준|발신한)/);
  if (m) {
    // ★ 캡처된 이름에 조사가 붙어 온다("설병헌이"). 제거하지 않으면 DB LIKE 가 0건이 된다(실측).
    const nm = /[가-힣]/.test(m[1]) ? stripParticle(m[1]) : m[1];
    if (nm && nm.length >= 2) { cond.senderList.push(nm); chip('sender', `보낸사람: ${nm}`, nm); }
    cut(new RegExp(m[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  // ---- 받는사람: "설병헌에게 보낸", "김봉정에게 보낸" ----
  const rm = q.match(/([가-힣A-Za-z0-9._%+-]{2,30})\s*(?:님|씨)?\s*(?:에게|한테|께)\s*(?:보낸|보낸것|발송한)?/);
  if (rm && !cond.senderList.length) {
    const rn = /[가-힣]/.test(rm[1]) ? stripParticle(rm[1]) : rm[1];
    if (rn && rn.length >= 2) { cond.toList.push(rn); chip('to', `받는사람: ${rn}`, rn); }
    cut(new RegExp(rm[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  // ---- 첨부 ----
  if (/첨부|파일|도면\s*첨부|attachment/i.test(q)) {
    if (/첨부\s*(?:있|한|된|포함)|attachment/i.test(q)) { cond.hasAttach = true; chip('attach', '첨부 있음', true); }
    cut(/첨부\s*(?:있는|있|한|된|포함된|파일)?/g);
  }
  // ---- 안 읽음 ----
  if (/안\s*읽은|읽지\s*않은|미확인|unread/i.test(q)) {
    cond.unreadOnly = true; chip('unread', '읽지 않음', true);
    cut(/안\s*읽은|읽지\s*않은|미확인|unread/gi);
  }
  // ---- 폴더(보낸/받은) ----
  if (!cond.folder && /보낸\s*메일|보낸편지함/.test(q)) { cond.folder = 'Sent'; chip('folder', '보낸 편지함', 'Sent'); cut(/보낸\s*메일|보낸편지함/g); }
  else if (!cond.folder && /받은\s*메일|받은편지함/.test(q)) { cond.folder = 'Inbox'; chip('folder', '받은 편지함', 'Inbox'); cut(/받은\s*메일|받은편지함/g); }

  // ---- 기간 (필드 문법에서 이미 처리된 경우는 건너뜀) ----
  if (!cond.sinceTs) {
    const d = parseDateExpr(q);
    if (d) { cond.sinceTs = d.sinceTs; cond.untilTs = d.untilTs; chip('date', d.label, d.matched); cut(new RegExp(d.matched.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))); }
  }

  // ---- 범위어·지시대명사 제거 ----
  //  ★ 2026-08-20 실측 결함: "전체요약해봐" 에서 '전체'가 키워드로 남아 AND 조건이 되면서
  //    제목에 '전체'가 든 메일만 찾다가 0건이 됐다(직전 결과 8건이 눈앞에 있었는데도).
  //    범위 표현은 '조건'이 아니라 '범위 확장'이므로 검색어에서 뺀다.
  cut(/전체|전부|모두|모든|다\s*(?=요약|정리|보여|알려)/g);
  //  직전 결과를 가리키는 표현(후속 지시) — 검색어가 아니라 '대상 지정'이다.
  cut(/이\s*중에서|이\s*중|이중|그\s*중에서|그\s*중|그중|위\s*결과|위\s*목록|방금\s*(?:것|거)?|직전|이거|이것|그거|그것|것만|중에서/g);
  cut(/더\s*자세히|자세히|간단히|짧게|요약해서|다시/g);
  //  ★ 선택 메일에 대해 던지는 질문 표현은 검색어가 아니다(0건 사고 방지)
  cut(/무슨\s*내용|무슨\s*말|뭔\s*내용|뭐라고|이거\s*뭐야?|이게\s*뭐야?|뭐야|언제까지|기한이?|마감이?|누가\s*요청|어떻게\s*답장|어떻게\s*회신|왜\s*그래|설명해/g);

  // ---- 요청 동사 제거 ----
  //  ★ 2026-08-20 실측: '브리핑해줘'가 키워드로 남아 AND 조건이 되면서
  //    날짜는 맞게 잡혔는데도 결과가 0건이 됐다(어제 메일 8건 존재).
  cut(/브리핑\s*(?:해\s*줘|해줘|해\s*주세요|해|좀|부탁해?)?|요약\s*(?:해\s*줘|해줘|해\s*주세요|해|좀)?|정리\s*(?:해\s*줘|해줘|해\s*주세요|해|좀)?|알려\s*(?:줘|주세요)|보여\s*(?:줘|주세요)|찾아\s*(?:줘|주세요)/g);

  // ---- 남은 토큰 = 키워드 (불용어·조사 제거는 기존 로직 재사용) ----
  cond.keywords = extractKeywords(q);
  cond.keywords.forEach(k => chip('keyword', k, k));

  // ---- 하위호환: 옛 코드(cond.sender/cond.recipient 단일값 참조)를 위해 대표값 유지 ----
  cond.sender = cond.senderList[0] || '';
  cond.recipient = cond.toList[0] || cond.ccList[0] || '';
  return cond;
}

// 파싱된 조건으로 DB 검색 (모든 조건 AND 결합, 같은 필드 여러 값은 OR)
function runConditionSearch(cond, limit = 300) {
  const opts = {
    query: (cond.keywords || []).join(' '),
    limit,
    sender: (cond.senderList && cond.senderList.length) ? cond.senderList : (cond.sender || ''),
    to: (cond.toList && cond.toList.length) ? cond.toList : '',
    cc: (cond.ccList && cond.ccList.length) ? cond.ccList : '',
    subject: (cond.subjectList && cond.subjectList.length) ? cond.subjectList : '',
    body: (cond.bodyList && cond.bodyList.length) ? cond.bodyList : '',
    attachExt: (cond.attachExtList && cond.attachExtList.length) ? cond.attachExtList : '',
    // 레거시 recipient(받는사람 OR 참조 통합) — 필드문법으로 to/cc 를 명시하지 않은 옛 경로 호환용
    recipient: (!(cond.toList && cond.toList.length) && !(cond.ccList && cond.ccList.length)) ? (cond.recipient || '') : '',
    folder: cond.folder || '',
    hasAttach: cond.hasAttach === true ? true : (cond.hasAttach === false ? false : null),
    unreadOnly: !!cond.unreadOnly,
    sinceTs: cond.sinceTs || null,
    untilTs: cond.untilTs || null,
    sortBy: 'date', sortDir: 'desc'
  };
  return { mails: db.searchMails(opts), opts };
}

function groundingSearch(question, limit = 12) {
  const kws = extractKeywords(question);
  // ★ 키워드가 뽑혔는데 결과가 0건이면 '0건'이 정답이다.
  //   원문 전체로 재검색하면 '메일/찾아줘' 같은 불용어가 매칭돼
  //   무관한 메일이 근거로 딸려 들어간다(환각의 원료).
  const tryQueries = kws.length
    ? [kws.join(' ')]
    : [String(question || '').trim()];

  for (const q of tryQueries) {
    if (!q) continue;
    const cand = db.searchMails({ query: q, limit: limit * 5 });
    if (!cand.length) continue;
    if (kws.length <= 1) return cand.slice(0, limit);
    // 키워드 적중 수로 재정렬 (여러 키워드를 모두 포함한 메일 우선)
    const scored = cand.map(m => {
      const hay = `${m.subject || ''} ${m.sender_name || ''} ${m.sender_email || ''} ${m.preview || ''}`.toLowerCase();
      const hits = kws.reduce((n, k) => n + (hay.includes(k.toLowerCase()) ? 1 : 0), 0);
      return { m, hits };
    });
    scored.sort((a, b) => (b.hits - a.hits) || ((b.m.received_ts || 0) - (a.m.received_ts || 0)));
    return scored.slice(0, limit).map(s => s.m);
  }
  return [];
}

// AI 대량 처리 진행상황 → 렌더러
function aiProgress(kind) {
  return (phase, cur, total, msg) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ai-progress', { kind, phase, cur, total, msg });
    }
  };
}

function requireDb() {
  if (!dbReady) throw new Error('DB가 초기화되지 않았습니다: ' + (dbInitError || 'better-sqlite3 재빌드 필요(npm run rebuild)'));
}
// ============================================================
//  AI 제공자 설정 (Cerebras 무료 티어 402 사태 대응 — 제공자 전환 가능)
//  ------------------------------------------------------------
//  키는 '제공자별 세트'로 저장된다 → 제공자를 바꿔도 기존 키가 지워지지 않는다.
// ============================================================
function aiRawConfig() {
  return {
    aiChain: store.get('aiChain'),
    aiProvider: store.get('aiProvider'),
    aiBaseUrl: store.get('aiBaseUrl'),
    model: store.get('model'),
    apiKeys: store.get('apiKeys'),
    apiKeysByProvider: store.get('apiKeysByProvider')
  };
}
//  등록된 제공자 전체(순위 순) — 화면 표시·저장용
function aiChain() { return aiProviders.normalizeChain(aiRawConfig()); }
//  실제 호출에 쓸 수 있는 제공자만(활성 + 키/URL 있음)
function aiUsableChain() { return aiProviders.activeChain(aiRawConfig()); }
//  1순위 제공자 (기존 단일 제공자 코드 경로 호환)
function aiConfig() { return aiProviders.resolve(aiRawConfig()); }
//  활성 체인을 클라이언트에 반영(설정 저장 시·시작 시 호출)
//  이전 버전에서 쓰던 사용자(aiChain 이 비어 있음)를 기본 체인으로 올린다.
//   ★ 마스터 앱이 402 상태로 멈춰 있지 않도록, 시작 시 1회 조용히 채운다.
function migrateAiChain() {
  const cur = store.get('aiChain');
  if (Array.isArray(cur) && cur.length) return false;
  const def = DEFAULT_AI_CHAIN;
  if (!def.length) return false;
  store.set('aiChain', def);
  //  레거시 필드(model/aiProvider)도 1순위에 맞춰 둔다 — 설정 화면 표기가 체인과 어긋나지 않게.
  store.set('aiProvider', def[0].provider);
  store.set('aiBaseUrl', def[0].baseUrl || '');
  store.set('model', def[0].model);
  console.log('[ai] 제공자 체인 초기화 — 1순위', def[0].provider, '· 2순위', (def[1] || {}).provider || '(없음)');
  return true;
}

//  체인 항목을 cerebras.js 가 쓰는 얕은 형태로 변환 (models: OpenRouter 전용 폴백 배열)
function toCerebrasNode(e) {
  return {
    provider: e.provider, label: e.label, chatUrl: e.chatUrl, model: e.model, models: e.models || null,
    keys: e.keys, limits: e.limits || null   // 무료 한도(RPM/RPD/TPM/TPD) — 근접 시 자동 전환
  };
}
function applyAiConfig() {
  const chain = aiUsableChain();
  //  대화형(사용자 직접 요청) = 설정 순서 그대로(OpenRouter 우선). 배치·자동 작업은
  //  Groq 를 앞으로 당긴 별도 순서(마스터 지시: OpenRouter 일일 한도를 대화용으로 아낀다).
  const batchChain = aiProviders.reorderForBatch(chain);
  cerebras.setChain(chain.map(toCerebrasNode), batchChain.map(toCerebrasNode));
  const c = aiConfig();
  if (!chain.length) cerebras.setEndpoint(c.chatUrl, c.provider);
  return c;
}
function getKeys() { return aiConfig().keys; }
function getModel() { return aiConfig().model || 'gpt-oss-120b'; }
//  이미지 첨부 비전 분석(2단계)은 OpenRouter 무료 비전 모델 전용 — SoT(apiKeysByProvider.openrouter)
//  키를 그대로 재사용한다(별도 키 저장소 신설 금지). 1순위 제공자가 OpenRouter 가 아니어도 항상 이 키를 쓴다.
function getVisionKeys() { return ((store.get('apiKeysByProvider') || {}).openrouter || []).filter(k => k && k.trim()); }
function getConcurrency() { const n = Number(store.get('aiConcurrency')); return Math.max(1, Math.min(Number.isFinite(n) && n > 0 ? n : 3, 3)); }

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
      maxMails: store.get('maxMails') || 5000,
      saveAttachments: store.get('saveAttachmentsOnSync') !== false,
      includeSubfolders: store.get('includeSubfolders') !== false,
      subfolderDepth: store.get('subfolderDepth') || 5,
      includeDeleted: store.get('includeDeleted') === true,
      includeArchiveStores: store.get('includeArchiveStores') === true,
      archiveDepth: store.get('archiveDepth') || 6,
      archiveStoreNames: store.get('archiveStoreNames'),   // null 이면 전체 (sync 에서 해석)
      autoImportContacts: store.get('autoImportContacts') !== false
    };
    const onProgress = (phase, cur, total, msg) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sync-progress', { phase, cur, total, msg });
      }
    };
    const result = await sync.syncAll(config, onProgress);
    setRealtimeSince(new Date().toISOString());
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


// --- DB 메일 상세 + 첨부 ---
ipcMain.handle('db:getMail', (_e, { id }) => {
  try {
    requireDb();
    const mail = db.getMailById(id);
    if (!mail) return { ok: false, error: '메일을 찾을 수 없습니다.' };
    // 진짜 첨부와 인라인(서명 로고·본문 삽입 이미지)을 나눠서 준다.
    //  인라인도 숨기기만 하면 필요할 때 못 찾으므로 접힌 목록으로 함께 넘긴다.
    const all = db.getAttachmentsByMail(id, { includeInline: true });
    const atts = all.filter(a => !a.is_inline);
    const inlineAtts = all.filter(a => a.is_inline);
    const analyses = db.getAnalyses(id);
    return { ok: true, mail, attachments: atts, inlineAttachments: inlineAtts, analyses };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// ============================================================
//  첨부 미리보기 지원 (앱 안에서 열기 — 외부 프로그램 실행 없음)
//   · 텍스트/CSV 는 내용을 읽어 준다(용량 상한).
//   · PDF/이미지는 렌더러가 file:// 로 직접 표시한다.
//   · 저장(다른 이름으로)은 복사만 한다 — 원본은 그대로 둔다.
// ============================================================
const PREVIEW_TEXT_MAX = 512 * 1024;      // 텍스트 미리보기 상한 512KB

ipcMain.handle('file:preview', (_e, { path: fp } = {}) => {
  try {
    const p2 = String(fp || '');
    if (!p2 || !fsMain.existsSync(p2)) return { ok: false, error: '파일을 찾을 수 없습니다.' };
    const st = fsMain.statSync(p2);
    const ext = (p2.split('.').pop() || '').toLowerCase();
    const TEXT = ['txt', 'csv', 'log', 'md', 'json', 'xml', 'html', 'htm'];
    if (!TEXT.includes(ext)) return { ok: true, kind: 'binary', size: st.size, ext };
    if (st.size > PREVIEW_TEXT_MAX) {
      return { ok: true, kind: 'text', size: st.size, ext, truncated: true,
               text: fsMain.readFileSync(p2).slice(0, PREVIEW_TEXT_MAX).toString('utf8') };
    }
    let text = fsMain.readFileSync(p2, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return { ok: true, kind: 'text', size: st.size, ext, text };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

ipcMain.handle('file:saveAs', async (_e, { path: fp } = {}) => {
  try {
    const p2 = String(fp || '');
    if (!p2 || !fsMain.existsSync(p2)) return { ok: false, error: '파일을 찾을 수 없습니다.' };
    const res = await dialog.showSaveDialog(mainWindow, {
      title: '다른 이름으로 저장', defaultPath: path.basename(p2)
    });
    if (res.canceled || !res.filePath) return { ok: true, canceled: true };
    fsMain.copyFileSync(p2, res.filePath);      // 복사만 — 원본 불변
    return { ok: true, saved: res.filePath };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// ============================================================
//  읽기창 첨부 목록 (2026-08-20 회귀 수정)
//  ------------------------------------------------------------
//  실측: 클립 아이콘이 뜨는 메일 13,668건 중 13,357건은 attachments 테이블에
//  행이 아예 없었다(동기화 때 첨부를 저장하지 않은 구간). 읽기창은 DB 행에만
//  의존했기 때문에 "첨부가 있다고 표시되는데 목록은 안 보이는" 상태가 됐다.
//   → 저장 전이라도 Outlook 에서 '이름·크기'만 읽어와 목록을 보여주고,
//     사용자가 [가져오기]를 누르면 그때 파일을 저장한다(원본은 읽기만 한다).
// ============================================================
//  ★ 성능(2026-08-20 실측): 이 조회는 Outlook COM 을 띄운다 — 메일 1건당 평균 834ms.
//    읽기창을 열 때마다 부르면 "클릭이 무겁다"는 체감의 주범이 된다.
//    → 메일별 결과를 메모리에 캐시하고, 같은 메일을 다시 열면 즉시 돌려준다.
const attachMetaCache = new Map();          // mailId -> { items, savedAll, at }
const ATTACH_META_TTL = 30 * 60 * 1000;

ipcMain.handle('mail:attachMeta', async (_e, { id, force } = {}) => {
  try {
    requireDb();
    const mail = db.getMailById(id);
    if (!mail) return { ok: false, error: '메일을 찾을 수 없습니다.' };
    const cached = attachMetaCache.get(id);
    if (!force && cached && (Date.now() - cached.at) < ATTACH_META_TTL) {
      return { ok: true, saved: cached.saved, items: cached.items, cached: true };
    }
    const rows = db.getAttachmentsByMail(id, { includeInline: true });
    if (rows.length) {
      const items = rows.map(a => ({ name: a.file_name, sizeKB: a.size_kb, inline: !!a.is_inline, savedPath: a.saved_path || '' }));
      attachMetaCache.set(id, { items, saved: true, at: Date.now() });
      return { ok: true, saved: true, items };
    }
    // DB 에 없으면 Outlook 속성만 읽는다(파일 저장 없음)
    const eid = mail.entry_id || '';
    if (!eid || store.get('source') === 'pst') {
      return { ok: true, saved: false, items: [], unavailable: true,
               expected: Number(mail.real_attach_count != null ? mail.real_attach_count : mail.attach_count) || 0 };
    }
    const probe = await outlook.probeAttachments([eid], { light: true });
    const list = (probe[0] && probe[0].attachments) || [];
    const c = attachClassify.classifyList(list);
    const items = c.items.map(a => ({ name: a.name, sizeKB: Math.round((Number(a.size) || 0) / 1024), inline: !!a.inline, savedPath: '' }));
    attachMetaCache.set(id, { items, saved: false, at: Date.now() });
    return { ok: true, saved: false, items };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

//  ★ 진짜 첨부를 Outlook COM 으로 로컬에 복사(읽기만, MailItem 변경 없음)하고 DB 에 기록한다.
//    mail:attachFetch(사용자 [가져오기] 버튼)와 attach-content.js(분석/대화 시 자동 확보)가 공유한다
//    — 공유 함수 1곳(CLAUDE.md §G-2-5), 따로따로 구현하면 한쪽만 고쳤을 때 형제가 깨진다.
async function fetchMailAttachmentsToLocal(mail) {
  if (store.get('source') === 'pst') return { ok: false, error: 'PST 모드에서는 첨부를 가져올 수 없습니다.' };
  if (!mail || !mail.entry_id) return { ok: false, error: '이 메일의 Outlook 식별자를 찾을 수 없습니다.' };
  const day = String(mail.received_at || '').slice(0, 10) || 'unknown';
  const dir = path.join(app.getPath('userData'), 'attachments', day, String(mail.id));
  const res = await outlook.saveAttachmentsBatch([{ entryId: mail.entry_id, dir }]);
  const paths = (res[0] && res[0].paths) || [];
  if (!paths.length) return { ok: false, error: '가져올 첨부가 없습니다(본문 이미지만 있을 수 있습니다).' };
  // 이미 기록된 파일명은 건너뛴다(중복 누적 방지)
  const known = new Set(db.getAttachmentsByMail(mail.id, { includeInline: true }).map(a => a.file_name));
  const saved = [];
  for (const fp of paths) {
    const name = path.basename(fp);
    let sizeKB = 0;
    try { sizeKB = Math.round(fsMain.statSync(fp).size / 1024); } catch (e) { /* noop */ }
    if (!known.has(name)) db.addAttachment(mail.id, { fileName: name, sizeKB, savedPath: fp, isInline: false });
    saved.push({ name, sizeKB, inline: false, savedPath: fp });
  }
  attachMetaCache.delete(mail.id);         // 저장했으므로 다음 조회는 DB 행을 쓴다
  return { ok: true, saved: true, items: saved, dir };
}

//  [가져오기] — 이 메일의 진짜 첨부를 지금 로컬에 저장하고 DB 에 기록한다.
ipcMain.handle('mail:attachFetch', async (_e, { id } = {}) => {
  try {
    requireDb();
    const mail = db.getMailById(id);
    if (!mail) return { ok: false, error: '메일을 찾을 수 없습니다.' };
    return await fetchMailAttachmentsToLocal(mail);
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// ============================================================
//  로컬 가상 폴더 / 즐겨찾기 / 읽음 상태
//  ★ 전부 로컬 DB 전용. Outlook 원본 메일함은 절대 변경하지 않는다.
// ============================================================
const okWrap = (fn) => (..._a) => { try { requireDb(); return { ok: true, ...fn(..._a) }; } catch (e) { return { ok: false, error: String(e.message || e) }; } };

ipcMain.handle('vf:list', () => okWrap(() => ({ folders: db.listVirtualFolders() }))());
ipcMain.handle('vf:create', (_e, { name, parentId }) => okWrap(() => ({ folder: db.createVirtualFolder(name, parentId || null) }))());
ipcMain.handle('vf:rename', (_e, { id, name }) => okWrap(() => ({ folder: db.renameVirtualFolder(id, name) }))());
ipcMain.handle('vf:delete', (_e, { id }) => okWrap(() => db.deleteVirtualFolder(id))());
ipcMain.handle('vf:sortChildren', (_e, { parentId }) => okWrap(() => ({ sorted: db.sortVirtualChildren(parentId || null) }))());
ipcMain.handle('vf:moveMails', (_e, { mailIds, vfolderId }) => okWrap(() => ({ moved: db.moveMailsToVirtual(mailIds, vfolderId || null) }))());

ipcMain.handle('fav:list', () => okWrap(() => ({ favorites: db.listFavorites() }))());
ipcMain.handle('folderOrder:get', () => okWrap(() => ({ order: db.getFolderOrder() }))());
ipcMain.handle('folderOrder:set', (_e, { list }) => okWrap(() => ({ saved: db.setFolderOrder(list) }))());
ipcMain.handle('fav:add', (_e, { key, kind, label }) => okWrap(() => db.addFavorite(key, kind, label))());
ipcMain.handle('fav:remove', (_e, { key }) => okWrap(() => db.removeFavorite(key))());
ipcMain.handle('fav:move', (_e, { key, dir }) => okWrap(() => db.moveFavorite(key, dir))());

ipcMain.handle('mail:setRead', (_e, { mailIds, read }) => okWrap(() => ({ changed: db.setReadFlag(mailIds, read) }))());
ipcMain.handle('mail:markFolderRead', (_e, opts) => okWrap(() => ({ changed: db.markFolderRead(opts || {}) }))());
ipcMain.handle('db:unreadCounts', () => okWrap(() => ({ counts: db.unreadCounts() }))());
ipcMain.handle('db:toMeStats', () => okWrap(() => ({ stats: db.toMeStats(), me: [...db.myAddresses(3), ...db.myDisplayNames(2)] }))());
ipcMain.handle('db:toMeBackfill', () => okWrap(() => db.backfillToMe({ force: true }))());

// ============================================================
//  보낸메일 프로젝트 트리 (프로젝트 → 수신인 → 메일) · 읽기 전용 뷰
//  ★ Outlook 원본 불변. 프로젝트 판정/지정은 전부 로컬 DB.
// ============================================================
// 수신인 표시명: 주소록(contacts) 매칭해 이름/회사 보강
function decorateRecipient(toFirst) {
  const raw = String(toFirst || '').trim();
  if (!raw) return { label: '(수신인 없음)', company: '' };
  const email = (raw.match(/[\w.+-]+@[\w.-]+\.\w+/) || [])[0] || '';
  const plain = raw.replace(/<[^>]*>/g, '').replace(/["']/g, '').trim();
  try {
    const row = email
      ? db.listContacts(1, email)[0]
      : (plain ? db.listContacts(1, plain)[0] : null);
    if (row) {
      const nm = row.name || plain || email;
      return { label: nm, company: row.company || '', email: row.email || email };
    }
  } catch (_) {}
  return { label: plain || email || raw, company: '', email };
}

ipcMain.handle('project:tree', () => {
  try {
    requireDb();
    return { ok: true, projects: db.sentProjectTree({ folder: 'Sent' }) };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// 분류 축 ②날짜별 ③이벤트·테마별 — 원본 행 1회 조회 + 순수 모듈 집계
//  캐시: 같은 데이터를 축을 바꿀 때마다 다시 읽지 않는다(새 메일이 들어오면 무효화).
let sentAxisCache = { at: 0, rows: null };
ipcMain.handle('sent:axis', (_e, { axis = 'date', force = false } = {}) => {
  try {
    requireDb();
    const t0 = Date.now();
    if (force || !sentAxisCache.rows || Date.now() - sentAxisCache.at > 60000) {
      sentAxisCache = { at: Date.now(), rows: db.sentAxisRows({ folder: 'Sent' }) };
    }
    const rows = sentAxisCache.rows;
    const groups = axis === 'event' ? sentAxis.groupByEvent(rows) : sentAxis.groupByDate(rows);
    return { ok: true, axis, total: rows.length, groups, ms: Date.now() - t0 };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// 2차: 상대 조직
ipcMain.handle('project:orgs', (_e, { project } = {}) => {
  try { requireDb(); return { ok: true, orgs: db.sentOrgs({ project }) }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
});
// 3차: 스레드(제목 단위)
ipcMain.handle('project:threads', (_e, { project, org } = {}) => {
  try { requireDb(); return { ok: true, threads: db.sentThreads({ project, org }) }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
});
// 4차: 스레드 안 개별 메일
ipcMain.handle('project:threadMails', (_e, { tkey, project, org } = {}) => {
  try { requireDb(); return { ok: true, mails: db.sentThreadMails({ tkey, project, org }) }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
});
// 조직 사전 (조회/편집) + 커버리지
ipcMain.handle('org:dict', (_e, { action, domain, org } = {}) => {
  try {
    requireDb();
    if (action === 'set') return { ok: true, ...db.setOrgMap(domain, org, 0) };
    if (action === 'remove') return { ok: true, ...db.removeOrgMap(domain) };
    if (action === 'rebuild') return { ok: true, ...db.buildOrgDictionary() };
    return { ok: true, map: db.listOrgMap(), coverage: db.orgCoverage({ folder: 'Sent' }) };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});


ipcMain.handle('project:mails', (_e, { project, toFirst, limit } = {}) => {
  try {
    requireDb();
    return { ok: true, mails: db.sentMails({ project, toFirst: toFirst === undefined ? null : toFirst, limit: limit || 300 }) };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

//  allFolders=true 면 받은메일까지 전부 분류한다.
//  실측: Sent 전용이면 대시보드 프로젝트 축이 '기타' 85% 였고, 전 폴더로 돌리면 6.0% 로 떨어진다.
ipcMain.handle('project:recompute', (_e, { allFolders } = {}) => {
  try { requireDb(); return { ok: true, allFolders: !!allFolders, ...db.recomputeProjects({ folder: allFolders ? '*' : 'Sent' }) }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
});

ipcMain.handle('project:setMail', (_e, { mailId, project, learn } = {}) => {
  try { requireDb(); return { ok: true, ...db.setMailProject(mailId, project, learn !== false) }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
});

ipcMain.handle('project:rules', (_e, { action, id, pattern, project, kind, priority } = {}) => {
  try {
    requireDb();
    if (action === 'add') return { ok: true, ...db.addProjectRule(pattern, project, kind || 'contains', priority || 100, 0) };
    if (action === 'remove') return { ok: true, ...db.removeProjectRule(id) };
    return { ok: true, rules: db.listProjectRules(), projects: db.projectList({ folder: 'Sent' }) };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// ============================================================
//  전역 자연어 검색 (조건 파싱 + AND 결합 · AI 없이도 동작)
// ============================================================
// ★ 이름(사람) 값이 들어간 필드에 대해 동명이인 후보를 붙인다(마스터 지시).
//   검색 자체는 부분일치라 후보와 무관하게 동작한다 — 어디까지나 안내용.
function annotateNameAmbiguity(cond) {
  if (!dbReady) return cond;
  try {
    const fields = [['senderList', 'sender'], ['toList', 'to'], ['ccList', 'cc']];
    for (const [listKey, kind] of fields) {
      for (const v of (cond[listKey] || [])) {
        if (!v || /[@.]/.test(v) || !/[가-힣]/.test(v)) continue;   // 이메일·영문값은 대상 아님
        const cands = db.findContactCandidates(v);
        const distinctEmails = new Set(cands.map(c => (c.email || '').toLowerCase()));
        if (distinctEmails.size >= 2) {
          cond.nameAmbiguity.push({ field: kind, value: v, candidates: cands.slice(0, 8) });
        }
      }
    }
  } catch (_) { /* 동명이인 안내는 부가 기능 — 실패해도 검색 자체는 계속 */ }
  return cond;
}

// ============================================================
//  메일별 대화 이력 (마스터 지시: 메일 다시 열면 "이전 대화 N턴 이어보기")
// ============================================================
ipcMain.handle('chat:history', (_e, { id } = {}) => {
  try { requireDb(); return { ok: true, turns: db.getChatHistory(id, 40) }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
});
ipcMain.handle('chat:historyClear', (_e, { id } = {}) => {
  try { requireDb(); return { ok: true, ...db.clearChatHistory(id) }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
});

ipcMain.handle('search:parse', (_e, { query } = {}) => {
  try { return { ok: true, cond: annotateNameAmbiguity(parseSearchQuery(query || '')) }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
});

ipcMain.handle('search:run', (_e, { query, cond, limit } = {}) => {
  try {
    requireDb();
    // cond 가 오면 그것을 쓰고(칩 편집·후속 질문 AND 결합), 없으면 원문을 파싱
    const c = cond && typeof cond === 'object' ? cond : parseSearchQuery(query || '');
    const r = runConditionSearch(c, limit || 300);
    return { ok: true, cond: c, mails: r.mails, count: r.mails.length, applied: r.opts, resultTabs: buildResultTabs(r.mails) };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// --- 미회신 감지 (답장 안 한 메일 경고) ---
ipcMain.handle('db:unanswered', (_e, opts) => {
  try {
    requireDb();
    const o = opts || {};
    return {
      ok: true,
      mails: db.unansweredMails({
        days: o.days || 14,
        limit: o.limit || 30,
        minDays: o.minDays === undefined ? 1 : o.minDays,
        senderQuery: o.senderQuery || '',
        sort: o.sort === 'waiting' ? 'waiting' : 'date',
        excludeClosed: store.get('followupExcludeClosed') !== false
      })
    };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// --- 회신 필요성(의미) 판정 — 기존 미회신 후보 중 판정 안 된 것만 LLM 1건 1호출로 채운다 ---
//    초기 1회 + 이후 신규 후보만 증분(reply_needed_source IS NULL 인 것만 대상 — 재판정 금지).
ipcMain.handle('reply:classifyBatch', async (_e, opts) => {
  try {
    requireDb();
    const keys = getKeys();
    if (!keys.length) return { ok: false, error: 'API 키가 설정되지 않았습니다.' };
    const o = opts || {};
    const cand = db.unansweredMails({
      days: o.days || 30, limit: o.limit || 200, minDays: o.minDays === undefined ? 1 : o.minDays,
      sort: 'date', excludeClosed: true
    });
    // 🔴 1회 상한(기본 50건) — 미분류가 한꺼번에 몰려도 한 트리거에서 전부 소진하지 않는다.
    //   (다음 loadFollowup() 진입/동기화 때 남은 건이 이어서 증분 판정됨 — 재판정 아님, 미분류만 골라 계속 좁혀감)
    const maxBatch = Number.isFinite(o.maxBatch) && o.maxBatch > 0 ? o.maxBatch : 50;
    const allTargets = cand.filter(m => m.replyUnclassified);
    const targets = allTargets.slice(0, maxBatch);
    if (!targets.length) return { ok: true, classified: 0, total: 0 };

    const items = targets.map(t => {
      const full = db.getMailById(t.id) || t;
      let threadPrev = '';
      try {
        const ctx = db.getThreadContext(full, 1);
        if (ctx.length) threadPrev = String(ctx[ctx.length - 1].body || ctx[ctx.length - 1].preview || '').replace(/\s+/g, ' ').slice(0, 400);
      } catch (_) {}
      let attachNames = [];
      try { attachNames = (db.getAttachmentsByMail(t.id) || []).map(a => a.file_name).filter(Boolean); } catch (_) {}
      return { mail: full, threadPrev, attachNames };
    });

    const model = getModel();
    const onProgress = aiProgress('replyNeeded');
    const results = await replyNeeded.classifyBatch(items, {
      keys, model,
      onProgress: (p) => onProgress('progress', p.cur, p.total)
    });
    let classified = 0, failed = 0;
    for (const r of results) {
      if (r.ok) {
        db.setReplyNeeded(r.id, { needsReply: r.needsReply, confidence: r.confidence, reason: r.reason, source: 'llm' });
        classified++;
      } else failed++;
    }
    return { ok: true, classified, failed, total: targets.length, remaining: Math.max(0, allTargets.length - targets.length) };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// --- 회신 필요성 수동 재지정 (마스터 판단이 항상 우선, LLM 재판정이 절대 안 덮음) ---
ipcMain.handle('reply:setManual', (_e, { id, needsReply } = {}) => {
  try {
    requireDb();
    return db.setReplyNeeded(id, { needsReply: !!needsReply, confidence: 1, reason: '마스터가 직접 지정', source: 'manual' });
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
    const res = await analyzer.briefing({ keys, model: getModel(), mails, periodLabel: label, onProgress: aiProgress('briefing'), concurrency: getConcurrency() });
    if (res.ok) db.addAnalysis(null, 'briefing', res.content, 'ko', { mode, count: mails.length });
    return { ...res, count: mails.length, period: label };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// --- 일일 메일 브리핑 (날짜 하나 → 서술형 4섹션, 날짜키 캐시) ---
//  일일 브리핑 본문 — IPC 핸들러와 대화창 라우팅이 함께 쓴다(중복 구현 금지).
async function dailyBriefingFor(date, force) {
  try {
    requireDb();
    const day = String(date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ok: false, error: '날짜 형식이 올바르지 않습니다 (YYYY-MM-DD).' };

    // 캐시 우선 (force 면 무시하고 재생성)
    if (!force) {
      const c = db.getDailyBriefing(day);
      if (c) {
        let structured = null;
        try { structured = JSON.parse(c.content); } catch (_) {}
        return { ok: true, cached: true, date: day, createdAt: c.created_at, structured, content: c.content };
      }
    }

    const keys = getKeys();
    if (!keys.length) return { ok: false, error: 'API 키가 설정되지 않았습니다.' };
    const mails = db.mailsOnDate(day, 400);
    if (!mails.length) return { ok: false, error: `${day} 에는 저장된 메일이 없습니다. 동기화 후 다시 시도하세요.`, count: 0 };

    const res = await analyzer.dailyBriefing({
      keys, model: getModel(), mails, dateLabel: day,
      myEmails: db.myAddresses(3),
      onProgress: aiProgress('daily'), concurrency: getConcurrency()
    });
    if (res.ok && res.structured) {
      db.saveDailyBriefing(day, JSON.stringify(res.structured), { count: mails.length, chunks: res.chunks });
    }
    return { ...res, cached: false, date: day, count: mails.length };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}
ipcMain.handle('ai:dailyBriefing', (_e, { date, force } = {}) => dailyBriefingFor(date, force));

// --- 브리핑이 있는 날짜 목록 (달력 표시) ---
ipcMain.handle('ai:dailyBriefingDates', () => {
  try { requireDb(); return { ok: true, dates: db.dailyBriefingDates(60) }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// --- 업무일지 (기간 내 메일 → 날짜별 업무 기록) ---
ipcMain.handle('ai:workLog', async (_e, { mode, start, end } = {}) => {
  try {
    requireDb();
    const keys = getKeys();
    if (!keys.length) return { ok: false, error: 'API 키가 설정되지 않았습니다.' };
    let sinceTs, untilTs = null, label;
    const now = Date.now();
    if (mode === 'today') { const d = new Date(); d.setHours(0, 0, 0, 0); sinceTs = d.getTime(); label = '오늘'; }
    else if (mode === 'yesterday') {
      const d = new Date(); d.setDate(d.getDate() - 1); d.setHours(0, 0, 0, 0); sinceTs = d.getTime();
      const e = new Date(sinceTs); e.setHours(23, 59, 59, 999); untilTs = e.getTime(); label = '어제';
    }
    else if (mode === 'month') { sinceTs = now - 30 * 864e5; label = '최근 30일'; }
    else if (mode === 'range' && start) {
      sinceTs = new Date(start).getTime();
      if (end) { const e = new Date(end); e.setHours(23, 59, 59, 999); untilTs = e.getTime(); }
      label = `${start} ~ ${end || '오늘'}`;
    }
    else { sinceTs = now - 7 * 864e5; label = '최근 7일'; }

    const mails = db.mailsInRange(sinceTs, untilTs, 400);
    const res = await analyzer.workLog({
      keys, model: getModel(), mails, myEmails: db.myAddresses(3), periodLabel: label,
      onProgress: aiProgress('worklog'), concurrency: getConcurrency()
    });
    if (res.ok) {
      db.addAnalysis(null, 'worklog', res.structured ? JSON.stringify(res.structured) : res.content, 'ko', { mode, count: mails.length, label });
    }
    return { ...res, count: mails.length, period: label };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// --- 저장된 업무일지 목록 ---
ipcMain.handle('ai:workLogHistory', (_e, { limit } = {}) => {
  try {
    requireDb();
    return { ok: true, items: db.listAnalyses('worklog', limit || 10) };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// ============================================================
//  일정(달력) — 저장된 분석 결과에서 수집 + 수동 등록
//   ★ AI 를 새로 호출하지 않는다(비용·429 방지). analyses 테이블만 읽는다.
// ============================================================
ipcMain.handle('sched:month', (_e, { year, month } = {}) => okWrap(() => {
  // month 는 1~12. 달력에는 앞뒤 주가 걸치므로 여유 있게 ±7일을 함께 준다.
  const first = new Date(year, month - 1, 1);
  const last = new Date(year, month, 0);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return {
    items: db.schedulesInRange(iso(new Date(first.getTime() - 7 * 864e5)), iso(new Date(last.getTime() + 7 * 864e5))),
    stats: db.scheduleStats()
  };
})());
ipcMain.handle('sched:upcoming', (_e, { days } = {}) =>
  okWrap(() => ({ items: db.schedulesUpcoming({ days: days || 7 }) }))());
ipcMain.handle('sched:collect', () => okWrap(() => db.collectSchedules())());
ipcMain.handle('sched:add', (_e, payload) => okWrap(() => db.addSchedule(payload || {}))());
ipcMain.handle('sched:update', (_e, { id, ...rest }) => okWrap(() => db.updateSchedule(id, rest))());
ipcMain.handle('sched:done', (_e, { id, done }) => okWrap(() => db.setScheduleDone(id, done))());
ipcMain.handle('sched:delete', (_e, { id }) => okWrap(() => db.deleteSchedule(id))());

// ============================================================
//  대용량 첨부 (bigmail) — 업로드 후 Outlook 작성창 본문에 링크 블록 삽입
//   ★ 발송은 하지 않는다. 본문에 넣어 주기만 한다(마스터가 Outlook 에서 직접 발송).
// ============================================================
ipcMain.handle('bigmail:pick', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '대용량으로 보낼 파일 선택',
    properties: ['openFile', 'multiSelections']
  });
  if (r.canceled || !r.filePaths.length) return { ok: true, files: [] };
  const files = r.filePaths.map(p => {
    let size = 0;
    try { size = fsMain.statSync(p).size; } catch (_) {}
    return { path: p, name: path.basename(p), size };
  });
  return { ok: true, files, limit: bigmail.BODY_LIMIT };
});

ipcMain.handle('bigmail:upload', async (_e, { files, subject, password } = {}) => {
  try {
    const res = await bigmail.upload({
      files: files || [],
      baseUrl: store.get('bigmailBase'),
      licenseKey: store.get('bigmailKey'),
      expireDays: store.get('bigmailExpireDays') || 7,
      password: password || '',
      subject: subject || '',
      onProgress: (percent, sent, total) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('bigmail-progress', { percent, sent, total });
        }
      }
    });
    if (!res.ok) return res;
    try { requireDb(); db.addBigmailUpload({ ...res, subject: subject || '' }); } catch (_) {}
    return { ...res, html: bigmail.buildInsertHtml(res) };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// 업로드 결과 블록을 Outlook 작성창 본문에 넣는다(열려 있으면 그 창, 없으면 새 창)
ipcMain.handle('bigmail:insert', async (_e, { html }) => {
  try { return await outlook.insertHtmlIntoCompose(html || ''); }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// --- 첨부 재분류 (서명 로고·본문 이미지를 진짜 첨부와 분리) ---
// Outlook 규칙을 읽어 프로젝트 판정 사전에 반영 (읽기 전용 — 규칙을 고치지 않는다)
ipcMain.handle('rules:import', async () => {
  try {
    requireDb();
    const r = await outlook.listRules();
    if (!r.ok) return r;
    const before = db.recomputeProjects({ folder: 'Sent' });
    const imported = db.importOutlookRules(r.rules || []);
    const after = db.recomputeProjects({ folder: 'Sent' });
    return { ok: true, rules: (r.rules || []).length, imported, before, after };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// ============================================================
//  Outlook 잔여 데이터 수집 (범주 / 플래그 / 캘린더 / 작업 / 검색폴더)
//  🔴 전부 읽기 전용. Outlook 원본에 쓰는 호출은 하나도 없다.
// ============================================================
ipcMain.handle('extras:import', async (_e, { metaBatch = 1500, retryUnreachable = false } = {}) => {
  try {
    requireDb();
    const report = { ok: true, steps: [] };
    // '조회 불가'로 접어 둔 건을 다시 시도한다(조회 로직을 고친 뒤 1회)
    if (retryUnreachable) report.reset = db.resetMetaUnreachable();
    const step = (name, outlookCount, dbCount, error) =>
      report.steps.push({ name, outlook: outlookCount, db: dbCount, match: outlookCount === dbCount, error: error || '' });

    // ① 범주 마스터
    try {
      const r = await outlook.listCategories();
      if (r.ok) { const n = db.saveCategories(r.categories || []); step('범주(Categories)', (r.categories || []).length, n); }
      else step('범주(Categories)', 0, 0, r.error);
    } catch (e) { step('범주(Categories)', 0, 0, String(e.message || e)); }

    // ② 메일별 범주·플래그·중요도 백필 (아직 안 채워진 것부터 최신순)
    try {
      const ids = db.mailsMissingMeta(metaBatch);
      let applied = 0, unreachable = 0;
      for (let i = 0; i < ids.length; i += 300) {
        const chunk = ids.slice(i, i + 300);
        const meta = await outlook.probeMailMeta(chunk);
        applied += db.applyMailMeta(meta);
        // Outlook 이 못 돌려준 건은 '조회 불가'로 못 박아 무한 재시도를 끊는다
        unreachable += db.markMetaUnreachable(chunk, meta.map(x => x.entryId));
      }
      step('메일 메타(범주·플래그·중요도)', ids.length, applied + unreachable);
    } catch (e) { step('메일 메타(범주·플래그·중요도)', 0, 0, String(e.message || e)); }

    // ③ 캘린더 일정 (지난 6개월 ~ 향후 6개월, 반복 일정 펼침)
    try {
      const r = await outlook.listAppointments({ fromDays: 180, toDays: 180 });
      if (r.ok) { const n = db.saveOutlookSchedules(r.appointments || [], 'outlook-cal'); step('캘린더 일정', (r.appointments || []).length, n); }
      else step('캘린더 일정', 0, 0, r.error);
    } catch (e) { step('캘린더 일정', 0, 0, String(e.message || e)); }

    // ④ 작업(Tasks)
    try {
      const r = await outlook.listTasks({});
      if (r.ok) { const n = db.saveOutlookSchedules(r.tasks || [], 'outlook-task'); step('작업(Tasks)', (r.tasks || []).length, n); }
      else step('작업(Tasks)', 0, 0, r.error);
    } catch (e) { step('작업(Tasks)', 0, 0, String(e.message || e)); }

    // ⑤ 검색 폴더
    try {
      const r = await outlook.listSearchFolders();
      if (r.ok) { const n = db.saveSearchFolders(r.searchFolders || []); step('검색 폴더', (r.searchFolders || []).length, n); }
      else step('검색 폴더', 0, 0, r.error);
    } catch (e) { step('검색 폴더', 0, 0, String(e.message || e)); }

    report.stats = db.outlookExtrasStats();
    try { report.outlookCounts = await outlook.countOutlookItems(); } catch (_) { report.outlookCounts = null; }
    return report;
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

ipcMain.handle('extras:stats', () => okWrap(() => ({
  stats: db.outlookExtrasStats(),
  categories: db.listCategoriesDb(),
  searchFolders: db.listSearchFoldersDb()
}))());

ipcMain.handle('extras:flagged', (_e, { includeDone } = {}) =>
  okWrap(() => ({ mails: db.flaggedMails({ includeDone: !!includeDone, limit: 200 }) }))());

// ============================================================
//  산출물 내보내기 — 통합 대시보드 HTML 1개 + 엑셀(.xlsx)
//  ------------------------------------------------------------
//  화면이 보고 있는 목록(필터·정렬 적용분)을 그대로 넘겨받아 파일로 떨군다.
//  집계는 dashboard-agg, 파일 쓰기는 exporter 가 담당(단일 책임).
// ============================================================
function exportRoot() { return store.get('exportRoot') || exporter.defaultRoot(); }

// ============================================================
//  본문 링크 열기 — 파일/대용량첨부 링크는 우하단 다운로드 팝업에서 바로 다운로드(link-download.js),
//  나머지는 외부 브라우저
//  저장 폴더: 내보내기 폴더(exportRoot — 설정에서 바꾸는 기존 SoT) 아래 '링크다운로드'
// ============================================================
const LINK_DL_SUBDIR = '링크다운로드';
function linkDownloadDir() { return path.join(exporter.resolveRoot(exportRoot()), LINK_DL_SUBDIR); }
let linkDownloader = null;
function openLink(url) {
  try {
    if (!linkDownloader) {
      linkDownloader = linkDownload.createLinkDownloader({
        BrowserWindow, WebContentsView, screen, ipcMain, session, shell,
        getSaveDir: linkDownloadDir,
        getParent: () => mainWindow,
        popupHtml: path.join(__dirname, 'renderer', 'link-popup.html'),
        popupPreload: path.join(__dirname, 'link-popup-preload.js')
      });
    }
    return linkDownloader.open(url);
  } catch (e) {
    console.error('링크 열기 실패:', e);
    return { ok: false, action: 'error', reason: String(e.message || e) };
  }
}
ipcMain.handle('link:open', (_e, { url }) => openLink(url));

// 대시보드용 원본 메일 — 화면이 준 id 목록이 있으면 그것만, 없으면 전체(상한)
function mailsForExport({ ids, limit = 30000 } = {}) {
  let out;
  if (Array.isArray(ids) && ids.length) {
    out = [];
    for (const id of ids) { const m = db.getMailById(id); if (m) out.push(m); }
  } else {
    out = db.searchMails({ limit, sortBy: 'date', sortDir: 'desc' });
  }
  return db.annotateReplied(out);   // '회신여부' 컬럼 채우기 (화면 회신대기와 같은 판정 기준)
}

ipcMain.handle('export:dashboard', (_e, { ids, granularity, scopeLabel, open } = {}) => {
  try {
    requireDb();
    const mails = mailsForExport({ ids });
    const res = exporter.writeDashboard(mails, {
      root: exportRoot(),
      granularity: ['day', 'week', 'month'].includes(granularity) ? granularity : 'day',
      activeDays: Number(store.get('projectActiveDays')) || 90,
      scopeLabel: scopeLabel || ''
    });
    if (open !== false) shell.openPath(res.file);
    return res;
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// kind: 'mails'(현재 목록) | 'dashboard'(집계표 여러 시트)
ipcMain.handle('export:excel', (_e, { kind = 'mails', ids, rows, sheetName, fileName, open } = {}) => {
  try {
    requireDb();
    let res;
    if (kind === 'dashboard') {
      res = exporter.writeDashboardExcel(mailsForExport({ ids }), { root: exportRoot(), fileName });
    } else if (Array.isArray(rows) && rows.length) {
      // 화면이 이미 만든 표(업무일지 등)를 그대로 시트로
      res = exporter.writeExcel([{ name: sheetName || '목록', rows }], { root: exportRoot(), fileName });
    } else {
      res = exporter.writeMailsExcel(mailsForExport({ ids }), { root: exportRoot(), fileName, sheetName: sheetName || '메일목록' });
    }
    if (open !== false) shell.openPath(res.file);
    return res;
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// 저장 루트 선택 / 폴더 열기
ipcMain.handle('export:pickRoot', async () => {
  try {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '내보내기 저장 폴더 선택',
      defaultPath: exportRoot(),
      properties: ['openDirectory', 'createDirectory']
    });
    if (res.canceled || !res.filePaths.length) return { ok: true, root: exportRoot(), canceled: true };
    store.set('exportRoot', res.filePaths[0]);
    return { ok: true, root: res.filePaths[0] };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

ipcMain.handle('export:openRoot', () => {
  try { const r = exporter.resolveRoot(exportRoot()); shell.openPath(r); return { ok: true, root: r }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// ============================================================
//  대화로 첨부 정리 — 계획(plan) → 사용자 확인 → 실행(run)
//  ------------------------------------------------------------
//  🔴 계획 단계에서는 파일을 단 1개도 쓰지 않는다(첨부 속성만 읽는다).
//     실제 파일 기록은 사용자가 [실행]을 눌러 organize:run 을 호출했을 때만.
//  🔴 Outlook 원본은 읽기만 한다. 복사만 하고 이동·삭제는 없다.
// ============================================================
const ORGANIZE_MAX_MAILS = 200;          // 계획 1회가 다루는 메일 상한(속도·안전)

function organizeRoots() {
  return {
    documents: app.getPath('documents'),
    desktop: app.getPath('desktop'),
    downloads: app.getPath('downloads'),
    home: app.getPath('home')
  };
}
// 앱 자신의 폴더에는 쓰지 못하게 한다(설치본·DB 보호)
function organizeBlocked() {
  const out = [];
  try { out.push(app.getPath('userData')); } catch { /* noop */ }
  try { out.push(path.dirname(app.getPath('exe'))); } catch { /* noop */ }
  try { out.push(app.getAppPath()); } catch { /* noop */ }
  return out.filter(Boolean);
}
function organizeHistoryPath() { return path.join(app.getPath('userData'), 'organize-history.json'); }
function readOrganizeHistory() {
  try { return JSON.parse(fsMain.readFileSync(organizeHistoryPath(), 'utf8')) || []; }
  catch { return []; }
}
function pushOrganizeHistory(entry) {
  const list = readOrganizeHistory();
  list.unshift(entry);
  try { fsMain.writeFileSync(organizeHistoryPath(), JSON.stringify(list.slice(0, 50), null, 2), 'utf8'); }
  catch (e) { console.error('정리 이력 저장 실패:', e.message); }
}
//  같은 목적지 폴더로 정리한 과거 이력을 찾는다 — 구조를 바꿔 재실행하면 파일이 한 벌 더
//  생기는 한계(복사 엔진은 구조가 바뀌면 경로가 달라져 멱등 판정을 못 한다)를
//  실행 전에 경고하기 위함이다. 삭제·차단은 하지 않고 "알려주기"만 한다.
function normDestPath(p) { return path.resolve(String(p || '')).replace(/[\\/]+$/, '').toLowerCase(); }
function priorOrganizeRuns(dest) {
  const target = normDestPath(dest);
  return readOrganizeHistory().filter(h => normDestPath(h.dest) === target);
}

// 메일별 '진짜 첨부' 목록 — Outlook 속성 조회(읽기 전용)가 1순위, 실패하면 DB 기록으로 폴백
async function organizeCollectFiles(mails) {
  const byEntry = new Map();
  const ids = mails.map(m => m.entry_id || m.entryId).filter(Boolean);
  let probed = false;
  if (ids.length && store.get('source') !== 'pst') {
    try {
      const CH = 40;
      for (let i = 0; i < ids.length; i += CH) {
        const res = await outlook.probeAttachments(ids.slice(i, i + CH), { light: true });
        for (const r of res) byEntry.set(String(r.entryId), r.attachments || []);
      }
      probed = true;
    } catch (e) {
      console.error('첨부 속성 조회 실패(DB 기록으로 폴백):', e.message);
    }
  }
  return mails.map(m => {
    const eid = String(m.entry_id || m.entryId || '');
    let files = [];
    if (probed && byEntry.has(eid)) {
      files = attachClassify.classifyList(byEntry.get(eid)).real
        .map(a => ({ name: a.name, sizeKB: Math.round((Number(a.size) || 0) / 1024) }));
    } else {
      files = db.getAttachmentsByMail(m.id).map(a => ({ name: a.file_name, sizeKB: Number(a.size_kb) || 0 }));
    }
    return {
      id: m.id, entryId: eid, subject: m.subject || '', received_ts: m.received_ts,
      received_at: m.received_at || '', project: m.project || '', folder: m.folder || '',
      sender_name: m.sender_name || '', sender_email: m.sender_email || '',
      files, exact: probed && byEntry.has(eid),
      // 속성 조회가 안 된 메일은 DB 가 아는 만큼만 보여 주고, 실제 개수는 실행 때 확정된다
      knownCount: Number(m.real_attach_count != null ? m.real_attach_count : m.attach_count) || 0
    };
  });
}

// --- ① 계획 세우기 (파일 쓰기 0) ---
ipcMain.handle('organize:plan', async (_e, { text, prev } = {}) => {
  try {
    const intent = organizeAttach.parseOrganizeIntent(text, { prev: prev || null, roots: organizeRoots() });
    if (!intent.isOrganize) return { ok: true, isOrganize: false };
    requireDb();

    const chk = organizeAttach.checkDest(intent.dest, { extraBlocked: organizeBlocked() });
    if (!chk.ok) return { ok: false, isOrganize: true, error: chk.error, intent };

    // 메일 검색은 기존 자연어 파서를 그대로 쓴다(중복 구현 금지). 첨부 있는 것만.
    const cond = parseSearchQuery(intent.searchText);
    cond.hasAttach = true;
    const found = runConditionSearch(cond, ORGANIZE_MAX_MAILS * 2).mails
      .filter(m => Number(m.real_attach_count != null ? m.real_attach_count : m.attach_count) > 0);
    const truncated = found.length > ORGANIZE_MAX_MAILS;
    const picked = found.slice(0, ORGANIZE_MAX_MAILS);

    const withFiles = await organizeCollectFiles(picked);
    // 종류 필터 적용 — 파일 목록을 아는 메일만 확정 계산할 수 있다
    let fileCount = 0, bytes = 0, unknownMails = 0;
    const mails = withFiles.map(m => {
      const files = m.files.filter(f => organizeAttach.matchesKind(f.name, intent.kinds));
      if (!m.exact && !m.files.length) unknownMails++;
      fileCount += files.length;
      bytes += files.reduce((n, f) => n + (f.sizeKB || 0) * 1024, 0);
      return { ...m, files };
    }).filter(m => m.files.length > 0 || (!m.exact && !m.files.length));

    const plan = {
      dest: chk.dest, structure: intent.structure, nameRule: intent.nameRule, kinds: intent.kinds,
      searchText: intent.searchText, rawText: intent.rawText, mails
    };
    //  같은 폴더로 이미 정리한 이력이 있으면 알려준다(특히 구조가 바뀐 경우 — 중복 생성 주의).
    const priorRuns = priorOrganizeRuns(chk.dest);
    const priorHistory = priorRuns.length ? {
      runs: priorRuns.length,
      lastAt: priorRuns[0].at,
      lastStructure: organizeAttach.STRUCTURE_LABEL[priorRuns[0].structure] || priorRuns[0].structure,
      totalSaved: priorRuns.reduce((n, h) => n + (h.saved || 0), 0),
      structureChanged: priorRuns[0].structure !== intent.structure
    } : null;
    return {
      ok: true, isOrganize: true, plan,
      summary: {
        mailCount: mails.length, matchedMails: found.length, fileCount, bytes,
        destExists: chk.exists, truncated, unknownMails,
        kindsLabel: organizeAttach.kindsLabel(intent.kinds),
        structureLabel: organizeAttach.STRUCTURE_LABEL[intent.structure] || intent.structure,
        nameRuleLabel: organizeAttach.NAMERULE_LABEL[intent.nameRule] || intent.nameRule,
        chips: cond.chips || [],
        priorHistory
      }
    };
  } catch (e) { return { ok: false, isOrganize: true, error: String(e.message || e) }; }
});

// --- ② 실행 (사용자가 [실행]을 눌렀을 때만 호출된다) ---
ipcMain.handle('organize:run', async (_e, { plan } = {}) => {
  try {
    if (!plan || !plan.dest) return { ok: false, error: '실행할 계획이 없습니다.' };
    if (store.get('source') === 'pst') {
      return { ok: false, error: 'PST 모드에서는 첨부를 꺼낼 수 없습니다. 상단에서 실시간(Outlook) 모드로 전환하세요.' };
    }
    const started = Date.now();
    const res = await organizeAttach.execute(plan, {
      saveBatch: (tasks) => outlook.saveAttachmentsBatch(tasks),
      extraBlocked: organizeBlocked(),
      // 매니페스트(mail_id+파일명+크기)로 destRoot 1곳당 멱등을 기억한다 —
      // 구조를 바꿔 재실행해도 이미 저장했던 첨부는 다시 만들지 않는다.
      manifestPath: organizeAttach.manifestPathFor(app.getPath('userData'), plan.dest),
      onProgress: (p) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('organize-progress', p);
      }
    });
    if (res.ok) {
      pushOrganizeHistory({
        at: new Date().toISOString(), text: plan.rawText || '', dest: res.dest,
        structure: plan.structure, kinds: plan.kinds, nameRule: plan.nameRule,
        mails: (plan.mails || []).length, saved: res.saved, skipped: res.skipped,
        failed: res.failed, bytes: res.bytes, ms: Date.now() - started
      });
    }
    return res;
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// --- ③ 실행 이력 조회 ---
ipcMain.handle('organize:history', () => {
  try {
    const items = readOrganizeHistory().slice(0, 20).map(h => ({
      ...h,
      structureLabel: organizeAttach.STRUCTURE_LABEL[h.structure] || h.structure || '',
      kindsLabel: organizeAttach.kindsLabel(h.kinds || [])
    }));
    return { ok: true, items };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// ============================================================
//  로컬 정리 — 별도 프로세스에서 스캔 (메인 앱 메모리·CPU 영향 0)
//  ------------------------------------------------------------
//  🔴 기본은 '보고만'(dry-run). 실제 삭제는 사용자가 [정리 실행]을 눌렀을 때만 한다.
//     자동 스케줄러는 **절대 삭제하지 않는다** — 스캔해서 알려 주기만 한다.
// ============================================================
let cleanupChild = null;
let lastCleanupReport = null;

function runCleanupWorker({ apply = false } = {}) {
  return new Promise((resolve) => {
    if (cleanupChild) return resolve({ ok: false, error: '정리 작업이 이미 실행 중입니다.' });
    const script = path.join(__dirname, '..', 'scripts', 'cleanup-worker.mjs');
    if (!fsMain.existsSync(script)) return resolve({ ok: false, error: '정리 스크립트를 찾을 수 없습니다: ' + script });
    const userData = app.getPath('userData');
    const payload = JSON.stringify({
      attachRoot: path.join(userData, 'attachments'),
      exportRoot: exporter.resolveRoot(exportRoot()),
      dbPath: db.dbPath,
      exportKeepDays: Number(store.get('cleanupKeepDays')) || 30,
      apply: apply === true,
      rssLimitMb: Number(store.get('cleanupRssLimitMb')) || 400,
      parentPid: process.pid
    });
    // ★ ELECTRON_RUN_AS_NODE=1 로 Electron 바이너리를 순수 Node 로 띄운다.
    //   (better-sqlite3 가 Electron ABI 로 빌드돼 있어 시스템 node 로는 로드되지 않는다)
    const child = spawn(process.execPath, [script, payload], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    cleanupChild = child;
    let out = '', err = '';
    child.stdout.on('data', d => { out += d.toString('utf8'); });
    child.stderr.on('data', d => { err += d.toString('utf8'); });
    child.on('error', (e) => { cleanupChild = null; resolve({ ok: false, error: String(e.message || e) }); });
    child.on('close', () => {
      cleanupChild = null;
      const line = out.split(/\r?\n/).reverse().find(l => l.startsWith('RESULT:'));
      if (!line) return resolve({ ok: false, error: '정리 결과를 읽지 못했습니다. ' + (err || out).slice(0, 300) });
      try {
        const r = JSON.parse(line.slice(7));
        r.finishedAt = new Date().toISOString();
        // 파일이 사라진 껍데기 행 정리는 DB 를 쥔 이 프로세스에서 (가볍고 즉시 끝난다)
        try {
          const dang = db.attachmentRowsWithPath().filter(x => !fsMain.existsSync(x.saved_path));
          r.danglingRows = { count: dang.length, deleted: 0, samples: dang.slice(0, 10).map(x => ({ id: x.id, file: x.file_name })) };
          if (apply) { for (const x of dang) r.danglingRows.deleted += db.clearAttachmentPath(x.id); }
        } catch (_) { }
        lastCleanupReport = r;
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('cleanup:report', r);
        resolve(r);
      } catch (e) { resolve({ ok: false, error: '정리 결과 파싱 실패: ' + String(e.message || e) }); }
    });
  });
}

ipcMain.handle('cleanup:scan', () => runCleanupWorker({ apply: false }));
ipcMain.handle('cleanup:apply', () => runCleanupWorker({ apply: true }));
ipcMain.handle('cleanup:last', () => ({ ok: true, report: lastCleanupReport, schedule: cleanupScheduleInfo() }));

// ---- 자동 정리 스케줄러 (업무시간 09~18시 매시 정각, 스캔만) ----
let cleanupTimer = null;
function cleanupScheduleInfo() {
  const on = store.get('cleanupAuto') !== false;
  return { enabled: on, fromHour: Number(store.get('cleanupFromHour')) || 9, toHour: Number(store.get('cleanupToHour')) || 18 };
}
function scheduleNextCleanup() {
  if (cleanupTimer) { clearTimeout(cleanupTimer); cleanupTimer = null; }
  const s = cleanupScheduleInfo();
  if (!s.enabled) return;
  // 다음 정각까지 남은 시간 (+3초 여유)
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1, 0, 3, 0);
  const wait = Math.max(5000, next.getTime() - now.getTime());
  cleanupTimer = setTimeout(async () => {
    const h = new Date().getHours();
    // 업무시간에만, 그리고 절대 삭제하지 않는다(스캔만)
    if (h >= s.fromHour && h <= s.toHour) {
      try { await runCleanupWorker({ apply: false }); } catch (_) { }
    }
    scheduleNextCleanup();
  }, wait);
  if (cleanupTimer.unref) cleanupTimer.unref();
}

// ============================================================
//  메일별 내 처리 상태 (todo 할일 / hold 보류 / done 처리 / fyi 확인)
//  ------------------------------------------------------------
//  수동 지정이 정본. 자동 제안은 저장하지 않고 조회 시 계산해 함께 돌려준다.
//  🔴 전부 로컬 DB 표시이며 Outlook 원본은 변경하지 않는다.
// ============================================================
ipcMain.handle('action:set', (_e, { ids, state, note, due } = {}) => {
  try {
    requireDb();
    const r = db.setActionState(ids, state, {
      note, due,
      propagateThread: store.get('actionPropagateThread') === true
    });
    return r;
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

ipcMain.handle('action:undo', (_e, { ids } = {}) =>
  okWrap(() => db.undoActionState(ids))());

ipcMain.handle('action:counts', (_e, { folder } = {}) =>
  okWrap(() => ({ counts: db.actionStateCounts({ folder: folder || null }) }))());

// '할 일' 뷰 — 상태별 목록 + 상태별 건수
ipcMain.handle('action:list', (_e, { state, limit } = {}) =>
  okWrap(() => ({
    mails: db.actionMails({ state: state === 'none' ? null : state, limit: limit || 300 }),
    counts: db.actionStateCounts({})
  }))());

// 자동 제안 — 저장하지 않고 계산만 (수동 지정이 있으면 제안하지 않는다)
ipcMain.handle('action:suggest', (_e, { ids } = {}) => {
  try {
    requireDb();
    const list = (ids || []).map(n => parseInt(n, 10)).filter(Number.isFinite);
    const hints = db.actionHintCounts(list);
    const out = {};
    for (const id of list) {
      const m = db.getMailById(id);
      if (!m) continue;
      if (m.action_state) { out[id] = null; continue; }   // 수동 지정이 정본 — 제안 안 함
      const s = actionState.suggest(m, { actionCount: hints[id] || 0 });
      out[id] = s.state ? { state: s.state, reason: s.reason, confidence: s.confidence, text: actionState.suggestText(s) } : null;
    }
    return { ok: true, suggestions: out };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// Outlook 깃발 수집분 → 최초 1회 todo/done 매핑
ipcMain.handle('action:seedFromFlags', () => okWrap(() => db.seedActionFromFlags())());

// 출처별 집계 (직접 지정 vs Outlook 깃발 자동 매핑) — 마스터 확인용
ipcMain.handle('action:sourceCounts', () => okWrap(() => ({ counts: db.actionSourceCounts() }))());
// 자동 매핑분만 초기화 (직접 지정한 건 절대 건드리지 않는다)
ipcMain.handle('action:clearAuto', () => okWrap(() => db.clearAutoActionStates())());

ipcMain.handle('attach:stats', () => okWrap(() => ({ stats: db.attachmentStats() }))());
ipcMain.handle('attach:reclassify', async (_e, { maxBatches } = {}) => {
  try {
    requireDb();
    const local = db.backfillAttachmentFlags();
    let mails = 0, batches = 0;
    const cap = Math.max(1, Math.min(parseInt(maxBatches, 10) || 40, 400));
    while (batches < cap) {
      const need = db.mailsNeedingAttachProbe(250);
      if (!need.length) break;
      const probe = await outlook.probeAttachments(need.map(x => x.entry_id));
      const r = db.applyAttachmentProbe(probe);
      mails += r.mails; batches++;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('attach-progress', { done: mails, remain: db.attachmentStats().pending });
      }
      if (!r.mails) break;                 // 더 진행되지 않으면 중단(무한루프 방지)
    }
    return { ok: true, local, mails, stats: db.attachmentStats() };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

ipcMain.handle('bigmail:history', () => okWrap(() => ({ items: db.listBigmailUploads(50) }))());
ipcMain.handle('bigmail:historyDelete', (_e, { id }) => okWrap(() => db.deleteBigmailUpload(id))());

// ============================================================
//  교차 검증 — 등록된 제공자가 2개 이상이면 서로 다른 제공자로 병렬 호출해
//  핵심 필드(기한/요청유무/할일수/의도)만 대조한다. (마스터 지시: 분석 신뢰도)
//  ------------------------------------------------------------
//  · refine(대화로 고치는 중)에는 적용하지 않는다 — 토큰 낭비 방지, 이미 사람이 확인 중인 흐름.
//  · 2차 호출 실패(429/한도 등)는 조용히 묻지 않고 배지로 표시 + 1차 결과로 폴백한다.
//  · 불일치 시 3순위 제공자가 있으면 다수결, 없으면 '확인 필요' 배지만 표시한다.
// ============================================================
async function crossValidateTranslate(mail, keys, model, primary, threadContext = [], attachments = [], attachmentContext = '') {
  const chain = aiUsableChain();
  if (chain.length < 2) return { enabled: false, reason: '등록된 제공자가 1개뿐입니다' };
  const second = chain[1];
  let secRes;
  try {
    secRes = await analyzer.translateAnalyze({
      keys: second.keys, model: second.model, mail, threadContext, attachments, attachmentContext,
      providerOverride: { chatUrl: second.chatUrl, provider: second.provider, model: second.model, keys: second.keys }
    });
  } catch (e) {
    return { enabled: true, failed: true, reason: String(e.message || e) };
  }
  if (!secRes.ok || !secRes.structured || !primary.structured) {
    return { enabled: true, failed: true, reason: secRes.error || '2차 검증 결과를 구조화하지 못했습니다' };
  }
  const tokensUsed = (Number(primary.usage && primary.usage.total_tokens) || 0) + (Number(secRes.usage && secRes.usage.total_tokens) || 0);
  const cmp = analyzer.compareAnalysis(primary.structured, secRes.structured);
  if (cmp.match) {
    return { enabled: true, match: true, votes: '2/2', providerA: chain[0].provider, providerB: second.provider, tokensUsed };
  }
  // 불일치 → 3순위가 있으면 다수결 시도
  if (chain.length >= 3) {
    const third = chain[2];
    try {
      const thirdRes = await analyzer.translateAnalyze({
        keys: third.keys, model: third.model, mail, threadContext, attachments, attachmentContext,
        providerOverride: { chatUrl: third.chatUrl, provider: third.provider, model: third.model, keys: third.keys }
      });
      if (thirdRes.ok && thirdRes.structured) {
        const cmpAC = analyzer.compareAnalysis(primary.structured, thirdRes.structured);
        const cmpBC = analyzer.compareAnalysis(secRes.structured, thirdRes.structured);
        const t3 = (Number(thirdRes.usage && thirdRes.usage.total_tokens) || 0);
        if (cmpAC.match) return { enabled: true, match: true, votes: '2/3(A=C)', providerA: chain[0].provider, providerB: second.provider, providerC: third.provider, tokensUsed: tokensUsed + t3 };
        if (cmpBC.match) return { enabled: true, match: true, votes: '2/3(B=C)', providerA: chain[0].provider, providerB: second.provider, providerC: third.provider, tokensUsed: tokensUsed + t3, useSecond: true };
        return { enabled: true, match: false, votes: '0/3 전부 다름', diffs: cmp.diffs, providerA: chain[0].provider, providerB: second.provider, providerC: third.provider, tokensUsed: tokensUsed + t3 };
      }
    } catch (_) { /* 3차 실패는 무시하고 2건 불일치로 표시 */ }
  }
  return { enabled: true, match: false, votes: '2건 불일치', diffs: cmp.diffs, providerA: chain[0].provider, providerB: second.provider, tokensUsed };
}

// --- AI 번역/분석 (특정 메일) ---
ipcMain.handle('ai:translate', async (_e, { id, refine } = {}) => {
  try {
    requireDb();
    const keys = getKeys();
    if (!keys.length) return { ok: false, error: 'API 키가 설정되지 않았습니다.' };
    const mail = db.getMailById(id);
    if (!mail) return { ok: false, error: '메일을 찾을 수 없습니다.' };
    // ★ 마스터 지시(임무B): 스레드 맥락(최대 N통, 기본 5) + 진짜 첨부 파일명을 분석 입력에 함께 넣는다.
    const threadLimit = Math.max(1, Math.min(parseInt(store.get('threadContextLimit'), 10) || 5, 20));
    let threadContext = [];
    try { threadContext = db.getThreadContext(mail, threadLimit); } catch (e) { threadContext = []; }
    let attachments = [];
    try { attachments = (db.getAttachmentsByMail(id) || []).map(a => ({ name: a.file_name })); } catch (e) { attachments = []; }
    // ★ 첨부 '내용'(PDF·XLSX/CSV·DOCX·TXT) 주입 — 캐시 우선, 저장본 없으면 1회 COM 확보(읽기만).
    let attachmentContent = { text: '', chips: [] };
    try { attachmentContent = await attachContent.buildAttachmentContext(mail, { fetchMissingFn: () => fetchMailAttachmentsToLocal(mail), visionKeys: getVisionKeys() }); }
    catch (e) { attachmentContent = { text: '', chips: [] }; }
    const res = await analyzer.translateAnalyze({ keys, model: getModel(), mail, refine: refine || null, threadContext, attachments, attachmentContext: attachmentContent.text });
    let crossValidation = { enabled: false };
    if (res.ok && !refine && store.get('crossValidate') !== false) {
      try { crossValidation = await crossValidateTranslate(mail, keys, getModel(), res, threadContext, attachments, attachmentContent.text); }
      catch (e) { crossValidation = { enabled: true, failed: true, reason: String(e.message || e) }; }
    }
    // 구조화 결과가 있으면 JSON 으로 저장 → 다시 열 때도 카드 형태로 복원된다
    if (res.ok) {
      db.addAnalysis(id, 'translate', res.structured ? JSON.stringify(res.structured) : res.content, mail.lang || '');
    }
    return { ...res, crossValidation, attachmentChips: attachmentContent.chips };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// --- AI 답장 초안 ---
ipcMain.handle('ai:draftReply', async (_e, { id, instruction, tone, replyLang, previousDraft } = {}) => {
  try {
    requireDb();
    const keys = getKeys();
    if (!keys.length) return { ok: false, error: 'API 키가 설정되지 않았습니다.' };
    const mail = db.getMailById(id);
    if (!mail) return { ok: false, error: '메일을 찾을 수 없습니다.' };
    // 렌더러가 값을 안 넘겨도 설정값을 따른다(설정 > AI 답장 언어).
    const effReplyLang = replyLang || store.get('replyLang') || 'auto';
    const res = await analyzer.draftReply({ keys, model: getModel(), mail, instruction, tone, replyLang: effReplyLang, previousDraft: previousDraft || '' });
    if (res.ok) db.addAnalysis(id, 'reply', res.content, effReplyLang === 'auto' ? (mail.lang || '') : effReplyLang);
    return res;
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// --- AI 대화형 질의 (DB 검색결과를 근거로) ---
//  '브리핑/요약/정리' 의도 — 검색이 아니라 브리핑 기능으로 라우팅한다.
const BRIEFING_RE = /브리핑|요약\s*(?:해|하|좀|줘)|정리\s*(?:해|하|좀|줘)|무슨\s*일|어떤\s*일/;
//  '내가 뭘 하면 되니' 류 — 검색이 아니라 '할 일 브리핑'
const TODO_INTENT_RE = /뭘\s*하?면|뭐\s*하?면|무엇을\s*하|할\s*일|해야\s*할|처리할|뭐부터|어디부터|급한\s*(?:거|것|일)|우선\s*순위|남은\s*일|밀린/;
//  ★ 2026-08-20 치명 결함: 메일을 열어 둔 채 "무슨내용이지?" 를 물었더니
//    검색을 돌려 0건을 내고 "동기화하세요"라고 답했다. 눈앞의 메일을 놔두고 검색한 것.
//    → 검색 의도가 '명시적'일 때만 검색하고, 그 외에는 선택된 메일을 근거로 답한다.
//  검색으로 가는 명시 신호(동사)
const SEARCH_VERB_RE = /찾아\s*(?:줘|주세요|봐)|검색(?:해|하|좀)|알려\s*줘\s*(?:.*메일)|목록|리스트|몇\s*건|누가\s*보냈/;
//  선택한 메일에 대해 묻는 표현(대상 지정 없이 던지는 질문)
const FOCUS_INTENT_RE = /무슨\s*내용|무슨\s*말|뭐라고|뭔\s*내용|이거\s*뭐|이게\s*뭐|요약|정리해|번역|해석|핵심|언제까지|기한|마감|누가\s*요청|어떻게\s*(?:답장|회신|답변)|답장|회신|왜|어떤\s*의미|설명해|알려\s*줘$|첨부(?:가|는|에)?\s*(?:뭐|무엇)/;

//  직전 결과를 가리키는 후속 지시
const FOLLOWUP_RE = /이\s*중|이중|그\s*중|그중|위\s*(?:결과|목록)|방금|직전|이거|이것|그거|그것|더\s*자세|자세히|간단히|짧게|다시|\d+\s*번째|첫\s*번째|마지막/;

//  ★ 4탭(마스터 지시): "타임라인으로 보여줘"/"사람별로 정리해줘" 류 — 새 검색 없이 직전 결과를
//    다른 탭으로 즉시 재구성한다(AI 호출 없음 → 캐시 재조회처럼 즉시 응답).
const TAB_SWITCH_RE = /(타임라인|목록|리스트|사람별|인물별|사람으로|키워드별|주제별|키워드로)\s*(?:로|으로)?\s*(?:정리|보여|보기|바꿔|전환)/;
const TAB_LABEL = { timeline: '타임라인', list: '목록', person: '사람별', keyword: '키워드별' };
function detectTabSwitch(q) {
  const m = TAB_SWITCH_RE.exec(String(q || ''));
  if (!m) return null;
  const w = m[1];
  if (w === '타임라인') return 'timeline';
  if (w === '목록' || w === '리스트') return 'list';
  if (w === '사람별' || w === '인물별' || w === '사람으로') return 'person';
  return 'keyword';
}

function hasStructuredCond(c) {
  return !!(c && (c.sender || c.recipient || c.folder || c.sinceTs || c.untilTs || c.hasAttach || c.unreadOnly));
}
function singleDayOf(cond) {
  if (!cond.sinceTs || !cond.untilTs) return '';
  const a = new Date(cond.sinceTs), b = new Date(cond.untilTs);
  if (a.toDateString() !== b.toDateString()) return '';
  const p2 = (n) => String(n).padStart(2, '0');
  return a.getFullYear() + '-' + p2(a.getMonth() + 1) + '-' + p2(a.getDate());
}

// ============================================================
//  대화 세션 맥락 (2026-08-20 치명 결함 수정)
//  ------------------------------------------------------------
//  실측 사고: 직전 턴에 어제 메일 8건을 보여 주고도 "전체요약해봐" 에
//  새 검색을 돌려 0건을 냈다. 대화라면 '직전에 보여 준 것'을 기억해야 한다.
//   -> 검색·브리핑 결과의 메일 id 를 세션에 남기고, 후속 지시는 그 집합에 적용한다.
// ============================================================
let chatCtx = { mailIds: [], label: '', chips: [], at: 0 };
function rememberChatResult(mails, label, chips) {
  chatCtx = {
    mailIds: (mails || []).map(m => m.id).filter(Boolean).slice(0, 300),
    label: label || '', chips: chips || [], at: Date.now()
  };
}
function prevChatMails() {
  const out = [];
  for (const id of chatCtx.mailIds) { const m = db.getMailById(id); if (m) out.push(m); }
  return out;
}

// ------------------------------------------------------------
//  근거 선정 — 광고·뉴스레터 제외 + 관련도(키워드 적중)·최신성 가중
//   실측 사고: "내가 뭘하면되니" 에 2022~2025년 무관 메일과 광고(HR DIVE)가 근거로 붙었다.
// ------------------------------------------------------------
const AD_SENDER_RE = /noreply|no-reply|donotreply|newsletter|mailer|notification|marketing/i;
const AD_SUBJECT_RE = /\(광고\)|\[광고\]|무료\s*체험|수신거부|unsubscribe|newsletter|웨비나|프로모션|이벤트\s*안내|인크루트|사람인|잡코리아/i;
function isPromotional(m) {
  const from = (m.sender_email || '') + ' ' + (m.sender_name || '');
  return AD_SENDER_RE.test(from) || AD_SUBJECT_RE.test(String(m.subject || ''));
}
function rankGrounding(mails, keywords, limit) {
  const kws = (keywords || []).map(k => String(k).toLowerCase()).filter(Boolean);
  const now = Date.now();
  const scored = (mails || [])
    .filter(m => !isPromotional(m))
    .map(m => {
      const hay = ((m.subject || '') + ' ' + (m.sender_name || '') + ' ' + (m.preview || '')).toLowerCase();
      const hit = kws.reduce((n, k) => n + (hay.indexOf(k) >= 0 ? 1 : 0), 0);
      const ageDays = Math.max(0, (now - (m.received_ts || 0)) / 864e5);
      const fresh = Math.max(0, 1 - ageDays / 365);
      return { m, hit, score: hit * 3 + fresh * 2 };
    })
    //  키워드가 있는데 하나도 안 맞으면 근거로 쓰지 않는다(무관 메일 억지 채움 금지)
    .filter(x => !kws.length || x.hit > 0);
  scored.sort((a, b) => (b.score - a.score) || ((b.m.received_ts || 0) - (a.m.received_ts || 0)));
  return scored.slice(0, limit || 12).map(x => x.m);
}

// ------------------------------------------------------------
//  ★ 날짜별 그룹핑 (마스터 지시: 복합 조건 검색 결과를 날짜별로 묶어 요약)
//   순수 함수 — 최신 날짜가 먼저 오도록 정렬.
// ------------------------------------------------------------
function groupMailsByDate(mails) {
  const map = new Map();
  for (const m of (mails || [])) {
    const d = String(m.received_at || '').slice(0, 10) || '(날짜미상)';
    if (!map.has(d)) map.set(d, []);
    map.get(d).push(m);
  }
  return [...map.entries()]
    .map(([date, ms]) => ({ date, count: ms.length, mails: ms }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

// ------------------------------------------------------------
//  ★ 마스터 지시(4탭): 검색/대화 결과 집합을 타임라인·목록·사람별·키워드별로 정리.
//    집계는 timeline-agg(순수 함수)가 하고, 여기서는 DB 원본(replied 등)만 채워 넘긴다.
//    화면에는 전문(body)을 보내지 않는다 — preview(짧은 발췌)만 태운다(payload 비대화 방지).
// ------------------------------------------------------------
function buildResultTabs(fullMails) {
  try {
    const list = db.annotateReplied([...(fullMails || [])]);
    return {
      timeline: timelineAgg.timelineRows(list),
      person: timelineAgg.personTable(list, { extractCodes: analyzer.extractProjectCodes }),
      keyword: timelineAgg.keywordTable(list, analyzer.extractProjectCodes)
    };
  } catch (e) { return { timeline: [], person: [], keyword: [], error: String(e.message || e) }; }
}

// ------------------------------------------------------------
//  '할 일' 브리핑 — 기존 자산만 조합(새 판정 로직을 만들지 않는다)
//   회신대기(To·미회신) + 내 처리상태(할일/보류) + 기한 있는 건
// ------------------------------------------------------------
function buildTodoDigest() {
  let un = [], todo = [], hold = [];
  try { un = db.unansweredMails({ days: 30, limit: 40, minDays: 1, excludeClosed: true }) || []; } catch (e) { un = []; }
  try { todo = db.actionMails({ state: 'todo', limit: 60 }) || []; } catch (e) { todo = []; }
  try { hold = db.actionMails({ state: 'hold', limit: 40 }) || []; } catch (e) { hold = []; }
  // ★ SoT: "회신 대기" 카운트·브리핑 노출은 db.unansweredMails() 가 붙여 준 replyBucket 을 그대로 따른다
  //   (reply-needed.js bucketOf() 파생 — 화면·대시보드·브리핑이 각자 계산하면 반드시 갈라진다).
  const unNeeded = un.filter(m => m.replyBucket !== 'notneeded');
  const seen = new Set();
  const rows = [];
  const push = (m, kind, extra) => {
    if (!m || seen.has(m.id) || isPromotional(m)) return;
    seen.add(m.id);
    const o = Object.assign({}, m);
    o.todoKind = kind; o.todoNote = extra || '';
    rows.push(o);
  };
  todo.filter(m => m.action_due).sort((a, b) => String(a.action_due).localeCompare(String(b.action_due)))
    .forEach(m => push(m, '기한 있는 할 일', '기한 ' + m.action_due));
  unNeeded.slice().sort((a, b) => (b.daysWaiting || 0) - (a.daysWaiting || 0))
    .forEach(m => push(m, '회신 대기', (m.daysWaiting ? m.daysWaiting + '일 경과' : '') + (m.replyUncertain ? ' · 판단 불확실' : '')));
  todo.filter(m => !m.action_due).forEach(m => push(m, '내 할 일', ''));
  hold.forEach(m => push(m, '보류', ''));
  return { rows: rows.slice(0, 15), counts: { unanswered: unNeeded.length, todo: todo.length, hold: hold.length } };
}

// --- AI 대화형 질의 (DB 검색결과를 근거로) ---
//  ★ 라우팅: (1) 할 일 브리핑 (2) 후속 지시=직전 결과 (3) 기간 브리핑 (4) 새 검색/일반 대화
ipcMain.handle('ai:chatMails', async (_e, { question, history, context, focusMailId } = {}) => {
  try {
    requireDb();
    const keys = getKeys();
    if (!keys.length) return { ok: false, error: 'API 키가 설정되지 않았습니다.' };
    const q = String(question || '');

    const cond = parseSearchQuery(q);
    const wantsBriefing = BRIEFING_RE.test(q) && (cond.sinceTs || cond.untilTs);
    if (wantsBriefing) { cond.keywords = []; cond.chips = (cond.chips || []).filter(c => c.kind !== 'keyword'); }
    const structured = hasStructuredCond(cond);
    const kws = cond.keywords || [];
    const chips = (cond.chips || []).map(c => ({ kind: c.kind, label: c.label }));
    let dbTotal = null; try { dbTotal = db.stats().total; } catch (e) { dbTotal = null; }
    const hasPrev = chatCtx.mailIds.length > 0 && (Date.now() - chatCtx.at) < 60 * 60 * 1000;

    // ---- (0) ★ 선택된 메일이 최우선 대상 ----
    //   검색 조건이 실제로 파싱됐거나 '찾아줘/검색' 같은 명시 동사가 있을 때만 검색으로 간다.
    const explicitSearch = structured || SEARCH_VERB_RE.test(q);
    const focusIntent = FOCUS_INTENT_RE.test(q) || (!kws.length && !explicitSearch);
    const focusMail = focusMailId ? db.getMailById(focusMailId) : null;
    if (focusMail && !explicitSearch && !TODO_INTENT_RE.test(q)) {
      const atts = db.getAttachmentsByMail(focusMail.id) || [];
      const attLine = atts.length
        ? atts.map(a => a.file_name).join(', ')
        : (Number(focusMail.real_attach_count || focusMail.attach_count) > 0 ? '(첨부 있음 - 목록 미저장)' : '(없음)');
      const prior = (db.getAnalyses(focusMail.id) || [])
        .filter(a => a.kind === 'analysis' || a.kind === 'reply')
        .slice(0, 1).map(a => String(a.content || '').slice(0, 1200)).join('');
      // ★ 마스터 지시("각 메일 안에서 '대화하기'"): 같은 스레드 이전 메일 요약 최대 5통도 함께 넣는다.
      let threadCtx = [];
      try { threadCtx = db.getThreadContext(focusMail, 5); } catch (e) { threadCtx = []; }
      const threadBlock = threadCtx.length
        ? ['', '[같은 스레드 이전 메일(오래된순)]',
           threadCtx.map((m, i) => `${i + 1}. ${m.received_at || ''} ${m.sender_name || ''} — ${String(m.subject || '')} : ${String(m.body || m.preview || '').replace(/\s+/g, ' ').slice(0, 150)}`).join('\n')].join('\n')
        : '';
      // ★ 첨부 '내용'(PDF·XLSX/CSV·DOCX·TXT) 주입 — 캐시 우선, 저장본 없으면 1회 COM 확보(읽기만).
      let attachmentContent = { text: '', chips: [] };
      try { attachmentContent = await attachContent.buildAttachmentContext(focusMail, { fetchMissingFn: () => fetchMailAttachmentsToLocal(focusMail), visionKeys: getVisionKeys() }); }
      catch (e) { attachmentContent = { text: '', chips: [] }; }
      const ask = [
        '[대상] 사용자가 지금 화면에서 열어 둔 메일 1건이다. 검색하지 말고 이 메일(과 함께 주어진 스레드 맥락)만 근거로 답하라.',
        '근거가 이 메일 밖으로 나가면 안 된다. 도면번호·호선번호·기한은 아래 내용에 실제로 적힌 것만 언급하라.',
        attachmentContent.text ? '첨부 내용이 함께 주어지면 그 내용을 근거로 답하고, 첨부에 없는 사실을 지어내지 마라. 인용할 때는 첨부 파일명을 명시하라.' : '',
        '제목: ' + (focusMail.subject || ''),
        '보낸사람: ' + (focusMail.sender_name || '') + ' <' + (focusMail.sender_email || '') + '>',
        '받은시각: ' + (focusMail.received_at || ''),
        '진짜 첨부: ' + attLine,
        prior ? ('이전 분석 결과: ' + prior) : '',
        threadBlock,
        attachmentContent.text,
        '',
        '[본문]',
        String(focusMail.body || focusMail.preview || '').slice(0, 6000),
        '',
        '[질문] ' + q
      ].filter(Boolean).join(String.fromCharCode(10));
      // ★ 서버 저장 이력 우선 — 클라이언트가 새로고침돼도 "이전 대화 N턴 이어보기"가 가능하다.
      let persisted = [];
      try { persisted = db.getChatHistory(focusMail.id, 40); } catch (e) { persisted = []; }
      const mergedHistory = (persisted.length
        ? persisted.map(h => ({ role: h.role, content: h.content }))
        : (history || [])).slice(-8);
      const res = await analyzer.chatOverMails({
        keys, model: getModel(), contextMails: [focusMail], question: ask, history: mergedHistory
      });
      try {
        db.saveChatTurn(focusMail.id, 'user', q);
        if (res.ok) db.saveChatTurn(focusMail.id, 'assistant', res.content || '');
      } catch (e) { /* 이력 저장 실패는 대화 자체를 막지 않는다 */ }
      rememberChatResult([focusMail], '선택한 메일', []);
      return Object.assign({}, res, {
        kind: 'focus', focusMailId: focusMail.id, contextCount: 1,
        mails: [mailBrief(focusMail)],
        chips: [{ kind: 'scope', label: '이 메일: ' + String(focusMail.subject || '').slice(0, 24) }],
        attachmentChips: attachmentContent.chips,
        historyTurns: persisted.length, dbTotal
      });
    }

    //  선택 메일이 없는데 '이거 뭐야'류 질문이면 검색으로 새지 않는다.
    //   직전 결과가 있으면 그것을, 없으면 무엇을 대상으로 할지 되묻는다(동기화 권유 금지).
    if (!focusMail && focusIntent && !explicitSearch && !TODO_INTENT_RE.test(q) && !hasPrev) {
      return { ok: true, kind: 'chat', needTarget: true, contextCount: 0, mails: [],
               chips: [{ kind: 'scope', label: '대상 없음' }],
               content: '대화할 메일을 먼저 선택하시거나, 검색 조건(발신자·기간·키워드)을 알려 주세요.', dbTotal };
    }

    // ---- (0-b) ★ 탭 전환 지시 — 새 검색·AI 호출 없이 직전 결과를 즉시 재구성 ----
    const tabSwitch = hasPrev ? detectTabSwitch(q) : null;
    if (tabSwitch) {
      const base = prevChatMails();
      if (!base.length) {
        return { ok: true, kind: 'chat', content: '직전 결과가 없어 전환할 수 없습니다. 먼저 검색해 주세요.',
                 contextCount: 0, mails: [], chips: [{ kind: 'scope', label: '대상 없음' }], dbTotal };
      }
      const subsetChips = [{ kind: 'scope', label: '직전 결과 ' + base.length + '건' }];
      rememberChatResult(base, chatCtx.label || '직전 결과', subsetChips);
      return {
        ok: true, kind: 'tab-switch', requestedTab: tabSwitch,
        content: `직전 결과 ${base.length}건을 ${TAB_LABEL[tabSwitch]} 로 정리했습니다.`,
        contextCount: base.length, mails: base.slice(0, 200).map(mailBrief),
        chips: subsetChips, dbTotal, resultTabs: buildResultTabs(base)
      };
    }

    // ---- (1) 할 일 브리핑 ("내가 뭘 하면 되니") ----
    if (TODO_INTENT_RE.test(q)) {
      const d = buildTodoDigest();
      if (!d.rows.length) {
        return { ok: true, kind: 'todo', content: '지금 처리할 회신 대기·할 일이 없습니다.',
                 contextCount: 0, mails: [], chips: [{ kind: 'intent', label: '할 일 브리핑' }], dbTotal };
      }
      const lines = d.rows.map((m, i) =>
        (i + 1) + '. [' + m.todoKind + (m.todoNote ? ' · ' + m.todoNote : '') + '] ' +
        (m.subject || '(제목 없음)') + ' — ' + (m.sender_name || m.sender_email || '') + ' (' + (m.received_at || '') + ')');
      const ask = [
        '아래는 내가 지금 처리해야 할 후보 목록이다(회신 대기 ' + d.counts.unanswered + '건, 할 일 ' + d.counts.todo + '건, 보류 ' + d.counts.hold + '건).',
        lines.join(String.fromCharCode(10)),
        '',
        '이 목록만 근거로, 내가 지금 무엇부터 하면 되는지 우선순위 순으로 정리해라.',
        '마감이 임박하거나 오래 방치된 것을 앞에 두고, 각 항목에 왜 급한지 한 줄 이유를 붙여라.',
        '목록에 없는 메일은 절대 언급하지 마라.'
      ].join(String.fromCharCode(10));
      //  ★ Groq 무료 한도는 분당 8K 토큰이다. 목록 텍스트(lines)에 이미 제목·발신자가 들어가므로
      //    본문 컨텍스트는 상위 10건만 넘겨 토큰을 아낀다(429 로 답이 아예 안 나오던 실측 사고 방지).
      const res = await analyzer.chatOverMails({ keys, model: getModel(), contextMails: d.rows.slice(0, 10), question: ask, history: [] });
      rememberChatResult(d.rows, '할 일 후보', chips);
      return Object.assign({}, res, {
        kind: 'todo', contextCount: d.rows.length, todoCounts: d.counts,
        mails: d.rows.map(mailBrief), chips: [{ kind: 'intent', label: '할 일 브리핑' }], dbTotal,
        resultTabs: buildResultTabs(d.rows)
      });
    }

    // ---- (2) 후속 지시 -> 직전 결과 집합에 적용 (새 검색 금지) ----
    const noNewTarget = !structured && !kws.length;
    const isFollowup = hasPrev && (FOLLOWUP_RE.test(q) || noNewTarget || focusIntent ||
      (BRIEFING_RE.test(q) && !cond.sinceTs && !cond.untilTs));
    if (isFollowup) {
      let base = prevChatMails();
      if (cond.hasAttach) base = base.filter(m => Number(m.real_attach_count != null ? m.real_attach_count : m.attach_count) > 0);
      if (cond.unreadOnly) base = base.filter(m => m.unread);
      if (cond.sender) base = base.filter(m => ((m.sender_name || '') + ' ' + (m.sender_email || '')).indexOf(cond.sender) >= 0);
      const subsetChips = [{ kind: 'scope', label: '직전 결과 ' + chatCtx.mailIds.length + '건' }]
        .concat((cond.chips || []).filter(c => c.kind !== 'keyword').map(c => ({ kind: c.kind, label: c.label })));
      if (!base.length) {
        return { ok: true, kind: 'chat', content: '직전 결과 중에 그 조건에 맞는 메일이 없습니다.',
                 contextCount: 0, mails: [], chips: subsetChips, usedPrevious: true, dbTotal };
      }
      const ask = [
        '[대상] 바로 앞에서 보여 준 메일 ' + base.length + '건이다. 새로 검색하지 말고 이 목록만 근거로 답하라.',
        '[지시] ' + q
      ].join(String.fromCharCode(10));
      const res = await analyzer.chatOverMails({
        keys, model: getModel(), contextMails: base.slice(0, 30), question: ask, history: (history || []).slice(-4)
      });
      rememberChatResult(base, chatCtx.label || '직전 결과', subsetChips);
      return Object.assign({}, res, {
        kind: 'chat', usedPrevious: true, contextCount: base.length,
        mails: base.slice(0, 30).map(mailBrief), chips: subsetChips, dbTotal
      });
    }

    // ---- (3) 새 검색 ----
    let matched = [];
    if (structured) {
      matched = runConditionSearch(cond, 400).mails;
      if (!matched.length && kws.length) matched = groundingSearch(q, 30);
    } else {
      matched = groundingSearch(q, 30);
    }
    const grounded = rankGrounding(matched, kws, structured ? 30 : 12);
    //  선택 메일도 없고 검색도 0건이면 '무엇을 대상으로 할지' 물어본다(동기화 권유 금지)
    if (!grounded.length && !matched.length && !hasPrev && !explicitSearch) {
      return { ok: true, kind: 'chat', needTarget: true, contextCount: 0, mails: [], chips,
               content: '대화할 메일을 먼저 선택하시거나, 검색 조건(발신자·기간·키워드)을 알려 주세요.', dbTotal };
    }

    // ---- (4) 기간 브리핑 ----
    if (wantsBriefing && matched.length) {
      const day = singleDayOf(cond);
      if (day) {
        const b = await dailyBriefingFor(day, false);
        if (b.ok) {
          rememberChatResult(matched, day, chips);
          return { ok: true, kind: 'briefing', briefingKind: 'daily', date: day,
                   structured: b.structured, content: b.content, cached: b.cached, usedKeyIndex: b.usedKeyIndex,
                   contextCount: b.count != null ? b.count : matched.length,
                   mails: matched.slice(0, 30).map(mailBrief), chips, dbTotal };
        }
        return { ok: false, error: b.error, chips, contextCount: matched.length };
      }
      const label = (chips.find(c => c.kind === 'date') || {}).label || '지정 기간';
      const res = await analyzer.briefing({
        keys, model: getModel(), mails: matched.slice(0, 300), periodLabel: label,
        onProgress: aiProgress('briefing'), concurrency: getConcurrency()
      });
      rememberChatResult(matched, label, chips);
      return Object.assign({}, res, {
        kind: 'briefing', briefingKind: 'period', period: label,
        contextCount: matched.length, mails: matched.slice(0, 30).map(mailBrief), chips, dbTotal
      });
    }

    // ---- (4-b) ★ 검색 결과 → 타임라인(날짜별 요약) + 목록/사람별/키워드별 집계 ----
    //   마스터 지시: "8월에 설병헌이 보낸 hole 관련 메일 찾아줘" 류뿐 아니라, 진짜 '검색'이면
    //   (조건 있음 또는 찾아줘/검색 같은 명시 동사) 무조건 결과를 나열만 하지 않고 정리·요약한다.
    if (explicitSearch && !wantsBriefing && matched.length) {
      const allGroups = groupMailsByDate(matched);
      const capLimit = 60;
      const queryLabel = chips.map(c => c.label).join(' · ');
      let dateGroups = allGroups.map(g => ({ date: g.date, count: g.count, summary: '' }));
      let overall = [];
      let summarizeFailed = false;
      let promptReduced = false;
      try {
        const sres = await analyzer.summarizeByDate({ keys, model: getModel(), mails: matched, queryLabel, maxMails: capLimit });
        promptReduced = !!sres.promptReduced;
        if (sres.ok && sres.structured) {
          const byDate = new Map(sres.structured.perDate.map(x => [x.date, x.summary]));
          dateGroups = dateGroups.map(g => Object.assign({}, g, { summary: byDate.get(g.date) || '' }));
          overall = sres.structured.overall;
        } else summarizeFailed = true;
      } catch (e) { summarizeFailed = true; }
      const summarizedCount = Math.min(matched.length, capLimit);
      const truncNote = matched.length > capLimit ? `${matched.length}건 중 ${summarizedCount}건 요약` : '';
      const content = (overall.length ? overall.join(' ') : `조건에 맞는 메일 ${matched.length}건을 찾았습니다.`) +
        (truncNote ? ` (${truncNote})` : '') + (summarizeFailed ? ' (날짜별 요약은 지금 생성하지 못했습니다 — 목록은 정상입니다)' : '');
      rememberChatResult(matched, queryLabel, chips);
      return {
        ok: true, kind: 'search-grouped', content,
        contextCount: matched.length, matchedCount: matched.length, summarizedCount, truncNote,
        mails: matched.slice(0, 200).map(mailBrief),
        dateGroups, overall, chips, dbTotal,
        promptReduced,
        resultTabs: buildResultTabs(matched)
      };
    }

    // ---- (5) 일반 대화 ----
    const res = await analyzer.chatOverMails({
      keys, model: getModel(), question: q, contextMails: grounded,
      history: history || [], extraContext: context || ''
    });
    rememberChatResult(grounded.length ? grounded : matched, (chips[0] || {}).label || '', chips);
    return Object.assign({}, res, {
      kind: 'chat', contextCount: grounded.length, matchedCount: matched.length,
      mails: grounded.map(mailBrief), chips, dbTotal,
      resultTabs: buildResultTabs(grounded)
    });
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

//  근거 메일을 화면에 넘길 때 쓰는 최소 필드
function mailBrief(m) {
  return {
    id: m.id, subject: m.subject, sender_name: m.sender_name, sender_email: m.sender_email,
    received_at: m.received_at, folder: m.folder, has_attach: m.has_attach, attach_count: m.attach_count
  };
}

// ============================================================
//  ★ 4탭(마스터 지시) — 타임라인 자동요약(비동기)
//  ------------------------------------------------------------
//  리스트/집계표(resultTabs)는 검색 응답에 이미 동기로 실려 있다(즉시 렌더 가능).
//  AI 요약(날짜별 한줄+종합)만 별도 왕복으로 비동기 요청한다 — 화면이 요약을
//  기다리며 멈추지 않게 하기 위함. 같은 결과집합(id 조합)은 재요약하지 않는다(캐시).
// ============================================================
const groupSummaryCache = new Map();   // key(queryLabel|id,id,...) -> { at, res }
const GROUP_SUMMARY_TTL = 30 * 60 * 1000;
function summaryCacheKey(ids, queryLabel) {
  return String(queryLabel || '') + '|' + [...new Set(ids)].sort((a, b) => a - b).join(',');
}
ipcMain.handle('ai:summarizeGroups', async (_e, { ids, queryLabel = '', capLimit = 60 } = {}) => {
  try {
    requireDb();
    const keys = getKeys();
    if (!keys.length) return { ok: false, error: 'API 키가 설정되지 않았습니다.' };
    const list = (Array.isArray(ids) ? ids : []).slice(0, 300);
    if (!list.length) return { ok: false, error: '요약할 메일이 없습니다.' };
    const key = summaryCacheKey(list, queryLabel);
    const cached = groupSummaryCache.get(key);
    if (cached && (Date.now() - cached.at) < GROUP_SUMMARY_TTL) return Object.assign({}, cached.res, { cached: true });
    const mails = list.map(id => db.getMailById(id)).filter(Boolean);
    if (!mails.length) return { ok: false, error: '요약할 메일이 없습니다.' };
    const sres = await analyzer.summarizeByDate({ keys, model: getModel(), mails, queryLabel, maxMails: capLimit });
    if (!sres.ok) return sres;
    const out = {
      ok: true, overall: sres.structured.overall, perDate: sres.structured.perDate,
      promptReduced: !!sres.promptReduced,
      summarizedCount: Math.min(mails.length, capLimit), totalCount: mails.length
    };
    groupSummaryCache.set(key, { at: Date.now(), res: out });
    if (groupSummaryCache.size > 40) groupSummaryCache.delete(groupSummaryCache.keys().next().value);
    return out;
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// ============================================================
//  AI 상태 / 제공자 / 모델 / 연결 테스트 / 사용량
//  ------------------------------------------------------------
//  화면에는 raw JSON 을 절대 노출하지 않는다 — ai-errors 가 만든 문구만 넘긴다.
// ============================================================
ipcMain.handle('ai:status', () => {
  try {
    const c = aiConfig();
    const h = cerebras.healthStatus(c.keys);
    return { ok: true, state: h.state, label: h.label, info: h.info, lastOkAt: h.lastOkAt,
             keyCount: c.keys.length, provider: c.provider, providerLabel: c.label, model: c.model, baseUrl: c.baseUrl,
             chain: cerebras.currentChain(), lastSwitch: cerebras.lastSwitchInfo(),
             limitWarning: cerebras.lastLimitInfo(), usage: cerebras.usageSnapshot(), registered: aiChain().length };
  } catch (e) {
    const info = aiErrors.describe({ message: String(e.message || e) });
    return { ok: false, state: 'error', label: info.title, info };
  }
});

//  오늘 사용량 (설정 화면 '오늘 사용량' 표시)
ipcMain.handle('ai:usage', () => {
  try {
    return { ok: true, usage: cerebras.usageSnapshot(), chain: cerebras.currentChain(), limitWarning: cerebras.lastLimitInfo() };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

//  제공자 프리셋 목록 + 등록된 체인 (설정 화면)
ipcMain.handle('ai:providers', () => {
  try {
    const c = aiConfig();
    const chain = aiChain();
    return {
      ok: true, presets: aiProviders.listPresets(), current: c.provider,
      baseUrl: c.baseUrl, model: c.model, keyUrl: c.keyUrl, note: c.note, keys: c.keys,
      chain: chain.map(e => ({
        provider: e.provider, label: e.label, baseUrl: e.rawBaseUrl, model: e.model,
        keys: e.keys, accountId: e.accountId, enabled: e.enabled, usable: e.usable,
        needsKey: e.needsKey, needsAccountId: e.needsAccountId,
        free: e.free, card: e.card, training: e.training, privacy: e.privacy, note: e.note
      })),
      runtime: cerebras.currentChain(),
      lastSwitch: cerebras.lastSwitchInfo(),
      usage: cerebras.usageSnapshot()
    };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

//  제공자의 모델 목록 조회 (/models). 드롭다운 채우기용.
ipcMain.handle('ai:models', async (_e, { provider, baseUrl, key } = {}) => {
  try {
    const cur = aiConfig();
    const pid = provider || cur.provider;
    const base = aiProviders.normalizeBaseUrl(baseUrl || (provider ? aiProviders.getPreset(pid).baseUrl : cur.baseUrl));
    const useKey = key || (aiProviders.keysFor({
      aiChain: store.get('aiChain'), aiProvider: pid,
      apiKeys: store.get('apiKeys'), apiKeysByProvider: store.get('apiKeysByProvider')
    }, pid)[0] || '');
    const r = await cerebras.listModels({ url: aiProviders.modelsUrl(base), key: useKey });
    if (!r.ok) return r;
    return { ok: true, models: aiProviders.sortModels(r.models, pid), provider: pid, baseUrl: base };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

//  [전체 연결 테스트] — 등록된 모든 제공자·키를 실호출해 표로 돌려준다
ipcMain.handle('ai:chainTest', async () => {
  try {
    const chain = aiChain();
    const rows = [];
    for (const e of chain) {
      if (!e.chatUrl) {
        rows.push({ provider: e.provider, label: e.label, key: '-', ok: false, state: 'error',
                    status: '', model: e.model, ms: 0, detail: '베이스 URL 이 비어 있습니다' });
        continue;
      }
      const keys = e.keys.length ? e.keys : (e.needsKey ? [] : ['local']);
      if (!keys.length) {
        rows.push({ provider: e.provider, label: e.label, key: '-', ok: false, state: 'nokey',
                    status: '', model: e.model, ms: 0, detail: '키가 없습니다' });
        continue;
      }
      for (const k of keys) {
        const t0 = Date.now();
        const r = await cerebras.probeKeys([k], e.model, e.chatUrl);
        const row = r[0] || {};
        rows.push({
          provider: e.provider, label: e.label, key: row.tail || ('…' + String(k).slice(-4)),
          ok: !!row.ok, state: row.state || (row.ok ? 'ok' : 'error'),
          status: String(row.detail || '').replace(/^HTTP (\d+).*$/, '$1'),
          model: e.model, ms: Date.now() - t0, detail: row.detail || row.label || '',
          enabled: e.enabled
        });
      }
    }
    const usable = rows.filter(r => r.ok).length;
    applyAiConfig();
    return { ok: true, rows, usable, total: rows.length };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// --- 주소록 가져오기 (Outlook → DB) ---
ipcMain.handle('contacts:import', async () => {
  try {
    requireDb();
    if (store.get('source') !== 'outlook') {
      return { ok: false, error: '주소록 가져오기는 Outlook 연동 모드에서만 지원됩니다.' };
    }
    // 전 스토어 · 하위폴더 재귀 · 배포목록(그룹)까지 전량 수집
    const items = await outlook.getAllContacts(20000);
    const r = db.upsertAddressBook(items);
    const s = db.addressBookStats();
    return { ok: true, imported: r.persons + r.groups, ...r, stats: s };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// --- 주소록 통계 / 그룹 멤버 ---
ipcMain.handle('contacts:stats', () => {
  try { requireDb(); return { ok: true, stats: db.addressBookStats() }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
});
ipcMain.handle('contacts:groupMembers', (_e, { groupId }) => {
  try { requireDb(); return { ok: true, members: db.getGroupMembers(groupId) }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// --- 주소록 목록 (DB) ---
ipcMain.handle('contacts:list', (_e, { query, limit, sort }) => {
  try { requireDb(); return { ok: true, contacts: db.listContacts(limit || 500, query || '', sort === 'name' ? 'name' : 'recent') }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// ============================================================
//  새 메일 / 답장 작성창 열기 (Outlook 브리지)
//  ★ 발송(Send)은 절대 하지 않는다. 작성창만 띄우고 발송은 마스터가 직접.
// ============================================================
ipcMain.handle('compose:open', async (_e, opts) => {
  try {
    const o = opts || {};
    if (store.get('source') === 'pst') {
      return { ok: false, error: 'PST 모드에서는 메일 작성을 열 수 없습니다. 상단에서 실시간(Outlook) 모드로 전환하세요.' };
    }
    return await outlook.composeMail({
      mode: o.mode || 'new',
      entryId: o.entryId || '',
      to: o.to || '', cc: o.cc || '',
      subject: o.subject || '', body: o.body || '',
      useSignature: o.useSignature !== false && store.get('useOutlookSignature') !== false,
      // 'Outlook 기본 서명 따름'(빈 값)이면 outlook.js 가 첫 서명을 자동 선택한다
      signatureName: o.signatureName || store.get('signatureName') || ''
    });
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// --- Outlook 서명 조회 (초안 미리보기용 · 텍스트) ---
ipcMain.handle('compose:signature', async (_e, { name } = {}) => {
  try { return await outlook.getSignature(name || ''); }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// --- Outlook 서명 HTML 원본 (서식·로고 포함, 설정 화면 진단용) ---
ipcMain.handle('compose:signatureHtml', (_e, { name } = {}) => {
  try {
    const r = outlook.getSignatureHtml(name || store.get('signatureName') || '');
    if (!r.ok) return r;
    // HTML 원본 전체는 무거우니 진단에 필요한 요약만 넘긴다
    return {
      ok: true, name: r.name, encoding: r.encoding, list: r.list,
      length: r.html.length, imageCount: r.imageCount,
      textPreview: r.textPreview,
      hasMalgun: /맑은\s*고딕|Malgun/i.test(r.html),
      colors: [...new Set((r.html.match(/#[0-9a-fA-F]{6}/g) || []))].slice(0, 6)
    };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// --- Outlook 폴더 계층 트리 (UI 폴더 트리용) + DB 메일건수 매칭 ---
//  ★ COM 열거는 244폴더 기준 실측 9.4초가 걸린다. 앱을 켜자마자 트리가 비어 보이는 것을 막기 위해
//    마지막 결과를 userData 에 캐시해 두고, 렌더러가 { cached:true } 로 먼저 즉시 그린 뒤
//    같은 채널을 인자 없이 다시 호출해 실제 Outlook 값으로 교체한다.
function treeCachePath() {
  return path.join(app.getPath('userData'), 'folder-tree-cache.json');
}
// 메일 폴더가 아니거나 Outlook 자신도 탐색 창에 숨기는 폴더 — 트리에서 제외한다.
//  DefaultItemType: 0=메일, 1=일정, 2=연락처, 3=작업, 4=업무일지, 5=메모
const TREE_HIDE_NAMES = new Set([
  '대화 동작 설정', 'Conversation Action Settings',
  '빠른 단계 설정', 'Quick Step Settings',
  '동기화 문제', 'Sync Issues', 'Yammer Root', 'ExternalContacts',
  'PersonMetadata', 'Recipient Cache', 'Organizational Contacts', 'GAL Contacts'
]);
function visibleMailFolders(folders) {
  const hidden = new Set();                 // '스토어/경로' — 숨긴 폴더의 자식도 함께 숨긴다
  const out = [];
  for (const f of folders || []) {
    const key = `${f.store}/${f.path}`;
    const parentHidden = f.parentPath && hidden.has(`${f.store}/${f.parentPath}`);
    const nonMail = Number(f.defaultType) > 0;
    if (parentHidden || nonMail || TREE_HIDE_NAMES.has(String(f.name))) { hidden.add(key); continue; }
    out.push(f);
  }
  return out;
}
ipcMain.handle('outlook:folderTree', async (_e, opts) => {
  try {
    // 캐시 경로: Outlook 을 건드리지 않고 즉시 반환 (앱 시작 시 첫 렌더용)
    if (opts && opts.cached) {
      try {
        const raw = fsMain.readFileSync(treeCachePath(), 'utf8');
        const c = JSON.parse(raw);
        if (c && Array.isArray(c.folders) && c.folders.length) {
          let counts = {}, byName = {};
          try { requireDb(); counts = db.statsByFolderStore(); byName = db.stats().byFolder || {}; } catch (_) {}
          const CANON = { '받은 편지함': 'Inbox', '보낸 편지함': 'Sent', '지운 편지함': 'Deleted', '보낼 편지함': 'Outbox', '임시 보관함': 'Drafts', '정크 메일': 'Junk' };
          const folders = c.folders.map(f => {
            const k = `${f.store}/${CANON[f.name] || f.name}`;
            const n = counts[k];
            return { ...f, dbCount: n !== undefined ? n : (byName[CANON[f.name] || f.name] || 0) };
          });
          return { ok: true, folders, cached: true, at: c.at || '' };
        }
      } catch (_) {}
      return { ok: true, folders: [], cached: true, at: '' };
    }
    const r = await outlook.listFolderTree(6);
    if (!r.ok) return r;
    r.folders = visibleMailFolders(r.folders);
    // DB 의 folder(=폴더 이름) 별 건수를 붙여 준다
    // 동명 폴더가 스토어를 넘어 합산되지 않도록 '스토어/폴더명' 키로 매칭한다
    let counts = {}, byName = {};
    try { requireDb(); counts = db.statsByFolderStore(); byName = db.stats().byFolder || {}; } catch (_) {}
    const CANON = { '받은 편지함': 'Inbox', '보낸 편지함': 'Sent', '지운 편지함': 'Deleted', '보낼 편지함': 'Outbox', '임시 보관함': 'Drafts', '정크 메일': 'Junk' };
    const folders = (r.folders || []).map(f => {
      const key = `${f.store}/${CANON[f.name] || f.name}`;
      const c = counts[key];
      return { ...f, dbCount: c !== undefined ? c : (byName[CANON[f.name] || f.name] || 0) };
    });
    // 다음 실행 때 즉시 그릴 수 있도록 구조를 캐시 (건수는 저장하지 않고 매번 DB 에서 다시 붙인다)
    const at = new Date().toISOString();
    try {
      fsMain.writeFileSync(treeCachePath(), JSON.stringify({
        at, folders: folders.map(({ dbCount, ...rest }) => rest)
      }), 'utf8');
    } catch (e) { console.error('폴더 트리 캐시 저장 실패:', e.message); }
    return { ok: true, folders, at };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// --- Outlook 탐색 창 즐겨찾기 가져오기 (목록 + 순서 그대로, 읽기 전용) ---
ipcMain.handle('fav:syncOutlook', async () => {
  try {
    requireDb();
    const r = await outlook.listNavFavorites();
    if (!r.ok) return r;
    const favs = (r.favorites || []).filter(f => f.groupType === 4 || /즐겨찾기|Favorite/i.test(f.group || ''));
    const use = favs.length ? favs : (r.favorites || []);
    const res = db.syncOutlookFavorites(use);
    return { ok: true, ...res, favorites: db.listFavorites() };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// ============================================================
//  PST · 데이터 파일 관리 (읽기 전용 진단 + 수집 대상 선택)
//  ★ PST 추가/제거/압축은 Outlook 원본을 바꾸는 행위 → 이 앱에서 절대 하지 않는다.
//    여기서는 "무엇이 연결돼 있고 얼마나 수집됐는지" 보여주고 수집 대상만 고른다.
// ============================================================
ipcMain.handle('pst:stores', async () => {
  try {
    const st = await outlook.listStores();
    if (!st.ok) return st;
    const tree = await outlook.listFolderTree(6);
    const folders = tree.ok ? (tree.folders || []) : [];

    // DB 적재 건수(폴더 이름 기준) — 스토어별 합산
    let dbByFolder = {};
    try { requireDb(); dbByFolder = db.stats().byFolder || {}; } catch (_) {}

    const sel = store.get('archiveStoreNames');
    const selected = Array.isArray(sel) ? sel : null;   // null = 전체
    const rows = (st.stores || []).map(s => {
      const mine = folders.filter(f => f.store === s.name);
      const outlookItems = mine.reduce((a, f) => a + (f.items || 0), 0);
      // 같은 폴더 이름이 여러 스토어에 있으면 중복 계산될 수 있어 폴더명 집합으로 계산
      const names = new Set(mine.map(f => f.name));
      let dbItems = 0;
      names.forEach(n => { dbItems += dbByFolder[n] || 0; });
      let sizeMB = null;
      try {
        if (s.path && fsMain.existsSync(s.path)) sizeMB = Math.round(fsMain.statSync(s.path).size / 1048576);
      } catch (_) {}
      return {
        name: s.name, path: s.path || '', isDefault: !!s.isDefault,
        folderCount: mine.length, outlookItems, dbItems, sizeMB,
        included: s.isDefault ? true : (selected === null || selected.includes(s.name))
      };
    });
    return { ok: true, stores: rows, selectionMode: selected === null ? 'all' : 'custom' };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});

// --- Outlook 스토어 목록 (기본 계정 / 추가 마운트된 아카이브 PST) ---
ipcMain.handle('outlook:listStores', async () => {
  try { return await outlook.listStores(); }
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
