#!/usr/bin/env node
// ============================================================
//  jev-measure2.mjs — Jev 기준선 비교 + 하이브리드 state 개선 측정 (2026-09-28)
//  ------------------------------------------------------------
//  발주서 1~3 항 구현. jev-measure.mjs(③-b)의 하네스/어댑터를 재사용(재작성 아님).
//  추가하는 것: ① 기존 규칙(action-state.js/sent-axis.js/db.js 알고리즘) 대비 LLM 일치율
//              ② 하이브리드 state(한국어 원문+구조화 필드) 재측정
//              ③ 40건(층화, 기존 24 + 신규 16) 표본
//              ④ 판정 규칙(스킬 §3, 발주서 §3) 자동 적용
//
//  🔴 실DB 읽기전용 — db.js 의 init()(마이그레이션 포함 RW 오픈)은 프로덕션 DB에 쓰기 위험이
//     있어 쓰지 않는다. reply_needed 기존규칙은 db.js unansweredMails()(src/db.js:1777-1826)의
//     "정규화 제목 기반 미회신 판정" 알고리즘을 이 스크립트의 readonly 커넥션 위에서 동일 로직으로
//     재현한다(알고리즘 재사용, 프로세스/DB커넥션은 분리 — SoT는 알고리즘 출처 주석으로 명시).
//
//  사용: ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/jev-measure2.mjs
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
const cerebras = require(join(ROOT, 'src', 'cerebras.js'));
const actionState = require(join(ROOT, 'src', 'action-state.js'));
const sentAxis = require(join(ROOT, 'src', 'sent-axis.js'));

// 🔴 마스터 지시(2026-09-30): C: 드라이브 읽기 포함 일체 접근 금지 — E: 실경로만 사용
//   (정션 C:\Users\FREE\AppData\Roaming\outlook-ai-assistant\... 도 금지, 실경로 직접 사용)
const DB_PATH = String.raw`E:\BmailData\outlook-ai-assistant\data\mailstore.db`;
const CONFIG_PATH = String.raw`E:\BmailData\outlook-ai-assistant\outlook-ai-config.json`;
const OUT_JSON = join(ROOT, 'scripts', 'jev-measure2-result.json');
const fs = require('fs');

const log = (...a) => console.log('[jev-measure2]', new Date().toISOString(), ...a);

// ---------------------------------------------------------------
//  1) 표본 추출 — 40건(층화), jev-measure.mjs 와 동일한 카테고리/셔플 로직 재사용
// ---------------------------------------------------------------
function categorize(mail) {
  const subj = mail.subject || '';
  const body = (mail.preview || mail.body || '').slice(0, 400);
  const t = subj + ' ' + body;
  if (/\[SPAM\]|\(광고\)|수신거부|뉴스레터|웹진|Webinar|무료\s*(교육|세미나)/i.test(t)) return 'newsletter';
  if (/견적|승인요청|결재|approval|quotation|price\s*quote/i.test(t)) return 'quote_approval';
  if (mail.has_attach && /도면|dwg|drawing|G\/A|GA\s|arrangement/i.test(t)) return 'drawing_send';
  if (mail.action_state === 'done' || /^\s*RE\s*[:：]/i.test(subj)) return 'replied_thread';
  if (mail.to_me === 1) return 'direct_request';
  return 'cc_notify';
}

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

const SAMPLE_SIZE = 40;

function pickSample(db) {
  const pool = db.prepare(`
    SELECT id, subject, sender_name, sender_email, recipients, cc, body, preview,
           has_attach, real_attach_count, to_me, action_state, received_at, received_ts, folder
    FROM mails
    WHERE folder NOT IN ('Deleted Items', 'Junk Email', '정크 메일', '삭제된 편지함')
      AND length(coalesce(body, preview, '')) > 20
    ORDER BY received_ts DESC
    LIMIT 6000
  `).all();

  const bucketKeys = ['direct_request', 'cc_notify', 'drawing_send', 'quote_approval', 'newsletter', 'replied_thread'];
  const buckets = Object.fromEntries(bucketKeys.map(k => [k, []]));
  for (const m of pool) {
    const cat = categorize(m);
    if (buckets[cat]) buckets[cat].push(m);
  }

  const attachStmt = db.prepare(`SELECT file_name FROM attachments WHERE mail_id = ? AND is_inline = 0 LIMIT 5`);
  const perBucket = Math.floor(SAMPLE_SIZE / bucketKeys.length);
  const extra = SAMPLE_SIZE - perBucket * bucketKeys.length;
  const sample = [];
  bucketKeys.forEach((cat, i) => {
    const n = perBucket + (i < extra ? 1 : 0);
    const list = buckets[cat];
    const shuffled = seededShuffle(list, 42 + cat.length);
    const picked = shuffled.slice(0, n);
    if (picked.length < n) log(`⚠ 카테고리 ${cat} 후보 ${picked.length}건뿐(목표 ${n}건 미달)`);
    for (const m of picked) {
      const attaches = attachStmt.all(m.id).map(a => a.file_name);
      sample.push({ ...m, category: cat, attachNames: attaches });
    }
  });
  return sample;
}

