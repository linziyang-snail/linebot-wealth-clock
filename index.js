const express = require('express');
const dotenv = require('dotenv');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const line = require('@line/bot-sdk');

dotenv.config();

const config = {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(config);
const app = express();

app.use(line.middleware(config));
app.use(express.json());

const DATA_FILE = path.join(__dirname, 'userData.json');

// 讀取使用者資料
function loadUserData() {
    if (!fs.existsSync(DATA_FILE)) return {};
    return JSON.parse(fs.readFileSync(DATA_FILE));
}

// 儲存使用者資料
function saveUserData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// 使用 Binance 批次查詢幣價
async function getCryptoPrices(symbols = []) {
    try {
        const response = await axios.get('https://api1.binance.com/api/v3/ticker/price');
        const prices = response.data;

        const result = {};
        for (const symbol of symbols) {
            const pair = `${symbol.toUpperCase()}USDT`;
            const match = prices.find(p => p.symbol === pair);
            if (match) {
                result[symbol.toLowerCase()] = { usd: parseFloat(match.price) };
            }
        }
        return result;
    } catch (error) {
        console.error('❌ Binance 幣價查詢失敗：', error.message);
        return { error: 'API_ERROR' };
    }
}

// 接收 Webhook 請求
app.post('/webhook', async (req, res) => {
    const events = req.body.events;
    const userData = loadUserData();

    for (const event of events) {
        try {
            if (event.type !== 'message' || event.message.type !== 'text') continue;

            const userId = event.source.userId;
            const msg = event.message.text.trim();
            const [cmd, symbol, amount] = msg.split(' ');
            userData[userId] = userData[userId] || { goal: 0, assets: {} };

            if (cmd === '/add') {
                if (!symbol || isNaN(parseFloat(amount))) {
                    await client.replyMessage(event.replyToken, {
                        type: 'text',
                        text: `⚠️ 格式錯誤，請使用：/add 幣種 數量\n例如：/add btc 0.5`,
                    });
                    continue;
                }

                userData[userId].assets[symbol.toLowerCase()] = parseFloat(amount);
                saveUserData(userData);

                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: `✅ 已新增 ${symbol.toUpperCase()} 數量：${amount}`,
                });

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

            } else if (cmd === '/status') {
                const assets = userData[userId].assets;
                if (!assets || Object.keys(assets).length === 0) {
                    await client.replyMessage(event.replyToken, {
                        type: 'text',
                        text: `📭 尚未新增任何幣種資產，請使用 /add 開始記錄！`,
                    });
                    continue;
                }

                const symbols = Object.keys(assets);
                const prices = await getCryptoPrices(symbols);

                if (prices.error === 'API_ERROR') {
                    await client.replyMessage(event.replyToken, {
                        type: 'text',
                        text: `⚠️ 幣價查詢失敗，請稍後再試`,
                    });
                    continue;
                }

                let totalUSD = 0;
                let detail = '';

                for (const s of symbols) {
                    const priceData = prices[s.toLowerCase()];
                    if (!priceData) continue;
                    const price = priceData.usd;
                    const value = price * assets[s];
                    totalUSD += value;
                    detail += `${s.toUpperCase()}：${assets[s]} 顆 x $${price} = $${value.toFixed(2)}\n`;
                }

                const totalTWD = totalUSD * 32;
                const goal = userData[userId].goal || 0;
                const percent = goal > 0 ? ((totalTWD / goal) * 100).toFixed(2) : 'N/A';

                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text:
                        `📊 幣圈資產總覽：\n\n${detail}--------------------------\n` +
                        `💰 資產總值：$${totalUSD.toFixed(2)}（約 NT$${totalTWD.toLocaleString()}）\n` +
                        `🎯 目標進度：${percent}%`,
                });

            } else {
                await client.replyMessage(event.replyToken, {
                    type: 'text',
                    text: `📘 指令說明：\n/add [幣種] [數量]\n/setgoal [金額]\n/status 查詢資產狀況`,
                });
            }

        } catch (err) {
            console.error('處理使用者訊息錯誤：', err);
            await client.replyMessage(event.replyToken, {
                type: 'text',
                text: `❌ 發生錯誤，請稍後再試`,
            });
        }
    }

    res.sendStatus(200);
});

// 啟動伺服器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ LINE Bot is running on port ${PORT}`);
});