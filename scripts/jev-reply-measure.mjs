#!/usr/bin/env node
// ============================================================
//  jev-reply-measure.mjs — reply_needed 전용 Jev 재측정 (2026-09-30 발주)
//  ------------------------------------------------------------
//  발주서: DB 에서 source='llm' 로 판정된 행 중 seeded shuffle 로 60건(필요/불필요 비율 유지).
//  정답 기준 = 기존 LLM 판정(mails.reply_needed). manual 행이 있으면 그걸 우선 정답으로 쓰고 별도 표기
//  (source='llm' 필터라 이론상 없음 — 방어적으로만 표시).
//
//  Jev 질문: jev-measure2.mjs 의 reply_needed 하이브리드(state B) 방식 재사용(로직 복제 — 원본
//  SoT는 scripts/jev-measure2.mjs, 이 스크립트는 측정 전용 사본이라 프로덕션 중복 금지 원칙 비적용).
//
//  🔴 실DB 읽기전용 — better-sqlite3 readonly 커넥션만 사용, 쓰기 없음.
//  사용: TEMP=E:\tmp TMP=E:\tmp ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/jev-reply-measure.mjs
// ============================================================
import { createRequire } from 'module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const Database = require('better-sqlite3');
const jev = require(join(ROOT, 'src', 'jev.js'));
const jevServer = require(join(ROOT, 'src', 'jev-server.js'));
const actionState = require(join(ROOT, 'src', 'action-state.js'));

// 🔴 마스터 지시(2026-09-30): C: 드라이브 읽기 포함 일체 접근 금지 — E: 실경로만 사용
//   (정션 C:\Users\FREE\AppData\Roaming\outlook-ai-assistant\... 도 금지, 실경로 직접 사용)
const DB_PATH = String.raw`E:\BmailData\outlook-ai-assistant\data\mailstore.db`;
const OUT_DIR = String.raw`E:\tmp\jev-reply`;
const OUT_JSON = join(OUT_DIR, 'jev-reply-measure-result.json');

const fs = require('fs');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const log = (...a) => console.log('[jev-reply-measure]', new Date().toISOString(), ...a);

const SAMPLE_SIZE = 60;

// ---------------------------------------------------------------
//  1) 표본 추출 — source='llm' 풀에서 필요/불필요 비율 유지 seeded shuffle 60건
// ---------------------------------------------------------------
function seededShuffle(arr, seed = 42) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickSample(db) {
  const pool = db.prepare(`
    SELECT id, subject, sender_name, sender_email, recipients, cc, body, preview,
           has_attach, real_attach_count, to_me, action_state, received_at, received_ts, folder,
           reply_needed, reply_needed_confidence, reply_needed_reason, reply_needed_source
    FROM mails
    WHERE reply_needed_source = 'llm'
  `).all();

  if (pool.length === 0) throw new Error('reply_needed_source=llm 행이 0건 — 표본 추출 불가');

  const needed = pool.filter(m => m.reply_needed === 1 || m.reply_needed === true);
  const notneeded = pool.filter(m => !(m.reply_needed === 1 || m.reply_needed === true));
  const ratio = needed.length / pool.length;

  let nNeeded = Math.round(SAMPLE_SIZE * ratio);
  let nNotneeded = SAMPLE_SIZE - nNeeded;
  // 풀 부족 시 가용치로 축소(발주서 §1: 20건 미만이면 보고 금지 — 최대한 60건에 가깝게)
  nNeeded = Math.min(nNeeded, needed.length);
  nNotneeded = Math.min(nNotneeded, notneeded.length);

  const pickedNeeded = seededShuffle(needed, 4242).slice(0, nNeeded);
  const pickedNotneeded = seededShuffle(notneeded, 8484).slice(0, nNotneeded);
  const sample = seededShuffle([...pickedNeeded, ...pickedNotneeded], 1111);

  const attachStmt = db.prepare(`SELECT file_name FROM attachments WHERE mail_id = ? AND is_inline = 0 LIMIT 5`);
  const withAttach = sample.map(m => ({
    ...m,
    attachNames: attachStmt.all(m.id).map(a => a.file_name),
  }));

  log(`풀 ${pool.length}건(필요 ${needed.length}/불필요 ${notneeded.length}, 비율 ${(ratio * 100).toFixed(1)}%) → 표본 ${withAttach.length}건(필요 ${nNeeded}/불필요 ${nNotneeded})`);
  return { sample: withAttach, poolStats: { total: pool.length, needed: needed.length, notneeded: notneeded.length, ratio } };
}

