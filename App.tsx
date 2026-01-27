import React, { useState, useEffect } from 'react';
import { Mail, Config, AnalysisResult } from './types';
import { fetchMailsFromServer } from './services/mailService';
import { analyzeMailWithSubAgents, testApiConnection } from './services/aiService';
import MailList from './components/MailList';
import MailContent from './components/MailContent';
import Sidebar from './components/Sidebar';
import Settings from './components/Settings';

const App: React.FC = () => {
  const [mails, setMails] = useState<Mail[]>([]);
  const [selectedMail, setSelectedMail] = useState<Mail | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [apiStatus, setApiStatus] = useState({ glm: 'testing' });

  const [config, setConfig] = useState<Config>({
    apiKey: '384fffa4d8a44ce58ee573be0d49d995.kqLAZNeRmjnUNPJh',
    agentId: '',
    mailUser: 'designsir@seastargo.com',
    mailPass: ['pE5cptK>P{N7=dYv', '$', 'R,?'].join(''),
    pop3Server: 'pop3.mailplug.co.kr',
    pop3Port: 995
  });

  const [isLoading, setIsLoading] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string>('');
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  useEffect(() => {
    // Clear old localStorage and use hardcoded defaults
    localStorage.removeItem('bonglook_config_v4');
    checkHealth(config);
    handleSyncMails(config);
  }, []);

  const checkHealth = async (cfg: Config) => {
    setApiStatus({ glm: 'testing' });
    const glmRes = await testApiConnection(cfg.apiKey);
    setApiStatus({
      glm: glmRes.success ? 'online' : 'offline'
    });
  };

  const handleSyncMails = async (currentConfig: Config = config) => {
    setIsLoading(true);
    setSyncStatus('데이터 동기화 중...');
    try {
      const data = await fetchMailsFromServer(currentConfig);
      setMails(data);
      setSyncStatus('');
    } catch (error: any) {
      console.error(error);
      setSyncStatus('동기화 실패');
      alert(`오류: ${error.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelectMail = (mail: Mail) => {
    setSelectedMail(mail);
    setAnalysis(null);
    setAnalysisError(null);
    setMails(prev => prev.map(m => m.id === mail.id ? { ...m, isRead: true } : m));
  };

  const handleAnalyze = async () => {
    if (!selectedMail) return;
    setIsAnalyzing(true);
    setAnalysisError(null);
    try {
      const result = await analyzeMailWithSubAgents({ apiKey: config.apiKey }, selectedMail);
      setAnalysis(result);
    } catch (error) {
      setAnalysisError("AI 분석 중 오류가 발생했습니다. API 키를 확인하세요.");
    } finally {
      setIsAnalyzing(false);
    }
  };

  const saveConfig = (newConfig: Config) => {
    setConfig(newConfig);
    localStorage.setItem('bonglook_config_v4', JSON.stringify(newConfig));
    setIsSettingsOpen(false);
    checkHealth(newConfig);
    handleSyncMails(newConfig);
  };

  return (
    <div className="flex h-screen w-screen bg-[#f3f2f1] text-[#323130] overflow-hidden">
      <Sidebar />
      <div className="flex flex-col flex-1 overflow-hidden">
        <header className="h-12 bg-[#0078d4] text-white flex items-center justify-between px-4 shrink-0 shadow-sm z-10">
          <div className="flex items-center gap-4">
            <h1 className="font-semibold text-lg flex items-center gap-2">
              <i className="fas fa-eye"></i> BongLook AI
            </h1>
            <div className="flex gap-2">
              <StatusBadge label="Z.AI Engine" status={apiStatus.glm} />
              {config.agentId && <StatusBadge label="Agent Mode" status="online" />}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsSettingsOpen(true)}
              className="p-2 hover:bg-[#005a9e] rounded transition-colors flex items-center gap-2"
              title="설정 열기"
            >
              <i className="fas fa-cog"></i>
              <span className="text-sm hidden sm:inline">설정</span>
            </button>
          </div>
        </header>

        <main className="flex flex-1 overflow-hidden">
          <div className="flex w-[400px] shrink-0 border-r border-[#edebe9] bg-white flex-col overflow-hidden">
            <div className="p-4 border-b flex justify-between items-center bg-[#faf9f8]">
              <h2 className="font-semibold text-sm text-[#605e5c] uppercase tracking-wider">수신함</h2>
              <button
                onClick={() => handleSyncMails()}
                disabled={isLoading}
                className="text-[#0078d4] text-xs font-bold hover:underline flex items-center gap-1 disabled:opacity-50"
              >
                {isLoading ? <i className="fas fa-spinner fa-spin"></i> : <i className="fas fa-sync-alt"></i>}
                {isLoading ? '동기화 중...' : '새로고침'}
              </button>
            </div>
            <MailList mails={mails} selectedId={selectedMail?.id} onSelect={handleSelectMail} />
          </div>

          <div className="flex-1 bg-white overflow-hidden relative">
            {selectedMail ? (
              <MailContent
                mail={selectedMail}
                onAnalyze={handleAnalyze}
                isAnalyzing={isAnalyzing}
                analysis={analysis}
                config={config}
                analysisError={analysisError}
                onOpenSettings={() => setIsSettingsOpen(true)}
              />
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-gray-300 gap-4">
                <i className="fas fa-envelope-open-text fa-4xl opacity-20"></i>
                <div className="text-center">
                  <p className="text-lg font-medium text-gray-400">분석할 메일을 선택하세요</p>
                  <p className="text-xs text-gray-400 mt-2">
                    {config.agentId ? 'Z.AI 에이전트를 통해 실제 메일을 가져옵니다.' : '상단의 새로고침 버튼을 눌러 메일을 가져올 수 있습니다.'}
                  </p>
                </div>
              </div>
            )}
            {syncStatus && (
              <div className="absolute bottom-4 left-4 bg-black/70 text-white px-4 py-2 rounded-full text-xs animate-pulse">
                {syncStatus}
              </div>
            )}
          </div>
        </main>
      </div>
      {isSettingsOpen && <Settings config={config} onSave={saveConfig} onClose={() => setIsSettingsOpen(false)} />}
    </div>
  );
};

const StatusBadge = ({ label, status }: { label: string, status: string }) => (
  <div className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-[9px] border transition-all ${status === 'online' ? 'bg-green-500/20 border-green-500/50 text-white' : 'bg-red-500/20 border-red-500/50 text-white opacity-60'}`}>
    <div className={`w-1.5 h-1.5 rounded-full ${status === 'online' ? 'bg-green-400 animate-pulse' : status === 'testing' ? 'bg-yellow-400' : 'bg-red-400'}`}></div>
    <span className="font-bold">{label}</span>
  </div>
);

export default App;
