import { GoogleGenerativeAI } from '@google/generative-ai';
import { getFirestore } from './firebaseAdmin';
import {
  DEFAULT_CATEGORY_ALLOCATION,
  getCategoryConfig,
  allCategoryNames,
  activeCategoryNames,
  MAX_ACTIVE_CATEGORIES,
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

// 如果帳號是在新增「固定支出」這個分類之前就設定過比例，存在 Firestore 的舊資料會缺這個 key。
// 這裡統一補齊：缺的分類給 0%，不動使用者已經自訂過的其他分類數值，也不會偷偷幫使用者重新分配
export function normalizeAllocation(stored, categoryNames) {
  const source = stored || DEFAULT_CATEGORY_ALLOCATION;
  const normalized = {};
  categoryNames.forEach((cat) => {
    normalized[cat] = source[cat] ?? 0;
  });
  return normalized;
}

// 自訂分類沒有現成的權重可用，給一個跟內建分類裡最低權重（醫療/其他）同級的基準值，
// 純粹是「大概給個數字」不是精算——使用者自己會再去網頁調整
const CUSTOM_CATEGORY_BASE_WEIGHT = 5;

// 「自動分配」按鈕用：純粹依分類名稱給一個大致合理的比例，不讀花費紀錄、不呼叫AI，
// 每次同一組分類結果都一樣。內建分類直接套用 DEFAULT_CATEGORY_ALLOCATION 裡已經
// 精心分配好的權重（飲食25/居家20/固定支出15/交通10/購物10/娛樂10/醫療5/其他5），
// 自訂分類一律給基準值，全部加起來後按比例縮放湊到剛好100%（最後一個吸收捨入誤差）
export function suggestCategoryAllocation(activeNames) {
  const weights = activeNames.map((name) => ({
    name,
    weight: DEFAULT_CATEGORY_ALLOCATION[name] ?? CUSTOM_CATEGORY_BASE_WEIGHT,
  }));
  const totalWeight = weights.reduce((sum, w) => sum + w.weight, 0);
  if (totalWeight <= 0) {
    // 理論上不會發生（權重都是正數），防呆用：平均分配
    const evenPct = Math.round(100 / activeNames.length);
    return Object.fromEntries(activeNames.map((name) => [name, evenPct]));
  }

  const result = {};
  let runningSum = 0;
  weights.forEach((w, i) => {
    if (i === weights.length - 1) {
      // 最後一個吸收捨入誤差，保證總和精確100%（跟 setCategoryBudgets 同一套技巧）
      result[w.name] = 100 - runningSum;
    } else {
      const pct = Math.round((w.weight / totalWeight) * 100);
      result[w.name] = pct;
      runningSum += pct;
    }
  });
  return result;
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
- 只說想記帳但完全沒講品項和金額（例如「記帳」「我要記帳」「幫我記一筆」），輸出：{"type":"record_help"}

情況二：統計查詢（例如「今天花多少」「這個月花多少」「這禮拜飲食類花多少」），輸出：
{"type":"query","startDate":"YYYY-MM-DD","endDate":"YYYY-MM-DD","category":"分類或null","label":"期間描述，例如：今天、這週、這個月"}
- 「這個月」指當月 1 號到今天；「這週」「本週」指這週一到今天；「上個月」指上個月 1 號到最後一天；「今年」指今年 1 月 1 號到今天；「去年」指去年 1 月 1 號到 12 月 31 號

情況二之一：想「比較」這個月和上個月的花費（例如「這個月跟上個月比」「這個月花得比上個月多嗎」「比上個月省還是多花」），輸出：
{"type":"compare"}

情況三：列出清單（例如「列出所有飲食」「列出這個月醫療」「列出交通類」「列出今天所有記錄」「列出這週所有記錄」「列出上個月飲食」「列出今年交通」「列出去年娛樂」「列出不限日期的飲食」「本月明細」「最近一筆」「最近5筆」「列出最近10筆飲食」），輸出：
{"type":"list","category":"分類或null","startDate":"YYYY-MM-DD或null","endDate":"YYYY-MM-DD或null","count":數字或null}
- 「今天」startDate=endDate=今天；「這個月」「本月」指當月1號到今天；「這週」「本週」指這週一到今天；「上個月」指上個月1號到最後一天；「今年」指今年1月1號到今天；「去年」指去年1月1號到12月31號
- 「最近N筆」「最近一筆」「上一筆」這類只講筆數不講日期範圍：startDate/endDate 都是 null，count 填筆數（「最近一筆」「上一筆」fill count=1）；不要再問日期範圍
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

情況八：使用者明確想動手編輯或刪除「消費記錄」，但完全沒提到日期/品項/分類/編號（例如「我要編輯」「我想改一筆」「編輯記錄」「我要刪除一筆」「我想刪東西」），輸出：
{"type":"manage_unspecified"}
- 注意：如果只是「可以修改嗎」「能改嗎」這種疑問句、而且看不出要修改的是什麼（記錄？預算比例？分類？），不要用這個情況——用情況二十，reply 反問他想修改哪一種並各給一個範例指令

情況九：使用者只是單獨回覆一個編號來回答「要選哪一筆」（例如「1」「#1」「第一筆」「第二個」「2」，沒有其他記帳/查詢內容），輸出：
{"type":"select_index","index":數字}
- 中文數字（一二三四五）、阿拉伯數字、「#1」「第1筆」等格式都要能轉換成數字

情況十：設定薪水與存錢/花費目標（例如「薪水50000，目標存15000」「月薪45000，最多花70%」「我想每個月存1萬」），輸出：
{"type":"set_budget","salary":數字或null,"savingsGoal":數字或null,"spendingPercentage":數字或null}
- 只填使用者實際提到的欄位，沒提到的給 null

情況十一：查詢預算/目標狀態（例如「這個月還剩多少可以花」「有沒有超支」「存錢目標達成了嗎」「餘額還有多少」「目前預算比例是多少」「各分類比例」「預算狀態」「分類預算」），輸出：
{"type":"budget_status"}

情況十二：使用者想調整/修改分類比例，不管是講了一個分類、多個分類、還是完全沒講細節、或想用按鈕選（例如「修改飲食為30%」「交通改成15%」「飲食調成30%，交通10%」「調整分類比例」「用按鈕改比例」「調整飲食比例」），輸出：
{"type":"percent_help"}
- 這個功能現在統一導向網頁設定，不管使用者講得多具體都輸出這個，不要嘗試自己解析出分類或%數字

情況十四之一：使用者想用「金額」換算某個分類應該佔幾%（例如「飲食大約花4000要設定幾%」「固定支出15000幫我算比例」「交通每個月1500，換算成%」「薪水48000飲食8000比例是多少」），輸出：
{"type":"calc_category_pct","category":"分類","amount":數字,"salary":薪水數字或null}
- 只有明確說想換算/設定比例、同時有分類名稱和金額才用這個；單純記帳（「午餐200」）不要用這個
- 如果同一句話也提到了薪水金額，把薪水放進 salary 欄位；沒有薪水資訊就給 null

情況十四之二：使用者想一次設定/看到所有分類比例、不想每次調整互相蓋掉（例如「設定所有比例」「一次設定所有比例」「網頁設定比例」「不想比例被互相蓋掉，一次設定」「有沒有辦法同時鎖定好幾個分類的比例」），輸出：
{"type":"open_budget_liff"}

情況十五：使用者想知道怎麼設定預算，但沒有直接給數字（例如「設定預算」「怎麼設定薪水」「預算怎麼設定」），輸出：
{"type":"budget_help"}

情況十五之一：使用者想刪除/清除預算相關設定，依範圍分三種，輸出：
{"type":"delete_budget","target":"goal或salary或all"}
- 只想刪存款目標/花費%，薪水要保留（例如「刪除目標」「取消存款目標」「不設定目標了」「清除花費比例」），target 給 "goal"
- 只想刪薪水（例如「刪除薪水」「清除薪水設定」），target 給 "salary"
- 想整組都清掉（例如「刪除預算」「清除預算設定」「重設預算」「取消預算設定」），target 給 "all"

情況十五之二：使用者想設定/修改/管理分類比例的整體入口，但沒有直接講要改成多少（例如「修改比例」「分類比例設定」「我要調整比例的設定」「管理分類比例」），輸出：
{"type":"percent_help"}

情況十六：查看目前的分類比例配置（例如「目前比例」「查看分類比例」「現在的比例是多少」），輸出：
{"type":"view_category_allocation"}
- 如果使用者只講「比例」兩個字、沒有其他任何線索（沒有「目前」「查看」「調整」「修改」「設定」這類動詞），一律當作情況十二（percent_help），不要用這個——「比例」單獨出現時預設是想要進入比例的整體入口，不是純查看

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
- 只說想新增分類、還沒講名稱（例如「新增分類」「我要新增分類」「加一個分類」），輸出：{"type":"add_category","name":null,"emoji":null}

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
- 使用者想停用、啟用、改emoji、或改名分類，但「沒有講是哪一個分類」時（例如「停用分類」「我要停用一個分類」「修改分類emoji」「分類改名」），也輸出這個——分類設定卡上每個分類都可以點，讓使用者直接點選要操作哪一個
- 注意：只要句子裡有講出分類名稱（例如「修改飲食的emoji」「停用醫療」），一律用對應的情況十七之二/十七之三/十七之五/十七之六，不要用這個

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

情況二十：完全無法對應上面任何一種情況（跟記帳/查詢/預算/分類/編輯刪除都無關，或看不懂想做什麼），輸出：
{"type":"none","reply":"給使用者的回覆文字"}
- 只有真的無法對應前面任何情況時才用這個；模稜兩可但勉強能對應某個情況的輸入，還是要分到那個情況，不要丟到這裡
- reply 的寫法規則（依序判斷）：
  1. 猜得到使用者可能想用哪個功能的話，用一句話確認並附上可以直接照著輸入的指令，例如：「你是不是想查消費記錄？輸入『列出這個月飲食』就可以看明細」
  2. 使用者在問功能怎麼用、或某個數字/機制的「意義」的話，「只能」依下面的功能總覽說明，總覽沒涵蓋的請他輸入「使用說明」，嚴禁自行推測機制。另外你看不到這位使用者的任何記帳資料與設定，嚴禁提及或編造任何具體金額、筆數、百分比數字
     【功能與機制總覽】
     - 記帳：直接用自然語言講就會記（可一次多筆、可指定日期，例如「昨天晚餐80，計程車150」）；買了什麼的細節會自動放進備註，也可以事後補備註；記完可以按「撤銷」鈕刪掉剛存的
     - 查詢：「明細」看清單（可翻頁、可按鈕匯出CSV）；「這個月花多少」看統計；「這個月跟上個月比」看比較；「月報表」看消費分佈（可切換過去月份）；「這個月還剩多少可以花」看預算狀態
     - 修改/刪除記錄：「第N筆改成300」「刪除上一筆」「刪除昨天的晚餐」，或直接點清單上的列／🗑️；「我要編輯」會列出近20筆；清單編號15分鐘後過期，要重新查詢才能再用編號
     - 預算：「薪水50000，目標存15000」一句設定；每月可花上限 = 薪水 − 目標存款（或 薪水 × 花費%）；沒設薪水就沒有上限；「刪除預算」可清除
     - 分配比例：分類旁的%是「預算分配比例」（這個分類可以花上限的多少），月報表上的%才是實際花費佔比；比例不用設薪水就存在——一開始所有啟用分類均分，會因「調整比例」「新增分類」「停用分類」而變動；總和固定100%；改比例只能用網頁（輸入「修改比例」會出現入口，可以一次看到所有分類，調整到剛好100%才能存），聊天只能查看目前比例（「目前比例」），沒有單獨用聊天改一個分類比例的功能了；還沒設上限時比例照樣顯示，只是還沒有對應金額
     - 分類：內建8個＋可自訂，最多同時啟用12個；「新增分類」可加新的（名稱最長6個字、可附emoji），新分類/重新啟用的分類起始比例是0%，不會自動分配到預算，需要使用者自己去「修改比例」設定；停用不是刪除、隨時可再啟用，停用時它的比例會變成「未分配」狀態，不會自動分給其他分類；自訂分類可以改名/換emoji，內建分類的emoji是固定的
     - 使用者問「有沒有辦法／能不能」做上面沒提到的事：回答「這部分我不確定」並請他輸入「使用說明」，不要肯定說有、也不要肯定說沒有
  3. 只是打招呼或閒聊的話，簡短友善回應一句，再提示可以輸入「使用說明」看完整功能
- reply 全部控制在 3 句以內，語氣自然像真人客服，不要出現「偵測」「意圖」「指令格式」這種系統腔

判斷「上一筆」還是「特定一筆」的關鍵：只要句子裡有提到日期、品項名稱、分類、或「第X筆」，一律當作「特定一筆」（情況六/七），只有完全沒提到任何指向性資訊、單純講「剛剛」「上一筆」時才用情況四/五；如果連「剛剛」「上一筆」都沒講，只是單純說「我要編輯/刪除」，用情況八。單獨的編號回覆（無其他內容）一律用情況九。
補充：「剛剛」同時出現在記帳語境時（句子裡有品項和金額，例如「剛剛被酷澎刷了59元」「剛剛在超商買了飲料120元」），優先判斷為情況一（記帳），「剛剛」只是說明時間，不代表要修改。「剛剛那筆」「剛剛打錯了」才是修改上一筆的信號。

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
  // 精確比對優先：自訂分類名稱可能「包含」內建名稱（例如自訂了「飲食飲食」），
  // 若直接跑子字串比對，排在前面的內建「飲食」會先命中，導致對完全同名的自訂分類操作失敗。
  // 先整輪找完全相同的，找不到才退回子字串比對（保留「醫療類」→「醫療」這種寬鬆講法的支援）
  const exact = names.find((c) => trimmed === c);
  if (exact) return exact;
  return names.find((c) => trimmed.includes(c) || c.includes(trimmed)) || null;
}

// 新分類（新增或重新啟用）起始比例一律0%，不塞假數字，使用者自己決定要分配多少。
// 跟停用分類一樣直接寫入 categoryAllocation、不透過 setCategoryBudgets——那個函式的
// 「沒指定的分類自動吸收差額」邏輯會順便把既有的未分配比例也吃掉，這裡不要那個效果。
// 用 normalizeAllocation 把其他啟用中分類「現在實際生效的值」攤平寫出來，不然這個分類
// 一寫進去，其他還活在 DEFAULT_CATEGORY_ALLOCATION fallback 裡、從沒手動調過的內建
// 分類會被誤判成 0%
async function setNewCategoryToZero(userId, matched, activeNames) {
  const budget = await getBudget(userId);
  const currentAllocation = normalizeAllocation(budget && budget.categoryAllocation, activeNames);
  currentAllocation[matched] = 0;
  await userDoc(userId).set({ budget: { ...(budget || {}), categoryAllocation: currentAllocation } }, { merge: true });
}

// 直接把某個分類的比例設成指定值，不透過 setCategoryBudgets 的「沒指定的分類自動吸收
// 差額」邏輯——那個邏輯會把其他分類的數字、以及既有的「未分配」缺口都一起蓋掉，不是
// 使用者要的。這裡只改這一個分類，其他分類完全不動；不管套用後總和會不會超過100%都
// 直接寫入，只回報有沒有超過、超過多少，交給呼叫端決定要不要提醒使用者去調整
export async function applyCategoryPercentDirect(userId, matched, pct) {
  const cfg = await getCategoryConfig(userId);
  const active = activeCategoryNames(cfg);
  if (!active.includes(matched)) {
    return { ok: false, invalid: true };
  }
  const budget = await getBudget(userId);
  const currentAllocation = normalizeAllocation(budget && budget.categoryAllocation, active);
  const otherSum = active
    .filter((name) => name !== matched)
    .reduce((sum, name) => sum + (currentAllocation[name] || 0), 0);
  const resultingTotal = otherSum + pct;
  currentAllocation[matched] = pct;
  await userDoc(userId).set({ budget: { ...(budget || {}), categoryAllocation: currentAllocation } }, { merge: true });
  return { ok: true, resultingTotal, otherSum, overLimit: resultingTotal > 100 };
}

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

  // 直接寫入，不透過 setCategoryBudgets——那個函式的邏輯是「沒指定的分類自動吸收差額」，
  // 會把這筆比例悄悄分給其他分類；這裡要的是單純把它從清單拿掉，其他分類的數字完全不動
  if (reclaimedPct > 0) {
    const newAllocation = { ...currentAllocation };
    delete newAllocation[matched];
    await userDoc(userId).set({ budget: { ...(budget || {}), categoryAllocation: newAllocation } }, { merge: true });
  }
  await setCategoryEnabled(userId, matched, false);
  return { category: matched, ok: true, reclaimedPct };
}

