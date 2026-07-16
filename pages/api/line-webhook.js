import crypto from 'crypto';
import {
  handleMessage,
  getListPage,
  getMonthlyReportForMonth,
  startManageFlow,
  startEditRecord,
  deleteRecordDirect,
} from '../../lib/parseExpense';
import { resultToLineMessages, welcomeMessage } from '../../lib/lineFormat';

// 要驗證簽章必須拿到「原始」request body，所以關掉 Next.js 內建的自動 JSON 解析
export const config = {
  api: {
    bodyParser: false,
  },
};

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifySignature(rawBody, signature, channelSecret) {
  if (!signature) return false;
  const hash = crypto.createHmac('sha256', channelSecret).update(rawBody).digest('base64');
  return hash === signature;
}

async function replyMessages(replyToken, messages) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages: messages.slice(0, 5) }),
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error('LINE reply 失敗:', res.status, errText);
  }
}

async function handleEvent(event, baseUrl) {
  try {
    if (event.type === 'follow') {
      await replyMessages(event.replyToken, [welcomeMessage()]);
      return;
    }

    if (event.type === 'postback') {
      const params = new URLSearchParams(event.postback.data);
      const userId = event.source.userId;

      if (params.get('action') === 'list_more' || params.get('action') === 'list_force') {
        const category = params.get('category') || null;
        const startDate = params.get('start') || null;
        const endDate = params.get('end') || null;
        const offset = parseInt(params.get('offset'), 10) || 0;
        const result = await getListPage(userId, category, startDate, endDate, offset);
        const messages = resultToLineMessages({ type: 'list', ...result });
        await replyMessages(event.replyToken, messages);
        return;
      }

      if (params.get('action') === 'export') {
        const category = params.get('category') || '';
        const start = params.get('start') || '';
        const end = params.get('end') || '';
        const query = new URLSearchParams({ userId, ...(category && { category }), ...(start && { start }), ...(end && { end }) });
        const url = `${baseUrl}/api/export?${query.toString()}`;
        await replyMessages(event.replyToken, [{ type: 'text', text: `📊 匯出完成，點連結下載 CSV：\n${url}` }]);
        return;
      }

      if (params.get('action') === 'monthly_report') {
        const month = params.get('month');
        const result = await getMonthlyReportForMonth(userId, month, event.timestamp);
        const messages = resultToLineMessages({ type: 'monthly_report', ...result });
        await replyMessages(event.replyToken, messages);
        return;
      }

      if (params.get('action') === 'manage_start') {
        const source = params.get('source');
        const result = await startManageFlow(userId, source);
        const messages = resultToLineMessages(result);
        await replyMessages(event.replyToken, messages);
        return;
      }

      if (params.get('action') === 'edit_record') {
        const id = params.get('id');
        const result = await startEditRecord(userId, id);
        await replyMessages(event.replyToken, resultToLineMessages(result));
        return;
      }

      if (params.get('action') === 'delete_record') {
        const id = params.get('id');
        const result = await deleteRecordDirect(userId, id);
        await replyMessages(event.replyToken, resultToLineMessages(result));
        return;
      }
      return;
    }

    if (event.type === 'message' && event.message.type === 'text') {
      const userId = event.source.userId;
      const result = await handleMessage(userId, event.message.text, event.timestamp);
      const messages = resultToLineMessages(result);
      await replyMessages(event.replyToken, messages);
      return;
    }
    // 其他事件類型（unfollow、貼圖、圖片等）目前先忽略
  } catch (err) {
    console.error('處理 LINE event 時發生錯誤:', err);
    if (event.replyToken) {
      await replyMessages(event.replyToken, [{ type: 'text', text: '❌ 系統忙線中，請稍後再試一次' }]);
    }
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).end();
  }

  const rawBody = await getRawBody(req);
  const signature = req.headers['x-line-signature'];

  if (!verifySignature(rawBody, signature, process.env.LINE_CHANNEL_SECRET)) {
    return res.status(401).json({ error: 'invalid signature' });
  }

  const body = JSON.parse(rawBody.toString('utf8'));
  const events = body.events || [];

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const baseUrl = `https://${host}`;

  // 先回 200 讓 LINE 不要重送，事件用 Promise.all 平行處理
  await Promise.all(events.map((event) => handleEvent(event, baseUrl)));

  return res.status(200).json({ ok: true });
}