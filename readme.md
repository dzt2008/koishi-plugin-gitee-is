# koishi-plugin-gitee-is

[![npm](https://img.shields.io/npm/v/koishi-plugin-gitee-is?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-gitee-is)

gitee-issues


**赞美ai，离不开ai了怎么办（）**

# 更新日志

### 0.0.3

- 修复：日志级别设置问题，改用 `ctx.logger()` 和数字级别（3=INFO, 4=DEBUG）替代不存在的 `Logger.DEBUG`
- 新增：网络请求指数退避重试机制，自动重试 3 次（延迟 1s→2s→4s），有效处理 ECONNRESET 等网络错误
- 新增：熔断器模式，连续失败 5 次的仓库自动暂停检查 30 秒，避免拖垮整体性能
- 新增：HTTP Keep-Alive 头部，减少连接重置概率
- 新增：配置项 `maxRetries`（最大重试次数）、`retryDelay`（初始延迟）、`circuitBreakerThreshold`（熔断阈值）
- 优化：错误处理逻辑，网络错误仅记录日志不再刷屏，仅业务错误推送群聊提示
- 优化：添加消息发送间隔（100ms），避免多条推送过快

### 0.0.2

- 新增：支持显示新建 Issue 的正文内容
- 新增：支持显示新增评论的具体内容
- 新增：可配置参数 `showIssueBody`、`showComments`、`maxBodyLength`、`maxCommentsPerIssue`
- 修复：删除仓库时 `WriteResult` 类型兼容问题

### 0.0.1

- 初始版本发布
