// ============================================================
//  renderer.js - UI 로직 (window.api 를 통해 메인 프로세스와 통신)
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

// ---------- DOM ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ============================================================
//  초기화
// ============================================================
window.addEventListener('DOMContentLoaded', async () => {
  // 버전 표시
  try { $('#app-version').textContent = 'v' + (await window.api.getVersion()); } catch {}

  // 설정 로드
  config = await window.api.getConfig();
  applyConfigToUI();
  updateKeyStatus();

  // 네비게이션
  $$('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  // 채팅
  $('#btn-send').addEventListener('click', sendChat);
  $('#chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  $('#chat-input').addEventListener('input', autoGrow);
  $('#btn-attach').addEventListener('click', pickFiles);

  // 메일 목록
  $('#btn-mail-refresh').addEventListener('click', () => loadMails(''));
  $('#btn-mail-search').addEventListener('click', () => loadMails($('#mail-search').value));
  $('#mail-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadMails($('#mail-search').value);
  });

  // 설정
  $('#btn-save-settings').addEventListener('click', saveSettings);
  $('#btn-check-update').addEventListener('click', checkUpdate);
  $('#toggle-keys').addEventListener('change', (e) => {
    $$('.api-key').forEach(inp => inp.type = e.target.checked ? 'text' : 'password');
  });

  // 소스(Outlook/PST) 선택 → PST 경로 입력 표시 토글
  $$('input[name="source"]').forEach(r => r.addEventListener('change', () => {
    const val = document.querySelector('input[name="source"]:checked').value;
    $('#pst-row').classList.toggle('hidden', val !== 'pst');
  }));
  $('#btn-pick-pst').addEventListener('click', async () => {
    const p = await window.api.pickPst();
    if (p) $('#pst-path').value = p;
  });

  // 기간 지정 선택 → 날짜 입력 표시 토글
  $$('input[name="dateMode"]').forEach(r => r.addEventListener('change', () => {
    const val = document.querySelector('input[name="dateMode"]:checked').value;
    $('#range-row').classList.toggle('hidden', val !== 'range');
  }));

  // 새 메일 수동 확인
  $('#btn-check-new').addEventListener('click', checkNewMails);
  $('#filter-attach').addEventListener('change', () => loadMails($('#mail-search').value));

  // === 동기화 ===
  $('#btn-sync').addEventListener('click', runSync);

  // === 대시보드 / 브리핑 ===
  $$('.brief-btn').forEach(b => b.addEventListener('click', () => {
    $$('.brief-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    briefMode = b.dataset.mode;
  }));
  $('#btn-briefing').addEventListener('click', generateBriefing);

  // === 주소록 ===
  $('#btn-contact-import').addEventListener('click', importContacts);
  $('#btn-contact-search').addEventListener('click', () => loadContacts($('#contact-search').value));
  $('#contact-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadContacts($('#contact-search').value); });

  // === 메일 상세 모달 ===
  $('#modal-close').addEventListener('click', () => $('#mail-modal').classList.add('hidden'));
  $('#mail-modal').addEventListener('click', (e) => { if (e.target.id === 'mail-modal') $('#mail-modal').classList.add('hidden'); });

  // 이벤트 수신
  window.api.onUpdateStatus(handleUpdateStatus);
  window.api.onNewMails(handleNewMails);
  window.api.onRealtimeError((err) => console.warn('실시간 확인 오류:', err));
  window.api.onSyncProgress(handleSyncProgress);

  // 연결 상태 확인 + DB 상태 + 통계
  refreshConnectionStatus();
  refreshDbStatus();
  loadStats();
});

// ============================================================
//  DB 상태 / 통계
// ============================================================
async function refreshDbStatus() {
  try {
    const s = await window.api.dbStatus();
    const el = $('#sync-info');
    if (!s.ready) {
      el.textContent = '⚠️ DB 초기화 실패 (재빌드 필요)';
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

    // 발신자 상위
    const senders = $('#top-senders');
    senders.innerHTML = (s.topSenders || []).map(t =>
      `<div class="sender-row"><span>${escapeHtml(t.sender_name || t.sender_email)}</span><span class="badge">${t.c}</span></div>`
    ).join('') || '<div class="empty-sm">데이터 없음</div>';

    // 언어 분포
    const langNames = { ko: '한국어', en: '영어', zh: '중국어', ja: '일본어', unknown: '기타' };
    const dist = $('#lang-dist');
    dist.innerHTML = (s.byLang || []).map(l =>
      `<div class="sender-row"><span>${langNames[l.lang] || l.lang}</span><span class="badge">${l.c}</span></div>`
    ).join('') || '<div class="empty-sm">데이터 없음</div>';

    // 동기화 시각
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
  if ((config.apiKeys || []).length >= 0) { /* 동기화는 키 불필요 */ }
  const btn = $('#btn-sync');
  btn.disabled = true;
  showLoading('🔄 메일 동기화 시작...');
  try {
    const res = await window.api.syncRun();
    hideLoading();
    if (res.ok) {
      $('#sync-info').textContent = `✅ ${res.fetched}건 동기화 (첨부 ${res.attachSaved || 0}개 저장)`;
      loadStats();
      alert(`동기화 완료!\n\n• 메일 ${res.fetched}건 저장/색인\n• 첨부 ${res.attachSaved || 0}개 로컬 저장${res.attachFail ? ' ('+res.attachFail+'개 실패)' : ''}`);
    } else {
      alert('동기화 실패: ' + res.error);
      $('#sync-info').textContent = '⚠️ 동기화 실패';
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
  if ((config.apiKeys || []).filter(k => k && k.trim()).length === 0) {
    alert('API 키가 필요합니다. ⚙️ 설정에서 입력하세요.');
    switchView('settings');
    return;
  }
  const box = $('#briefing-result');
  box.innerHTML = '<div class="empty">🧠 AI가 메일을 분석하는 중입니다... (메일 수에 따라 시간이 걸릴 수 있습니다)</div>';
  showLoading('🧠 AI 브리핑 생성 중...');
  try {
    const res = await window.api.aiBriefing(briefMode);
    hideLoading();
    if (res.ok) {
      box.innerHTML = `<div class="briefing-meta">📅 ${res.period} · 분석 메일 ${res.count}건 · 키#${res.usedKeyIndex}</div>` +
        `<div class="briefing-body">${formatAnswer(res.content)}</div>`;
    } else {
      box.innerHTML = `<div class="empty">❌ ${escapeHtml(res.error)}</div>`;
    }
  } catch (err) {
    hideLoading();
    box.innerHTML = `<div class="empty">❌ ${escapeHtml(String(err))}</div>`;
  }
}

// ============================================================
//  주소록
// ============================================================
async function importContacts() {
  showLoading('📥 Outlook 주소록 가져오는 중...');
  try {
    const res = await window.api.contactsImport();
    hideLoading();
    if (res.ok) {
      alert(`주소록 ${res.imported}건을 가져왔습니다.`);
      loadContacts('');
      loadStats();
    } else {
      alert('주소록 가져오기 실패: ' + res.error);
    }
  } catch (err) {
    hideLoading();
    alert('오류: ' + String(err));
  }
}

async function loadContacts(query) {
  const list = $('#contact-list');
  list.innerHTML = '<div class="empty">불러오는 중...</div>';
  try {
    const res = await window.api.contactsList(query || '', 500);
    if (!res.ok) { list.innerHTML = `<div class="empty">❌ ${escapeHtml(res.error)}</div>`; return; }
    const contacts = res.contacts || [];
    if (!contacts.length) { list.innerHTML = '<div class="empty">👥 주소록이 비어 있습니다.</div>'; return; }
    list.innerHTML = '';
    contacts.forEach(c => {
      const item = document.createElement('div');
      item.className = 'contact-item';
      item.innerHTML = `
        <div class="contact-avatar">${escapeHtml((c.name || c.email || '?').slice(0, 1).toUpperCase())}</div>
        <div class="contact-info">
          <div class="contact-name">${escapeHtml(c.name || '(이름 없음)')}</div>
          <div class="contact-email">${escapeHtml(c.email)}${c.company ? ' · ' + escapeHtml(c.company) : ''}</div>
        </div>
        <button class="contact-search-btn" title="이 사람 메일 검색">📬</button>
      `;
      item.querySelector('.contact-search-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        switchView('mails');
        $('#mail-search').value = c.email;
        loadMails(c.email);
      });
      list.appendChild(item);
    });
  } catch (err) {
    list.innerHTML = `<div class="empty">❌ ${escapeHtml(String(err))}</div>`;
  }
}

// ============================================================
//  뷰 전환
// ============================================================
let mailsLoadedOnce = false;
let contactsLoadedOnce = false;
function switchView(view) {
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach(v => v.classList.remove('active'));
  $('#view-' + view).classList.add('active');

  if (view === 'dashboard') loadStats();
  // 메일 목록 뷰 최초 진입 시 자동으로 DB 메일 로딩
  if (view === 'mails' && !mailsLoadedOnce) {
    mailsLoadedOnce = true;
    loadMails('');
  }
  if (view === 'contacts' && !contactsLoadedOnce) {
    contactsLoadedOnce = true;
    loadContacts('');
  }
}

// ============================================================
//  설정 UI 반영/저장
// ============================================================
function applyConfigToUI() {
  const keys = config.apiKeys || [];
  $$('.api-key').forEach(inp => {
    const idx = parseInt(inp.dataset.idx, 10);
    inp.value = keys[idx] || '';
  });
  $('#model-select').value = config.model || 'llama-3.3-70b';
  $('#max-mails').value = config.maxMails || 2000;
  if ($('#save-attach-toggle')) $('#save-attach-toggle').checked = config.saveAttachmentsOnSync !== false;

  // 소스
  const source = config.source || 'outlook';
  const srcRadio = document.querySelector(`input[name="source"][value="${source}"]`);
  if (srcRadio) srcRadio.checked = true;
  $('#pst-path').value = config.pstPath || '';
  $('#pst-row').classList.toggle('hidden', source !== 'pst');

  // 날짜 필터
  const df = config.dateFilter || { mode: '6months' };
  const dmRadio = document.querySelector(`input[name="dateMode"][value="${df.mode}"]`);
  if (dmRadio) dmRadio.checked = true;
  $('#date-start').value = df.start || '';
  $('#date-end').value = df.end || '';
  $('#range-row').classList.toggle('hidden', df.mode !== 'range');

  // 실시간
  $('#realtime-toggle').checked = config.realtime !== false;
  $('#realtime-interval').value = config.realtimeIntervalSec || 60;

  // 실시간 표시등
  updateRealtimeDot();
}

async function saveSettings() {
  const apiKeys = [];
  $$('.api-key').forEach(inp => {
    apiKeys[parseInt(inp.dataset.idx, 10)] = inp.value.trim();
  });
  const source = document.querySelector('input[name="source"]:checked').value;
  const dateMode = document.querySelector('input[name="dateMode"]:checked').value;

  // PST 모드인데 경로 없으면 경고
  if (source === 'pst' && !$('#pst-path').value.trim()) {
    alert('PST 파일 경로를 선택해주세요. (📁 찾기 버튼)');
    return;
  }

  const newConfig = {
    apiKeys,
    model: $('#model-select').value,
    maxMails: parseInt($('#max-mails').value, 10) || 2000,
    source,
    pstPath: $('#pst-path').value.trim(),
    dateFilter: {
      mode: dateMode,
      start: $('#date-start').value || '',
      end: $('#date-end').value || ''
    },
    realtime: $('#realtime-toggle').checked,
    realtimeIntervalSec: parseInt($('#realtime-interval').value, 10) || 60,
    saveAttachmentsOnSync: $('#save-attach-toggle') ? $('#save-attach-toggle').checked : true
  };
  config = await window.api.setConfig(newConfig);
  updateKeyStatus();
  updateRealtimeDot();
  refreshConnectionStatus();
  const saved = $('#settings-saved');
  saved.classList.remove('hidden');
  setTimeout(() => saved.classList.add('hidden'), 2000);
}

// 실시간 표시등 갱신
function updateRealtimeDot() {
  const on = config.realtime !== false && (config.source || 'outlook') === 'outlook';
  $('#realtime-dot').classList.toggle('hidden', !on);
}

// 연결 상태 확인 (설정 카드에 표시)
async function refreshConnectionStatus() {
  const el = $('#conn-status');
  if (!el) return;
  el.textContent = '연결 확인 중...';
  el.className = 'conn-status';
  try {
    const r = await window.api.checkConnection();
    if (r.ok) {
      if (r.mode === 'pst') {
        el.textContent = `✅ PST 파일 연결됨: ${r.pstPath}`;
      } else {
        const stores = (r.stores || []).map(s => s.name).join(', ');
        el.textContent = `✅ Outlook 연결됨 (계정/데이터: ${stores || '기본'})`;
      }
      el.className = 'conn-status ok';
    } else {
      el.textContent = `⚠️ ${r.error || '연결되지 않음'}`;
      el.className = 'conn-status bad';
    }
  } catch (err) {
    el.textContent = `⚠️ ${String(err)}`;
    el.className = 'conn-status bad';
  }
}

// 새 메일 수동 확인
async function checkNewMails() {
  showLoading('📨 새 메일 확인 중...');
  try {
    const res = await window.api.checkNew();
    hideLoading();
    if (res.ok && res.mails && res.mails.length) {
      handleNewMails(res.mails);
      alert(`새 메일 ${res.mails.length}건을 확인했습니다.`);
    } else if (res.ok) {
      alert('새 메일이 없습니다.');
    } else {
      alert(res.error);
    }
  } catch (err) {
    hideLoading();
    alert('오류: ' + String(err));
  }
}

// 실시간 새 메일 수신 처리 → 목록 맨 위에 추가
function handleNewMails(mails) {
  if (!mails || !mails.length) return;
  // 중복 제거하며 앞에 삽입
  const existingIds = new Set(mailCache.map(m => m.entryId));
  const fresh = mails.filter(m => !existingIds.has(m.entryId));
  if (!fresh.length) return;
  mailCache = [...fresh, ...mailCache];
  // 메일 목록 뷰가 활성화되어 있으면 다시 렌더
  if ($('#view-mails').classList.contains('active')) {
    renderMailList(mailCache);
  }
  // 채팅에도 알림
  addMessage('assistant', `📨 <b>새 메일 ${fresh.length}건 도착</b>\n` +
    fresh.slice(0, 5).map(m => `• ${escapeHtml(m.sender)}: ${escapeHtml(m.subject)}`).join('\n'));
}

function updateKeyStatus() {
  const count = (config.apiKeys || []).filter(k => k && k.trim()).length;
  const el = $('#key-status');
  if (count > 0) {
    el.textContent = `API 키: ${count}개 활성 ✓`;
    el.className = 'key-status ok';
  } else {
    el.textContent = 'API 키 없음 - 설정 필요';
    el.className = 'key-status bad';
  }
}

// ============================================================
//  파일 첨부
// ============================================================
async function pickFiles() {
  const files = await window.api.pickFiles();
  for (const f of files) {
    if (pendingFiles.length >= 5) break;
    if (!pendingFiles.includes(f)) pendingFiles.push(f);
  }
  renderPendingFiles();
}

function renderPendingFiles() {
  const box = $('#pending-files');
  box.innerHTML = '';
  pendingFiles.forEach((f, i) => {
    const name = f.split(/[\\/]/).pop();
    const chip = document.createElement('div');
    chip.className = 'file-chip';
    chip.innerHTML = `📄 ${escapeHtml(name)} <span class="remove" data-i="${i}">✕</span>`;
    chip.querySelector('.remove').addEventListener('click', () => {
      pendingFiles.splice(i, 1); renderPendingFiles();
    });
    box.appendChild(chip);
  });
}

// ============================================================
//  대화형 채팅 (핵심 로직)
//  1) 사용자가 파일 첨부 → 첨부 분석 텍스트를 맥락에 포함
//  2) 사용자가 메일 검색 의도 → Outlook 검색 후 결과를 맥락에 포함
//  3) Cerebras 로 답변 생성
// ============================================================
async function sendChat() {
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text && pendingFiles.length === 0) return;

  // API 키 체크
  if ((config.apiKeys || []).filter(k => k && k.trim()).length === 0) {
    addMessage('assistant', '⚠️ API 키가 설정되지 않았습니다. 왼쪽 <b>⚙️ 설정</b>에서 Cerebras 키를 입력해주세요.');
    switchView('settings');
    return;
  }

  const userDisplay = text + (pendingFiles.length ? `\n📎 첨부 ${pendingFiles.length}개` : '');
  addMessage('user', escapeHtml(userDisplay));
  input.value = '';
  autoGrow();

  const typingEl = addTyping();

  try {
    let contextParts = [];

    // ---- (1) 첨부파일 분석 ----
    if (pendingFiles.length > 0) {
      setTyping(typingEl, '📎 첨부파일 분석 중...');
      const results = await window.api.analyzeAttachments(pendingFiles);
      for (const r of results) {
        if (r.ok) {
          contextParts.push(`[첨부파일: ${r.file} (${r.type}, ${r.sizeKB}KB)]\n${r.text}`);
        } else {
          contextParts.push(`[첨부파일: ${r.file}] 분석 실패: ${r.error}`);
        }
      }
      pendingFiles = [];
      renderPendingFiles();
    }

    // ---- (2) 첨부가 있으면 첨부 분석 위주로 응답 ----
    if (contextParts.length > 0) {
      setTyping(typingEl, '🧠 AI가 답변 생성 중...');
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
      } else {
        addMessage('assistant', `❌ 오류: ${escapeHtml(res.error)}`);
      }
      return;
    }

    // ---- (3) DB 색인 기반 대화형 질의 (aiChatMails) ----
    setTyping(typingEl, '🔎 메일 DB 검색 + AI 분석 중...');
    const res = await window.api.aiChatMails(text, chatHistory.slice(-6));
    removeTyping(typingEl);
    if (res.ok) {
      chatHistory.push({ role: 'user', content: text });
      chatHistory.push({ role: 'assistant', content: res.content });
      const info = res.contextCount ? { keyIndex: res.usedKeyIndex, ctx: res.contextCount } : { keyIndex: res.usedKeyIndex };
      addMessage('assistant', formatAnswer(res.content), info);
    } else {
      addMessage('assistant', `❌ 오류가 발생했습니다:\n${escapeHtml(res.error)}`);
    }

  } catch (err) {
    removeTyping(typingEl);
    addMessage('assistant', `❌ 처리 중 오류: ${escapeHtml(String(err))}`);
  }
}

// 메일 검색 의도 감지 (간단한 휴리스틱)
function looksLikeMailSearch(text) {
  if (!text) return false;
  const kw = ['메일', '이메일', '메세지', '보낸', '받은', '찾아', '검색', '견적', '계약', '첨부', '회신', '답장'];
  return kw.some(k => text.includes(k));
}

// 검색 키워드 추출 (조사/명령어 제거)
function extractKeyword(text) {
  let t = text
    .replace(/찾아\s*줘|찾아|검색\s*해?\s*줘?|보여\s*줘|알려\s*줘|해\s*줘|요약\s*해?\s*줘?/g, '')
    .replace(/관련(된)?|메일|이메일|메세지|좀|을|를|이|가|은|는|에서|의/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // 너무 짧아지면 원문 사용
  return t.length >= 2 ? t : '';
}

// ============================================================
//  메일 목록 뷰
// ============================================================
// DB 색인 기반 메일 로드 (동기화된 데이터)
async function loadMails(query) {
  const list = $('#mail-list');
  list.innerHTML = '<div class="empty">🔄 불러오는 중...</div>';
  try {
    const hasAttach = $('#filter-attach') && $('#filter-attach').checked ? true : null;
    let res;
    if (query && query.trim()) {
      res = await window.api.dbSearchMails({ query: query.trim(), limit: 300, hasAttach });
      if (res.ok) mailCache = res.mails;
    } else {
      res = await window.api.dbSearchMails({ query: '', limit: 300, hasAttach });
      if (res.ok) mailCache = res.mails;
    }
    if (!res.ok) { list.innerHTML = `<div class="empty">❌ ${escapeHtml(res.error)}</div>`; return; }
    renderMailList(mailCache);
  } catch (err) {
    list.innerHTML = `<div class="empty">❌ ${escapeHtml(String(err))}</div>`;
  }
}

// DB row 또는 실시간 mail 객체 모두 렌더 (필드 호환)
function mv(m, dbField, liveField) { return m[dbField] !== undefined ? m[dbField] : m[liveField]; }

function renderMailList(mails) {
  const list = $('#mail-list');
  if (!mails || mails.length === 0) {
    list.innerHTML = '<div class="empty">📭 저장된 메일이 없습니다. 🔄 <b>메일 동기화</b>를 먼저 실행하세요.</div>';
    return;
  }
  list.innerHTML = '';
  mails.forEach(m => {
    const subject = mv(m, 'subject', 'subject');
    const sender = m.sender_name !== undefined ? m.sender_name : m.sender;
    const received = m.received_at !== undefined ? m.received_at : m.received;
    const hasAttach = m.has_attach !== undefined ? m.has_attach : m.hasAttach;
    const attachCount = m.attach_count !== undefined ? m.attach_count : m.attachCount;
    const unread = m.unread;
    const preview = m.preview || '';
    const lang = m.lang || '';
    const langTag = lang === 'en' ? '🇬🇧 EN' : (lang === 'zh' ? '🇨🇳 ZH' : (lang === 'ja' ? '🇯🇵 JA' : ''));

    const item = document.createElement('div');
    item.className = 'mail-item';
    item.innerHTML = `
      <div class="subject">${unread ? '<span class="unread-dot">●</span> ' : ''}${escapeHtml(subject || '(제목 없음)')}</div>
      <div class="meta">
        <span>👤 ${escapeHtml(sender || '')}</span>
        <span>🕐 ${escapeHtml(received || '')}</span>
        ${langTag ? `<span class="lang-tag">${langTag}</span>` : ''}
        ${hasAttach ? `<span class="attach-tag">📎 ${attachCount || ''}</span>` : ''}
      </div>
      <div class="preview">${escapeHtml((preview || '').replace(/\s+/g, ' '))}</div>
    `;
    item.addEventListener('click', () => openMailDetail(m));
    list.appendChild(item);
  });
}

// 메일 상세 모달 (DB id 기반)
async function openMailDetail(m) {
  // 실시간 수신 메일(entryId만 있고 DB id 없음)은 DB에서 조회 시도
  let id = m.id;
  if (!id && m.entryId) {
    // DB에서 못 찾으면 미리보기만
  }
  if (!id) {
    alert('이 메일은 아직 DB에 색인되지 않았습니다. 🔄 동기화 후 확인하세요.');
    return;
  }
  showLoading('📧 메일 불러오는 중...');
  try {
    const res = await window.api.dbGetMail(id);
    hideLoading();
    if (!res.ok) { alert(res.error); return; }
    renderMailModal(res.mail, res.attachments, res.analyses);
  } catch (err) {
    hideLoading();
    alert('오류: ' + String(err));
  }
}

function renderMailModal(mail, atts, analyses) {
  const body = $('#modal-body');
  const langNames = { ko: '한국어', en: '영어', zh: '중국어', ja: '일본어', unknown: '기타' };
  let html = `
    <h2 class="modal-subject">${escapeHtml(mail.subject || '(제목 없음)')}</h2>
    <div class="modal-meta">
      <div>👤 <b>${escapeHtml(mail.sender_name || '')}</b> &lt;${escapeHtml(mail.sender_email || '')}&gt;</div>
      <div>📥 받는사람: ${escapeHtml(mail.recipients || '')}</div>
      ${mail.cc ? `<div>📋 참조: ${escapeHtml(mail.cc)}</div>` : ''}
      <div>🕐 ${escapeHtml(mail.received_at || '')} · 🌐 ${langNames[mail.lang] || mail.lang} · 📁 ${escapeHtml(mail.folder || '')}</div>
    </div>`;

  if (atts && atts.length) {
    html += `<div class="modal-atts"><b>📎 첨부파일 (${atts.length})</b><ul>` +
      atts.map(a => `<li>${escapeHtml(a.file_name)} (${a.size_kb}KB) ${a.saved_path ? `<button class="link-btn" data-open="${escapeHtml(a.saved_path)}">열기</button> <button class="link-btn" data-folder="${escapeHtml(a.saved_path)}">폴더</button>` : ''}</li>`).join('') +
      `</ul></div>`;
  }

  html += `<div class="modal-actions">
    <button class="btn-primary" id="modal-translate">🌐 번역/분석</button>
    <button class="btn-primary" id="modal-reply">✍️ 답장 초안</button>
    <button id="modal-ask">💬 이 메일로 질문</button>
  </div>`;

  html += `<div class="modal-body-text">${escapeHtml((mail.body || '').slice(0, 8000))}</div>`;
  html += `<div id="modal-ai-result" class="modal-ai-result"></div>`;

  body.innerHTML = html;
  $('#mail-modal').classList.remove('hidden');

  // 첨부 열기/폴더
  body.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => window.api.openPath(b.dataset.open)));
  body.querySelectorAll('[data-folder]').forEach(b => b.addEventListener('click', () => window.api.showItem(b.dataset.folder)));

  // 번역/분석
  $('#modal-translate').addEventListener('click', async () => {
    const box = $('#modal-ai-result');
    box.innerHTML = '<div class="empty">🌐 번역/분석 중...</div>';
    const res = await window.api.aiTranslate(mail.id);
    box.innerHTML = res.ok ? `<div class="briefing-body">${formatAnswer(res.content)}</div>` : `<div class="empty">❌ ${escapeHtml(res.error)}</div>`;
  });
  // 답장 초안
  $('#modal-reply').addEventListener('click', async () => {
    const instruction = prompt('답장에 반영할 지시사항이 있으면 입력하세요 (없으면 비워두기):', '') || '';
    const box = $('#modal-ai-result');
    box.innerHTML = '<div class="empty">✍️ 답장 초안 작성 중...</div>';
    const res = await window.api.aiDraftReply(mail.id, instruction, 'formal', 'auto');
    if (res.ok) {
      box.innerHTML = `<div class="reply-draft"><div class="reply-head">✍️ 답장 초안 <button class="link-btn" id="copy-reply">📋 복사</button></div><pre>${escapeHtml(res.content)}</pre></div>`;
      $('#copy-reply').addEventListener('click', () => { navigator.clipboard.writeText(res.content); $('#copy-reply').textContent = '✅ 복사됨'; });
    } else {
      box.innerHTML = `<div class="empty">❌ ${escapeHtml(res.error)}</div>`;
    }
  });
  // 이 메일로 질문
  $('#modal-ask').addEventListener('click', () => {
    $('#mail-modal').classList.add('hidden');
    switchView('chat');
    chatHistory.push({ role: 'user', content: `[참고 메일]\n제목:${mail.subject}\n발신:${mail.sender_name}\n본문:${(mail.body||'').slice(0,4000)}` });
    addMessage('assistant', `📧 "<b>${escapeHtml(mail.subject)}</b>" 메일을 맥락에 추가했습니다. 이 메일에 대해 질문해보세요.`);
  });

  // 이전 분석 결과 표시
  if (analyses && analyses.length) {
    const box = $('#modal-ai-result');
    const kindName = { translate: '🌐 번역/분석', reply: '✍️ 답장초안', summary: '요약' };
    box.innerHTML = `<div class="prev-analyses"><b>📚 이전 분석 기록</b>` +
      analyses.slice(0, 3).map(a => `<details><summary>${kindName[a.kind] || a.kind} (${a.created_at})</summary><div class="briefing-body">${formatAnswer(a.content)}</div></details>`).join('') +
      `</div>`;
  }
}

// ============================================================
//  채팅 메시지 렌더링 헬퍼
// ============================================================
function addMessage(role, html, opts = {}) {
  const log = $('#chat-log');
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  let extra = '';
  if (opts.keyIndex) extra = `<div style="font-size:10px;opacity:.5;margin-top:6px;">키#${opts.keyIndex} 사용${opts.ctx ? ` · 참고메일 ${opts.ctx}건` : ''}</div>`;
  div.innerHTML = `<div class="bubble">${html}${extra}</div>`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}
function addTyping() {
  const log = $('#chat-log');
  const div = document.createElement('div');
  div.className = 'msg assistant typing';
  div.innerHTML = `<div class="bubble">⏳ 처리 중...</div>`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}
function setTyping(el, text) { if (el) el.querySelector('.bubble').textContent = '⏳ ' + text; $('#chat-log').scrollTop = $('#chat-log').scrollHeight; }
function removeTyping(el) { if (el && el.parentNode) el.parentNode.removeChild(el); }

// 마크다운 비슷하게 간단 포맷
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
    checking: ['info', '🔍 업데이트 확인 중...'],
    available: ['info', '⬇️ 새 버전 다운로드 중...'],
    downloading: ['info', `⬇️ 다운로드 ${info && info.percent ? Math.round(info.percent) + '%' : '...'}`],
    downloaded: ['ready', '✅ 업데이트 준비 완료 (재시작 시 적용)'],
    none: ['', ''],
    error: ['info', '⚠️ 업데이트 확인 실패']
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
