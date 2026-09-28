// ============================================================
//  attach-content.js — 첨부 '내용'을 분석 프롬프트에 넣기 위한 단일 진입점
//  ------------------------------------------------------------
//  단일 책임: 메일 1건의 "진짜 첨부"(attach-classify 기준) 중 문서류(PDF·XLSX/CSV·
//  DOCX·TXT)를 캐시 우선으로 추출해, 분석·대화 프롬프트에 넣을 수 있는 텍스트
//  블록과 UI 칩(반영/미지원 표시)을 만든다.
//   · 이미지(PNG/JPG 등)는 여기서 다루지 않는다 — 2단계(비전) 별도 모듈.
//   · 저장본이 없으면 main.js 가 넘겨준 fetchMissingFn(Outlook COM 첨부 복사, 읽기전용)
//     으로 1회 확보한다. MailItem 은 절대 바꾸지 않는다(첨부 복사만).
//   · 같은 첨부는 재추출하지 않는다 — db.attachments.extract_at 이 캐시 신호.
// ============================================================
const fs = require('fs');
const path = require('path');
const db = require('./db');
const attachments = require('./attachments');
const attachClassify = require('./attach-classify');
const attachVision = require('./attach-vision');   // 이미지 첨부 무료 비전 분석(2단계)

const PER_ATTACH_BUDGET_CHARS = 3000;     // 첨부 1건이 프롬프트에 들어갈 수 있는 상한
const TOTAL_BUDGET_CHARS = 9000;          // 메일 1건 전체 첨부 내용 상한(제공자 컨텍스트에 비례해 조절 가능)
const MAX_DOC_ATTACHMENTS = 5;            // 문서형 첨부는 최대 5건까지만 시도(토큰·시간 방어)
const MAX_IMAGE_ATTACHMENTS = 3;          // 비전 호출은 첨부당 API 요청이라 더 보수적으로 제한

// 이 모듈이 다루는 '문서류' 확장자 — 나머지(이미지·CAD·압축 등)는 여기서 건드리지 않는다.
const DOC_EXT_PRIORITY = ['pdf', 'docx', 'xlsx', 'xls', 'csv', 'txt', 'md', 'json', 'log'];
const DOC_EXT_SET = new Set(DOC_EXT_PRIORITY);

function extOfRow(row) {
  return (row.ext || attachClassify.extOf(row.file_name) || '').toLowerCase();
}

// 캐시가 있으면 그대로, 없으면 추출 시도 후 db 에 기록한다(성공/실패 모두 extract_at 을 채움).
async function ensureExtracted(row) {
  if (row.extract_at) return row;   // ★ 캐시 hit — 재추출 금지
  const ext = extOfRow(row);
  if (!row.saved_path || !fs.existsSync(row.saved_path)) {
    db.updateAttachmentExtract(row.id, { extracted: '', kind: 'missing', failed: '로컬 저장본 없음(가져오기 실패)' });
    return db.getAttachmentById(row.id);
  }
  try {
    const ex = await attachments.extract(row.saved_path);
    const text = ex.text || '';
    db.updateAttachmentExtract(row.id, {
      extracted: text, kind: ex.type || ext, pages: ex.pages || null,
      fullLen: text.length, failed: ex.extractFailed || null
    });
  } catch (e) {
    db.updateAttachmentExtract(row.id, { extracted: '', kind: 'error', failed: `추출 오류: ${String(e.message || e).slice(0, 200)}` });
  }
  return db.getAttachmentById(row.id);
}

