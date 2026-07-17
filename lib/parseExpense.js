import { GoogleGenerativeAI } from '@google/generative-ai';
import { getFirestore } from './firebaseAdmin';
import {
  DEFAULT_CATEGORY_ALLOCATION,
  getCategoryConfig,
  allCategoryNames,
  activeCategoryNames,
  buildCategoryDefs,
  getAllCategoryDefs,
  addCategory,
  setCategoryEnabled,
  setCategoryEmoji,
  renameCategoryConfig,
  findCategoryDef,
} from './categories';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite' });

// 新增或重新啟用分類時給的起始比例（不能是0%，理由見呼叫的地方）
const DEFAULT_NEW_CATEGORY_PERCENTAGE = 5;

// 如果帳號是在新增「固定支出」這個分類之前就設定過比例，存在 Firestore 的舊資料會缺這個 key。
// 這裡統一補齊：缺的分類給 0%，不動使用者已經自訂過的其他分類數值，也不會偷偷幫使用者重新分配
function normalizeAllocation(stored, categoryNames) {
  const source = stored || DEFAULT_CATEGORY_ALLOCATION;
  const normalized = {};
  categoryNames.forEach((cat) => {
    normalized[cat] = source[cat] ?? 0;
  });
  return normalized;
}

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

function buildPrompt(dateStr, weekday, message, activeNames, allNames) {
  return `你是記帳助手。現在日期是 ${dateStr}，星期${weekday}。
使用者目前「可用分類」（記帳、預算比例設定只能從這裡面選）：${JSON.stringify(activeNames)}
使用者「全部分類」（含已停用，查詢/列清單/停用啟用分類時可以用到）：${JSON.stringify(allNames)}
請判斷使用者輸入屬於哪一種意圖，只輸出 JSON，不要有任何其他文字、不要用 markdown code block 包住。

情況一：記帳（例如「今天午餐吃2200元」「午餐200，晚餐1500，計程車150」「7-11買了136元的麵包跟餅乾」），輸出：
{"type":"record","expenses":[{"date":"YYYY-MM-DD","item":"品項","amount":數字,"category":"分類","categoryConfidence":"high或low","note":""}]}
- date 從語句推算絕對日期；category 從上面「可用分類」選一個最可能的
- categoryConfidence：像「午餐」「計程車」「房租」這種明確的給 "high"；像「跟朋友出去花的」「買東西」「聚會」這種可能橫跨好幾類、不確定的給 "low"
- 拆成多筆的條件是「每個品項各自都有自己的金額」，例如「午餐200，晚餐1500，計程車150」是三筆，因為 200/1500/150 分別對應各自的品項
- 如果只有「一個總金額」但描述了多樣東西，一律記成「一筆」，不要拆
  - 有提到店名/地點（例如「7-11」「全聯」「家樂福」「星巴克」），item 用店名/地點，買了什麼細節放進 note。例如「7-11買了136元的麵包跟餅乾」→ 一筆 {"item":"7-11","amount":136,"note":"麵包、餅乾"}，不是兩筆各68元
  - 沒有店名，item 用頓號把品項列出來（例如「麵包、餅乾」），note 留空
- 如果「固定支出」在可用分類裡：這個分類專門給每月固定要繳、金額通常不變的支出用，例如房貸、房租、保險費、分期付款、訂閱服務（Netflix等）；不是每月都有、金額會變動的（例如水電費、電話費）還是照原本的分類判斷（居家、其他等）

情況二：統計查詢（例如「今天花多少」「這個月花多少」「這禮拜飲食類花多少」），輸出：
{"type":"query","startDate":"YYYY-MM-DD","endDate":"YYYY-MM-DD","category":"分類或null","label":"期間描述，例如：今天、這週、這個月"}
- 「這個月」指當月 1 號到今天；「這週」「本週」指這週一到今天；「上個月」指上個月 1 號到最後一天；「今年」指今年 1 月 1 號到今天；「去年」指去年 1 月 1 號到 12 月 31 號

情況三：列出清單（例如「列出所有飲食」「列出這個月醫療」「列出交通類」「列出今天所有記錄」「列出這週所有記錄」「列出上個月飲食」「列出今年交通」「列出去年娛樂」「列出不限日期的飲食」「本月明細」），輸出：
{"type":"list","category":"分類或null","startDate":"YYYY-MM-DD或null","endDate":"YYYY-MM-DD或null"}
- 「今天」startDate=endDate=今天；「這個月」「本月」指當月1號到今天；「這週」「本週」指這週一到今天；「上個月」指上個月1號到最後一天；「今年」指今年1月1號到今天；「去年」指去年1月1號到12月31號
- 只有使用者明確講「不限日期」「全部時間」時，才給 startDate/endDate 都是 null；沒講任何日期範圍（包括「所有」「全部」這種模糊講法）也一律給 null，讓後續程式判斷是否要反問

情況四：修改「上一筆」（沒有指定日期/品項，單純說「剛剛」「上一筆」，例如「剛剛打錯了改成250元」「剛剛那筆備註加一下氧氣機租借」），輸出：
{"type":"modify_last","updates":{"amount":數字,"item":"品項","category":"分類","date":"YYYY-MM-DD","note":"備註"}}
- updates 只放實際要改的欄位；「備註」「加註」這種字眼要填進 note，不要填進 item

情況五：刪除「上一筆」（同上，沒有指定日期/品項），例如「刪除上一筆」，輸出：
{"type":"delete_last"}

情況六：修改「特定一筆」（有指定日期、品項關鍵字、或列表中的第幾筆），例如「7/12的點心改成80元」「醫療那筆改成4800」「第2筆改成計程車」「7/12的點心備註改成氧氣機租借」，輸出：
{"type":"modify_specific","target":{"date":"YYYY-MM-DD或null","item":"品項關鍵字或null","index":數字或null},"updates":{"amount":數字或null,"item":"品項或null","category":"分類或null","date":"YYYY-MM-DD或null","note":"備註或null"}}
- updates 只放使用者實際要改的欄位；「備註」「加註」這種字眼要填進 note，不要填進 item

情況七：刪除「特定一筆或多筆」，可以一次刪多筆（例如「刪除7/12的點心」「刪掉醫療那筆」「刪除第2筆」「刪除今天的麵包跟餅乾」），輸出：
{"type":"delete_specific","targets":[{"date":"YYYY-MM-DD或null","item":"品項關鍵字或null","index":數字或null}]}
- 一次可以列多個目標放進 targets 陣列；只刪一筆也要用陣列包起來（陣列只有一個元素）
- 例如「刪除今天的麵包跟餅乾」要拆成兩個 target：{"date":"今天日期","item":"麵包"} 跟 {"date":"今天日期","item":"餅乾"}

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

情況十二：修改分類的預算比例，可以一次改一個或多個（例如「修改飲食為30%」「交通改成15%」「飲食調成30%，交通10%，居家25%」），輸出：
{"type":"set_category_budget","adjustments":[{"category":"分類","percentage":數字}]}
- category 必須是上面「可用分類」其中一個
- 一次可以列多個分類調整，每個都放進 adjustments 陣列；只改一個也要用陣列包起來（陣列只有一個元素）

情況十三：使用者想調整分類比例，但用按鈕選、沒有直接講數字或分類（例如「調整分類比例」「用按鈕改比例」），輸出：
{"type":"adjust_category_menu"}

情況十四：使用者選好要調整哪個分類，但還沒講要改成多少%（例如「調整飲食比例」「飲食比例要調」），輸出：
{"type":"adjust_category_percent_step","category":"分類"}
- category 必須是上面「可用分類」其中一個

情況十五：使用者想知道怎麼設定預算，但沒有直接給數字（例如「設定預算」「怎麼設定薪水」「預算怎麼設定」），輸出：
{"type":"budget_help"}

情況十五之一：使用者想刪除/清除預算相關設定，依範圍分三種，輸出：
{"type":"delete_budget","target":"goal或salary或all"}
- 只想刪存款目標/花費%，薪水要保留（例如「刪除目標」「取消存款目標」「不設定目標了」「清除花費比例」），target 給 "goal"
- 只想刪薪水（例如「刪除薪水」「清除薪水設定」），target 給 "salary"
- 想整組都清掉（例如「刪除預算」「清除預算設定」「重設預算」「取消預算設定」），target 給 "all"

情況十六：查看目前的分類比例配置（例如「目前比例」「查看分類比例」「現在的比例是多少」），輸出：
{"type":"view_category_allocation"}

情況十七：使用者直接講明要用哪個範圍來編輯/刪除（例如「近10筆」「近20筆」「最近查看的清單」「剛查看的清單」），輸出：
{"type":"manage_start_direct","source":"recent10或recent20或lastList"}
- 「近10筆」用 recent10；「近20筆」用 recent20；「最近查看的清單」「剛查看的清單」用 lastList

情況十六：使用者想查明細但沒指定範圍或分類（例如「明細」「查詢明細」「我要看明細」），輸出：
{"type":"list_menu"}

情況十七：使用者想自訂查詢區間（例如「自訂區間」「其他區間」），輸出：
{"type":"custom_range_help"}

情況十七之一：使用者想新增一個自訂分類（例如「新增分類寵物」「新增一個分類叫寵物」「新增分類 寵物 🐾」），輸出：
{"type":"add_category","name":"分類名稱","emoji":"訊息中出現的emoji字元或null"}
- name 不含「新增分類」這幾個字，只留分類名稱本身
- 如果訊息裡有一個 emoji 符號，取出來放進 emoji；沒有就給 null

情況十七之二：使用者想停用一或多個分類，不想再看到它們出現在記帳選項裡（例如「停用醫療」「停用其他跟娛樂」「醫療分類不要了」「關閉購物這個分類」），輸出：
{"type":"disable_category","categories":["分類名稱1","分類名稱2"]}
- categories 是陣列，可以放一個或多個分類名稱；只停用一個也要用陣列包起來（陣列只有一個元素），不要輸出多個 JSON 物件
- 每個分類名稱從上面「全部分類」裡找最符合的一個（含已停用的也算，方便重複操作時能得到明確回覆）

情況十七之三：使用者想啟用/恢復一或多個先前停用的分類（例如「啟用醫療」「打開購物跟醫療」「恢復醫療分類」），輸出：
{"type":"enable_category","categories":["分類名稱1","分類名稱2"]}
- categories 是陣列，可以放一個或多個分類名稱；只啟用一個也要用陣列包起來（陣列只有一個元素），不要輸出多個 JSON 物件
- 每個分類名稱從上面「全部分類」裡找最符合的一個

情況十七之四：使用者想看目前有哪些分類、分類設定狀況（例如「分類設定」「設定分類」「目前有哪些分類」「分類清單」「看分類」），輸出：
{"type":"category_settings"}

情況十七之五：使用者想修改一個分類的 emoji 圖示（例如「運動的emoji改成🏃」「修改運動分類emoji為🏃」「運動類圖示換成🏃」），輸出：
{"type":"set_category_emoji","category":"分類名稱","emoji":"emoji字元"}
- category 從上面「全部分類」裡找最符合的一個
- emoji 是訊息裡出現的那個 emoji 符號；如果訊息沒有包含任何 emoji，emoji 給 null

情況十七之六：使用者想修改一個自訂分類的名稱（例如「運動改名叫健身」「把寵物改名成毛孩」「運動類的名稱改成健身」），輸出：
{"type":"rename_category","from":"舊名稱","to":"新名稱"}
- from 從上面「全部分類」裡找最符合的一個

情況十七之七：使用者想開啟設定選單，但不確定要設定什麼（例如「設定」「我要設定」「設定選單」），輸出：
{"type":"settings_menu"}

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

async function classifyMessage(message, timestamp, activeNames, allNames) {
  const { dateStr, weekday } = getTodayInfo(timestamp);
  const prompt = buildPrompt(dateStr, weekday, message, activeNames, allNames);
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
function buildUpdatePrompt(dateStr, weekday, message, activeNames) {
  return `你是記帳助手。現在日期是 ${dateStr}，星期${weekday}。
使用者剛才選好要編輯哪一筆記錄，這句話是在描述要把這筆記錄改成什麼。
請解析成 JSON，只輸出 JSON，不要有其他文字：
{"amount":數字或null,"item":"品項或null","category":"分類或null","date":"YYYY-MM-DD或null","note":"備註或null"}
- category 從 ${JSON.stringify(activeNames)} 選一個
- 只填使用者有提到的欄位，其他給 null
- 如果使用者講的是「金額多少」「改成什麼品項」「改成哪一天」「改成哪一類」，對應填到 amount/item/date/category
- 如果使用者明確講「備註」「加註」「新增備註」這種字眼，或單純想補充說明（不是要換掉品項本身），要填進 note，不要填進 item

使用者輸入：「${message}」`;
}

async function parseUpdateFields(message, timestamp, activeNames) {
  const { dateStr, weekday } = getTodayInfo(timestamp);
  const prompt = buildUpdatePrompt(dateStr, weekday, message, activeNames);
  const result = await model.generateContent(prompt);
  const text = cleanJson(result.response.text());

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {};
  }

  const updates = {};
  for (const key of ['amount', 'item', 'category', 'date', 'note']) {
    if (parsed[key] !== undefined && parsed[key] !== null) updates[key] = parsed[key];
  }
  return updates;
}

// 使用者說的分類名稱不一定完全比對，允許包含比對（跟 confirm_category 流程的比對邏輯一致）
function matchCategoryName(names, spoken) {
  if (!spoken) return null;
  const trimmed = spoken.trim();
  return names.find((c) => trimmed === c || trimmed.includes(c) || c.includes(trimmed)) || null;
}

// 停用單一分類：回收它的預算比例分給其他啟用中的分類，回傳收回的比例讓呼叫端可以提示使用者
async function disableOneCategory(userId, matched) {
  const cfgNow = await getCategoryConfig(userId);
  if (cfgNow.disabled.includes(matched)) return { category: matched, alreadyDisabled: true };
  const activeNow = activeCategoryNames(cfgNow);
  if (activeNow.length <= 1) return { category: matched, lastOne: true };

  // 用 normalizeAllocation 而不是直接讀 budget.categoryAllocation[matched]：
  // 使用者從沒手動調過的內建分類，比例是活在 DEFAULT_CATEGORY_ALLOCATION 的 fallback 裡，
  // 不會真的存在 Firestore 文件裡，直接讀欄位會拿到 undefined
  const budget = await getBudget(userId);
  const currentAllocation = normalizeAllocation(budget && budget.categoryAllocation, activeNow);
  const reclaimedPct = currentAllocation[matched] || 0;
  await setCategoryBudgets(userId, [{ category: matched, percentage: 0 }]);
  await setCategoryEnabled(userId, matched, false);
  return { category: matched, ok: true, reclaimedPct };
}

// 啟用單一分類
async function enableOneCategory(userId, matched) {
  const result = await setCategoryEnabled(userId, matched, true);
  if (result.alreadyEnabled) return { category: matched, alreadyEnabled: true };
  // 跟新增分類一樣：0% 的分類長條圖幾乎看不到線，也沒有實際的起始比例可以調整，先給個非0%的基準值
  await setCategoryBudgets(userId, [{ category: matched, percentage: DEFAULT_NEW_CATEGORY_PERCENTAGE }]);
  return { category: matched, ok: true };
}

// 給 Rich Menu 以外的「點列切換」用：不經過 AI 分類，直接依目前狀態切換
export async function toggleCategoryEnabled(userId, name) {
  const cfg = await getCategoryConfig(userId);
  if (!allCategoryNames(cfg).includes(name)) {
    return { type: 'disable_category', results: [{ requested: name, notFound: true }] };
  }
  const isActive = activeCategoryNames(cfg).includes(name);
  if (isActive) {
    const r = await disableOneCategory(userId, name);
    return { type: 'disable_category', results: [r] };
  }
  const r = await enableOneCategory(userId, name);
  return { type: 'enable_category', results: [r] };
}

// 分類設定的「已停用」清單一頁最多顯示幾筆，跟啟用中分類的上限（12）用同一個數字
const DISABLED_CATEGORY_PAGE_LIMIT = 5;

// 從完整分類定義裡切出「已停用」清單的其中一頁
function buildDisabledCategoryPage(defs, offset) {
  const disabledDefs = defs.filter((d) => !d.enabled);
  const page = disabledDefs.slice(offset, offset + DISABLED_CATEGORY_PAGE_LIMIT);
  const nextOffset = offset + DISABLED_CATEGORY_PAGE_LIMIT;
  const hasMore = nextOffset < disabledDefs.length;
  return { defs: page, offset, nextOffset, hasMore, total: disabledDefs.length };
}

// 分類設定的完整視圖：啟用中的分類（結構上保證 ≤12 筆，不需要分頁，一次全部顯示）
// + 已停用分類的第一頁（沒有上限、只增不減，超過 DISABLED_CATEGORY_PAGE_LIMIT 才會出現「看更多」）
export async function getCategorySettingsView(userId) {
  const defs = await getAllCategoryDefs(userId);
  const activeDefs = defs.filter((d) => d.enabled);
  const disabled = buildDisabledCategoryPage(defs, 0);
  return { type: 'category_settings', activeDefs, disabled };
}

// 「已停用」清單的「看更多」用：不用重送啟用中分類那張卡，只回覆已停用清單的下一頁
export async function getCategorySettingsMore(userId, offset) {
  const defs = await getAllCategoryDefs(userId);
  const disabled = buildDisabledCategoryPage(defs, offset);
  return { type: 'category_settings_more', disabled };
}

// 點分類設定裡的某一列，彈出這個分類可以做的動作（改emoji/改名/啟用停用），一次列出、一次處理
export async function startCategoryActionMenu(userId, name) {
  const cfg = await getCategoryConfig(userId);
  if (!allCategoryNames(cfg).includes(name)) {
    return { type: 'category_action_menu', notFound: true, requested: name };
  }
  const isCustom = cfg.custom.some((c) => c.name === name);
  const enabled = !cfg.disabled.includes(name);
  return { type: 'category_action_menu', category: name, enabled, isCustom };
}

// 選單裡點「修改emoji」：內建分類直接回絕，自訂分類進入「等待輸入新emoji」的引導狀態
export async function startCategoryEmojiEdit(userId, name) {
  const cfg = await getCategoryConfig(userId);
  if (!allCategoryNames(cfg).includes(name)) {
    return { type: 'category_action_menu', notFound: true, requested: name };
  }
  const isCustom = cfg.custom.some((c) => c.name === name);
  if (!isCustom) return { type: 'set_category_emoji', builtin: true, category: name };
  await savePendingAction(userId, { action: 'awaiting_category_emoji', category: name });
  return { type: 'awaiting_category_emoji', category: name };
}

// 選單裡點「修改名稱」：內建分類直接回絕，自訂分類進入「等待輸入新名稱」的引導狀態
export async function startCategoryRename(userId, name) {
  const cfg = await getCategoryConfig(userId);
  if (!allCategoryNames(cfg).includes(name)) {
    return { type: 'category_action_menu', notFound: true, requested: name };
  }
  const isCustom = cfg.custom.some((c) => c.name === name);
  if (!isCustom) return { type: 'rename_category', builtin: true, category: name };
  await savePendingAction(userId, { action: 'awaiting_category_rename', category: name });
  return { type: 'awaiting_category_rename', category: name };
}

// 改名：先改 categoryConfig 本身，成功的話再把既有記錄的 category 欄位、預算比例的 key 一併遷移過去，
// 不然改名後舊記錄跟預算比例會變成孤兒（查不到、對不上分類設定裡的名字）
async function renameCategoryEverywhere(userId, oldName, newName) {
  const result = await renameCategoryConfig(userId, oldName, newName);
  if (!result.ok) return { ...result, oldName, newName };

  const snapshot = await recordsCollection(userId).where('category', '==', oldName).get();
  if (!snapshot.empty) {
    const BATCH_SIZE = 400;
    const docs = snapshot.docs;
    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
      const batch = getFirestore().batch();
      docs.slice(i, i + BATCH_SIZE).forEach((doc) => batch.update(doc.ref, { category: newName }));
      await batch.commit();
    }
  }

  const budget = await getBudget(userId);
  if (budget && budget.categoryAllocation && oldName in budget.categoryAllocation) {
    const newAllocation = { ...budget.categoryAllocation };
    newAllocation[newName] = newAllocation[oldName];
    delete newAllocation[oldName];
    await userDoc(userId).set({ budget: { ...budget, categoryAllocation: newAllocation } }, { merge: true });
  }

  return { ok: true, defs: result.defs, oldName, newName };
}

function recordsCollection(userId) {
  return getFirestore().collection('expenses').doc(userId).collection('records');
}

function userDoc(userId) {
  return getFirestore().collection('expenses').doc(userId);
}

// 給明細清單的按鈕直接呼叫：不用先選「要編輯還是刪除」，按鈕本身就決定了動作
export async function startEditRecord(userId, recordId) {
  const doc = await recordsCollection(userId).doc(recordId).get();
  if (!doc.exists) return { type: 'not_found' };
  await savePendingAction(userId, { action: 'awaiting_value', targetId: recordId });
  return { type: 'awaiting_value', record: { id: recordId, ...doc.data() } };
}

// 給垃圾桶按鈕呼叫：先跳確認，不直接刪，真的要刪要再點一次確認裡的按鈕
export async function startConfirmDelete(userId, recordId) {
  const doc = await recordsCollection(userId).doc(recordId).get();
  if (!doc.exists) return { type: 'not_found' };
  await savePendingAction(userId, { action: 'confirm_delete', targetId: recordId });
  return { type: 'confirm_delete', record: { id: recordId, ...doc.data() } };
}

export async function deleteRecordDirect(userId, recordId) {
  const doc = await recordsCollection(userId).doc(recordId).get();
  if (!doc.exists) return { type: 'not_found' };
  await recordsCollection(userId).doc(recordId).delete();
  await removeFromLastList(userId, recordId);
  await clearPendingAction(userId);
  return { type: 'delete_specific', deleted: { id: recordId, ...doc.data() } };
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
  for (const key of ['amount', 'item', 'category', 'date', 'note']) {
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
  await removeFromLastList(userId, last.id);
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

// 記錄被刪除後，如果它還留在「最近查看清單」的快照裡，要一併移除，
// 不然下次選「最近查看的清單」還會看到已經刪掉的那筆
async function removeFromLastList(userId, recordId) {
  const doc = await userDoc(userId).get();
  if (!doc.exists) return;
  const list = doc.data().lastList || [];
  const filtered = list.filter((r) => r.id !== recordId);
  if (filtered.length !== list.length) {
    const reindexed = filtered.map((r, i) => ({ ...r, index: i + 1 }));
    await userDoc(userId).set({ lastList: reindexed }, { merge: true });
  }
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
const LARGE_RESULT_THRESHOLD = 100; // 超過這個筆數就建議直接匯出，不逼使用者一頁一頁翻

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
  const defs = await getAllCategoryDefs(userId);
  const categoryEmojiMap = {};
  defs.forEach((d) => {
    categoryEmojiMap[d.name] = d.emoji;
  });
  return {
    records: indexed,
    total: fullTotal,
    count: fullCount,
    offset,
    nextOffset,
    hasMore,
    category,
    startDate,
    endDate,
    categoryEmojiMap,
  };
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

  // 「最近 N 筆」本身就是照最近建立的排序，維持這個順序顯示（最新的排最上面）比較符合直覺，
  // 不像明細查詢（getListPage）是瀏覽一段日期區間，那個才適合照日期由舊到新排
  records.sort((a, b) => b.date.localeCompare(a.date) || b.amount - a.amount);

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
    } else {
      // 沒填存款目標也沒填百分比：預設整筆薪水都算可花費上限
      monthlyLimit = salary;
    }
  }

  const budget = { salary, savingsGoal, spendingPercentage, monthlyLimit };
  await userDoc(userId).set({ budget }, { merge: true });
  return budget;
}

// 清除薪水/目標/每月上限，分類比例配置（categoryAllocation）維持不動
// target: 'goal'（只清存款目標/花費%）、'salary'（只清薪水）、'all'（全部清空）
async function clearBudget(userId, target) {
  const existing = (await getBudget(userId)) || {};
  let salary = existing.salary ?? null;
  let savingsGoal = existing.savingsGoal ?? null;
  let spendingPercentage = existing.spendingPercentage ?? null;

  if (target === 'goal') {
    savingsGoal = null;
    spendingPercentage = null;
  } else if (target === 'salary') {
    salary = null;
  } else {
    salary = null;
    savingsGoal = null;
    spendingPercentage = null;
  }

  // 跟 setBudget() 用同一套公式重算上限：只剩薪水、沒有目標的話，上限=整筆薪水都算可花費
  let monthlyLimit = null;
  if (salary != null) {
    if (savingsGoal != null) {
      monthlyLimit = salary - savingsGoal;
    } else if (spendingPercentage != null) {
      monthlyLimit = Math.round((salary * spendingPercentage) / 100);
    } else {
      monthlyLimit = salary;
    }
  }

  const budget = {
    salary,
    savingsGoal,
    spendingPercentage,
    monthlyLimit,
    categoryAllocation: existing.categoryAllocation || null,
  };
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

  const cfg = await getCategoryConfig(userId);
  const active = activeCategoryNames(cfg);

  const { dateStr } = getTodayInfo();
  const month = dateStr.slice(0, 7);
  const monthStat = await getMonthlyCategoryBreakdown(userId, month);

  // 已停用分類的花費不計入預算上限：停用代表「以後不追蹤這個分類的預算」，
  // 過去花的錢還是誠實記在報表跟明細裡（見 getCategoryBudgetStatus），但不該拖累「還可以花多少」的數字
  let spent = 0;
  let disabledSpent = 0;
  monthStat.categories.forEach((c) => {
    if (active.includes(c.category)) {
      spent += c.amount;
    } else {
      disabledSpent += c.amount;
    }
  });

  const remaining = budget.monthlyLimit - spent;
  const percentageUsed =
    budget.monthlyLimit > 0 ? Math.round((spent / budget.monthlyLimit) * 1000) / 10 : 0;

  return {
    ...budget,
    month,
    spent,
    remaining,
    percentageUsed,
    disabledSpent,
    warningLevel: getWarningLevel(spent, budget.monthlyLimit),
  };
}

// 一次調整一到多個分類，沒講到的分類依原本的相對比例自動補滿剩下的%（只在「目前啟用中」的分類範圍內分配）
async function setCategoryBudgets(userId, adjustments) {
  const cfg = await getCategoryConfig(userId);
  const active = activeCategoryNames(cfg);

  const existingBudget = (await getBudget(userId)) || {};
  const current = normalizeAllocation(existingBudget.categoryAllocation, active);

  // 檢查分類名稱都合法（必須是目前啟用中的分類）
  const invalidCategory = adjustments.find((a) => !active.includes(a.category));
  if (invalidCategory) return { invalid: true };

  // 同一分類講兩次的話，取最後一次講的
  const specifiedMap = {};
  adjustments.forEach((a) => {
    specifiedMap[a.category] = Math.max(0, Math.min(100, Math.round(a.percentage)));
  });

  const specifiedCategories = Object.keys(specifiedMap);
  const specifiedSum = Object.values(specifiedMap).reduce((s, v) => s + v, 0);

  if (specifiedSum > 100) {
    return { tooMuch: true, specifiedSum };
  }

  const otherKeys = active.filter((cat) => !specifiedCategories.includes(cat));
  const remaining = 100 - specifiedSum;

  // 如果啟用中的分類全部都講了，沒有剩下的分類可以吸收差額，加起來必須剛好 100%
  if (otherKeys.length === 0) {
    if (specifiedSum !== 100) return { allSpecifiedMismatch: true, specifiedSum };
    const updatedBudget = { ...existingBudget, categoryAllocation: specifiedMap };
    await userDoc(userId).set({ budget: updatedBudget }, { merge: true });
    const ordered = {};
    active.forEach((cat) => {
      ordered[cat] = specifiedMap[cat];
    });
    return { allocation: ordered };
  }

  const othersOldSum = otherKeys.reduce((s, cat) => s + (current[cat] ?? 0), 0);
  const updated = { ...specifiedMap };
  let assigned = 0;

  otherKeys.forEach((cat, i) => {
    const isLast = i === otherKeys.length - 1;
    if (isLast) {
      updated[cat] = Math.max(0, remaining - assigned);
      return;
    }
    let pct;
    if (othersOldSum <= 0) {
      pct = Math.round(remaining / otherKeys.length);
    } else {
      pct = Math.round(((current[cat] ?? 0) * remaining) / othersOldSum);
    }
    updated[cat] = Math.max(0, pct);
    assigned += updated[cat];
  });

  const updatedBudget = { ...existingBudget, categoryAllocation: updated };
  await userDoc(userId).set({ budget: updatedBudget }, { merge: true });

  // 依目前啟用中分類的固定順序輸出，不要用物件鍵值順序
  const ordered = {};
  active.forEach((cat) => {
    ordered[cat] = updated[cat];
  });
  return { allocation: ordered };
}

async function getCategoryBudgetStatus(userId) {
  const budget = await getBudget(userId);
  const cfg = await getCategoryConfig(userId);
  const active = activeCategoryNames(cfg);
  const defs = buildCategoryDefs(cfg);
  const allocation = normalizeAllocation(budget && budget.categoryAllocation, active);
  const monthlyLimit = budget ? budget.monthlyLimit : null;

  const { dateStr } = getTodayInfo();
  const month = dateStr.slice(0, 7);
  const monthStat = await getMonthlyCategoryBreakdown(userId, month);
  const spentByCategory = {};
  monthStat.categories.forEach((c) => {
    spentByCategory[c.category] = c.amount;
  });

  const activeTable = active.map((cat) => {
    const pct = allocation[cat] ?? 0;
    const allocatedAmount = monthlyLimit != null ? Math.round((monthlyLimit * pct) / 100) : null;
    const spent = spentByCategory[cat] || 0;
    const remaining = allocatedAmount != null ? allocatedAmount - spent : null;
    return {
      category: cat,
      emoji: findCategoryDef(defs, cat)?.emoji || '',
      percentage: pct,
      allocatedAmount,
      spent,
      remaining,
      warningLevel: getWarningLevel(spent, allocatedAmount),
      disabled: false,
    };
  });

  // 已停用但這個月還是有花費的分類：沒有比例/預算上限可比較，只單純顯示花了多少，
  // 標成已停用讓使用者知道為什麼會出現在這裡；下個月如果沒有這個分類的花費，就不會再出現
  const disabledWithSpending = Object.keys(spentByCategory)
    .filter((cat) => !active.includes(cat) && spentByCategory[cat] > 0)
    .map((cat) => ({
      category: cat,
      emoji: findCategoryDef(defs, cat)?.emoji || '',
      percentage: null,
      allocatedAmount: null,
      spent: spentByCategory[cat],
      remaining: null,
      warningLevel: 'ok',
      disabled: true,
    }));

  const table = [...activeTable, ...disabledWithSpending];

  return { allocation, monthlyLimit, month, table };
}

// 給報表頁用：某月份依分類加總。用資料驅動（不是寫死分類清單），才能涵蓋自訂分類跟已停用分類的歷史資料；
// 排序依照目前的分類定義順序（內建在前、自訂在後），定義裡找不到的（例如分類後來改過名）排最後
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

  const defs = await getAllCategoryDefs(userId);
  const orderedNames = defs.map((d) => d.name);
  const extraNames = Object.keys(byCategory).filter((c) => !orderedNames.includes(c));

  const categories = [...orderedNames, ...extraNames]
    .filter((cat) => byCategory[cat] > 0)
    .map((category) => {
      const def = findCategoryDef(defs, category);
      return {
        category,
        amount: byCategory[category],
        percentage: total > 0 ? Math.round((byCategory[category] / total) * 1000) / 10 : 0,
        emoji: def?.emoji || '',
        color: def?.color || '#9ca3af',
        disabled: def ? !def.enabled : false,
      };
    });

  return { month, startDate, endDate, total, count: snapshot.size, categories };
}

// 給「編輯」的範圍選單用：依使用者選的來源抓候選清單，繞過 AI 分類直接呼叫
export async function startManageFlow(userId, source) {
  let candidates;
  let fromLastList = false;

  if (source === 'lastList') {
    candidates = await getLastList(userId, { checkFreshness: true });
    fromLastList = candidates.length > 0;
  } else if (source === 'recent20') {
    candidates = await listRecentRecords(userId, 20);
  } else {
    candidates = await listRecentRecords(userId, 10);
  }

  await savePendingAction(userId, { action: 'select_for_action' });
  const defs = await getAllCategoryDefs(userId);
  const categoryEmojiMap = {};
  defs.forEach((d) => {
    categoryEmojiMap[d.name] = d.emoji;
  });
  return { type: 'manage_unspecified', candidates, fromLastList, categoryEmojiMap };
}

export async function handleMessage(userId, message, timestamp) {
  const pendingBefore = await getPendingAction(userId);
  const categoryCfg = await getCategoryConfig(userId);
  const allDefs = buildCategoryDefs(categoryCfg);
  const activeDefs = allDefs.filter((c) => c.enabled);
  const activeNames = activeDefs.map((c) => c.name);
  const allNames = allDefs.map((c) => c.name);
  const categoryEmojiMap = {};
  allDefs.forEach((d) => {
    categoryEmojiMap[d.name] = d.emoji;
  });

  // 使用者正在回答「這筆算哪一類」
  if (pendingBefore && pendingBefore.action === 'confirm_category') {
    const trimmed = message.trim();

    if (trimmed === '取消' || trimmed.toLowerCase() === 'cancel') {
      const skippedCount = pendingBefore.queue.length + 1;
      await clearPendingAction(userId);
      return { type: 'confirm_category_cancelled', skippedCount };
    }

    const matched = activeNames.find((c) => trimmed === c || trimmed.includes(c));

    if (!matched) {
      return {
        type: 'confirm_category',
        invalid: true,
        item: pendingBefore.currentItem,
        options: activeDefs,
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
        options: activeDefs,
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

    const updates = await parseUpdateFields(message, timestamp, activeNames);
    await clearPendingAction(userId);
    if (Object.keys(updates).length === 0) {
      return { type: 'modify_specific', unchanged: true };
    }
    const updated = await modifyRecordById(userId, pendingBefore.targetId, updates);
    if (!updated) return { type: 'modify_specific', unchanged: true };
    return { type: 'modify_specific', record: updated };
  }

  // 使用者剛點了「修改emoji」，這句話就是新的emoji
  if (pendingBefore && pendingBefore.action === 'awaiting_category_emoji') {
    const trimmed = message.trim();
    await clearPendingAction(userId);
    if (trimmed === '取消' || trimmed.toLowerCase() === 'cancel') {
      return { type: 'manage_cancelled' };
    }
    const result = await setCategoryEmoji(userId, pendingBefore.category, trimmed);
    if (result.builtin) return { type: 'set_category_emoji', builtin: true, category: pendingBefore.category };
    if (result.notFound) return { type: 'set_category_emoji', notFound: true, requested: pendingBefore.category };
    if (result.invalidEmoji) return { type: 'set_category_emoji', invalidEmoji: true, category: pendingBefore.category };
    return { type: 'set_category_emoji', category: pendingBefore.category, emoji: trimmed };
  }

  // 使用者剛點了「修改名稱」，這句話就是新的名稱
  if (pendingBefore && pendingBefore.action === 'awaiting_category_rename') {
    const trimmed = message.trim();
    await clearPendingAction(userId);
    if (trimmed === '取消' || trimmed.toLowerCase() === 'cancel') {
      return { type: 'manage_cancelled' };
    }
    const result = await renameCategoryEverywhere(userId, pendingBefore.category, trimmed);
    return { type: 'rename_category', ...result };
  }

  // 使用者正在確認要不要真的刪除這一筆
  if (pendingBefore && pendingBefore.action === 'confirm_delete') {
    const trimmed = message.trim();
    const targetId = pendingBefore.targetId;

    if (trimmed === '取消' || trimmed.toLowerCase() === 'cancel') {
      await clearPendingAction(userId);
      return { type: 'manage_cancelled' };
    }

    if (trimmed === '刪除' || trimmed === '確定刪除' || trimmed === '確定') {
      return await deleteRecordDirect(userId, targetId);
    }

    // 看不懂的回覆，重新問一次
    const doc = await recordsCollection(userId).doc(targetId).get();
    if (!doc.exists) {
      await clearPendingAction(userId);
      return { type: 'not_found' };
    }
    return { type: 'confirm_delete', record: { id: targetId, ...doc.data() }, invalid: true };
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

  const parsed = await classifyMessage(message, timestamp, activeNames, allNames);

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
      // 選好是哪一筆了，等同於直接點列進編輯；要刪除的話可以點🗑️或直接說「刪除第X筆」
      await savePendingAction(userId, { action: 'awaiting_value', targetId: found.id });
      const doc = await recordsCollection(userId).doc(found.id).get();
      return { type: 'awaiting_value', record: { id: found.id, ...doc.data() } };
    }

    await clearPendingAction(userId);

    if (pendingBefore.action === 'delete') {
      const doc = await recordsCollection(userId).doc(found.id).get();
      if (!doc.exists) return { type: 'not_found' };
      await recordsCollection(userId).doc(found.id).delete();
      await removeFromLastList(userId, found.id);
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
        options: activeDefs,
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
      categoryEmojiMap,
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

    // 資料量太大時，翻頁體驗很差，直接建議匯出而不是硬塞清單
    if (result.count > LARGE_RESULT_THRESHOLD) {
      return {
        type: 'list_large',
        count: result.count,
        total: result.total,
        category,
        startDate,
        endDate,
      };
    }

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
    const targets = parsed.targets && parsed.targets.length > 0 ? parsed.targets : parsed.target ? [parsed.target] : [];
    if (targets.length === 0) return { type: 'not_found' };

    if (targets.length === 1) {
      const resolved = await resolveTarget(userId, targets[0]);
      if (resolved.notFound) return { type: 'not_found' };
      if (resolved.ambiguous) {
        await savePendingAction(userId, { action: 'delete' });
        return { type: 'ambiguous', action: 'delete', candidates: resolved.candidates, categoryEmojiMap };
      }
      await recordsCollection(userId).doc(resolved.record.id).delete();
      await removeFromLastList(userId, resolved.record.id);
      return { type: 'delete_specific', deleted: resolved.record };
    }

    // 多筆批次刪除：每個目標各自比對，只有明確比對到唯一一筆才刪，
    // 模糊到多筆的先跳過（不猜、不整批刪），讓使用者用更精確的方式再處理
    const deleted = [];
    const notFound = [];
    const ambiguousTargets = [];
    for (const target of targets) {
      const resolved = await resolveTarget(userId, target);
      if (resolved.notFound) {
        notFound.push(target);
        continue;
      }
      if (resolved.ambiguous) {
        ambiguousTargets.push({ target, candidates: resolved.candidates });
        continue;
      }
      await recordsCollection(userId).doc(resolved.record.id).delete();
      await removeFromLastList(userId, resolved.record.id);
      deleted.push(resolved.record);
    }
    return { type: 'delete_batch', deleted, notFound, ambiguousTargets };
  }

  if (parsed.type === 'modify_specific') {
    const resolved = await resolveTarget(userId, parsed.target || {});
    if (resolved.notFound) return { type: 'not_found' };
    if (resolved.ambiguous) {
      await savePendingAction(userId, { action: 'modify', updates: parsed.updates || {} });
      return { type: 'ambiguous', action: 'modify', candidates: resolved.candidates, categoryEmojiMap };
    }
    const updated = await modifyRecordById(userId, resolved.record.id, parsed.updates || {});
    if (!updated) return { type: 'modify_specific', unchanged: true, record: resolved.record };
    return { type: 'modify_specific', record: updated };
  }

  if (parsed.type === 'manage_unspecified') {
    const lastList = await getLastList(userId, { checkFreshness: true });
    if (lastList.length > 0) {
      return await startManageFlow(userId, 'lastList');
    }
    return await startManageFlow(userId, 'recent20');
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
    const adjustments = parsed.adjustments || [];
    if (adjustments.length === 0) {
      return { type: 'set_category_budget', missingPercentage: true, category: null };
    }
    const badItem = adjustments.find((a) => typeof a.percentage !== 'number' || Number.isNaN(a.percentage));
    if (badItem) {
      return { type: 'set_category_budget', missingPercentage: true, category: badItem.category || null };
    }
    // 明確要求設成 0% 的話，引導改用「停用」：0% 但仍啟用中的分類會繼續出現在記帳選單/分類設定裡，沒有實際用處
    const zeroItem = adjustments.find((a) => a.percentage === 0);
    if (zeroItem) {
      return { type: 'set_category_budget', zeroNotAllowed: true, category: zeroItem.category };
    }

    const result = await setCategoryBudgets(userId, adjustments);
    if (result.invalid) return { type: 'set_category_budget', invalid: true };
    if (result.tooMuch) return { type: 'set_category_budget', tooMuch: true, specifiedSum: result.specifiedSum };
    if (result.allSpecifiedMismatch) {
      return { type: 'set_category_budget', allSpecifiedMismatch: true, specifiedSum: result.specifiedSum };
    }
    const budget = await getBudget(userId);
    return {
      type: 'set_category_budget',
      allocation: result.allocation,
      monthlyLimit: budget ? budget.monthlyLimit : null,
      specified: adjustments.map((a) => a.category),
      categories: activeDefs,
    };
  }

  if (parsed.type === 'adjust_category_menu') {
    return { type: 'adjust_category_menu', categories: activeDefs };
  }

  if (parsed.type === 'adjust_category_percent_step') {
    if (!activeNames.includes(parsed.category)) {
      return { type: 'set_category_budget', invalid: true };
    }
    const catStatus = await getCategoryBudgetStatus(userId);
    const current = catStatus.table.find((c) => c.category === parsed.category);
    return { type: 'adjust_category_percent_step', category: parsed.category, current: current ? current.percentage : 0 };
  }

  if (parsed.type === 'budget_help') {
    const budget = await getBudget(userId);
    return { type: 'budget_help', budget };
  }

  if (parsed.type === 'delete_budget') {
    const target = parsed.target === 'goal' || parsed.target === 'salary' ? parsed.target : 'all';
    const existing = await getBudget(userId);
    const hasSomethingToDelete =
      existing &&
      (target === 'goal'
        ? existing.savingsGoal != null || existing.spendingPercentage != null
        : target === 'salary'
        ? existing.salary != null
        : existing.salary != null || existing.savingsGoal != null || existing.spendingPercentage != null);

    if (!hasSomethingToDelete) {
      return { type: 'delete_budget', wasEmpty: true, target };
    }
    const budget = await clearBudget(userId, target);
    return { type: 'delete_budget', wasEmpty: false, target, budget };
  }

  if (parsed.type === 'view_category_allocation') {
    const catStatus = await getCategoryBudgetStatus(userId);
    return {
      type: 'view_category_allocation',
      allocation: catStatus.allocation,
      monthlyLimit: catStatus.monthlyLimit,
      categories: activeDefs,
    };
  }

  if (parsed.type === 'manage_start_direct') {
    return await startManageFlow(userId, parsed.source);
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

  if (parsed.type === 'add_category') {
    const result = await addCategory(userId, parsed.name, parsed.emoji);
    if (result.invalid) return { type: 'add_category', invalid: true };
    if (result.tooLong) return { type: 'add_category', tooLong: true, maxLength: result.maxLength };
    if (result.invalidEmoji) return { type: 'add_category', invalidEmoji: true };
    if (result.duplicate) return { type: 'add_category', duplicate: true, name: parsed.name };
    if (result.tooMany) return { type: 'add_category', tooMany: true, max: result.max };
    // 給新分類一個非0%的起始比例：0% 的分類長條圖幾乎看不到線，也沒有實際的起始比例可以調整
    await setCategoryBudgets(userId, [{ category: result.added, percentage: DEFAULT_NEW_CATEGORY_PERCENTAGE }]);
    return { type: 'add_category', added: result.added, defs: result.defs };
  }

  if (parsed.type === 'disable_category') {
    const requested = parsed.categories && parsed.categories.length > 0 ? parsed.categories : [];
    if (requested.length === 0) return { type: 'disable_category', results: [] };

    const results = [];
    for (const reqCat of requested) {
      // 每次迭代都重新讀取最新狀態，因為前一筆的停用結果會影響「是不是最後一個啟用中的分類」的判斷
      const cfgNow = await getCategoryConfig(userId);
      const matched = matchCategoryName(allCategoryNames(cfgNow), reqCat);
      if (!matched) {
        results.push({ requested: reqCat, notFound: true });
        continue;
      }
      results.push(await disableOneCategory(userId, matched));
    }
    return { type: 'disable_category', results };
  }

  if (parsed.type === 'enable_category') {
    const requested = parsed.categories && parsed.categories.length > 0 ? parsed.categories : [];
    if (requested.length === 0) return { type: 'enable_category', results: [] };

    const results = [];
    for (const reqCat of requested) {
      const cfgNow = await getCategoryConfig(userId);
      const matched = matchCategoryName(allCategoryNames(cfgNow), reqCat);
      if (!matched) {
        results.push({ requested: reqCat, notFound: true });
        continue;
      }
      results.push(await enableOneCategory(userId, matched));
    }
    return { type: 'enable_category', results };
  }

  if (parsed.type === 'category_settings') {
    return await getCategorySettingsView(userId);
  }

  if (parsed.type === 'set_category_emoji') {
    const matched = matchCategoryName(allNames, parsed.category);
    if (!matched) return { type: 'set_category_emoji', notFound: true, requested: parsed.category };
    if (!parsed.emoji) return { type: 'set_category_emoji', missingEmoji: true, category: matched };
    const result = await setCategoryEmoji(userId, matched, parsed.emoji);
    if (result.builtin) return { type: 'set_category_emoji', builtin: true, category: matched };
    if (result.notFound) return { type: 'set_category_emoji', notFound: true, requested: parsed.category };
    if (result.invalidEmoji) return { type: 'set_category_emoji', invalidEmoji: true, category: matched };
    return { type: 'set_category_emoji', category: matched, emoji: parsed.emoji };
  }

  if (parsed.type === 'rename_category') {
    const matched = matchCategoryName(allNames, parsed.from);
    if (!matched) return { type: 'rename_category', notFound: true, requested: parsed.from };
    const result = await renameCategoryEverywhere(userId, matched, parsed.to);
    return { type: 'rename_category', ...result };
  }

  if (parsed.type === 'settings_menu') {
    return { type: 'settings_menu' };
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