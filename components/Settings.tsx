import React, { useState } from 'react';
import { Config } from '../types';

interface SettingsProps {
  config: Config;
  onSave: (config: Config) => void;
  onClose: () => void;
}

const Settings: React.FC<SettingsProps> = ({ config, onSave, onClose }) => {
  const [formData, setFormData] = useState<Config>(config);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: name === 'pop3Port' ? parseInt(value) || 0 : value
    }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(formData);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 animate-in fade-in duration-200">
      <div className="bg-white w-full max-w-md rounded-lg shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200">
        <div className="bg-[#0078d4] text-white p-4 flex justify-between items-center">
          <h3 className="font-semibold flex items-center gap-2">
            <i className="fas fa-cog"></i> 시스템 설정
          </h3>
          <button
            onClick={onClose}
            className="hover:bg-black/10 p-1 rounded"
            title="닫기"
          >
            <i className="fas fa-times"></i>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          <section className="space-y-3">
            <h4 className="text-xs font-bold text-[#0078d4] uppercase">AI 엔진 및 에이전트 설정</h4>
            <div>
              <label htmlFor="apiKey" className="block text-xs font-medium text-gray-500 mb-1">Z.AI API Key (GLM-4.7)</label>
              <input
                id="apiKey"
                type="password"
                name="apiKey"
                value={formData.apiKey}
                onChange={handleChange}
                className="w-full px-3 py-2 border rounded text-sm focus:ring-1 focus:ring-[#0078d4] outline-none"
                placeholder="Z.AI API 키를 입력하세요"
                title="API Key"
              />
            </div>
            <div>
              <label htmlFor="agentId" className="block text-xs font-medium text-gray-500 mb-1">Z.AI Agent ID (GitHub Pages 용)</label>
              <input
                id="agentId"
                type="text"
                name="agentId"
                value={formData.agentId || ''}
                onChange={handleChange}
                className="w-full px-3 py-2 border rounded text-sm focus:ring-1 focus:ring-[#0078d4] outline-none"
                placeholder="Agent ID가 있으면 입력 (브라우저 직접 연결)"
                title="Agent ID"
              />
              <p className="text-[10px] text-gray-400 mt-1">※ Agent ID 입력 시 로컬 서버 없이도 메일을 가져올 수 있습니다.</p>
            </div>
          </section>

          <hr className="border-gray-100" />

          <section className="space-y-3">
            <h4 className="text-xs font-bold text-[#0078d4] uppercase">POP3 메일 서버 설정</h4>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label htmlFor="pop3Server" className="block text-xs font-medium text-gray-500 mb-1">서버 주소</label>
                <input
                  id="pop3Server"
                  type="text"
                  name="pop3Server"
                  value={formData.pop3Server}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border rounded text-sm focus:ring-1 focus:ring-[#0078d4] outline-none"
                  placeholder="예: pop3.mailplug.co.kr"
                  title="서버 주소"
                />
              </div>
              <div>
                <label htmlFor="pop3Port" className="block text-xs font-medium text-gray-500 mb-1">포트</label>
                <input
                  id="pop3Port"
                  type="number"
                  name="pop3Port"
                  value={formData.pop3Port}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border rounded text-sm focus:ring-1 focus:ring-[#0078d4] outline-none"
                  placeholder="995"
                  title="포트 번호"
                />
              </div>
            </div>
            <div>
              <label htmlFor="mailUser" className="block text-xs font-medium text-gray-500 mb-1">계정 (ID/Email)</label>
              <input
                id="mailUser"
                type="text"
                name="mailUser"
                value={formData.mailUser}
                onChange={handleChange}
                className="w-full px-3 py-2 border rounded text-sm focus:ring-1 focus:ring-[#0078d4] outline-none"
                placeholder="메일 주소를 입력하세요"
                title="메일 계정"
              />
            </div>
            <div>
              <label htmlFor="mailPass" className="block text-xs font-medium text-gray-500 mb-1">비밀번호</label>
              <input
                id="mailPass"
                type="password"
                name="mailPass"
                value={formData.mailPass}
                onChange={handleChange}
                className="w-full px-3 py-2 border rounded text-sm focus:ring-1 focus:ring-[#0078d4] outline-none"
                placeholder="비밀번호를 입력하세요"
                title="비밀번호"
              />
            </div>
          </section>

          <div className="flex gap-2 pt-2">
            <button
              type="submit"
              className="flex-1 bg-[#0078d4] text-white py-2 rounded text-sm font-semibold hover:bg-[#005a9e] transition-colors"
            >
              설정 저장 및 새로고침
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border border-gray-300 rounded text-sm text-gray-600 hover:bg-gray-50"
            >
              취소
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default Settings;
