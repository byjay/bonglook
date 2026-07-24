// ============================================================
//  renderer.js - UI 로직 (window.api 를 통해 메인 프로세스와 통신)
// ============================================================

// ---------- 상태 ----------
let config = {
  apiKeys: ['', '', '', '', ''], model: 'llama-3.3-70b', maxMails: 50,
  source: 'outlook', pstPath: '',
  dateFilter: { mode: '6months', start: '', end: '' },
  realtime: true, realtimeIntervalSec: 60
};
let pendingFiles = [];          // 첨부 대기 파일 경로 (최대 5)
let chatHistory = [];           // {role, content} - AI 대화 맥락
let mailCache = [];             // 최근 검색된 메일 목록

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

  // 이벤트 수신
  window.api.onUpdateStatus(handleUpdateStatus);
  window.api.onNewMails(handleNewMails);
  window.api.onRealtimeError((err) => console.warn('실시간 확인 오류:', err));

  // 연결 상태 확인
  refreshConnectionStatus();
});

// ============================================================
//  뷰 전환
// ============================================================
let mailsLoadedOnce = false;
function switchView(view) {
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach(v => v.classList.remove('active'));
  $('#view-' + view).classList.add('active');

  // 메일 목록 뷰 최초 진입 시 자동으로 최신 메일 로딩
  if (view === 'mails' && !mailsLoadedOnce) {
    mailsLoadedOnce = true;
    loadMails('');
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
  $('#max-mails').value = config.maxMails || 50;

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
    maxMails: parseInt($('#max-mails').value, 10) || 50,
    source,
    pstPath: $('#pst-path').value.trim(),
    dateFilter: {
      mode: dateMode,
      start: $('#date-start').value || '',
      end: $('#date-end').value || ''
    },
    realtime: $('#realtime-toggle').checked,
    realtimeIntervalSec: parseInt($('#realtime-interval').value, 10) || 60
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

    // ---- (2) 메일 검색 의도 감지 ----
    if (looksLikeMailSearch(text)) {
      setTyping(typingEl, '📬 Outlook 메일 검색 중...');
      const keyword = extractKeyword(text);
      const mails = await window.api.searchMails(keyword, config.maxMails);
      mailCache = mails;
      if (mails.length > 0) {
        const mailSummary = mails.slice(0, 20).map((m, i) =>
          `${i + 1}. [${m.received}] 보낸사람:${m.sender} | 제목:${m.subject}${m.hasAttach ? ' (첨부'+m.attachCount+')' : ''}\n   미리보기: ${(m.preview||'').replace(/\s+/g,' ').slice(0,150)}`
        ).join('\n');
        contextParts.push(`[Outlook 검색 결과 - "${keyword}" 관련 ${mails.length}건]\n${mailSummary}`);
      } else {
        contextParts.push(`[Outlook 검색 결과] "${keyword}" 관련 메일을 찾지 못했습니다.`);
      }
    }

    // ---- (3) Cerebras 호출 ----
    setTyping(typingEl, '🧠 AI가 답변 생성 중...');
    const systemPrompt = {
      role: 'system',
      content: `당신은 한국어로 답변하는 Outlook 이메일 비서입니다.
- 사용자의 메일 검색, 첨부파일(PDF/엑셀/이미지/워드) 분석, 요약을 돕습니다.
- 제공된 [Outlook 검색 결과]나 [첨부파일] 정보를 근거로 정확하게 답하세요.
- 정보가 없으면 추측하지 말고 "해당 정보를 찾지 못했다"고 말하세요.
- 답변은 간결하고 명확하게, 필요하면 목록으로 정리하세요.`
    };

    const userContent = contextParts.length
      ? `${contextParts.join('\n\n')}\n\n---\n사용자 질문: ${text || '위 첨부파일을 분석/요약해줘'}`
      : text;

    // 대화 맥락 유지 (최근 6개 메시지만)
    chatHistory.push({ role: 'user', content: userContent });
    const messages = [systemPrompt, ...chatHistory.slice(-6)];

    const res = await window.api.chat(messages);

    removeTyping(typingEl);
    if (res.ok) {
      chatHistory.push({ role: 'assistant', content: res.content });
      addMessage('assistant', formatAnswer(res.content), { keyIndex: res.usedKeyIndex });
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
async function loadMails(query) {
  const list = $('#mail-list');
  list.innerHTML = '<div class="empty">🔄 Outlook에서 불러오는 중... (Outlook이 실행 중이어야 합니다)</div>';
  showLoading('📬 Outlook 메일 불러오는 중...');
  try {
    const mails = await window.api.searchMails(query || '', config.maxMails);
    mailCache = mails;
    renderMailList(mails);
  } catch (err) {
    list.innerHTML = `<div class="empty">❌ ${escapeHtml(String(err))}<br><br>
      Outlook이 실행 중이고 로그인되어 있는지 확인하세요.</div>`;
  } finally {
    hideLoading();
  }
}

function renderMailList(mails) {
  const list = $('#mail-list');
  if (!mails || mails.length === 0) {
    list.innerHTML = '<div class="empty">📭 메일이 없습니다.</div>';
    return;
  }
  list.innerHTML = '';
  mails.forEach(m => {
    const item = document.createElement('div');
    item.className = 'mail-item';
    item.innerHTML = `
      <div class="subject">${m.unread ? '<span class="unread-dot">●</span> ' : ''}${escapeHtml(m.subject || '(제목 없음)')}</div>
      <div class="meta">
        <span>👤 ${escapeHtml(m.sender || '')}</span>
        <span>🕐 ${escapeHtml(m.received || '')}</span>
        ${m.hasAttach ? `<span class="attach-tag">📎 첨부 ${m.attachCount}</span>` : ''}
      </div>
      <div class="preview">${escapeHtml((m.preview || '').replace(/\s+/g, ' '))}</div>
    `;
    item.addEventListener('click', () => openMail(m.entryId));
    list.appendChild(item);
  });
}

// 메일 클릭 → 상세 열기 + AI 요약 옵션
async function openMail(entryId) {
  showLoading('📧 메일 상세 불러오는 중...');
  try {
    const mail = await window.api.getMail(entryId);
    hideLoading();
    // 채팅 뷰로 이동해서 메일 내용 표시
    switchView('chat');
    let msg = `<b>📧 ${escapeHtml(mail.subject || '(제목 없음)')}</b>\n`;
    msg += `보낸사람: ${escapeHtml(mail.sender || '')} &lt;${escapeHtml(mail.senderMail || '')}&gt;\n`;
    msg += `받는사람: ${escapeHtml(mail.to || '')}\n`;
    msg += `시간: ${escapeHtml(mail.received || '')}\n`;
    if (mail.attachments && mail.attachments.length) {
      msg += `첨부: ${mail.attachments.map(a => escapeHtml(a.name)).join(', ')}\n`;
    }
    msg += `\n${escapeHtml((mail.body || '').slice(0, 1500))}`;
    addMessage('assistant', msg);

    // 이 메일을 대화 맥락에 넣기
    chatHistory.push({
      role: 'user',
      content: `[선택한 메일]\n제목:${mail.subject}\n보낸사람:${mail.sender}\n본문:${(mail.body||'').slice(0,5000)}`
    });

    // 첨부가 있으면 분석 제안
    if (mail.attachments && mail.attachments.length) {
      const analyze = confirm(`이 메일에 첨부파일 ${mail.attachments.length}개가 있습니다.\nAI로 분석할까요?`);
      if (analyze) analyzeMailAttachments(entryId);
    }
  } catch (err) {
    hideLoading();
    addMessage('assistant', `❌ 메일 열기 실패: ${escapeHtml(String(err))}`);
    switchView('chat');
  }
}

// 메일 첨부파일 저장 후 분석
async function analyzeMailAttachments(entryId) {
  const typingEl = addTyping();
  setTyping(typingEl, '📎 첨부파일 저장/분석 중...');
  try {
    const paths = await window.api.saveAttachments(entryId);
    if (!paths.length) { removeTyping(typingEl); addMessage('assistant', '분석 가능한 첨부파일이 없습니다.'); return; }
    const results = await window.api.analyzeAttachments(paths);
    const contextParts = results.map(r => r.ok
      ? `[첨부: ${r.file} (${r.type}, ${r.sizeKB}KB)]\n${r.text}`
      : `[첨부: ${r.file}] 실패: ${r.error}`);

    setTyping(typingEl, '🧠 AI 분석 중...');
    const messages = [
      { role: 'system', content: '당신은 한국어 이메일 첨부파일 분석 비서입니다. 첨부 내용을 명확히 요약/분석하세요.' },
      { role: 'user', content: `${contextParts.join('\n\n')}\n\n---\n위 첨부파일들을 각각 요약하고 핵심을 정리해줘.` }
    ];
    const res = await window.api.chat(messages);
    removeTyping(typingEl);
    if (res.ok) addMessage('assistant', formatAnswer(res.content), { keyIndex: res.usedKeyIndex });
    else addMessage('assistant', `❌ ${escapeHtml(res.error)}`);
  } catch (err) {
    removeTyping(typingEl);
    addMessage('assistant', `❌ 첨부 분석 실패: ${escapeHtml(String(err))}`);
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
  if (opts.keyIndex) extra = `<div style="font-size:10px;opacity:.5;margin-top:6px;">키#${opts.keyIndex} 사용</div>`;
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
