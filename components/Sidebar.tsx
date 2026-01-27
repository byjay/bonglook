
import React from 'react';

const Sidebar: React.FC = () => {
  return (
    <div className="w-12 bg-[#f3f2f1] border-r border-[#edebe9] flex flex-col items-center py-4 gap-4 shrink-0 z-20">
      <div className="p-2 text-[#0078d4] cursor-pointer hover:bg-[#edebe9] rounded">
        <i className="fas fa-envelope text-xl"></i>
      </div>
      <div className="p-2 text-[#605e5c] cursor-pointer hover:bg-[#edebe9] rounded">
        <i className="far fa-calendar-alt text-xl"></i>
      </div>
      <div className="p-2 text-[#605e5c] cursor-pointer hover:bg-[#edebe9] rounded">
        <i className="fas fa-users text-xl"></i>
      </div>
      <div className="p-2 text-[#605e5c] cursor-pointer hover:bg-[#edebe9] rounded">
        <i className="fas fa-check-circle text-xl"></i>
      </div>
      <div className="mt-auto p-2 text-[#605e5c] cursor-pointer hover:bg-[#edebe9] rounded">
        <i className="fas fa-plus text-xl"></i>
      </div>
    </div>
  );
};

export default Sidebar;
