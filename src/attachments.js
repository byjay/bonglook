// ============================================================
//  attachments.js - 첨부파일 텍스트/데이터 추출
//  지원: PDF, 엑셀(xlsx/xls/csv), 워드(docx), 이미지, 텍스트
//  - PDF   : pdf-parse 로 텍스트 추출
//  - 엑셀  : xlsx 로 시트별 표 데이터 → 텍스트/CSV 변환
//  - 워드  : mammoth 로 텍스트 추출
//  - 이미지: base64 로 인코딩 (Cerebras 비전 모델용 or 메타정보)
//  - 텍스트: 그대로 읽음
// ============================================================
const fs = require('fs');
const path = require('path');

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'];

async function extract(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath);
  const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
  const sizeKB = stat ? Math.round(stat.size / 1024) : 0;

  // -------- PDF --------
  if (ext === '.pdf') {
    const buffer = fs.readFileSync(filePath);
    // 1차: pdf-parse (빠름). 실패 시 2차: pdfjs-dist (견고, Mozilla 공식)
    let text = '', pages = 0;
    try {
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(buffer);
      if (data && data.text && data.text.trim().length > 0) {
        text = data.text; pages = data.numpages;
      } else {
        throw new Error('empty text');   // 텍스트가 비면 폴백
      }
    } catch (e1) {
      // 2차: pdfjs-dist
      try {
        const result = await extractPdfWithPdfjs(buffer);
        text = result.text || ''; pages = result.pages || 0;
      } catch (e2) {
        return { type: 'pdf', sizeKB, pages: 0, text: '', extractFailed: `PDF 추출 실패: ${String(e2.message || e2).slice(0, 200)}` };
      }
    }
    // 공백 제외 20자 미만이면 '텍스트가 있는 PDF'로 보기 어렵다(스캔·도면 이미지 PDF) — 지어내지 않고 정직하게 표시.
    if (text.replace(/\s+/g, '').length < 20) {
      return { type: 'pdf', sizeKB, pages, text: '', extractFailed: '텍스트 없음(스캔/도면 추정)' };
    }
    return { type: 'pdf', sizeKB, pages, text: truncate(text, 20000) };
  }

  // -------- 엑셀 / CSV --------
  if (ext === '.xlsx' || ext === '.xls' || ext === '.csv') {
    const XLSX = require('xlsx');
    let wb;
    if (ext === '.csv') {
      // CSV는 UTF-8 텍스트로 직접 읽어 인코딩 깨짐 방지 (BOM 제거)
      let raw = fs.readFileSync(filePath, 'utf8');
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
      wb = XLSX.read(raw, { type: 'string', codepage: 65001 });
    } else {
      // 엑셀 바이너리
      wb = XLSX.read(fs.readFileSync(filePath), { type: 'buffer', codepage: 65001 });
    }
    let out = '';
    const sheetsInfo = [];
    for (const sheetName of wb.SheetNames) {
      const ws = wb.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(ws);
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
      sheetsInfo.push({ name: sheetName, rows: rows.length });
      out += `\n===== 시트: ${sheetName} (행 ${rows.length}) =====\n${csv}\n`;
    }
    return {
      type: 'excel',
      sizeKB,
      sheets: sheetsInfo,
      text: truncate(out, 20000)
    };
  }

  // -------- 워드 --------
  if (ext === '.docx') {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ path: filePath });
    return {
      type: 'word',
      sizeKB,
      text: truncate(result.value, 20000)
    };
  }

  // -------- 이미지 --------
  if (IMAGE_EXTS.includes(ext)) {
    const buffer = fs.readFileSync(filePath);
    const b64 = buffer.toString('base64');
    const mime = ext === '.png' ? 'image/png'
      : (ext === '.gif' ? 'image/gif'
        : (ext === '.webp' ? 'image/webp'
          : (ext === '.bmp' ? 'image/bmp' : 'image/jpeg')));
    return {
      type: 'image',
      sizeKB,
      mime,
      dataUrl: `data:${mime};base64,${b64}`,
      // 이미지는 텍스트가 없으므로 비전 분석 대상임을 표시
      text: `[이미지 파일: ${name}, ${sizeKB}KB] - 이미지 내용은 AI 비전 분석으로 처리됩니다.`
    };
  }

  // -------- 일반 텍스트 --------
  if (ext === '.txt' || ext === '.md' || ext === '.log' || ext === '.json') {
    const text = fs.readFileSync(filePath, 'utf8');
    return { type: 'text', sizeKB, text: truncate(text, 20000) };
  }

  // -------- 미지원 --------
  return {
    type: 'unknown',
    sizeKB,
    text: '',
    extractFailed: `미지원 형식(.${ext.replace(/^\./, '') || '?'})`
  };
}

