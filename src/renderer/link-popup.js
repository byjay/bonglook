// ============================================================
//  link-popup.js — 다운로드 팝업 상단 띠 그리기 (link-popup.html 전용)
//  상태: loading → progress(%) → done([열기][폴더 열기] + n초 뒤 닫힘)
//        | manual(자동 불가 — 이 창에서 직접) | blocked(실행형 차단)
//  🔴 받은 파일을 자동으로 열지 않는다. 열기는 버튼을 눌렀을 때만.
// ============================================================
(() => {
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => {
    const v = Number(n) || 0;
    if (v >= 1073741824) return (v / 1073741824).toFixed(1) + ' GB';
    if (v >= 1048576) return (v / 1048576).toFixed(1) + ' MB';
    if (v >= 1024) return Math.round(v / 1024) + ' KB';
    return v + ' B';
  };
  function render(s) {
    $('bar').className = 'st-' + (s.state || 'loading');
    $('domain').textContent = s.domain || '';
    document.title = (s.name || s.domain || '다운로드') + ' — Bmail';
    let msg = '';
    let pct = 0;
    if (s.state === 'loading') msg = s.reason && /자동 클릭/.test(s.reason) ? `다운로드 준비 중 · ${s.reason}` : '다운로드 준비 중…';
    else if (s.state === 'progress') {
      if (s.total > 0) { pct = Math.min(100, Math.floor((s.received || 0) * 100 / s.total)); msg = `다운로드 중 ${pct}% · ${fmt(s.received)} / ${fmt(s.total)}`; }
      else msg = `다운로드 중 · ${fmt(s.received)}`;
    } else if (s.state === 'done') {
      pct = 100;
      msg = `완료 · ${fmt(s.size)}${s.count > 1 ? ` · 모두 ${s.count}개` : ''}`;
      if (s.closeIn != null) msg += s.hover ? ' · 마우스를 떼면 닫힘' : ` · ${s.closeIn}초 뒤 닫힘`;
    } else msg = s.reason || '';
    $('name').textContent = s.name || (s.state === 'manual' || s.state === 'blocked' ? '자동 다운로드 불가' : s.url || '');
    $('name').title = s.name || s.url || '';
    $('msg').textContent = msg;
    $('msg').title = msg;
    $('prog-fill').style.width = pct + '%';
    const done = s.state === 'done';
    $('b-open').classList.toggle('hide', !done);
    $('b-folder').classList.toggle('hide', !done);
    $('b-enlarge').classList.toggle('hide', s.state === 'blocked');
    $('b-enlarge').textContent = s.large ? '작게' : '크게';
    // 페이지가 없는 경우(차단·직링크)엔 띠 아래에 안내문을 보여준다
    const note = $('note');
    const showNote = s.state === 'blocked' || !!s.pageless;
    note.classList.toggle('hide', !showNote);
    if (s.state === 'blocked') note.textContent = `${s.reason || ''}\n${s.url || ''}`;
    else if (showNote) note.textContent = `${s.name || ''}\n저장 위치: ${s.file || s.dir || ''}\n\n파일 링크라 페이지 없이 바로 받습니다.`;
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (b) window.ldp.act(b.dataset.act);
  });
  window.ldp.onState(render);
  window.ldp.ready($('bar').offsetHeight);
})();
