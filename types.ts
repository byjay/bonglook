export interface MailAttachment {
  name: string;
  type: 'image' | 'pdf' | 'other';
  size: string;
  url: string;
  content?: string;
}

export interface Mail {
  id: string;
  sender: string;
  senderEmail: string;
  subject: string;
  date: string;
  preview: string;
  content: string;
  attachments: MailAttachment[];
  isRead: boolean;
  isFlagged: boolean;
}

export interface AnalysisResult {
  summary: string;
  actionItems: string;
  deadlines: string;
  attachmentsInsight: string;
  replyDraft: string;
  modelUsed?: string;
}

export interface Config {
  apiKey: string; // Z.AI GLM Key
  agentId?: string; // Z.AI Agent ID
  mailUser: string;
  mailPass: string;
  pop3Server: string;
  pop3Port: number;
}