// ---------------------------------------------------------------
//  2) 하이브리드 state(B) — jev-measure2.mjs buildStateB 재사용(로직 복제, SoT: jev-measure2.mjs)
// ---------------------------------------------------------------
function buildStateB(m) {
  const role = m.to_me === 1 ? 'To (direct recipient)' : (m.to_me === 0 ? 'CC (carbon copy)' : 'unknown');
  const text = `${m.subject || ''}\n${(m.body || m.preview || '').slice(0, 1500)}`;
  const requestDetected = actionState.REQUEST_RE.test(text) ? 'yes' : 'no';
  const informOnly = actionState.INFORM_RE.test(text) ? 'yes' : 'no';
  const isReplyThread = /^\s*RE\s*[:：]/i.test(m.subject || '') ? 'yes' : 'no';
  const attachCount = m.attachNames.length;
  const attachTypes = m.attachNames.length
    ? [...new Set(m.attachNames.map(n => (String(n).split('.').pop() || '').toLowerCase()).filter(Boolean))].join(',')
    : 'none';
  const orgDomain = String(m.sender_email || '').split('@')[1] || 'unknown';
  const bodyText = (m.body || m.preview || '').slice(0, 800);
  return [
    `Subject: ${m.subject || '(제목 없음)'}`,
    `From: ${m.sender_name || ''} <${m.sender_email || ''}> (org: ${orgDomain})`,
    `Recipient role (To/CC): ${role}`,
    `Request phrase detected: ${requestDetected}`,
    `Informational-only phrase detected: ${informOnly}`,
    `Is reply thread (subject starts with RE:): ${isReplyThread}`,
    `Real attachments: count=${attachCount}, types=${attachTypes}`,
    `Body: ${bodyText}`,
  ].join('\n');
}

const QUESTIONS = {
  reply_needed: {
    type: 'noul',
    instructions: 'Does THIS specific recipient need to personally reply to this email? Answer false if this is CC-only with no direct request, if the thread already shows a reply, or if it is purely informational.',
  },
};

