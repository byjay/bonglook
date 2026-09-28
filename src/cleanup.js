// ============================================================
//  cleanup.js — 로컬 저장물 정리 (스캔 = 안전 · 삭제 = 명시 요청 시에만)
//  ------------------------------------------------------------
//  책임 범위(단일 책임): "무엇을 지울 수 있는지 찾아내는 일"과 "지우는 일"만 한다.
//  스케줄·프로세스 관리는 scripts/cleanup-worker.mjs 와 main.js 가 맡는다.
//
//  🔴 안전 규율
//   · 기본 동작은 **dry-run(보고만)**. 실제 삭제는 apply=true 를 넘겼을 때만 한다.
//   · Outlook 원본은 건드리지 않는다. 이 파일이 다루는 건 오직 이 앱이 만든 로컬 사본이다.
//   · DB 행은 '파일이 사라진 껍데기'만 지운다(메일 본문·분석 결과는 절대 안 지운다).
//
//  ⚡ 메모리·CPU 영향 0 제약
//   · 파일 목록을 통째로 배열에 담지 않는다 — 디렉터리를 순회하며 **배치 25건**씩 흘려보낸다.
//   · 배치 사이에 유휴 양보(setImmediate + 지연)를 넣어 CPU 를 붙잡지 않는다.
//   · 호출자가 RSS 상한을 넘기면 즉시 중단할 수 있게 shouldStop 훅을 받는다.
// ============================================================
const fs = require('fs');
const path = require('path');

const BATCH = 25;                       // 한 번에 처리할 건수(스트리밍 단위)
const DEFAULT_IDLE_MS = 40;             // 배치 사이 양보 시간

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 디렉터리를 재귀 순회하며 파일 경로를 하나씩 흘려보낸다(전체 배열 생성 금지).
function* walkFiles(dir, depth = 0) {
  if (depth > 8) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(p, depth + 1);
    else if (e.isFile()) yield p;
  }
}

const norm = (p) => path.resolve(String(p || '')).toLowerCase();

// ------------------------------------------------------------
//  스캔 — 지울 수 있는 것을 분류해서 센다 (기본은 삭제하지 않음)
//  종류
//   orphanFiles : attachments 폴더에 있으나 DB 어디서도 참조하지 않는 파일
//   danglingRows: DB attachments 행은 있으나 실제 파일이 사라진 것
//   oldExports  : 내보내기 폴더의 오래된 산출물(대시보드.html 은 항상 보존)
// ------------------------------------------------------------
async function scan({
  attachRoot, exportRoot, referencedPaths,
  exportKeepDays = 30, apply = false,
  batch = BATCH, idleMs = DEFAULT_IDLE_MS,
  shouldStop = () => false, onProgress = () => {}
} = {}) {
  const started = Date.now();
  const ref = referencedPaths instanceof Set ? referencedPaths : new Set((referencedPaths || []).map(norm));
  const res = {
    ok: true, apply, startedAt: new Date(started).toISOString(),
    scannedFiles: 0,
    orphanFiles: { count: 0, bytes: 0, deleted: 0, samples: [] },
    oldExports: { count: 0, bytes: 0, deleted: 0, samples: [] },
    danglingRows: { count: 0, deleted: 0, samples: [] },
    stopped: false, errors: []
  };

  // ① 첨부 폴더의 고아 파일
  if (attachRoot && fs.existsSync(attachRoot)) {
    let n = 0;
    for (const file of walkFiles(attachRoot)) {
      if (shouldStop()) { res.stopped = true; break; }
      res.scannedFiles++;
      if (!ref.has(norm(file))) {
        let size = 0;
        try { size = fs.statSync(file).size; } catch { }
        res.orphanFiles.count++;
        res.orphanFiles.bytes += size;
        if (res.orphanFiles.samples.length < 10) res.orphanFiles.samples.push({ file, size });
        if (apply) {
          try { fs.unlinkSync(file); res.orphanFiles.deleted++; }
          catch (e) { res.errors.push(`삭제 실패 ${path.basename(file)}: ${e.message}`); }
        }
      }
      if (++n % batch === 0) {                       // 배치마다 이벤트 루프 양보
        onProgress({ phase: 'attachments', scanned: res.scannedFiles, orphans: res.orphanFiles.count });
        await sleep(idleMs);
      }
    }
  }

  // ② 내보내기 폴더의 오래된 산출물 (대시보드는 항상 최신 1장을 유지하므로 제외)
  if (!res.stopped && exportRoot && fs.existsSync(exportRoot)) {
    const cutoff = Date.now() - exportKeepDays * 864e5;
    let n = 0;
    for (const file of walkFiles(exportRoot)) {
      if (shouldStop()) { res.stopped = true; break; }
      const base = path.basename(file);
      if (base === '대시보드.html') continue;                       // 항상 보존
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (st.mtimeMs >= cutoff) continue;
      res.oldExports.count++;
      res.oldExports.bytes += st.size;
      if (res.oldExports.samples.length < 10) res.oldExports.samples.push({ file, size: st.size });
      if (apply) {
        try { fs.unlinkSync(file); res.oldExports.deleted++; }
        catch (e) { res.errors.push(`삭제 실패 ${base}: ${e.message}`); }
      }
      if (++n % batch === 0) { onProgress({ phase: 'exports', old: res.oldExports.count }); await sleep(idleMs); }
    }
  }

  res.durationMs = Date.now() - started;
  return res;
}

