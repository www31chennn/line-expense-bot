# AI 記帳 - 獨立新專案（使用免費的 Gemini API）

這是一個完全獨立的 Next.js 專案，跟 `my-planner-firebase` 沒有任何關聯，
用自己的 Firebase 專案、自己的 git repo。

> **關於免費額度**：Gemini API 免費層級（`gemini-2.5-flash`）不用信用卡，
> 額度是每分鐘約 10 次、每天約 250 次請求，個人記帳用量完全夠用。
> 但 Google 的免費層級條款允許將你送出的內容用於改善模型，
> 如果會記錄比較私人的備註內容，這點可以留意。

## 檔案說明

```
package.json              專案設定與套件依賴
next.config.js            Next.js 設定
pages/_app.js              App 進入點
pages/index.js             首頁（導到 /test）
lib/parseExpense.js       核心邏輯：文字 → AI 解析 → 寫入 Firebase（之後 LINE webhook 會呼叫同一個函式）
lib/firebaseAdmin.js      Firebase Admin 初始化
pages/api/test-parse.js   給網頁測試用的 API route
pages/test.js              陽春的測試網頁（一個輸入框，模擬聊天）
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

## 2. 建立新的 Firebase 專案

因為要跟 `my-planner-firebase` 完全分開，建議去 Firebase Console 開一個新專案
（例如 `line-expense-bot`），啟用 Firestore，然後：

專案設定 -> 服務帳戶 (Service accounts) -> 產生新的私密金鑰，下載 JSON。

## 3. 設定環境變數

複製 `.env.local.example` 成 `.env.local`，填入：

- **GEMINI_API_KEY**：去 aistudio.google.com/apikey，用 Google 帳號登入後直接建立，
  免費、不用信用卡。建立完直接複製貼上即可。
- **Firebase 三項**：Firebase Console -> 齒輪圖示「專案設定」-> 服務帳戶 (Service accounts)
  -> 產生新的私密金鑰，下載的 JSON 檔裡有 `project_id`、`client_email`、`private_key`
  三個欄位，分別對應貼進去。`private_key` 記得整段包含 `-----BEGIN...-----END-----`
  都要貼，並保留雙引號。

`.env.local` 不要進 git，記得確認 `.gitignore` 裡有這行（Next.js 專案通常預設就有）。

## 4. 本機啟動測試

```bash
npm run dev
```

開瀏覽器到 `http://localhost:3000/test`，輸入「今天午餐吃200元」，
應該會看到 AI 解析結果、並寫入 Firestore 的 `expenses/test-user/records/` 底下。

可以多測幾種說法確認 prompt 夠不夠：
- 「昨天晚餐80元」
- 「今天午餐200，晚餐跟朋友聚餐1500」（測試一次多筆）
- 「今天心情不錯」（測試沒有金額時不應該誤記）

## 5. 部署到 Vercel（跟你現有專案流程一樣）

```bash
vercel --prod
```

記得在 Vercel 專案設定 -> Environment Variables 裡，把 `.env.local` 的
三個變數也加進去（`FIREBASE_PRIVATE_KEY` 貼的時候一樣要包含換行）。

部署後一樣可以用 `https://你的網域/test` 測試，行為應該跟本機一致。

## 6. 串接 LINE

程式碼已經寫好：`pages/api/line-webhook.js`（webhook 進入點）、
`lib/lineFormat.js`（把 `handleMessage()` 的結果轉成 LINE 訊息格式）。
步驟如下：

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
- **自動回覆訊息（Auto-reply messages）** 設定為 **停用**（不然使用者傳訊息時
  LINE 會自己回一則罐頭訊息，跟我們的 webhook 打架）
- **加入好友的歡迎訊息（Greeting messages）** 也設定為 **停用**（我們用
  `follow` 事件自己送歡迎訊息，內容在 `lib/lineFormat.js` 的 `welcomeMessage()`）

### 6.3 部署到 Vercel，設定 Webhook URL

LINE 要求 Webhook URL 必須是**公開的 HTTPS 網址**，本機 `localhost` 沒辦法直接用
（要測本機的話可以用 `ngrok` 開一個臨時的公開網址，但正式使用建議直接部署）。

```bash
vercel --prod
```

部署完成後，把三個環境變數（`LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN`，
以及原本就有的 `GEMINI_API_KEY`、Firebase 三項）加進 Vercel 專案設定的
Environment Variables，然後回到 LINE Developers Console 的 Messaging API 分頁，
把 **Webhook URL** 填成：

```
https://你的網域/api/line-webhook
```

填完點 **Verify**，LINE 會送一個測試請求，如果顯示成功就代表簽章驗證跟連線都正常。

### 6.4 加好友測試

Messaging API 分頁最上面有個 QR code，掃描加好友，或直接搜尋 Bot ID。加好友後
應該會馬上收到 `welcomeMessage()` 那則使用說明。之後打字「今天午餐吃200元」測試
記帳，或是照使用說明裡提到的方式測查詢/編輯/刪除。

### 6.5 Rich Menu（常駐選單）

除了 **Quick Reply**（分類反問、選第幾筆這種跟著訊息出現又消失的一次性按鈕），
「常駐在輸入框上方的深藍色按鈕」是另一個功能 **Rich Menu**，已經做好了：

- `richmenu.png`：6 宮格選單圖片（2500x1686）
- `scripts/setup-rich-menu.js`：建立 Rich Menu、上傳圖片、設成該帳號的預設選單

6 個區塊對應的固定文字（跟 `handleMessage()` 判斷的意圖完全一樣）：

| 區塊 | 送出文字 |
|---|---|
| 明細 | `明細` |
| 預算 | `這個月還剩多少可以花` |
| 設定預算 | `設定預算` |
| 編輯 | `我要編輯` |
| 使用說明 | `使用說明` |
| 月報表 | `月報表` |

執行方式（在 `line-expense-bot` 資料夾內，`.env.local` 要先填好 `LINE_CHANNEL_ACCESS_TOKEN`）：

```bash
npm run setup-rich-menu
```

如果之後想換圖片或改按鈕配置，改 `richmenu.png` 跟 `scripts/setup-rich-menu.js` 裡的 `areas`，
重新執行一次指令即可（會建立一顆新的 Rich Menu 並重新設成預設選單）。