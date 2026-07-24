// ============================================================
//  renderer.js - UI 로직 (window.api 를 통해 메인 프로세스와 통신)
//  Outlook 스타일 3단 레이아웃 버전
// ============================================================

// ---------- 상태 ----------
let config = {
  apiKeys: ['', '', '', '', ''], model: 'llama-3.3-70b', maxMails: 2000,
  source: 'outlook', pstPath: '',
  dateFilter: { mode: '6months', start: '', end: '' },
  realtime: true, realtimeIntervalSec: 60, saveAttachmentsOnSync: true
};
let pendingFiles = [];          // 첨부 대기 파일 경로 (최대 5)
let chatHistory = [];           // {role, content} - AI 대화 맥락
let mailCache = [];             // 최근 검색된 메일 목록
let briefMode = 'week';         // 브리핑 기간
let currentFolder = 'all';      // 현재 폴더 필터
let selectedMail = null;        // 읽기창에 표시 중인 메일

// ---------- DOM ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

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
    // 폴더 필터
    $$('.fld-item').forEach(x => x.classList.remove('active'));
    btn.classList.add('active');
    currentFolder = btn.dataset.folder;
    $('#mlp-title').textContent = btn.textContent.replace(/\d+$/, '').trim();
    switchView('mail');
    loadMails($('#global-search').value);
  }));

  // ----- 메뉴 탭 (홈/파일 등 시각적 활성화만) -----
  $$('.menu-tab').forEach(tab => tab.addEventListener('click', () => {
    $$('.menu-tab').forEach(x => x.classList.remove('active'));
    tab.classList.add('active');
  }));

  // ----- 리본 버튼 -----
  $('#rb-new').addEventListener('click', () => { switchView('chat'); $('#chat-input').focus(); });
  $('#rb-sync').addEventListener('click', runSync);
  $('#rb-checknew').addEventListener('click', checkNewMails);
  $('#rb-brief').addEventListener('click', () => { switchView('dashboard'); });
  $('#rb-reply').addEventListener('click', () => { if (selectedMail) rpDraftReply(); });
  $('#rb-translate').addEventListener('click', () => { if (selectedMail) rpTranslate(); });

  // ----- 리본 소스 토글 (Outlook / PST) -----
  $('#rb-src-outlook').addEventListener('click', () => setSource('outlook'));
  $('#rb-src-pst').addEventListener('click', () => setSourcePst());

  // ----- 전역 검색 -----
  $('#global-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { switchView('mail'); loadMails($('#global-search').value); }
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

  // ----- 설정 -----
  $('#btn-save-settings').addEventListener('click', saveSettings);
  $('#btn-check-update').addEventListener('click', checkUpdate);
  $('#toggle-keys').addEventListener('change', (e) => {
    $$('.api-key').forEach(inp => inp.type = e.target.checked ? 'text' : 'password');
  });
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

  // ----- 주소록 -----
  $('#btn-contact-import').addEventListener('click', importContacts);
  $('#btn-contact-search').addEventListener('click', () => loadContacts($('#contact-search').value));
  $('#contact-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadContacts($('#contact-search').value); });

  // ----- 관리자 진단 -----
  $('#btn-admin-refresh').addEventListener('click', refreshAdminInfo);
  $('#btn-admin-testconn').addEventListener('click', refreshConnectionStatus);
  $('#btn-admin-openattach').addEventListener('click', async () => {
    const s = await window.api.dbStatus();
    if (s && s.path) {
      // DB와 같은 userData 하위의 attachments 폴더 열기
      const attachDir = s.path.replace(/[\\/][^\\/]+$/, '') + '/attachments';
      const r = await window.api.openPath(attachDir);
      if (r && !r.ok) alert('첨부 폴더를 열 수 없습니다: ' + (r.error || '경로 없음'));
    } else alert('DB 경로를 확인할 수 없습니다.');
  });

  // ----- 이벤트 수신 -----
  window.api.onUpdateStatus(handleUpdateStatus);
  window.api.onNewMails(handleNewMails);
  window.api.onRealtimeError((err) => console.warn('실시간 확인 오류:', err));
  window.api.onSyncProgress(handleSyncProgress);

  refreshConnectionStatus();
  refreshDbStatus();
  refreshAdminInfo();
  loadStats();
  loadMails('');   // 시작 시 메일 뷰 자동 로드
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
      alert(`동기화 완료!\n\n• 메일 ${res.fetched}건 저장/색인\n• 첨부 ${res.attachSaved || 0}개 로컬 저장${res.attachFail ? ' ('+res.attachFail+'개 실패)' : ''}`);
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
      box.innerHTML = `<div class="empty">${escapeHtml(res.error)}</div>`;
    }
  } catch (err) {
    hideLoading();
    box.innerHTML = `<div class="empty">${escapeHtml(String(err))}</div>`;
  }
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