// DB 쪽 껍데기 행 정리 — 파일이 사라진 attachments 행만 손댄다.
//  ★ 메일 본문·분석 결과는 절대 건드리지 않는다.
async function scanDanglingRows(dbmod, { apply = false, batch = BATCH, idleMs = DEFAULT_IDLE_MS, shouldStop = () => false } = {}) {
  const out = { count: 0, deleted: 0, samples: [] };
  if (!dbmod || typeof dbmod.attachmentRowsWithPath !== 'function') return out;
  const rows = dbmod.attachmentRowsWithPath();
  for (let i = 0; i < rows.length; i++) {
    if (shouldStop()) break;
    const r = rows[i];
    if (!r.saved_path) continue;
    if (fs.existsSync(r.saved_path)) continue;
    out.count++;
    if (out.samples.length < 10) out.samples.push({ id: r.id, file: r.file_name });
    if (apply && typeof dbmod.clearAttachmentPath === 'function') {
      try { dbmod.clearAttachmentPath(r.id); out.deleted++; } catch { }
    }
    if (i % batch === 0) await sleep(idleMs);
  }
  return out;
}

const humanBytes = (n) => {
  const b = Number(n) || 0;
  if (b < 1024) return `${b}B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)}KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)}MB`;
  return `${(b / 1024 ** 3).toFixed(2)}GB`;
};

module.exports = { scan, scanDanglingRows, walkFiles, humanBytes, BATCH, norm };

