// ============================================================
//  pst.js - PST 파일 직접 파싱 (Outlook 미실행 시 사용)
//  ------------------------------------------------------------
//  ★ pst-extractor 라이브러리로 .pst 파일을 직접 열어 메일을 읽음.
//  ★ Outlook을 켜지 않아도 되지만, "실시간 갱신"은 안 됨(파일 스냅샷).
//     → 실시간이 필요하면 outlook.js(COM) 방식을 사용.
//  ------------------------------------------------------------
//  날짜 필터: { mode: '6months'|'all'|'range', start?, end? }
//  ============================================================
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// 날짜 범위 계산
function resolveRange(dateFilter) {
  const mode = (dateFilter && dateFilter.mode) || '6months';
  let start = null, end = null;
  if (mode === '6months') {
    start = new Date(); start.setMonth(start.getMonth() - 6);
  } else if (mode === 'range') {
    if (dateFilter.start) start = new Date(dateFilter.start);
    if (dateFilter.end) { end = new Date(dateFilter.end); end.setHours(23, 59, 59); }
  }
  return { start, end };
}

function inRange(date, start, end) {
  if (!date) return true;
  if (start && date < start) return false;
  if (end && date > end) return false;
  return true;
}

// 메일 하나를 표준 객체로 변환
function mapEmail(email, folderName, pstPath) {
  const received = email.messageDeliveryTime || email.clientSubmitTime || null;
  // entryId 대용: PST경로+제목+시간 해시 (직접 파싱은 EntryID가 COM과 다름)
  const idSource = `${pstPath}|${folderName}|${email.subject || ''}|${received ? received.toISOString() : ''}`;
  const entryId = 'pst:' + crypto.createHash('md5').update(idSource).digest('hex');
  const body = email.body || '';
  return {
    entryId,
    _pstPath: pstPath,
    _descriptorIndex: email.descriptorNodeId, // 첨부 재접근용
    subject: email.subject || '',
    sender: email.senderName || email.senderEmailAddress || '',
    senderMail: email.senderEmailAddress || '',
    to: email.displayTo || '',
    cc: email.displayCC || '',
    received: received ? formatDate(received) : '',
    receivedRaw: received ? received.toISOString() : '',
    folder: folderName,
    hasAttach: email.hasAttachments || (email.numberOfAttachments > 0),
    attachCount: email.numberOfAttachments || 0,
    preview: body.slice(0, 400),
    body,
    unread: email.isRead === false
  };
}

function formatDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 폴더 재귀 순회
function walkFolder(folder, folderName, opts, out) {
  const { start, end, query, limit } = opts;
  // 이메일 처리
  if (folder.contentCount > 0) {
    let email = folder.getNextChild();
    while (email != null) {
      if (out.count >= limit) return;
      try {
        const received = email.messageDeliveryTime || email.clientSubmitTime || null;
        if (inRange(received, start, end)) {
          const mapped = mapEmail(email, folderName, opts.pstPath);
          let match = true;
          if (query) {
            const hay = (mapped.subject + ' ' + mapped.sender + ' ' + mapped.to + ' ' + mapped.preview).toLowerCase();
            match = hay.includes(query.toLowerCase());
          }
          if (match) { out.list.push(mapped); out.count++; }
        }
      } catch (_) { /* 개별 메일 오류 무시 */ }
      email = folder.getNextChild();
    }
  }
  // 하위 폴더 재귀
  if (folder.hasSubfolders) {
    const subs = folder.getSubFolders();
    for (const sub of subs) {
      if (out.count >= limit) return;
      walkFolder(sub, `${folderName}/${sub.displayName}`, opts, out);
    }
  }
}

// ------------------------------------------------------------
//  메일 검색 (PST 직접)
// ------------------------------------------------------------
async function searchMails(pstPath, query, limit = 50, dateFilter = { mode: '6months' }) {
  if (!pstPath || !fs.existsSync(pstPath)) {
    throw new Error('PST 파일을 찾을 수 없습니다: ' + pstPath);
  }
  const { PSTFile } = require('pst-extractor');
  const pstFile = new PSTFile(pstPath);
  const root = pstFile.getRootFolder();

  const { start, end } = resolveRange(dateFilter);
  const out = { list: [], count: 0 };
  walkFolder(root, '', {
    start, end,
    query: String(query || '').trim(),
    limit,
    pstPath
  }, out);

  // 최신순 정렬
  out.list.sort((a, b) => (b.receivedRaw || '').localeCompare(a.receivedRaw || ''));
  return out.list;
}

// ------------------------------------------------------------
//  특정 메일 상세 + 첨부 저장 (entryId 해시로 재탐색)
// ------------------------------------------------------------
async function getMailDetailAndAttachments(pstPath, entryId, saveAttach = false) {
  if (!pstPath || !fs.existsSync(pstPath)) throw new Error('PST 파일 없음: ' + pstPath);
  const { PSTFile } = require('pst-extractor');
  const pstFile = new PSTFile(pstPath);
  const root = pstFile.getRootFolder();

  let found = null;
  const search = (folder, folderName) => {
    if (found) return;
    if (folder.contentCount > 0) {
      let email = folder.getNextChild();
      while (email != null && !found) {
        const mapped = mapEmail(email, folderName, pstPath);
        if (mapped.entryId === entryId) { found = { email, mapped }; return; }
        email = folder.getNextChild();
      }
    }
    if (folder.hasSubfolders && !found) {
      for (const sub of folder.getSubFolders()) {
        if (found) break;
        search(sub, `${folderName}/${sub.displayName}`);
      }
    }
  };
  search(root, '');

  if (!found) throw new Error('해당 메일을 PST에서 찾지 못했습니다.');

  const { email, mapped } = found;
  const attachments = [];
  const savedPaths = [];

  const numAtt = email.numberOfAttachments || 0;
  for (let i = 0; i < numAtt; i++) {
    try {
      const att = email.getAttachment(i);
      const fname = att.longFilename || att.filename || `attachment_${i}`;
      attachments.push({ name: fname, size: att.filesize || 0 });
      if (saveAttach) {
        const tmpDir = path.join(os.tmpdir(), 'outlook-ai-attach', Date.now().toString());
        fs.mkdirSync(tmpDir, { recursive: true });
        const outPath = path.join(tmpDir, fname);
        const stream = att.fileInputStream;
        if (stream) {
          const chunkSize = 8176;
          const buf = Buffer.alloc(chunkSize);
          const fd = fs.openSync(outPath, 'w');
          let bytesRead = stream.read(buf);
          while (bytesRead > 0) {
            fs.writeSync(fd, buf, 0, bytesRead);
            bytesRead = stream.read(buf);
          }
          fs.closeSync(fd);
          savedPaths.push(outPath);
        }
      }
    } catch (_) { /* 개별 첨부 오류 무시 */ }
  }

  mapped.attachments = attachments;
  return { mail: mapped, savedPaths };
}

module.exports = { searchMails, getMailDetailAndAttachments };