// 이미지 1건을 무료 비전 체인으로 설명하고 db 에 캐시한다(문서와 같은 extract_at 캐시 신호 재사용).
async function ensureImageDescribed(row, visionKeys) {
  if (row.extract_at) return row;   // ★ 캐시 hit — 재호출 금지(API 비용·시간 방어)
  if (!row.saved_path || !fs.existsSync(row.saved_path)) {
    db.updateAttachmentExtract(row.id, { extracted: '', kind: 'missing', failed: '로컬 저장본 없음(가져오기 실패)' });
    return db.getAttachmentById(row.id);
  }
  try {
    const ex = await attachments.extract(row.saved_path);   // dataUrl(base64) 생성
    const vis = await attachVision.describeImage({ keys: visionKeys, dataUrl: ex.dataUrl, fileName: row.file_name });
    if (vis.ok) {
      db.updateAttachmentExtract(row.id, { extracted: vis.text, kind: 'image-vision', fullLen: vis.text.length, failed: null });
    } else {
      db.updateAttachmentExtract(row.id, { extracted: '', kind: 'image-vision', failed: vis.error || '이미지 분석 불가(무료 비전 모델 응답 없음)' });
    }
  } catch (e) {
    db.updateAttachmentExtract(row.id, { extracted: '', kind: 'error', failed: `비전 분석 오류: ${String(e.message || e).slice(0, 200)}` });
  }
  return db.getAttachmentById(row.id);
}

// ------------------------------------------------------------
//  메일 1건의 첨부 내용 컨텍스트를 만든다.
//   mail: db.getMailById() 결과 (id 필요)
//   opts.fetchMissingFn: async () => void — 저장본이 하나도 없을 때 1회 호출(Outlook 복사)
//   opts.visionKeys: string[] — 주어지면 이미지 첨부도 비전 체인으로 설명해 함께 주입(2단계).
//     없으면(기본) 이미지는 예전처럼 "별도 비전 분석 대상" 칩만 표시하고 API 호출은 하지 않는다.
//  반환: { text, chips, imageRows }
//   text  : 프롬프트에 그대로 넣을 "[첨부 내용]" 블록 문자열(내용이 없으면 '')
//   chips : UI 표시용 [{ name, kind, ok, note }]
// ------------------------------------------------------------
async function buildAttachmentContext(mail, { fetchMissingFn = null, visionKeys = null } = {}) {
  if (!mail || !mail.id) return { text: '', chips: [], imageRows: [] };
  let rows = db.getAttachmentsByMail(mail.id);   // 기본이 '진짜 첨부만'
  const expected = Number(mail.real_attach_count != null ? mail.real_attach_count : mail.attach_count) || 0;
  if (!rows.length && expected > 0 && typeof fetchMissingFn === 'function') {
    try { await fetchMissingFn(); } catch (_) { /* 실패해도 아래에서 "저장본 없음"으로 정직하게 표시됨 */ }
    rows = db.getAttachmentsByMail(mail.id);
  }
  if (!rows.length) return { text: '', chips: [], imageRows: [] };

  const imageRows = rows.filter(r => attachClassify.IMAGE_EXT.has(extOfRow(r)));
  const docRows = rows.filter(r => DOC_EXT_SET.has(extOfRow(r)));
  const otherRows = rows.filter(r => !DOC_EXT_SET.has(extOfRow(r)) && !attachClassify.IMAGE_EXT.has(extOfRow(r)));

  docRows.sort((a, b) => DOC_EXT_PRIORITY.indexOf(extOfRow(a)) - DOC_EXT_PRIORITY.indexOf(extOfRow(b)));
  const targets = docRows.slice(0, MAX_DOC_ATTACHMENTS);

  const chips = [];
  const blocks = [];
  let remaining = TOTAL_BUDGET_CHARS;

  for (const row0 of targets) {
    const row = await ensureExtracted(row0);
    if (row.extract_failed) {
      chips.push({ name: row.file_name, kind: row.extract_kind || extOfRow(row), ok: false, note: row.extract_failed });
      blocks.push(`— ${row.file_name} : ${row.extract_failed}`);
      continue;
    }
    const full = row.extracted || '';
    if (!full.trim()) {
      chips.push({ name: row.file_name, kind: row.extract_kind || extOfRow(row), ok: false, note: '텍스트 없음' });
      blocks.push(`— ${row.file_name} : 텍스트 없음`);
      continue;
    }
    const cap = Math.max(0, Math.min(PER_ATTACH_BUDGET_CHARS, remaining));
    if (cap === 0) {
      chips.push({ name: row.file_name, kind: row.extract_kind, ok: false, note: '전체 첨부 예산 초과로 미반영' });
      continue;
    }
    const fullLen = row.extract_full_len || full.length;
    const used = Math.min(cap, full.length);
    const content = full.slice(0, used);
    remaining -= used;
    const truncated = used < fullLen;
    const note = truncated ? `첨부 ${fullLen}자 중 ${used}자 반영` : `${used}자 반영`;
    chips.push({ name: row.file_name, kind: row.extract_kind, ok: true, note });
    blocks.push(`— ${row.file_name} (${row.extract_kind}${row.extract_pages ? `, ${row.extract_pages}p` : ''}, ${note}):\n${content}`);
  }

  for (const row of otherRows) {
    const ext = extOfRow(row);
    chips.push({ name: row.file_name, kind: ext, ok: false, note: `미지원 형식(.${ext || '?'})` });
  }

  const hasVisionKeys = Array.isArray(visionKeys) && visionKeys.length > 0;
  const imageTargets = imageRows.slice(0, MAX_IMAGE_ATTACHMENTS);
  for (const row0 of imageRows) {
    if (!hasVisionKeys || !imageTargets.includes(row0)) {
      chips.push({ name: row0.file_name, kind: 'image', ok: null, note: '이미지(별도 비전 분석 대상)' });
      continue;
    }
    const row = await ensureImageDescribed(row0, visionKeys);
    if (row.extract_failed || !row.extracted) {
      chips.push({ name: row.file_name, kind: 'image', ok: false, note: row.extract_failed || '이미지 분석 불가(무료 비전 모델 응답 없음)' });
      continue;
    }
    const cap = Math.max(0, Math.min(PER_ATTACH_BUDGET_CHARS, remaining));
    if (cap === 0) {
      chips.push({ name: row.file_name, kind: 'image', ok: false, note: '전체 첨부 예산 초과로 미반영' });
      continue;
    }
    const content = row.extracted.slice(0, cap);
    remaining -= content.length;
    chips.push({ name: row.file_name, kind: 'image', ok: true, note: '비전 분석 반영' });
    blocks.push(`— ${row.file_name} (이미지, 비전 분석):\n${content}`);
  }

  const text = blocks.length ? ['', '[첨부 내용]', blocks.join('\n\n')].join('\n') : '';
  return { text, chips, imageRows };
}

