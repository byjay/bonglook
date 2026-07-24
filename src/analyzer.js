// ============================================================
//  analyzer.js - AI 기반 메일 분석 (Cerebras 사용)
//  ------------------------------------------------------------
//  기능:
//   1) briefing()   : 기간 내 전체 메일을 종합 → 내 스케줄/한 일/놓친 일/
//                     누가 언제 무엇을 보냈는지 요약 (한국어)
//   2) translateAnalyze() : 영어/중국어 등 외국어 메일 번역 + 요점 분석
//   3) draftReply() : 메일에 대한 답장 초안 작성 (원문 언어에 맞춰)
//   4) chatOverMails() : DB 검색결과를 컨텍스트로 대화형 질의응답
//  ------------------------------------------------------------
//  모든 결과는 main.js 에서 db.addAnalysis()로 저장됨.
// ============================================================
const cerebras = require('./cerebras');

const LANG_NAME = { ko: '한국어', en: '영어', zh: '중국어', ja: '일본어', unknown: '알 수 없음' };

// 메일 목록을 프롬프트용 텍스트로 압축
function mailsToContext(mails, maxBody = 500) {
  return mails.map((m, i) => {
    const body = (m.body || m.preview || '').replace(/\s+/g, ' ').slice(0, maxBody);
    return `[${i + 1}] 날짜:${m.received_at || m.received || ''} | 발신:${m.sender_name || m.sender || ''} <${m.sender_email || m.senderMail || ''}> | 제목:${m.subject || ''}${m.has_attach || m.hasAttach ? ' (첨부있음)' : ''}\n   내용: ${body}`;
  }).join('\n\n');
}

// ------------------------------------------------------------
//  1) 종합 브리핑
// ------------------------------------------------------------
async function briefing({ keys, model, mails, periodLabel = '최근 기간' }) {
  if (!mails || mails.length === 0) {
    return { ok: false, error: '분석할 메일이 없습니다. 먼저 동기화(가져오기)를 실행하세요.' };
  }
  const context = mailsToContext(mails, 400);
  const messages = [
    {
      role: 'system',
      content: [
        '당신은 사용자의 개인 이메일 비서입니다. 아래 이메일 목록을 분석하여 한국어로 간결하고 실용적인 브리핑을 작성하세요.',
        '다음 섹션을 반드시 마크다운으로 구성하세요:',
        '## 📌 핵심 요약 (3~5줄)',
        '## 🗓️ 내 스케줄/일정 (메일에 언급된 회의·마감·약속을 날짜와 함께)',
        '## ✅ 최근 처리/진행된 일',
        '## ⚠️ 내가 놓치고 있을 수 있는 것 (미회신·마감임박·중요요청)',
        '## 👤 주요 발신자별 요약 (누가 언제 무엇을 보냈는지)',
        '## 📎 첨부/도면 관련 (있으면)',
        '추측은 피하고 메일 근거에 기반하세요. 외국어 메일은 한국어로 요점을 번역해 포함하세요.'
      ].join('\n')
    },
    {
      role: 'user',
      content: `분석 기간: ${periodLabel}\n총 ${mails.length}건의 메일입니다.\n\n${context}`
    }
  ];
  const res = await cerebras.chat({ keys, model, messages, temperature: 0.3, maxTokens: 4096 });
  return res;
}

