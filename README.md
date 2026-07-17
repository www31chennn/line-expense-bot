# AI 記帳 LINE Bot

Next.js 專案，透過 LINE Messaging API 提供記帳、查詢、預算追蹤功能，使用 Gemini API
做自然語言解析，資料儲存在 Firebase Firestore。

> **關於免費額度**：Gemini API 免費層級（`gemini-2.5-flash`）不需要信用卡，
> 額度是每分鐘約 10 次、每天約 250 次請求，個人記帳用量足夠。
> 但 Google 的免費層級條款允許將送出的內容用於改善模型，
> 如果會記錄較私人的備註內容，這點請留意。

## 檔案說明

```
package.json              專案設定與套件依賴
next.config.js            Next.js 設定
pages/_app.js              App 進入點
pages/index.js             首頁（導到 /test）
lib/parseExpense.js       核心邏輯：文字 → AI 解析 → 寫入 Firebase（LINE webhook 也呼叫同一個函式）
lib/categories.js         分類定義（內建8個 + 使用者自訂）、啟用/停用邏輯，供 parseExpense.js/export.js 共用
lib/firebaseAdmin.js      Firebase Admin 初始化
pages/api/test-parse.js   給網頁測試用的 API route
pages/test.js              測試網頁（一個輸入框，模擬聊天）
.env.local.example        環境變數範例
.gitignore
```

## 1. 安裝套件

把整個 `line-expense-bot` 資料夾放到你想要的位置，進去之後：

```bash
cd line-expense-bot
npm install
```

（`package.json` 裡已經列好 `@google/generative-ai`、`firebase-admin`、`next`、`react`，
`npm install` 會一次裝好，不用額外再裝。）

## 2. 建立 Firebase 專案

去 Firebase Console 建立一個新專案（例如 `line-expense-bot`），啟用 Firestore，然後：

專案設定 -> 服務帳戶 (Service accounts) -> 產生新的私密金鑰，下載 JSON。

## 3. 設定環境變數

複製 `.env.local.example` 成 `.env.local`，填入：

- **GEMINI_API_KEY**：去 aistudio.google.com/apikey，用 Google 帳號登入後直接建立，
  免費、不需要信用卡。建立完直接複製貼上即可。
- **Firebase 三項**：Firebase Console -> 齒輪圖示「專案設定」-> 服務帳戶 (Service accounts)
  -> 產生新的私密金鑰，下載的 JSON 檔裡有 `project_id`、`client_email`、`private_key`
  三個欄位，分別對應貼進去。`private_key` 記得整段包含 `-----BEGIN...-----END-----`
  都要貼，並保留雙引號。

`.env.local` 不要進 git，請確認 `.gitignore` 裡有這行（Next.js 專案通常預設就有）。

## 4. 本機啟動測試

```bash
npm run dev
```

開瀏覽器到 `http://localhost:3000/test`，輸入「今天午餐吃200元」，
應該會看到 AI 解析結果，並寫入 Firestore 的 `expenses/test-user/records/` 底下。

可以多測幾種說法確認 prompt 是否涵蓋：
- 「昨天晚餐80元」
- 「今天午餐200，晚餐跟朋友聚餐1500」（測試一次多筆）
- 「今天心情不錯」（測試沒有金額時不應該誤記）

## 5. 部署到 Vercel

