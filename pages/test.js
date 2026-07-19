import { useState } from 'react';
import { resultToLineMessages } from '../lib/lineFormat';

// LINE Flex Message 的 size/spacing 是語意 token（xs/sm/md...），不是像素值，
// 這裡對應成近似的 px，讓測試頁面看起來盡量貼近實際 LINE 畫面
const SIZE_PX = { xxs: 10, xs: 11, sm: 13, md: 14, lg: 16, xl: 19, xxl: 22 };
const SPACE_PX = { none: 0, xs: 4, sm: 6, md: 8, lg: 12, xl: 16, xxl: 20 };

// 遞迴渲染 Flex box/text/separator/image 節點，跟 lib/lineFormat.js 產生的 JSON 結構一一對應，
// 這樣測試頁面看到的排版就是實際會送到 LINE 的東西，不會有兩邊各自維護、對不上的問題
function FlexNode({ node, onAction }) {
  if (!node) return null;

  const clickable = node.action ? { cursor: 'pointer' } : {};
  const handleClick = node.action ? () => onAction(node.action) : undefined;

  if (node.type === 'separator') {
    return <div style={{ borderTop: '1px solid #ececec', marginTop: SPACE_PX[node.margin] || 0 }} />;
  }

  if (node.type === 'text') {
    return (
      <div
        onClick={handleClick}
        style={{
          fontSize: SIZE_PX[node.size] || 14,
          color: node.color || '#111111',
          fontWeight: node.weight === 'bold' ? 700 : 400,
          textAlign: node.align === 'end' ? 'right' : node.align === 'center' ? 'center' : 'left',
          marginTop: SPACE_PX[node.margin] || 0,
          whiteSpace: node.wrap ? 'normal' : 'nowrap',
          overflow: node.wrap ? 'visible' : 'hidden',
          textOverflow: node.wrap ? 'clip' : 'ellipsis',
          flex: node.flex != null ? `${node.flex} 1 0%` : undefined,
          minWidth: 0,
          ...clickable,
        }}
      >
        {node.text}
      </div>
    );
  }

  if (node.type === 'image') {
    return <img src={node.url} style={{ width: '100%', display: 'block' }} />;
  }

  if (node.type === 'button') {
    // LINE 的 button 節點：link 樣式是無底色文字鈕，primary 是實心主色鈕
    const isPrimary = node.style === 'primary';
    return (
      <div
        onClick={node.action ? () => onAction(node.action) : undefined}
        style={{
          textAlign: 'center',
          padding: node.height === 'sm' ? '8px 12px' : '12px 16px',
          marginTop: SPACE_PX[node.margin] || 0,
          borderRadius: 8,
          backgroundColor: isPrimary ? '#5B7F76' : 'transparent',
          color: isPrimary ? '#ffffff' : '#42659A',
          fontSize: 14,
          fontWeight: 700,
          cursor: 'pointer',
        }}
      >
        {node.action ? node.action.label : ''}
      </div>
    );
  }

  if (node.type === 'box') {
    return (
      <div
        onClick={handleClick}
        style={{
          display: 'flex',
          flexDirection: node.layout === 'horizontal' ? 'row' : 'column',
          // 撐滿交叉軸（垂直於排列方向的那一軸），不是置中：長條圖的色塊都是空內容的box，
          // 靠這個撐滿父層設定的 height 才會有高度，改成 center 會讓空內容的box塌陷成0高度、變成看不到線
          alignItems: 'stretch',
          justifyContent: node.justifyContent || 'flex-start',
          backgroundColor: node.backgroundColor || 'transparent',
          borderRadius: node.cornerRadius || 0,
          padding: node.paddingAll != null ? SPACE_PX[node.paddingAll] ?? node.paddingAll : 0,
          marginTop: SPACE_PX[node.margin] || 0,
          height: node.height || undefined,
          width: node.width || undefined,
          flex: node.flex != null ? `${node.flex} 1 0%` : undefined,
          gap: node.spacing ? SPACE_PX[node.spacing] : 0,
          minWidth: 0,
          ...clickable,
        }}
      >
        {(node.contents || []).map((child, i) => (
          <FlexNode key={i} node={child} onAction={onAction} />
        ))}
      </div>
    );
  }

  // 防漏網：lineFormat 產生了這裡沒實作的節點類型時，顯示醒目警示而不是靜默跳過——
  // 之前 button 節點就是被這行舊的 return null 吃掉的，才會出現「/test 沒有、真機有」的落差。
  // 看到這個紅框就代表 FlexNode 要補一種節點的渲染
  return (
    <div style={{ background: '#ffecec', color: '#c0392b', fontSize: 11, padding: 6, borderRadius: 4 }}>
      ⚠️ /test 渲染器未支援的節點類型：{node.type}（真機 LINE 會正常顯示，請補 FlexNode 實作）
    </div>
  );
}
// 這裡的渲染是「近似」不是 100% 還原（LINE 的 Flex 排版引擎有很多細節：gravity、offset、
// baseline、aspectRatio 等這裡沒實作）——要做像素級確認時，按 JSON 鈕把這張卡的
// Flex JSON 複製起來，貼到 LINE 官方 Flex Message Simulator 看官方渲染結果
function FlexBubbleView({ bubble, onAction }) {
  const [copied, setCopied] = useState(false);
  function copyJson() {
    navigator.clipboard.writeText(JSON.stringify(bubble, null, 2)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }
  return (
    <div style={{ maxWidth: 320 }}>
      <div
        style={{
          border: '1px solid #e5e5e5',
          borderRadius: 12,
          overflow: 'hidden',
          boxShadow: '0 1px 4px rgba(0,0,0,0.1)',
          background: '#fff',
        }}
      >
        {bubble.header && <FlexNode node={bubble.header} onAction={onAction} />}
        {bubble.body && <FlexNode node={bubble.body} onAction={onAction} />}
        {bubble.footer && <FlexNode node={bubble.footer} onAction={onAction} />}
      </div>
      <div style={{ textAlign: 'right', marginTop: 2 }}>
        <span
          onClick={copyJson}
          title="複製這張卡的 Flex JSON，貼到 LINE 官方 Flex Message Simulator 看正式渲染"
          style={{ fontSize: 10, color: '#aaaaaa', cursor: 'pointer', userSelect: 'none' }}
        >
          {copied ? '✓ 已複製，貼到官方模擬器' : '{ } 複製JSON'}
        </span>
      </div>
    </div>
  );
}

// Quick Reply 一排圓角按鈕，label 直接用 action.label（跟 LINE 上顯示的字一致）
function QuickReplyRow({ items, onAction }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
      {items.map((item, i) => (
        <button
          key={i}
          type="button"
          onClick={() => onAction(item.action)}
          style={{
            padding: '6px 12px',
            border: '1px solid #5B7F76',
            borderRadius: 16,
            background: '#fff',
            color: '#5B7F76',
            cursor: 'pointer',
            fontSize: 13,
          }}
        >
          {item.action.label}
        </button>
      ))}
    </div>
  );
}

