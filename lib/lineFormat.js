// 跟 lib/categories.js 的 MAX_ACTIVE_CATEGORIES 保持同一個數字（12）。
// 這裡不能直接 import categories.js，因為它會連帶 import firebaseAdmin.js（用到 firebase-admin，
// 只能在伺服器端跑），而這個檔案會被 pages/test.js 直接 import 到瀏覽器端，
// 一牽連到 firebase-admin 就會導致 webpack 找不到 net/tls 這些 Node 核心模組而編譯失敗
const MAX_ACTIVE_CATEGORIES = 12;

// LINE Quick Reply 上限：最多 13 顆，每顆 label 上限 20 字
// options 是分類定義陣列 [{name, emoji}, ...]（來自 parseExpense.js 動態算出的目前啟用分類）
function quickReplyFromCategories(options) {
  const items = options.slice(0, 12).map((cat) => ({
    type: 'action',
    action: {
      type: 'message',
      label: `${cat.emoji || ''} ${cat.name}`.slice(0, 20),
      text: cat.name,
    },
  }));
  items.push({
    type: 'action',
    action: { type: 'message', label: '❌ 取消', text: '取消' },
  });
  return { items };
}

// 只有真的需要注意（整體或某分類進入警示/超支）才顯示，平常記帳保持乾淨
// 有分類警示時，一個分類一行，把整體剩餘額度一起帶在括號裡；沒有分類警示但整體超標時，顯示整體那一行
function budgetSummaryLines(budgetStatus, categoryWarnings) {
  if (!budgetStatus) return '';

  const overallBad = budgetStatus.warningLevel !== 'ok';
  const hasCategoryWarnings = categoryWarnings && categoryWarnings.length > 0;
  if (!overallBad && !hasCategoryWarnings) return '';

  const remainingText =
    budgetStatus.remaining >= 0
      ? `本月還可以花 $${budgetStatus.remaining}`
      : `本月已超支 $${Math.abs(budgetStatus.remaining)}`;

  if (hasCategoryWarnings) {
    return categoryWarnings
      .map((c) => {
        const icon = c.warningLevel === 'over' ? '🚨' : '⚠️';
        const detail =
          c.warningLevel === 'over'
            ? `已超支 $${Math.abs(c.remaining)}`
            : `已用${Math.round((c.spent / c.allocatedAmount) * 100)}%`;
        return `\n${icon} ${c.category}${detail}（${remainingText}）`;
      })
      .join('');
  }

  const icon = budgetStatus.warningLevel === 'over' ? '🚨' : '⚠️';
  return `\n${icon} ${remainingText}`;
}

// categories 每列已經帶 emoji（parseExpense.js 的 getCategoryBudgetStatus 產生的 table）
function categoryBarRows(categories) {
  return categories.map((c) => {
    // 已停用但這個月還有花費的分類：沒有比例/上限可比較，不畫長條，純文字顯示金額
    if (c.disabled) {
      return {
        type: 'box',
        layout: 'horizontal',
        margin: 'md',
        contents: [
          { type: 'text', text: `${c.emoji || ''} ${c.category}`, size: 'sm', color: '#999999', flex: 3, wrap: true },
          { type: 'text', text: '停用', size: 'xxs', color: '#bbbbbb', flex: 2 },
          { type: 'text', text: `$${c.spent}`, size: 'xs', color: '#999999', align: 'end', flex: 2 },
        ],
      };
    }

    const hasAmount = c.allocatedAmount != null;
    const pct = hasAmount
      ? c.allocatedAmount > 0
        ? Math.min(100, Math.round((c.spent / c.allocatedAmount) * 100))
        : 0
      : Math.min(100, c.percentage);
    const barColor = c.warningLevel === 'over' ? '#E4572E' : c.warningLevel === 'warning' ? '#E0A72E' : '#5B7F76';
    const rightLabel = hasAmount ? `${c.percentage}% · $${c.spent}/$${c.allocatedAmount}` : `${c.percentage}%`;
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
            { type: 'text', text: `${c.emoji || ''} ${c.category}`, size: 'sm', flex: 3, wrap: true },
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
    if (result.disabledSpent > 0) {
      headerContents.push({
        type: 'text',
        text: `已停用分類本月花了 $${result.disabledSpent}（不計入上面的預算）`,
        color: '#cccccc',
        size: 'xxs',
        wrap: true,
        margin: 'xs',
      });
    }
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
      header: { type: 'box', layout: 'vertical', backgroundColor: '#5B7F76', paddingAll: 'lg', contents: headerContents },
      body: { type: 'box', layout: 'vertical', paddingAll: 'lg', contents: bodyContents },
    },
  };
}

// 月報表：純消費佔比長條圖（不比對預算，只看實際花費分佈）
const RANK_MEDAL = ['🥇', '🥈', '🥉'];

