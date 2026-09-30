#!/usr/bin/env node
// ============================================================
//  reply-needed-measure3.mjs — 회신 필요성 40건 표본 재측정(2026-09-29, HANDOFF 7-1 누락분)
//  ------------------------------------------------------------
//  직전 세션(2026-09-28)이 UI 기본값(3일+, 30일창) 141건 후보 중 40건을 무료 LLM 1건 1호출로
//  실측(필요 6·불필요 34)했으나 개별 결과 파일을 남기지 않아 마스터 제시용 20건/6건 표를 만들 수
//  없었다. 이 스크립트는 같은 방식(reply-needed.js classifyMail, mode:'batch')으로 readonly 재측정한다.
//
//  🔴 실DB 읽기전용 — db.js init()(RW+migrate)을 쓰지 않는다. unansweredMails() 알고리즘
//     (src/db.js:1822-1880)을 이 스크립트의 readonly 커넥션 위에서 동일 로직으로 재현한다
//     (jev-measure2.mjs 의 baselineReplyNeeded 와 같은 패턴 — SoT는 db.js, 커넥션만 분리).
//  🔴 DB 쓰기 0 · C: 임시파일 0 — 출력은 E: 아래 scripts/reply-needed-sample.md 하나뿐(gitignore 처리).
//
//  사용: ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/reply-needed-measure3.mjs
// ============================================================
import { createRequire } from 'module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const Database = require('better-sqlite3');
const replyNeeded = require(join(ROOT, 'src', 'reply-needed.js'));
const cerebras = require(join(ROOT, 'src', 'cerebras.js'));
const aiProviders = require(join(ROOT, 'src', 'ai-providers.js'));

// 🔴 마스터 지시(2026-09-30): C: 드라이브 읽기 포함 일체 접근 금지 — E: 실경로만 사용
//   (정션 C:\Users\FREE\AppData\Roaming\outlook-ai-assistant\... 도 금지, 실경로 직접 사용)
const DB_PATH = String.raw`E:\BmailData\outlook-ai-assistant\data\mailstore.db`;
const CONFIG_PATH = String.raw`E:\BmailData\outlook-ai-assistant\outlook-ai-config.json`;
const OUT_MD = join(ROOT, 'scripts', 'reply-needed-sample.md');

const log = (...a) => console.log('[reply-needed-measure3]', new Date().toISOString(), ...a);

