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

function loadUserData() {
    if (!fs.existsSync(DATA_FILE)) return {};
    return JSON.parse(fs.readFileSync(DATA_FILE));
}

function saveUserData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function cryptoSymbolToId(symbol) {
    const map = { btc: 'bitcoin', eth: 'ethereum', usdt: 'tether' };
    return map[symbol.toLowerCase()] || null;
}

async function getCryptoPrices(symbols = []) {
    const ids = symbols.join('%2C');
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`;
    try {
        const response = await axios.get(url);
        return response.data;
    } catch (error) {
        if (error.response?.status === 429) {
            console.warn('⚠️ 已達到 CoinGecko API 呼叫限制，請稍後再試');
            return { error: 'RATE_LIMIT' };
        }
        console.error('❌ 幣價查詢失敗：', error.message);
        return { error: 'API_ERROR' };
    }
}

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
                const ids = symbols.map(cryptoSymbolToId).filter(Boolean);
                if (ids.length === 0) {
                    await client.replyMessage(event.replyToken, {
                        type: 'text',
                        text: `⚠️ 無法解析幣種，請使用正確代碼（如 btc、eth）`,
                    });
                    continue;
                }

                const prices = await getCryptoPrices(ids);
                if (prices.error === 'RATE_LIMIT') {
                    await client.replyMessage(event.replyToken, {
                        type: 'text',
                        text: `⚠️ 查詢太頻繁，請稍後再試（CoinGecko 限制）`,
                    });
                    continue;
                }

                let totalUSD = 0;
                let detail = '';

                for (const s of symbols) {
                    const id = cryptoSymbolToId(s);
                    if (!prices[id]) continue;
                    const price = prices[id].usd;
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
        }
    }

    res.sendStatus(200); // ✅ 一定要回傳 200 給 LINE
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ LINE Bot is running on port ${PORT}`);
});