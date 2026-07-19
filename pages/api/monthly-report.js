import { getMonthlyCategoryBreakdown } from '../../lib/parseExpense';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { userId, month, trend } = req.query;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'month is required, format YYYY-MM' });
  }

  try {
    const uid = userId || 'test-user';

    // trend 模式：以 month 為終點往回取 N 個月（上限12），回每月總額給折線圖用
    if (trend) {
      const n = Math.min(Math.max(parseInt(trend, 10) || 6, 2), 12);
      const months = [];
      let [y, m] = month.split('-').map(Number);
      for (let i = 0; i < n; i++) {
        months.unshift(`${y}-${String(m).padStart(2, '0')}`);
        m -= 1;
        if (m === 0) {
          m = 12;
          y -= 1;
        }
      }
      const results = await Promise.all(months.map((mo) => getMonthlyCategoryBreakdown(uid, mo)));
      return res.status(200).json({
        months: months.map((mo, i) => ({ month: mo, total: results[i].total, count: results[i].count })),
      });
    }

    const report = await getMonthlyCategoryBreakdown(uid, month);
    return res.status(200).json(report);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'unknown error' });
  }
}