// 引入必要的模組
const express = require('express'); // 用於建立 Express 應用程式
const dotenv = require('dotenv');   // 用於讀取 .env 設定檔
const axios = require('axios');     // 用於發送 HTTP 請求（呼叫 CoinGecko API）
const fs = require('fs');           // 用於檔案讀取與寫入
const path = require('path');       // 處理檔案路徑
const line = require('@line/bot-sdk'); // LINE Messaging API SDK

// 載入環境變數
dotenv.config();

// 設定 LINE Bot 的存取金鑰與密鑰（需從 .env 讀取）
const config = {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET,
};

// 初始化 LINE Bot 客戶端
const client = new line.Client(config);

// 建立 Express 應用
const app = express();

// 啟用 LINE webhook middleware 以解析來自 LINE 的請求
app.use(line.middleware(config));
// 啟用 JSON 解析（處理其他非 LINE 請求）
app.use(express.json());

// 定義儲存用戶資料的 JSON 檔案位置
const DATA_FILE = path.join(__dirname, 'userData.json');

// 讀取本地儲存的用戶資料（若檔案不存在則回傳空物件）
function loadUserData() {
    if (!fs.existsSync(DATA_FILE)) return {};
    return JSON.parse(fs.readFileSync(DATA_FILE));
}

// 將用戶資料寫入本地 JSON 檔案（做簡單的資料持久化）
function saveUserData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// 幣種代碼對應 CoinGecko API 所需的 ID
function cryptoSymbolToId(symbol) {
    const map = { btc: 'bitcoin', eth: 'ethereum', usdt: 'tether' };
    return map[symbol.toLowerCase()] || null;
}

// 呼叫 CoinGecko API 取得指定幣種的即時價格（對 USD）
async function getCryptoPrices(symbols = []) {
    const ids = symbols.join('%2C'); // 以逗號連接多個幣種 ID
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`;
    try {
        const response = await axios.get(url);
        return response.data;
    } catch (error) {
        // 若 API 回應 429，代表過度呼叫，需限制
        if (error.response?.status === 429) {
            console.warn('⚠️ 已達到 CoinGecko API 呼叫限制，請稍後再試');
            return { error: 'RATE_LIMIT' };
        }
        // 其他錯誤顯示錯誤訊息
        console.error('❌ 幣價查詢失敗：', error.message);
        return { error: 'API_ERROR' };
    }
}

// 接收來自 LINE 的 webhook 請求
app.post('/webhook', async (req, res) => {
    const events = req.body.events;          // LINE 傳來的事件陣列
    const userData = loadUserData();         // 載入用戶資料

    for (const event of events) {
        try {
            // 僅處理文字訊息事件，忽略貼圖、圖片等
            if (event.type !== 'message' || event.message.type !== 'text') continue;

            const userId = event.source.userId;     // 使用者 ID（作為儲存 key）
            const msg = event.message.text.trim();  // 使用者輸入文字
            const [cmd, symbol, amount] = msg.split(' '); // 拆解指令參數
            userData[userId] = userData[userId] || { goal: 0, assets: {} }; // 若該用戶為首次使用，初始化其資料

            // 處理 /add 指令：記錄幣種與數量
            if (cmd === '/add') {
                // 檢查輸入格式是否正確
                if (!symbol || isNaN(parseFloat(amount))) {
                    await client.replyMessage(event.replyToken, {
                        type: 'text',
                        text: `⚠️ 格式錯誤，請使用：/add 幣種 數量\n例如：/add btc 0.5`,
                    });
                    continue;
                }

                // 儲存使用者輸入的幣種與數量
                userData[userId].assets[symbol.toLowerCase()] = parseFloat(amount);
                saveUserData(userData);

                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: `✅ 已新增 ${symbol.toUpperCase()} 數量：${amount}`,
                });

                // 處理 /setgoal 指令：設定財富目標金額
            } else if (cmd === '/setgoal') {
                if (isNaN(parseInt(symbol))) {
                    await client.replyMessage(event.replyToken, {
                        type: 'text',
                        text: `⚠️ 格式錯誤，請使用：/setgoal 金額\n例如：/setgoal 1000000`,
                    });
                    continue;
                }

                userData[userId].goal = parseInt(symbol);
                saveUserData(userData);

                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: `🎯 已設定財富目標為：${symbol} 元`,
                });

                // 處理 /status 指令：顯示目前資產狀況與目標達成率
            } else if (cmd === '/status') {
                const assets = userData[userId].assets;

                // 沒有任何資產記錄
                if (!assets || Object.keys(assets).length === 0) {
                    await client.replyMessage(event.replyToken, {
                        type: 'text',
                        text: `📭 尚未新增任何幣種資產，請使用 /add 開始記錄！`,
                    });
                    continue;
                }

                // 取得所有已記錄幣種，轉換成 CoinGecko 所需 ID
                const symbols = Object.keys(assets);
                const ids = symbols.map(cryptoSymbolToId).filter(Boolean);

                // 若有無法識別的幣種，回傳錯誤
                if (ids.length === 0) {
                    await client.replyMessage(event.replyToken, {
                        type: 'text',
                        text: `⚠️ 無法解析幣種，請使用正確代碼（如 btc、eth）`,
                    });
                    continue;
                }

                // 查詢目前幣價
                const prices = await getCryptoPrices(ids);

                // 若 CoinGecko 返回限流錯誤
                if (prices.error === 'RATE_LIMIT') {
                    await client.replyMessage(event.replyToken, {
                        type: 'text',
                        text: `⚠️ 查詢太頻繁，請稍後再試（CoinGecko 限制）`,
                    });
                    continue;
                }

                // 計算總資產（USD）
                let totalUSD = 0;
                let detail = '';

                for (const s of symbols) {
                    const id = cryptoSymbolToId(s);
                    if (!prices[id]) continue; // 若該幣種查不到價格則略過
                    const price = prices[id].usd;
                    const value = price * assets[s];
                    totalUSD += value;
                    detail += `${s.toUpperCase()}：${assets[s]} 顆 x $${price} = $${value.toFixed(2)}\n`;
                }

                // 將 USD 轉換為 TWD（此處寫死匯率為 32）
                const totalTWD = totalUSD * 32;
                const goal = userData[userId].goal || 0;
                const percent = goal > 0 ? ((totalTWD / goal) * 100).toFixed(2) : 'N/A';

                // 回傳統計資料給使用者
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text:
                        `📊 幣圈資產總覽：\n\n${detail}--------------------------\n` +
                        `💰 資產總值：$${totalUSD.toFixed(2)}（約 NT$${totalTWD.toLocaleString()}）\n` +
                        `🎯 目標進度：${percent}%`,
                });

                // 所有未知指令皆回傳使用教學
            } else {
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: `📘 指令說明：\n/add [幣種] [數量]\n/setgoal [金額]\n/status 查詢資產狀況`,
                });
            }

        } catch (err) {
            // 捕捉錯誤但僅印出 log（建議可加上通知開發者的 webhook 通知）
            console.error('處理使用者訊息錯誤：', err);
        }
    }

    // 一定要對 LINE 回傳 HTTP 200，否則會認為 webhook 無效
    res.sendStatus(200);
});

// 啟動伺服器，預設 port 為 3000（可被 Render、Heroku 等平台覆蓋）
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ LINE Bot is running on port ${PORT}`);
});