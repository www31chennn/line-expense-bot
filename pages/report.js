import { useEffect, useState } from 'react';
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  Legend,
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
} from 'recharts';

const COLORS = {
  飲食: '#f97066',
  交通: '#4f9cf9',
  購物: '#f9c846',
  娛樂: '#a78bfa',
  醫療: '#34d399',
  居家: '#fb923c',
  固定支出: '#5B7F76',
  其他: '#9ca3af',
};

function currentMonth() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export default function ReportPage() {
  const [month, setMonth] = useState(currentMonth());
  const [report, setReport] = useState(null);
  const [trend, setTrend] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');

    fetch(`/api/monthly-report?userId=test-user&month=${month}`)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        if (data.error) {
          setError(data.error);
          setReport(null);
        } else {
          setReport(data);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [month]);

  // 近6個月趨勢另外抓：失敗不影響主報表（折線圖缺席就好，不整頁報錯）
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/monthly-report?userId=test-user&month=${month}&trend=6`)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setTrend(data.months || null);
      })
      .catch(() => {
        if (!cancelled) setTrend(null);
      });
    return () => {
      cancelled = true;
    };
  }, [month]);

  return (
    <div style={{ maxWidth: 480, margin: '40px auto', fontFamily: 'sans-serif', padding: '0 16px' }}>
      <h2>每月分類報表</h2>

      <input
        type="month"
        value={month}
        onChange={(e) => setMonth(e.target.value)}
        style={{ padding: 8, fontSize: 16, marginBottom: 16 }}
      />

      {loading && <div style={{ color: '#999' }}>載入中...</div>}
      {error && <div style={{ color: '#a33' }}>❌ {error}</div>}

      {report && !loading && (
        <>
          <div style={{ fontSize: 18, marginBottom: 8 }}>
            {report.month} 總支出：<strong>${report.total}</strong>（共 {report.count} 筆）
          </div>

          {report.categories.length === 0 ? (
            <div style={{ color: '#999' }}>這個月還沒有任何記錄</div>
          ) : (
            <>
              <div style={{ width: '100%', height: 320 }}>
                <ResponsiveContainer>
                  <PieChart>
                    <Pie
                      data={report.categories}
                      dataKey="amount"
                      nameKey="category"
                      cx="50%"
                      cy="45%"
                      outerRadius={90}
                    >
                      {report.categories.map((entry) => (
                        <Cell key={entry.category} fill={entry.color || COLORS[entry.category] || '#9ca3af'} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(value, name) => [`$${value}`, name]} />
                    <Legend layout="horizontal" verticalAlign="bottom" wrapperStyle={{ fontSize: 12 }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>

              <table style={{ width: '100%', marginTop: 16, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'left', borderBottom: '1px solid #ddd' }}>
                    <th style={{ padding: 8 }}>分類</th>
                    <th style={{ padding: 8 }}>金額</th>
                    <th style={{ padding: 8 }}>佔比</th>
                  </tr>
                </thead>
                <tbody>
                  {report.categories.map((c) => (
                    <tr key={c.category} style={{ borderBottom: '1px solid #f0f0f0' }}>
                      <td style={{ padding: 8 }}>{c.category}</td>
                      <td style={{ padding: 8 }}>${c.amount}</td>
                      <td style={{ padding: 8 }}>{c.percentage}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {trend && trend.length > 1 && (
            <>
              <h3 style={{ marginTop: 32, marginBottom: 8, fontSize: 16 }}>近 {trend.length} 個月趨勢</h3>
              <div style={{ width: '100%', height: 220 }}>
                <ResponsiveContainer>
                  <LineChart data={trend} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                    <XAxis dataKey="month" tick={{ fontSize: 11 }} tickFormatter={(m) => m.slice(5) + '月'} />
                    <YAxis tick={{ fontSize: 11 }} width={52} />
                    <Tooltip
                      formatter={(value) => [`$${value}`, '總支出']}
                      labelFormatter={(m) => `${m}（${(trend.find((t) => t.month === m) || {}).count ?? 0} 筆）`}
                    />
                    <Line type="monotone" dataKey="total" stroke="#5B7F76" strokeWidth={2} dot={{ r: 3 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}