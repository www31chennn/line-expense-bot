// 一次性腳本：群發訊息給所有加了這個 LINE 官方帳號的好友，或指定單一使用者測試
// 執行方式（在 line-expense-bot 資料夾內）：
//   全體群發：npm run broadcast
//   單一使用者測試：npm run broadcast -- --to <userId>
//   （<userId> 可以到 Firestore 的 expenses collection 底下找，文件 ID 就是使用者的 LINE userId；
//    前提是那個 userId 已經加你的官方帳號好友，Push API 沒辦法推播給非好友）
//
// 注意：
// - LINE 免費（輕用量）方案每月有 200 則群發免費額度，算法是「收到的好友數」不是「呼叫次數」
//   （例如 1 個好友收到算 1 則，不是整個群發動作算 1 則）；指定單一使用者測試不會計入群發額度，
//   是算在「訊息推播」的額度裡，同樣有免費上限但通常寬鬆很多
// - 全體群發沒有分眾功能，會送給「全部」好友；正式群發前建議先用 --to 測試效果
// - 下面的內容改完再執行，執行下去無法收回

const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
if (!TOKEN) {
  console.error('❌ 找不到 LINE_CHANNEL_ACCESS_TOKEN，確認 .env.local 有這個值，且指令有帶 dotenv_config_path=.env.local');
  process.exit(1);
}

// --to <userId> 只給單一使用者測試用；沒帶這個參數就維持原本的全體群發
const rawArgs = process.argv.slice(2);
const toIndex = rawArgs.indexOf('--to');
const targetUserId = toIndex >= 0 ? rawArgs[toIndex + 1] : null;
if (toIndex >= 0 && !targetUserId) {
  console.error('❌ --to 後面要接 userId，例如：npm run broadcast -- --to Uxxxxxxxx...');
  process.exit(1);
}

// 要改公告內容，直接改這個物件；也可以照這個格式再加一則文字訊息（一次最多送 5 則）
const announcement = {
  type: 'flex',
  altText: '📢 新功能上線：分類設定',
  contents: {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#5B7F76',
      paddingAll: 'lg',
      contents: [
        { type: 'text', text: '📢 新功能上線', color: '#ffffff', size: 'sm' },
        { type: 'text', text: '分類設定', color: '#ffffff', size: 'xl', weight: 'bold' },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: 'lg',
      spacing: 'md',
      contents: [
        { type: 'text', text: '現在可以自己管理記帳分類了：', size: 'sm', color: '#555555', wrap: true },
        {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          margin: 'md',
          contents: [
            { type: 'text', text: '🟢 新增自訂分類', size: 'xs', color: '#555555', wrap: true },
            { type: 'text', text: '⚪ 停用不需要的分類', size: 'xs', color: '#555555', wrap: true },
            { type: 'text', text: '✏️ 修改分類的 emoji 或名稱', size: 'xs', color: '#555555', wrap: true },
          ],
        },
        { type: 'text', text: '輸入「分類設定」立即查看', size: 'xs', color: '#999999', wrap: true, margin: 'md' },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: 'md',
      contents: [
        {
          type: 'button',
          style: 'primary',
          color: '#5B7F76',
          action: { type: 'message', label: '查看分類設定', text: '分類設定' },
        },
      ],
    },
  },
};

async function main() {
  const isTest = !!targetUserId;
  const url = isTest ? 'https://api.line.me/v2/bot/message/push' : 'https://api.line.me/v2/bot/message/broadcast';
  const body = isTest ? { to: targetUserId, messages: [announcement] } : { messages: [announcement] };

  console.log(isTest ? `準備推播測試訊息給 ${targetUserId}...` : '準備群發訊息給所有好友...');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    console.error(isTest ? '❌ 推播失敗:' : '❌ 群發失敗:', res.status, await res.text());
    process.exit(1);
  }

  console.log(isTest ? '✅ 測試訊息已送出！' : '✅ 群發完成！');
}

main().catch((err) => {
  console.error('❌ 腳本執行失敗:', err);
  process.exit(1);
});