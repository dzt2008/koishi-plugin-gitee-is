import { Context, Schema, Logger, Session } from 'koishi'
import { format } from 'date-fns'

// ====================== 1. 类型扩展（官方规范写法） ======================
declare module 'koishi' {
  interface Tables {
    gitee_is_repo_binding: GiteeRepoBinding
  }
}

// ====================== 2. 核心类型定义 ======================
export interface GiteeRepoBinding {
  id: number                // 自增主键
  channelId: string         // 频道/会话ID（platform:guildId 或 platform:userId）
  owner: string             // Gitee 仓库所有者
  repo: string              // Gitee 仓库名称
  lastCheckTime: Date       // 最后检查时间
  isPrivate: boolean        // 是否为私聊绑定（true=私聊，false=群聊）
}

export interface Config {
  giteeToken: string        // Gitee 私人访问令牌
  pollInterval: number      // 轮询间隔（秒，默认 60，最小 30）
  debug: boolean            // 是否开启调试日志
  maxIssuesPerMessage: number // 单次推送最大 Issues 数量
  showIssueBody: boolean      // 是否显示 Issue 正文
  showComments: boolean       // 是否显示评论内容
  maxBodyLength: number       // 正文最大长度
  maxCommentsPerIssue: number // 单个 Issue 最大评论数
  maxRetries: number          // 网络请求失败时的最大重试次数
  retryDelay: number          // 重试初始延迟时间(ms)
  circuitBreakerThreshold: number // 连续失败多少次后熔断
}

// ====================== 3. 插件元信息 & 配置校验 ======================
export const name = 'gitee-is'
export const using = ['database', 'http'] as const

export const Config: Schema<Config> = Schema.object({
  giteeToken: Schema.string()
    .description('Gitee 私人访问令牌（https://gitee.com/profile/personal_access_tokens）')
    .required(),
  pollInterval: Schema.number()
    .description('Issues 轮询间隔（秒）')
    .default(60)
    .min(30),
  debug: Schema.boolean()
    .description('是否开启调试日志')
    .default(false),
  maxIssuesPerMessage: Schema.number()
    .description('单次推送最大 Issues 数量')
    .default(5)
    .min(1)
    .max(10),
  showIssueBody: Schema.boolean()
    .description('新创建的 Issue 是否显示正文内容')
    .default(true),
  showComments: Schema.boolean()
    .description('评论更新时是否显示评论内容')
    .default(true),
  maxBodyLength: Schema.number()
    .description('正文最大显示字符数（防止过长）')
    .default(500)
    .min(100)
    .max(2000),
  maxCommentsPerIssue: Schema.number()
    .description('单个 Issue 最多显示几条新评论')
    .default(3)
    .min(1)
    .max(10),
  maxRetries: Schema.number()
    .description('网络请求失败时的最大重试次数（指数退避）')
    .default(3)
    .min(0)
    .max(5),
  retryDelay: Schema.number()
    .description('重试初始延迟时间(ms)')
    .default(1000)
    .min(500)
    .max(5000),
  circuitBreakerThreshold: Schema.number()
    .description('连续失败多少次后熔断（暂停检查30秒）')
    .default(5)
    .min(3)
    .max(10),
})

// ====================== 4. 常量定义 ======================
const GITEE_API_BASE = 'https://gitee.com/api/v5'

