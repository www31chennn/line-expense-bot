// 一次性腳本：建立 Rich Menu、上傳圖片、設成這個帳號的預設選單
// 執行方式（在 line-expense-bot 資料夾內）：
//   node -r dotenv/config scripts/setup-rich-menu.js dotenv_config_path=.env.local
//
// 需要先 npm install dotenv --save-dev（只有跑這支腳本時需要，跟 Next.js 本身無關）

const fs = require('fs');
const path = require('path');

const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
if (!TOKEN) {
  console.error('❌ 找不到 LINE_CHANNEL_ACCESS_TOKEN，確認 .env.local 有這個值，且指令有帶 dotenv_config_path=.env.local');
  process.exit(1);
}

// 6 個區塊：對應右下角懸浮選單同一組固定文字，跟 handleMessage() 判斷的意圖完全一樣
const richMenuBody = {
  size: { width: 2500, height: 1686 },
  selected: true,
  name: '記帳助手主選單',
  chatBarText: '選單',
  areas: [
    { bounds: { x: 0, y: 0, width: 833, height: 843 }, action: { type: 'message', text: '明細' } },
    { bounds: { x: 833, y: 0, width: 834, height: 843 }, action: { type: 'message', text: '這個月還剩多少可以花' } },
    { bounds: { x: 1667, y: 0, width: 833, height: 843 }, action: { type: 'message', text: '設定預算' } },
    { bounds: { x: 0, y: 843, width: 833, height: 843 }, action: { type: 'message', text: '我要編輯' } },
    { bounds: { x: 833, y: 843, width: 834, height: 843 }, action: { type: 'message', text: '使用說明' } },
    {
      bounds: { x: 1667, y: 843, width: 833, height: 843 },
      action: { type: 'uri', uri: 'https://line-expense-bot-plum.vercel.app/report' },
    },
  ],
};

async function main() {
  console.log('1/4 建立 Rich Menu 設定...');
  const createRes = await fetch('https://api.line.me/v2/bot/richmenu', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(richMenuBody),
  });
  if (!createRes.ok) {
    console.error('❌ 建立失敗:', createRes.status, await createRes.text());
    process.exit(1);
  }
  const { richMenuId } = await createRes.json();
  console.log('   -> richMenuId:', richMenuId);

  console.log('2/4 上傳選單圖片...');
  const imagePath = path.join(__dirname, '..', 'richmenu.png');
  const imageBuffer = fs.readFileSync(imagePath);
  const uploadRes = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
    method: 'POST',
    headers: {
      'Content-Type': 'image/png',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: imageBuffer,
  });
  if (!uploadRes.ok) {
    console.error('❌ 上傳圖片失敗:', uploadRes.status, await uploadRes.text());
    process.exit(1);
  }
  console.log('   -> 圖片上傳完成');

  console.log('3/4 設成這個帳號的預設選單...');
  const defaultRes = await fetch(`https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!defaultRes.ok) {
    console.error('❌ 設定預設選單失敗:', defaultRes.status, await defaultRes.text());
    process.exit(1);
  }
  console.log('   -> 已設成預設選單');

  console.log('4/4 完成！richMenuId =', richMenuId);
  console.log('去 LINE 上跟機器人的對話視窗，應該馬上會看到底部選單（如果沒有，把 App 切背景再切回來重整一次）。');
}

main().catch((err) => {
  console.error('❌ 腳本執行失敗:', err);
  process.exit(1);
});