async function loadContacts(query) {
  const list = $('#contact-list');
  list.innerHTML = '<div class="empty">불러오는 중...</div>';
  try {
    const res = await window.api.contactsList(query || '', 500);
    if (!res.ok) { list.innerHTML = `<div class="empty">${escapeHtml(res.error)}</div>`; return; }
    const contacts = res.contacts || [];
    if (!contacts.length) { list.innerHTML = '<div class="empty">👥 주소록이 비어 있습니다.</div>'; return; }
    list.innerHTML = '';
    contacts.forEach(c => {
      const item = document.createElement('div');
      item.className = 'contact-item';
      const av = initials(c.name || c.email);
      item.innerHTML = `
        <div class="contact-avatar" style="background:${avatarColor(c.name||c.email)}">${escapeHtml(av)}</div>
        <div class="contact-info">
          <div class="contact-name">${escapeHtml(c.name || '(이름 없음)')}</div>
          <div class="contact-email">${escapeHtml(c.email)}${c.company ? ' · ' + escapeHtml(c.company) : ''}</div>
        </div>
        <button class="contact-search-btn" title="이 사람 메일 검색">📬</button>`;
      item.querySelector('.contact-search-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        switchView('mail'); $('#global-search').value = c.email; loadMails(c.email);
      });
      list.appendChild(item);
    });
  } catch (err) { list.innerHTML = `<div class="empty">${escapeHtml(String(err))}</div>`; }
}

// ============================================================
//  뷰 전환
// ============================================================
let contactsLoadedOnce = false;
function switchView(view) {
  // 폴더 트리의 nav 항목 활성화 (메일 뷰는 폴더 항목이 담당)
  $$('.fld-item[data-nav]').forEach(b => b.classList.toggle('active', b.dataset.nav === view));
  if (view !== 'mail') $$('.fld-item[data-folder]').forEach(b => b.classList.remove('active'));
  $$('.view').forEach(v => v.classList.remove('active'));
  const el = $('#view-' + view);
  if (el) el.classList.add('active');

  if (view === 'dashboard') loadStats();
  if (view === 'contacts' && !contactsLoadedOnce) { contactsLoadedOnce = true; loadContacts(''); }
}

// ============================================================
//  설정 UI 반영/저장
// ============================================================
function applyConfigToUI() {
  const keys = config.apiKeys || [];
  $$('.api-key').forEach(inp => { inp.value = keys[parseInt(inp.dataset.idx, 10)] || ''; });
  $('#model-select').value = config.model || 'llama-3.3-70b';
  $('#max-mails').value = config.maxMails || 2000;
  if ($('#save-attach-toggle')) $('#save-attach-toggle').checked = config.saveAttachmentsOnSync !== false;

  const df = config.dateFilter || { mode: '6months' };
  const dmRadio = document.querySelector(`input[name="dateMode"][value="${df.mode}"]`);
  if (dmRadio) dmRadio.checked = true;
  $('#date-start').value = df.start || '';
  $('#date-end').value = df.end || '';
  $('#range-row').classList.toggle('hidden', df.mode !== 'range');

  $('#realtime-toggle').checked = config.realtime !== false;
  $('#realtime-interval').value = config.realtimeIntervalSec || 60;

  syncSourceUI();
  updateRealtimeDot();
}