// ====================== 5. 插件核心逻辑 ======================
export function apply(ctx: Context, config: Config) {
  // 使用 ctx.logger 创建命名空间日志实例（官方推荐）
  const logger = ctx.logger('gitee-is')
  
  // 移除错误的 logger.level 设置，改为在 debug 模式下输出一条确认信息
  if (config.debug) {
    logger.debug('Gitee Issues 插件调试模式已启用')
  }
  // 熔断器状态管理（防止连续失败的仓库拖垮整体性能）
  const circuitBreakers = new Map<string, { failures: number; lastFailure: number; state: 'CLOSED' | 'OPEN' | 'HALF_OPEN' }>()
  
  // --------------------- 5.2 数据库模型定义 ---------------------
  ctx.model.extend('gitee_is_repo_binding', {
    id: {
      type: 'unsigned',
      length: 4,
      nullable: false,
    },
    channelId: {
      type: 'string',
      length: 128,
      nullable: false,
    },
    owner: {
      type: 'string',
      length: 64,
      nullable: false,
    },
    repo: {
      type: 'string',
      length: 64,
      nullable: false,
    },
    lastCheckTime: {
      type: 'timestamp',
      nullable: false,
      initial: new Date(0),
    },
    isPrivate: {
      type: 'boolean',
      nullable: false,
      initial: false,
    },
  }, {
    primary: 'id',
    autoInc: true,
    unique: [['channelId', 'owner', 'repo']],
  })

  // --------------------- 5.3 辅助函数：获取当前会话ID ---------------------
  function getChannelId(session: Session): { channelId: string; isPrivate: boolean } {
    if (session.guildId) {
      return {
        channelId: `${session.platform}:${session.guildId}`,
        isPrivate: false
      }
    } else {
      return {
        channelId: `${session.platform}:private:${session.userId}`,
        isPrivate: true
      }
    }
  }

  function parseChannelId(channelId: string): { platform: string; targetId: string; isPrivate: boolean } {
    const parts = channelId.split(':')
    
    if (parts.length === 3 && parts[1] === 'private') {
      return {
        platform: parts[0],
        targetId: parts[2],
        isPrivate: true
      }
    } else if (parts.length >= 2) {
      return {
        platform: parts[0],
        targetId: parts.slice(1).join(':'),
        isPrivate: false
      }
    }
    
    throw new Error(`Invalid channelId format: ${channelId}`)
  }

  // 熔断器辅助函数
  function getCircuitBreaker(key: string) {
    if (!circuitBreakers.has(key)) {
      circuitBreakers.set(key, { failures: 0, lastFailure: 0, state: 'CLOSED' })
    }
    return circuitBreakers.get(key)!
  }

  function recordFailure(key: string) {
    const cb = getCircuitBreaker(key)
    cb.failures++
    cb.lastFailure = Date.now()
    
    if (cb.failures >= config.circuitBreakerThreshold) {
      cb.state = 'OPEN'
      logger.warn(`仓库 ${key} 触发熔断，暂停检查30秒`)
    }
  }

  function recordSuccess(key: string) {
    const cb = getCircuitBreaker(key)
    if (cb.state === 'HALF_OPEN' || cb.failures > 0) {
      cb.failures = Math.max(0, cb.failures - 1)
      if (cb.failures === 0) cb.state = 'CLOSED'
    }
  }

  function canRequest(key: string): boolean {
    const cb = getCircuitBreaker(key)
    if (cb.state === 'CLOSED') return true
    
    if (cb.state === 'OPEN') {
      // 30秒后进入半开状态尝试恢复
      if (Date.now() - cb.lastFailure > 30000) {
        cb.state = 'HALF_OPEN'
        logger.info(`仓库 ${key} 熔断器进入半开状态，尝试恢复`)
        return true
      }
      return false
    }
    
    return true // HALF_OPEN
  }

  function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  function isRetryableError(error: any): boolean {
    const code = error?.cause?.code || error?.code
    const status = error?.response?.status
    
    return [
      'ECONNRESET',    // 连接被重置（你遇到的错误）
      'ETIMEDOUT',     // 超时
      'ECONNREFUSED',  // 连接被拒绝
      'EPIPE',         // 管道错误
      'ENOTFOUND',     // DNS 解析失败
    ].includes(code) || (status >= 500 && status < 600) || status === 429
  }

  // --------------------- 5.4 Gitee API 请求封装（带指数退避重试） ---------------------
  async function giteeRequest<T>(endpoint: string, params?: Record<string, any>): Promise<T> {
    let lastError: any
    
    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      try {
        const data = await ctx.http.get(`${GITEE_API_BASE}${endpoint}`, {
          params: {
            ...params,
            access_token: config.giteeToken,
          },
          timeout: 15000,
          headers: {
            'Connection': 'keep-alive', // 保持连接复用，减少 ECONNRESET 概率
          },
        })
        return data as T
      } catch (error: any) {
        lastError = error
        
        // 检查是否为可重试的错误
        const isRetryable = isRetryableError(error)
        
        if (!isRetryable || attempt === config.maxRetries) {
          throw error
        }
        
        // 指数退避：1s, 2s, 4s... 最多10秒
        const delay = Math.min(config.retryDelay * Math.pow(2, attempt), 10000)
        logger.debug(`请求失败，${delay}ms 后第 ${attempt + 2} 次重试...`)
        await sleep(delay)
      }
    }
    
    throw lastError
  }

  // --------------------- 5.5 指令注册 ---------------------
  const baseCommand = ctx.command('giteeis', 'Gitee Issues 监控管理')
    .usage('支持群聊和私聊使用，仓库格式为「所有者/仓库名」（如 koishijs/koishi）')

  // 子指令 1：添加仓库
  baseCommand.subcommand('.add <repo:string>', '添加要监控的 Gitee 仓库')
    .usage('添加要监控的 Gitee 仓库，格式：所有者/仓库名\n在群聊中使用则绑定到当前群，私聊中使用则绑定到当前私聊会话')
    .example('giteeis.add koishijs/koishi')
    .action(async ({ session }, repo) => {
      if (!session) return '❌ 会话不存在'

      const { channelId, isPrivate } = getChannelId(session)
      const sceneType = isPrivate ? '私聊' : '群聊'

      if (!repo || !repo.includes('/')) {
        return '❌ 仓库格式错误！正确格式：所有者/仓库名（例如：koishijs/koishi）'
      }

      const [owner, repoName] = repo.split('/')
      if (!owner || !repoName) {
        return '❌ 仓库格式错误！所有者或仓库名不能为空。'
      }

      try {
        await giteeRequest(`/repos/${owner}/${repoName}`)
      } catch (error: any) {
        const status = error?.response?.status
        if (status === 404) {
          return `❌ 仓库 ${owner}/${repoName} 不存在！`
        } else if (status === 403) {
          return `❌ 没有权限访问仓库 ${owner}/${repoName}，请检查 Token 是否有权限访问该仓库。`
        }
        return `❌ 验证仓库失败：${error.message || '网络错误，请检查网络连接'}`
      }

      const existing = await ctx.database.get('gitee_is_repo_binding', { 
        channelId, 
        owner, 
        repo: repoName 
      })

      if (existing.length > 0) {
        return `ℹ️ 该${sceneType}已绑定仓库 ${owner}/${repoName}，无需重复添加！`
      }

      await ctx.database.create('gitee_is_repo_binding', {
        channelId,
        owner,
        repo: repoName,
        lastCheckTime: new Date(),
        isPrivate,
      })

      return `✅ 成功在${sceneType}中绑定仓库 ${owner}/${repoName}！\n已开始监控其 Issues 动态，新 Issue 或更新将自动推送至此${sceneType}。`
    })

  // 子指令 2：删除仓库
  baseCommand.subcommand('.remove <repo:string>', '删除已绑定的 Gitee 仓库')
    .usage('删除当前群聊或私聊中已绑定的 Gitee 仓库监控')
    .example('giteeis.remove koishijs/koishi')
    .action(async ({ session }, repo) => {
      if (!session) return '❌ 会话不存在'

      const { channelId, isPrivate } = getChannelId(session)
      const sceneType = isPrivate ? '私聊' : '群聊'

      if (!repo || !repo.includes('/')) {
        return '❌ 仓库格式错误！正确格式：所有者/仓库名'
      }

      const [owner, repoName] = repo.split('/')

      const result = await ctx.database.remove('gitee_is_repo_binding', { 
        channelId, 
        owner, 
        repo: repoName 
      })

      const deletedCount = typeof result === 'number' ? result : (result as any).matchedCount || 0

      if (deletedCount > 0) {
        return `✅ 成功删除${sceneType}中绑定的仓库 ${owner}/${repoName}！`
      } else {
        return `ℹ️ 当前${sceneType}未绑定仓库 ${owner}/${repoName}，无需删除！`
      }
    })

  // 子指令 3：查看当前绑定的仓库
  baseCommand.subcommand('.list', '查看当前会话已绑定的所有 Gitee 仓库')
    .usage('查看当前群聊或私聊中已绑定的所有 Gitee 仓库列表')
    .action(async ({ session }) => {
      if (!session) return '❌ 会话不存在'

      const { channelId, isPrivate } = getChannelId(session)
      const sceneType = isPrivate ? '私聊' : '群聊'

      const bindings = await ctx.database.get('gitee_is_repo_binding', { channelId })

      if (bindings.length === 0) {
        return `ℹ️ 当前${sceneType}暂未绑定任何 Gitee 仓库！\n使用 giteeis.add <所有者/仓库名> 添加监控。`
      }

      const repoList = bindings.map(b => {
        const lastCheck = format(b.lastCheckTime, 'yyyy-MM-dd HH:mm:ss')
        return `• ${b.owner}/${b.repo} (上次检查: ${lastCheck})`
      }).join('\n')
      
      return `📋 当前${sceneType}已绑定 ${bindings.length} 个 Gitee 仓库：\n${repoList}`
    })

  // 子指令 4：查看仓库的 Open Issues
  baseCommand.subcommand('.issues <repo:string>', '查看指定仓库的所有 Open 状态 Issues')
    .usage('查看指定仓库当前 Open 状态的 Issues 列表（无需绑定即可查询）')
    .example('giteeis.issues koishijs/koishi')
    .action(async ({ session }, repo) => {
      if (!repo || !repo.includes('/')) {
        return '❌ 仓库格式错误！正确格式：所有者/仓库名'
      }

      const [owner, repoName] = repo.split('/')

      try {
        const issues = await giteeRequest<any[]>(`/repos/${owner}/${repoName}/issues`, {
          state: 'open',
          per_page: 20,
          sort: 'created',
          direction: 'desc',
        })

        if (!Array.isArray(issues) || issues.length === 0) {
          return `ℹ️ 仓库 ${owner}/${repoName} 暂无 Open 状态的 Issues！`
        }

        const issuesList = issues.map((issue: any) => {
          const number = issue?.number || '未知'
          const title = issue?.title || '无标题'
          const author = issue?.user?.login || '未知作者'
          const createTime = issue?.created_at 
            ? format(new Date(issue.created_at), 'yyyy-MM-dd HH:mm') 
            : '未知时间'
          const url = issue?.html_url || '无链接'
          const labels = issue?.labels?.map((l: any) => l.name).join(', ') || '无标签'
          
          return `【#${number}】${title}\n` +
            `作者：${author} | 标签：${labels}\n` +
            `创建时间：${createTime}\n` +
            `链接：${url}`
        }).join('\n\n')

        return `📄 仓库 ${owner}/${repoName} 的 Open Issues（共 ${issues.length} 条）：\n\n${issuesList}`
      } catch (error: any) {
        logger.error(`获取 Issues 失败: ${owner}/${repoName}`, error)
        return `❌ 获取 Issues 失败！${error.message?.includes('fetch') ? '网络连接错误，请检查网络。' : (error.message || '请检查仓库名是否正确或网络连接。')}`
      }
    })

  // 子指令 5：手动触发检查
  baseCommand.subcommand('.check', '手动触发一次 Issues 检查（调试用）')
    .usage('立即执行一次 Issues 更新检查，不受轮询间隔限制')
    .action(async ({ session }) => {
      pollIssues().catch(err => logger.error('手动检查失败', err))
      return '🔍 已触发 Issues 检查，请留意后续消息推送。'
    })

  // --------------------- 5.6 定时轮询逻辑（带熔断器保护） ---------------------
  async function pollIssues() {
    logger.debug('开始轮询检查 Gitee Issues 更新')

    try {
      const allBindings = await ctx.database.get('gitee_is_repo_binding', {})

      if (allBindings.length === 0) {
        logger.debug('暂无绑定的仓库，跳过本轮轮询')
        return
      }

      logger.debug(`开始检查 ${allBindings.length} 个绑定的仓库`)

      for (const binding of allBindings) {
        if (!binding?.channelId || !binding?.owner || !binding?.repo) {
          logger.warn('无效的仓库绑定数据，跳过：', binding)
          continue
        }

        const { channelId, owner, repo, lastCheckTime, isPrivate } = binding
        const repoKey = `${owner}/${repo}`
        
        // 熔断器检查：如果该仓库连续失败多次，暂时跳过
        if (!canRequest(repoKey)) {
          logger.debug(`仓库 ${repoKey} 处于熔断状态，跳过检查`)
          continue
        }
        
        try {
          const { platform, targetId } = parseChannelId(channelId)

          const issues = await giteeRequest<any[]>(`/repos/${owner}/${repo}/issues`, {
            state: 'all',
            sort: 'updated',
            direction: 'desc',
            per_page: 50,
            since: lastCheckTime.toISOString(),
          })

          // 请求成功，重置熔断器失败计数
          recordSuccess(repoKey)

          if (!Array.isArray(issues) || issues.length === 0) {
            logger.debug(`仓库 ${owner}/${repo} 无更新`)
            continue
          }

          const lastCheck = new Date(lastCheckTime).getTime()
          const updatedIssues = issues.filter((issue: any) => {
            const updateTime = new Date(issue?.updated_at).getTime()
            return !isNaN(updateTime) && updateTime > lastCheck
          })

          if (updatedIssues.length === 0) {
            logger.debug(`仓库 ${owner}/${repo} 无有效更新`)
            continue
          }

          logger.info(`仓库 ${owner}/${repo} 发现 ${updatedIssues.length} 个更新的 Issues`)

          for (const issue of updatedIssues.slice(0, config.maxIssuesPerMessage)) {
            await processAndPushIssue(
              issue, 
              owner, 
              repo, 
              lastCheck, 
              platform, 
              targetId, 
              isPrivate,
              channelId
            )
            // 添加小延迟，避免消息发送过快
            await sleep(100)
          }

          const remainingCount = updatedIssues.length - Math.min(updatedIssues.length, config.maxIssuesPerMessage)
          if (remainingCount > 0) {
            const bot = ctx.bots.find(b => b.platform === platform)
            if (bot?.online) {
              const msg = `...还有 ${remainingCount} 条 Issue 更新未显示`
              if (isPrivate) {
                await bot.sendPrivateMessage(targetId, msg)
              } else {
                await bot.sendMessage(targetId, msg)
              }
            }
          }

        } catch (error: any) {
          // 记录失败，触发熔断器逻辑
          recordFailure(repoKey)
          
          const isNetworkError = isRetryableError(error)
          
          if (isNetworkError) {
            logger.warn(`仓库 ${owner}/${repo} 网络请求失败 (${getCircuitBreaker(repoKey).failures}/${config.circuitBreakerThreshold})：${error?.cause?.code || error.message}`)
          } else {
            logger.error(`检查仓库 ${owner}/${repo} Issues 失败：`, error.message)
          }
          
          // 非网络错误且未达到熔断阈值时，尝试推送错误提示（限流）
          if (!isNetworkError && getCircuitBreaker(repoKey).failures < 3) {
            try {
              const { platform, targetId, isPrivate } = parseChannelId(channelId)
              const bot = ctx.bots.find(b => b.platform === platform && b.online)
              if (bot) {
                const errorMsg = `⚠️ 监控仓库 ${owner}/${repo} 时出错：${error.message?.substring(0, 100) || '未知错误'}`
                if (isPrivate) {
                  await bot.sendPrivateMessage(targetId, errorMsg).catch(() => {})
                } else {
                  await bot.sendMessage(targetId, errorMsg).catch(() => {})
                }
              }
            } catch (err) {
              logger.error('推送错误提示失败：', err)
            }
          }
          continue
        } finally {
          // 更新最后检查时间（无论成功与否都更新，避免重复检查）
          try {
            await ctx.database.set('gitee_is_repo_binding', 
              { id: binding.id },
              { lastCheckTime: new Date() }
            )
          } catch (err) {
            logger.error('更新最后检查时间失败：', err)
          }
        }
      }
    } catch (error: any) {
      logger.error('轮询过程发生错误：', error.message)
    }
  }

  // 处理并推送单个 Issue 的详细信息
  async function processAndPushIssue(
    issue: any,
    owner: string,
    repo: string,
    lastCheck: number,
    platform: string,
    targetId: string,
    isPrivate: boolean,
    channelId: string
  ) {
    const issueNumber = issue?.number
    const issueCreateTime = new Date(issue?.created_at).getTime()
    
    let type = '🔄 内容更新'
    let showBody = false
    let showComments = false
    
    if (issueCreateTime > lastCheck) {
      type = '🆕 新创建'
      showBody = config.showIssueBody
    } else if (issue?.comments > 0) {
      type = '💬 评论更新'
      showComments = config.showComments
    }

    let bodyContent = ''
    if (showBody && config.showIssueBody) {
      try {
        const issueDetail = await giteeRequest<any>(`/repos/${owner}/${repo}/issues/${issueNumber}`)
        bodyContent = issueDetail?.body || ''
        if (bodyContent.length > config.maxBodyLength) {
          bodyContent = bodyContent.substring(0, config.maxBodyLength) + '...'
        }
      } catch (err) {
        logger.debug(`获取 Issue #${issueNumber} 正文失败`)
      }
    }

    let commentsContent: string[] = []
    if (showComments && config.showComments && issue?.comments > 0) {
      try {
        const comments = await giteeRequest<any[]>(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
          sort: 'updated',
          direction: 'desc',
          per_page: config.maxCommentsPerIssue,
        })
        
        const newComments = comments.filter((c: any) => {
          const commentTime = new Date(c?.created_at).getTime()
          return !isNaN(commentTime) && commentTime > lastCheck
        })

        commentsContent = newComments.map((c: any) => {
          const author = c?.user?.login || '未知作者'
          const body = c?.body || ''
          const truncatedBody = body.length > 200 ? body.substring(0, 200) + '...' : body
          return `💬 ${author}: ${truncatedBody}`
        })
      } catch (err) {
        logger.debug(`获取 Issue #${issueNumber} 评论失败`)
      }
    }

    const number = issue?.number || '未知'
    const title = issue?.title || '无标题'
    const author = issue?.user?.login || '未知作者'
    const updateTime = issue?.updated_at 
      ? format(new Date(issue.updated_at), 'yyyy-MM-dd HH:mm') 
      : '未知时间'
    const state = issue?.state === 'open' ? '🟢 Open' : '🔴 Closed'
    const url = issue?.html_url || '无链接'

    let message = `${type} Issue【#${number}】${title}\n` +
      `状态：${state} | 仓库：${owner}/${repo}\n` +
      `作者：${author} | 更新时间：${updateTime}\n`

    if (bodyContent) {
      message += `\n📝 正文：\n${bodyContent}\n`
    }

    if (commentsContent.length > 0) {
      message += `\n📢 新增评论：\n${commentsContent.join('\n')}\n`
    }

    // 链接始终放在最后
    message += `\n链接：${url}`

    const bot = ctx.bots.find(b => b.platform === platform)
    if (!bot || !bot.online) {
      logger.warn(`Bot 不可用，跳过推送到 ${channelId}`)
      return
    }

    if (isPrivate) {
      await bot.sendPrivateMessage(targetId, message)
    } else {
      await bot.sendMessage(targetId, message)
    }
    
    logger.debug(`成功推送 Issue #${number} 更新到 ${channelId}`)
  }

  // --------------------- 5.7 定时任务配置 ---------------------
  const pollTimer = ctx.setInterval(pollIssues, config.pollInterval * 1000)

  const initialTimer = ctx.setTimeout(() => {
    pollIssues().catch(err => logger.error('初始检查失败', err))
  }, 5000)

  // --------------------- 5.8 插件卸载清理 ---------------------
  ctx.on('dispose', () => {
    logger.info('Gitee Issues 插件已卸载，清理定时任务')
    initialTimer()
    pollTimer()
    circuitBreakers.clear()
  })
}
