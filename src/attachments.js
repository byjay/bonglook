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
    const pdfParse = require('pdf-parse');
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    return {
      type: 'pdf',
      sizeKB,
      pages: data.numpages,
      text: truncate(data.text, 20000)
    };
  }

  // -------- 엑셀 / CSV --------
  if (ext === '.xlsx' || ext === '.xls' || ext === '.csv') {
    const XLSX = require('xlsx');
    const wb = XLSX.readFile(filePath);
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
    text: `[지원하지 않는 형식: ${name}] 텍스트 추출을 건너뜁니다.`
  };
}

function truncate(str, max) {
  if (!str) return '';
  if (str.length <= max) return str;
  return str.slice(0, max) + `\n...[내용이 길어 ${max}자까지만 표시됨]`;
}

module.exports = { extract };
