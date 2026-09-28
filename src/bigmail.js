// ============================================================
//  bigmail 연동 (대용량 첨부 업로드)
//   ★ 단일 책임: 파일 업로드 + 진행률 통지 + 메일 본문 삽입용 HTML 생성.
//   ★ bigmail 서비스(E:\code-project\bigmail) 코드는 읽기만 했고 수정하지 않는다.
//
//  실측으로 확인한 API (2026-07-30):
//    POST {base}/api/upload   multipart/form-data
//      files       : 파일(복수 가능)  ← 문서에는 files[] 로 적혀 있으나
//                    서버 구현은 fd.getAll('files') 라서 'files' 여야 한다(실측 확인).
//      expireDays  : 1~90 (기본 7)
//      password    : 선택
//      subject     : 선택
//      헤더 X-License-Key : 내부 무제한 슬롯 BM-INT-WEAR-S001~S010
//    응답: { success, id, downloadUrl, files[], totalSize, expiresAt, hasPassword }
//    downloadUrl 은 '요청을 보낸 origin' 기준으로 만들어진다
//    → bigmail.sedms.app 으로 보내면 링크도 sedms.app 이 된다(실측 확인).
// ============================================================
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const DEFAULT_BASE = 'https://bigmail.sedms.app';
const DEFAULT_KEY = 'BM-INT-WEAR-S001';
// Cloudflare Pages Functions 의 요청 본문 한계(서버 소스 주석에 명시).
// 초과분은 서버에 닿기 전에 잘리므로 업로드 전에 막고 안내한다.
const BODY_LIMIT = 100 * 1024 * 1024;

function humanSize(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
}

// multipart 본문을 직접 조립한다(의존성 추가 없이 진행률을 정확히 셀 수 있다).
function buildMultipart(files, fields, boundary) {
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8'));
  }
  for (const f of files) {
    const name = path.basename(f);
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="files"; filename="${name}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`, 'utf8'));
    parts.push(fs.readFileSync(f));
    parts.push(Buffer.from('\r\n', 'utf8'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return Buffer.concat(parts);
}

// ------------------------------------------------------------
//  업로드. onProgress(percent, sentBytes, totalBytes) 로 진행률을 알린다.
// ------------------------------------------------------------
function upload({ files, baseUrl, licenseKey, expireDays = 7, password = '', subject = '', onProgress = () => {} }) {
  return new Promise((resolve) => {
    try {
      const list = (files || []).filter(f => f && fs.existsSync(f));
      if (!list.length) return resolve({ ok: false, error: '업로드할 파일을 선택하세요.' });

      let totalSize = 0;
      const info = list.map(f => {
        const st = fs.statSync(f);
        totalSize += st.size;
        return { name: path.basename(f), size: st.size, path: f };
      });
      if (totalSize > BODY_LIMIT) {
        return resolve({
          ok: false, tooLarge: true, totalSize,
          error: `한 번에 보낼 수 있는 총 용량은 ${humanSize(BODY_LIMIT)} 입니다. ` +
                 `현재 ${humanSize(totalSize)} — 파일을 나눠서 여러 번 올려 주세요.`
        });
      }

      const base = String(baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
      const u = new URL(base + '/api/upload');
      const boundary = '----BmailBoundary' + Date.now().toString(16);
      const body = buildMultipart(list, { expireDays, password, subject }, boundary);
      const mod = u.protocol === 'http:' ? http : https;

      const req = mod.request({
        method: 'POST', hostname: u.hostname, port: u.port || undefined, path: u.pathname,
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
          'X-License-Key': String(licenseKey || DEFAULT_KEY).trim()
        },
        timeout: 15 * 60 * 1000
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const txt = Buffer.concat(chunks).toString('utf8');
          let data = null;
          try { data = JSON.parse(txt); } catch (_) {}
          if (res.statusCode >= 200 && res.statusCode < 300 && data && data.success) {
            onProgress(100, body.length, body.length);
            resolve({ ok: true, ...data, files: data.files || info.map(f => ({ name: f.name, size: f.size })) });
          } else {
            resolve({ ok: false, status: res.statusCode,
              error: (data && data.error) || `업로드 실패 (HTTP ${res.statusCode})` });
          }
        });
      });

      req.on('error', e => resolve({ ok: false, error: `연결 실패: ${e.message}` }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: '업로드 시간이 초과됐습니다. 다시 시도해 주세요.' }); });

      // 진행률: 청크로 나눠 써서 실제 전송량을 센다
      const CHUNK = 256 * 1024;
      let sent = 0;
      const writeNext = () => {
        while (sent < body.length) {
          const end = Math.min(sent + CHUNK, body.length);
          const ok = req.write(body.subarray(sent, end));
          sent = end;
          onProgress(Math.min(99, Math.round((sent / body.length) * 100)), sent, body.length);
          if (!ok) { req.once('drain', writeNext); return; }
        }
        req.end();
      };
      writeNext();
    } catch (e) {
      resolve({ ok: false, error: String(e.message || e) });
    }
  });
}

// ------------------------------------------------------------
//  메일 본문에 넣을 안내 블록 (Outlook 이 안전하게 렌더하는 인라인 스타일 표)
//   대비: 제목 #0b4f8a on #eef6fd 8.0:1 · 본문 #1a1a1a on #fff 17.4:1 → AA 이상
// ------------------------------------------------------------
function buildInsertHtml({ downloadUrl, files = [], totalSize = 0, expiresAt, hasPassword }) {
  const exp = expiresAt ? new Date(expiresAt) : null;
  const expText = exp && !isNaN(exp.getTime())
    ? `${exp.getFullYear()}-${String(exp.getMonth() + 1).padStart(2, '0')}-${String(exp.getDate()).padStart(2, '0')}`
    : '';
  const rows = files.map(f => `
      <tr>
        <td style="padding:3px 10px 3px 0;font-size:10pt;color:#1a1a1a;">${escapeHtml(f.name)}</td>
        <td style="padding:3px 0;font-size:10pt;color:#605e5c;white-space:nowrap;">${humanSize(f.size)}</td>
      </tr>`).join('');

  return `
<div style="border:1px solid #cfe3f5;background:#f8fbff;border-radius:6px;padding:12px 14px;margin:10px 0;font-family:'맑은 고딕','Malgun Gothic',sans-serif;">
  <div style="font-size:10.5pt;font-weight:bold;color:#0b4f8a;margin-bottom:6px;">대용량 파일 전송 (${files.length}개 · ${humanSize(totalSize)})</div>
  <table style="border-collapse:collapse;margin-bottom:8px;">${rows}</table>
  <div style="font-size:10pt;margin-bottom:4px;">
    <a href="${escapeHtml(downloadUrl)}" style="color:#1d4ed8;font-weight:bold;">${escapeHtml(downloadUrl)}</a>
  </div>
  <div style="font-size:9pt;color:#605e5c;">
    ${expText ? `다운로드 기한: ${expText} 까지` : ''}${hasPassword ? ' · 비밀번호 필요' : ''}
  </div>
</div>`.trim();
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

module.exports = { upload, buildInsertHtml, humanSize, DEFAULT_BASE, DEFAULT_KEY, BODY_LIMIT };
