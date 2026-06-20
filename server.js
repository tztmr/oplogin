const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const { buildWakeUrl } = require('./lib/op-url');

const app = express();
const PORT = process.env.PORT || 3000;

// 启用中间件
app.use(cors());
app.use(express.json());

// 静态文件托管（前端页面）
app.use(express.static(path.join(__dirname, 'public')));

// API 代理路由，解决前端跨域问题
app.post('/api/submit', async (req, res) => {
    const { url, game } = req.body;

    if (!url || !game) {
        return res.status(400).json({ error: 'Missing required parameters: url or game' });
    }

    try {
        const wakeUrl = buildWakeUrl(url, game);

        return res.status(200).json({
            status: 'success',
            url: wakeUrl,
            source: 'local'
        });
    } catch (localError) {
        console.warn('Local encode failed, falling back to remote API:', localError.message);

        try {
            // 向目标服务器发送真实的请求作为兜底，兼容未来可能出现的其他数据格式。
            const response = await axios.post('https://www.opdengluqi.com/api.php', {
                url,
                game
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    // 伪造 Referer 和 User-Agent，防止目标服务器拦截非浏览器请求
                    'Referer': 'https://www.opdengluqi.com/',
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            });

            // 将目标服务器的返回数据原样返回给前端
            return res.status(200).json({
                ...response.data,
                source: 'remote'
            });
        } catch (remoteError) {
            console.error('API Error:', remoteError.message);
            return res.status(500).json({
                error: 'Failed to encode data locally or fetch from target API',
                detail: localError.message
            });
        }
    }
});

// 捕获所有其他 GET 请求，并返回 index.html，以支持 URL 参数提取（如 /785C405C...）
app.get(/^.*$/, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