function monthlyReportFlex(result) {
  if (result.categories.length === 0) {
    return {
      type: 'text',
      text: `🧾 ${result.month} 還沒有任何記錄`,
    };
  }

  // 依金額排名（顯示用；資料本身固定順序，這裡另外排序不影響 result.categories）
  const ranked = [...result.categories].sort((a, b) => b.amount - a.amount);

  // 單一疊層長條：所有分類的區段接在同一條裡，取代逐項長條圖
  const stackedBar = {
    type: 'box',
    layout: 'horizontal',
    height: '20px',
    cornerRadius: '10px',
    contents: ranked.map((c) => ({
      type: 'box',
      layout: 'vertical',
      flex: Math.max(1, Math.round(c.percentage)),
      backgroundColor: c.color || '#9ca3af',
      contents: [],
    })),
  };

  // 排行榜清單：色塊 + 排名 + 分類 + 金額，不畫個別長條
  const rankRows = ranked.map((c, i) => ({
    type: 'box',
    layout: 'horizontal',
    margin: i === 0 ? 'lg' : 'sm',
    contents: [
      {
        type: 'box',
        layout: 'vertical',
        width: '10px',
        height: '10px',
        cornerRadius: '5px',
        backgroundColor: c.color || '#9ca3af',
        contents: [],
      },
      {
        type: 'box',
        layout: 'horizontal',
        flex: 4,
        margin: 'sm',
        contents: c.disabled
          ? [
              {
                type: 'text',
                text: `${RANK_MEDAL[i] || `${i + 1}.`} ${c.category}`,
                size: 'sm',
                color: '#999999',
                wrap: true,
                flex: 1,
              },
              // 不給 flex：讓這個標籤只佔自己內容需要的寬度（3個小字），不要照比例分配，
              // 這樣名稱那邊才能拿到最大空間，不會因為比例分配而被擠到換行
              { type: 'text', text: '停用', size: 'xxs', color: '#bbbbbb', wrap: true },
            ]
          : [
              {
                type: 'text',
                text: `${RANK_MEDAL[i] || `${i + 1}.`} ${c.category}`,
                size: 'sm',
                color: '#111111',
                wrap: true,
              },
            ],
      },
      {
        type: 'text',
        text: `$${c.amount}`,
        size: 'sm',
        flex: 3,
        align: 'end',
        weight: i < 3 ? 'bold' : 'regular',
        color: c.disabled ? '#999999' : '#111111',
      },
      { type: 'text', text: `${c.percentage}%`, size: 'xs', color: '#999999', flex: 2, align: 'end' },
    ],
  }));

  const bodyContents = [stackedBar, ...rankRows];

  return {
    type: 'flex',
    altText: `${result.month} 消費報表：共花 $${result.total}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#5B7F76',
        paddingAll: 'lg',
        contents: [
          { type: 'text', text: `🧾 ${result.month} 消費報表`, color: '#ffffff', size: 'sm' },
          { type: 'text', text: `$${result.total}`, color: '#ffffff', size: 'xxl', weight: 'bold' },
          { type: 'text', text: `共 ${result.count} 筆`, color: '#cccccc', size: 'xs' },
        ],
      },
      body: { type: 'box', layout: 'vertical', paddingAll: 'lg', contents: bodyContents },
    },
  };
}

// 明細清單：卡片式排版取代一長串文字，每筆一行，日期/品項在左，金額在右
function listFlex(result) {
  const rows = [];
  const emojiMap = result.categoryEmojiMap || {};
  result.records.forEach((r, i) => {
    if (i > 0) rows.push({ type: 'separator', margin: 'md' });
    rows.push({
      type: 'box',
      layout: 'horizontal',
      margin: 'md',
      contents: [
        {
          type: 'box',
          layout: 'horizontal',
          flex: 6,
          paddingAll: 'sm',
          action: {
            type: 'postback',
            label: `編輯#${r.index}`,
            data: new URLSearchParams({ action: 'edit_record', id: r.id }).toString(),
            displayText: `編輯 #${r.index} ${r.item}`,
          },
          contents: [
            {
              type: 'text',
              text: `#${r.index} ${r.date} ${emojiMap[r.category] || ''} ${r.item}`,
              size: 'sm',
              flex: 5,
              wrap: true,
            },
            { type: 'text', text: `$${r.amount}`, size: 'sm', flex: 2, align: 'end', weight: 'bold' },
          ],
        },
        {
          type: 'box',
          layout: 'vertical',
          flex: 1,
          justifyContent: 'center',
          action: {
            type: 'postback',
            label: `刪除#${r.index}`,
            data: new URLSearchParams({ action: 'confirm_delete', id: r.id }).toString(),
            displayText: `刪除 #${r.index} ${r.item}`,
          },
          contents: [{ type: 'text', text: '🗑️', size: 'sm', align: 'center', color: '#a33333' }],
        },
      ],
    });
  });

  return {
    type: 'flex',
    altText: `📋 共 ${result.count} 筆，總計 $${result.total}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#5B7F76',
        paddingAll: 'lg',
        contents: [
          { type: 'text', text: '📋 明細（點列可編輯，點🗑️可刪除）', color: '#ffffff', size: 'sm', wrap: true },
          { type: 'text', text: `$${result.total}`, color: '#ffffff', size: 'xxl', weight: 'bold' },
          { type: 'text', text: `共 ${result.count} 筆`, color: '#cccccc', size: 'xs' },
        ],
      },
      body: { type: 'box', layout: 'vertical', paddingAll: 'lg', contents: rows },
    },
  };
}

function setBudgetFlex(result) {
  const b = result.budget;
  const headerContents = [
    { type: 'text', text: '✅ 預算已設定', color: '#ffffff', size: 'sm' },
  ];
  if (b.monthlyLimit != null) {
    headerContents.push({ type: 'text', text: `$${b.monthlyLimit} / 月`, color: '#ffffff', size: 'xxl', weight: 'bold' });
  }
  const detailParts = [`薪水 $${b.salary ?? '未設定'}`];
  if (b.savingsGoal != null) detailParts.push(`目標存 $${b.savingsGoal}`);
  if (b.spendingPercentage != null) detailParts.push(`最多花 ${b.spendingPercentage}%`);
  headerContents.push({ type: 'text', text: detailParts.join('，'), color: '#cccccc', size: 'xs' });

  const bodyContents =
    result.categories && result.categories.length > 0
      ? categoryBarRows(result.categories)
      : [{ type: 'text', text: '尚未設定分類比例', size: 'sm', color: '#999999' }];

  return {
    type: 'flex',
    altText: `預算已設定：每月上限 $${b.monthlyLimit ?? '未設定'}`,
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#5B7F76', paddingAll: 'lg', contents: headerContents },
      body: { type: 'box', layout: 'vertical', paddingAll: 'lg', contents: bodyContents },
    },
  };
}

// 分類比例調整用的百分比選項（按鈕流程用）
const PERCENT_OPTIONS = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50];

// 純分類比例的長條圖卡片（沒有「已花多少」的比較，跟 budgetOverviewFlex 用途不同）
// categories 是分類定義陣列 [{name, emoji}, ...]，來自 parseExpense.js 目前啟用中的分類
function categoryAllocationFlex(headerTitle, headerSubtitle, allocation, monthlyLimit, categories) {
  const bodyContents = categories.map((cat) => {
    const pct = allocation[cat.name] ?? 0;
    const safePct = Math.max(0, Math.min(100, Math.round(pct)));
    const rightLabel = monthlyLimit != null ? `${pct}%（$${Math.round((monthlyLimit * pct) / 100)}）` : `${pct}%`;
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
            { type: 'text', text: `${cat.emoji || ''} ${cat.name}`, size: 'sm', flex: 3, wrap: true },
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
            { type: 'box', layout: 'vertical', flex: Math.max(1, safePct), backgroundColor: '#5B7F76', contents: [] },
            { type: 'box', layout: 'vertical', flex: Math.max(1, 100 - safePct), contents: [] },
          ],
        },
      ],
    };
  });

  const headerContents = [{ type: 'text', text: headerTitle, color: '#ffffff', size: 'md', weight: 'bold', wrap: true }];
  if (headerSubtitle) {
    headerContents.push({ type: 'text', text: headerSubtitle, color: '#cccccc', size: 'xs', wrap: true, margin: 'sm' });
  }

  return {
    type: 'flex',
    altText: headerTitle,
    contents: {
      type: 'bubble',
      header: { type: 'box', layout: 'vertical', backgroundColor: '#5B7F76', paddingAll: 'lg', contents: headerContents },
      body: { type: 'box', layout: 'vertical', paddingAll: 'lg', contents: bodyContents },
    },
  };
}

// 候選清單卡片：編輯/刪除選單、明細清單共用同一種排版邏輯
function candidateListFlex(title, candidates, categoryEmojiMap, headerColor = '#5B7F76', { cancellable = true } = {}) {
  const emojiMap = categoryEmojiMap || {};
  const rows = [];
  candidates.forEach((r, i) => {
    if (i > 0) rows.push({ type: 'separator', margin: 'md' });
    rows.push({
      type: 'box',
      layout: 'horizontal',
      margin: 'md',
      contents: [
        {
          type: 'box',
          layout: 'horizontal',
          flex: 6,
          paddingAll: 'sm',
          action: {
            type: 'postback',
            label: `編輯#${r.index}`,
            data: new URLSearchParams({ action: 'edit_record', id: r.id }).toString(),
            displayText: `編輯 #${r.index} ${r.item}`,
          },
          contents: [
            {
              type: 'text',
              text: `#${r.index} ${r.date} ${emojiMap[r.category] || ''} ${r.item}`,
              size: 'sm',
              flex: 5,
              wrap: true,
              color: '#2B2B2B',
            },
            { type: 'text', text: `$${r.amount}`, size: 'sm', flex: 2, align: 'end', weight: 'bold', color: '#2B2B2B' },
          ],
        },
        {
          type: 'box',
          layout: 'vertical',
          flex: 1,
          justifyContent: 'center',
          action: {
            type: 'postback',
            label: `刪除#${r.index}`,
            data: new URLSearchParams({ action: 'confirm_delete', id: r.id }).toString(),
            displayText: `刪除 #${r.index} ${r.item}`,
          },
          contents: [{ type: 'text', text: '🗑️', size: 'sm', align: 'center', color: '#a33333' }],
        },
      ],
    });
  });

  if (cancellable) {
    rows.push({ type: 'separator', margin: 'md' });
    rows.push({
      type: 'box',
      layout: 'horizontal',
      margin: 'md',
      paddingAll: 'sm',
      action: { type: 'message', label: '取消', text: '取消' },
      contents: [{ type: 'text', text: '❌ 取消', size: 'sm', color: '#999999' }],
    });
  }

  return {
    type: 'flex',
    altText: title,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: headerColor,
        paddingAll: 'lg',
        contents: [{ type: 'text', text: title, color: '#ffffff', size: 'sm', wrap: true }],
      },
      body: { type: 'box', layout: 'vertical', paddingAll: 'lg', contents: rows },
    },
  };
}

