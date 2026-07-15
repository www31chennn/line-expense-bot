import { GoogleGenerativeAI } from '@google/generative-ai';
import { getFirestore } from './firebaseAdmin';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite' });

// 分類預算的預設比例，總和固定 100%
const DEFAULT_CATEGORY_ALLOCATION = {
  飲食: 30,
  居家: 25,
  交通: 10,
  購物: 10,
  娛樂: 10,
  醫療: 5,
  其他: 10,
};

// 固定的 7 個分類，反問使用者時用這組當選項
const ALL_CATEGORIES = ['飲食', '交通', '購物', '娛樂', '醫療', '居家', '其他'];

// 預算用到這個 % 開始警示，超過 100% 算超支
const BUDGET_WARNING_THRESHOLD = 80;

function getWarningLevel(spent, limit) {
  if (limit == null || limit <= 0) return 'ok';
  const pct = (spent / limit) * 100;
  if (pct >= 100) return 'over';
  if (pct >= BUDGET_WARNING_THRESHOLD) return 'warning';
  return 'ok';
}

// 取得台灣時區的今天日期字串，讓 AI 可以正確換算「今天/昨天/這個月」
function getTodayInfo(timestamp) {
  const date = timestamp ? new Date(timestamp) : new Date();
  const tzDate = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const yyyy = tzDate.getFullYear();
  const mm = String(tzDate.getMonth() + 1).padStart(2, '0');
  const dd = String(tzDate.getDate()).padStart(2, '0');
  const weekday = ['日', '一', '二', '三', '四', '五', '六'][tzDate.getDay()];
  return { dateStr: `${yyyy}-${mm}-${dd}`, weekday };
}

