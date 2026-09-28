#!/usr/bin/env node
// ============================================================
//  jev-measure.mjs — Jev(JevK5 로컬) ③-b 측정 전용 스크립트
//  ------------------------------------------------------------
//  Bmail UI·기존 분류 로직은 건드리지 않는다(③-c 에서 앱 연결 예정).
//  실DB(읽기 전용)에서 층화 표본 24건(6카테고리 x4) → Jev(로컬) 4질문 1콜 vs
//  현재 앱 LLM(OpenRouter 무료 체인, 대화형) 을 대조해 일치율·지연·VRAM·폴백률을 잰다.
//
//  사용: ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/jev-measure.mjs
//  (better-sqlite3 가 Electron ABI 로 빌드돼 있어 plain node 로는 로드 불가 — HANDOFF.md 환경 참조)
// ============================================================
import { createRequire } from 'module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const Database = require('better-sqlite3');
// join(ROOT,'src','jev.js') 형태로 요구 — scan-orphans.mjs 모듈고아 정규식과 일치시킴(cleanup-worker.mjs 관례)
const jev = require(join(ROOT, 'src', 'jev.js'));
const jevServer = require(join(ROOT, 'src', 'jev-server.js'));
const cerebras = require(join(ROOT, 'src', 'cerebras.js'));

const DB_PATH = String.raw`C:\Users\FREE\AppData\Roaming\outlook-ai-assistant\data\mailstore.db`;
const CONFIG_PATH = String.raw`C:\Users\FREE\AppData\Roaming\outlook-ai-assistant\outlook-ai-config.json`;
const fs = require('fs');

const log = (...a) => console.log('[jev-measure]', new Date().toISOString(), ...a);

// ---------------------------------------------------------------
//  1) 표본 추출 — 실DB 읽기 전용, 6카테고리 x4 = 24건
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

