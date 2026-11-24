# Quefa CDK 兑换页

同域 Node 服务托管兑换页，并使用代理商凭据签名调用 Quefa Partner API。用户可以验证 ChatGPT CDK、核对账号、提交兑换并恢复进度。

## 本地启动

需要 Node.js 24 或更新版本。将以下配置写入项目根目录的 `.env`，或通过部署环境注入。

```dotenv
QUEFA_PARTNER_ID=
QUEFA_KEY_ID=
QUEFA_CLIENT_SECRET=
QUEFA_API_ORIGIN=https://tibo.ink
REDEMPTION_RECORD_SECRET=
APP_ORIGIN=http://127.0.0.1:5173
PORT=5173
```

`REDEMPTION_RECORD_SECRET` 至少 32 字节。可用以下命令生成，并在重启和部署间保留同一个值，以便验证已有查询码和会话。

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
npm run check:quefa
npm start
```

打开 `http://127.0.0.1:5173`。网站名称和客服链接在 `config.js` 配置。

## 联调与部署

- `npm test` 使用本地模拟 Quefa 服务执行签名和接口测试。沙箱联调时，将 `QUEFA_API_ORIGIN` 和三项 API 凭据一起切换到 Quefa 提供的沙箱配置。
- `npm run check:quefa` 签名检查代理状态和 `customRedemptionEnabled`。正式部署还需确认相关商品授权、出口 IP 白名单和服务器时钟。
- 生产设置 `NODE_ENV=production` 和 HTTPS 的 `APP_ORIGIN`。使用单个 Node 实例，将 `REDEMPTION_DB_PATH` 指向持久卷上的 SQLite 文件，默认路径为 `data/redemptions.sqlite`。部署在同机反向代理后时，可设置 `TRUST_LOOPBACK_PROXY=1` 并由代理覆盖 `X-Real-IP`，以便按客户端 IP 限流。
- 在沙箱验证 Quefa 允许用原卡密执行 `mode=cdk` 重提后，设置 `ENABLE_CDK_RETRY=1`。按钮还会根据最新任务的重提条件动态显示。
- 排查时使用本站兑换编号和应用日志中的 Quefa `X-Request-Id`。代理层和日志工具应排除请求正文、Cookie 和鉴权头。

实现范围和验收条件见 [Quefa CDK 兑换适配开发计划](QUEFA_ADAPTATION_PLAN.md)。