// ---------------------------------------------------------------
//  2) state 빌더 — (A) 기존 한국어 원문(③-b 그대로) / (B) 하이브리드(원문 + 구조화 필드)
// ---------------------------------------------------------------
function buildStateA(m) {
  const role = m.to_me === 1 ? 'to (직접 수신)' : (m.to_me === 0 ? 'cc (참조)' : '알 수 없음');
  const attach = m.attachNames.length ? m.attachNames.join(', ') : 'none';
  const bodyText = (m.body || m.preview || '').slice(0, 800);
  return [
    `Subject: ${m.subject || '(제목 없음)'}`,
    `From: ${m.sender_name || ''} <${m.sender_email || ''}>`,
    `Recipient role: ${role}`,
    `Attachments: ${attach}`,
    `Body: ${bodyText}`,
  ].join('\n');
}

// 요청문구 탐지 — action-state.js REQUEST_RE 재사용(정규식 복제 금지, SoT)
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

// ---------------------------------------------------------------
//  3) 질문 4종 (jev-measure.mjs 와 동일, criteria 영어 유지)
// ---------------------------------------------------------------
const QUESTIONS = {
  action: {
    type: 'choice',
    instructions: 'What should the recipient do with this email? Base your judgement on explicit request phrases, recipient role (To vs CC), and whether this is a reply-completed thread.',
    criteria: {
      todo: 'recipient must take an action (review, reflect, reply, process) — usually when addressed directly (To) with an explicit request phrase',
      fyi: 'informational only, no action needed from recipient — usually CC-only or explicit informational phrasing, or the thread is already closed/replied',
      hold: 'pending, needs to wait or be held for later — action exists but cannot be completed yet',
    },
  },
  reply_needed: {
    type: 'noul',
    instructions: 'Does THIS specific recipient need to personally reply to this email? Answer false if this is CC-only with no direct request, if the thread already shows a reply, or if it is purely informational.',
  },
  theme: {
    type: 'choice',
    instructions: 'What is the main topic of this email? Pick the single best match.',
    criteria: {
      drawing: 'technical drawing or design document (CAD files, G/A, arrangement drawings)',
      approval: 'approval or sign-off request (review/approve/comment requested)',
      quote: 'price quotation or cost estimate',
      meeting: 'meeting or event invitation/scheduling',
      order: 'purchase order or procurement',
      report: 'status report or progress update',
      other: 'none of the above',
    },
  },
  is_newsletter: {
    type: 'noul',
    instructions: 'Is this a mass marketing newsletter, advertisement, or promotional bulk email (e.g. no-reply sender, unsubscribe link, ad markers) rather than personal/business correspondence?',
  },
};

// ---------------------------------------------------------------
//  4) 기준 라벨(LLM) — 현재 앱 체인(OpenRouter 무료) 1회, 하이브리드 state(B) 입력 사용
//     (하이브리드가 정보량이 더 많아 "진짜 정답"에 가장 가까움 — Jev-A/Jev-B/규칙 3방 비교의
//      공통 기준으로 재사용해 LLM 호출을 40건으로 절약)
// ---------------------------------------------------------------
const LLM_SYSTEM = `You are an email triage classifier for a Korean shipbuilding/marine engineering firm.
Answer ONLY with compact JSON, no prose, no markdown fences, matching exactly this schema:
{"action":"todo|fyi|hold","reply_needed":true|false,"theme":"drawing|approval|quote|meeting|order|report|other","is_newsletter":true|false}
Definitions:
action: todo=recipient must act(review/reply/process), fyi=informational only, hold=pending/wait
reply_needed: true if THIS recipient must personally reply
theme: drawing=technical drawing/design doc, approval=approval/sign-off request, quote=price quotation, meeting=meeting/event invite, order=purchase order, report=status/progress report, other=none of these
is_newsletter: true if mass marketing/advertisement/promotional bulk email`;

function parseLlmJson(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { return null; }
}

