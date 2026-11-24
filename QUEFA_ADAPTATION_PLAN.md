# Quefa CDK 兑换适配开发计划

## 目标

将现有兑换页切换至 Quefa，覆盖用户已有 ChatGPT CDK 的兑换。同域 Node 24 服务托管页面并签名调用 Quefa Partner API。接口以完整接入包中的 OpenAPI 1.4.3 为准。

## 接口和用户流程

| 本站接口 | 对应行为 |
| --- | --- |
| `POST /api/redemption/preview` | 调用 `POST /v1/cdk/preview`，验证原卡密，展示商品和目标套餐，发放本站查询码。 |
| `POST /api/redemption/submit` | 用户确认后调用 `POST /v1/redemptions`，传入 `mode=cdk`、原卡密、完整 Session 和 `customer_confirmed_email=true`。 |
| `GET /api/redemption/status` | 用本站会话定位记录，调用 `GET /v1/redemptions/{redemption_id}` 查询最新任务。 |
| `POST /api/redemption/recover` | 用原卡密和本站查询码在另一设备建立查询会话。 |
| `POST /webhooks/quefa` | 使用 Quefa 独立回调密钥验签，按事件 ID 持久化去重，再后台查询已知 CDK 订单的最新任务。 |

页面从 Session 尽量读取邮箱供用户核对，标注「账号待平台校验」。用户确认前，Session 留在当前页面。确认时原样提交并清空。服务端用同一份 UTF-8 正文签名和发送，按序列化后的 256 KiB 字节上限校验请求。

## 任务状态与恢复

SQLite 保存本站兑换编号、卡密和查询码的带密钥指纹、幂等键、平台任务映射及脱敏状态。安全 Cookie 支持同一浏览器刷新恢复。HTTP `202` 只代表已受理，任务状态为 `succeeded` 时显示成功及完成时间。前两分钟每 5 秒轮询，之后每 20 秒轮询，遵守 `Retry-After`，并跟进 Quefa 返回的最新任务。

同一卡密原子防重，同次传输重放沿用原正文和幂等键并更新签名。没有任务号的未知结果进入待核对状态，24 小时内可用原资料和原键核对，超出窗口由本站客服处理。手动重试只在最新任务明确失败或取消、未暂停、允许重提并返回 `next_action=resubmit` 与 `fallback_recharge_available=true` 时开放。重提前重新查任务，用户主动确认后使用新幂等键。

## 验收与上线

1. 签名通过接入包提供的三组测试向量，模拟服务覆盖原始卡密、长 Session、重复提交、超时、限流、最新任务、退款及跨设备恢复。
2. 用本代理沙箱卡密验证主渠道与渠道二的接单及终态，完成显式 CDK 重提验证后启用重试入口。用 Quefa 工作台的测试回调验证应用配置和公网 HTTPS 地址。
3. 上线前确认代理状态、自建兑换权限、商品授权和出口 IP。生产环境使用 HTTPS 和持久卷，保护应用密钥及本地记录。排障使用本站兑换编号及上游 `X-Request-Id`。