// 啟用單一分類
async function enableOneCategory(userId, matched) {
  const result = await setCategoryEnabled(userId, matched, true);
  if (result.alreadyEnabled) return { category: matched, alreadyEnabled: true };
  const activeAfter = result.defs.filter((d) => d.enabled).map((d) => d.name);
  await setNewCategoryToZero(userId, matched, activeAfter);
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

// 新增分類的共同收尾：AI 直接解析出名稱的路徑、與引導狀態輸入名稱的路徑都走這裡，
// 驗證與起始比例的邏輯只維護一份
async function completeAddCategory(userId, name, emoji) {
  const result = await addCategory(userId, name, emoji);
  if (result.invalid) return { type: 'add_category', invalid: true };
  if (result.tooLong) return { type: 'add_category', tooLong: true, maxLength: result.maxLength };
  if (result.invalidEmoji) return { type: 'add_category', invalidEmoji: true };
  if (result.duplicate) return { type: 'add_category', duplicate: true, name };
  if (result.tooMany) return { type: 'add_category', tooMany: true, max: result.max };
  const activeAfter = result.defs.filter((d) => d.enabled).map((d) => d.name);
  await setNewCategoryToZero(userId, result.added, activeAfter);
  return { type: 'add_category', added: result.added, defs: result.defs };
}

// 使用者只說「新增分類」還沒給名稱（打字或按設定卡上的按鈕都會走到這裡）：
// 進入「等待輸入名稱」的引導狀態，下一句直接當作名稱處理，不用重打「新增分類」前綴。
// 已達啟用上限就直接講，不讓使用者輸入完名稱才被打槍
export async function startAddCategory(userId) {
  const cfg = await getCategoryConfig(userId);
  if (activeCategoryNames(cfg).length >= MAX_ACTIVE_CATEGORIES) {
    return { type: 'add_category', tooMany: true, max: MAX_ACTIVE_CATEGORIES };
  }
  await savePendingAction(userId, { action: 'awaiting_new_category_name' });
  return { type: 'awaiting_new_category_name' };
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

// 撤銷剛剛的記帳：記帳成功卡上的「撤銷」鈕帶著剛存的記錄id進來，直接刪掉。
// 只刪還存在的（可能已被其他操作刪過），並同步從最近查看清單移除
export async function undoRecords(userId, ids) {
  let deleted = 0;
  for (const id of ids || []) {
    const ref = recordsCollection(userId).doc(id);
    const doc = await ref.get();
    if (doc.exists) {
      await ref.delete();
      await removeFromLastList(userId, id);
      deleted++;
    }
  }
  return { type: 'undo_records', deleted };
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

export async function getPendingAction(userId) {
  const doc = await userDoc(userId).get();
  if (!doc.exists) return null;
  return doc.data().pendingAction || null;
}

export async function savePendingAction(userId, pendingAction) {
  await userDoc(userId).set({ pendingAction }, { merge: true });
}

export async function clearPendingAction(userId) {
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
    // 「第N筆」的編號來自最近列出的清單：清單過期（超過TTL）就當找不到，
    // 請使用者重新查詢，避免隔天憑記憶下指令改到舊清單的第N筆
    const lastList = await getLastList(userId, { checkFreshness: true });
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
  const categoryAllocation = existing.categoryAllocation || null;

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
    categoryAllocation,
  };
  await userDoc(userId).set({ budget }, { merge: true });
  return budget;
}

export async function getBudget(userId) {
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
export async function setCategoryBudgets(userId, adjustments) {
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
    if (trimmed === '取消' || trimmed.toLowerCase() === 'cancel') {
      await clearPendingAction(userId);
      return { type: 'manage_cancelled' };
    }
    const result = await setCategoryEmoji(userId, pendingBefore.category, trimmed);
    if (result.invalidEmoji) {
      // 驗證失敗不清掉狀態，讓使用者可以直接重新輸入，不用重新點一次選單
      return { type: 'set_category_emoji', invalidEmoji: true, category: pendingBefore.category };
    }
    await clearPendingAction(userId);
    if (result.builtin) return { type: 'set_category_emoji', builtin: true, category: pendingBefore.category };
    if (result.notFound) return { type: 'set_category_emoji', notFound: true, requested: pendingBefore.category };
    return { type: 'set_category_emoji', category: pendingBefore.category, emoji: trimmed };
  }

  // 使用者剛點了「修改名稱」，這句話就是新的名稱
  if (pendingBefore && pendingBefore.action === 'awaiting_category_rename') {
    const trimmed = message.trim();
    if (trimmed === '取消' || trimmed.toLowerCase() === 'cancel') {
      await clearPendingAction(userId);
      return { type: 'manage_cancelled' };
    }
    const result = await renameCategoryEverywhere(userId, pendingBefore.category, trimmed);
    if (result.invalid || result.tooLong || result.duplicate) {
      // 驗證失敗不清掉狀態，讓使用者可以直接重新輸入，不用重新點一次選單
      return { type: 'rename_category', ...result };
    }
    await clearPendingAction(userId);
    return { type: 'rename_category', ...result };
  }

  // 使用者剛說要新增分類（還沒給名稱），這句話就是分類名稱（可能結尾附一個 emoji）
  if (pendingBefore && pendingBefore.action === 'awaiting_new_category_name') {
    const trimmed = message.trim();
    if (trimmed === '取消' || trimmed.toLowerCase() === 'cancel') {
      await clearPendingAction(userId);
      return { type: 'manage_cancelled' };
    }

    // 看起來像記帳內容（含連續兩位以上數字，例如「午餐200」）就先擋下來確認，
    // 避免使用者在引導狀態下想記帳、結果被建立成一個叫「午餐200」的分類。
    // 正常分類名稱不會有多位數字（「3C」這種單位數字不受影響）
    if (/\d{2,}/.test(trimmed)) {
      return { type: 'awaiting_new_category_name', looksLikeExpense: true, input: trimmed };
    }

    // 把結尾的 emoji 字素剝出來當 emoji 參數：「寵物 🐾」「寵物🐾」都要能拆。
    // 用字素叢集切（跟 categories.js 的 emoji 驗證同一套邏輯），複合emoji（🏃‍♂️等）才會被當成一個
    const segs = Array.from(
      new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(trimmed)
    ).map((s) => s.segment);
    let name = trimmed;
    let emoji = null;
    if (segs.length > 1 && /\p{Extended_Pictographic}/u.test(segs[segs.length - 1])) {
      emoji = segs[segs.length - 1];
      name = segs.slice(0, -1).join('').trim();
    }

    const result = await completeAddCategory(userId, name, emoji);
    if (result.invalid || result.tooLong || result.duplicate || result.invalidEmoji) {
      // 驗證失敗不清掉狀態，讓使用者可以直接重新輸入，不用重新觸發一次流程
      return { ...result, retry: true };
    }
    await clearPendingAction(userId);
    return result;
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

  // 兜底：單獨送出「取消」但沒有對應到任何pendingAction的狀態（例如分類管理選單本身是無狀態的，
  // 每顆按鈕各自獨立），這種情況不要丟給AI判斷——AI找不到「取消」對應的意圖，只會回「沒有偵測到...」，
  // 對使用者來說等於按了取消卻沒反應。直接當作「沒事，已取消」處理
  if (message.trim() === '取消' || message.trim().toLowerCase() === 'cancel') {
    return { type: 'manage_cancelled' };
  }

  // Rich Menu 與高頻固定字句直接短路，不送 AI：這六句是最常被按的入口，
  // 省一次 Gemini 呼叫（免費層每日額度）與 1~2 秒延遲；字句必須完全相同才短路，
  // 任何多字少字都照常走 AI 分類，不影響自然語言的彈性
  const FIXED_COMMANDS = {
    明細: { type: 'list_menu' },
    設定: { type: 'settings_menu' },
    使用說明: { type: 'help' },
    月報表: { type: 'monthly_report', month: null },
    我要編輯: { type: 'manage_unspecified' },
    這個月還剩多少可以花: { type: 'budget_status' },
  };
  const parsed = FIXED_COMMANDS[message.trim()] || (await classifyMessage(message, timestamp, activeNames, allNames));

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

    // AI 被告知只能從啟用中的分類選，但偶爾會沒照指示走（可能是分類剛好在這次對話中被停用，
    // 或單純模型沒跟上），如果回傳的分類已經不在啟用清單裡，不能直接存進去——
    // 當作跟「categoryConfidence低」一樣的情況處理，讓使用者從實際啟用中的分類重新選
    const confident = validAll.filter((e) => e.categoryConfidence !== 'low' && activeNames.includes(e.category));
    const uncertain = validAll.filter((e) => e.categoryConfidence === 'low' || !activeNames.includes(e.category));

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
    const count = parsed.count ? parseInt(parsed.count, 10) : null;

    // 「最近N筆」「最近一筆」：只有筆數、沒有日期範圍，直接查不問範圍
    if (count && count > 0 && !startDate && !endDate) {
      const limit = Math.min(count, 50);
      const records = await listRecentRecords(userId, limit);
      const recentCfg = await getCategoryConfig(userId);
      const defs = buildCategoryDefs(recentCfg);
      const mapped = records.map((r) => ({
        ...r,
        emoji: (defs.find((d) => d.name === r.category) || {}).emoji || '',
      }));
      return { type: 'list', records: mapped, count: records.length, total: mapped.reduce((s, r) => s + r.amount, 0), category, recentN: limit, truncated: records.length >= limit && count > limit };
    }
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

  // 「調整比例」相關的三種聊天式編輯（自由文字改一個或多個、按鈕選單、選好分類等輸入%）已經停用，
  // 統一導向 percent_help 引導使用者用 LIFF 網頁——那裡才能一次看到所有分類、不會有「改一個、
  // 其他自動浮動」的疑惑。這裡同時攔 AI 可能還是照舊輸出的三種舊 type（prompt 剛改，安全網防止
  // 模型偶爾沒跟上新指示時掉進没人接的死路）
  if (
    parsed.type === 'set_category_budget' ||
    parsed.type === 'adjust_category_menu' ||
    parsed.type === 'adjust_category_percent_step'
  ) {
    const catStatus = await getCategoryBudgetStatus(userId);
    return {
      type: 'percent_help',
      allocation: catStatus.allocation,
      monthlyLimit: catStatus.monthlyLimit,
      categories: activeDefs,
    };
  }

  if (parsed.type === 'calc_category_pct') {
    let budget = await getBudget(userId);
    // 沒設薪水但這句話同時包含薪水資訊（例如「薪水48000飲食8000比例是多少」）：
    // 先把薪水存起來，再繼續換算比例，不用使用者分兩次說
    if ((!budget || !budget.monthlyLimit) && parsed.salary) {
      budget = await setBudget(userId, { salary: parsed.salary });
    }
    // 即使已有 budget，若這次帶了不同薪水也要更新，並重新讀取 monthlyLimit
    if (parsed.salary && budget && budget.salary !== parsed.salary) {
      budget = await setBudget(userId, { salary: parsed.salary });
    }
    if (!budget || !budget.monthlyLimit) {
      return { type: 'calc_category_pct', noLimit: true };
    }
    const matched = matchCategoryName(allNames, parsed.category);
    if (!matched) {
      return { type: 'calc_category_pct', notFound: true, requested: parsed.category };
    }
    const raw = (parsed.amount / budget.monthlyLimit) * 100;
    const pct = Math.round(raw);
    if (pct <= 0) {
      return { type: 'calc_category_pct', tooSmall: true, category: matched, amount: parsed.amount, monthlyLimit: budget.monthlyLimit };
    }
    return {
      type: 'calc_category_pct',
      category: matched,
      amount: parsed.amount,
      monthlyLimit: budget.monthlyLimit,
      raw: Math.round(raw * 100) / 100,
      pct,
      salarySaved: parsed.salary || null,
      pending: true, // 尚未寫入，等使用者確認
    };
  }

  if (parsed.type === 'open_budget_liff') {
    return { type: 'open_budget_liff' };
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

  if (parsed.type === 'percent_help') {
    const catStatus = await getCategoryBudgetStatus(userId);
    return {
      type: 'percent_help',
      allocation: catStatus.allocation,
      monthlyLimit: catStatus.monthlyLimit,
      categories: activeDefs,
    };
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

  if (parsed.type === 'compare') {
    // 固定比較「這個月 vs 上個月」：兩個月份的統計並行查詢
    const { dateStr } = getTodayInfo(timestamp);
    const thisMonth = dateStr.slice(0, 7);
    const [ty, tm] = thisMonth.split('-').map(Number);
    const lastMonth = tm === 1 ? `${ty - 1}-12` : `${ty}-${String(tm - 1).padStart(2, '0')}`;
    const [cur, prev] = await Promise.all([
      getMonthlyCategoryBreakdown(userId, thisMonth),
      getMonthlyCategoryBreakdown(userId, lastMonth),
    ]);
    // 各分類的差額（本月 − 上月），取變化最大的前3個給回覆用
    const catNames = new Set([...cur.categories.map((c) => c.category), ...prev.categories.map((c) => c.category)]);
    const catDiffs = [...catNames]
      .map((name) => {
        const a = cur.categories.find((c) => c.category === name);
        const b = prev.categories.find((c) => c.category === name);
        return { category: name, emoji: (a && a.emoji) || (b && b.emoji) || '', diff: ((a && a.amount) || 0) - ((b && b.amount) || 0) };
      })
      .filter((d) => d.diff !== 0)
      .sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff))
      .slice(0, 3);
    return {
      type: 'compare',
      thisMonth: { month: thisMonth, total: cur.total },
      lastMonth: { month: lastMonth, total: prev.total },
      diff: cur.total - prev.total,
      catDiffs,
    };
  }

  if (parsed.type === 'monthly_report') {
    const { dateStr } = getTodayInfo(timestamp);
    const month = parsed.month || dateStr.slice(0, 7);
    const report = await getMonthlyCategoryBreakdown(userId, month);
    const recentMonths = computeMonthNavOptions(dateStr.slice(0, 7), month);
    return { type: 'monthly_report', ...report, recentMonths };
  }

  if (parsed.type === 'add_category') {
    // AI 判斷出「想新增分類但還沒給名稱」→ 進入引導狀態，下一句直接當名稱
    if (!parsed.name || !String(parsed.name).trim()) {
      return await startAddCategory(userId);
    }
    return await completeAddCategory(userId, parsed.name, parsed.emoji);
  }

  if (parsed.type === 'record_help') {
    return { type: 'record_help' };
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
    // 有講分類但沒附 emoji：進入跟設定卡按鈕相同的引導狀態（下一句直接當新 emoji），
    // 而不是回一句要使用者重打整句的靜態提示——兩條路徑統一同一種體驗
    if (!parsed.emoji) return await startCategoryEmojiEdit(userId, matched);
    const result = await setCategoryEmoji(userId, matched, parsed.emoji);
    if (result.builtin) return { type: 'set_category_emoji', builtin: true, category: matched };
    if (result.notFound) return { type: 'set_category_emoji', notFound: true, requested: parsed.category };
    if (result.invalidEmoji) return { type: 'set_category_emoji', invalidEmoji: true, category: matched };
    return { type: 'set_category_emoji', category: matched, emoji: parsed.emoji };
  }

  if (parsed.type === 'rename_category') {
    const matched = matchCategoryName(allNames, parsed.from);
    if (!matched) return { type: 'rename_category', notFound: true, requested: parsed.from };
    // 有講要改哪個分類但沒給新名稱（「飲食飲食改名」）：同樣進引導狀態，下一句直接當新名稱
    if (!parsed.to || !String(parsed.to).trim()) return await startCategoryRename(userId, matched);
    const result = await renameCategoryEverywhere(userId, matched, parsed.to);
    return { type: 'rename_category', ...result };
  }

  if (parsed.type === 'settings_menu') {
    return { type: 'settings_menu' };
  }

  if (parsed.type === 'none') {
    // AI 針對無法分類的輸入產生的回覆（見 buildPrompt 情況二十）。
    // 防呆：欄位缺失、空字串、或長到不像正常回覆（可能是模型失控）就丟棄，
    // 讓 lineFormat 退回原本的罐頭句，確保這條路永遠有東西可回
    const reply =
      typeof parsed.reply === 'string' && parsed.reply.trim() && parsed.reply.trim().length <= 300
        ? parsed.reply.trim()
        : null;
    return { type: 'none', reply };
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