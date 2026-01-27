import express from 'express';
import cors from 'cors';
import POP3Client from 'poplib';
import { simpleParser } from 'mailparser';
import tls from 'tls';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 33001;

// Mail polling state
let mailState = {
    lastMsgCount: 0,
    lastCheckTime: null,
    config: null,
    pollingInterval: null
};

// Check for new mail periodically
const checkNewMail = async () => {
    if (!mailState.config) return null;

    return new Promise((resolve) => {
        const { pop3Server, pop3Port, mailUser, mailPass } = mailState.config;
        const client = new POP3Client(pop3Port, pop3Server, {
            tlserrs: false,
            enabletls: true,
            debug: false
        });

        client.on('error', () => resolve(null));
        client.on('connect', () => client.login(mailUser, mailPass));
        client.on('login', (status) => status ? client.list() : resolve(null));
        client.on('list', (status, msgCount) => {
            client.quit();
            if (status) {
                const newCount = msgCount - mailState.lastMsgCount;
                if (newCount > 0 && mailState.lastMsgCount > 0) {
                    console.log(`[POLL] ${newCount} new email(s) detected!`);
                }
                mailState.lastMsgCount = msgCount;
                mailState.lastCheckTime = new Date();
                resolve({ msgCount, newCount: newCount > 0 ? newCount : 0 });
            } else {
                resolve(null);
            }
        });
    });
};

// Start polling endpoint
app.post('/api/start-polling', (req, res) => {
    const { pop3Server, pop3Port, mailUser, mailPass, intervalMs = 60000 } = req.body;

    if (mailState.pollingInterval) {
        clearInterval(mailState.pollingInterval);
    }

    mailState.config = { pop3Server, pop3Port, mailUser, mailPass };
    mailState.pollingInterval = setInterval(checkNewMail, intervalMs);

    console.log(`[POLL] Started polling every ${intervalMs / 1000}s`);
    checkNewMail(); // Initial check
    res.json({ status: 'polling started', intervalMs });
});

// Stop polling endpoint
app.post('/api/stop-polling', (req, res) => {
    if (mailState.pollingInterval) {
        clearInterval(mailState.pollingInterval);
        mailState.pollingInterval = null;
        console.log('[POLL] Stopped polling');
    }
    res.json({ status: 'polling stopped' });
});

// Get mail status (for frontend polling)
app.get('/api/mail-status', async (req, res) => {
    const result = await checkNewMail();
    res.json({
        lastMsgCount: mailState.lastMsgCount,
        lastCheckTime: mailState.lastCheckTime,
        ...result
    });
});

app.post('/api/fetch-mails', async (req, res) => {
    const { pop3Server, pop3Port, mailUser, mailPass, fromDate, limit = 100 } = req.body;

    if (!pop3Server || !pop3Port || !mailUser || !mailPass) {
        return res.status(400).json({ error: 'Missing configuration' });
    }

    const dateFilter = fromDate ? new Date(fromDate) : null;
    console.log(`[POP3] Connecting to ${pop3Server}:${pop3Port} for ${mailUser}...`);
    console.log(`[POP3] Filter: ${dateFilter ? `from ${dateFilter.toLocaleDateString()}` : 'no date filter'}, limit: ${limit}`);

    try {
        const client = new POP3Client(pop3Port, pop3Server, {
            tlserrs: false,
            enabletls: true,
            debug: false
        });

        client.on('error', (err) => {
            console.error('[POP3 Error]', err);
            if (!res.headersSent) {
                res.status(500).json({ error: 'POP3 Connection Error: ' + err.message });
            }
        });

        client.on('connect', () => {
            console.log('[POP3] Connected, logging in...');
            client.login(mailUser, mailPass);
        });

        client.on('login', (status, raw) => {
            if (status) {
                console.log('[POP3] Login success');
                client.list();
            } else {
                console.error('[POP3] Login failed:', raw);
                res.status(401).json({ error: 'Login failed: ' + raw });
            }
        });

        client.on('list', (status, msgCount, msgs, raw) => {
            if (status) {
                console.log(`[POP3] ${msgCount} messages found`);
                if (msgCount === 0) {
                    client.quit();
                    return res.json([]);
                }

                // Fetch the latest messages with optional date filter
                const fetchCount = Math.min(msgCount, limit);
                const emails = [];
                let processed = 0;
                let retrHandlerRegistered = false;

                // Register retr handler ONCE before fetching
                client.on('retr', async (status, msgid, data, raw) => {
                    processed++;
                    if (status) {
                        try {
                            const parsed = await simpleParser(data);
                            const mailDate = parsed.date || new Date();

                            // Apply date filter if specified
                            if (dateFilter && mailDate < dateFilter) {
                                // Skip emails older than the filter date
                            } else {
                                emails.push({
                                    id: `pop3-${msgid}-${Date.now()}`,
                                    sender: parsed.from?.value[0]?.name || parsed.from?.text || 'Unknown',
                                    senderEmail: parsed.from?.value[0]?.address || 'unknown@email.com',
                                    subject: parsed.subject || '(No Subject)',
                                    date: mailDate.toLocaleString(),
                                    preview: parsed.text?.substring(0, 100) || '',
                                    content: parsed.text || parsed.textAsHtml || '',
                                    attachments: (parsed.attachments || []).map(att => ({
                                        name: att.filename || 'attachment',
                                        type: att.contentType?.includes('pdf') ? 'pdf' : att.contentType?.includes('image') ? 'image' : 'other',
                                        size: `${Math.round(att.size / 1024)}KB`,
                                        url: '#',
                                        content: att.contentType?.includes('text') ? att.content.toString() : ''
                                    })),
                                    isRead: false,
                                    isFlagged: false
                                });
                            }
                        } catch (parseErr) {
                            console.error('Mail parse error:', parseErr);
                        }
                    }

                    if (processed === fetchCount) {
                        client.quit();
                        console.log(`[POP3] Returning ${emails.length} emails after filtering`);
                        res.json(emails.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()));
                    }
                });
            } else {
                console.error('[POP3] List failed:', raw);
                res.status(500).json({ error: 'List failed' });
                client.quit();
            }
        });

        client.on('quit', (status, raw) => {
            console.log('[POP3] Connection closed');
        });

    } catch (err) {
        console.error('[Backend Catch]', err);
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        }
    }
});

app.listen(PORT, () => {
    console.log(`BongLook Backend running on http://localhost:${PORT}`);
});
