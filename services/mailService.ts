import { Mail, Config } from "../types";

/**
 * 메일 서버(POP3)로부터 메일을 가져오는 함수
 * 1. agentId가 있으면 Z.AI Agent를 통해 메일을 가져옵니다. (GitHub Pages/보안 권장)
 * 2. agentId가 없으면 로컬 백엔드(localhost:3001)를 통해 가져옵니다.
 */
export const fetchMailsFromServer = async (config: Config): Promise<Mail[]> => {
  if (config.agentId) {
    console.log(`[Z.AI Agent] Fetching mails via Agent: ${config.agentId}...`);
    return fetchViaAgent(config);
  }

  console.log(`[Local Proxy] Requesting mails from local backend...`);
  return fetchViaLocalProxy(config);
};

/**
 * Z.AI Agent API 호출을 통한 메일 수집
 */
const fetchViaAgent = async (config: Config): Promise<Mail[]> => {
  const CHAT_URL = 'https://api.z.ai/api/coding/paas/v4/chat/completions';

  const prompt = `내 메일 서버(${config.pop3Server}:${config.pop3Port})에서 최신 메일 5개를 가져와줘.
계정 정보:
- User: ${config.mailUser}
- Pass: ${config.mailPass}

결과는 반드시 [{id, sender, senderEmail, subject, date, preview, content, attachments, isRead, isFlagged}] 형식의 JSON 배열로만 응답해줘. 다른 설명은 생략해.`;

  try {
    const response = await fetch(CHAT_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        agent_id: config.agentId, // 에이전트 모드 사용
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        response_format: { type: "json_object" }
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Agent request failed');
    }

    const data = await response.json();
    const content = data.choices[0].message.content;

    // JSON 추출 및 파싱
    const start = content.indexOf('[');
    const end = content.lastIndexOf(']');
    if (start !== -1 && end !== -1) {
      return JSON.parse(content.substring(start, end + 1));
    }

    throw new Error("올바른 메일 리스트 형식이 아닙니다.");
  } catch (error: any) {
    console.error('[Agent Fetch Error]', error);
    throw new Error(`Z.AI 에이전트 연동 실패: ${error.message}`);
  }
};

/**
 * 로컬 프록시를 통한 메일 수집 (기존 방식)
 * @param fromDate - 이 날짜 이후의 메일만 가져옴 (선택)
 * @param limit - 가져올 최대 메일 수 (기본 100)
 */
const fetchViaLocalProxy = async (config: Config, fromDate?: Date, limit: number = 100): Promise<Mail[]> => {
  try {
    const response = await fetch('http://localhost:33001/api/fetch-mails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pop3Server: config.pop3Server,
        pop3Port: config.pop3Port,
        mailUser: config.mailUser,
        mailPass: config.mailPass,
        fromDate: fromDate?.toISOString(),
        limit
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || 'Failed to fetch mails');
    }

    return await response.json();
  } catch (error: any) {
    console.error('[Local Proxy Error]', error);
    throw new Error("로컬 백엔드가 실행 중이지 않거나 연결에 실패했습니다.");
  }
};
