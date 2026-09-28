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
  const limit = config.maxMails && config.maxMails > 0 ? config.maxMails : 5000;
  const doSaveAttach = config.saveAttachments !== false;

  let allMails = [];

  onProgress('fetch', 0, 0, '메일 목록을 가져오는 중...');

  if (config.source === 'pst') {
    if (!config.pstPath) throw new Error('PST 경로가 설정되지 않았습니다.');
    // PST 전체 스캔 (query 없이)
    allMails = await pst.searchMails(config.pstPath, '', limit, dateFilter);
  } else {
    // Outlook: 받은편지함(6) + 보낸편지함(5), 각각 하위 폴더까지 재귀 수집
    const scanOpts = {
      includeSubfolders: config.includeSubfolders !== false,
      maxDepth: config.subfolderDepth || 3
    };
    onProgress('fetch', 0, 0, '받은편지함(하위 폴더 포함)을 읽는 중...');
    const inbox = await outlook.scanFolder(6, dateFilter, limit, scanOpts);
    allMails = inbox.slice();

    // ★ Outlook 사이드바와 1:1 이 되도록 특수 폴더까지 수집한다.
    //   실측(2026-07-30): 임시 보관함 21 / 정크 메일 248 / 보낼 편지함 2 / 지운 편지함 1,491 이
    //   전부 미수집이었다(받은·보낸편지함만 스캔했기 때문).
    //   지운 편지함은 용량이 크고 '버린 메일'이라 기본 제외하고 옵션으로 켠다.
    const SPECIAL = [
      { type: 5, label: '보낸편지함' },
      { type: 16, label: '임시 보관함' },
      { type: 4, label: '보낼 편지함' },
      { type: 23, label: '정크 메일' }
    ];
    if (config.includeDeleted === true) SPECIAL.push({ type: 3, label: '지운 편지함' });

    for (const sp of SPECIAL) {
      onProgress('fetch', allMails.length, 0, `${sp.label}을 읽는 중... (누적 ${allMails.length}건)`);
      try {
        const got = await outlook.scanFolder(sp.type, dateFilter, limit, scanOpts);
        allMails = allMails.concat(got);
      } catch (e) {
        // 폴더가 없는 계정도 있으므로 실패는 건너뛰되 조용히 삼키지 않는다
        onProgress('fetch', allMails.length, 0, `${sp.label} 읽기 실패: ` + (e && e.message ? e.message : e));
      }
    }

    // 아카이브 PST(Outlook 에 마운트된 추가 스토어, 예: 백업.pst)
    // archiveStoreNames: null/미설정 = 전부, 배열 = 그 목록만, 빈 배열 = 수집 안 함
    const wantedArchives = config.archiveStoreNames;
    const explicitArchives = Array.isArray(wantedArchives);
    const skipArchives = explicitArchives && wantedArchives.length === 0;
    if (config.includeArchiveStores === true && skipArchives) {
      onProgress('fetch', allMails.length, 0, '수집 대상으로 선택된 아카이브가 없어 건너뜁니다.');
    } else if (config.includeArchiveStores === true) {
      onProgress('fetch', allMails.length, 0, '아카이브 PST를 읽는 중... (건수가 많으면 오래 걸립니다)');
      try {
        const archive = await outlook.scanStores(dateFilter, limit, {
          maxDepth: config.archiveDepth || 6,
          storeNames: explicitArchives ? wantedArchives : []
        });
        onProgress('fetch', allMails.length + archive.length, 0, `아카이브 ${archive.length}건 수집`);
        allMails = allMails.concat(archive);
      } catch (e) {
        // 아카이브 실패로 전체 동기화를 죽이지 않되, 조용히 삼키지도 않는다
        onProgress('fetch', allMails.length, 0, '아카이브 PST 읽기 실패: ' + (e && e.message ? e.message : e));
      }
    }
  }

  const total = allMails.length;
  onProgress('store', 0, total, `${total}건을 DB에 저장하는 중...`);

  // DB 저장 (배치)
  db.upsertMailsBatch(allMails);

  // 주소록 자동 연동 ①: 메일 발신자에서 파생 축적
  const contactMap = new Map();
  for (const m of allMails) {
    const c = deriveContact(m);
    if (c && !contactMap.has(c.email.toLowerCase())) contactMap.set(c.email.toLowerCase(), c);
  }
  let contactsDerived = 0;
  if (contactMap.size) contactsDerived = db.upsertContactsBatch([...contactMap.values()]);

  // 주소록 자동 연동 ②: Outlook 연락처 폴더를 동기화 때마다 자동으로 가져온다
  //  (기존에는 주소록 화면의 '가져오기' 버튼을 눌러야만 반영됐다)
  let contactsImported = 0;
  if (config.source !== 'pst' && config.autoImportContacts !== false) {
    try {
      onProgress('contacts', 0, 0, 'Outlook 주소록을 가져오는 중...');
      const oc = await outlook.getContacts(5000);
      if (oc && oc.length) contactsImported = db.upsertContactsBatch(oc);
    } catch (e) {
      onProgress('contacts', 0, 0, '주소록 자동 가져오기 실패: ' + (e && e.message ? e.message : e));
    }
  }

  // 첨부 저장 + 추출
  let attachSaved = 0, attachFail = 0, attachSkipped = 0;
  if (doSaveAttach) {
    // 대상 = 첨부가 있고, 아직 DB 에 첨부 기록이 없는 메일
    //  (이미 저장한 메일을 다시 처리하면 attachments 행이 매 동기화마다 중복 누적된다)
    const targets = [];
    for (const m of allMails) {
      if (!(m.hasAttach || m.attachCount > 0)) continue;
      const mailRow = db.getMailByEntryId(m.entryId);
      if (!mailRow) continue;
      if (db.getAttachmentsByMail(mailRow.id).length > 0) { attachSkipped++; continue; }
      const dateDir = (m.received || '').slice(0, 10) || 'unknown';
      targets.push({
        mail: m,
        mailId: mailRow.id,
        dir: path.join(ATTACH_ROOT, dateDir, safeName(m.subject || m.entryId).slice(0, 40))
      });
    }

    // 저장된 파일 → 텍스트 추출 + DB 기록
    const record = async (mailId, savedPaths) => {
      for (const sp of savedPaths) {
        let extracted = '';
        try {
          const ex = await attachments.extract(sp);
          extracted = (ex && ex.text) ? ex.text.slice(0, 4000) : '';
        } catch (_) {}
        const stat = fs.existsSync(sp) ? fs.statSync(sp) : null;
        db.addAttachment(mailId, {
          fileName: path.basename(sp),
          sizeKB: stat ? Math.round(stat.size / 1024) : 0,
          savedPath: sp,
          extracted
        });
        attachSaved++;
      }
    };

    if (config.source === 'pst') {
      let idx = 0;
      for (const t of targets) {
        idx++;
        onProgress('attach', idx, targets.length, `첨부 저장 중 (${idx}/${targets.length}): ${t.mail.subject || ''}`);
        try {
          const r = await pst.getMailDetailAndAttachments(config.pstPath, t.mail.entryId, true, t.dir);
          await record(t.mailId, r.savedPaths || []);
        } catch (_) { attachFail++; }
      }
    } else {
      // Outlook: PowerShell 1회에 여러 건씩 묶어 저장 (프로세스/COM 재연결 비용 제거)
      const CHUNK = 50;
      const byEntry = new Map(targets.map(t => [t.mail.entryId, t]));
      for (let i = 0; i < targets.length; i += CHUNK) {
        const chunk = targets.slice(i, i + CHUNK);
        onProgress('attach', Math.min(i + chunk.length, targets.length), targets.length,
          `첨부 저장 중 (${Math.min(i + chunk.length, targets.length)}/${targets.length})`);
        let results = [];
        try {
          results = await outlook.saveAttachmentsBatch(
            chunk.map(t => ({ entryId: t.mail.entryId, dir: t.dir }))
          );
        } catch (_) { attachFail += chunk.length; continue; }
        for (const r of results) {
          const t = byEntry.get(r.entryId);
          if (!t) continue;
          if (!r.paths.length) { attachFail++; continue; }
          try { await record(t.mailId, r.paths); } catch (_) { attachFail++; }
        }
      }
    }
  }

  // ★ To/CC 역할 백필: 새로 들어온 메일의 '직접 수신/참조'를 채운다(리스트 마커·필터·AI 힌트 공용)
  let toMe = { direct: 0, cc: 0 };
  try { onProgress('store', total, total, '수신/참조 구분을 정리하는 중...'); toMe = db.backfillToMe({ force: false }); } catch (_) {}

  db.setState('lastSyncAt', new Date().toISOString());
  db.setState('lastSyncCount', String(total));

  const s = db.stats();
  onProgress('done', total, total, '동기화 완료');
  return {
    ok: true,
    fetched: total,
    attachSaved,
    attachFail,
    attachSkipped,
    contactsDerived,
    contactsImported,
    toMeDirect: toMe.direct || 0,
    toMeCc: toMe.cc || 0,
    stats: s,
    lastSyncAt: db.getState('lastSyncAt')
  };
}