// ---------------------------------------------------------------
//  unansweredMails() 알고리즘 재현(src/db.js:1822-1880, SoT=db.js — 여기는 readonly 커넥션 분리만)
// ---------------------------------------------------------------
function normalizeSubject(s) {
  return String(s || '')
    .replace(/^(\s*(re|fw|fwd|답장|전달)\s*(\[\d+\])?\s*:)+/gi, '')
    .replace(/\[[^\]]{1,20}\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function myAddresses(db, limit = 3) {
  return db.prepare(`
    SELECT sender_email, COUNT(*) c FROM mails
    WHERE folder = 'Sent' AND sender_email != ''
    GROUP BY lower(sender_email) ORDER BY c DESC LIMIT ?
  `).all(limit).map(r => String(r.sender_email).toLowerCase());
}

function unansweredMailsReadonly(db, { days = 30, limit = 200, minDays = 3, excludeClosed = true } = {}) {
  const now = Date.now();
  const sinceTs = now - days * 864e5;
  const mine = new Set(myAddresses(db, 3));

  const received = db.prepare(`
    SELECT id, subject, sender_name, sender_email, recipients, cc, received_at, received_ts, folder,
           has_attach, preview, body, action_state, to_me
    FROM mails
    WHERE folder != 'Sent' AND received_ts >= ?
    ORDER BY received_ts DESC
  `).all(sinceTs);

  const sent = db.prepare(`
    SELECT subject, received_ts FROM mails WHERE folder = 'Sent' AND received_ts >= ?
  `).all(sinceTs - 7 * 864e5);

  const sentIndex = new Map();
  for (const s of sent) {
    const k = normalizeSubject(s.subject);
    if (!k) continue;
    const prev = sentIndex.get(k) || 0;
    if (s.received_ts > prev) sentIndex.set(k, s.received_ts);
  }

  const seen = new Set();
  const out = [];
  for (const m of received) {
    if (!m.received_ts) continue;
    if (mine.has(String(m.sender_email || '').toLowerCase())) continue;
    if (excludeClosed && (m.action_state === 'done' || m.action_state === 'fyi')) continue;
    const waited = Math.floor((now - m.received_ts) / 864e5);
    if (waited < minDays) continue;
    const k = normalizeSubject(m.subject);
    if (!k || seen.has(k)) continue;
    const repliedAt = sentIndex.get(k) || 0;
    if (repliedAt > m.received_ts) continue;
    seen.add(k);
    out.push({ ...m, daysWaiting: waited });
  }
  out.sort((a, b) => (b.received_ts || 0) - (a.received_ts || 0));
  return out.slice(0, limit);
}

function seededShuffle(arr, seed = 20260929) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const SAMPLE_SIZE = 40;

//  체인 항목을 cerebras.js 가 쓰는 얕은 형태로 변환 (main.js toCerebrasNode 그대로 재현)
function toCerebrasNode(e) {
  return {
    provider: e.provider, label: e.label, chatUrl: e.chatUrl, model: e.model, models: e.models || null,
    keys: e.keys, limits: e.limits || null
  };
}

async function main() {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const orKeys = cfg.apiKeysByProvider?.openrouter || [];
  const orModel = cfg.model || 'nvidia/nemotron-3-ultra-550b-a55b:free';
  if (!orKeys.length) throw new Error('OpenRouter 키 없음');

  // 🔴 main.js applyAiConfig() 재현 — cerebras.chat({mode:'batch',...})는 모듈 전역 체인
  //   (activeChainList/batchChainList)을 봐야 하는데, 앱을 안 거치는 이 스크립트에선 그게
  //   비어 있어 기본 엔드포인트(cerebras.ai)로 새 버렸었다(1차 시도 실패 원인 — 지휘자 재현 확인).
  //   main.js:955-964 와 동일하게 체인을 실제로 설정해야 OpenRouter/Groq 키가 맞는 URL로 간다.
  const chain = aiProviders.activeChain(cfg);
  const batchChain = aiProviders.reorderForBatch(chain);
  cerebras.setChain(chain.map(toCerebrasNode), batchChain.map(toCerebrasNode));
  log(`체인 설정: ${chain.map(c => c.provider).join(' > ')} (배치 우선순위: ${batchChain.map(c => c.provider).join(' > ')})`);

  const db = new Database(DB_PATH, { readonly: true });
  const candidates = unansweredMailsReadonly(db, { days: 30, limit: 200, minDays: 3 });
  log(`후보 ${candidates.length}건(UI 기본값 3일+, 30일창 — HANDOFF 141건과 같은 조건)`);

  const sample = seededShuffle(candidates, 20260929).slice(0, SAMPLE_SIZE);
  log(`표본 ${sample.length}건 추출(seeded, 재현 가능)`);

  const attachStmt = db.prepare(`SELECT file_name FROM attachments WHERE mail_id = ? AND is_inline = 0 LIMIT 5`);
  const rows = [];
  for (let i = 0; i < sample.length; i++) {
    const m = sample[i];
    const attachNames = attachStmt.all(m.id).map(a => a.file_name);
    log(`(${i + 1}/${sample.length}) mail#${m.id} 판정 중...`);
    const r = await replyNeeded.classifyMail(m, { keys: orKeys, model: orModel, attachNames });
    if (!r.ok) log(`  ⚠ 실패 mail#${m.id}: ${r.error}`);
    rows.push({ mail: m, result: r });
  }
  db.close();

  const ok = rows.filter(r => r.result.ok);
  const needed = ok.filter(r => r.result.needsReply);
  const notNeeded = ok.filter(r => !r.result.needsReply);
  const failed = rows.filter(r => !r.result.ok);
  const uncertain = ok.filter(r => r.result.confidence < 0.70);
  log(`성공 ${ok.length}/${rows.length} · 필요 ${needed.length}건 · 불필요 ${notNeeded.length}건 · 판단불확실(<0.70) ${uncertain.length}건 · 실패 ${failed.length}건`);

  const roleLabel = (m) => m.to_me === 1 ? 'To(직접수신)' : (m.to_me === 0 ? 'CC(참조)' : '알수없음');
  const dateOf = (m) => String(m.received_at || '').slice(0, 16);
  const rowsTable = (list, n) => {
    const picked = n ? seededShuffle(list, 777).slice(0, n) : list;
    const header = '| 날짜 | 발신 | 제목 | 수신역할 | 판정 이유 | confidence |\n|---|---|---|---|---|---|\n';
    const body = picked.map(({ mail: m, result: r }) =>
      `| ${dateOf(m)} | ${String(m.sender_name || m.sender_email || '').replace(/\|/g, '/')} | ${String(m.subject || '(제목 없음)').replace(/\|/g, '/')} | ${roleLabel(m)} | ${String(r.reason || '').replace(/\|/g, '/')} | ${r.confidence.toFixed(2)} |`
    ).join('\n');
    return header + body + '\n';
  };

  const md = [
    '# 회신 필요성 판정 표본(readonly 재측정, 2026-09-29)',
    '',
    `모집단: UI 기본값(3일+, 30일창) 회신대기 후보 ${candidates.length}건 중 시드 셔플 40건 표본.`,
    `결과: 성공 ${ok.length}/${rows.length} · 필요 ${needed.length}건 · 불필요 ${notNeeded.length}건 · 판단불확실(conf<0.70) ${uncertain.length}건 · 실패 ${failed.length}건`,
    '',
    `## 「회신 필요」로 판정된 전체 ${needed.length}건`,
    '',
    rowsTable(needed, 0),
    `## 「회신 불필요」로 판정된 것 중 무작위 20건(전체 ${notNeeded.length}건 중)`,
    '',
    rowsTable(notNeeded, 20),
  ].join('\n');

  writeFileSync(OUT_MD, md, 'utf8');
  log(`저장: ${OUT_MD}`);
}

main().catch((e) => { console.error('[reply-needed-measure3] FAIL:', e); process.exit(1); });
