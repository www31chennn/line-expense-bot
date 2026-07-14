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
  return {
    items: options.slice(0, 13).map((cat) => ({
      type: 'action',
      action: {
        type: 'message',
        label: `${CATEGORY_EMOJI[cat] || ''} ${cat}`.slice(0, 20),
        text: cat,
      },
    })),
  };
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

function exportReportFlex(result) {
  const pct = result.monthlyLimit ? Math.round((result.total / result.monthlyLimit) * 100) : null;
  return {
    type: 'flex',
    altText: `${result.month} 消費總覽：共花 $${result.total}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#333333',
        paddingAll: 'lg',
        contents: [
          { type: 'text', text: `🧾 ${result.month} 消費總覽`, color: '#ffffff', size: 'sm' },
          { type: 'text', text: `$${result.total}`, color: '#ffffff', size: 'xxl', weight: 'bold' },
          ...(pct != null
            ? [{ type: 'text', text: `預算 $${result.monthlyLimit}（${pct}%）`, color: '#cccccc', size: 'xs' }]
            : []),
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: 'lg',
        contents:
          result.categories.length === 0
            ? [{ type: 'text', text: '這個月還沒有任何記錄', size: 'sm', color: '#999999' }]
            : result.categories.map((c) => ({
                type: 'box',
                layout: 'horizontal',
                contents: [
                  { type: 'text', text: `${CATEGORY_EMOJI[c.category] || ''} ${c.category}`, size: 'sm', flex: 3 },
                  { type: 'text', text: `$${c.amount}`, size: 'sm', flex: 2, align: 'end' },
                  { type: 'text', text: `${c.percentage}%`, size: 'sm', flex: 2, align: 'end', color: '#999999' },
                ],
              })),
      },
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
      return [{ type: 'text', text: `📋 共 ${result.records.length} 筆，總計 $${result.total}\n` + lines.join('\n') }];
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

    case 'edit_unspecified': {
      if (result.candidates.length === 0) {
        return [{ type: 'text', text: '📋 目前沒有任何記錄' }];
      }
      const actionLabel = result.action === 'delete' ? '刪除' : '編輯';
      const lines = result.candidates.map((r) => `#${r.index} ${r.date} ${r.item} $${r.amount}（${r.category}）`);
      return [
        {
          type: 'text',
          text: `❓ 要${actionLabel}哪一筆？（最近 ${result.candidates.length} 筆）\n` + lines.join('\n'),
          quickReply: quickReplyFromIndexed(result.candidates),
        },
      ];
    }

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
      if (result.notSet) {
        return [{ type: 'text', text: '⚠️ 還沒有設定薪水或目標，先跟我說「薪水50000，目標存15000」之類的' }];
      }
      return [{ type: 'text', text: budgetLine(result).trim() }];
    }

    case 'set_category_budget': {
      if (result.invalid) return [{ type: 'text', text: '⚠️ 不是有效的分類名稱' }];
      const lines = Object.entries(result.allocation).map(([cat, pct]) => {
        const amt = result.monthlyLimit != null ? `（總額度 $${Math.round((result.monthlyLimit * pct) / 100)}）` : '';
        return `${CATEGORY_EMOJI[cat] || ''} ${cat}：${pct}%${amt}`;
      });
      return [{ type: 'text', text: '✅ 已調整分類比例：\n' + lines.join('\n') }];
    }

    case 'query_category_budget': {
      const lines = result.table.map((c) => {
        if (result.monthlyLimit == null) return `${CATEGORY_EMOJI[c.category] || ''} ${c.category}：${c.percentage}%`;
        const icon = c.warningLevel === 'over' ? '🚨' : c.warningLevel === 'warning' ? '⚠️' : '';
        return `${CATEGORY_EMOJI[c.category] || ''} ${c.category}：${c.percentage}%，上限$${c.allocatedAmount} 已花$${c.spent} ${icon}剩$${c.remaining}`;
      });
      const header =
        result.monthlyLimit == null
          ? `📊 ${result.month} 分類預算（尚未設定月預算上限，只顯示比例）`
          : `📊 ${result.month} 分類預算`;
      return [{ type: 'text', text: header + '\n' + lines.join('\n') }];
    }

    case 'export_report':
      return [exportReportFlex(result)];

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