async function saveSettings() {
  const apiKeys = [];
  $$('.api-key').forEach(inp => { apiKeys[parseInt(inp.dataset.idx, 10)] = inp.value.trim(); });
  const source = document.querySelector('input[name="source"]:checked').value;
  const dateMode = document.querySelector('input[name="dateMode"]:checked').value;
  if (source === 'pst' && !$('#pst-path').value.trim()) { alert('PST 파일 경로를 선택해주세요. (찾기 버튼)'); return; }

  const newConfig = {
    apiKeys, model: $('#model-select').value,
    maxMails: parseInt($('#max-mails').value, 10) || 2000,
    source, pstPath: $('#pst-path').value.trim(),
    dateFilter: { mode: dateMode, start: $('#date-start').value || '', end: $('#date-end').value || '' },
    realtime: $('#realtime-toggle').checked,
    realtimeIntervalSec: parseInt($('#realtime-interval').value, 10) || 60,
    saveAttachmentsOnSync: $('#save-attach-toggle') ? $('#save-attach-toggle').checked : true
  };
  config = await window.api.setConfig(newConfig);
  updateKeyStatus(); updateRealtimeDot(); refreshConnectionStatus(); syncSourceUI();
  const saved = $('#settings-saved');
  saved.classList.remove('hidden');
  setTimeout(() => saved.classList.add('hidden'), 2000);
}

function updateRealtimeDot() {
  const on = config.realtime !== false && (config.source || 'outlook') === 'outlook';
  $('#realtime-dot').classList.toggle('hidden', !on);
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
  const count = (config.apiKeys || []).filter(k => k && k.trim()).length;
  const el = $('#key-status');
  if (count > 0) { el.textContent = `API 키: ${count}개 활성`; el.className = 'key-status ok'; }
  else { el.textContent = 'API 키 없음 - 설정 필요'; el.className = 'key-status bad'; }
}
function needKey() {
  if ((config.apiKeys || []).filter(k => k && k.trim()).length === 0) {
    alert('API 키가 필요합니다. 설정에서 입력하세요.');
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
      } else addMessage('assistant', `오류: ${escapeHtml(res.error)}`);
      return;
    }

    setTyping(typingEl, '메일 검색 중...');
    const res = await window.api.aiChatMails(text, chatHistory.slice(-6));
    removeTyping(typingEl);
    if (res.ok) {
      chatHistory.push({ role: 'user', content: text });
      chatHistory.push({ role: 'assistant', content: res.content });
      const info = res.contextCount ? { keyIndex: res.usedKeyIndex, ctx: res.contextCount } : { keyIndex: res.usedKeyIndex };
      addMessage('assistant', formatAnswer(res.content), info);
    } else addMessage('assistant', `오류가 발생했습니다:\n${escapeHtml(res.error)}`);
  } catch (err) {
    removeTyping(typingEl);
    addMessage('assistant', `처리 중 오류: ${escapeHtml(String(err))}`);
  }
}

// ============================================================
//  메일 목록
// ============================================================
async function loadMails(query) {
  const list = $('#mail-list');
  list.innerHTML = '<div class="empty">불러오는 중...</div>';
  try {
    let hasAttach = ($('#filter-attach') && $('#filter-attach').checked) ? true : null;
    let folder = null;
    if (currentFolder === '__attach') hasAttach = true;
    else if (currentFolder === 'Inbox' || currentFolder === 'Sent') folder = currentFolder;

    const res = await window.api.dbSearchMails({ query: (query || '').trim(), limit: 300, hasAttach, folder });
    if (!res.ok) { list.innerHTML = `<div class="empty">${escapeHtml(res.error)}</div>`; return; }
    mailCache = res.mails;
    renderMailList(mailCache);
  } catch (err) {
    list.innerHTML = `<div class="empty">${escapeHtml(String(err))}</div>`;
  }
}

