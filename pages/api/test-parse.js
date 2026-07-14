import { handleMessage, getListPage } from '../../lib/parseExpense';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { message, userId, listMore } = req.body;
  const uid = userId || 'test-user';

  try {
    if (listMore) {
      const result = await getListPage(uid, listMore.category, listMore.startDate, listMore.endDate, listMore.offset);
      return res.status(200).json({ type: 'list', ...result });
    }

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message is required' });
    }
    const result = await handleMessage(uid, message, Date.now());
    return res.status(200).json(result);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'unknown error' });
  }
}