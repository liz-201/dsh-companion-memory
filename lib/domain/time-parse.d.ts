/**
 * 用户时区下的自然语言时间解析（任务书 §14.3、§27.3）。
 *
 * 三条硬规矩，测试逐条断言：
 *   1. 一律按**用户时区**解释，绝不按服务器本地时区猜。
 *   2. 缺时间、含糊、超出支持范围 → 明确失败（调用方建 proposed），不编一个时间。
 *   3. 「今天八点」若已过去 → 返回 past，让模型/命令**确认意图**，
 *      绝不悄悄挪到明天。
 *
 * 不引第三方库：只用 Intl 做时区换算，避免多一个依赖与时区数据库漂移。
 */
export interface ZoneParts {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
    /** 0=周日，6=周六（与 Date.getDay 一致）。 */
    weekday: number;
}
/** 把绝对时刻换算成某个时区的墙钟时间。 */
export declare function partsInZone(ms: number, timezone: string): ZoneParts;
/** 该时刻在指定时区的 UTC 偏移（毫秒，东八区为 +8h）。 */
export declare function zoneOffsetMs(ms: number, timezone: string): number;
/**
 * 墙钟时间 → 绝对时刻。
 * 用两次迭代收敛，兼容有夏令时的时区；不存在的墙钟时间（跳变间隙）
 * 会被推到跳变后的第一个有效时刻，并在调用方用 partsInZone 复核。
 */
export declare function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, timezone: string): number;
export declare function formatInZone(ms: number, timezone: string): string;
/** 解析 0–59 的中文/阿拉伯数字（「八」「十五」「二十三」「8」）。 */
export declare function parseSmallNumber(text: string): number | null;
export type WhenFailure = 'missing-time' | 'past' | 'ambiguous' | 'unsupported' | 'invalid';
export interface WhenParseOk {
    ok: true;
    atMs: number;
    /** 解析依据的墙钟时间，供日志与「为什么这么理解」展示。 */
    wallClock: string;
    /** 是否只给了日期没给时刻（调用方应视作缺时间）。 */
    hasTime: true;
    matched: string;
}
export interface WhenParseFail {
    ok: false;
    reason: WhenFailure;
    detail: string;
    matched?: string;
}
export type WhenParse = WhenParseOk | WhenParseFail;
export interface ParseWhenOptions {
    nowMs: number;
    timezone: string;
    /** 用户原话；用于交叉校验（模型给的 when 必须与本句一致）。 */
    text?: string;
}
/**
 * 解析用户原话里的时间。
 * 输入可以是纯 ISO 字符串（模型产物校验路径），也可以是中文自然语言。
 */
export declare function parseWhen(input: string, options: ParseWhenOptions): WhenParse;
/**
 * 提醒请求识别：用户这句话是不是在让助手在某个时刻提醒某事。
 * 只做**保守**判定：没有「提醒/叫我/别忘了」这类明确祈使就返回 false。
 */
export declare function looksLikeReminderRequest(text: string): boolean;
/** 从「今晚八点提醒我测试连接」里剥出要做的事；剥不出就返回 null（走 proposed）。 */
export declare function extractReminderSubject(text: string): string | null;
