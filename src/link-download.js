// ============================================================
//  link-download.js — 메일 본문 링크 클릭 → 파일/대용량첨부 링크는 바로 다운로드
//  ------------------------------------------------------------
//  마스터 요청(2026-10): "링크를 클릭하면 별도 버튼 클릭 없이 바로 다운로드".
//   · 일반 링크          → 기존대로 외부 브라우저(shell.openExternal)
//   · 다운로드 후보 링크 → 숨김 창(전용 세션)에서 열고 will-download 를 대화상자 없이 저장
//   · 랜딩 페이지        → 다운로드 버튼이 1개(또는 '전체 다운로드')일 때만 1회 자동 클릭
//   · 그 외(로그인·캡차·입력 필요·여러 파일·시간 초과) → 브라우저로 폴백 + 알림(조용한 실패 금지)
//
//  🔴 보안
//   · 실행형 확장자는 자동 저장하지 않는다(취소 + 알림, 받을지는 마스터가 브라우저에서 결정).
//   · 받은 파일을 자동 실행·자동 열기 하지 않는다(완료 알림에 버튼만).
//   · 숨김 창에서 폼 입력·자격증명 입력을 하지 않는다(클릭 1회가 전부).
//   · http(s) 외 스킴은 무시한다(mailto 만 기존대로 외부 처리).
//
//  순수 판정 함수(classifyLink·pickLandingAction 등)는 electron 없이 테스트된다.
//  electron 객체는 createLinkDownloader() 에 주입받는다(셀프체크가 plain node 로 돈다).
// ============================================================
'use strict';
const path = require('path');
const fs = require('fs');

