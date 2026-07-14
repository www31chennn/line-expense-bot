const CATEGORY_EMOJI = {
  飲食: '🍜',
  交通: '🚗',
  購物: '🛍️',
  娛樂: '🎮',
  醫療: '🏥',
  居家: '🏠',
  其他: '📦',
};

// LINE Quick Reply 上限：最多 13 顆，每顆 label 上限 20 字
function quickReplyFromIndexed(records) {
  return {
    items: records.slice(0, 13).map((r) => ({
      type: 'action',
      action: {
        type: 'message',
        label: `#${r.index} ${r.item}`.slice(0, 20),
        text: String(r.index),
      },
    })),
  };
}

function quickReplyFromCategories(options) {
  const items = options.slice(0, 12).map((cat) => ({
    type: 'action',
    action: {
      type: 'message',
      label: `${CATEGORY_EMOJI[cat] || ''} ${cat}`.slice(0, 20),
      text: cat,
    },
  }));
  items.push({
    type: 'action',
    action: { type: 'message', label: '❌ 取消', text: '取消' },
  });
  return { items };
}

function budgetLine(status) {
  if (!status) return '';
  const icon = status.warningLevel === 'over' ? '🚨' : status.warningLevel === 'warning' ? '⚠️' : '💰';
  const balance =
    status.remaining >= 0 ? `還可以花 $${status.remaining}` : `已超支 $${Math.abs(status.remaining)}`;
  return `\n${icon} 本月已花 $${status.spent}/$${status.monthlyLimit}（${status.percentageUsed}%），${balance}`;
}

function categoryWarningLines(warnings) {
  if (!warnings || warnings.length === 0) return '';
  return warnings
    .map((c) => {
      const icon = c.warningLevel === 'over' ? '🚨' : '⚠️';
      const detail =
        c.warningLevel === 'over'
          ? `已超支 $${Math.abs(c.remaining)}`
          : `已用 ${Math.round((c.spent / c.allocatedAmount) * 100)}%（剩 $${c.remaining}）`;
      return `\n${icon} ${c.category}${detail}`;
    })
    .join('');
}

function categoryBarRows(categories) {
  return categories.map((c) => {
    const hasAmount = c.allocatedAmount != null;
    const pct = hasAmount ? Math.min(100, Math.round((c.spent / c.allocatedAmount) * 100)) : Math.min(100, c.percentage);
    const barColor = c.warningLevel === 'over' ? '#E4572E' : c.warningLevel === 'warning' ? '#E0A72E' : '#5B7F76';
    const rightLabel = hasAmount ? `$${c.spent}/$${c.allocatedAmount}` : `${c.percentage}%`;
    const safePct = Math.max(0, Math.min(100, pct));
    return {
      type: 'box',
      layout: 'vertical',
      margin: 'md',
      spacing: 'xs',
      contents: [
        {
          type: 'box',
          layout: 'horizontal',
          contents: [
            { type: 'text', text: `${CATEGORY_EMOJI[c.category] || ''} ${c.category}`, size: 'sm', flex: 3 },
            { type: 'text', text: rightLabel, size: 'xs', color: '#999999', align: 'end', flex: 4 },
          ],
        },
        {
          type: 'box',
          layout: 'horizontal',
          height: '6px',
          cornerRadius: '3px',
          backgroundColor: '#EAEAEA',
          contents: [
            { type: 'box', layout: 'vertical', flex: Math.max(1, safePct), backgroundColor: barColor, contents: [] },
            { type: 'box', layout: 'vertical', flex: Math.max(1, 100 - safePct), contents: [] },
          ],
        },
      ],
    };
  });
}

function budgetOverviewFlex(result) {
  const headerContents = [];
  if (result.notSet) {
    headerContents.push({ type: 'text', text: '💰 分類預算', color: '#ffffff', size: 'sm' });
    headerContents.push({ type: 'text', text: '尚未設定月預算上限', color: '#ffffff', size: 'lg', weight: 'bold' });
    headerContents.push({ type: 'text', text: '下面先顯示各分類的比例', color: '#cccccc', size: 'xs' });
  } else {
    const icon = result.warningLevel === 'over' ? '🚨' : result.warningLevel === 'warning' ? '⚠️' : '💰';
    headerContents.push({ type: 'text', text: `${icon} ${result.month} 預算`, color: '#ffffff', size: 'sm' });
    headerContents.push({ type: 'text', text: `$${result.spent} / $${result.monthlyLimit}`, color: '#ffffff', size: 'xl', weight: 'bold' });
    const balanceText =
      result.remaining >= 0 ? `還可以花 $${result.remaining}` : `已超支 $${Math.abs(result.remaining)}`;
    headerContents.push({ type: 'text', text: `${balanceText}（已用 ${result.percentageUsed}%）`, color: '#cccccc', size: 'xs' });
  }

  const bodyContents =
    result.categories && result.categories.length > 0
      ? categoryBarRows(result.categories)
      : [{ type: 'text', text: '尚未設定分類比例', size: 'sm', color: '#999999' }];

  return {
    type: 'flex',
    altText: result.notSet ? '尚未設定預算' : `${result.month} 已花 $${result.spent}/$${result.monthlyLimit}`,
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#333333', paddingAll: 'lg', contents: headerContents },
      body: { type: 'box', layout: 'vertical', paddingAll: 'lg', contents: bodyContents },
    },
  };
}