function buildPrompt(dateStr, weekday, message) {
  return `你是記帳助手。現在日期是 ${dateStr}，星期${weekday}。
請判斷使用者輸入屬於哪一種意圖，只輸出 JSON，不要有任何其他文字、不要用 markdown code block 包住。

情況一：記帳（例如「今天午餐吃2200元」「午餐200，晚餐1500，計程車150」），輸出：
{"type":"record","expenses":[{"date":"YYYY-MM-DD","item":"品項","amount":數字,"category":"分類","categoryConfidence":"high或low","note":""}]}
- date 從語句推算絕對日期；category 從 ["飲食","交通","購物","娛樂","醫療","居家","其他"] 選一個最可能的
- categoryConfidence：像「午餐」「計程車」「房租」這種明確的給 "high"；像「跟朋友出去花的」「買東西」「聚會」這種可能橫跨好幾類、不確定的給 "low"
- 一句話裡出現多個「品項+金額」組合就要拆成多筆，不要合併

情況二：統計查詢（例如「今天花多少」「這個月花多少」「這禮拜飲食類花多少」），輸出：
{"type":"query","startDate":"YYYY-MM-DD","endDate":"YYYY-MM-DD","category":"分類或null","label":"期間描述，例如：今天、這週、這個月"}
- 「這個月」指當月 1 號到今天；「這週」「本週」指這週一到今天；「上個月」指上個月 1 號到最後一天；「今年」指今年 1 月 1 號到今天；「去年」指去年 1 月 1 號到 12 月 31 號

情況三：列出清單（例如「列出所有飲食」「列出這個月醫療」「列出交通類」「列出今天所有記錄」「列出這週所有記錄」「列出上個月飲食」「列出今年交通」「列出去年娛樂」「列出不限日期的飲食」「本月明細」），輸出：
{"type":"list","category":"分類或null","startDate":"YYYY-MM-DD或null","endDate":"YYYY-MM-DD或null"}
- 「今天」startDate=endDate=今天；「這個月」「本月」指當月1號到今天；「這週」「本週」指這週一到今天；「上個月」指上個月1號到最後一天；「今年」指今年1月1號到今天；「去年」指去年1月1號到12月31號
- 只有使用者明確講「不限日期」「全部時間」時，才給 startDate/endDate 都是 null；沒講任何日期範圍（包括「所有」「全部」這種模糊講法）也一律給 null，讓後續程式判斷是否要反問

情況四：修改「上一筆」（沒有指定日期/品項，單純說「剛剛」「上一筆」，例如「剛剛打錯了改成250元」），輸出：
{"type":"modify_last","updates":{"amount":數字,"item":"品項","category":"分類","date":"YYYY-MM-DD"}}
- updates 只放實際要改的欄位

情況五：刪除「上一筆」（同上，沒有指定日期/品項），例如「刪除上一筆」，輸出：
{"type":"delete_last"}

情況六：修改「特定一筆」（有指定日期、品項關鍵字、或列表中的第幾筆），例如「7/12的點心改成80元」「醫療那筆改成4800」「第2筆改成計程車」，輸出：
{"type":"modify_specific","target":{"date":"YYYY-MM-DD或null","item":"品項關鍵字或null","index":數字或null},"updates":{...}}

情況七：刪除「特定一筆」，例如「刪除7/12的點心」「刪掉醫療那筆」「刪除第2筆」，輸出：
{"type":"delete_specific","target":{"date":"YYYY-MM-DD或null","item":"品項關鍵字或null","index":數字或null}}

情況八：使用者要編輯或刪除記錄，但完全沒提到日期/品項/分類/編號（例如「我要編輯」「我想改一筆」「編輯記錄」「我要刪除一筆」「我想刪東西」），輸出：
{"type":"manage_unspecified"}

情況九：使用者只是單獨回覆一個編號來回答「要選哪一筆」（例如「1」「#1」「第一筆」「第二個」「2」，沒有其他記帳/查詢內容），輸出：
{"type":"select_index","index":數字}
- 中文數字（一二三四五）、阿拉伯數字、「#1」「第1筆」等格式都要能轉換成數字

情況十：設定薪水與存錢/花費目標（例如「薪水50000，目標存15000」「月薪45000，最多花70%」「我想每個月存1萬」），輸出：
{"type":"set_budget","salary":數字或null,"savingsGoal":數字或null,"spendingPercentage":數字或null}
- 只填使用者實際提到的欄位，沒提到的給 null

情況十一：查詢預算/目標狀態（例如「這個月還剩多少可以花」「有沒有超支」「存錢目標達成了嗎」「餘額還有多少」「目前預算比例是多少」「各分類比例」「預算狀態」「分類預算」），輸出：
{"type":"budget_status"}

情況十二：修改某分類的預算比例（例如「修改飲食為30%」「交通改成15%」），輸出：
{"type":"set_category_budget","category":"分類","percentage":數字}
- category 必須是 ["飲食","交通","購物","娛樂","醫療","居家","其他"] 其中一個

情況十三：使用者想調整分類比例，但用按鈕選、沒有直接講數字或分類（例如「調整分類比例」「用按鈕改比例」），輸出：
{"type":"adjust_category_menu"}

情況十四：使用者選好要調整哪個分類，但還沒講要改成多少%（例如「調整飲食比例」「飲食比例要調」），輸出：
{"type":"adjust_category_percent_step","category":"分類"}
- category 必須是 ["飲食","交通","購物","娛樂","醫療","居家","其他"] 其中一個

情況十五：使用者想知道怎麼設定預算，但沒有直接給數字（例如「設定預算」「怎麼設定薪水」「預算怎麼設定」），輸出：
{"type":"budget_help"}

情況十六：使用者想查明細但沒指定範圍或分類（例如「明細」「查詢明細」「我要看明細」），輸出：
{"type":"list_menu"}

情況十七：使用者想自訂查詢區間（例如「自訂區間」「其他區間」），輸出：
{"type":"custom_range_help"}

情況十八：使用者想知道怎麼使用這個機器人、有哪些功能（例如「使用說明」「教學」「怎麼用」「有什麼功能」），輸出：
{"type":"help"}

情況十九：查看消費報表卡片（例如「月報表」「這個月的報表」「上個月報表」「6月報表」「本月總覽」），輸出：
{"type":"monthly_report","month":"YYYY-MM或null"}
- 沒指定月份就是當月（null）；「上個月」算上個月；「6月」這種只講月份沒講年份，指今年6月

情況二十：完全無法辨識意圖，輸出：
{"type":"none"}

判斷「上一筆」還是「特定一筆」的關鍵：只要句子裡有提到日期、品項名稱、分類、或「第X筆」，一律當作「特定一筆」（情況六/七），只有完全沒提到任何指向性資訊、單純講「剛剛」「上一筆」時才用情況四/五；如果連「剛剛」「上一筆」都沒講，只是單純說「我要編輯/刪除」，用情況八。單獨的編號回覆（無其他內容）一律用情況九。

使用者輸入：「${message}」`;
}