// ------------------------------------------------------------
//  증분 동기화 (실시간 새 메일 → DB)  [Outlook 전용]
// ------------------------------------------------------------
async function syncNew(sinceIso, limit = 50) {
  // ★ 받은편지함 '루트만' 보면 안 된다.
  //   Outlook 규칙이 새 메일을 하위 폴더(예: 22K FD, KSIT)로 자동 분류하면
  //   루트 조회로는 영구히 잡히지 않는다(실측: 3일치 조회에도 0건).
  //   → 검증된 재귀 스캐너(scanFolder)를 그대로 재사용해 하위 폴더까지 본다.
  const since = new Date(sinceIso || Date.now() - 3600000);
  const dateFilter = { mode: 'range', start: since.toISOString() };
  let newMails = [];
  try {
    newMails = await outlook.scanFolder(6, dateFilter, limit, { includeSubfolders: true, maxDepth: 3 });
  } catch (e) {
    // 재귀 스캔 실패 시 루트 전용 경로로 폴백 (기능 정지 방지)
    newMails = await outlook.getNewMailsSince(sinceIso, limit);
  }
  if (!newMails || !newMails.length) return [];

  const mapped = newMails.map(m => ({ ...m, source: 'outlook', folder: m.folder || 'Inbox' }));

  // ★ '진짜 새 메일'은 저장하기 전에 판정해야 한다 (2026-08-04).
  //   따라잡기 창(시작 시 72시간)에는 이미 저장된 메일도 함께 들어오므로,
  //   upsert 뒤에 조회하면 전부 isNew=true 가 되어 알림·목록 꽂기가 잘못 뜬다.
  const known = new Set();
  for (const m of mapped) { if (m.entryId && db.getMailByEntryId(m.entryId)) known.add(m.entryId); }

  db.upsertMailsBatch(mapped);

  const contacts = [];
  for (const m of mapped) { const c = deriveContact(m); if (c) contacts.push(c); }
  if (contacts.length) db.upsertContactsBatch(contacts);

  // ★ DB id 를 붙여서 반환한다. id 가 없으면 UI 에서 클릭해도 메일을 열 수 없다.
  //   (기존에는 COM 결과를 그대로 넘겨 목록에 꽂혀도 열리지 않았다)
  return mapped.map(m => {
    const row = db.getMailByEntryId(m.entryId);
    return {
      ...m,
      id: row ? row.id : null,
      isNew: !known.has(m.entryId),
      received_at: m.received || '',
      sender_name: m.sender || '',
      sender_email: m.senderMail || '',
      has_attach: m.hasAttach ? 1 : 0,
      attach_count: m.attachCount || 0
    };
  });
}

function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|\r\n]/g, '_').trim() || 'mail';
}

module.exports = { syncAll, syncNew, setAttachRoot, get attachRoot() { return ATTACH_ROOT; } };
