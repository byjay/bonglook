#!/usr/bin/env node
// ============================================================
//  cleanup-worker.mjs — 정리 스캔을 '별도 프로세스'에서 실행
//  ------------------------------------------------------------
//  왜 별도 프로세스인가 (마스터 제약: 메인 앱의 메모리·CPU 영향 0)
//   · 이 프로세스가 쓰는 메모리는 끝나는 즉시 OS 로 전부 반환된다 →
//     메인 앱(Electron)의 RSS 는 스캔을 아무리 돌려도 늘지 않는다. 누수 자체가 성립 불가.
//   · CPU 도 별개 프로세스라 UI 스레드를 막지 않는다. 배치마다 유휴 양보까지 넣는다.
//
//  가드
//   · RSS 상한(기본 400MB)을 넘으면 스캔을 즉시 중단하고 부분 결과를 돌려준다.
//   · 부모가 죽으면 고아로 남지 않도록 부모 PID 를 주기적으로 확인한다.
//
//  입력 : argv[2] = JSON { attachRoot, exportRoot, dbPath, exportKeepDays, apply, rssLimitMb, parentPid }
//  출력 : stdout 마지막 줄에 JSON 한 줄 (RESULT: 접두)
// ============================================================
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cleanup = require(join(ROOT, 'src', 'cleanup.js'));

const opts = JSON.parse(process.argv[2] || '{}');
const RSS_LIMIT = (Number(opts.rssLimitMb) || 400) * 1024 * 1024;
const startRss = process.memoryUsage().rss;
let peakRss = startRss;
let stopReason = '';

function shouldStop() {
  const rss = process.memoryUsage().rss;
  if (rss > peakRss) peakRss = rss;
  if (rss > RSS_LIMIT) { stopReason = `RSS ${(rss / 1048576).toFixed(0)}MB > 상한 ${(RSS_LIMIT / 1048576).toFixed(0)}MB`; return true; }
  // 부모(앱)가 사라졌으면 즉시 종료 — 좀비 프로세스 방지
  if (opts.parentPid) {
    try { process.kill(opts.parentPid, 0); }
    catch { stopReason = '앱이 종료됨'; return true; }
  }
  return false;
}

// DB 에서 '참조 중인 첨부 경로'를 읽는다. 실패하면 아무것도 고아로 보지 않는다(안전측 실패).
function referencedPaths() {
  const set = new Set();
  if (!opts.dbPath) return { set, ok: false, error: 'dbPath 없음' };
  try {
    const Database = require(join(ROOT, 'node_modules', 'better-sqlite3'));
    const db = new Database(opts.dbPath, { readonly: true, fileMustExist: true });
    const stmt = db.prepare("SELECT saved_path FROM attachments WHERE IFNULL(saved_path,'') <> ''");
    for (const r of stmt.iterate()) set.add(cleanup.norm(r.saved_path));
    db.close();
    return { set, ok: true };
  } catch (e) {
    return { set, ok: false, error: String(e.message || e) };
  }
}

(async () => {
  const ref = referencedPaths();
  if (!ref.ok) {
    // 참조 목록을 못 읽으면 '전부 고아'로 오판해 사용자 파일을 지울 수 있다 → 실행 자체를 거부한다.
    console.log('RESULT:' + JSON.stringify({
      ok: false, error: `참조 목록을 읽지 못해 정리를 중단했습니다(안전): ${ref.error}`,
      peakRssMb: Math.round(peakRss / 1048576)
    }));
    process.exit(0);
  }

  const res = await cleanup.scan({
    attachRoot: opts.attachRoot,
    exportRoot: opts.exportRoot,
    referencedPaths: ref.set,
    exportKeepDays: Number(opts.exportKeepDays) || 30,
    apply: opts.apply === true,
    shouldStop
  });

  res.referenced = ref.set.size;
  res.startRssMb = Math.round(startRss / 1048576);
  res.peakRssMb = Math.round(peakRss / 1048576);
  res.endRssMb = Math.round(process.memoryUsage().rss / 1048576);
  res.rssLimitMb = Math.round(RSS_LIMIT / 1048576);
  if (stopReason) res.stopReason = stopReason;
  console.log('RESULT:' + JSON.stringify(res));
  process.exit(0);
})().catch(e => {
  console.log('RESULT:' + JSON.stringify({ ok: false, error: String(e.message || e), peakRssMb: Math.round(peakRss / 1048576) }));
  process.exit(0);
});