// ---------------------------------------------------------------
//  3) 메인
// ---------------------------------------------------------------
async function main() {
  const db = new Database(DB_PATH, { readonly: true });
  const { sample, poolStats } = pickSample(db);

  const manualOverrides = sample.filter(m => m.reply_needed_source === 'manual');
  if (manualOverrides.length) log(`⚠ manual 표기 ${manualOverrides.length}건 발견(source='llm' 필터인데도) — 정답기준 manual 우선 적용`);

  const vramBefore = await jevServer.freeVramMb();
  log(`측정 시작 전 여유 VRAM: ${vramBefore}MB`);

  const rows = [];
  const latencies = [];
  let modeUsed = null;
  for (let i = 0; i < sample.length; i++) {
    const m = sample[i];
    const state = buildStateB(m);
    const t0 = Date.now();
    const jr = await jev.decide({ state, questions: QUESTIONS });
    const latencyMs = Date.now() - t0;
    latencies.push(latencyMs);
    if (jr.ok) {
      modeUsed = jr.mode || modeUsed;
      log(`(${i + 1}/${sample.length}) mail#${m.id} ok p=${jr.answers.reply_needed?.probability?.toFixed(3)} decision=${jr.answers.reply_needed?.decision} mode=${jr.mode} ${latencyMs}ms`);
    } else {
      log(`(${i + 1}/${sample.length}) mail#${m.id} ⚠ Jev 실패: ${jr.error}`);
    }

    const groundTruth = m.reply_needed_source === 'manual' ? !!m.reply_needed : !!m.reply_needed;
    const truthSource = m.reply_needed_source;

    rows.push({
      id: m.id, subject: String(m.subject || '').slice(0, 60),
      groundTruth, truthSource,
      jev: jr.ok ? {
        ok: true,
        p: jr.answers.reply_needed?.probability,
        decision: jr.answers.reply_needed?.decision,
        label: jr.answers.reply_needed?.noul >= 0.5,
        mode: jr.mode,
      } : { ok: false, error: jr.error },
      latencyMs,
    });
  }

  await jevServer.shutdown();
  const vramAfterShutdown = await jevServer.freeVramMb();
  log(`측정 종료 — 서버 종료. VRAM 시작 ${vramBefore}MB → 종료후 ${vramAfterShutdown}MB, 사용모드=${modeUsed}`);

  // ---- 집계 ----
  const total = rows.length;
  const jevOk = rows.filter(r => r.jev.ok);
  const jevFail = rows.filter(r => !r.jev.ok);

  const buckets = {
    ge090: jevOk.filter(r => r.jev.p >= 0.90),
    b070_090: jevOk.filter(r => r.jev.p >= 0.70 && r.jev.p < 0.90),
    lt070: jevOk.filter(r => r.jev.p < 0.70),
  };
  const matchCount = (arr) => arr.filter(r => r.jev.label === r.groundTruth).length;
  const pct = (a, b) => (b ? (100 * a / b) : null);

  const ge090Match = matchCount(buckets.ge090);
  const b070_090Match = matchCount(buckets.b070_090);
  const lt070Match = matchCount(buckets.lt070);
  const overallMatch = matchCount(jevOk);

  const ge090Rate = pct(ge090Match, buckets.ge090.length);
  const b070_090Rate = pct(b070_090Match, buckets.b070_090.length);
  const overallRate = pct(overallMatch, jevOk.length);
  const fallbackRate = pct(buckets.lt070.length, jevOk.length);

  const avgLatency = latencies.length ? (latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;
  const maxLatency = latencies.length ? Math.max(...latencies) : null;

  // ---- 게이트 판정(발주서 §2) ----
  const gatePass =
    buckets.ge090.length >= 15 && ge090Rate !== null && ge090Rate >= 90 &&
    (b070_090Rate === null || buckets.b070_090.length === 0 || b070_090Rate >= 75);

  const report = {
    poolStats, sampleSize: total, manualOverrides: manualOverrides.length,
    vramBefore, vramAfterShutdown, modeUsed,
    jevOkCount: jevOk.length, jevFailCount: jevFail.length,
    buckets: {
      ge090: { count: buckets.ge090.length, match: ge090Match, rate: ge090Rate },
      b070_090: { count: buckets.b070_090.length, match: b070_090Match, rate: b070_090Rate },
      lt070: { count: buckets.lt070.length, match: lt070Match, rate: pct(lt070Match, buckets.lt070.length) },
    },
    overallRate, fallbackRate, avgLatencyMs: avgLatency, maxLatencyMs: maxLatency,
    gatePass,
    rows,
  };

  console.log('\n========== jev-reply-measure (reply_needed 재측정) 결과 ==========');
  console.log(`풀: source='llm' ${poolStats.total}건 (필요 ${poolStats.needed}/불필요 ${poolStats.notneeded}, 비율 ${(poolStats.ratio * 100).toFixed(1)}%)`);
  console.log(`표본: ${total}건, manual 우선표기 ${manualOverrides.length}건`);
  console.log(`실행모드: ${modeUsed} (VRAM 시작 ${vramBefore}MB)`);
  console.log(`Jev 성공 ${jevOk.length}/${total}, 실패 ${jevFail.length}`);
  console.log(`p>=0.90: ${buckets.ge090.length}건, 일치율 ${ge090Rate !== null ? ge090Rate.toFixed(1) : 'N/A'}% (${ge090Match}/${buckets.ge090.length})`);
  console.log(`0.70~0.90: ${buckets.b070_090.length}건, 일치율 ${b070_090Rate !== null ? b070_090Rate.toFixed(1) : 'N/A'}% (${b070_090Match}/${buckets.b070_090.length})`);
  console.log(`<0.70(폴백): ${buckets.lt070.length}건`);
  console.log(`전체 일치율: ${overallRate !== null ? overallRate.toFixed(1) : 'N/A'}%`);
  console.log(`폴백률: ${fallbackRate !== null ? fallbackRate.toFixed(1) : 'N/A'}%`);
  console.log(`지연: 평균 ${avgLatency?.toFixed(1)}ms, 최대 ${maxLatency}ms`);
  console.log(`\n게이트(p>=0.90 건수>=15 AND 일치율>=90% AND 0.70~0.90 일치율>=75%): ${gatePass ? '✅ 통과' : '❌ 미통과'}`);
  console.log('=================================================');

  writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));
  log(`결과 JSON 저장: ${OUT_JSON}`);

  db.close();
  return report;
}

main().catch((e) => { console.error('[jev-reply-measure] FAIL:', e); process.exit(1); });