function renderMailList(mails) {
  const list = $('#mail-list');
  if (!mails || mails.length === 0) {
    list.innerHTML = '<div class="empty">저장된 메일이 없습니다.<br>상단 <b>동기화</b>를 먼저 실행하세요.</div>';
    return;
  }
  list.innerHTML = '';
  let lastGroup = null;
  mails.forEach(m => {
    const subject = m.subject || '(제목 없음)';
    const sender = (m.sender_name !== undefined ? m.sender_name : m.sender) || '(발신자)';
    const received = (m.received_at !== undefined ? m.received_at : m.received) || '';
    const hasAttach = m.has_attach !== undefined ? m.has_attach : m.hasAttach;
    const attachCount = m.attach_count !== undefined ? m.attach_count : m.attachCount;
    const unread = m.unread;
    const preview = (m.preview || '').replace(/\s+/g, ' ');
    const lang = m.lang || '';
    const langTag = lang === 'en' ? 'EN' : (lang === 'zh' ? 'ZH' : (lang === 'ja' ? 'JA' : ''));

    // 날짜 그룹 헤더 (오늘/어제/이번 주/지난 주/이전)
    const group = dateGroup(received);
    if (group !== lastGroup) {
      lastGroup = group;
      const gh = document.createElement('div');
      gh.className = 'date-group';
      gh.textContent = group;
      list.appendChild(gh);
    }

    const item = document.createElement('div');
    item.className = 'mail-item';
    item.innerHTML = `
      ${unread ? '<span class="mi-unread-bar"></span>' : ''}
      <div class="mi-row1">
        <span class="mi-sender">${escapeHtml(sender)}</span>
        <span class="mi-date">${escapeHtml(shortDate(received))}</span>
      </div>
      <div class="mi-subject ${unread ? 'unread' : ''}">${escapeHtml(subject)}</div>
      <div class="mi-preview">${escapeHtml(preview)}${(langTag || hasAttach) ? `<span class="mi-tags">${langTag ? `<span class="lang-tag">${langTag}</span>` : ''}${hasAttach ? `<span class="attach-tag">첨부${attachCount ? ' ' + attachCount : ''}</span>` : ''}</span>` : ''}</div>`;
    item.addEventListener('click', () => {
      $$('.mail-item').forEach(x => x.classList.remove('selected'));
      item.classList.add('selected');
      openMailDetail(m);
    });
    list.appendChild(item);
  });
}

// 날짜를 오늘/어제/이번 주/지난 주/이전 그룹으로 분류
function dateGroup(s) {
  if (!s) return '이전';
  const m = String(s).match(/(\d{4})[-/](\d{2})[-/](\d{2})/);
  if (!m) return '이전';
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.floor((today - d) / 86400000);
  if (diffDays <= 0) return '오늘';
  if (diffDays === 1) return '어제';
  if (diffDays < 7) return '이번 주';
  if (diffDays < 14) return '지난 주';
  return '이전';
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
    renderReadingPane(res.mail, res.attachments, res.analyses);
  } catch (err) { hideLoading(); alert('오류: ' + String(err)); }
}