// pdfjs-dist 로 PDF 텍스트 추출 (pdf-parse 실패 시 폴백)
// pdfjs-dist v4 는 ESM(.mjs) 이므로 동적 import 사용
async function extractPdfWithPdfjs(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const uint8 = new Uint8Array(buffer);
  const loadingTask = pdfjs.getDocument({
    data: uint8,
    useSystemFonts: true,
    disableFontFace: true,
    isEvalSupported: false
  });
  const pdf = await loadingTask.promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const strings = content.items.map(it => (it.str || ''));
    text += strings.join(' ') + '\n';
  }
  return { text, pages: pdf.numPages };
}

function truncate(str, max) {
  if (!str) return '';
  if (str.length <= max) return str;
  return str.slice(0, max) + `\n...[내용이 길어 ${max}자까지만 표시됨]`;
}

module.exports = { extract };

// ============================================================
//  셀프체크 — `node src/attachments.js`
//  ------------------------------------------------------------
//  실파일 없이도 검증 가능한 것만: 텍스트/CSV 추출·truncate·미지원 형식 정직 표시.
//  PDF 스캔 판정(20자 미만→extractFailed)은 attach-content.js 셀프체크에서 실파일로 재확인한다.
// ============================================================
if (require.main === module) {
  (async () => {
    const os = require('os');
    const assert = require('assert');
    let pass = 0;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmail-att-'));
    try {
      // 1) 텍스트 파일
      const txtPath = path.join(tmpDir, 'note.txt');
      fs.writeFileSync(txtPath, '안녕하세요\n본문 내용입니다.', 'utf8');
      const rTxt = await extract(txtPath);
      assert.strictEqual(rTxt.type, 'text'); pass++;
      assert.ok(rTxt.text.includes('안녕하세요')); pass++;

      // 2) truncate 동작 — 20000자 넘으면 잘리고 안내문이 붙는다
      const bigPath = path.join(tmpDir, 'big.txt');
      fs.writeFileSync(bigPath, 'A'.repeat(25000), 'utf8');
      const rBig = await extract(bigPath);
      assert.ok(rBig.text.length < 25000, 'truncate 가 동작하지 않음'); pass++;
      assert.ok(rBig.text.includes('내용이 길어'), 'truncate 안내문 누락'); pass++;

      // 3) CSV — 시트/행 구조 보존
      const csvPath = path.join(tmpDir, 'sheet.csv');
      fs.writeFileSync(csvPath, '﻿이름,금액\n홍길동,1000\n', 'utf8');
      const rCsv = await extract(csvPath);
      assert.strictEqual(rCsv.type, 'excel'); pass++;
      assert.ok(rCsv.text.includes('홍길동') && rCsv.text.includes('1000'), 'CSV 표 내용 유실'); pass++;

      // 4) 미지원 형식 — 지어내지 않고 정직하게 표시(빈 텍스트 + extractFailed)
      const dwgPath = path.join(tmpDir, 'plan.dwg');
      fs.writeFileSync(dwgPath, 'binary-stub', 'utf8');
      const rDwg = await extract(dwgPath);
      assert.strictEqual(rDwg.type, 'unknown'); pass++;
      assert.strictEqual(rDwg.text, '', '미지원 형식인데 text 를 채움(지어내기 금지 위반)'); pass++;
      assert.ok(/미지원 형식/.test(rDwg.extractFailed), 'extractFailed 사유 누락'); pass++;

      console.log(`attachments.js 셀프체크 OK — ${pass}건 통과(텍스트·truncate·CSV·미지원형식 정직표시)`);
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
  })().catch((e) => { console.error('attachments.js 셀프체크 FAIL:', e.message); process.exit(1); });
}