// 把 handleMessage() 回傳的結果轉成 LINE 訊息陣列（最多 5 則，reply API 上限）
export function resultToLineMessages(result) {
  switch (result.type) {
    case 'record': {
      const lines = result.expenses.map((e) => `✅ ${e.date} ${e.item} $${e.amount}（${e.category}）`);
      const text =
        lines.join('\n') + budgetLine(result.budgetStatus) + categoryWarningLines(result.categoryWarnings);
      return [{ type: 'text', text }];
    }

    case 'confirm_category_cancelled': {
      const extra = result.skippedCount > 1 ? `（連同待確認的其他 ${result.skippedCount - 1} 筆一起取消）` : '';
      return [{ type: 'text', text: `❌ 已取消，這筆沒有記錄${extra}` }];
    }

    case 'record_with_confirm':
    case 'confirm_category': {
      const savedLines = [];
      if (result.savedExpenses) {
        result.savedExpenses.forEach((e) => savedLines.push(`✅ ${e.date} ${e.item} $${e.amount}（${e.category}）`));
      }
      if (result.savedItem) {
        savedLines.push(
          `✅ ${result.savedItem.date} ${result.savedItem.item} $${result.savedItem.amount}（${result.savedItem.category}）`
        );
      }
      if (result.invalid) {
        savedLines.push('⚠️ 不是有效的分類，請從下面選');
      }
      const remainingNote = result.remaining > 1 ? `（還有 ${result.remaining - 1} 筆待確認）` : '';
      savedLines.push(`❓「${result.item.item} $${result.item.amount}」這筆算哪一類？${remainingNote}`);
      return [
        {
          type: 'text',
          text: savedLines.join('\n'),
          quickReply: quickReplyFromCategories(result.options),
        },
      ];
    }

    case 'query': {
      const entries = Object.entries(result.byCategory || {});
      let text = `📊 ${result.label}${result.category ? `（${result.category}）` : ''}：共 ${result.count} 筆，總計 $${result.total}`;
      if (entries.length > 1) {
        text += '\n' + entries.map(([cat, amt]) => `${CATEGORY_EMOJI[cat] || ''} ${cat}：$${amt}`).join('\n');
      }
      return [{ type: 'text', text }];
    }

    case 'list': {
      if (result.records.length === 0) {
        return [{ type: 'text', text: '📋 沒有符合條件的記錄' }];
      }
      const lines = result.records.map((r) => `#${r.index} ${r.date} ${r.item} $${r.amount}（${r.category}）`);
      const text = `📋 共 ${result.count} 筆，總計 $${result.total}\n` + lines.join('\n');
      const message = { type: 'text', text };
      if (result.hasMore) {
        const data = new URLSearchParams({
          action: 'list_more',
          category: result.category || '',
          start: result.startDate || '',
          end: result.endDate || '',
          offset: String(result.nextOffset),
        }).toString();
        message.quickReply = {
          items: [
            {
              type: 'action',
              action: { type: 'postback', label: '看更多 ↓', data, displayText: '看更多' },
            },
          ],
        };
      }
      return [message];
    }

    case 'ambiguous': {
      const actionLabel = result.action === 'delete' ? '刪除' : '修改';
      const lines = result.candidates.map((r) => `#${r.index} ${r.date} ${r.item} $${r.amount}（${r.category}）`);
      return [
        {
          type: 'text',
          text: `⚠️ 找到多筆符合的記錄，請選要${actionLabel}哪一筆：\n` + lines.join('\n'),
          quickReply: quickReplyFromIndexed(result.candidates),
        },
      ];
    }

    case 'manage_unspecified': {
      if (result.candidates.length === 0) {
        return [{ type: 'text', text: '📋 目前沒有任何記錄' }];
      }
      const lines = result.candidates.map((r) => `#${r.index} ${r.date} ${r.item} $${r.amount}（${r.category}）`);
      return [
        {
          type: 'text',
          text: `❓ 要編輯或刪除哪一筆？（最近 ${result.candidates.length} 筆）\n` + lines.join('\n'),
          quickReply: quickReplyFromIndexed(result.candidates),
        },
      ];
    }

    case 'choose_action': {
      const r = result.record;
      const invalidNote = result.invalid ? '⚠️ 看不懂，請點下面按鈕：\n' : '';
      return [
        {
          type: 'text',
          text: `${invalidNote}✏️ 選好了：${r.date} ${r.item} $${r.amount}（${r.category}）\n要編輯還是刪除？`,
          quickReply: {
            items: [
              { type: 'action', action: { type: 'message', label: '✏️ 編輯', text: '編輯' } },
              { type: 'action', action: { type: 'message', label: '🗑️ 刪除', text: '刪除' } },
              { type: 'action', action: { type: 'message', label: '❌ 取消', text: '取消' } },
            ],
          },
        },
      ];
    }

    case 'manage_cancelled':
      return [{ type: 'text', text: '❌ 已取消' }];

    case 'budget_help':
      return [
        {
          type: 'text',
          text:
            '💰 跟我說「薪水50000，目標存15000」或「薪水50000，最多花70%」，我就會幫你算出每月可花上限。\n' +
            '之後想改分類比例可以說「修改飲食為30%」。',
        },
      ];

    case 'awaiting_value': {
      const r = result.record;
      return [
        {
          type: 'text',
          text: `✏️ 選好了：${r.date} ${r.item} $${r.amount}（${r.category}）\n要改成什麼？直接打字回覆，例如「80元」`,
        },
      ];
    }

    case 'delete_last':
      if (result.empty) return [{ type: 'text', text: '⚠️ 沒有找到可以刪除的記錄' }];
      return [
        {
          type: 'text',
          text: `🗑️ 已刪除：${result.deleted.date} ${result.deleted.item} $${result.deleted.amount}（${result.deleted.category}）`,
        },
      ];

    case 'modify_last':
      if (result.empty) return [{ type: 'text', text: '⚠️ 沒有找到可以修改的記錄' }];
      if (result.record.unchanged) return [{ type: 'text', text: '⚠️ 沒有偵測到要修改的內容' }];
      return [
        {
          type: 'text',
          text: `✏️ 已修改為：${result.record.date} ${result.record.item} $${result.record.amount}（${result.record.category}）`,
        },
      ];

    case 'delete_specific':
      return [
        {
          type: 'text',
          text: `🗑️ 已刪除：${result.deleted.date} ${result.deleted.item} $${result.deleted.amount}（${result.deleted.category}）`,
        },
      ];

    case 'modify_specific':
      if (result.unchanged) return [{ type: 'text', text: '⚠️ 沒有偵測到要修改的內容' }];
      return [
        {
          type: 'text',
          text: `✏️ 已修改為：${result.record.date} ${result.record.item} $${result.record.amount}（${result.record.category}）`,
        },
      ];

    case 'not_found':
      return [{ type: 'text', text: '⚠️ 沒有找到符合的記錄' }];

    case 'set_budget': {
      const b = result.budget;
      let text = `✅ 已設定：薪水 $${b.salary ?? '未設定'}`;
      if (b.savingsGoal != null) text += `，目標存 $${b.savingsGoal}`;
      if (b.spendingPercentage != null) text += `，最多花薪水的 ${b.spendingPercentage}%`;
      if (b.monthlyLimit != null) text += `，每月可花上限 $${b.monthlyLimit}`;
      return [{ type: 'text', text }];
    }

    case 'budget_status': {
      const message = budgetOverviewFlex(result);
      if (result.categories && result.categories.length > 0) {
        message.quickReply = {
          items: result.categories.slice(0, 13).map((c) => ({
            type: 'action',
            action: {
              type: 'message',
              label: `${CATEGORY_EMOJI[c.category] || ''} ${c.category}明細`.slice(0, 20),
              text: `列出這個月${c.category}`,
            },
          })),
        };
      }
      return [message];
    }

    case 'set_category_budget': {
      if (result.invalid) return [{ type: 'text', text: '⚠️ 不是有效的分類名稱' }];
      const lines = Object.entries(result.allocation).map(([cat, pct]) => {
        const amt = result.monthlyLimit != null ? `（總額度 $${Math.round((result.monthlyLimit * pct) / 100)}）` : '';
        return `${CATEGORY_EMOJI[cat] || ''} ${cat}：${pct}%${amt}`;
      });
      return [{ type: 'text', text: '✅ 已調整分類比例：\n' + lines.join('\n') }];
    }

    case 'none':
    default:
      return [{ type: 'text', text: '🤔 沒有偵測到記帳或查詢意圖' }];
  }
}

export function welcomeMessage() {
  return {
    type: 'text',
    text:
      '哈囉，我是你的 AI 記帳助手！👋\n\n' +
      '📝 記帳：直接打字就好，像跟朋友聊天一樣\n' +
      '例如「今天午餐吃200元」「昨天晚餐跟朋友聚餐1500，計程車150」\n\n' +
      '📊 查詢：「這個月花多少」「列出所有飲食」\n' +
      '✏️ 編輯：「我要編輯」會列出最近的記錄讓你選\n' +
      '🗑️ 刪除：「我要刪除一筆」同樣會列清單選\n\n' +
      '💰 設定預算：「薪水50000，目標存15000」\n' +
      '之後每次記帳都會提醒你這個月還剩多少可以花\n\n' +
      '需要選擇的時候（例如要選哪一筆、這筆算哪一類）我會跳出按鈕，點選就好，不用打字。\n\n' +
      '打字只有在「記一筆新花費」或「回答我的問題」時需要，其他都可以用按鈕完成 😊',
  };
}