// 分類設定總覽：每個分類一行，標示啟用/停用狀態跟是否為自訂分類
// 分類設定的一列（啟用中/已停用卡片共用），點了會開啟該分類的管理選單
function categoryRow(d, isFirst) {
  return {
    type: 'box',
    layout: 'horizontal',
    margin: isFirst ? 'none' : 'md',
    paddingAll: 'sm',
    action: {
      type: 'postback',
      label: `管理${d.name}`,
      data: new URLSearchParams({ action: 'category_menu', name: d.name }).toString(),
      displayText: `管理${d.name}`,
    },
    contents: [
      {
        type: 'text',
        text: `${d.emoji || ''} ${d.name}${d.isCustom ? '（自訂）' : ''}`,
        size: 'sm',
        flex: 5,
        color: d.enabled ? '#2B2B2B' : '#aaaaaa',
        wrap: true,
      },
      {
        type: 'text',
        text: d.enabled ? '🟢 啟用中' : '⚪ 已停用',
        size: 'xs',
        color: d.enabled ? '#5B7F76' : '#aaaaaa',
        align: 'end',
        flex: 3,
      },
    ],
  };
}

function categoryRows(defs) {
  const rows = [];
  defs.forEach((d, i) => {
    if (i > 0) rows.push({ type: 'separator', margin: 'md' });
    rows.push(categoryRow(d, i === 0));
  });
  return rows;
}

// 啟用中的分類：結構上保證最多 12 筆（新增/啟用時就會擋，見 categories.js 的 MAX_ACTIVE_CATEGORIES），
// 一定塞得進一張卡片，不需要分頁
function categorySettingsActiveFlex(activeDefs) {
  const rows = categoryRows(activeDefs);
  rows.push({ type: 'separator', margin: 'lg' });
  rows.push({
    type: 'text',
    text: '點列可以修改emoji、改名、啟用/停用；「新增分類 名稱」新增一個分類',
    size: 'xxs',
    color: '#999999',
    wrap: true,
    margin: 'lg',
  });

  return {
    type: 'flex',
    altText: '分類設定 - 啟用中分類',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#5B7F76',
        paddingAll: 'lg',
        contents: [
          { type: 'text', text: '🗂️ 分類設定', color: '#ffffff', size: 'lg', weight: 'bold' },
          { type: 'text', text: `🟢 啟用中分類（${activeDefs.length}/${MAX_ACTIVE_CATEGORIES}）`, color: '#eeeeee', size: 'xs', margin: 'xs' },
        ],
      },
      body: { type: 'box', layout: 'vertical', paddingAll: 'lg', contents: rows },
    },
  };
}

