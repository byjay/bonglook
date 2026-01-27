import React, { useState } from 'react';
import { Mail, AnalysisResult, Config } from '../types';
import { refineUserReply, translateContent } from '../services/aiService';

interface MailContentProps {
  mail: Mail;
  onAnalyze: () => void;
  isAnalyzing: boolean;
  analysis: AnalysisResult | null;
  config: Config;
  analysisError: string | null;
  onOpenSettings: () => void;
}

const MailContent: React.FC<MailContentProps> = ({
  mail, onAnalyze, isAnalyzing, analysis, config, analysisError, onOpenSettings
}) => {
  const [replyIntent, setReplyIntent] = useState('');
  const [isGeneratingReply, setIsGeneratingReply] = useState(false);
  const [generatedReply, setGeneratedReply] = useState<string | null>(null);
  const [translatedContent, setTranslatedContent] = useState<string | null>(null);
  const [isTranslating, setIsTranslating] = useState(false);

  const handleGenerateReply = async () => {
    if (!replyIntent) return;
    setIsGeneratingReply(true);
    try {
      const reply = await refineUserReply({ apiKey: config.apiKey }, mail, replyIntent);
      setGeneratedReply(reply);
    } catch (error) {
      alert("답장 생성 중 오류가 발생했습니다.");
    } finally {
      setIsGeneratingReply(false);
    }
  };

  const handleTranslate = async () => {
    setIsTranslating(true);
    try {
      const translated = await translateContent({ apiKey: config.apiKey }, mail.content);
      setTranslatedContent(translated);
    } catch (error) {
      alert("번역 중 오류가 발생했습니다.");
    } finally {
      setIsTranslating(false);
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden bg-white">
      {/* Mail Header */}
      <div className="p-6 border-b border-[#edebe9] shrink-0">
        <div className="flex justify-between items-start mb-4">
          <h2 className="text-xl font-semibold text-[#323130] leading-tight">{mail.subject}</h2>
          <div className="flex gap-2">
            <button
              onClick={handleTranslate}
              disabled={isTranslating}
              className="px-3 py-1.5 border border-[#0078d4] text-[#0078d4] text-xs font-semibold rounded hover:bg-[#f0f8ff] transition-colors disabled:opacity-50"
            >
              {isTranslating ? <i className="fas fa-spinner fa-spin mr-1"></i> : <i className="fas fa-language mr-1"></i>}
              한글 번역
            </button>
            <button
              onClick={onAnalyze}
              disabled={isAnalyzing}
              className="px-4 py-1.5 bg-[#0078d4] text-white text-xs font-bold rounded shadow-sm hover:bg-[#005a9e] transition-colors disabled:opacity-50"
            >
              {isAnalyzing ? <i className="fas fa-robot fa-spin mr-2"></i> : <i className="fas fa-brain mr-2"></i>}
              AI 정밀 분석
            </button>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-[#0078d4] text-white flex items-center justify-center font-bold text-lg">
            {mail.sender[0]}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex justify-between items-center">
              <span className="font-semibold text-[#323130] block truncate">{mail.sender}</span>
              <span className="text-xs text-[#605e5c] shrink-0">{mail.date}</span>
            </div>
            <span className="text-sm text-[#605e5c] block truncate">&lt;{mail.senderEmail}&gt;</span>
          </div>
        </div>
      </div>

      {/* Main Scrollable Content */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6 bg-[#faf9f8]">
        {/* Analysis Results */}
        {analysis && (
          <div className="bg-white rounded-lg shadow-sm border border-[#0078d4]/20 overflow-hidden animate-in slide-in-from-top-4 duration-300">
            <div className="bg-[#0078d4]/5 px-4 py-2 border-b border-[#0078d4]/10 flex justify-between items-center">
              <span className="text-xs font-bold text-[#0078d4] flex items-center gap-2">
                <i className="fas fa-magic"></i> AI 분석 결과 ({analysis.modelUsed})
              </span>
            </div>
            <div className="p-5 space-y-5">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <h4 className="text-xs font-bold text-gray-400 uppercase mb-2">요약 (Summary)</h4>
                  <p className="text-sm text-[#323130] leading-relaxed whitespace-pre-wrap">{analysis.summary}</p>
                </div>
                <div>
                  <h4 className="text-xs font-bold text-gray-400 uppercase mb-2">실행 과제 (Action Items)</h4>
                  <p className="text-sm text-[#323130] leading-relaxed whitespace-pre-wrap">{analysis.actionItems}</p>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-4 border-t border-gray-50">
                <div>
                  <h4 className="text-xs font-bold text-gray-400 uppercase mb-2">마감 및 중요일정</h4>
                  <p className="text-sm text-[#d83b01] font-medium leading-relaxed">{analysis.deadlines}</p>
                </div>
                <div>
                  <h4 className="text-xs font-bold text-gray-400 uppercase mb-2">첨부파일 통찰</h4>
                  <p className="text-sm text-[#323130] leading-relaxed">{analysis.attachmentsInsight}</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {analysisError && (
          <div className="bg-red-50 p-4 rounded border border-red-100 flex items-center gap-3 text-red-600">
            <i className="fas fa-exclamation-circle text-lg"></i>
            <div className="flex-1">
              <p className="text-sm font-semibold">{analysisError}</p>
              <button onClick={onOpenSettings} className="text-xs underline mt-1">API 설정 확인하기</button>
            </div>
          </div>
        )}

        {/* Email Body */}
        <div className="bg-white p-8 rounded-lg shadow-sm border border-[#edebe9]">
          {translatedContent ? (
            <div className="space-y-4 animate-in fade-in duration-300">
              <div className="p-3 bg-blue-50/50 rounded text-sm text-blue-900 border-l-4 border-blue-400 italic">
                한글 번역이 적용되었습니다.
              </div>
              <div className="text-[15px] leading-relaxed whitespace-pre-wrap text-[#323130]">
                {translatedContent}
              </div>
              <button
                onClick={() => setTranslatedContent(null)}
                className="text-xs text-gray-400 hover:text-gray-600 underline"
              >
                원문 보기
              </button>
            </div>
          ) : (
            <div className="text-[15px] leading-relaxed whitespace-pre-wrap text-[#323130]">
              {mail.content}
            </div>
          )}
        </div>

        {/* Attachments */}
        {mail.attachments.length > 0 && (
          <div className="space-y-3">
            <h4 className="text-xs font-bold text-gray-400 uppercase px-1">첨부파일 ({mail.attachments.length})</h4>
            <div className="flex flex-wrap gap-2">
              {mail.attachments.map((att, i) => (
                <div key={i} className="flex items-center gap-3 p-3 bg-white border border-[#edebe9] rounded-md hover:border-[#0078d4] transition-all cursor-pointer group shadow-sm min-w-[200px]">
                  <div className="text-[#0078d4] text-xl">
                    <i className={att.type === 'pdf' ? 'fas fa-file-pdf' : att.type === 'image' ? 'fas fa-file-image' : 'fas fa-file-alt'}></i>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-[#323130] group-hover:text-[#0078d4]">{att.name}</p>
                    <p className="text-[11px] text-[#605e5c]">{att.size}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Quick Reply Tool */}
        <div className="bg-white p-6 rounded-lg shadow-sm border border-[#edebe9] space-y-4">
          <div className="flex items-center gap-2 text-[#0078d4]">
            <i className="fas fa-reply-all"></i>
            <h4 className="text-xs font-bold uppercase">지능형 답장 초안</h4>
          </div>

          <div className="flex gap-2">
            <input
              type="text"
              value={replyIntent}
              onChange={(e) => setReplyIntent(e.target.value)}
              placeholder="답장에 포함할 핵심 내용을 간단히 적어보세요 (예: 수락합니다, 일정을 조정하고 싶습니다)"
              className="flex-1 px-4 py-2 border rounded-md text-sm outline-none focus:ring-1 focus:ring-[#0078d4]"
              onKeyPress={(e) => e.key === 'Enter' && handleGenerateReply()}
            />
            <button
              onClick={handleGenerateReply}
              disabled={isGeneratingReply || !replyIntent}
              className="bg-[#0078d4] text-white px-6 py-2 rounded-md text-sm font-bold hover:bg-[#005a9e] disabled:opacity-50 transition-all flex items-center gap-2 shadow-sm"
            >
              {isGeneratingReply ? <i className="fas fa-spinner fa-spin"></i> : <i className="fas fa-paper-plane"></i>}
              초안 생성
            </button>
          </div>

          {generatedReply && (
            <div className="mt-4 p-5 bg-[#faf9f8] rounded-md border border-[#edebe9] animate-in slide-in-from-bottom-2 duration-300 relative group">
              <button
                className="absolute top-2 right-2 p-1.5 opacity-0 group-hover:opacity-100 transition-opacity bg-white border rounded shadow-sm hover:bg-gray-50"
                onClick={() => {
                  navigator.clipboard.writeText(generatedReply);
                  alert("복사되었습니다.");
                }}
                title="복사하기"
              >
                <i className="fas fa-copy text-gray-500"></i>
              </button>
              <div className="text-[14px] leading-relaxed text-[#323130] whitespace-pre-wrap italic">
                {generatedReply}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default MailContent;
