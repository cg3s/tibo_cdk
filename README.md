# Quefa CDK 兑换页

同域 Node 服务托管兑换页，并使用代理商凭据签名调用 Quefa Partner API。用户可以验证 ChatGPT CDK、核对账号、提交兑换并恢复进度。

## 本地启动

需要 Node.js 24 或更新版本。将以下配置写入项目根目录的 `.env`，或通过部署环境注入。

```dotenv
QUEFA_PARTNER_ID=
QUEFA_APP_ID=
QUEFA_KEY_ID=
QUEFA_CLIENT_SECRET=
QUEFA_WEBHOOK_SECRET=
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

## Quefa 应用与回调

1. 在 Quefa 工作台选择接入应用。将该应用的 App ID 写入 `QUEFA_APP_ID` 供部署核对，签名凭据使用同一应用的 Partner ID、Key ID 和 Client Secret。接入包定义的签名请求头中没有 App ID。
2. 在工作台登记 `https://你的域名/webhooks/quefa`，将回调的独立签名密钥写入 `QUEFA_WEBHOOK_SECRET`。订阅 `fulfillment.updated`、`fulfillment.succeeded`、`fulfillment.failed`、`fulfillment.cancelled` 和 `refund.succeeded`。
3. 在 Quefa 发起测试回调，确认 HTTPS 地址可达且返回 HTTP 204。回调按事件 ID 去重，签名复查已知 CDK 订单和最新任务。浏览器轮询作为补充。

## 联调与部署

- `npm test` 使用本地模拟 Quefa 服务执行签名和接口测试。沙箱联调时，将 `QUEFA_API_ORIGIN` 和三项 API 凭据一起切换到 Quefa 提供的沙箱配置。
- `npm run check:quefa` 签名检查代理状态和 `customRedemptionEnabled`。若返回 `ip_not_allowed`，在工作台的「开放接口 → 应用与密钥 → IP 白名单」核对运行命令的机器所用出口 IP。若返回 `api_access_required`，核对代理和应用的 API 权限。正式部署还需确认相关商品授权和服务器时钟。
- 生产设置 `NODE_ENV=production` 和 HTTPS 的 `APP_ORIGIN`。使用单个 Node 实例，将 `REDEMPTION_DB_PATH` 指向持久卷上的 SQLite 文件，默认路径为 `data/redemptions.sqlite`。部署在同机反向代理后时，可设置 `TRUST_LOOPBACK_PROXY=1` 并由代理覆盖 `X-Real-IP`，以便按客户端 IP 限流。
- 在沙箱验证 Quefa 允许用原卡密执行 `mode=cdk` 重提后，设置 `ENABLE_CDK_RETRY=1`。按钮还会根据最新任务的重提条件动态显示。
- 排查时使用本站兑换编号和应用日志中的 Quefa `X-Request-Id`。代理层和日志工具应排除请求正文、Cookie 和鉴权头。

实现范围和验收条件见 [Quefa CDK 兑换适配开发计划](QUEFA_ADAPTATION_PLAN.md)。