async function callLlm(state, keys, model) {
  const t0 = Date.now();
  const r = await cerebras.chatOnce({
    keys, model, provider: 'openrouter',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    messages: [
      { role: 'system', content: LLM_SYSTEM },
      { role: 'user', content: state },
    ],
    temperature: 0.1, maxTokens: 900,   // 🔴 200 이면 truncated(HANDOFF ③-b 실측) — 900 유지
  });
  const latencyMs = Date.now() - t0;
  if (!r.ok) return { ok: false, error: r.error, latencyMs };
  const parsed = parseLlmJson(r.content || '');
  if (!parsed) return { ok: false, error: `JSON 파싱 실패(truncated=${r.truncated}): ${String(r.content || '').slice(0, 200)}`, latencyMs };
  return { ok: true, parsed, latencyMs };
}

// ---------------------------------------------------------------
//  5) 기존 규칙(baseline) — 코드베이스 실제 함수 재사용
// ---------------------------------------------------------------
// 5-a) is_newsletter — action-state.js NOREPLY_RE / NEWSLETTER_RE (2026-09-28 export 추가)
function baselineNewsletter(m) {
  const sender = String(m.sender_email || '').toLowerCase();
  const text = `${m.subject || ''}\n${(m.preview || m.body || '').slice(0, 1500)}`;
  const hit = actionState.NOREPLY_RE.test(sender) || actionState.NEWSLETTER_RE.test(text);
  return { value: hit, abstain: false };   // 정규식은 항상 판정(hit/no-hit), 미판정 없음
}

// 5-b) action — action-state.js suggest() 그대로. done→fyi 매핑(Jev action 질문엔 done 선택지 없음).
function baselineAction(m) {
  const s = actionState.suggest(m, {});
  if (!s || !s.state) return { value: null, abstain: true };
  const mapped = s.state === 'done' ? 'fyi' : s.state;
  return { value: mapped, abstain: false, reason: s.reason };
}

// 5-c) theme — sent-axis.js classifyEvent(). 'etc'(기타)는 미판정으로 별도 집계(발주서 §1 지시).
const THEME_MAP = { quote: 'quote', order: 'order', approval: 'approval', drawing: 'drawing', meeting: 'meeting', report: 'report' };
function baselineTheme(m) {
  const e = sentAxis.classifyEvent(m.subject);
  if (e.key === 'etc' || !THEME_MAP[e.key]) return { value: null, abstain: true, reason: `규칙 미판정(기타/비매핑: ${e.key})` };
  return { value: THEME_MAP[e.key], abstain: false };
}