// 已停用的分類：停用不是刪除，只增不減，沒有上限，超過一頁的量才會出現「看更多」
function categorySettingsDisabledFlex(disabled) {
  const rows =
    disabled.defs.length > 0
      ? categoryRows(disabled.defs)
      : [{ type: 'text', text: '目前沒有已停用的分類', size: 'sm', color: '#999999' }];

  const message = {
    type: 'flex',
    altText: `分類設定 - 停用中分類（共 ${disabled.total} 個）`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#9a9a9a',
        paddingAll: 'lg',
        contents: [
          { type: 'text', text: '🗂️ 分類設定', color: '#ffffff', size: 'lg', weight: 'bold' },
          { type: 'text', text: `⚪ 停用中分類（共 ${disabled.total} 個）`, color: '#eeeeee', size: 'xs', margin: 'xs' },
        ],
      },
      body: { type: 'box', layout: 'vertical', paddingAll: 'lg', contents: rows },
    },
  };

  if (disabled.hasMore) {
    message.quickReply = {
      items: [
        {
          type: 'action',
          action: {
            type: 'postback',
            label: '看更多 ↓',
            data: new URLSearchParams({
              action: 'category_settings_more',
              offset: String(disabled.nextOffset),
            }).toString(),
            displayText: '看更多已停用分類',
          },
        },
      ],
    };
  }

  return message;
}

// 使用說明卡片：分段落呈現，比一長串文字好讀
function helpFlex() {
  const menuSections = [
    { icon: '📋', title: '明細', desc: '查詢指定範圍的消費紀錄。', example: '範例：「明細」「列出這個月飲食」' },
    { icon: '💰', title: '預算狀態', desc: '查看本月已花金額、剩餘額度與各分類佔比。', example: '範例：「這個月還剩多少」' },
    {
      icon: '⚙️',
      title: '設定',
      desc: '輸入「設定」會列出以下兩個子選單：',
      subsections: [
        {
          title: '💰 預算設定',
          desc: '設定薪水與存款目標（或改用花費百分比），系統會自動算出每月可花費上限；也可以調整各分類的預算比例。',
          example: '範例：「設定預算」「薪水50000，目標存15000」「修改飲食為30%」',
        },
        {
          title: '🗂️ 分類設定',
          desc: '列出所有分類的啟用/停用狀態，點列可以修改emoji、改名、啟用/停用；也可以新增自訂分類（停用不影響歷史記錄）。',
          example: '範例：「分類設定」「新增分類 寵物」「停用醫療」「運動改名叫健身」',
        },
      ],
    },
    { icon: '✏️', title: '編輯記錄', desc: '選擇一筆記錄進行修改或刪除。', example: '範例：「編輯記錄」' },
    { icon: '🧾', title: '月報表', desc: '查看本月消費分佈，可切換至過去數月。', example: '範例：「月報表」「上個月報表」' },
  ];

  const bodyContents = [];
  menuSections.forEach((s, i) => {
    if (i > 0) bodyContents.push({ type: 'separator', margin: 'lg' });

    const children = [{ type: 'text', text: `${s.icon} ${s.title}`, size: 'sm', weight: 'bold', color: '#5B7F76' }];
    if (s.desc) {
      children.push({ type: 'text', text: s.desc, size: 'xs', color: '#555555', wrap: true, margin: 'xs' });
    }
    if (s.example) {
      children.push({ type: 'text', text: s.example, size: 'xxs', color: '#999999', wrap: true, margin: 'xs' });
    }

    if (s.subsections) {
      s.subsections.forEach((sub) => {
        children.push({
          type: 'box',
          layout: 'vertical',
          margin: 'md',
          spacing: 'xs',
          backgroundColor: '#F5F5F5',
          cornerRadius: '8px',
          paddingAll: 'sm',
          contents: [
            { type: 'text', text: sub.title, size: 'xs', weight: 'bold', color: '#5B7F76' },
            { type: 'text', text: sub.desc, size: 'xxs', color: '#555555', wrap: true, margin: 'xs' },
            { type: 'text', text: sub.example, size: 'xxs', color: '#999999', wrap: true, margin: 'xs' },
          ],
        });
      });
    }

    bodyContents.push({
      type: 'box',
      layout: 'vertical',
      margin: i === 0 ? 'none' : 'lg',
      spacing: 'xs',
      contents: children,
    });
  });

  bodyContents.push({ type: 'separator', margin: 'lg' });
  bodyContents.push({
    type: 'box',
    layout: 'vertical',
    margin: 'lg',
    spacing: 'xs',
    contents: [
      { type: 'text', text: '✏️ 記帳', size: 'sm', weight: 'bold', color: '#5B7F76' },
      {
        type: 'text',
        text: '輸入消費內容即可記錄，可一次輸入多筆。',
        size: 'xs',
        color: '#555555',
        wrap: true,
        margin: 'xs',
      },
      {
        type: 'text',
        text: '範例：「午餐100元」「午餐100元，晚餐300元」',
        size: 'xxs',
        color: '#999999',
        wrap: true,
        margin: 'xs',
      },
    ],
  });
  bodyContents.push({
    type: 'text',
    text: '需要選擇時會提供按鈕操作；查詢明細後可使用「匯出Excel」下載記錄。',
    size: 'xxs',
    color: '#999999',
    wrap: true,
    margin: 'lg',
  });

  return {
    type: 'flex',
    altText: '使用說明',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#5B7F76',
        paddingAll: 'lg',
        contents: [{ type: 'text', text: '💡 使用說明', color: '#ffffff', size: 'lg', weight: 'bold' }],
      },
      body: { type: 'box', layout: 'vertical', paddingAll: 'lg', contents: bodyContents },
    },
  };
}