function cleanJson(text) {
  return text.replace(/^```json\s*|^```\s*|```$/g, '').trim();
}

async function classifyMessage(message, timestamp) {
  const { dateStr, weekday } = getTodayInfo(timestamp);
  const prompt = buildPrompt(dateStr, weekday, message);
  const result = await model.generateContent(prompt);
  const text = cleanJson(result.response.text());
  try {
    return JSON.parse(text);
  } catch (err) {
    console.error('AI 回傳的內容無法解析為 JSON:', text);
    throw new Error('AI_PARSE_FAILED');
  }
}

// 使用者已經選好要編輯哪一筆，這句話用來解析「要改成什麼」
function buildUpdatePrompt(dateStr, weekday, message) {
  return `你是記帳助手。現在日期是 ${dateStr}，星期${weekday}。
使用者剛才選好要編輯哪一筆記錄，這句話是在描述要把這筆記錄改成什麼。
請解析成 JSON，只輸出 JSON，不要有其他文字：
{"amount":數字或null,"item":"品項或null","category":"分類或null","date":"YYYY-MM-DD或null"}
- category 從 ["飲食","交通","購物","娛樂","醫療","居家","其他"] 選一個
- 只填使用者有提到的欄位，其他給 null

使用者輸入：「${message}」`;
}

async function parseUpdateFields(message, timestamp) {
  const { dateStr, weekday } = getTodayInfo(timestamp);
  const prompt = buildUpdatePrompt(dateStr, weekday, message);
  const result = await model.generateContent(prompt);
  const text = cleanJson(result.response.text());

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {};
  }

  const updates = {};
  for (const key of ['amount', 'item', 'category', 'date']) {
    if (parsed[key] !== undefined && parsed[key] !== null) updates[key] = parsed[key];
  }
  return updates;
}

function recordsCollection(userId) {
  return getFirestore().collection('expenses').doc(userId).collection('records');
}

function userDoc(userId) {
  return getFirestore().collection('expenses').doc(userId);
}

async function saveExpenses(userId, expenses, rawMessage) {
  const db = getFirestore();
  const batch = db.batch();
  const savedIds = [];
  for (const expense of expenses) {
    const ref = recordsCollection(userId).doc();
    batch.set(ref, { ...expense, rawMessage, createdAt: new Date().toISOString() });
    savedIds.push(ref.id);
  }
  await batch.commit();
  return savedIds;
}

async function queryExpenses(userId, startDate, endDate, category) {
  const snapshot = await recordsCollection(userId)
    .where('date', '>=', startDate)
    .where('date', '<=', endDate)
    .get();

  let total = 0;
  let count = 0;
  const byCategory = {};
  snapshot.forEach((doc) => {
    const d = doc.data();
    if (category && d.category !== category) return;
    total += d.amount;
    count += 1;
    byCategory[d.category] = (byCategory[d.category] || 0) + d.amount;
  });
  return { total, count, byCategory };
}

async function getLastRecord(userId) {
  const snapshot = await recordsCollection(userId).orderBy('createdAt', 'desc').limit(1).get();
  if (snapshot.empty) return null;
  const doc = snapshot.docs[0];
  return { id: doc.id, ...doc.data() };
}

async function modifyRecordById(userId, id, updates) {
  const cleanUpdates = {};
  for (const key of ['amount', 'item', 'category', 'date']) {
    if (updates[key] !== undefined && updates[key] !== null) cleanUpdates[key] = updates[key];
  }
  if (Object.keys(cleanUpdates).length === 0) return null;
  await recordsCollection(userId).doc(id).update(cleanUpdates);
  const doc = await recordsCollection(userId).doc(id).get();
  return { id, ...doc.data() };
}

async function deleteLastRecord(userId) {
  const last = await getLastRecord(userId);
  if (!last) return null;
  await recordsCollection(userId).doc(last.id).delete();
  return last;
}

async function modifyLastRecord(userId, updates) {
  const last = await getLastRecord(userId);
  if (!last) return null;
  const updated = await modifyRecordById(userId, last.id, updates);
  if (!updated) return { unchanged: true, ...last };
  return updated;
}

// 把清單存起來，讓「第2筆」這種指代之後可以查回對應的 record，也讓「編輯」可以直接沿用
const LAST_LIST_TTL_MS = 15 * 60 * 1000; // 15 分鐘，超過就當作過期，避免挖出很久以前查的清單

async function saveLastList(userId, indexedRecords) {
  await userDoc(userId).set(
    {
      lastList: indexedRecords.map((r) => ({
        index: r.index,
        id: r.id,
        date: r.date,
        item: r.item,
        amount: r.amount,
        category: r.category,
      })),
      lastListSavedAt: Date.now(),
    },
    { merge: true }
  );
}

// 回傳目前這份清單是否還「新鮮」（15分鐘內查過），供「編輯」判斷要不要沿用
async function getLastList(userId, { checkFreshness = false } = {}) {
  const doc = await userDoc(userId).get();
  if (!doc.exists) return [];
  const data = doc.data();
  const list = data.lastList || [];
  if (checkFreshness) {
    const savedAt = data.lastListSavedAt || 0;
    if (Date.now() - savedAt > LAST_LIST_TTL_MS) return [];
  }
  return list;
}

async function getPendingAction(userId) {
  const doc = await userDoc(userId).get();
  if (!doc.exists) return null;
  return doc.data().pendingAction || null;
}

async function savePendingAction(userId, pendingAction) {
  await userDoc(userId).set({ pendingAction }, { merge: true });
}

async function clearPendingAction(userId) {
  await userDoc(userId).set({ pendingAction: null }, { merge: true });
}

// 一次最多顯示/建立索引的筆數，避免訊息太長；超過的部分只算總額不列出
const LIST_DISPLAY_LIMIT = 20;

// 列出符合條件的記錄，依日期、金額排序並附上編號，支援 offset 分頁
// 匯出給 webhook 的 postback / 網頁版的分頁請求直接呼叫，不透過 AI 分類
export async function getListPage(userId, category, startDate, endDate, offset = 0) {
  let query = recordsCollection(userId);
  if (startDate) query = query.where('date', '>=', startDate);
  if (endDate) query = query.where('date', '<=', endDate);

  const snapshot = await query.get();
  let records = [];
  snapshot.forEach((doc) => {
    const d = doc.data();
    if (category && d.category !== category) return;
    records.push({ id: doc.id, ...d });
  });
  records.sort((a, b) => a.date.localeCompare(b.date) || a.amount - b.amount);

  const fullCount = records.length;
  const fullTotal = records.reduce((s, r) => s + r.amount, 0);
  const page = records.slice(offset, offset + LIST_DISPLAY_LIMIT);
  const indexed = page.map((r, i) => ({ ...r, index: offset + i + 1 }));
  await saveLastList(userId, indexed);

  const nextOffset = offset + LIST_DISPLAY_LIMIT;
  const hasMore = nextOffset < fullCount;
  return { records: indexed, total: fullTotal, count: fullCount, offset, nextOffset, hasMore, category, startDate, endDate };
}

// 給 CSV 匯出用：不分頁，抓出全部符合條件的記錄
export async function getAllMatchingRecords(userId, category, startDate, endDate) {
  let query = recordsCollection(userId);
  if (startDate) query = query.where('date', '>=', startDate);
  if (endDate) query = query.where('date', '<=', endDate);

  const snapshot = await query.get();
  let records = [];
  snapshot.forEach((doc) => {
    const d = doc.data();
    if (category && d.category !== category) return;
    records.push(d);
  });
  records.sort((a, b) => a.date.localeCompare(b.date) || a.amount - b.amount);
  return records;
}

// 抓最近 N 筆記錄（不限日期/分類），給「編輯/刪除但沒指定是哪一筆」時當候選清單
async function listRecentRecords(userId, limit) {
  const snapshot = await recordsCollection(userId).orderBy('createdAt', 'desc').limit(limit).get();
  const records = [];
  snapshot.forEach((doc) => records.push({ id: doc.id, ...doc.data() }));

  const indexed = records.map((r, i) => ({ ...r, index: i + 1 }));
  await saveLastList(userId, indexed);
  return indexed;
}

// 依日期/品項關鍵字找出符合的候選記錄（不靠編號時使用）
async function findMatchingRecords(userId, { date, item, category }) {
  let query = recordsCollection(userId);
  if (date) query = query.where('date', '==', date);
  const snapshot = await query.get();

  const candidates = [];
  snapshot.forEach((doc) => {
    const d = doc.data();
    if (category && d.category !== category) return;
    if (item && d.item && !d.item.includes(item) && !item.includes(d.item)) return;
    candidates.push({ id: doc.id, ...d });
  });
  return candidates;
}

// 解析「特定一筆」的目標：優先用編號（對應上次列出的清單），否則用日期/品項比對
async function resolveTarget(userId, target = {}) {
  if (target.index) {
    const lastList = await getLastList(userId);
    const found = lastList.find((r) => r.index === target.index);
    if (!found) return { notFound: true };
    const doc = await recordsCollection(userId).doc(found.id).get();
    if (!doc.exists) return { notFound: true };
    return { record: { id: doc.id, ...doc.data() } };
  }

  const candidates = await findMatchingRecords(userId, target);
  if (candidates.length === 0) return { notFound: true };
  if (candidates.length > 1) {
    const indexed = candidates.map((r, i) => ({ ...r, index: i + 1 }));
    await saveLastList(userId, indexed);
    return { ambiguous: true, candidates: indexed };
  }
  return { record: candidates[0] };
}

// 設定薪水與目標，換算成每月可花費上限（跟既有設定合併，不會覆蓋掉沒提到的欄位）
async function setBudget(userId, updates) {
  const existing = (await getBudget(userId)) || {};
  const salary = updates.salary ?? existing.salary ?? null;

  let savingsGoal = existing.savingsGoal ?? null;
  let spendingPercentage = existing.spendingPercentage ?? null;
  if (updates.savingsGoal != null) {
    savingsGoal = updates.savingsGoal;
    spendingPercentage = null;
  } else if (updates.spendingPercentage != null) {
    spendingPercentage = updates.spendingPercentage;
    savingsGoal = null;
  }

  let monthlyLimit = null;
  if (salary != null) {
    if (savingsGoal != null) {
      monthlyLimit = salary - savingsGoal;
    } else if (spendingPercentage != null) {
      monthlyLimit = Math.round((salary * spendingPercentage) / 100);
    }
  }

  const budget = { salary, savingsGoal, spendingPercentage, monthlyLimit };
  await userDoc(userId).set({ budget }, { merge: true });
  return budget;
}

async function getBudget(userId) {
  const doc = await userDoc(userId).get();
  if (!doc.exists) return null;
  return doc.data().budget || null;
}

// 算出這個月已花多少、剩多少、用了幾%
async function getBudgetStatus(userId) {
  const budget = await getBudget(userId);
  if (!budget || budget.monthlyLimit == null) return null;

  const { dateStr } = getTodayInfo();
  const month = dateStr.slice(0, 7);
  const monthStat = await getMonthlyCategoryBreakdown(userId, month);
  const spent = monthStat.total;
  const remaining = budget.monthlyLimit - spent;
  const percentageUsed =
    budget.monthlyLimit > 0 ? Math.round((spent / budget.monthlyLimit) * 1000) / 10 : 0;

  return { ...budget, month, spent, remaining, percentageUsed, warningLevel: getWarningLevel(spent, budget.monthlyLimit) };
}

// 修改某分類比例，其餘分類依原本的相對比例等比縮放，確保總和永遠是 100%
async function setCategoryBudget(userId, category, percentage) {
  const existingBudget = (await getBudget(userId)) || {};
  const current = existingBudget.categoryAllocation || { ...DEFAULT_CATEGORY_ALLOCATION };

  if (!(category in current)) return null;

  const newValue = Math.max(0, Math.min(100, Math.round(percentage)));
  const remaining = 100 - newValue;
  const oldValue = current[category] ?? 0;
  const othersOldSum = 100 - oldValue;
  const otherKeys = Object.keys(current).filter((k) => k !== category);

  const updated = { [category]: newValue };
  let assigned = 0;

  otherKeys.forEach((k, i) => {
    const isLast = i === otherKeys.length - 1;
    if (isLast) {
      updated[k] = Math.max(0, remaining - assigned);
      return;
    }
    let newPct;
    if (othersOldSum <= 0) {
      newPct = Math.round(remaining / otherKeys.length);
    } else {
      const oldPct = current[k] ?? 0;
      newPct = Math.round((oldPct * remaining) / othersOldSum);
    }
    updated[k] = Math.max(0, newPct);
    assigned += updated[k];
  });

  const updatedBudget = { ...existingBudget, categoryAllocation: updated };
  await userDoc(userId).set({ budget: updatedBudget }, { merge: true });

  // 依固定順序（ALL_CATEGORIES）輸出，不要用物件鍵值順序（剛改的那個分類會被排到最前面）
  const ordered = {};
  ALL_CATEGORIES.forEach((cat) => {
    ordered[cat] = updated[cat];
  });
  return ordered;
}

async function getCategoryBudgetStatus(userId) {
  const budget = await getBudget(userId);
  const allocation = (budget && budget.categoryAllocation) || DEFAULT_CATEGORY_ALLOCATION;
  const monthlyLimit = budget ? budget.monthlyLimit : null;

  const { dateStr } = getTodayInfo();
  const month = dateStr.slice(0, 7);
  const monthStat = await getMonthlyCategoryBreakdown(userId, month);
  const spentByCategory = {};
  monthStat.categories.forEach((c) => {
    spentByCategory[c.category] = c.amount;
  });

  const table = ALL_CATEGORIES.map((cat) => {
    const pct = allocation[cat] ?? 0;
    const allocatedAmount = monthlyLimit != null ? Math.round((monthlyLimit * pct) / 100) : null;
    const spent = spentByCategory[cat] || 0;
    const remaining = allocatedAmount != null ? allocatedAmount - spent : null;
    return {
      category: cat,
      percentage: pct,
      allocatedAmount,
      spent,
      remaining,
      warningLevel: getWarningLevel(spent, allocatedAmount),
    };
  });

  return { allocation, monthlyLimit, month, table };
}

// 給報表頁用：某月份依分類加總
export async function getMonthlyCategoryBreakdown(userId, month) {
  const startDate = `${month}-01`;
  const [y, m] = month.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  const endDate = `${month}-${String(lastDay).padStart(2, '0')}`;

  const snapshot = await recordsCollection(userId)
    .where('date', '>=', startDate)
    .where('date', '<=', endDate)
    .get();

  let total = 0;
  const byCategory = {};
  snapshot.forEach((doc) => {
    const d = doc.data();
    total += d.amount;
    byCategory[d.category] = (byCategory[d.category] || 0) + d.amount;
  });

  const categories = ALL_CATEGORIES.filter((cat) => byCategory[cat] > 0).map((category) => ({
    category,
    amount: byCategory[category],
    percentage: total > 0 ? Math.round((byCategory[category] / total) * 1000) / 10 : 0,
  }));

  return { month, startDate, endDate, total, count: snapshot.size, categories };
}

export async function handleMessage(userId, message, timestamp) {
  const pendingBefore = await getPendingAction(userId);

  // 使用者正在回答「這筆算哪一類」
  if (pendingBefore && pendingBefore.action === 'confirm_category') {
    const trimmed = message.trim();

    if (trimmed === '取消' || trimmed.toLowerCase() === 'cancel') {
      const skippedCount = pendingBefore.queue.length + 1;
      await clearPendingAction(userId);
      return { type: 'confirm_category_cancelled', skippedCount };
    }

    const matched = ALL_CATEGORIES.find((c) => trimmed === c || trimmed.includes(c));

    if (!matched) {
      return {
        type: 'confirm_category',
        invalid: true,
        item: pendingBefore.currentItem,
        options: ALL_CATEGORIES,
        remaining: pendingBefore.queue.length + 1,
      };
    }

    const savedItem = { ...pendingBefore.currentItem, category: matched };
    delete savedItem.categoryConfidence;
    const ids = await saveExpenses(userId, [savedItem], pendingBefore.rawMessage);

    if (pendingBefore.queue.length > 0) {
      const [next, ...rest] = pendingBefore.queue;
      await savePendingAction(userId, {
        action: 'confirm_category',
        currentItem: next,
        queue: rest,
        rawMessage: pendingBefore.rawMessage,
      });
      return {
        type: 'confirm_category',
        savedItem,
        item: next,
        options: ALL_CATEGORIES,
        remaining: rest.length + 1,
      };
    }

    await clearPendingAction(userId);
    const budgetStatus = await getBudgetStatus(userId);
    let categoryWarnings = [];
    if (budgetStatus) {
      const catStatus = await getCategoryBudgetStatus(userId);
      categoryWarnings = catStatus.table.filter((c) => c.category === matched && c.warningLevel !== 'ok');
    }
    return { type: 'record', expenses: [savedItem], ids, budgetStatus, categoryWarnings, confirmedCategory: true };
  }

  // 使用者剛選好要編輯哪一筆，這句話就是新的值，跳過一般意圖判斷直接解析
  if (pendingBefore && pendingBefore.action === 'awaiting_value') {
    const trimmed = message.trim();
    if (trimmed === '取消' || trimmed.toLowerCase() === 'cancel') {
      await clearPendingAction(userId);
      return { type: 'manage_cancelled' };
    }

    const updates = await parseUpdateFields(message, timestamp);
    await clearPendingAction(userId);
    if (Object.keys(updates).length === 0) {
      return { type: 'modify_specific', unchanged: true };
    }
    const updated = await modifyRecordById(userId, pendingBefore.targetId, updates);
    if (!updated) return { type: 'modify_specific', unchanged: true };
    return { type: 'modify_specific', record: updated };
  }

  // 使用者選好是哪一筆了，現在要回答「編輯」還是「刪除」
  if (pendingBefore && pendingBefore.action === 'choose_action') {
    const trimmed = message.trim();
    const targetId = pendingBefore.targetId;

    if (trimmed === '取消' || trimmed.toLowerCase() === 'cancel') {
      await clearPendingAction(userId);
      return { type: 'manage_cancelled' };
    }

    if (trimmed === '編輯' || trimmed === '改' || trimmed === '要編輯') {
      await savePendingAction(userId, { action: 'awaiting_value', targetId });
      const doc = await recordsCollection(userId).doc(targetId).get();
      if (!doc.exists) {
        await clearPendingAction(userId);
        return { type: 'not_found' };
      }
      return { type: 'awaiting_value', record: { id: targetId, ...doc.data() } };
    }

    if (trimmed === '刪除' || trimmed === '刪' || trimmed === '要刪除') {
      const doc = await recordsCollection(userId).doc(targetId).get();
      await clearPendingAction(userId);
      if (!doc.exists) return { type: 'not_found' };
      await recordsCollection(userId).doc(targetId).delete();
      return { type: 'delete_specific', deleted: { id: targetId, ...doc.data() } };
    }

    // 看不懂的回覆，重新問一次
    const doc = await recordsCollection(userId).doc(targetId).get();
    if (!doc.exists) {
      await clearPendingAction(userId);
      return { type: 'not_found' };
    }
    return { type: 'choose_action', record: { id: targetId, ...doc.data() }, invalid: true };
  }

  // 通用取消攔截：涵蓋 select_for_action（選哪一筆要編輯/刪除）、delete、modify（ambiguous 比對到多筆後的待選狀態）
  if (
    pendingBefore &&
    ['select_for_action', 'delete', 'modify'].includes(pendingBefore.action) &&
    (message.trim() === '取消' || message.trim().toLowerCase() === 'cancel')
  ) {
    await clearPendingAction(userId);
    return { type: 'manage_cancelled' };
  }

  const parsed = await classifyMessage(message, timestamp);

  // 除了「回覆編號」之外的任何新意圖，都視為使用者換了話題，清掉舊的待選狀態
  if (parsed.type !== 'select_index') {
    await clearPendingAction(userId);
  }

  if (parsed.type === 'select_index') {
    if (!pendingBefore) return { type: 'none' };

    const lastList = await getLastList(userId);
    const found = lastList.find((r) => r.index === parsed.index);
    if (!found) return { type: 'not_found' };

    if (pendingBefore.action === 'select_for_action') {
      // 選好是哪一筆了，記住這筆，改問要編輯還是刪除
      await savePendingAction(userId, { action: 'choose_action', targetId: found.id });
      const doc = await recordsCollection(userId).doc(found.id).get();
      return { type: 'choose_action', record: { id: found.id, ...doc.data() } };
    }

    await clearPendingAction(userId);

    if (pendingBefore.action === 'delete') {
      const doc = await recordsCollection(userId).doc(found.id).get();
      if (!doc.exists) return { type: 'not_found' };
      await recordsCollection(userId).doc(found.id).delete();
      return { type: 'delete_specific', deleted: { id: doc.id, ...doc.data() } };
    }

    if (pendingBefore.action === 'modify') {
      const updated = await modifyRecordById(userId, found.id, pendingBefore.updates || {});
      if (!updated) return { type: 'modify_specific', unchanged: true };
      return { type: 'modify_specific', record: updated };
    }

    return { type: 'none' };
  }

  if (parsed.type === 'record') {
    const validAll = (parsed.expenses || []).filter(
      (p) => p && typeof p.amount === 'number' && p.amount > 0
    );
    if (validAll.length === 0) return { type: 'none' };

    const confident = validAll.filter((e) => e.categoryConfidence !== 'low');
    const uncertain = validAll.filter((e) => e.categoryConfidence === 'low');

    let ids = [];
    let budgetStatus = null;
    let categoryWarnings = [];

    if (confident.length > 0) {
      ids = await saveExpenses(userId, confident, message);
      budgetStatus = await getBudgetStatus(userId);
      if (budgetStatus) {
        const catStatus = await getCategoryBudgetStatus(userId);
        const touched = new Set(confident.map((e) => e.category));
        categoryWarnings = catStatus.table.filter((c) => touched.has(c.category) && c.warningLevel !== 'ok');
      }
    }

    if (uncertain.length > 0) {
      const [first, ...rest] = uncertain;
      await savePendingAction(userId, {
        action: 'confirm_category',
        currentItem: first,
        queue: rest,
        rawMessage: message,
      });
      return {
        type: 'record_with_confirm',
        savedExpenses: confident,
        budgetStatus,
        categoryWarnings,
        item: first,
        options: ALL_CATEGORIES,
        remaining: uncertain.length,
      };
    }

    return { type: 'record', expenses: confident, ids, budgetStatus, categoryWarnings };
  }

  if (parsed.type === 'query') {
    const summary = await queryExpenses(userId, parsed.startDate, parsed.endDate, parsed.category || null);
    return {
      type: 'query',
      label: parsed.label || `${parsed.startDate}~${parsed.endDate}`,
      category: parsed.category || null,
      ...summary,
    };
  }

  if (parsed.type === 'list') {
    const category = parsed.category || null;
    const startDate = parsed.startDate || null;
    const endDate = parsed.endDate || null;
    const isUnbounded = !startDate && !endDate;
    const explicitOverride = message.includes('不限') || message.includes('全部時間');

    if (isUnbounded && !explicitOverride) {
      return { type: 'list_scope_prompt', category };
    }

    const result = await getListPage(userId, category, startDate, endDate, 0);
    return { type: 'list', ...result };
  }

  if (parsed.type === 'delete_last') {
    const deleted = await deleteLastRecord(userId);
    if (!deleted) return { type: 'delete_last', empty: true };
    return { type: 'delete_last', deleted };
  }

  if (parsed.type === 'modify_last') {
    const result = await modifyLastRecord(userId, parsed.updates || {});
    if (!result) return { type: 'modify_last', empty: true };
    return { type: 'modify_last', record: result };
  }

  if (parsed.type === 'delete_specific') {
    const resolved = await resolveTarget(userId, parsed.target || {});
    if (resolved.notFound) return { type: 'not_found' };
    if (resolved.ambiguous) {
      await savePendingAction(userId, { action: 'delete' });
      return { type: 'ambiguous', action: 'delete', candidates: resolved.candidates };
    }
    await recordsCollection(userId).doc(resolved.record.id).delete();
    return { type: 'delete_specific', deleted: resolved.record };
  }

  if (parsed.type === 'modify_specific') {
    const resolved = await resolveTarget(userId, parsed.target || {});
    if (resolved.notFound) return { type: 'not_found' };
    if (resolved.ambiguous) {
      await savePendingAction(userId, { action: 'modify', updates: parsed.updates || {} });
      return { type: 'ambiguous', action: 'modify', candidates: resolved.candidates };
    }
    const updated = await modifyRecordById(userId, resolved.record.id, parsed.updates || {});
    if (!updated) return { type: 'modify_specific', unchanged: true, record: resolved.record };
    return { type: 'modify_specific', record: updated };
  }

  if (parsed.type === 'manage_unspecified') {
    let candidates = await getLastList(userId, { checkFreshness: true });
    const fromLastList = candidates.length > 0;
    if (!fromLastList) {
      candidates = await listRecentRecords(userId, 10);
    }
    await savePendingAction(userId, { action: 'select_for_action' });
    return { type: 'manage_unspecified', candidates, fromLastList };
  }

  if (parsed.type === 'set_budget') {
    const budget = await setBudget(userId, {
      salary: parsed.salary ?? null,
      savingsGoal: parsed.savingsGoal ?? null,
      spendingPercentage: parsed.spendingPercentage ?? null,
    });
    const catStatus = await getCategoryBudgetStatus(userId);
    return { type: 'set_budget', budget, categories: catStatus.table };
  }

  if (parsed.type === 'budget_status') {
    const status = await getBudgetStatus(userId);
    const catStatus = await getCategoryBudgetStatus(userId);
    if (!status) return { type: 'budget_status', notSet: true, categories: catStatus.table };
    return { type: 'budget_status', ...status, categories: catStatus.table };
  }

  if (parsed.type === 'set_category_budget') {
    if (typeof parsed.percentage !== 'number' || Number.isNaN(parsed.percentage)) {
      return { type: 'set_category_budget', missingPercentage: true, category: parsed.category || null };
    }
    const updated = await setCategoryBudget(userId, parsed.category, parsed.percentage);
    if (!updated) return { type: 'set_category_budget', invalid: true };
    const budget = await getBudget(userId);
    return { type: 'set_category_budget', allocation: updated, monthlyLimit: budget ? budget.monthlyLimit : null };
  }

  if (parsed.type === 'adjust_category_menu') {
    return { type: 'adjust_category_menu' };
  }

  if (parsed.type === 'adjust_category_percent_step') {
    if (!ALL_CATEGORIES.includes(parsed.category)) {
      return { type: 'set_category_budget', invalid: true };
    }
    const catStatus = await getCategoryBudgetStatus(userId);
    const current = catStatus.table.find((c) => c.category === parsed.category);
    return { type: 'adjust_category_percent_step', category: parsed.category, current: current ? current.percentage : 0 };
  }

  if (parsed.type === 'budget_help') {
    return { type: 'budget_help' };
  }

  if (parsed.type === 'list_menu') {
    return { type: 'list_menu' };
  }

  if (parsed.type === 'custom_range_help') {
    return { type: 'custom_range_help' };
  }

  if (parsed.type === 'help') {
    return { type: 'help' };
  }

  if (parsed.type === 'monthly_report') {
    const { dateStr } = getTodayInfo(timestamp);
    const month = parsed.month || dateStr.slice(0, 7);
    const report = await getMonthlyCategoryBreakdown(userId, month);
    const recentMonths = computeMonthNavOptions(dateStr.slice(0, 7), month);
    return { type: 'monthly_report', ...report, recentMonths };
  }

  return { type: 'none' };
}

// 給快速回覆用：從「今天所在月」往前推 N 個月的選項，排除目前正在看的月份
function computeMonthNavOptions(todayMonth, currentMonth, count = 5) {
  const [ty, tm] = todayMonth.split('-').map(Number);
  const pool = [];
  for (let i = 0; i <= count; i++) {
    let yy = ty;
    let mm = tm - i;
    while (mm <= 0) {
      mm += 12;
      yy -= 1;
    }
    pool.push(`${yy}-${String(mm).padStart(2, '0')}`);
  }
  return pool.filter((m) => m !== currentMonth).slice(0, count);
}

// 匯出給 webhook postback 用：切換月份時直接呼叫，不用經過 AI 判斷
export async function getMonthlyReportForMonth(userId, month, timestamp) {
  const { dateStr } = getTodayInfo(timestamp);
  const report = await getMonthlyCategoryBreakdown(userId, month);
  const recentMonths = computeMonthNavOptions(dateStr.slice(0, 7), month);
  return { ...report, recentMonths };
}