// 5-d) reply_needed — db.js unansweredMails() 알고리즘(src/db.js:1777-1826) 재현.
//      🔴 실DB 읽기전용 유지 위해 db.init()(RW+migrate) 대신 이 스크립트의 readonly 커넥션 위에서
//      동일 로직을 재구성한다(알고리즘 SoT = db.js, 커넥션만 분리).
function dbNormalizeSubject(s) {   // db.js:1276 그대로
  return String(s || '')
    .replace(/^(\s*(re|fw|fwd|답장|전달)\s*(\[\d+\])?\s*:)+/gi, '')
    .replace(/\[[^\]]{1,20}\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
function buildReplyNeededBaseline(db) {
  const mine = new Set(
    db.prepare(`SELECT sender_email, COUNT(*) c FROM mails WHERE folder='Sent' AND sender_email != '' GROUP BY lower(sender_email) ORDER BY c DESC LIMIT 3`)
      .all().map(r => String(r.sender_email).toLowerCase())
  );
  const sentIndex = new Map();
  for (const s of db.prepare(`SELECT subject, received_ts FROM mails WHERE folder='Sent'`).all()) {
    const k = dbNormalizeSubject(s.subject);
    if (!k) continue;
    if ((sentIndex.get(k) || 0) < (s.received_ts || 0)) sentIndex.set(k, s.received_ts || 0);
  }
  return function baselineReplyNeeded(m) {
    if (String(m.folder || '') === 'Sent') return { value: null, abstain: true, reason: 'Sent 폴더(해당없음)' };
    if (mine.has(String(m.sender_email || '').toLowerCase())) return { value: null, abstain: true, reason: '내 주소 발신(해당없음)' };
    if (m.action_state === 'done' || m.action_state === 'fyi') return { value: false, abstain: false, reason: '내가 처리/확인으로 닫음' };
    const k = dbNormalizeSubject(m.subject);
    if (!k) return { value: null, abstain: true, reason: '제목 정규화 불가(규칙 미판정)' };
    const repliedAt = sentIndex.get(k) || 0;
    const needed = !(repliedAt > (m.received_ts || 0));
    return { value: needed, abstain: false };
  };
}

// ---------------------------------------------------------------
//  6) 메인
// ---------------------------------------------------------------
async function main() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const orKeys = cfg.apiKeysByProvider?.openrouter || [];
  const orModel = cfg.model || 'nvidia/nemotron-3-ultra-550b-a55b:free';
  if (!orKeys.length) throw new Error('OpenRouter 키 없음');

  const db = new Database(DB_PATH, { readonly: true });
  const sample = pickSample(db);
  log(`표본 ${sample.length}건 추출 완료 (목표 ${SAMPLE_SIZE})`);

  const baselineReplyNeeded = buildReplyNeededBaseline(db);

  const vramBefore = await jevServer.freeVramMb();
  log(`측정 시작 전 여유 VRAM: ${vramBefore}MB`);

  const rows = [];
  for (let i = 0; i < sample.length; i++) {
    const m = sample[i];
    const stateA = buildStateA(m);
    const stateB = buildStateB(m);

    log(`(${i + 1}/${sample.length}) mail#${m.id} [${m.category}] LLM(하이브리드 state 기준)...`);
    const llmResult = await callLlm(stateB, orKeys, orModel);
    if (!llmResult.ok) log(`  ⚠ LLM 실패 mail#${m.id}: ${llmResult.error}`);

    log(`(${i + 1}/${sample.length}) mail#${m.id} Jev(state A: 원문)...`);
    const jevA = await jev.decide({ state: stateA, questions: QUESTIONS });
    if (!jevA.ok) log(`  ⚠ Jev-A 실패 mail#${m.id}: ${jevA.error}`);

    log(`(${i + 1}/${sample.length}) mail#${m.id} Jev(state B: 하이브리드)...`);
    const jevB = await jev.decide({ state: stateB, questions: QUESTIONS });
    if (!jevB.ok) log(`  ⚠ Jev-B 실패 mail#${m.id}: ${jevB.error}`);

    const baseline = {
      is_newsletter: baselineNewsletter(m),
      action: baselineAction(m),
      theme: baselineTheme(m),
      reply_needed: baselineReplyNeeded(m),
    };

    rows.push({ mail: { id: m.id, category: m.category, subject: m.subject }, llm: llmResult, jevA, jevB, baseline });
  }

  await jevServer.shutdown();
  const vramAfterShutdown = await jevServer.freeVramMb();
  log(`측정 종료 — 서버 종료. VRAM 시작 ${vramBefore}MB → 종료후 ${vramAfterShutdown}MB`);

  // ---- 집계 ----
  const QKEYS = ['action', 'reply_needed', 'theme', 'is_newsletter'];
  const report = {};
  for (const qk of QKEYS) {
    report[qk] = {
      total: 0, llmOk: 0,
      baseline: { judged: 0, match: 0, abstain: 0 },
      jevA: { ge070: 0, matchGe070: 0, all: 0, matchAll: 0, fallback: 0, jevOk: 0 },
      jevB: { ge070: 0, matchGe070: 0, all: 0, matchAll: 0, fallback: 0, jevOk: 0 },
      mismatches: [],
    };
  }

  function tallyJev(rep, key, jr, lr) {
    const bucket = rep;
    if (!jr.ok || !jr.answers?.[key]) return;
    bucket.jevOk++;
    const ja = jr.answers[key];
    const jevLabel = ja.type === 'choice' ? ja.choice : (ja.noul >= 0.5);
    const p = ja.probability;
    if (p < 0.70) bucket.fallback++;
    if (!lr.ok || lr.parsed?.[key] === undefined) return;
    let llmLabel = lr.parsed[key];
    if (ja.type === 'noul') llmLabel = !!llmLabel;
    const match = (ja.type === 'noul') ? (jevLabel === llmLabel) : (String(jevLabel) === String(llmLabel));
    bucket.all++;
    if (match) bucket.matchAll++;
    if (p >= 0.70) { bucket.ge070++; if (match) bucket.matchGe070++; }
    return { jevLabel, p, match };
  }

  for (const { mail, llm: lr, jevA, jevB, baseline } of rows) {
    for (const qk of QKEYS) {
      const rep = report[qk];
      rep.total++;
      if (lr.ok) rep.llmOk++;

      // 기존 규칙
      const b = baseline[qk];
      if (b.abstain) rep.baseline.abstain++;
      else if (lr.ok && lr.parsed?.[qk] !== undefined) {
        rep.baseline.judged++;
        let llmLabel = lr.parsed[qk];
        if (qk === 'is_newsletter' || qk === 'reply_needed') llmLabel = !!llmLabel;
        const match = String(b.value) === String(llmLabel);
        if (match) rep.baseline.match++;
      }

      // Jev A/B
      const resA = tallyJev(rep.jevA, qk, jevA, lr);
      const resB = tallyJev(rep.jevB, qk, jevB, lr);

      if ((resA && !resA.match) || (resB && !resB.match)) {
        rep.mismatches.push({
          id: mail.id, category: mail.category, subject: String(mail.subject || '').slice(0, 60),
          llm: lr.ok ? lr.parsed?.[qk] : null,
          jevA: resA ? { v: resA.jevLabel, p: resA.p.toFixed(3), match: resA.match } : null,
          jevB: resB ? { v: resB.jevLabel, p: resB.p.toFixed(3), match: resB.match } : null,
          baseline: b.abstain ? '미판정' : b.value,
        });
      }
    }
  }

  // ---- 판정(발주서 §3): p>=0.70 일치율>=90% AND 폴백<=30% AND (Jev - baseline) >= +5%p ----
  const pct = (a, b) => (b ? (100 * a / b) : null);
  const verdicts = {};
  for (const qk of QKEYS) {
    const r = report[qk];
    const baselineRate = pct(r.baseline.match, r.baseline.judged);
    const aRate = pct(r.jevA.matchGe070, r.jevA.ge070);
    const bRate = pct(r.jevB.matchGe070, r.jevB.ge070);
    const aFallback = pct(r.jevA.fallback, r.jevA.jevOk);
    const bFallback = pct(r.jevB.fallback, r.jevB.jevOk);
    const better = (bRate ?? -1) >= (aRate ?? -1) ? 'B' : 'A';
    const bestRate = better === 'B' ? bRate : aRate;
    const bestFallback = better === 'B' ? bFallback : aFallback;
    const advantage = (bestRate != null && baselineRate != null) ? (bestRate - baselineRate) : null;
    const pass = bestRate != null && bestRate >= 90 && bestFallback != null && bestFallback <= 30 && advantage != null && advantage >= 5;
    verdicts[qk] = { baselineRate, aRate, bRate, aFallback, bFallback, better, bestRate, bestFallback, advantage, pass };
  }

  // ---- 출력 ----
  console.log('\n========== jev-measure2 (기준선 비교 + 하이브리드 개선) 결과 ==========');
  console.log(`표본 ${sample.length}건(목표 ${SAMPLE_SIZE}) — 층화 6카테고리`);
  for (const qk of QKEYS) {
    const r = report[qk];
    const v = verdicts[qk];
    console.log(`\n--- 질문: ${qk} ---`);
    console.log(`기존규칙: 판정 ${r.baseline.judged}건/미판정 ${r.baseline.abstain}건, 일치율 ${v.baselineRate?.toFixed(1)}% (${r.baseline.match}/${r.baseline.judged})`);
    console.log(`Jev-A(원문) : p>=0.70 일치율 ${v.aRate?.toFixed(1)}% (${r.jevA.matchGe070}/${r.jevA.ge070}), 전체일치 ${pct(r.jevA.matchAll, r.jevA.all)?.toFixed(1)}%, 폴백 ${v.aFallback?.toFixed(1)}%`);
    console.log(`Jev-B(하이브리드): p>=0.70 일치율 ${v.bRate?.toFixed(1)}% (${r.jevB.matchGe070}/${r.jevB.ge070}), 전체일치 ${pct(r.jevB.matchAll, r.jevB.all)?.toFixed(1)}%, 폴백 ${v.bFallback?.toFixed(1)}%`);
    console.log(`판정: 최선=${v.better}, 최선일치율 ${v.bestRate?.toFixed(1)}%, baseline대비 ${v.advantage != null ? (v.advantage >= 0 ? '+' : '') + v.advantage.toFixed(1) : 'N/A'}%p → ${v.pass ? '✅ Jev 적용' : '❌ 미적용(규칙 유지)'}`);
  }
  console.log('\n=================================================');

  writeFileSync(OUT_JSON, JSON.stringify({ sample: sample.map(m => ({ id: m.id, category: m.category, subject: m.subject })), report, verdicts, rows }, null, 2));
  log(`결과 JSON 저장: ${OUT_JSON}`);

  db.close();
}

main().catch((e) => { console.error('[jev-measure2] FAIL:', e); process.exit(1); });
