import { getMonthlyCategoryBreakdown } from '../../lib/parseExpense';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { userId, month } = req.query;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'month is required, format YYYY-MM' });
  }

  try {
    const report = await getMonthlyCategoryBreakdown(userId || 'test-user', month);
    return res.status(200).json(report);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'unknown error' });
  }
}