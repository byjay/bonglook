# BongLook AI - Outlook Mail Analyzer

AI 기반 메일 분석 Outlook Add-in. 요약, 액션 아이템, 마감일 자동 추출.

## Features

- 메일 내용 AI 요약
- 액션 아이템 자동 추출
- 마감일 감지
- 첨부파일 분석
- Outlook Web/Desktop 지원

## Quick Start

### Option 1: GitHub Pages (Online)

1. Outlook Web 열기: https://outlook.office.com
2. Settings > View all Outlook settings
3. Mail > Customize actions > Add-ins
4. My add-ins > Add a custom add-in > Add from URL
5. URL 입력: `https://byjay.github.io/bonglook/manifest.xml`

### Option 2: Local Installation

```powershell
# Clone repository
git clone https://github.com/byjay/bonglook.git
cd bonglook

# Run installer
.\install-outlook-addin.ps1
```

## Configuration

Create `.env.local` file:

```env
VITE_API_KEY=your_api_key
VITE_MAIL_USER=your_email
VITE_MAIL_PASS=your_password
VITE_POP3_SERVER=pop3.yourserver.com
VITE_POP3_PORT=995
```

## Development

```bash
npm install
npm run dev          # Frontend (port 3000)
npm run start:backend  # Backend (port 3001)
```

## Build

```bash
npm run build
```

## License

MIT
