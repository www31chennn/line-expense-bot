// 測試資料工具：匯入假資料 / 清除資料，合併成一支腳本用子命令區分
//
// 執行方式（在 line-expense-bot 資料夾內）：
//   匯入：node -r dotenv/config scripts/test-data.js dotenv_config_path=.env.local -- seed <userId> [筆數] [起始日期] [結束日期]
//   清測試資料：node -r dotenv/config scripts/test-data.js dotenv_config_path=.env.local -- clear <userId>
//   清全部資料：node -r dotenv/config scripts/test-data.js dotenv_config_path=.env.local -- clear <userId> --all
//
// 範例：
//   npm run test-data seed test-user 1000 2026-01-01 2026-07-15
//   npm run test-data clear test-user
//   npm run test-data clear test-user --all

const admin = require('firebase-admin');
const readline = require('readline');

function getDb() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    console.error('❌ 找不到 Firebase 環境變數，確認 .env.local 有設定，且指令有帶 dotenv_config_path=.env.local');
    process.exit(1);
  }
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert({ projectId, clientEmail, privateKey }) });
  }
  return admin.firestore();
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// ---------- seed ----------

const CATEGORIES = ['飲食', '交通', '購物', '娛樂', '醫療', '居家', '其他'];
const ITEMS = {
  飲食: ['午餐', '晚餐', '早餐', '飲料', '零食', '咖啡'],
  交通: ['加油', '停車費', '計程車', '捷運'],
  購物: ['衣服', '日用品', '3C配件'],
  娛樂: ['電影', '遊戲', 'Netflix', 'KTV'],
  醫療: ['看醫生', '藥局', '保健品'],
  居家: ['電話費', '水電費', '房租'],
  其他: ['捐款', '罰單', '禮物'],
};

function randomDate(start, end) {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  const d = new Date(startMs + Math.random() * (endMs - startMs));
  return d.toISOString().slice(0, 10);
}

function randomRecord(startDate, endDate) {
  const category = CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)];
  const items = ITEMS[category];
  const item = items[Math.floor(Math.random() * items.length)];
  const amount = Math.floor(Math.random() * 2000) + 20;
  return {
    date: randomDate(startDate, endDate),
    item,
    amount,
    category,
    note: '',
    rawMessage: `[測試資料] ${item}${amount}`,
    createdAt: new Date().toISOString(),
  };
}

async function seed(args) {
  const userId = args[0] || 'test-user';
  const count = parseInt(args[1], 10) || 200;
  const startDate = args[2] || `${new Date().getFullYear()}-01-01`;
  const endDate = args[3] || new Date().toISOString().slice(0, 10);

  const db = getDb();
  const recordsRef = db.collection('expenses').doc(userId).collection('records');

  console.log(`準備匯入 ${count} 筆記錄，userId=${userId}，日期範圍 ${startDate} ~ ${endDate}`);

  const BATCH_SIZE = 400;
  let written = 0;
  while (written < count) {
    const batch = db.batch();
    const chunkSize = Math.min(BATCH_SIZE, count - written);
    for (let i = 0; i < chunkSize; i++) {
      batch.set(recordsRef.doc(), randomRecord(startDate, endDate));
    }
    await batch.commit();
    written += chunkSize;
    console.log(`已寫入 ${written}/${count}`);
  }

  console.log('✅ 完成');
}

// ---------- clear ----------

async function clear(args) {
  const all = args.includes('--all');
  const userId = args.find((a) => a !== '--all');

  if (!userId) {
    console.error('❌ 請提供 userId，例如：npm run test-data clear test-user');
    process.exit(1);
  }

  const db = getDb();
  const recordsRef = db.collection('expenses').doc(userId).collection('records');

  if (all) {
    console.log(`⚠️ 即將刪除 userId=${userId} 底下「全部」記帳記錄，此操作無法復原！`);
    const answer = await ask('請輸入 CONFIRM 以繼續，其他任意輸入取消：');
    if (answer.trim() !== 'CONFIRM') {
      console.log('已取消，沒有刪除任何資料');
      return;
    }
  } else {
    console.log(`準備清除 userId=${userId} 底下由 seed 產生的測試資料（rawMessage 開頭是「[測試資料]」）`);
  }

  const snapshot = await recordsRef.get();
  const targets = snapshot.docs.filter((doc) => {
    if (all) return true;
    const data = doc.data();
    return typeof data.rawMessage === 'string' && data.rawMessage.startsWith('[測試資料]');
  });

  if (targets.length === 0) {
    console.log('沒有符合條件的記錄，不需要刪除');
    return;
  }

  console.log(`找到 ${targets.length} 筆符合條件的記錄，開始刪除...`);

  const BATCH_SIZE = 400;
  let deleted = 0;
  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = targets.slice(i, i + BATCH_SIZE);
    chunk.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    deleted += chunk.length;
    console.log(`已刪除 ${deleted}/${targets.length}`);
  }

  console.log('✅ 完成');
}

// ---------- 入口 ----------

async function main() {
  const rawArgs = process.argv.slice(2);
  const dashIndex = rawArgs.lastIndexOf('--');
  const args = dashIndex === -1 ? rawArgs : rawArgs.slice(dashIndex + 1);
  const [command, ...rest] = args;

  if (command === 'seed') {
    await seed(rest);
  } else if (command === 'clear') {
    await clear(rest);
  } else {
    console.error('❌ 請指定子命令：seed 或 clear');
    console.error('   例如：npm run test-data seed test-user 1000');
    console.error('   例如：npm run test-data clear test-user');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('❌ 腳本執行失敗:', err);
  process.exit(1);
});