// 결정적 셔플(seed 고정) — 매 실행 같은 표본이 나오게(재현성)
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
           has_attach, real_attach_count, to_me, action_state, received_at
    FROM mails
    WHERE folder NOT IN ('Deleted Items', 'Junk Email', '정크 메일', '삭제된 편지함')
      AND length(coalesce(body, preview, '')) > 20
    ORDER BY received_ts DESC
    LIMIT 4000
  `).all();

  const buckets = { direct_request: [], cc_notify: [], drawing_send: [], quote_approval: [], newsletter: [], replied_thread: [] };
  for (const m of pool) {
    const cat = categorize(m);
    if (buckets[cat]) buckets[cat].push(m);
  }

  const attachStmt = db.prepare(`SELECT file_name FROM attachments WHERE mail_id = ? AND is_inline = 0 LIMIT 5`);
  const sample = [];
  for (const [cat, list] of Object.entries(buckets)) {
    const shuffled = seededShuffle(list, 42 + cat.length);
    const picked = shuffled.slice(0, 4);
    if (picked.length < 4) log(`⚠ 카테고리 ${cat} 후보 ${picked.length}건뿐(목표 4건 미달)`);
    for (const m of picked) {
      const attaches = attachStmt.all(m.id).map(a => a.file_name);
      sample.push({ ...m, category: cat, attachNames: attaches });
    }
  }
  return sample;
}

// ---------------------------------------------------------------
//  2) state 빌더 — (A) 한국어 원문: 제목·발신·수신역할·첨부명·본문 앞 800자
// ---------------------------------------------------------------
function buildState(m) {
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

// ---------------------------------------------------------------
//  3) 질문 4종 (criteria 키·instructions 영어 — 스킬 §6 규격, state 는 한국어)
// ---------------------------------------------------------------
const QUESTIONS = {
  action: {
    type: 'choice',
    instructions: 'What should the recipient do with this email?',
    criteria: {
      todo: 'recipient must take an action (review, reflect, reply, process)',
      fyi: 'informational only, no action needed from recipient',
      hold: 'pending, needs to wait or be held for later',
    },
  },
  reply_needed: {
    type: 'noul',
    instructions: 'Does this specific recipient need to reply to this email themselves?',
  },
  theme: {
    type: 'choice',
    instructions: 'What is the main topic of this email?',
    criteria: {
      drawing: 'technical drawing or design document',
      approval: 'approval or sign-off request',
      quote: 'price quotation or cost estimate',
      meeting: 'meeting or event invitation',
      order: 'purchase order or procurement',
      report: 'status report or progress update',
      other: 'none of the above',
    },
  },
  is_newsletter: {
    type: 'noul',
    instructions: 'Is this a mass marketing newsletter, advertisement, or promotional bulk email rather than personal/business correspondence?',
  },
};

// ---------------------------------------------------------------
//  4) 기준 라벨(LLM) — 현재 앱 체인(OpenRouter 무료) 대화형 1회
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
    // 🔴 실측(2026-09-28): nemotron-3-ultra 는 reasoning_tokens 를 200~250개 먼저 써버려
    //   maxTokens:200 이면 JSON 이 중간에 잘린다(truncated:true, content 파싱 실패) — 900 으로 여유 확보.
    temperature: 0.1, maxTokens: 900,
  });
  const latencyMs = Date.now() - t0;
  if (!r.ok) return { ok: false, error: r.error, latencyMs };
  const parsed = parseLlmJson(r.content || '');
  if (!parsed) return { ok: false, error: `JSON 파싱 실패(truncated=${r.truncated}): ${String(r.content || '').slice(0, 200)}`, latencyMs };
  return { ok: true, parsed, latencyMs };
}

// ---------------------------------------------------------------
//  5) 메인
// ---------------------------------------------------------------
async function main() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const orKeys = cfg.apiKeysByProvider?.openrouter || [];
  const orModel = cfg.model || 'nvidia/nemotron-3-ultra-550b-a55b:free';
  if (!orKeys.length) throw new Error('OpenRouter 키 없음 — outlook-ai-config.json apiKeysByProvider.openrouter 확인');

  const db = new Database(DB_PATH, { readonly: true });
  const sample = pickSample(db);
  log(`표본 ${sample.length}건 추출 완료 (목표 24)`);
  for (const m of sample) log(`  [${m.category}] #${m.id} ${String(m.subject || '').slice(0, 50)}`);

  const vramBefore = await jevServer.freeVramMb();
  log(`측정 시작 전 여유 VRAM: ${vramBefore}MB`);

  const rows = [];
  let coldStartMs = null;
  let vramAfterLoad = null;

  for (let i = 0; i < sample.length; i++) {
    const m = sample[i];
    const state = buildState(m);
    log(`(${i + 1}/${sample.length}) mail#${m.id} [${m.category}] Jev 호출...`);
    const jevResult = await jev.decide({ state, questions: QUESTIONS });
    if (jevResult.coldStartMs != null && coldStartMs == null) coldStartMs = jevResult.coldStartMs;
    if (vramAfterLoad == null) vramAfterLoad = await jevServer.freeVramMb();

    log(`(${i + 1}/${sample.length}) mail#${m.id} LLM 호출...`);
    const llmResult = await callLlm(state, orKeys, orModel);
    if (!llmResult.ok) log(`  ⚠ LLM 실패 mail#${m.id}: ${llmResult.error}`);
    if (!jevResult.ok) log(`  ⚠ Jev 실패 mail#${m.id}: ${jevResult.error}`);

    rows.push({ mail: m, jev: jevResult, llm: llmResult });
  }

  // ---- 종료: 측정 후 서버 종료, VRAM 원복 확인 ----
  await jevServer.shutdown();
  const vramAfterShutdown = await jevServer.freeVramMb();
  log(`측정 종료 — 서버 종료 완료. VRAM: 시작 ${vramBefore}MB → 적재후 ${vramAfterLoad}MB → 종료후 ${vramAfterShutdown}MB`);

  // ---- 집계 ----
  const QKEYS = ['action', 'reply_needed', 'theme', 'is_newsletter'];
  const report = {};
  for (const qk of QKEYS) {
    report[qk] = { total: 0, jevOk: 0, llmOk: 0, bothOk: 0, ge070Jev: 0, ge070Both: 0, matchGe070: 0, matchAll: 0, fallback: 0, mismatches: [] };
  }
  const jevLatencies = [];
  const llmLatencies = [];

  for (const { mail, jev: jr, llm: lr } of rows) {
    if (jr.ok) jevLatencies.push(jr.latencyMs);
    if (lr.ok) llmLatencies.push(lr.latencyMs);

    for (const qk of QKEYS) {
      const rep = report[qk];
      rep.total++;
      if (!jr.ok || !jr.answers?.[qk]) continue;
      rep.jevOk++;
      const ja = jr.answers[qk];
      const jevLabel = ja.type === 'choice' ? ja.choice : (ja.noul >= 0.5 ? true : false);
      const p = ja.probability;
      // 🔴 fallback/ge070Jev 는 Jev 단독 통계(LLM 성공 여부 무관) — 폴백률의 정의 그대로
      if (p < 0.70) rep.fallback++; else rep.ge070Jev++;

      if (!lr.ok || lr.parsed?.[qk] === undefined) continue;
      rep.llmOk++;
      rep.bothOk++;
      let llmLabel = lr.parsed[qk];
      if (ja.type === 'noul') llmLabel = !!llmLabel;

      const match = (ja.type === 'noul') ? (jevLabel === llmLabel) : (String(jevLabel) === String(llmLabel));
      if (match) rep.matchAll++;
      // 🔴 일치율(p>=0.70만) 의 분모는 "Jev p>=0.70 이면서 LLM 도 성공한 건"이어야 한다(둘 다 성공한 표본에서만 비교 가능)
      if (p >= 0.70) { rep.ge070Both++; if (match) rep.matchGe070++; }
      if (!match) {
        rep.mismatches.push({
          id: mail.id, category: mail.category, subject: String(mail.subject || '').slice(0, 60),
          jev: jevLabel, jevP: p.toFixed(3), llm: llmLabel,
        });
      }
    }
  }

  const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const max = (arr) => arr.length ? Math.max(...arr) : null;

  console.log('\n========== ③-b 측정 결과 (2026-09-28) ==========');
  console.log(`표본 24건(목표) 실제 ${sample.length}건 — 카테고리별 4건: 직접수신요청/참조통보/도면송부/견적승인/광고뉴스레터/회신완료스레드`);
  console.log(`Jev 콜드 기동: ${coldStartMs}ms, VRAM 시작 ${vramBefore}MB → 적재후 ${vramAfterLoad}MB (피크 사용 ≈ ${vramBefore - vramAfterLoad}MB) → 종료후 ${vramAfterShutdown}MB`);
  console.log(`Jev 지연(4질문/1콜) 평균 ${avg(jevLatencies)?.toFixed(0)}ms, 최대 ${max(jevLatencies)}ms`);
  console.log(`LLM 지연(1콜/건) 평균 ${avg(llmLatencies)?.toFixed(0)}ms, 최대 ${max(llmLatencies)}ms`);

  for (const qk of QKEYS) {
    const r = report[qk];
    console.log(`\n--- 질문: ${qk} ---`);
    console.log(`판정 건수   : ${r.total}건`);
    console.log(`P(판정비중) : 미측정, 측정 전용 단계`);
    console.log(`일치율(p>=0.70만): ${r.ge070Both ? (100 * r.matchGe070 / r.ge070Both).toFixed(1) : 'N/A'}% (${r.matchGe070}/${r.ge070Both})`);
    console.log(`일치율(전체)     : ${r.bothOk ? (100 * r.matchAll / r.bothOk).toFixed(1) : 'N/A'}% (${r.matchAll}/${r.bothOk})`);
    console.log(`폴백률(p<0.70)   : ${r.jevOk ? (100 * r.fallback / r.jevOk).toFixed(1) : 'N/A'}% (${r.fallback}/${r.jevOk})`);
    console.log(`LLM 실패(비교불가): ${r.total - r.llmOk}/${r.total}건`);
    console.log(`비용        : 로컬 0 / LLM 무료쿼터 ${r.llmOk}건 소모`);
    if (r.mismatches.length) {
      console.log(`불일치 ${r.mismatches.length}건:`);
      for (const mm of r.mismatches) {
        console.log(`  #${mm.id}[${mm.category}] "${mm.subject}" → Jev=${mm.jev}(p=${mm.jevP}) vs LLM=${mm.llm}`);
      }
    }
  }
  console.log('\n=================================================');

  db.close();
}

main().catch((e) => { console.error('[jev-measure] FAIL:', e); process.exit(1); });
