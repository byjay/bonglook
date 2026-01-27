import { Mail, AnalysisResult } from "../types";

// Z.AI 코딩 전용 API 주소
const CHAT_URL = 'https://api.z.ai/api/coding/paas/v4/chat/completions';

const ZAI_HEADERS = (apiKey: string) => ({
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
});

/**
 * AI 응답에서 JSON 구조만 안전하게 추출하여 파싱합니다.
 */
const robustJsonParse = (text: string) => {
    if (!text) throw new Error("AI 응답이 없습니다.");
    try {
        return JSON.parse(text);
    } catch (e) {
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start !== -1 && end !== -1) {
            try {
                const jsonStr = text.substring(start, end + 1);
                return JSON.parse(jsonStr);
            } catch (parseError) {
                throw new Error("데이터 구조 해석 실패");
            }
        }
        throw new Error("올바른 JSON 형식이 아닙니다.");
    }
};

/**
 * Z.AI GLM-4.7 코딩 API 연결 테스트
 */
export const testApiConnection = async (apiKey: string): Promise<{ success: boolean; message: string }> => {
    try {
        if (!apiKey) return { success: false, message: "Z.AI 키가 없습니다." };

        const response = await fetch(CHAT_URL, {
            method: 'POST',
            headers: ZAI_HEADERS(apiKey),
            body: JSON.stringify({
                model: 'GLM-4.7',
                messages: [{ role: 'user', content: 'OK' }],
                stream: false,
                max_tokens: 10
            })
        });

        if (response.ok) {
            return { success: true, message: "Z.AI 연결 성공!" };
        }
        return { success: false, message: `Z.AI API 오류 (${response.status})` };
    } catch (err: any) {
        return { success: false, message: `네트워크 연결 실패: ${err.message}` };
    }
};

/**
 * 메일 정밀 분석 (Z.AI Only)
 */
export const analyzeMailWithSubAgents = async (config: { apiKey: string }, mail: Mail): Promise<AnalysisResult> => {
    const systemInstruction = `You are a professional business email analyst. 
Analyze the content and provide a JSON response with terms in Korean and English:
- summary: Core summary.
- actionItems: Checklist.
- deadlines: Critical dates.
- attachmentsInsight: File analysis.
- replyDraft: Professional bilingual reply.
Return ONLY the raw JSON object.`;

    const userPrompt = `Subject: ${mail.subject}\n\nContent:\n${mail.content}`;

    const response = await fetch(CHAT_URL, {
        method: 'POST',
        headers: ZAI_HEADERS(config.apiKey),
        body: JSON.stringify({
            model: 'GLM-4.7',
            messages: [
                { role: 'system', content: systemInstruction },
                { role: 'user', content: userPrompt }
            ],
            response_format: { type: "json_object" },
            temperature: 0.1
        })
    });

    if (response.ok) {
        const data = await response.json();
        const content = data.choices[0].message.content;
        const result = robustJsonParse(content);
        return { ...result, modelUsed: 'GLM-4.7' };
    }
    throw new Error("Z.AI 분석 실패");
};

/**
 * 지능형 답장 생성
 */
export const refineUserReply = async (config: { apiKey: string }, mail: Mail, userIntent: string): Promise<string> => {
    const prompt = `Based on the email: "${mail.content}", draft a reply for: "${userIntent}". Bilingual Korean/English.`;

    const response = await fetch(CHAT_URL, {
        method: 'POST',
        headers: ZAI_HEADERS(config.apiKey),
        body: JSON.stringify({
            model: 'GLM-4.7',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.7
        })
    });

    if (response.ok) {
        const data = await response.json();
        return data.choices[0].message.content;
    }
    throw new Error("답장 생성 실패");
};

/**
 * 한/영 분할 번역
 */
export const translateContent = async (config: { apiKey: string }, content: string): Promise<string> => {
    const prompt = `Translate to professional Korean: ${content}`;

    const response = await fetch(CHAT_URL, {
        method: 'POST',
        headers: ZAI_HEADERS(config.apiKey),
        body: JSON.stringify({
            model: 'GLM-4.7',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.1
        })
    });

    if (response.ok) {
        const data = await response.json();
        return data.choices[0].message.content;
    }
    return "번역 실패";
};