function renderReadingPane(mail, atts, analyses) {
  $('#rp-empty').classList.add('hidden');
  const rp = $('#rp-content');
  rp.classList.remove('hidden');
  const langNames = { ko: '한국어', en: '영어', zh: '중국어', ja: '일본어', unknown: '기타' };

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
    <div class="rp-meta">${escapeHtml(mail.received_at || '')} · ${langNames[mail.lang] || mail.lang} · ${escapeHtml(mail.folder || '')}</div>`;

  if (atts && atts.length) {
    html += `<div class="rp-atts"><b>첨부파일 (${atts.length})</b><ul>` +
      atts.map(a => `<li>${escapeHtml(a.file_name)} <span style="color:var(--muted)">(${a.size_kb}KB)</span> ${a.saved_path ? `<button class="link-btn" data-open="${escapeHtml(a.saved_path)}">열기</button> <button class="link-btn" data-folder="${escapeHtml(a.saved_path)}">폴더</button>` : ''}</li>`).join('') +
      `</ul></div>`;
  }

  html += `<div class="rp-actions">
    <button class="btn-primary" id="rp-translate-btn">번역/분석</button>
    <button class="btn-primary" id="rp-reply-btn">답장 초안</button>
    <button id="rp-ask-btn">이 메일로 질문</button>
  </div>`;

  html += `<div class="rp-body">${escapeHtml((mail.body || '').slice(0, 12000))}</div>`;
  html += `<div id="rp-ai-result" class="rp-ai-result"></div>`;

  rp.innerHTML = html;
  rp.scrollTop = 0;

  rp.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => window.api.openPath(b.dataset.open)));
  rp.querySelectorAll('[data-folder]').forEach(b => b.addEventListener('click', () => window.api.showItem(b.dataset.folder)));
  $('#rp-translate-btn').addEventListener('click', rpTranslate);
  $('#rp-reply-btn').addEventListener('click', rpDraftReply);
  $('#rp-ask-btn').addEventListener('click', () => {
    switchView('chat');
    chatHistory.push({ role: 'user', content: `[참고 메일]\n제목:${mail.subject}\n발신:${mail.sender_name}\n본문:${(mail.body||'').slice(0,4000)}` });
    addMessage('assistant', `"<b>${escapeHtml(mail.subject)}</b>" 메일을 맥락에 추가했습니다. 질문해보세요.`);
  });

  if (analyses && analyses.length) {
    const box = $('#rp-ai-result');
    const kindName = { translate: '번역/분석', reply: '답장초안', summary: '요약' };
    box.innerHTML = `<div class="prev-analyses"><b>이전 분석 기록</b>` +
      analyses.slice(0, 3).map(a => `<details><summary>${kindName[a.kind] || a.kind} (${a.created_at})</summary><div class="briefing-body">${formatAnswer(a.content)}</div></details>`).join('') +
      `</div>`;
  }
}

async function rpTranslate() {
  if (!selectedMail || needKey()) return;
  const box = $('#rp-ai-result');
  box.innerHTML = '<div class="empty">번역/분석 중...</div>';
  const res = await window.api.aiTranslate(selectedMail.id);
  box.innerHTML = res.ok ? `<div class="briefing-body">${formatAnswer(res.content)}</div>` : `<div class="empty">${escapeHtml(res.error)}</div>`;
}

async function rpDraftReply() {
  if (!selectedMail || needKey()) return;
  const instruction = (window.prompt ? (prompt('답장에 반영할 지시사항이 있으면 입력하세요 (없으면 비워두기):', '') || '') : '');
  const box = $('#rp-ai-result');
  box.innerHTML = '<div class="empty">답장 초안 작성 중...</div>';
  const res = await window.api.aiDraftReply(selectedMail.id, instruction, 'formal', 'auto');
  if (res.ok) {
    box.innerHTML = `<div class="reply-draft"><div class="reply-head">답장 초안 <button class="link-btn" id="copy-reply">복사</button></div><pre>${escapeHtml(res.content)}</pre></div>`;
    $('#copy-reply').addEventListener('click', () => { navigator.clipboard.writeText(res.content); $('#copy-reply').textContent = '복사됨'; });
  } else box.innerHTML = `<div class="empty">${escapeHtml(res.error)}</div>`;
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
//  업데이트
// ============================================================
async function checkUpdate() {
  showLoading('업데이트 확인 중...');
  const res = await window.api.checkUpdate();
  hideLoading();
  if (!res.ok) alert('업데이트 확인 실패: ' + res.error);
}
function handleUpdateStatus({ status, info }) {
  const badge = $('#update-badge');
  const map = {
    checking: ['info', '업데이트 확인 중...'],
    available: ['info', '새 버전 다운로드 중...'],
    downloading: ['info', `다운로드 ${info && info.percent ? Math.round(info.percent) + '%' : '...'}`],
    downloaded: ['ready', '업데이트 준비 완료 (재시작 시 적용)'],
    none: ['', ''],
    error: ['info', '업데이트 확인 실패']
  };
  const [cls, txt] = map[status] || ['', ''];
  if (!txt) { badge.classList.add('hidden'); return; }
  badge.className = 'update-badge ' + cls;
  badge.textContent = txt;
  badge.classList.remove('hidden');
}

// ============================================================
//  유틸
// ============================================================
function showLoading(text) { $('#loading-text').textContent = text || '처리 중...'; $('#loading').classList.remove('hidden'); }
function hideLoading() { $('#loading').classList.add('hidden'); }
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