// 一則 LINE 訊息：純文字或 Flex，下面可能還帶一排 Quick Reply
// LINE app 會自動把文字訊息裡的網址變成可點擊連結，這裡做同樣的事，
// 不然像匯出連結這種訊息在測試頁面上只是一串死文字，點了沒反應
const URL_RE = /(https?:\/\/[^\s]+)/g;
function linkify(text) {
  return text.split(URL_RE).map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a key={i} href={part} target="_blank" rel="noreferrer" style={{ color: '#1a5cad', wordBreak: 'break-all' }}>
        {part}
      </a>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

function LineMessageView({ message, onAction }) {
  if (message.type === 'text') {
    return (
      <div style={{ marginBottom: 8 }}>
        <div
          style={{
            display: 'inline-block',
            background: '#fff',
            border: '1px solid #e5e5e5',
            borderRadius: 12,
            padding: '10px 14px',
            maxWidth: 320,
            whiteSpace: 'pre-wrap',
            fontSize: 14,
            lineHeight: 1.6,
          }}
        >
          {linkify(message.text)}
        </div>
        {message.quickReply && <QuickReplyRow items={message.quickReply.items} onAction={onAction} />}
      </div>
    );
  }
  if (message.type === 'flex') {
    return (
      <div style={{ marginBottom: 8 }}>
        <FlexBubbleView bubble={message.contents} onAction={onAction} />
        {message.quickReply && <QuickReplyRow items={message.quickReply.items} onAction={onAction} />}
      </div>
    );
  }
  // 防漏網：非 text/flex 的訊息類型（未來如果 lineFormat 開始送 sticker、image 訊息等）
  // 顯示警示而不是整則靜默消失
  return (
    <div style={{ background: '#ffecec', color: '#c0392b', fontSize: 12, padding: 8, borderRadius: 6, marginBottom: 8 }}>
      ⚠️ /test 未支援的訊息類型：{message.type}（真機 LINE 會正常顯示）
    </div>
  );
}

export default function TestPage() {
  const [message, setMessage] = useState('');
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);

  // 所有跟後端互動的動作都走這裡：打 /api/test-parse、拿到 result，
  // 用跟正式環境完全相同的 resultToLineMessages() 轉成 LINE 訊息陣列再存進歷史紀錄
  async function callApi(body, userMsg) {
    setLoading(true);
    try {
      const res = await fetch('/api/test-parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, userId: 'test-user' }),
      });
      const data = await res.json();
      if (data.error) {
        setHistory((prev) => [...prev, { userMsg, error: data.error }]);
      } else {
        const messages = resultToLineMessages(data);
        setHistory((prev) => [...prev, { userMsg, messages }]);
      }
    } catch (err) {
      setHistory((prev) => [...prev, { userMsg, error: err.message }]);
    } finally {
      setLoading(false);
    }
  }

  function sendMessage(text, userMsg) {
    if (!text || !text.trim()) return;
    return callApi({ message: text }, userMsg ?? text);
  }
  function sendListMore(params, userMsg) {
    return callApi({ listMore: params }, userMsg ?? '看更多');
  }
  function sendReportMonth(month, userMsg) {
    return callApi({ reportMonth: month }, userMsg ?? `${month} 報表`);
  }
  function sendManageStart(source, userMsg) {
    return callApi({ manageSource: source }, userMsg ?? '編輯');
  }
  function sendEditRecord(id, userMsg) {
    return callApi({ editRecordId: id }, userMsg ?? '編輯');
  }
  function sendConfirmDelete(id, userMsg) {
    return callApi({ confirmDeleteId: id }, userMsg ?? '刪除');
  }
  function sendDeleteRecord(id, userMsg) {
    return callApi({ deleteRecordId: id }, userMsg ?? '確定刪除');
  }
  function sendToggleCategory(name, userMsg) {
    return callApi({ toggleCategoryName: name }, userMsg ?? `切換${name}`);
  }
  function sendCategoryMenu(name, userMsg) {
    return callApi({ categoryMenuName: name }, userMsg ?? `管理${name}`);
  }
  function sendStartAddCategory(userMsg) {
    return callApi({ startAddCategoryFlag: true }, userMsg ?? '新增分類');
  }
  function sendStartCategoryEmoji(name, userMsg) {
    return callApi({ startCategoryEmojiName: name }, userMsg ?? `修改${name}的emoji`);
  }
  function sendStartCategoryRename(name, userMsg) {
    return callApi({ startCategoryRenameName: name }, userMsg ?? `修改${name}的名稱`);
  }
  function sendCategorySettingsMore(offset, userMsg) {
    return callApi({ categorySettingsMoreOffset: offset }, userMsg ?? '看更多已停用分類');
  }

  // 匯出是唯一不經過 handleMessage() 的 postback，webhook 那邊也是直接組連結回覆文字，這裡照樣模擬
  function sendExportLink(params, userMsg) {
    const query = new URLSearchParams({
      userId: 'test-user',
      ...(params.category && { category: params.category }),
      ...(params.start && { start: params.start }),
      ...(params.end && { end: params.end }),
    });
    // 跟正式環境的 webhook 一樣組出完整網址（不是相對路徑），這樣才是使用者實際會看到、能點的連結
    const url = `${window.location.origin}/api/export?${query.toString()}`;
    setHistory((prev) => [
      ...prev,
      { userMsg, messages: [{ type: 'text', text: `📊 匯出完成，點連結下載 CSV：\n${url}` }] },
    ]);
  }

  // 所有 Flex/QuickReply 上的 action（點擊 box 或按鈕）統一從這裡分派，
  // 邏輯對應 pages/api/line-webhook.js 的 postback 處理，讓測試頁面點擊行為跟正式環境一致
  function handleAction(action) {
    if (!action) return;

    if (action.type === 'message') {
      sendMessage(action.text, action.text);
      return;
    }

    if (action.type === 'postback') {
      const params = new URLSearchParams(action.data);
      const type = params.get('action');
      const userMsg = action.displayText || type;

      if (type === 'edit_record') return sendEditRecord(params.get('id'), userMsg);
      if (type === 'confirm_delete') return sendConfirmDelete(params.get('id'), userMsg);
      if (type === 'delete_record') return sendDeleteRecord(params.get('id'), userMsg);
      if (type === 'list_more' || type === 'list_force') {
        return sendListMore(
          {
            category: params.get('category') || null,
            startDate: params.get('start') || null,
            endDate: params.get('end') || null,
            offset: parseInt(params.get('offset'), 10) || 0,
          },
          userMsg
        );
      }
      if (type === 'export') {
        return sendExportLink(
          { category: params.get('category') || '', start: params.get('start') || '', end: params.get('end') || '' },
          userMsg
        );
      }
      if (type === 'monthly_report') return sendReportMonth(params.get('month'), userMsg);
      if (type === 'manage_start') return sendManageStart(params.get('source'), userMsg);
      if (type === 'toggle_category') return sendToggleCategory(params.get('name'), userMsg);
      if (type === 'category_menu') return sendCategoryMenu(params.get('name'), userMsg);
      if (type === 'undo_records') {
        const ids = (params.get('ids') || '').split(',').filter(Boolean);
        return callApi({ undoRecordIds: ids }, userMsg ?? '撤銷剛剛的記帳');
      }
      if (type === 'start_add_category') return sendStartAddCategory(userMsg);
      if (type === 'start_category_emoji') return sendStartCategoryEmoji(params.get('name'), userMsg);
      if (type === 'start_category_rename') return sendStartCategoryRename(params.get('name'), userMsg);
      if (type === 'category_settings_more') {
        return sendCategorySettingsMore(parseInt(params.get('offset'), 10) || 0, userMsg);
      }
    }
  }

  function handleSubmit(e) {
    e.preventDefault();
    const text = message.trim();
    if (!text) return;
    setMessage('');
    sendMessage(text);
  }

  const quickActions = [
    { label: '📋 明細', text: '明細' },
    { label: '💰 預算狀態', text: '這個月還剩多少可以花' },
    { label: '⚙️ 設定', text: '設定' },
    { label: '✏️ 編輯記錄', text: '我要編輯' },
    { label: '💡 使用說明', text: '使用說明' },
    { label: '🧾 月報表', text: '月報表' },
  ];

  return (
    <div style={{ maxWidth: 480, margin: '40px auto', fontFamily: 'sans-serif', padding: '0 16px 100px' }}>
      <h2>記帳測試（本機用，不會出現在正式 LINE 畫面）</h2>
      <div style={{ fontSize: 13, color: '#999', marginBottom: 8 }}>
        畫面直接渲染實際會送到 LINE 的 Flex Message JSON（跟 lib/lineFormat.js 共用同一份邏輯），
        右下角是常駐選單（LINE 上會做成 Rich Menu）
      </div>
      <div
        style={{
          border: '1px solid #ddd',
          borderRadius: 8,
          padding: 16,
          minHeight: 300,
          marginBottom: 16,
          background: '#f5f5f3',
        }}
      >
        {history.length === 0 && (
          <div style={{ color: '#999' }}>
            試試看：「今天午餐吃200元」「列出所有醫療」「7/12的點心改成80元」，或直接點右下角按鈕
          </div>
        )}
        {history.map((h, i) => (
          <div key={i} style={{ marginBottom: 12 }}>
            <div style={{ textAlign: 'right', color: '#333', marginBottom: 4 }}>🗣️ {h.userMsg}</div>
            <div style={{ textAlign: 'left' }}>
              {h.error && <div style={{ color: '#a33' }}>❌ {h.error}</div>}
              {h.messages && h.messages.map((m, mi) => <LineMessageView key={mi} message={m} onAction={handleAction} />)}
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