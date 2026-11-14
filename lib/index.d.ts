import { Context, Schema } from 'koishi';
declare module 'koishi' {
    interface Tables {
        gitee_is_repo_binding: GiteeRepoBinding;
    }
}
export interface GiteeRepoBinding {
    id: number;
    channelId: string;
    owner: string;
    repo: string;
    lastCheckTime: Date;
    isPrivate: boolean;
}
export interface Config {
    giteeToken: string;
    pollInterval: number;
    debug: boolean;
    maxIssuesPerMessage: number;
    showIssueBody: boolean;
    showComments: boolean;
    maxBodyLength: number;
    maxCommentsPerIssue: number;
    maxRetries: number;
    retryDelay: number;
    circuitBreakerThreshold: number;
}
export declare const name = "gitee-is";
export declare const using: readonly ["database", "http"];
export declare const Config: Schema<Config>;
export declare function apply(ctx: Context, config: Config): void;