// ---- 다운로드 후보: 대용량첨부 서비스 패턴 ----
//  근거: 실DB 본문 링크 빈도 실측 2026-10 (최근 6000건). 빈도순.
//  구조 확인(2026-10-06 HTML GET): mailplug = 307 → filefree2 직링크(만료 시 alert 페이지),
//  naver = Content-Disposition 직링크, daum = 만료 시 alert 페이지, hanwha = 사내망(외부 접속 불가).
//  제외: mybox.naver.com/saveFile (MYBOX 클라우드 '저장' — 로그인 필요, 다운로드 아님),
//        img.mailplug.com (첨부 아이콘 이미지).
const DOWNLOAD_PATTERNS = [
  { service: 'mailplug', host: /^filefree\d*\.mailplug\.com$/i, path: /^\/download\//i },
  { service: 'hanwha', host: /^ep\.circle\.hanwha\.com$/i, path: /^\/neo\/bigmail\//i },
  { service: 'naver', host: /^bigfile\.mail\.naver\.com$/i, path: /^\/download/i },
  { service: 'kreng', host: /^gwa\.kreng\.co\.kr$/i, path: /^\/mail2\/file/i },
  { service: 'daum', host: /^attach\.mail\.daum\.net$/i, path: /^\/bigfile\/v1\//i },
  { service: 'officeplugin', host: /^attachment\.(?:officeplugin|totlelab)\.com$/i, path: /^\/outlook\/downloadFile2/i },
  { service: 'kte', host: /^webmail\.kte\.co\.kr$/i, path: /^\/mail\/mail_attach_down\.jsp/i },
  { service: 'hyundai', host: /^autowayatt\.hyundai\.net$/i, path: /^\/BigFileDownload\.aspx/i }
];

// 경로 끝이 이 확장자면 파일 링크로 본다(문서·도면·압축·오피스)
const FILE_EXTS = new Set([
  'pdf', 'zip', '7z', 'rar', 'alz', 'egg', 'tar', 'gz', 'tgz',
  'dwg', 'dxf', 'dwf', 'step', 'stp', 'igs', 'iges',
  'xls', 'xlsx', 'xlsm', 'xlsb', 'csv', 'doc', 'docx', 'ppt', 'pptx', 'hwp', 'hwpx', 'rtf'
]);
// 실행형 — 자동 저장 금지
const EXEC_EXTS = new Set([
  'exe', 'msi', 'msix', 'msp', 'appx', 'appxbundle', 'bat', 'cmd', 'com', 'ps1', 'psm1', 'vbs', 'vbe',
  'js', 'jse', 'wsf', 'wsh', 'jar', 'scr', 'lnk', 'hta', 'pif', 'cpl', 'reg', 'dll', 'msc', 'inf',
  'scf', 'url', 'chm', 'application', 'gadget', 'iso', 'img', 'vhd', 'vhdx'
]);

function extOf(name) {
  const base = String(name || '').split(/[\\/]/).pop().replace(/[\s.]+$/, '');
  const m = base.match(/\.([A-Za-z0-9]{1,12})$/);
  return m ? m[1].toLowerCase() : '';
}
function isExecutableName(name) { return EXEC_EXTS.has(extOf(name)); }

function urlExt(u) {
  let p = u.pathname || '';
  try { p = decodeURIComponent(p); } catch { /* 깨진 퍼센트 인코딩은 원문 그대로 */ }
  return extOf(p);
}

// Proofpoint v2 래핑 해제: ?u=https-3A__host_path  ('-'→'%', '_'→'/')
function unwrapUrl(raw) {
  let u = String(raw || '').trim();
  for (let depth = 0; depth < 3; depth++) {
    let p; try { p = new URL(u); } catch { return u; }
    if (!(/(^|\.)urldefense\.proofpoint\.com$/i.test(p.hostname) && /^\/v2\/url/i.test(p.pathname))) return u;
    const m = p.search.match(/[?&]u=([^&]+)/);
    if (!m) return u;
    try { u = decodeURIComponent(m[1].replace(/-/g, '%').replace(/_/g, '/')); } catch { return u; }
  }
  return u;
}

// 링크 1개 판정 → { action: 'external'|'download'|'blocked'|'ignore', url, target, service?, ext?, reason }
//  url    = 실제로 열 주소(래핑 원본 유지 — 보안 게이트웨이 검사를 우회하지 않는다)
//  target = 판정에 쓴 주소(래핑 해제본)
function classifyLink(raw) {
  const url = String(raw || '').trim();
  let scheme;
  try { scheme = new URL(url).protocol.toLowerCase(); } catch { return { action: 'ignore', url, target: url, reason: 'URL 해석 불가' }; }
  if (scheme === 'mailto:') return { action: 'external', url, target: url, reason: 'mailto' };
  if (scheme !== 'http:' && scheme !== 'https:') return { action: 'ignore', url, target: url, reason: 'http(s) 외 스킴' };
  const target = unwrapUrl(url);
  let p;
  try { p = new URL(target); } catch { return { action: 'external', url, target, reason: '래핑 해제 실패' }; }
  if (p.protocol !== 'http:' && p.protocol !== 'https:') return { action: 'ignore', url, target, reason: '래핑 안 주소가 http(s) 아님' };
  const ext = urlExt(p);
  if (EXEC_EXTS.has(ext)) return { action: 'blocked', url, target, ext, reason: `실행형 파일(.${ext}) — 자동 저장 차단` };
  const svc = DOWNLOAD_PATTERNS.find(s => s.host.test(p.hostname) && s.path.test(p.pathname));
  if (svc) return { action: 'download', url, target, service: svc.service, ext, reason: '대용량첨부 서비스' };
  if (FILE_EXTS.has(ext)) return { action: 'download', url, target, service: 'file', ext, reason: '파일 확장자' };
  return { action: 'external', url, target, reason: '일반 링크' };
}

// ---- 파일명·저장 경로 ----
const RESERVED_WIN = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;
function sanitizeFileName(name) {
  let s = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[\s.]+$/, '').trim();
  if (!s) s = 'download';
  if (RESERVED_WIN.test(s)) s = '_' + s;
  if (s.length > 180) { const e = path.extname(s); s = s.slice(0, 180 - e.length) + e; }
  return s;
}
// 같은 이름이 있으면 "이름 (1).확장자" … 로 피한다(덮어쓰기 금지)
function uniqueSavePath(dir, name, taken) {
  const isTaken = typeof taken === 'function' ? taken : (p) => fs.existsSync(p);
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let cand = path.join(dir, name);
  for (let i = 1; isTaken(cand) && i < 10000; i++) cand = path.join(dir, `${stem} (${i})${ext}`);
  return cand;
}

// ---- 랜딩 페이지 판정 (순수) ----
//  snap: 페이지 검사 결과 { hasPassword, hasCaptcha, needsInput, alertMsg, candidates:[{i,label,href}] }
const DL_WORD = /다운로드|download|받기/i;
const ALL_WORD = /전체|모두|일괄|\ball\b|zip/i;
//  '앱 다운로드'·'뷰어 설치' 같은 프로그램 설치 유도 버튼은 절대 누르지 않는다
const EXCLUDE_WORD = /앱|\bapp\b|설치|install|뷰어|viewer|플러그인|plug-?in|프로그램|program|매니저|manager|agent|에이전트/i;

function downloadCandidates(snap) {
  const seenHref = new Set();
  const out = [];
  for (const c of (snap && snap.candidates) || []) {
    const label = String(c.label || '');
    if (!DL_WORD.test(label) || EXCLUDE_WORD.test(label)) continue;
    const href = /^https?:/i.test(c.href || '') ? c.href : '';
    if (href) { if (seenHref.has(href)) continue; seenHref.add(href); }   // 같은 파일의 아이콘+글자 링크
    out.push(c);
  }
  return out;
}
function blockingReason(snap) {
  if (!snap) return '';
  if (snap.hasPassword) return '로그인/비밀번호 입력이 필요한 페이지';
  if (snap.hasCaptcha) return '보안문자(캡차) 확인이 필요한 페이지';
  if (snap.needsInput) return '인증번호 등 입력이 필요한 페이지';
  return '';
}
// → { kind:'click', i, label } | { kind:'fallback', reason } | { kind:'wait' }
function pickLandingAction(snap) {
  if (!snap) return { kind: 'wait' };
  const block = blockingReason(snap);
  if (block) return { kind: 'fallback', reason: block };
  const dl = downloadCandidates(snap);
  const all = dl.filter(c => ALL_WORD.test(c.label));
  if (all.length) return { kind: 'click', i: all[0].i, label: all[0].label };
  if (dl.length === 1) return { kind: 'click', i: dl[0].i, label: dl[0].label };
  if (dl.length > 1) return { kind: 'fallback', reason: `파일 ${dl.length}개 — 전체 다운로드 버튼이 없어 자동 선택하지 않음` };
  if (snap.alertMsg) return { kind: 'fallback', reason: `사이트 알림: ${snap.alertMsg}` };
  return { kind: 'wait' };
}
// 자동 클릭 1회 뒤 다시 페이지가 뜨면: 막힘 신호만 본다(두 번째 클릭은 하지 않는다)
function afterClickAction(snap) {
  const block = blockingReason(snap);
  if (block) return { kind: 'fallback', reason: block };
  if (snap && snap.alertMsg) return { kind: 'fallback', reason: `사이트 알림: ${snap.alertMsg}` };
  return { kind: 'wait' };
}

// 숨김 창 안에서 실행되는 검사 스크립트(읽기만 — 입력·제출 없음)
const INSPECT_JS = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  let els = [...document.querySelectorAll('a,button,input[type=button],input[type=submit],[role=button],[onclick]')].filter(vis);
  els = els.filter(el => !els.some(o => o !== el && o.contains(el)));
  window.__bmLdEls = els;
  const label = (el) => [el.innerText, el.value, el.getAttribute('aria-label'), el.title,
    ...[...el.querySelectorAll('img[alt]')].map(i => i.alt)].filter(Boolean).join(' ').replace(/\\s+/g, ' ').trim().slice(0, 120);
  const candidates = els.map((el, i) => ({ i, label: label(el), href: el.tagName === 'A' ? (el.href || '') : '' })).filter(c => c.label);
  const inputs = [...document.querySelectorAll('input,textarea,select')].filter(vis);
  const hasPassword = inputs.some(x => (x.type || '').toLowerCase() === 'password');
  const hasCaptcha = !!document.querySelector('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],.g-recaptcha,.h-captcha,[id*="captcha" i],[class*="captcha" i]');
  const needsInput = inputs.some(x => /^(text|number|tel|email|)$/i.test(x.type || '') &&
    /인증|비밀|암호|pass|code|otp|captcha|login|아이디|userid|user_id/i.test([x.name, x.id, x.placeholder].join(' ')));
  let alertMsg = '';
  for (const s of document.scripts) { const m = (s.textContent || '').match(/alert\\(\\s*(['"])([\\s\\S]{1,200}?)\\1/); if (m) { alertMsg = m[2]; break; } }
  return { title: document.title, hasPassword, hasCaptcha, needsInput, alertMsg, candidates: candidates.slice(0, 200) };
})()`;
const clickJs = (i) => `(() => { const el = (window.__bmLdEls || [])[${Number(i) | 0}]; if (!el) return false; el.click(); return true; })()`;

// ============================================================
//  다운로드 팝업 — 광고 팝업처럼 화면(작업영역) 우하단에 작은 창으로 뜬다 (마스터 지시 2026-10)
//   · 창 = 로컬 상단 띠(도메인·파일명·%·상태·버튼) + 그 아래 서비스 페이지(WebContentsView, 전용 세션)
//   · 자동 다운로드 성공 → 띠에 [열기][폴더 열기] → 5초 뒤 자동 닫힘(마우스가 창 위에 있으면 유지)
//   · 자동 불가(로그인·캡차·여러 파일·시간 초과) → 외부로 넘기지 않고 팝업을 키워(900×700) 그 창에서 직접 처리.
//     외부 브라우저는 띠의 [브라우저로 열기] 버튼으로만.
//   · 동시 여러 건: 우하단에서 위로 최대 3개 쌓고, 넘치면 대기열 → 자리가 나면 순서대로 뜬다.
//
//   deps: { BrowserWindow, WebContentsView, screen, ipcMain, session, shell, getSaveDir():string,
//           popupHtml, popupPreload, getParent?():BrowserWindow, getWorkArea?():Rect,
//           partition?, timeoutMs?, inspectDelayMs?, inspectTries?, autoCloseMs?, maxPopups?,
//           focusOnManual? }
// ============================================================
const POPUP_SIZE = { small: { width: 480, height: 360 }, large: { width: 900, height: 700 } };
const POPUP_MARGIN = 12;
const POPUP_GAP = 8;

// 우하단에서 위로 쌓는 배치(순수) — sizes[0] 이 맨 아래
//  위로 더 쌓으면 작업영역 위로 삐져나가는 경우 → 왼쪽에 새 열을 만들어 다시 아래부터 쌓는다
//  (실측: 1040px 작업영역에 480×360 3개 = 1108px → 세 번째가 화면 위로 68px 잘림)
function stackLayout(workArea, sizes) {
  const out = [];
  const floor = workArea.y + workArea.height - POPUP_MARGIN;
  const top = workArea.y + POPUP_MARGIN;
  let bottom = floor;
  let right = workArea.x + workArea.width - POPUP_MARGIN;
  let colWidth = 0;
  for (const s of sizes) {
    if (bottom - s.height < top && bottom !== floor) {          // 이 열이 찼다 → 왼쪽 새 열
      right -= colWidth + POPUP_GAP;
      bottom = floor;
      colWidth = 0;
    }
    const y = Math.max(top, bottom - s.height);
    out.push({ x: right - s.width, y, width: s.width, height: s.height });
    colWidth = Math.max(colWidth, s.width);
    bottom = y - POPUP_GAP;
  }
  return out;
}

function createLinkDownloader(deps) {
  const { BrowserWindow, WebContentsView, screen, ipcMain, session, shell, getSaveDir } = deps;
  const getParent = deps.getParent || (() => null);
  const getWorkArea = deps.getWorkArea || (() => {
    const p = getParent();
    const d = p && !p.isDestroyed() ? screen.getDisplayMatching(p.getBounds()) : screen.getPrimaryDisplay();
    return d.workArea;
  });
  const partition = deps.partition || 'persist:linkdl';
  const timeoutMs = deps.timeoutMs || 15000;
  const inspectDelayMs = deps.inspectDelayMs || 800;
  const inspectTries = deps.inspectTries || 4;
  const autoCloseMs = deps.autoCloseMs || 5000;
  const maxPopups = deps.maxPopups || 3;
  const focusOnManual = deps.focusOnManual !== false;
  const ses = session.fromPartition(partition);
  const popups = [];               // 화면에 떠 있는 job (0 = 맨 아래)
  const queue = [];                // 자리 대기 중인 분류 결과
  const byView = new Map();        // 페이지 webContents.id → job
  const byShell = new Map();       // 띠 webContents.id → job
  const reserved = new Set();      // 진행 중 저장 경로(동시 다운로드 이름 충돌 방지)
  let seq = 0;

  const alive = (job) => job.win && !job.win.isDestroyed();
  function pushState(job, patch) {
    Object.assign(job.st, patch);
    if (alive(job) && job.shellReady) job.win.webContents.send('ldp:state', job.st);
  }
  function layoutView(job) {
    if (!alive(job)) return;
    const [w, h] = job.win.getContentSize();
    job.view.setBounds({ x: 0, y: job.barH, width: w, height: Math.max(0, h - job.barH) });
  }
  function layout() {
    const live = popups.filter(alive);
    const rects = stackLayout(getWorkArea(), live.map(j => POPUP_SIZE[j.large ? 'large' : 'small']));
    live.forEach((j, i) => { j.win.setBounds(rects[i]); layoutView(j); });
  }
  function clearTimers(job) {
    if (job.timer) { clearTimeout(job.timer); job.timer = null; }
    if (job.closePoll) { clearInterval(job.closePoll); job.closePoll = null; }
  }
  // 자동 흐름 종료 → 팝업 유지 + 확대 + 마스터가 직접 처리
  function manual(job, reason) {
    if (job.auto === false || !alive(job)) return;
    job.auto = false;
    clearTimers(job);
    pushState(job, { state: 'manual', reason: `자동 다운로드 불가 — 이 창에서 직접 진행하세요 (${reason})` });
    if (!job.large) { job.large = true; layout(); pushState(job, { large: true }); }
    if (focusOnManual) { job.win.show(); job.win.focus(); }
  }
  function armTimer(job) {
    if (job.timer) clearTimeout(job.timer);
    job.timer = setTimeout(() => { if (!job.started) manual(job, `${Math.round(timeoutMs / 1000)}초 안에 다운로드가 시작되지 않음`); }, timeoutMs);
  }
  // 완료 후 자동 닫힘 — 마우스가 창 위에 있으면 카운트를 처음부터 다시
  function startAutoClose(job) {
    if (!alive(job)) return;
    let left = autoCloseMs;
    const tick = 250;
    if (job.closePoll) clearInterval(job.closePoll);
    job.closePoll = setInterval(() => {
      if (!alive(job)) { clearInterval(job.closePoll); return; }
      const c = screen.getCursorScreenPoint();
      const b = job.win.getBounds();
      const hover = c.x >= b.x && c.x < b.x + b.width && c.y >= b.y && c.y < b.y + b.height;
      left = hover ? autoCloseMs : left - tick;
      const sec = Math.ceil(left / 1000);
      if (sec !== job.st.closeIn) pushState(job, { closeIn: sec, hover });
      if (left <= 0) { clearInterval(job.closePoll); job.closePoll = null; job.win.close(); }
    }, tick);
  }

  ses.on('will-download', (_e, item, wc) => {
    const job = wc ? byView.get(wc.id) : null;
    if (!job || !alive(job)) { item.cancel(); return; }
    const name = sanitizeFileName(item.getFilename());
    if (isExecutableName(name)) {
      item.cancel();
      job.auto = false; clearTimers(job);
      pushState(job, { state: 'blocked', name, reason: `실행형 파일(.${extOf(name)}) — 자동 저장 차단. 받으려면 [브라우저로 열기]` });
      return;
    }
    let dir;
    try { dir = getSaveDir(); fs.mkdirSync(dir, { recursive: true }); }
    catch (e) { item.cancel(); manual(job, '저장 폴더를 만들 수 없음: ' + e.message); return; }
    const savePath = uniqueSavePath(dir, name, (p) => reserved.has(p.toLowerCase()) || fs.existsSync(p));
    const rkey = savePath.toLowerCase();
    reserved.add(rkey);
    item.setSavePath(savePath);
    job.started = true; job.active++; job.items.add(item);
    if (job.timer) { clearTimeout(job.timer); job.timer = null; }
    if (job.closePoll) { clearInterval(job.closePoll); job.closePoll = null; }
    const base = path.basename(savePath);
    // 직링크면 페이지가 한 번도 그려지지 않는다(빈 흰 화면) → 페이지 자리를 접고 띠 아래 안내문으로 대신한다
    const pageless = !wc.getURL();
    if (pageless) job.view.setVisible(false);
    pushState(job, { state: 'progress', name: base, dir, pageless, received: 0, total: item.getTotalBytes(), closeIn: null });
    let lastEmit = 0;
    item.on('updated', () => {
      const now = Date.now();
      if (now - lastEmit < 250) return;
      lastEmit = now;
      pushState(job, { state: 'progress', name: base, received: item.getReceivedBytes(), total: item.getTotalBytes() });
    });
    item.once('done', (_ev, state) => {
      reserved.delete(rkey);
      job.items.delete(item);
      job.active--;
      if (state === 'completed') {
        job.files.push(savePath);
        job.auto = false;
        if (job.active === 0) {
          pushState(job, { state: 'done', name: base, file: savePath, count: job.files.length, size: item.getReceivedBytes() });
          startAutoClose(job);
        }
      } else {
        try { if (fs.existsSync(savePath)) fs.unlinkSync(savePath); } catch { /* noop */ }
        job.auto = true;                            // manual() 이 한 번은 동작하도록
        manual(job, `다운로드 중단(${state})`);
      }
    });
  });

  function scheduleInspect(job) {
    if (!job.auto || job.started || job.inspecting) return;
    job.inspecting = true;
    setTimeout(async () => {
      job.inspecting = false;
      if (!job.auto || job.started || !alive(job)) return;
      let snap = null;
      try { snap = await job.view.webContents.executeJavaScript(INSPECT_JS, true); } catch { snap = null; }
      if (!job.auto || job.started) return;
      const act = job.clicked ? afterClickAction(snap) : pickLandingAction(snap);
      if (act.kind === 'fallback') { manual(job, act.reason); return; }
      if (act.kind === 'click') {
        job.clicked = true;
        pushState(job, { state: 'loading', reason: `'${act.label}' 자동 클릭` });
        armTimer(job);                              // 클릭 뒤 응답 대기 시간을 새로 준다
        try { await job.view.webContents.executeJavaScript(clickJs(act.i), true); } catch { /* 이동 중 끊김은 정상 */ }
        return;
      }
      if (job.clicked) return;                      // 클릭 뒤에는 타이머가 판정한다
      if (++job.tries >= inspectTries) { manual(job, '다운로드 버튼을 찾지 못함'); return; }
      scheduleInspect(job);
    }, inspectDelayMs);
  }

  function openPopup(c, key) {
    let domain = '';
    try { domain = new URL(c.target || c.url).hostname; } catch { /* noop */ }
    const parent = getParent();
    const win = new BrowserWindow({
      ...POPUP_SIZE.small, show: false, frame: false, resizable: true, minimizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true, backgroundColor: '#ffffff', title: domain,
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      webPreferences: { preload: deps.popupPreload, contextIsolation: true, sandbox: true, nodeIntegration: false }
    });
    const view = new WebContentsView({
      webPreferences: { partition, nodeIntegration: false, contextIsolation: true, sandbox: true,
        disableDialogs: true, webviewTag: false, spellcheck: false }
    });
    win.contentView.addChildView(view);
    const job = { key, url: c.url, win, view, barH: 64, large: false, auto: c.action === 'download',
      started: false, clicked: false, inspecting: false, tries: 0, active: 0, items: new Set(), files: [],
      timer: null, closePoll: null, shellReady: false,
      st: { key, domain, url: c.url, state: c.action === 'blocked' ? 'blocked' : 'loading', large: false,
        reason: c.action === 'blocked' ? c.reason + '. 받으려면 [브라우저로 열기]' : c.reason } };
    const vwc = view.webContents;
    byView.set(vwc.id, job);
    byShell.set(win.webContents.id, job);
    popups.push(job);
    // 팝업 안의 새 창 요청은 같은 팝업에서 연다(임의 새 창 금지)
    vwc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) vwc.loadURL(url).catch(() => {});
      return { action: 'deny' };
    });
    vwc.on('will-navigate', (e, url) => { if (!/^https?:/i.test(url)) e.preventDefault(); });
    vwc.on('did-fail-load', (_e, code, desc, _u, isMainFrame) => {
      if (!isMainFrame || code === -3) return;     // -3(ERR_ABORTED) = 다운로드로 전환된 정상 흐름
      if (!job.started) manual(job, `페이지를 열 수 없음(${desc || code})`);
    });
    vwc.on('did-finish-load', () => scheduleInspect(job));
    vwc.on('render-process-gone', () => { if (!job.started) manual(job, '페이지 프로세스 종료'); });
    win.on('resize', () => layoutView(job));
    win.on('closed', () => {
      clearTimers(job);
      for (const it of job.items) { try { it.cancel(); } catch { /* noop */ } }   // 닫으면 진행 중 다운로드도 취소
      byView.delete(vwc.id);
      for (const [k, v] of byShell) if (v === job) byShell.delete(k);
      const i = popups.indexOf(job);
      if (i >= 0) popups.splice(i, 1);
      try { if (!vwc.isDestroyed()) vwc.close(); } catch { /* noop */ }
      layout();
      if (queue.length) { const q = queue.shift(); openPopup(q.c, q.key); }
    });
    win.once('ready-to-show', () => { if (alive(job)) win.showInactive(); });
    win.loadFile(deps.popupHtml);
    layout();
    if (c.action === 'download') { armTimer(job); vwc.loadURL(c.url).catch(() => {}); }
    else view.setVisible(false);                    // 차단: 페이지를 열지 않는다
    return job;
  }

  // 띠(로컬 페이지) ↔ main
  ipcMain.on('ldp:ready', (e, barH) => {
    const job = byShell.get(e.sender.id);
    if (!job) return;
    job.shellReady = true;
    const h = Number(barH);
    if (h >= 24 && h <= 200) job.barH = Math.round(h);
    layoutView(job);
    pushState(job, {});
  });
  ipcMain.on('ldp:act', (e, act) => {
    const job = byShell.get(e.sender.id);
    if (!job || !alive(job)) return;
    const file = job.st.file;
    if (act === 'open' && file) shell.openPath(file);
    else if (act === 'folder' && file) shell.showItemInFolder(file);
    else if (act === 'browser') shell.openExternal(job.url).catch(() => {});
    else if (act === 'enlarge') { job.large = !job.large; layout(); pushState(job, { large: job.large }); }
    else if (act === 'close') job.win.close();
  });

  function open(raw) {
    const c = classifyLink(raw);
    if (c.action === 'ignore') return { ok: false, action: 'ignore', reason: c.reason };
    if (c.action === 'external') { shell.openExternal(c.url).catch(() => {}); return { ok: true, action: 'external' }; }
    for (const j of popups) {
      if (j.url === c.url && alive(j)) { j.win.showInactive(); return { ok: true, action: 'busy', key: j.key }; }
    }
    const key = 'ld' + (++seq);
    if (popups.length >= maxPopups) { queue.push({ c, key }); return { ok: true, action: 'queued', key }; }
    openPopup(c, key);
    return { ok: true, action: c.action, key };
  }

  return { open, session: ses, popups, queue };
}

module.exports = {
  DOWNLOAD_PATTERNS, FILE_EXTS, EXEC_EXTS, POPUP_SIZE,
  extOf, isExecutableName, unwrapUrl, classifyLink, stackLayout,
  sanitizeFileName, uniqueSavePath, pickLandingAction, afterClickAction,
  createLinkDownloader
};

// ---- 셀프체크 (node src/link-download.js) ----
if (require.main === module) {
  let fail = 0, n = 0;
  const eq = (name, got, want) => { n++; if (got !== want) { fail++; console.log(`FAIL ${name}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); } };
  const act = (u) => classifyLink(u).action;
  // 도메인 패턴
  eq('mailplug', act('https://filefree.mailplug.com/download/f453345be7d9cf9b135d/'), 'download');
  eq('mailplug2', act('https://filefree2.mailplug.com/download/abc/HTML5/fname/a.dwg'), 'download');
  eq('naver', act('https://bigfile.mail.naver.com/download?fid=abc'), 'download');
  eq('daum', act('https://attach.mail.daum.net/bigfile/v1/urls/d/xyz'), 'download');
  eq('hanwha', act('http://ep.circle.hanwha.com/neo/bigmail/services/mail/downloadMassMailZip.mvc?mailId=1'), 'download');
  eq('kte', act('https://webmail.kte.co.kr/mail/mail_attach_down.jsp?x=1'), 'download');
  eq('officeplugin', act('https://attachment.totlelab.com/outlook/downloadFile2?id=1'), 'download');
  eq('mybox 제외', act('https://mybox.naver.com/saveFile?x=1'), 'external');
  eq('일반 링크', act('https://www.seastar.co.kr/notice'), 'external');
  eq('호스트 유사 위장', act('https://filefree.mailplug.com.evil.io/download/x'), 'external');
  // 확장자
  eq('pdf', act('https://example.com/files/spec%20rev1.PDF'), 'download');
  eq('dwg 쿼리', act('https://example.com/a/b.dwg?token=1'), 'download');
  eq('html', act('https://example.com/a/b.html'), 'external');
  // 실행형 차단
  eq('exe', act('https://example.com/setup.exe'), 'blocked');
  eq('msi', act('https://filefree.mailplug.com/download/x/fname/tool.msi'), 'blocked');
  eq('isExec bat', isExecutableName('run.BAT'), true);
  eq('isExec 공백꼬리', isExecutableName('evil.exe. '), true);
  eq('isExec pdf', isExecutableName('a.pdf'), false);
  // 스킴
  eq('mailto', act('mailto:a@b.com'), 'external');
  eq('file 스킴', act('file:///C:/Windows/notepad.exe'), 'ignore');
  eq('javascript 스킴', act('javascript:alert(1)'), 'ignore');
  eq('깨진 URL', act('not a url'), 'ignore');
  // proofpoint v2
  const pp = 'https://urldefense.proofpoint.com/v2/url?u=https-3A__filefree.mailplug.com_download_abc123_&d=DwMF&c=x';
  eq('pp 해제', unwrapUrl(pp), 'https://filefree.mailplug.com/download/abc123/');
  eq('pp 판정', act(pp), 'download');
  eq('pp 원본 유지', classifyLink(pp).url, pp);
  eq('pp exe', act('https://urldefense.proofpoint.com/v2/url?u=https-3A__x.com_a.exe&d=1'), 'blocked');
  eq('pp 일반', act('https://urldefense.proofpoint.com/v2/url?u=https-3A__www.google.com_&d=1'), 'external');
  eq('pp 안쪽 file 스킴', act('https://urldefense.proofpoint.com/v2/url?u=file-3A____c_x&d=1'), 'ignore');
  // 파일명·경로
  eq('sanitize', sanitizeFileName('a:b*c?.pdf'), 'a_b_c_.pdf');
  eq('sanitize 예약어', sanitizeFileName('CON.txt'), '_CON.txt');
  eq('sanitize 빈값', sanitizeFileName(''), 'download');
  const taken = new Set([path.join('D', 'a.pdf'), path.join('D', 'a (1).pdf')]);
  eq('unique', uniqueSavePath('D', 'a.pdf', (p) => taken.has(p)), path.join('D', 'a (2).pdf'));
  // 랜딩 판정
  const L = (labels, extra = {}) => ({ candidates: labels.map((label, i) => ({ i, label, href: '' })), ...extra });
  eq('단일 버튼', pickLandingAction(L(['홈', '다운로드'])).i, 1);
  eq('여러 파일 폴백', pickLandingAction(L(['a.pdf 다운로드', 'b.pdf 다운로드'])).kind, 'fallback');
  eq('전체 버튼', pickLandingAction(L(['a 다운로드', 'b 다운로드', '전체 다운로드'])).i, 2);
  eq('로그인 폴백', pickLandingAction(L(['다운로드'], { hasPassword: true })).kind, 'fallback');
  eq('캡차 폴백', pickLandingAction(L(['다운로드'], { hasCaptcha: true })).kind, 'fallback');
  eq('앱 설치 버튼 제외', pickLandingAction(L(['PC 앱 다운로드'])).kind, 'wait');
  eq('만료 alert', pickLandingAction(L([], { alertMsg: '기간 만료' })).kind, 'fallback');
  eq('같은 href 중복', pickLandingAction({ candidates: [{ i: 0, label: 'a.pdf 다운로드', href: 'https://x/a' }, { i: 1, label: '다운로드', href: 'https://x/a' }] }).i, 0);
  eq('클릭 후 로그인', afterClickAction({ hasPassword: true }).kind, 'fallback');
  // 팝업 배치: 우하단에서 위로 쌓기
  const wa = { x: 0, y: 0, width: 1920, height: 1040 };
  const S = POPUP_SIZE.small, Lg = POPUP_SIZE.large;
  const st = stackLayout(wa, [S, S, S]);
  eq('팝업1 x', st[0].x, 1920 - 12 - 480); eq('팝업1 y', st[0].y, 1040 - 12 - 360);
  eq('팝업2 위로', st[1].y, st[0].y - 8 - 360); eq('팝업2 같은 열', st[1].x, st[0].x);
  eq('팝업3 넘침 → 왼쪽 새 열', st[2].x, st[0].x - 8 - 480); eq('팝업3 아래부터', st[2].y, st[0].y);
  eq('전부 작업영역 안', stackLayout(wa, [S, Lg, S, S]).every(r => r.y >= 0 && r.x >= 0 && r.y + r.height <= 1040), true);
  const tall = stackLayout({ x: 0, y: 0, width: 1920, height: 600 }, [Lg]);
  eq('작업영역보다 큰 창은 위에 붙임', tall[0].y, 12);
  if (fail) { console.log(`link-download 셀프체크 FAIL ${fail}/${n}`); process.exit(1); }
  console.log(`link-download 셀프체크 ${n}/${n} 통과`);
}
