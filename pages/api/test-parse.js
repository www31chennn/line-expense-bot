import { handleMessage } from '../../lib/parseExpense';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { message, userId } = req.body;
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message is required' });
  }

  try {
    const result = await handleMessage(userId || 'test-user', message, Date.now());
    return res.status(200).json(result);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'unknown error' });
  }
}