// 設定預算引導卡片：把範例語法用獨立色塊框起來，比純文字段落好認
function budgetHelpFlex(budget) {
  const hasBudget = budget && budget.monthlyLimit != null;
  const statusBox = hasBudget
    ? {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#EAF2EF',
        cornerRadius: '8px',
        paddingAll: 'md',
        contents: [
          { type: 'text', text: '✅ 目前已設定', size: 'xs', color: '#5B7F76', weight: 'bold' },
          {
            type: 'text',
            text: `薪水 $${budget.salary ?? '未設定'}${
              budget.savingsGoal != null ? `，目標存 $${budget.savingsGoal}` : ''
            }${budget.spendingPercentage != null ? `，最多花 ${budget.spendingPercentage}%` : ''}，每月上限 $${budget.monthlyLimit}`,
            size: 'sm',
            wrap: true,
            margin: 'xs',
          },
        ],
      }
    : {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#FBF2E3',
        cornerRadius: '8px',
        paddingAll: 'md',
        contents: [{ type: 'text', text: '⚠️ 尚未設定預算，請參考下方範例', size: 'sm', color: '#B8860B', wrap: true }],
      };

  return {
    type: 'flex',
    altText: '設定預算說明',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#5B7F76',
        paddingAll: 'lg',
        contents: [{ type: 'text', text: '⚙️ 預算設定', color: '#ffffff', size: 'lg', weight: 'bold' }],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'lg',
        spacing: 'md',
        contents: [
          statusBox,
          { type: 'separator', margin: 'md' },
          { type: 'text', text: '💰 薪水與存款目標', size: 'sm', weight: 'bold', color: '#5B7F76', margin: 'md' },
          {
            type: 'text',
            text: '提供薪水，系統會自動計算每月可花費上限；存款目標非必填：',
            size: 'xs',
            wrap: true,
            color: '#555555',
            margin: 'xs',
          },
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#F5F5F5',
            cornerRadius: '8px',
            paddingAll: 'md',
            margin: 'sm',
            contents: [{ type: 'text', text: '「薪水50000，目標存15000」', size: 'sm', wrap: true }],
          },
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#F5F5F5',
            cornerRadius: '8px',
            paddingAll: 'md',
            margin: 'sm',
            contents: [{ type: 'text', text: '「薪水50000，最多花70%」', size: 'sm', wrap: true }],
          },
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#F5F5F5',
            cornerRadius: '8px',
            paddingAll: 'md',
            margin: 'sm',
            contents: [{ type: 'text', text: '「薪水50000」（沒設目標，上限=薪水全部）', size: 'sm', wrap: true }],
          },

          { type: 'separator', margin: 'md' },
          { type: 'text', text: '📊 分類比例', size: 'sm', weight: 'bold', color: '#5B7F76', margin: 'md' },
          {
            type: 'text',
            text: '決定每個分類可以花上限裡的多少比例，加總應該是100%：',
            size: 'xs',
            wrap: true,
            color: '#555555',
            margin: 'xs',
          },
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#F5F5F5',
            cornerRadius: '8px',
            paddingAll: 'md',
            margin: 'sm',
            contents: [{ type: 'text', text: '「修改飲食為30%」', size: 'sm', wrap: true }],
          },
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#F5F5F5',
            cornerRadius: '8px',
            paddingAll: 'md',
            margin: 'sm',
            contents: [{ type: 'text', text: '「飲食30%，交通10%」（一次調整多個）', size: 'sm', wrap: true }],
          },
          {
            type: 'text',
            text: '沒指定的分類會依原比例自動調整。',
            size: 'xxs',
            wrap: true,
            color: '#999999',
            margin: 'sm',
          },
        ],
      },
    },
  };
}