// ------------------------------------------------------------
//  2) 외국어 메일 번역 + 분석
// ------------------------------------------------------------
async function translateAnalyze({ keys, model, mail }) {
  const lang = mail.lang || 'unknown';
  const body = mail.body || mail.preview || '';
  const messages = [
    {
      role: 'system',
      content: [
        '당신은 전문 번역가이자 비즈니스 이메일 분석가입니다.',
        '주어진 이메일(외국어일 수 있음)을 다음 형식으로 한국어로 정리하세요:',
        '## 🌐 원문 언어',
        '## 📝 전문 번역 (한국어)',
        '## 🎯 핵심 요점 (불릿)',
        '## 📅 요청/마감/액션 아이템',
        '## 💬 답장 시 참고사항'
      ].join('\n')
    },
    {
      role: 'user',
      content: `발신: ${mail.sender_name || mail.sender || ''} <${mail.sender_email || mail.senderMail || ''}>\n제목: ${mail.subject || ''}\n감지언어: ${LANG_NAME[lang] || lang}\n\n본문:\n${body}`
    }
  ];
  return cerebras.chat({ keys, model, messages, temperature: 0.2, maxTokens: 3000 });
}

// ------------------------------------------------------------
//  3) 답장 초안 작성
//     tone: 'formal'|'friendly'|'concise', replyLang: 'auto'|'ko'|'en'|'zh'
// ------------------------------------------------------------
async function draftReply({ keys, model, mail, instruction = '', tone = 'formal', replyLang = 'auto' }) {
  const lang = mail.lang || 'unknown';
  const body = mail.body || mail.preview || '';
  const langInstruction = replyLang === 'auto'
    ? `원문과 같은 언어(${LANG_NAME[lang] || lang})로 작성하세요. 원문이 영어면 영어로, 중국어면 중국어로 답장하세요.`
    : `${LANG_NAME[replyLang] || replyLang}로 작성하세요.`;
  const toneMap = {
    formal: '정중하고 격식있는 비즈니스 어조',
    friendly: '친근하지만 전문적인 어조',
    concise: '간결하고 요점만 명확한 어조'
  };
  const messages = [
    {
      role: 'system',
      content: [
        '당신은 사용자를 대신해 이메일 답장 초안을 작성하는 비서입니다.',
        `어조: ${toneMap[tone] || toneMap.formal}.`,
        langInstruction,
        '실제 보낼 수 있는 완성된 답장 본문만 작성하세요(제목 제안 1줄 포함). 설명이나 메타코멘트는 넣지 마세요.',
        '형식:\n제목: <제안 제목>\n---\n<답장 본문>'
      ].join('\n')
    },
    {
      role: 'user',
      content: `아래 메일에 답장하려 합니다.${instruction ? '\n\n[사용자 지시]: ' + instruction : ''}\n\n--- 원본 메일 ---\n발신: ${mail.sender_name || mail.sender || ''}\n제목: ${mail.subject || ''}\n본문:\n${body}`
    }
  ];
  return cerebras.chat({ keys, model, messages, temperature: 0.4, maxTokens: 2500 });
}

// ------------------------------------------------------------
//  4) 대화형 질의응답 (DB 검색결과를 근거로)
//     history: [{role, content}], contextMails: 관련 메일 배열
// ------------------------------------------------------------
async function chatOverMails({ keys, model, question, contextMails = [], history = [] }) {
  const context = contextMails.length
    ? mailsToContext(contextMails, 500)
    : '(관련 메일을 찾지 못했습니다. 일반 지식으로 답하되, 메일 데이터가 필요하면 동기화를 안내하세요.)';
  const messages = [
    {
      role: 'system',
      content: [
        '당신은 사용자의 이메일 데이터베이스에 접근하는 AI 비서입니다.',
        '아래 "관련 메일" 컨텍스트를 근거로 한국어로 답하세요.',
        '메일에 근거가 있으면 [번호]로 인용하세요. 외국어 메일 내용은 한국어로 번역해 설명하세요.',
        '날짜·발신자·요청사항 질문에는 구체적으로 답하세요.'
      ].join('\n')
    },
    ...history.slice(-6),
    {
      role: 'user',
      content: `[관련 메일 컨텍스트]\n${context}\n\n[질문] ${question}`
    }
  ];
  return cerebras.chat({ keys, model, messages, temperature: 0.3, maxTokens: 3000 });
}

module.exports = { briefing, translateAnalyze, draftReply, chatOverMails, mailsToContext };
