
import React from 'react';
import { Mail } from '../types';

interface MailListProps {
  mails: Mail[];
  selectedId?: string;
  onSelect: (mail: Mail) => void;
}

const MailList: React.FC<MailListProps> = ({ mails, selectedId, onSelect }) => {
  return (
    <div className="flex-1 overflow-y-auto bg-white">
      {mails.length === 0 ? (
        <div className="p-8 text-center text-gray-400 text-sm">
          메일이 없습니다. 동기화를 진행해 주세요.
        </div>
      ) : (
        mails.map((mail) => (
          <div 
            key={mail.id}
            onClick={() => onSelect(mail)}
            className={`
              relative p-3 border-b border-[#f3f2f1] cursor-pointer transition-colors
              ${selectedId === mail.id ? 'bg-[#f3f2f1] border-l-4 border-l-[#0078d4]' : 'hover:bg-[#faf9f8] border-l-4 border-l-transparent'}
            `}
          >
            <div className="flex items-center justify-between mb-1">
              <span className={`text-sm ${mail.isRead ? 'font-normal text-[#605e5c]' : 'font-bold text-[#323130]'}`}>
                {mail.sender}
              </span>
              <span className="text-xs text-[#605e5c] opacity-60">{mail.date.split(' ')[0]}</span>
            </div>
            <div className={`text-sm mb-1 truncate ${mail.isRead ? 'font-normal text-[#605e5c]' : 'font-bold text-[#323130]'}`}>
              {mail.subject}
            </div>
            <div className="text-xs text-[#605e5c] line-clamp-2 leading-relaxed opacity-80">
              {mail.preview}
            </div>
            
            {mail.isFlagged && (
              <div className="absolute right-3 bottom-3 text-red-500 text-xs">
                <i className="fas fa-flag"></i>
              </div>
            )}
            
            {mail.attachments.length > 0 && (
              <div className="absolute right-8 bottom-3 text-[#605e5c] text-xs">
                <i className="fas fa-paperclip"></i>
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
};

export default MailList;