1. 把程式碼推送到一個 GitHub repository
2. 到 [vercel.com](https://vercel.com) 建立新專案，選擇 **Import Git Repository**，選剛剛的 repo
3. Framework Preset 會自動偵測成 Next.js，不需要更動
4. 在專案設定的 **Environment Variables** 區塊，把 `.env.local` 裡的所有變數
   （`GEMINI_API_KEY`、Firebase 三項）加進去；`FIREBASE_PRIVATE_KEY` 貼的時候要包含完整的換行
5. 點 **Deploy**

部署完成後可以用 `https://你的網域/test` 測試，行為應該跟本機一致。

之後每次 push 到 GitHub 的預設分支，Vercel 會自動重新部署。

## 6. 串接 LINE

`pages/api/line-webhook.js` 是 webhook 進入點，`lib/lineFormat.js` 負責把
`handleMessage()` 的結果轉成 LINE 訊息格式。步驟如下：

### 6.1 建立 LINE 官方帳號 + Messaging API Channel

1. 去 [LINE Developers Console](https://developers.line.biz/console/)，登入
2. 建立一個 Provider（如果還沒有的話）
3. 在該 Provider 底下建立一個 **Messaging API Channel**
4. 進到該 Channel 的 **Basic settings**，複製 **Channel secret**
5. 進到 **Messaging API** 分頁，往下找 **Channel access token**，點「Issue」產生一組
   長效 token，複製起來

把這兩個值填進 `.env.local`：`LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN`

### 6.2 關掉 LINE 內建的自動回覆，改用 Webhook

在 **Messaging API** 分頁：
- **Webhook** 設定為 **啟用（Use webhook）**
- **自動回覆訊息（Auto-reply messages）** 設定為 **停用**（否則使用者傳訊息時
  LINE 會自動回一則罐頭訊息，跟 webhook 衝突）
- **加入好友的歡迎訊息（Greeting messages）** 也設定為 **停用**（改用
  `follow` 事件送出歡迎訊息，內容在 `lib/lineFormat.js` 的 `welcomeMessage()`）

### 6.3 設定 Webhook URL

LINE 要求 Webhook URL 必須是**公開的 HTTPS 網址**，本機 `localhost` 無法直接使用
（本機測試可以用 `ngrok` 建立臨時的公開網址；正式使用請先完成第 5 節的部署）。

完成部署後，把 `LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN` 加進 Vercel
專案設定的 Environment Variables（跟 `GEMINI_API_KEY`、Firebase 三項放在一起），
然後回到 LINE Developers Console 的 Messaging API 分頁，把 **Webhook URL** 填成：

```
https://你的網域/api/line-webhook
```

填完點 **Verify**，LINE 會送一個測試請求，顯示成功即代表簽章驗證與連線正常。

### 6.4 加好友測試

Messaging API 分頁最上面有個 QR code，掃描加好友，或直接搜尋 Bot ID。加好友後
會收到 `welcomeMessage()` 那則使用說明。之後輸入「今天午餐吃200元」測試
記帳，或依照使用說明測試查詢/編輯/刪除。

### 6.5 Rich Menu（常駐選單）

除了 **Quick Reply**（分類反問、選第幾筆這類跟著訊息出現又消失的一次性按鈕），
「常駐在輸入框上方的按鈕」是另一個功能 **Rich Menu**，專案內已包含所需檔案：

- `richmenu.png`：6 宮格選單圖片（2500x1686）
- `scripts/setup-rich-menu.js`：建立 Rich Menu、上傳圖片、設成該帳號的預設選單

6 個區塊對應的固定文字（跟 `handleMessage()` 判斷的意圖一致）：

| 區塊 | 送出文字 |
|---|---|
| 明細 | `明細` |
| 預算 | `這個月還剩多少可以花` |
| 設定 | `設定`（會列出「設定預算」「設定分類」讓使用者選） |
| 編輯 | `我要編輯` |
| 使用說明 | `使用說明` |
| 月報表 | `月報表` |

執行方式（在 `line-expense-bot` 資料夾內，`.env.local` 要先填好 `LINE_CHANNEL_ACCESS_TOKEN`）：

```bash
npm run setup-rich-menu
```

如果之後想更換圖片或調整按鈕配置，修改 `richmenu.png` 跟 `scripts/setup-rich-menu.js`
裡的 `areas`，重新執行一次指令即可（會建立一顆新的 Rich Menu 並重新設成預設選單）。

## 7. 分類管理（新增/停用/改名自訂分類）

內建 8 個分類（飲食、交通、購物、娛樂、醫療、居家、固定支出、其他）都可以個別停用；
也可以自行新增分類。每個 LINE 使用者（`userId`）的分類設定各自獨立，存在
Firestore 該使用者文件底下的 `categoryConfig` 欄位。

**輸入「分類設定」會分兩張卡片列出所有分類**，點列可以直接開啟管理選單
（修改 emoji、修改名稱、啟用/停用），也可以直接下文字指令：

- **🟢 啟用中的分類**：結構上保證最多 12 個（見下方限制），一定塞得進一張卡片，不需要分頁
- **⚪ 已停用的分類**：停用不是刪除，只增不減、沒有上限，每頁顯示 5 個，超過時卡片下方會出現「看更多」，
  分頁邏輯跟「明細」清單同一套

| 指令範例 | 效果 |
|---|---|
| 「分類設定」「目前有哪些分類」 | 列出所有分類的啟用/停用狀態，點列可開啟管理選單 |
| 「新增分類 寵物」「新增分類 寵物 🐾」 | 新增一個自訂分類（可選填 emoji，沒填會自動配一個） |
| 「停用醫療」「停用其他跟娛樂」 | 停用一個或多個分類：記帳、預算比例都不會再出現它，但歷史記錄仍查得到 |
| 「啟用醫療」 | 恢復先前停用的分類（比例會是 0%，需重新分配） |
| 「運動的emoji改成🏃」 | 修改自訂分類的 emoji（內建分類的 emoji 固定，不支援修改） |
| 「運動改名叫健身」 | 修改自訂分類的名稱，既有記錄跟預算比例會一併更新（內建分類名稱固定） |

幾個實作上的限制：
- 啟用中的分類（內建+自訂加總）最多 12 個，因為 LINE Quick Reply 一則訊息最多 13 顆按鈕，扣掉「取消」剩 12
- 自訂分類名稱最多 6 個字（要跟 emoji、後綴文字一起塞進 20 字的按鈕 label）
- 至少要保留一個啟用中的分類，不能全部停用
- 不開放手動把分類設成 0%（會被導向改用「停用」），避免出現一堆 0% 但還啟用中、佔位置卻沒用的分類
- 停用分類時，它原本的預算比例會自動收回、依比例分給其他啟用中的分類
- 新增或重新啟用分類時，會自動給 5% 的起始比例（從其他啟用中分類收回），
  因為 0% 的分類在長條圖上幾乎看不到線，也沒有實際的起始比例可以調整

「編輯」指令是用來編輯/刪除**記帳記錄**（例如「編輯運動類」會被理解成「編輯」，
因為系統找不到特定記錄的日期/品項/編號，所以會列出最近的記錄讓你選，並不是編輯分類本身）；
分類的新增、停用、啟用、改名、emoji 修改一律使用上表的專用指令，或是「分類設定」點列開啟的管理選單。

分類比例的加總一律精準等於 100%：`setCategoryBudgets`（不管是手動調整、新增、停用、啟用觸發的）
每次都會讓最後一個分類吸收剩下的差額，不是四捨五入湊出來的，所以不需要另外提供「校正到100%」的功能。