// ============================================================
//  셀프체크 — `node src/cleanup.js`
// ============================================================
if (require.main === module) {
  const assert = require('assert');
  const os = require('os');
  (async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmail-clean-'));
    const att = path.join(tmp, 'attachments', 'sub');
    const exp = path.join(tmp, 'export');
    fs.mkdirSync(att, { recursive: true });
    fs.mkdirSync(exp, { recursive: true });

    const keep = path.join(att, '참조중-도면.pdf');
    const orphan1 = path.join(att, '고아-파일1.pdf');
    const orphan2 = path.join(att, '고아-파일2.dwg');
    fs.writeFileSync(keep, 'A'.repeat(100));
    fs.writeFileSync(orphan1, 'B'.repeat(2048));
    fs.writeFileSync(orphan2, 'C'.repeat(1024));

    const dash = path.join(exp, '대시보드.html');
    const oldXls = path.join(exp, '오래된-내보내기.xlsx');
    const newXls = path.join(exp, '최근-내보내기.xlsx');
    fs.writeFileSync(dash, 'x');
    fs.writeFileSync(oldXls, 'y'.repeat(500));
    fs.writeFileSync(newXls, 'z');
    const old = Date.now() - 60 * 864e5;
    fs.utimesSync(oldXls, new Date(old), new Date(old));
    fs.utimesSync(dash, new Date(old), new Date(old));   // 오래돼도 대시보드는 보존돼야 한다

    // ① dry-run: 세기만 하고 절대 지우지 않는다
    const dry = await scan({ attachRoot: path.join(tmp, 'attachments'), exportRoot: exp, referencedPaths: [keep], idleMs: 0 });
    assert.strictEqual(dry.apply, false);
    assert.strictEqual(dry.scannedFiles, 3, `스캔 파일 수 ${dry.scannedFiles}`);
    assert.strictEqual(dry.orphanFiles.count, 2, `고아 ${dry.orphanFiles.count}`);
    assert.strictEqual(dry.orphanFiles.bytes, 3072, `고아 용량 ${dry.orphanFiles.bytes}`);
    assert.strictEqual(dry.orphanFiles.deleted, 0, 'dry-run 인데 삭제됨 — 안전 규율 위반');
    assert.strictEqual(dry.oldExports.count, 1, `오래된 산출물 ${dry.oldExports.count}`);
    assert.ok(fs.existsSync(orphan1) && fs.existsSync(oldXls), 'dry-run 이 파일을 지웠다');

    // ② apply: 참조 중인 파일과 대시보드는 남아야 한다
    const run = await scan({ attachRoot: path.join(tmp, 'attachments'), exportRoot: exp, referencedPaths: [keep], apply: true, idleMs: 0 });
    assert.strictEqual(run.orphanFiles.deleted, 2, `삭제 ${run.orphanFiles.deleted}`);
    assert.strictEqual(run.oldExports.deleted, 1);
    assert.ok(fs.existsSync(keep), '참조 중인 첨부가 지워졌다 — 데이터 손실');
    assert.ok(fs.existsSync(dash), '대시보드가 지워졌다 — 항상 보존이어야 함');
    assert.ok(fs.existsSync(newXls), '최근 산출물이 지워졌다');
    assert.ok(!fs.existsSync(orphan1) && !fs.existsSync(orphan2), '고아가 안 지워졌다');

    // ③ 대소문자·경로 표기가 달라도 '참조 중'으로 인식해야 한다(윈도우 경로 함정)
    const f2 = path.join(att, 'MiXeD.PDF');
    fs.writeFileSync(f2, 'q');
    const mixed = await scan({ attachRoot: path.join(tmp, 'attachments'), referencedPaths: [keep, f2.toUpperCase()], idleMs: 0 });
    assert.strictEqual(mixed.orphanFiles.count, 0, '대소문자 차이로 참조 파일을 고아로 오판 — 데이터 손실 위험');

    // ④ shouldStop 훅이 즉시 멈추는지 (RSS 가드가 이걸로 동작한다)
    for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(att, `f${i}.tmp`), 'x');
    const stopped = await scan({
      attachRoot: path.join(tmp, 'attachments'), referencedPaths: [], idleMs: 0, batch: 5,
      shouldStop: (() => { let n = 0; return () => ++n > 10; })()
    });
    assert.strictEqual(stopped.stopped, true, 'shouldStop 이 동작하지 않음 — 메모리 가드가 무력');
    assert.ok(stopped.scannedFiles <= 12, `중단이 늦다: ${stopped.scannedFiles}건 스캔`);

    // ⑤ 없는 경로에서도 죽지 않아야 한다
    const none = await scan({ attachRoot: path.join(tmp, '없는폴더'), exportRoot: path.join(tmp, '없음'), referencedPaths: [], idleMs: 0 });
    assert.strictEqual(none.ok, true);
    assert.strictEqual(none.scannedFiles, 0);

    assert.strictEqual(humanBytes(0), '0B');
    assert.strictEqual(humanBytes(2048), '2KB');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('cleanup 셀프체크 OK — dry-run 무해성·참조파일 보존·대시보드 보존·대소문자 경로·중단훅·빈경로 통과');
  })().catch(e => { console.error(e); process.exit(1); });
}