// 把 handleMessage() 回傳的結果轉成 LINE 訊息陣列（最多 5 則，reply API 上限）
export function resultToLineMessages(result) {
  switch (result.type) {
    case 'record': {
      const lines = result.expenses.map(
        (e) => `✅ ${e.date} ${e.item} $${e.amount}（${e.category}）${e.note ? `\n　備註：${e.note}` : ''}`
      );
      const text = lines.join('\n') + budgetSummaryLines(result.budgetStatus, result.categoryWarnings);
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
        text += '\n' + entries.map(([cat, amt]) => `${(result.categoryEmojiMap || {})[cat] || ''} ${cat}：$${amt}`).join('\n');
      }
      return [{ type: 'text', text }];
    }

    case 'list_scope_prompt': {
      const cat = result.category;
      const catLabel = cat || '所有記錄';
      const scopeText = (label) => (cat ? `列出${label}${cat}` : `列出${label}所有記錄`);
      return [
        {
          type: 'text',
          text: `❓ 要看哪個範圍的${catLabel}？`,
          quickReply: {
            items: [
              { type: 'action', action: { type: 'message', label: '本月', text: scopeText('這個月') } },
              { type: 'action', action: { type: 'message', label: '上個月', text: scopeText('上個月') } },
              { type: 'action', action: { type: 'message', label: '今年', text: scopeText('今年') } },
              { type: 'action', action: { type: 'message', label: '去年', text: scopeText('去年') } },
              {
                type: 'action',
                action: {
                  type: 'message',
                  label: '不限日期',
                  text: cat ? `列出不限日期的${cat}` : '列出不限日期的所有記錄',
                },
              },
            ],
          },
        },
      ];
    }

    case 'list_large': {
      const forceData = new URLSearchParams({
        action: 'list_force',
        category: result.category || '',
        start: result.startDate || '',
        end: result.endDate || '',
      }).toString();
      const exportData = new URLSearchParams({
        action: 'export',
        category: result.category || '',
        start: result.startDate || '',
        end: result.endDate || '',
      }).toString();
      return [
        {
          type: 'text',
          text: `📊 符合條件的記錄有 ${result.count} 筆，總計 $${result.total}\n資料量較大，建議直接匯出查看。`,
          quickReply: {
            items: [
              { type: 'action', action: { type: 'postback', label: '📊 匯出Excel', data: exportData, displayText: '匯出Excel' } },
              { type: 'action', action: { type: 'postback', label: '還是要看清單', data: forceData, displayText: '還是要看清單' } },
            ],
          },
        },
      ];
    }

    case 'list': {
      if (result.records.length === 0) {
        return [{ type: 'text', text: '📋 沒有符合條件的記錄' }];
      }
      const message = listFlex(result);

      const items = [];
      if (result.hasMore) {
        const moreData = new URLSearchParams({
          action: 'list_more',
          category: result.category || '',
          start: result.startDate || '',
          end: result.endDate || '',
          offset: String(result.nextOffset),
        }).toString();
        items.push({
          type: 'action',
          action: { type: 'postback', label: '看更多 ↓', data: moreData, displayText: '看更多' },
        });
      }
      const exportData = new URLSearchParams({
        action: 'export',
        category: result.category || '',
        start: result.startDate || '',
        end: result.endDate || '',
      }).toString();
      items.push({
        type: 'action',
        action: { type: 'postback', label: '📊 匯出這份Excel', data: exportData, displayText: '匯出Excel' },
      });
      message.quickReply = { items };

      return [message];
    }

    case 'monthly_report': {
      const message = monthlyReportFlex(result);
      if (result.recentMonths && result.recentMonths.length > 0 && message.type === 'flex') {
        message.quickReply = {
          items: result.recentMonths.map((m) => {
            const [, mm] = m.split('-');
            const label = `${parseInt(mm, 10)}月報表`;
            const data = new URLSearchParams({ action: 'monthly_report', month: m }).toString();
            return {
              type: 'action',
              action: { type: 'postback', label, data, displayText: `${m} 報表` },
            };
          }),
        };
      }
      return [message];
    }

    case 'ambiguous': {
      const actionLabel = result.action === 'delete' ? '刪除' : '修改';
      return [
        candidateListFlex(
          `⚠️ 找到多筆符合的記錄（想${actionLabel}的那筆，點列編輯／點🗑️刪除）：`,
          result.candidates,
          result.categoryEmojiMap,
          '#B8860B'
        ),
      ];
    }

    case 'manage_unspecified': {
      if (result.candidates.length === 0) {
        return [{ type: 'text', text: '📋 目前沒有任何記錄' }];
      }
      const header = result.fromLastList
        ? '📋 剛剛列出的清單（點列編輯／點🗑️刪除）'
        : `📋 最近 ${result.candidates.length} 筆（點列編輯／點🗑️刪除）`;
      const message = candidateListFlex(header, result.candidates, result.categoryEmojiMap, '#B8860B');

      // 只有用「最近查看的清單」時才附上「換一批」的退路；本來就已經是近20筆的話不用再給按鈕
      if (result.fromLastList) {
        message.quickReply = {
          items: [
            {
              type: 'action',
              action: {
                type: 'postback',
                label: '🔁 改用近20筆',
                data: 'action=manage_start&source=recent20',
                displayText: '改用近20筆',
              },
            },
          ],
        };
      }
      return [message];
    }

    case 'manage_cancelled':
      return [{ type: 'text', text: '❌ 已取消' }];

    case 'budget_help': {
      const message = budgetHelpFlex(result.budget);
      const items = [
        { type: 'action', action: { type: 'message', label: '📊 目前比例', text: '目前比例' } },
        { type: 'action', action: { type: 'message', label: '🎯 調整比例', text: '調整分類比例' } },
      ];
      if (result.budget && result.budget.monthlyLimit != null) {
        items.push({ type: 'action', action: { type: 'message', label: '🗑️ 清除預算設定', text: '刪除預算' } });
      }
      message.quickReply = { items };
      return [message];
    }

    case 'delete_budget': {
      const scopeLabel = result.target === 'goal' ? '存款目標/花費%' : result.target === 'salary' ? '薪水' : '薪水/目標';

      if (result.wasEmpty) {
        return [{ type: 'text', text: `目前沒有設定${scopeLabel}，不需要清除。` }];
      }

      let extra = '';
      if (result.target === 'goal' && result.budget && result.budget.salary != null) {
        extra = `（薪水 $${result.budget.salary} 保留，每月上限改成整筆薪水都算可花費）`;
      } else if (result.target === 'salary') {
        extra = '（每月上限也一併清除，因為需要薪水才能算）';
      }
      return [{ type: 'text', text: `✅ 已清除${scopeLabel}${extra}，分類比例配置不受影響。` }];
    }

    case 'view_category_allocation': {
      const message = categoryAllocationFlex('📊 目前分類比例', null, result.allocation, result.monthlyLimit, result.categories);
      return [message];
    }

    case 'list_menu':
      return [
        {
          type: 'text',
          text: '📋 要看哪個範圍的明細？',
          quickReply: {
            items: [
              { type: 'action', action: { type: 'message', label: '本日', text: '列出今天所有記錄' } },
              { type: 'action', action: { type: 'message', label: '本週', text: '列出這週所有記錄' } },
              { type: 'action', action: { type: 'message', label: '本月', text: '列出這個月所有記錄' } },
              { type: 'action', action: { type: 'message', label: '今年', text: '列出今年所有記錄' } },
              { type: 'action', action: { type: 'message', label: '去年', text: '列出去年所有記錄' } },
              { type: 'action', action: { type: 'message', label: '其他區間', text: '自訂區間' } },
            ],
          },
        },
      ];

    case 'custom_range_help':
      return [
        {
          type: 'text',
          text: '📅 跟我說想查的區間就好，例如「列出7/1到7/15的記錄」「列出3月的飲食」，日期我會自動幫你抓。',
        },
      ];

    case 'help':
      return [helpFlex()];

    case 'awaiting_value': {
      const r = result.record;
      return [
        {
          type: 'text',
          text: `✏️ 選好了：${r.date} ${r.item} $${r.amount}（${r.category}）\n要改成什麼？`,
          quickReply: {
            items: [{ type: 'action', action: { type: 'message', label: '❌ 取消', text: '取消' } }],
          },
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
          text: `✏️ 已修改為：${result.record.date} ${result.record.item} $${result.record.amount}（${result.record.category}）${result.record.note ? `\n　備註：${result.record.note}` : ''}`,
        },
      ];

    case 'confirm_delete': {
      const r = result.record;
      const invalidNote = result.invalid ? '⚠️ 看不懂，請點下面按鈕：\n' : '';
      const data = new URLSearchParams({ action: 'delete_record', id: r.id }).toString();
      return [
        {
          type: 'text',
          text: `${invalidNote}🗑️ 確定要刪除這筆嗎？\n${r.date} ${r.item} $${r.amount}（${r.category}）`,
          quickReply: {
            items: [
              { type: 'action', action: { type: 'postback', label: '🗑️ 確定刪除', data, displayText: '確定刪除' } },
              { type: 'action', action: { type: 'message', label: '❌ 取消', text: '取消' } },
            ],
          },
        },
      ];
    }

    case 'delete_specific':
      return [
        {
          type: 'text',
          text: `🗑️ 已刪除：${result.deleted.date} ${result.deleted.item} $${result.deleted.amount}（${result.deleted.category}）`,
        },
      ];

    case 'delete_batch': {
      const lines = [];
      if (result.deleted.length > 0) {
        lines.push(`🗑️ 已刪除 ${result.deleted.length} 筆：`);
        result.deleted.forEach((r) => lines.push(`　${r.date} ${r.item} $${r.amount}（${r.category}）`));
      }
      if (result.notFound.length > 0) {
        lines.push(`⚠️ 找不到符合的：${result.notFound.map((t) => t.item || t.date || '?').join('、')}`);
      }
      if (result.ambiguousTargets.length > 0) {
        result.ambiguousTargets.forEach(({ target, candidates }) => {
          lines.push(`❓「${target.item}」比對到多筆，這次跳過，請用更精確的方式指定（例如加上日期）：`);
          candidates.forEach((c) => lines.push(`　#${c.index} ${c.date} ${c.item} $${c.amount}（${c.category}）`));
        });
      }
      return [{ type: 'text', text: lines.join('\n') }];
    }

    case 'modify_specific':
      if (result.unchanged) return [{ type: 'text', text: '⚠️ 沒有偵測到要修改的內容' }];
      return [
        {
          type: 'text',
          text: `✏️ 已修改為：${result.record.date} ${result.record.item} $${result.record.amount}（${result.record.category}）${result.record.note ? `\n　備註：${result.record.note}` : ''}`,
        },
      ];

    case 'not_found':
      return [{ type: 'text', text: '⚠️ 沒有找到符合的記錄' }];

    case 'set_budget':
      return [setBudgetFlex(result)];

    case 'adjust_category_menu':
      return [
        {
          type: 'text',
          text: '🎯 要調整哪個分類的比例？',
          quickReply: {
            items: result.categories.slice(0, 13).map((cat) => ({
              type: 'action',
              action: {
                type: 'message',
                label: `${cat.emoji || ''} ${cat.name}`.slice(0, 20),
                text: `調整${cat.name}比例`,
              },
            })),
          },
        },
      ];

    case 'adjust_category_percent_step':
      return [
        {
          type: 'text',
          text: `📊 ${result.category} 目前是 ${result.current}%，要改成多少？`,
          quickReply: {
            items: PERCENT_OPTIONS.map((pct) => ({
              type: 'action',
              action: { type: 'message', label: `${pct}%`, text: `修改${result.category}為${pct}%` },
            })),
          },
        },
      ];

    case 'budget_status': {
      const message = budgetOverviewFlex(result);
      if (result.categories && result.categories.length > 0) {
        message.quickReply = {
          items: result.categories.slice(0, 13).map((c) => ({
            type: 'action',
            action: {
              type: 'message',
              label: `${c.emoji || ''} ${c.category}明細`.slice(0, 20),
              text: `列出這個月${c.category}`,
            },
          })),
        };
      }
      return [message];
    }

    case 'set_category_budget': {
      if (result.missingPercentage) {
        const cat = result.category || '飲食';
        return [{ type: 'text', text: `❓ 要改成多少%？例如「修改${cat}為30%」` }];
      }
      if (result.zeroNotAllowed) {
        return [
          {
            type: 'text',
            text: `如果不想再追蹤「${result.category}」的預算，建議直接輸入「停用${result.category}」，而不是設成 0%（0% 但還啟用中的分類會繼續出現在記帳選單裡）`,
          },
        ];
      }
      if (result.invalid) return [{ type: 'text', text: '⚠️ 不是有效的分類名稱' }];
      if (result.tooMuch) {
        return [{ type: 'text', text: `⚠️ 你講的這幾個分類加起來已經 ${result.specifiedSum}%，超過100%了，麻煩降低一點` }];
      }
      if (result.allSpecifiedMismatch) {
        return [
          {
            type: 'text',
            text: `⚠️ 你一次講了全部啟用中的分類，但加起來是 ${result.specifiedSum}%，不是100%，因為沒有其他分類可以自動吸收差額，麻煩調整成剛好100%`,
          },
        ];
      }
      const specifiedList = result.specified || [];
      const autoAdjusted = result.categories.map((c) => c.name).filter((c) => !specifiedList.includes(c));
      const subtitle =
        autoAdjusted.length > 0
          ? `你設定：${specifiedList.join('、')}\n自動依比例調整：${autoAdjusted.join('、')}`
          : '你設定的比例剛好是100%';
      return [categoryAllocationFlex('✅ 分類比例已調整', subtitle, result.allocation, result.monthlyLimit, result.categories)];
    }

    case 'add_category': {
      if (result.invalid) return [{ type: 'text', text: '⚠️ 請提供分類名稱，例如「新增分類 寵物」' }];
      if (result.tooLong) {
        return [{ type: 'text', text: `⚠️ 分類名稱太長了，請控制在 ${result.maxLength} 個字以內` }];
      }
      if (result.invalidEmoji) {
        return [{ type: 'text', text: '⚠️ emoji 只能填一個，而且要是真的 emoji 符號，不能是文字，例如「新增分類 寵物 🐾」' }];
      }
      if (result.duplicate) return [{ type: 'text', text: `⚠️「${result.name}」已經存在了，不能重複新增` }];
      if (result.tooMany) {
        return [{ type: 'text', text: `⚠️ 啟用中的分類已經到上限（${result.max}個），請先停用一些分類再新增` }];
      }
      const def = (result.defs || []).find((d) => d.name === result.added);
      return [
        {
          type: 'text',
          text: `✅ 已新增分類：${def ? def.emoji : ''} ${result.added}\n可以直接開始用這個分類記帳，預算比例先給了 5%，之後可以用「設定預算」調整。`,
        },
      ];
    }

    case 'disable_category': {
      if (!result.results || result.results.length === 0) {
        return [{ type: 'text', text: '⚠️ 沒有指定要停用的分類' }];
      }
      const lines = result.results.map((r) => {
        if (r.notFound) return `⚠️ 找不到「${r.requested}」這個分類`;
        if (r.alreadyDisabled) return `「${r.category}」本來就是停用狀態`;
        if (r.lastOne) return `⚠️「${r.category}」是最後一個啟用中的分類，沒辦法停用`;
        return r.reclaimedPct > 0
          ? `✅ 已停用「${r.category}」（原本 ${r.reclaimedPct}% 已收回，分配給其他啟用中的分類）`
          : `✅ 已停用「${r.category}」`;
      });
      const anyOk = result.results.some((r) => r.ok);
      if (anyOk) lines.push('記帳跟分類設定不會再出現這些分類（歷史記錄還是查得到）');
      return [{ type: 'text', text: lines.join('\n') }];
    }

    case 'enable_category': {
      if (!result.results || result.results.length === 0) {
        return [{ type: 'text', text: '⚠️ 沒有指定要啟用的分類' }];
      }
      const lines = result.results.map((r) => {
        if (r.notFound) return `⚠️ 找不到「${r.requested}」這個分類`;
        if (r.alreadyEnabled) return `「${r.category}」本來就是啟用狀態`;
        return `✅ 已啟用「${r.category}」`;
      });
      const anyOk = result.results.some((r) => r.ok);
      if (anyOk) lines.push('記帳跟預算比例又能選到這些分類了（比例先給了 5%，之後可以用「設定預算」調整）');
      return [{ type: 'text', text: lines.join('\n') }];
    }

    case 'category_settings': {
      const messages = [categorySettingsActiveFlex(result.activeDefs)];
      if (result.disabled && result.disabled.total > 0) {
        messages.push(categorySettingsDisabledFlex(result.disabled));
      }
      return messages;
    }

    case 'category_settings_more':
      return [categorySettingsDisabledFlex(result.disabled)];

    case 'set_category_emoji': {
      if (result.notFound) return [{ type: 'text', text: `⚠️ 找不到「${result.requested}」這個分類` }];
      if (result.builtin) {
        return [{ type: 'text', text: `⚠️「${result.category}」是內建分類，emoji 固定，暫不支援修改` }];
      }
      if (result.missingEmoji) {
        return [{ type: 'text', text: `❓ 請附上要換成的 emoji，例如「${result.category}的emoji改成🏃」` }];
      }
      if (result.invalidEmoji) {
        return [{ type: 'text', text: '⚠️ 只能填一個 emoji 符號，不能是文字，請重新輸入' }];
      }
      return [{ type: 'text', text: `✅ 已把「${result.category}」的 emoji 改成 ${result.emoji}` }];
    }

    case 'category_action_menu': {
      if (result.notFound) return [{ type: 'text', text: `⚠️ 找不到「${result.requested}」這個分類` }];
      const items = [];
      if (result.isCustom) {
        items.push({
          type: 'action',
          action: {
            type: 'postback',
            label: '✏️ 修改emoji',
            data: new URLSearchParams({ action: 'start_category_emoji', name: result.category }).toString(),
            displayText: `修改${result.category}的emoji`,
          },
        });
        items.push({
          type: 'action',
          action: {
            type: 'postback',
            label: '🏷️ 修改名稱',
            data: new URLSearchParams({ action: 'start_category_rename', name: result.category }).toString(),
            displayText: `修改${result.category}的名稱`,
          },
        });
      }
      items.push({
        type: 'action',
        action: {
          type: 'postback',
          label: result.enabled ? '⚪ 停用' : '🟢 啟用',
          data: new URLSearchParams({ action: 'toggle_category', name: result.category }).toString(),
          displayText: result.enabled ? `停用${result.category}` : `啟用${result.category}`,
        },
      });
      items.push({ type: 'action', action: { type: 'message', label: '❌ 取消', text: '取消' } });

      return [
        {
          type: 'text',
          text: `${result.category}${result.isCustom ? '' : '（內建分類）'} 要做什麼？`,
          quickReply: { items },
        },
      ];
    }

    case 'awaiting_category_emoji':
      return [
        {
          type: 'text',
          text: `✏️ 請輸入「${result.category}」的新 emoji`,
          quickReply: { items: [{ type: 'action', action: { type: 'message', label: '❌ 取消', text: '取消' } }] },
        },
      ];

    case 'awaiting_category_rename':
      return [
        {
          type: 'text',
          text: `🏷️ 請輸入「${result.category}」的新名稱`,
          quickReply: { items: [{ type: 'action', action: { type: 'message', label: '❌ 取消', text: '取消' } }] },
        },
      ];

    case 'rename_category': {
      if (result.builtin) {
        return [{ type: 'text', text: `⚠️「${result.category}」是內建分類，名稱固定，暫不支援修改` }];
      }
      if (result.notFound) return [{ type: 'text', text: `⚠️ 找不到「${result.requested}」這個分類` }];
      if (result.invalid) return [{ type: 'text', text: '⚠️ 請提供新的分類名稱，請重新輸入' }];
      if (result.tooLong) {
        return [{ type: 'text', text: `⚠️ 分類名稱太長了，請控制在 ${result.maxLength} 個字以內，請重新輸入` }];
      }
      if (result.duplicate) return [{ type: 'text', text: `⚠️「${result.newName}」已經存在了，不能重複使用，請重新輸入` }];
      if (result.unchanged) return [{ type: 'text', text: '新名稱跟原本一樣，沒有變化' }];
      return [
        { type: 'text', text: `✅ 已把「${result.oldName}」改名為「${result.newName}」，歷史記錄跟預算比例也一併更新` },
      ];
    }

    case 'settings_menu':
      return [
        {
          type: 'text',
          text: '⚙️ 要設定什麼？',
          quickReply: {
            items: [
              { type: 'action', action: { type: 'message', label: '💰 設定預算', text: '設定預算' } },
              { type: 'action', action: { type: 'message', label: '🗂️ 設定分類', text: '設定分類' } },
            ],
          },
        },
      ];

    case 'none':
    default:
      return [{ type: 'text', text: '🤔 沒有偵測到記帳或查詢意圖' }];
  }
}

export function welcomeMessage() {
  return {
    type: 'flex',
    altText: '歡迎使用 AI 記帳助手',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#5B7F76',
        paddingAll: 'lg',
        contents: [
          { type: 'text', text: '👋 歡迎使用', color: '#ffffff', size: 'sm' },
          { type: 'text', text: 'AI 記帳助手', color: '#ffffff', size: 'lg', weight: 'bold' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'lg',
        spacing: 'md',
        contents: [
          {
            type: 'text',
            text: '輸入消費內容即可記錄，例如「午餐100元」。',
            size: 'sm',
            color: '#555555',
            wrap: true,
          },
          {
            type: 'text',
            text: '查詢明細、設定預算、月報表等功能，皆可透過畫面下方選單操作。',
            size: 'sm',
            color: '#555555',
            wrap: true,
          },
          { type: 'separator', margin: 'sm' },
          {
            type: 'text',
            text: '點選「💡 使用說明」查看完整功能介紹。',
            size: 'xs',
            color: '#999999',
            wrap: true,
            margin: 'sm',
          },
        ],
      },
    },
  };
}