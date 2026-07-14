import { useState } from 'react';

const CATEGORY_LABELS = {
  飲食: '🍜 飲食',
  交通: '🚗 交通',
  購物: '🛍️ 購物',
  娛樂: '🎮 娛樂',
  醫療: '🏥 醫療',
  居家: '🏠 居家',
  其他: '📦 其他',
};

const buttonStyle = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  padding: '6px 10px',
  marginTop: 4,
  border: '1px solid #ccc',
  borderRadius: 6,
  background: '#fff',
  cursor: 'pointer',
  fontSize: 14,
};

const CATEGORY_COLORS = {
  飲食: '#f97066',
  交通: '#4f9cf9',
  購物: '#f9c846',
  娛樂: '#a78bfa',
  醫療: '#34d399',
  居家: '#fb923c',
  其他: '#9ca3af',
};

function budgetIcon(level) {
  if (level === 'over') return '🚨';
  if (level === 'warning') return '⚠️';
  return '💰';
}

// onSelectIndex(index): 選了 ambiguous 清單裡的第幾筆
// onDeleteIndex(index): 想直接刪除 list 清單裡的第幾筆
// onSelectCategory(category): 回答「這筆算哪一類」
function renderResult(result, onSelectIndex, onDeleteIndex, onSelectCategory) {
  if (result.error) {
    return <div style={{ color: '#a33' }}>❌ {result.error}</div>;
  }

  if (result.type === 'record') {
    return (
      <div>
        {result.expenses.map((e, i) => (
          <div key={i} style={{ color: '#0a7d32' }}>
            ✅ {e.date} {e.item} ${e.amount}（{e.category}）
          </div>
        ))}
        {result.budgetStatus && (
          <div style={{ fontSize: 13, color: '#666', marginTop: 4 }}>
            {budgetIcon(result.budgetStatus.warningLevel)} 本月已花 ${result.budgetStatus.spent} / $
            {result.budgetStatus.monthlyLimit}（{result.budgetStatus.percentageUsed}%），
            {result.budgetStatus.remaining >= 0
              ? `還可以花 $${result.budgetStatus.remaining}`
              : `已超支 $${Math.abs(result.budgetStatus.remaining)}`}
          </div>
        )}
        {result.categoryWarnings && result.categoryWarnings.length > 0 && (
          <div style={{ marginTop: 6 }}>
            {result.categoryWarnings.map((c) => (
              <div
                key={c.category}
                style={{
                  fontSize: 13,
                  color: c.warningLevel === 'over' ? '#a33' : '#b8860b',
                  fontWeight: 'bold',
                }}
              >
                {c.warningLevel === 'over' ? '🚨' : '⚠️'} {c.category}
                {c.warningLevel === 'over'
                  ? `已超支 $${Math.abs(c.remaining)}`
                  : `已用 ${Math.round((c.spent / c.allocatedAmount) * 100)}%（剩 $${c.remaining}）`}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (result.type === 'set_budget') {
    const b = result.budget;
    return (
      <div style={{ color: '#0a7d32' }}>
        ✅ 已設定：薪水 ${b.salary ?? '未設定'}
        {b.savingsGoal != null && `，目標存 $${b.savingsGoal}`}
        {b.spendingPercentage != null && `，最多花薪水的 ${b.spendingPercentage}%`}
        {b.monthlyLimit != null && `，每月可花上限 $${b.monthlyLimit}`}
      </div>
    );
  }

  if (result.type === 'set_category_budget') {
    if (result.invalid) {
      return <div style={{ color: '#a33' }}>⚠️ 不是有效的分類名稱</div>;
    }
    const entries = Object.entries(result.allocation);
    return (
      <div style={{ color: '#0a7d32' }}>
        <div>✅ 已調整分類比例：</div>
        <div style={{ fontSize: 14, marginTop: 4 }}>
          {entries.map(([cat, pct]) => (
            <div key={cat}>
              {cat}：{pct}%
              {result.monthlyLimit != null && ` （總額度 $${Math.round((result.monthlyLimit * pct) / 100)}）`}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (result.type === 'query_category_budget') {
    return (
      <div>
        <div style={{ color: '#1a5cad', fontSize: 13, marginBottom: 6 }}>
          📊 {result.month} 分類預算{result.monthlyLimit == null && '（尚未設定月預算上限，只顯示比例）'}
        </div>
        {result.table.map((c) => {
          const hasAmount = c.allocatedAmount != null;
          const pct = hasAmount ? Math.min(100, Math.round((c.spent / c.allocatedAmount) * 100)) : c.percentage;
          const barColor =
            c.warningLevel === 'over' ? '#a33' : c.warningLevel === 'warning' ? '#b8860b' : CATEGORY_COLORS[c.category];
          return (
            <div key={c.category} style={{ marginBottom: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                <span>{c.category}</span>
                <span style={{ color: '#999' }}>{hasAmount ? `$${c.spent}/$${c.allocatedAmount}` : `${c.percentage}%`}</span>
              </div>
              <div style={{ background: '#eee', borderRadius: 4, height: 6 }}>
                <div style={{ width: `${Math.min(100, pct)}%`, background: barColor, height: 6, borderRadius: 4 }} />
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  if (result.type === 'budget_status') {
    const overallColor =
      result.warningLevel === 'over' ? '#a33' : result.warningLevel === 'warning' ? '#b8860b' : '#1a5cad';
    return (
      <div>
        {result.notSet ? (
          <div style={{ color: '#999', marginBottom: 8 }}>
            ⚠️ 還沒有設定薪水或目標，先跟我說「薪水50000，目標存15000」之類的
          </div>
        ) : (
          <div style={{ color: overallColor, marginBottom: 10 }}>
            {budgetIcon(result.warningLevel)} {result.month} 已花 ${result.spent} / ${result.monthlyLimit}（
            {result.percentageUsed}%）
            <br />
            {result.remaining >= 0 ? `還可以花 $${result.remaining}` : `已超支 $${Math.abs(result.remaining)}`}
          </div>
        )}
        {result.categories && result.categories.length > 0 && (
          <div>
            {result.categories.map((c) => {
              const hasAmount = c.allocatedAmount != null;
              const pct = hasAmount ? Math.min(100, Math.round((c.spent / c.allocatedAmount) * 100)) : c.percentage;
              const barColor =
                c.warningLevel === 'over' ? '#a33' : c.warningLevel === 'warning' ? '#b8860b' : CATEGORY_COLORS[c.category];
              return (
                <div key={c.category} style={{ marginBottom: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                    <span>{c.category}</span>
                    <span style={{ color: '#999' }}>
                      {hasAmount ? `$${c.spent}/$${c.allocatedAmount}` : `${c.percentage}%`}
                    </span>
                  </div>
                  <div style={{ background: '#eee', borderRadius: 4, height: 6 }}>
                    <div
                      style={{
                        width: `${Math.min(100, pct)}%`,
                        background: barColor,
                        height: 6,
                        borderRadius: 4,
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  if (result.type === 'query') {
    const entries = Object.entries(result.byCategory || {});
    return (
      <div style={{ color: '#1a5cad' }}>
        <div>
          📊 {result.label}
          {result.category ? `（${result.category}）` : ''}：共 {result.count} 筆，
          總計 ${result.total}
        </div>
        {entries.length > 1 && (
          <div style={{ marginTop: 4, fontSize: 14, color: '#555' }}>
            {entries.map(([cat, amt]) => (
              <div key={cat}>
                {CATEGORY_LABELS[cat] || cat}：${amt}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (result.type === 'delete_last') {
    if (result.empty) {
      return <div style={{ color: '#a33' }}>⚠️ 沒有找到可以刪除的記錄</div>;
    }
    const d = result.deleted;
    return (
      <div style={{ color: '#a33' }}>
        🗑️ 已刪除：{d.date} {d.item} ${d.amount}（{d.category}）
      </div>
    );
  }

  if (result.type === 'modify_last') {
    if (result.empty) {
      return <div style={{ color: '#a33' }}>⚠️ 沒有找到可以修改的記錄</div>;
    }
    const r = result.record;
    if (result.record.unchanged) {
      return <div style={{ color: '#a33' }}>⚠️ 沒有偵測到要修改的內容</div>;
    }
    return (
      <div style={{ color: '#b8860b' }}>
        ✏️ 已修改為：{r.date} {r.item} ${r.amount}（{r.category}）
      </div>
    );
  }

  if (result.type === 'list') {
    if (result.records.length === 0) {
      return <div style={{ color: '#999' }}>📋 沒有符合條件的記錄</div>;
    }
    return (
      <div style={{ color: '#1a5cad' }}>
        <div>
          📋 共 {result.count} 筆，總計 ${result.total}
        </div>
        <div style={{ marginTop: 4, fontSize: 14 }}>
          {result.records.map((r) => (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <span>
                #{r.index} {r.date} {r.item} ${r.amount}（{r.category}）
              </span>
              <button
                type="button"
                onClick={() => onDeleteIndex(r.index)}
                style={{
                  border: '1px solid #e0a0a0',
                  background: '#fff5f5',
                  color: '#a33',
                  borderRadius: 4,
                  padding: '2px 8px',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                🗑️ 刪除
              </button>
            </div>
          ))}
        </div>
        {result.hasMore && (
          <button
            type="button"
            style={{ ...buttonStyle, marginTop: 8, color: '#1a5cad', fontWeight: 'bold' }}
            onClick={() => onSelectIndex('看更多')}
          >
            看更多 ↓
          </button>
        )}
      </div>
    );
  }

  if (result.type === 'record_with_confirm' || result.type === 'confirm_category') {
    const item = result.item;
    return (
      <div>
        {result.savedExpenses &&
          result.savedExpenses.map((e, i) => (
            <div key={i} style={{ color: '#0a7d32' }}>
              ✅ {e.date} {e.item} ${e.amount}（{e.category}）
            </div>
          ))}
        {result.savedItem && (
          <div style={{ color: '#0a7d32' }}>
            ✅ {result.savedItem.date} {result.savedItem.item} ${result.savedItem.amount}（
            {result.savedItem.category}）
          </div>
        )}
        {result.invalid && (
          <div style={{ color: '#a33', fontSize: 13, marginBottom: 4 }}>⚠️ 不是有效的分類，請從下面選：</div>
        )}
        <div style={{ color: '#b8860b', marginTop: 4 }}>
          ❓ 「{item.item} ${item.amount}」這筆算哪一類？
          {result.remaining > 1 && <span style={{ fontSize: 12, color: '#999' }}>（還有 {result.remaining - 1} 筆待確認）</span>}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
          {result.options.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => onSelectCategory(cat)}
              style={{
                padding: '6px 12px',
                border: `1px solid ${CATEGORY_COLORS[cat]}`,
                borderRadius: 16,
                background: '#fff',
                color: CATEGORY_COLORS[cat],
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (result.type === 'export_report') {
    if (result.categories.length === 0) {
      return <div style={{ color: '#999' }}>🧾 {result.month} 還沒有任何記錄</div>;
    }
    const maxAmount = Math.max(...result.categories.map((c) => c.amount));
    return (
      <div
        style={{
          border: '1px solid #e5e5e5',
          borderRadius: 12,
          overflow: 'hidden',
          maxWidth: 320,
          boxShadow: '0 1px 4px rgba(0,0,0,0.1)',
        }}
      >
        <div style={{ background: '#333', color: '#fff', padding: '10px 14px' }}>
          <div style={{ fontSize: 12, opacity: 0.8 }}>🧾 {result.month} 消費總覽</div>
          <div style={{ fontSize: 22, fontWeight: 'bold' }}>${result.total}</div>
          {result.monthlyLimit != null && (
            <div style={{ fontSize: 12, opacity: 0.8 }}>
              預算 ${result.monthlyLimit}（{Math.round((result.total / result.monthlyLimit) * 100)}%）
            </div>
          )}
        </div>
        <div style={{ padding: '10px 14px' }}>
          {result.categories.map((c) => (
            <div key={c.category} style={{ marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                <span>{c.category}</span>
                <span>
                  ${c.amount}（{c.percentage}%）
                </span>
              </div>
              <div style={{ background: '#eee', borderRadius: 4, height: 6, marginTop: 2 }}>
                <div
                  style={{
                    width: `${(c.amount / maxAmount) * 100}%`,
                    background: CATEGORY_COLORS[c.category] || '#9ca3af',
                    height: 6,
                    borderRadius: 4,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (result.type === 'edit_unspecified') {
    if (result.candidates.length === 0) {
      return <div style={{ color: '#999' }}>📋 目前沒有任何記錄</div>;
    }
    return (
      <div style={{ color: '#b8860b' }}>
        <div>❓ 要{result.action === 'delete' ? '刪除' : '編輯'}哪一筆？（顯示最近 {result.candidates.length} 筆）</div>
        <div style={{ marginTop: 4 }}>
          {result.candidates.map((r) => (
            <button key={r.id} type="button" style={buttonStyle} onClick={() => onSelectIndex(r.index)}>
              #{r.index} {r.date} {r.item} ${r.amount}（{r.category}）
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (result.type === 'awaiting_value') {
    const r = result.record;
    return (
      <div style={{ color: '#b8860b' }}>
        ✏️ 選好了：{r.date} {r.item} ${r.amount}（{r.category}）
        <br />
        要改成什麼？（例如「80元」「改成晚餐」直接打字回覆）
      </div>
    );
  }

  if (result.type === 'ambiguous') {
    return (
      <div style={{ color: '#b8860b' }}>
        <div>⚠️ 找到多筆符合的記錄，請選要{result.action === 'delete' ? '刪除' : '修改'}哪一筆：</div>
        <div style={{ marginTop: 4 }}>
          {result.candidates.map((r) => (
            <button key={r.id} type="button" style={buttonStyle} onClick={() => onSelectIndex(r.index)}>
              #{r.index} {r.date} {r.item} ${r.amount}（{r.category}）
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (result.type === 'not_found') {
    return <div style={{ color: '#a33' }}>⚠️ 沒有找到符合的記錄</div>;
  }

  if (result.type === 'delete_specific') {
    const d = result.deleted;
    return (
      <div style={{ color: '#a33' }}>
        🗑️ 已刪除：{d.date} {d.item} ${d.amount}（{d.category}）
      </div>
    );
  }

  if (result.type === 'modify_specific') {
    if (result.unchanged) {
      return <div style={{ color: '#a33' }}>⚠️ 沒有偵測到要修改的內容</div>;
    }
    const r = result.record;
    return (
      <div style={{ color: '#b8860b' }}>
        ✏️ 已修改為：{r.date} {r.item} ${r.amount}（{r.category}）
      </div>
    );
  }

  return <div style={{ color: '#a33' }}>🤔 沒有偵測到記帳或查詢意圖</div>;
}

export default function TestPage() {
  const [message, setMessage] = useState('');
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);

  // 統一的送出函式：不管是手打送出，還是點按鈕觸發，都走這一條
  async function sendMessage(text) {
    if (!text || !text.trim()) return;
    setLoading(true);
    try {
      const res = await fetch('/api/test-parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, userId: 'test-user' }),
      });
      const data = await res.json();
      setHistory((prev) => [...prev, { userMsg: text, result: data }]);
    } catch (err) {
      setHistory((prev) => [...prev, { userMsg: text, result: { error: err.message } }]);
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit(e) {
    e.preventDefault();
    const text = message;
    setMessage('');
    sendMessage(text);
  }

  const quickActions = [
    { label: '📅 今日明細', text: '列出今天所有記錄' },
    { label: '🗓️ 本月明細', text: '列出這個月所有記錄' },
    { label: '💰 預算狀態', text: '這個月還剩多少可以花' },
    { label: '📊 分類預算', text: '各分類預算是多少' },
    { label: '🧾 匯出報表', text: '匯出報表' },
    { label: '✏️ 編輯', text: '我要編輯' },
    { label: '🗑️ 刪除', text: '我要刪除一筆' },
  ];

  return (
    <div style={{ maxWidth: 480, margin: '40px auto', fontFamily: 'sans-serif', padding: '0 16px 100px' }}>
      <h2>記帳測試（本機用，不會出現在正式 LINE 畫面）</h2>
      <div style={{ fontSize: 13, color: '#999', marginBottom: 8 }}>
        右下角是常駐選單（LINE 上會做成 Rich Menu），📊 完整分類報表在 <a href="/report">/report</a>
      </div>
      <div
        style={{
          border: '1px solid #ddd',
          borderRadius: 8,
          padding: 16,
          minHeight: 300,
          marginBottom: 16,
        }}
      >
        {history.length === 0 && (
          <div style={{ color: '#999' }}>
            試試看：「今天午餐吃200元」「列出所有醫療」「7/12的點心改成80元」，或直接點右下角按鈕
          </div>
        )}
        {history.map((h, i) => (
          <div key={i} style={{ marginBottom: 12 }}>
            <div style={{ textAlign: 'right', color: '#333' }}>🗣️ {h.userMsg}</div>
            <div style={{ textAlign: 'left', marginTop: 4 }}>
              {renderResult(
                h.result,
                (index) => sendMessage(String(index)),
                (index) => sendMessage(`刪除第${index}筆`),
                (category) => sendMessage(category)
              )}
            </div>
          </div>
        ))}
        {loading && <div style={{ color: '#999' }}>解析中...</div>}
      </div>
      <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 8 }}>
        <input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="今天午餐吃200元 / 這個月花多少"
          style={{ flex: 1, padding: 8, fontSize: 16 }}
        />
        <button type="submit" disabled={loading}>
          送出
        </button>
      </form>

      {/* 常駐懸浮選單：模擬 LINE Rich Menu，點了等同幫你打好字送出 */}
      <div
        style={{
          position: 'fixed',
          bottom: 16,
          right: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          background: '#fff',
          border: '1px solid #ddd',
          borderRadius: 12,
          padding: 8,
          boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
        }}
      >
        {quickActions.map((a) => (
          <button
            key={a.text}
            type="button"
            disabled={loading}
            onClick={() => sendMessage(a.text)}
            style={{
              padding: '8px 12px',
              border: '1px solid #ccc',
              borderRadius: 8,
              background: '#f7f7f7',
              cursor: 'pointer',
              fontSize: 14,
              whiteSpace: 'nowrap',
            }}
          >
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}