module.exports = { buildAttachmentContext, ensureExtracted, ensureImageDescribed, DOC_EXT_SET, PER_ATTACH_BUDGET_CHARS, TOTAL_BUDGET_CHARS, MAX_IMAGE_ATTACHMENTS };

// ============================================================
//  셀프체크 — `node src/attach-content.js`  (better-sqlite3 필요 → Electron 노드로 실행)
//  ------------------------------------------------------------
//  격리된 임시 DB(better-sqlite3)에 가짜 메일+첨부 1건을 넣고:
//   1) 캐시 미스 → 실제 추출 → 프롬프트 블록 텍스트에 내용이 들어가는지(뮤테이션 증명의 핵심:
//      DOC_EXT_SET 에서 그 확장자를 빼면 이 assert 가 FAIL 한다 — "주입을 끄면 FAIL")
//   2) 예산 초과 시 "N자 중 M자 반영" 정직 표시
//   3) 캐시 hit → 저장 파일을 지워도(원본 사라짐) 재추출 시도 없이 이전 결과를 그대로 재사용
//   4) 미지원 확장자는 지어내지 않고 정직하게 실패 칩으로 표시
// ============================================================
if (require.main === module) {
  (async () => {
    const os = require('os');
    const assert = require('assert');
    const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'bmail-attctx-'));
    let pass = 0;
    try {
      db.init(tmpUserData);
      db.upsertMailsBatch([{ entryId: 'selftest-1', subject: '테스트 메일', realAttachCount: 1, attachCount: 1 }]);
      const mail = db.getMailByEntryId('selftest-1');
      assert.ok(mail && mail.id, '테스트 메일 생성 실패');

      const filePath = path.join(tmpUserData, 'report.txt');
      const fullText = '핵심수치: 1234만원\n' + 'X'.repeat(5000);   // PER_ATTACH_BUDGET_CHARS(3000) 초과
      fs.writeFileSync(filePath, fullText, 'utf8');
      db.addAttachment(mail.id, { fileName: 'report.txt', sizeKB: 5, savedPath: filePath, isInline: false });

      // 1) 최초 호출 — 실제 추출 + 프롬프트 블록에 내용 반영 (뮤테이션 증명: DOC_EXT_SET 에서
      //    'txt' 를 빼면 아래 두 assert 가 즉시 FAIL 한다 = "주입을 끄면 FAIL")
      const ctx1 = await buildAttachmentContext(mail);
      assert.ok(ctx1.text.includes('[첨부 내용]'), '첨부 내용 블록이 프롬프트에 주입되지 않음'); pass++;
      assert.ok(ctx1.text.includes('핵심수치: 1234만원'), '첨부 실제 내용이 프롬프트에 없음(지어내기/누락)'); pass++;
      assert.strictEqual(ctx1.chips.length, 1); pass++;
      assert.strictEqual(ctx1.chips[0].ok, true); pass++;
      assert.ok(/자 중 \d+자 반영/.test(ctx1.chips[0].note), '예산 초과 시 "N자 중 M자 반영" 표시 누락'); pass++;

      const row1 = db.getAttachmentsByMail(mail.id)[0];
      assert.ok(row1.extract_at, '캐시(extract_at)가 기록되지 않음'); pass++;

      // 2) 저장 파일을 삭제해도(원본 사라짐) 캐시가 있으면 재추출 시도를 안 한다
      //    → 재추출을 시도했다면 'missing'/실패로 바뀌어야 하는데, 그대로면 캐시가 쓰인 것.
      fs.unlinkSync(filePath);
      const ctx2 = await buildAttachmentContext(mail);
      assert.strictEqual(ctx2.chips[0].note, ctx1.chips[0].note, '캐시가 있는데도 재추출을 시도함(원본 삭제 후 결과가 바뀜)'); pass++;
      assert.strictEqual(ctx2.chips[0].ok, true, '캐시 hit 인데 실패로 바뀜(재추출 발생 증거)'); pass++;

      // 3) 미지원 확장자 — 지어내지 않고 정직하게 실패 칩
      db.upsertMailsBatch([{ entryId: 'selftest-2', subject: '도면 메일', realAttachCount: 1, attachCount: 1 }]);
      const mail2 = db.getMailByEntryId('selftest-2');
      const dwgPath = path.join(tmpUserData, 'plan.dwg');
      fs.writeFileSync(dwgPath, 'stub', 'utf8');
      db.addAttachment(mail2.id, { fileName: 'plan.dwg', sizeKB: 1, savedPath: dwgPath, isInline: false });
      const ctx3 = await buildAttachmentContext(mail2);
      assert.strictEqual(ctx3.text, '', 'DWG(미지원)인데 내용 블록이 생김'); pass++;
      assert.strictEqual(ctx3.chips[0].ok, false); pass++;
      assert.ok(/미지원 형식/.test(ctx3.chips[0].note)); pass++;

      // 5) 이미지 첨부(2단계 비전) — visionKeys 없으면 API 호출 없이 안내 칩만(네트워크 비용 방어)
      db.upsertMailsBatch([{ entryId: 'selftest-3', subject: '사진 메일', realAttachCount: 1, attachCount: 1 }]);
      const mail3 = db.getMailByEntryId('selftest-3');
      const imgPath = path.join(tmpUserData, 'photo.png');
      fs.writeFileSync(imgPath, Buffer.from('89504e470d0a1a0a', 'hex'));   // PNG 헤더만(실디코딩 불필요, base64 인코딩만 확인)
      db.addAttachment(mail3.id, { fileName: 'photo.png', sizeKB: 1, savedPath: imgPath, isInline: false });
      const ctxNoVision = await buildAttachmentContext(mail3);
      assert.strictEqual(ctxNoVision.chips[0].ok, null); pass++;
      assert.ok(/비전 분석 대상/.test(ctxNoVision.chips[0].note)); pass++;

      // visionKeys 있으면 attachVision.describeImage 를 통해 결과를 주입한다(네트워크 없이 모듈 스텁으로 검증)
      const realDescribe = attachVision.describeImage;
      let describeCalls = 0;
      attachVision.describeImage = async () => { describeCalls++; return { ok: true, model: 'stub/vision', text: '엔진 사진: 호스와 밸브가 보임' }; };
      try {
        const ctxVision1 = await buildAttachmentContext(mail3, { visionKeys: ['k'] });
        assert.strictEqual(ctxVision1.chips[0].ok, true); pass++;
        assert.ok(ctxVision1.text.includes('엔진 사진: 호스와 밸브가 보임'), '비전 요약이 프롬프트에 주입되지 않음'); pass++;
        assert.strictEqual(describeCalls, 1); pass++;

        // 캐시 hit — 2차 호출은 describeImage 를 다시 부르지 않는다(비용 방어)
        const ctxVision2 = await buildAttachmentContext(mail3, { visionKeys: ['k'] });
        assert.strictEqual(describeCalls, 1, '이미지 비전 캐시가 있는데도 재호출함'); pass++;
        assert.strictEqual(ctxVision2.chips[0].note, ctxVision1.chips[0].note); pass++;
      } finally {
        attachVision.describeImage = realDescribe;
      }

      // 전부 실패 시 정직한 실패 표시(거짓 성공 금지) — 새 이미지로 캐시 미스 상태에서 검증
      db.upsertMailsBatch([{ entryId: 'selftest-4', subject: '사진 메일2', realAttachCount: 1, attachCount: 1 }]);
      const mail4 = db.getMailByEntryId('selftest-4');
      const imgPath2 = path.join(tmpUserData, 'photo2.png');
      fs.writeFileSync(imgPath2, Buffer.from('89504e470d0a1a0a', 'hex'));
      db.addAttachment(mail4.id, { fileName: 'photo2.png', sizeKB: 1, savedPath: imgPath2, isInline: false });
      const realDescribe2 = attachVision.describeImage;
      attachVision.describeImage = async () => ({ ok: false, error: '이미지 분석 불가(무료 비전 모델 응답 없음)' });
      try {
        const ctxFail = await buildAttachmentContext(mail4, { visionKeys: ['k'] });
        assert.strictEqual(ctxFail.chips[0].ok, false); pass++;
        assert.ok(/이미지 분석 불가/.test(ctxFail.chips[0].note)); pass++;
        assert.strictEqual(ctxFail.text, '', '전부 실패했는데 내용 블록이 생김(지어내기 금지 위반)'); pass++;
      } finally {
        attachVision.describeImage = realDescribe2;
      }

      console.log(`attach-content.js 셀프체크 OK — ${pass}건 통과(주입·예산표시·재추출금지 캐시·미지원 정직표시·비전 주입/캐시/실패표시)`);
    } finally {
      try { db.close(); } catch (_) {}
      try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (_) {}
    }
  })().catch((e) => { console.error('attach-content.js 셀프체크 FAIL:', e.message); process.exit(1); });
}
