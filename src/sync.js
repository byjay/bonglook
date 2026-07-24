// ============================================================
//  sync.js - 메일 동기화 엔진
//  ------------------------------------------------------------
//  Outlook(COM) 또는 PST(직접 파싱) → 로컬 DB(db.js) 저장
//   + 첨부파일(도면 등) 로컬 저장 + 텍스트 추출
//   + 발신자를 주소록(contacts)으로 자동 축적
//  ------------------------------------------------------------
//  진행상황은 onProgress(콜백)으로 렌더러에 전달.
// ============================================================
const path = require('path');
const fs = require('fs');
const outlook = require('./outlook');
const pst = require('./pst');
const db = require('./db');
const attachments = require('./attachments');

// 첨부 저장 루트 (userData/attachments/<날짜>)
let ATTACH_ROOT = '';
function setAttachRoot(dir) {
  ATTACH_ROOT = dir;
  fs.mkdirSync(ATTACH_ROOT, { recursive: true });
}

// 발신자 → 주소록 파생
function deriveContact(mail) {
  const email = mail.sender_email || mail.senderMail || '';
  if (!email || !email.includes('@')) return null;
  return {
    name: mail.sender_name || mail.sender || '',
    email,
    company: '',
    source: 'derived'
  };
}

// ------------------------------------------------------------
//  전체 동기화
//  config: { source:'outlook'|'pst', pstPath, dateFilter, maxMails, saveAttachments }
//  onProgress(phase, cur, total, msg)
// ------------------------------------------------------------
async function syncAll(config, onProgress = () => {}) {
  const dateFilter = config.dateFilter || { mode: '6months' };
  const limit = config.maxMails && config.maxMails > 0 ? config.maxMails : 2000;
  const doSaveAttach = config.saveAttachments !== false;

  let allMails = [];

  onProgress('fetch', 0, 0, '메일 목록을 가져오는 중...');

  if (config.source === 'pst') {
    if (!config.pstPath) throw new Error('PST 경로가 설정되지 않았습니다.');
    // PST 전체 스캔 (query 없이)
    allMails = await pst.searchMails(config.pstPath, '', limit, dateFilter);
  } else {
    // Outlook: 받은편지함(6) + 보낸편지함(5)
    const inbox = await outlook.scanFolder(6, dateFilter, limit);
    let sent = [];
    try { sent = await outlook.scanFolder(5, dateFilter, Math.min(limit, 1000)); } catch (_) {}
    allMails = inbox.concat(sent);
  }

  const total = allMails.length;
  onProgress('store', 0, total, `${total}건을 DB에 저장하는 중...`);

  // DB 저장 (배치)
  db.upsertMailsBatch(allMails);

  // 주소록 파생 축적
  const contactMap = new Map();
  for (const m of allMails) {
    const c = deriveContact(m);
    if (c && !contactMap.has(c.email.toLowerCase())) contactMap.set(c.email.toLowerCase(), c);
  }
  if (contactMap.size) db.upsertContactsBatch([...contactMap.values()]);

  // 첨부 저장 + 추출
  let attachSaved = 0, attachFail = 0;
  if (doSaveAttach) {
    const withAttach = allMails.filter(m => m.hasAttach || m.attachCount > 0);
    let idx = 0;
    for (const m of withAttach) {
      idx++;
      onProgress('attach', idx, withAttach.length, `첨부 저장 중 (${idx}/${withAttach.length}): ${m.subject || ''}`);
      try {
        const mailRow = db.getMailByEntryId(m.entryId);
        if (!mailRow) continue;
        const dateDir = (m.received || '').slice(0, 10) || 'unknown';
        const saveDir = path.join(ATTACH_ROOT, dateDir, safeName(m.subject || m.entryId).slice(0, 40));
        let savedPaths = [];

        if (config.source === 'pst') {
          const r = await pst.getMailDetailAndAttachments(config.pstPath, m.entryId, true, saveDir);
          savedPaths = r.savedPaths || [];
        } else {
          // Outlook: 임시 저장 후 목표 폴더로 이동
          const tmpPaths = await outlook.saveAttachments(m.entryId);
          fs.mkdirSync(saveDir, { recursive: true });
          for (const tp of tmpPaths) {
            const dest = path.join(saveDir, path.basename(tp));
            try { fs.copyFileSync(tp, dest); savedPaths.push(dest); } catch (_) { savedPaths.push(tp); }
          }
        }

        // 각 첨부 텍스트 추출 + DB 기록
        for (const sp of savedPaths) {
          let extracted = '';
          try {
            const ex = await attachments.extract(sp);
            extracted = (ex && ex.text) ? ex.text.slice(0, 4000) : '';
          } catch (_) {}
          const stat = fs.existsSync(sp) ? fs.statSync(sp) : null;
          db.addAttachment(mailRow.id, {
            fileName: path.basename(sp),
            sizeKB: stat ? Math.round(stat.size / 1024) : 0,
            savedPath: sp,
            extracted
          });
          attachSaved++;
        }
      } catch (e) {
        attachFail++;
      }
    }
  }

  db.setState('lastSyncAt', new Date().toISOString());
  db.setState('lastSyncCount', String(total));

  const s = db.stats();
  onProgress('done', total, total, '동기화 완료');
  return {
    ok: true,
    fetched: total,
    attachSaved,
    attachFail,
    stats: s,
    lastSyncAt: db.getState('lastSyncAt')
  };
}

// ------------------------------------------------------------
//  증분 동기화 (실시간 새 메일 → DB)  [Outlook 전용]
// ------------------------------------------------------------
async function syncNew(sinceIso, limit = 50) {
  const newMails = await outlook.getNewMailsSince(sinceIso, limit);
  if (newMails && newMails.length) {
    const mapped = newMails.map(m => ({ ...m, source: 'outlook', folder: m.folder || 'Inbox' }));
    db.upsertMailsBatch(mapped);
    const contacts = [];
    for (const m of mapped) { const c = deriveContact(m); if (c) contacts.push(c); }
    if (contacts.length) db.upsertContactsBatch(contacts);
  }
  return newMails || [];
}

function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|\r\n]/g, '_').trim() || 'mail';
}

module.exports = { syncAll, syncNew, setAttachRoot, get attachRoot() { return ATTACH_ROOT; } };
