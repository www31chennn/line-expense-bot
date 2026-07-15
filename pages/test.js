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
// onListMore(params): 列表分頁，params 帶著 category/startDate/endDate/offset
// onCategoryDetail(category): 從預算狀態點某個分類，看該分類明細
function renderResult(result, onSelectIndex, onDeleteIndex, onSelectCategory, onListMore, onCategoryDetail, onMonthlyReport) {
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
      <div
        style={{
          border: '1px solid #e5e5e5',
          borderRadius: 12,
          overflow: 'hidden',
          maxWidth: 320,
          boxShadow: '0 1px 4px rgba(0,0,0,0.1)',
        }}
      >
        <div style={{ background: '#5B7F76', color: '#fff', padding: '10px 14px' }}>
          <div style={{ fontSize: 12, opacity: 0.85 }}>✅ 預算已設定</div>
          {b.monthlyLimit != null && <div style={{ fontSize: 22, fontWeight: 'bold' }}>${b.monthlyLimit} / 月</div>}
          <div style={{ fontSize: 12, opacity: 0.85 }}>
            薪水 ${b.salary ?? '未設定'}
            {b.savingsGoal != null && `，目標存 $${b.savingsGoal}`}
            {b.spendingPercentage != null && `，最多花 ${b.spendingPercentage}%`}
          </div>
        </div>
        {result.categories && result.categories.length > 0 && (
          <div style={{ padding: '10px 14px' }}>
            {result.categories.map((c) => {
              const hasAmount = c.allocatedAmount != null;
              const pct = hasAmount ? Math.min(100, Math.round((c.spent / c.allocatedAmount) * 100)) : c.percentage;
              return (
                <div key={c.category} style={{ marginBottom: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                    <span>{c.category}</span>
                    <span style={{ color: '#999' }}>{c.percentage}%</span>
                  </div>
                  <div style={{ background: '#eee', borderRadius: 4, height: 6 }}>
                    <div
                      style={{
                        width: `${Math.min(100, pct)}%`,
                        background: CATEGORY_COLORS[c.category],
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

  if (result.type === 'adjust_category_menu') {
    return (
      <div style={{ color: '#1a5cad' }}>
        <div>🎯 要調整哪個分類的比例？</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
          {Object.keys(CATEGORY_COLORS).map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => onSelectCategory(`調整${cat}比例`)}
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

  if (result.type === 'adjust_category_percent_step') {
    const options = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50];
    return (
      <div style={{ color: '#b8860b' }}>
        <div>
          📊 {result.category} 目前是 {result.current}%，要改成多少？
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
          {options.map((pct) => (
            <button
              key={pct}
              type="button"
              style={{ ...buttonStyle, width: 'auto' }}
              onClick={() => onSelectCategory(`修改${result.category}為${pct}%`)}
            >
              {pct}%
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (result.type === 'set_category_budget') {
    if (result.missingPercentage) {
      return (
        <div style={{ color: '#b8860b' }}>
          ❓ 要改成多少%？{result.category ? `（${result.category}）` : ''}例如「修改{result.category || '飲食'}為30%」
        </div>
      );
    }
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
                      {hasAmount ? `${c.percentage}% · $${c.spent}/$${c.allocatedAmount}` : `${c.percentage}%`}
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
        {result.categories && result.categories.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
            {result.categories.map((c) => (
              <button
                key={c.category}
                type="button"
                onClick={() => onCategoryDetail(c.category)}
                style={{
                  padding: '4px 10px',
                  border: `1px solid ${CATEGORY_COLORS[c.category] || '#999'}`,
                  borderRadius: 14,
                  background: '#fff',
                  color: CATEGORY_COLORS[c.category] || '#999',
                  cursor: 'pointer',
                  fontSize: 12,
                }}
              >
                {c.category} 明細
              </button>
            ))}
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

  if (result.type === 'list_scope_prompt') {
    const cat = result.category;
    const catLabel = cat || '所有記錄';
    const scopeText = (label) => (cat ? `列出${label}${cat}` : `列出${label}所有記錄`);
    return (
      <div style={{ color: '#b8860b' }}>
        <div>❓ 要看哪個範圍的{catLabel}？</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
          <button type="button" style={{ ...buttonStyle, width: 'auto' }} onClick={() => onSelectCategory(scopeText('這個月'))}>
            本月
          </button>
          <button type="button" style={{ ...buttonStyle, width: 'auto' }} onClick={() => onSelectCategory(scopeText('上個月'))}>
            上個月
          </button>
          <button type="button" style={{ ...buttonStyle, width: 'auto' }} onClick={() => onSelectCategory(scopeText('今年'))}>
            今年
          </button>
          <button type="button" style={{ ...buttonStyle, width: 'auto' }} onClick={() => onSelectCategory(scopeText('去年'))}>
            去年
          </button>
          <button
            type="button"
            style={{ ...buttonStyle, width: 'auto' }}
            onClick={() => onSelectCategory(cat ? `列出不限日期的${cat}` : '列出不限日期的所有記錄')}
          >
            不限日期
          </button>
        </div>
      </div>
    );
  }

  if (result.type === 'list') {
    if (result.records.length === 0) {
      return <div style={{ color: '#999' }}>📋 沒有符合條件的記錄</div>;
    }
    const exportHref = `/api/export?userId=test-user${result.category ? `&category=${encodeURIComponent(result.category)}` : ''}${result.startDate ? `&start=${result.startDate}` : ''}${result.endDate ? `&end=${result.endDate}` : ''}`;
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
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          {result.hasMore && (
            <button
              type="button"
              style={{ ...buttonStyle, width: 'auto', color: '#1a5cad', fontWeight: 'bold' }}
              onClick={() =>
                onListMore({
                  category: result.category,
                  startDate: result.startDate,
                  endDate: result.endDate,
                  offset: result.nextOffset,
                })
              }
            >
              看更多 ↓
            </button>
          )}
          <a href={exportHref} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
            <button type="button" style={{ ...buttonStyle, width: 'auto', color: '#0a7d32', borderColor: '#0a7d32' }}>
              📊 匯出這份Excel
            </button>
          </a>
        </div>
      </div>
    );
  }

  if (result.type === 'confirm_category_cancelled') {
    return (
      <div style={{ color: '#999' }}>
        ❌ 已取消，這筆沒有記錄{result.skippedCount > 1 ? `（連同待確認的其他 ${result.skippedCount - 1} 筆一起取消）` : ''}
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
          <button
            type="button"
            onClick={() => onSelectCategory('取消')}
            style={{
              padding: '6px 12px',
              border: '1px solid #999',
              borderRadius: 16,
              background: '#fff',
              color: '#999',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            ❌ 取消
          </button>
        </div>
      </div>
    );
  }

  if (result.type === 'manage_unspecified') {
    if (result.candidates.length === 0) {
      return <div style={{ color: '#999' }}>📋 目前沒有任何記錄</div>;
    }
    const headerText = result.fromLastList
      ? '❓ 要編輯或刪除剛剛列出的哪一筆？'
      : `❓ 要編輯或刪除哪一筆？（顯示最近 ${result.candidates.length} 筆）`;
    return (
      <div style={{ color: '#b8860b' }}>
        <div>{headerText}</div>
        <div style={{ marginTop: 4 }}>
          {result.candidates.map((r) => (
            <button key={r.id} type="button" style={buttonStyle} onClick={() => onSelectIndex(r.index)}>
              #{r.index} {r.date} {r.item} ${r.amount}（{r.category}）
            </button>
          ))}
          <button
            type="button"
            style={{ ...buttonStyle, color: '#999' }}
            onClick={() => onSelectCategory('取消')}
          >
            ❌ 取消
          </button>
        </div>
      </div>
    );
  }

  if (result.type === 'choose_action') {
    const r = result.record;
    return (
      <div style={{ color: '#b8860b' }}>
        {result.invalid && <div style={{ color: '#a33', fontSize: 13, marginBottom: 4 }}>⚠️ 看不懂，請點下面按鈕：</div>}
        <div>
          ✏️ 選好了：{r.date} {r.item} ${r.amount}（{r.category}）
        </div>
        <div>要編輯還是刪除？</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <button
            type="button"
            onClick={() => onSelectCategory('編輯')}
            style={{ padding: '6px 14px', border: '1px solid #b8860b', borderRadius: 16, background: '#fff', color: '#b8860b', cursor: 'pointer' }}
          >
            ✏️ 編輯
          </button>
          <button
            type="button"
            onClick={() => onSelectCategory('刪除')}
            style={{ padding: '6px 14px', border: '1px solid #a33', borderRadius: 16, background: '#fff', color: '#a33', cursor: 'pointer' }}
          >
            🗑️ 刪除
          </button>
          <button
            type="button"
            onClick={() => onSelectCategory('取消')}
            style={{ padding: '6px 14px', border: '1px solid #999', borderRadius: 16, background: '#fff', color: '#999', cursor: 'pointer' }}
          >
            ❌ 取消
          </button>
        </div>
      </div>
    );
  }

  if (result.type === 'manage_cancelled') {
    return <div style={{ color: '#999' }}>❌ 已取消</div>;
  }

  if (result.type === 'budget_help') {
    return (
      <div style={{ color: '#1a5cad', fontSize: 14 }}>
        💰 跟我說「薪水50000，目標存15000」或「薪水50000，最多花70%」，我就會幫你算出每月可花上限。
        <br />
        之後想改分類比例可以說「修改飲食為30%」，或用按鈕調整。
        <div style={{ marginTop: 6 }}>
          <button
            type="button"
            style={{ ...buttonStyle, width: 'auto' }}
            onClick={() => onSelectCategory('調整分類比例')}
          >
            🎯 用按鈕調整比例
          </button>
        </div>
      </div>
    );
  }

  if (result.type === 'list_menu') {
    const ranges = [
      { label: '本日', text: '列出今天所有記錄' },
      { label: '本週', text: '列出這週所有記錄' },
      { label: '本月', text: '列出這個月所有記錄' },
      { label: '今年', text: '列出今年所有記錄' },
      { label: '去年', text: '列出去年所有記錄' },
      { label: '其他區間', text: '自訂區間' },
    ];
    return (
      <div style={{ color: '#1a5cad' }}>
        <div>📋 要看哪個範圍的明細？</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
          {ranges.map((r) => (
            <button
              key={r.label}
              type="button"
              style={{ ...buttonStyle, width: 'auto' }}
              onClick={() => onSelectCategory(r.text)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (result.type === 'custom_range_help') {
    return (
      <div style={{ color: '#1a5cad', fontSize: 14 }}>
        📅 跟我說想查的區間就好，例如「列出7/1到7/15的記錄」「列出3月的飲食」，日期我會自動幫你抓。
      </div>
    );
  }

  if (result.type === 'help') {
    return (
      <div style={{ color: '#2b2b2b', fontSize: 14, lineHeight: 1.7 }}>
        <div style={{ fontWeight: 'bold', marginBottom: 4 }}>💡 使用說明</div>
        ✏️ 記帳：直接打字，例如「午餐100元」，一次多筆也可以「午餐100，晚餐300」
        <br />
        📋 查詢：「明細」看指定範圍，或直接說「這個月花多少」看總額
        <br />
        💰 預算：「設定預算」設定薪水/目標，「修改飲食為30%」調整分類比例
        <br />
        ✏️🗑️ 編輯/刪除：「編輯記錄」選一筆來改或刪，過程中隨時可以打「取消」
        <br />
        📊 匯出：查完明細後，清單下方會有「匯出Excel」按鈕可以下載
        <br />
        <span style={{ color: '#999' }}>需要選擇的時候我會跳出按鈕，點選就好，不用打字。</span>
      </div>
    );
  }

  if (result.type === 'monthly_report') {
    if (result.categories.length === 0) {
      return <div style={{ color: '#999' }}>🧾 {result.month} 還沒有任何記錄</div>;
    }
    const ranked = [...result.categories].sort((a, b) => b.amount - a.amount);
    const medals = ['🥇', '🥈', '🥉'];
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
        <div style={{ background: '#5B7F76', color: '#fff', padding: '10px 14px' }}>
          <div style={{ fontSize: 12, opacity: 0.85 }}>🧾 {result.month} 消費報表</div>
          <div style={{ fontSize: 22, fontWeight: 'bold' }}>${result.total}</div>
          <div style={{ fontSize: 12, opacity: 0.85 }}>共 {result.count} 筆</div>
        </div>
        <div style={{ padding: '12px 14px' }}>
          {/* 單一疊層長條：所有分類接在同一條裡 */}
          <div style={{ display: 'flex', height: 16, borderRadius: 8, overflow: 'hidden', marginBottom: 12 }}>
            {ranked.map((c) => (
              <div
                key={c.category}
                style={{ width: `${c.percentage}%`, background: CATEGORY_COLORS[c.category] || '#9ca3af' }}
              />
            ))}
          </div>
          {ranked.map((c, i) => (
            <div key={c.category} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 13 }}>
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 5,
                  background: CATEGORY_COLORS[c.category] || '#9ca3af',
                  display: 'inline-block',
                }}
              />
              <span style={{ flex: 1 }}>
                {medals[i] || `${i + 1}.`} {c.category}
              </span>
              <span style={{ fontWeight: i < 3 ? 'bold' : 'normal' }}>${c.amount}</span>
              <span style={{ color: '#999', width: 40, textAlign: 'right' }}>{c.percentage}%</span>
            </div>
          ))}
        </div>
        {result.recentMonths && result.recentMonths.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '0 14px 12px' }}>
            {result.recentMonths.map((m) => (
              <button
                key={m}
                type="button"
                style={{ ...buttonStyle, width: 'auto', fontSize: 12 }}
                onClick={() => onMonthlyReport(m)}
              >
                {parseInt(m.split('-')[1], 10)}月
              </button>
            ))}
          </div>
        )}
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
          <button
            type="button"
            style={{ ...buttonStyle, color: '#999' }}
            onClick={() => onSelectCategory('取消')}
          >
            ❌ 取消
          </button>
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

  // 分頁專用：直接帶查詢條件跟 offset，不經過 AI 分類，不依賴任何全域狀態
  async function sendListMore(params) {
    setLoading(true);
    try {
      const res = await fetch('/api/test-parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ listMore: params, userId: 'test-user' }),
      });
      const data = await res.json();
      setHistory((prev) => [...prev, { userMsg: '看更多', result: data }]);
    } catch (err) {
      setHistory((prev) => [...prev, { userMsg: '看更多', result: { error: err.message } }]);
    } finally {
      setLoading(false);
    }
  }

  async function sendReportMonth(month) {
    setLoading(true);
    try {
      const res = await fetch('/api/test-parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reportMonth: month, userId: 'test-user' }),
      });
      const data = await res.json();
      setHistory((prev) => [...prev, { userMsg: `${month} 報表`, result: data }]);
    } catch (err) {
      setHistory((prev) => [...prev, { userMsg: `${month} 報表`, result: { error: err.message } }]);
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
    { label: '📋 明細', text: '明細' },
    { label: '💰 預算狀態', text: '這個月還剩多少可以花' },
    { label: '⚙️ 設定預算', text: '設定預算' },
    { label: '✏️ 編輯記錄', text: '我要編輯' },
    { label: '💡 使用說明', text: '使用說明' },
    { label: '🧾 月報表', text: '月報表' },
  ];

  return (
    <div style={{ maxWidth: 480, margin: '40px auto', fontFamily: 'sans-serif', padding: '0 16px 100px' }}>
      <h2>記帳測試（本機用，不會出現在正式 LINE 畫面）</h2>
      <div style={{ fontSize: 13, color: '#999', marginBottom: 8 }}>
        右下角是常駐選單（LINE 上會做成 Rich Menu），月報表跟明細都是卡片式呈現
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
                (category) => sendMessage(category),
                (params) => sendListMore(params),
                (category) => sendMessage(`列出這個月${category}`),
                (month) => sendReportMonth(month)
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