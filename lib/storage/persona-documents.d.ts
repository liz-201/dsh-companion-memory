/**
 * 人设正文的存储与跨机携带（REQ-MOBILITY R1）。
 *
 * 设计取舍：
 * - 不解析 `dsh-persona-dafeiyu` 的私有存储。宿主每轮会把 persona 段放进
 *   `system-prompt/assemble` 的 sections，这里直接把它抓成结构化文档。
 * - 抓到的正文随 portable 走，换到没装 persona 插件的电脑后由本插件自己注入。
 * - 同 id 内容不同时不覆盖本地值，只写 portable_conflicts，等显式 adopt。
 */
import type { Repositories } from './repositories.js';
export interface PersonaDocument {
    id: string;
    companionId: string;
    displayName: string | null;
    selfReference: string | null;
    ownerAddress: string | null;
    nicknames: string[];
    promptText: string;
    enabled: boolean;
    source: string;
    revision: string;
    updatedAtMs: number;
}
export declare const PERSONA_PROMPT_LIMIT: number;
export declare function personaRevision(text: string): string;
/** 与 persona-context.ts 的筛选口径保持一致：宿主的 persona 段，不含本插件自己的段。 */
export declare function personaSections(sections: unknown): string;
export declare function listPersonaDocuments(repos: Repositories, companionId: string): PersonaDocument[];
export declare function getPersonaDocument(repos: Repositories, id: string): PersonaDocument | null;
/** 取当前启用的那份；多份启用时按 updated_at_ms 最新优先，避免注入两段打架。 */
export declare function activePersonaDocument(repos: Repositories, companionId: string): PersonaDocument | null;
export interface WritePersonaInput {
    id: string;
    companionId: string;
    promptText: string;
    displayName?: string | null;
    selfReference?: string | null;
    ownerAddress?: string | null;
    nicknames?: string[];
    enabled?: boolean;
    source: string;
    nowMs: number;
}
export interface WritePersonaResult {
    written: boolean;
    revision: string;
    conflict: boolean;
}
/**
 * 写入人设。返回 conflict=true 表示同一个 id 已存在且内容不同、本地值未动。
 * 只有显式 adopt 才会覆盖（`force: true`）。
 */
export declare function writePersonaDocument(repos: Repositories, input: WritePersonaInput, force?: boolean): WritePersonaResult;
/**
 * 从宿主 sections 抓一份人设。只在抓到非空正文时写，且内容不变时不写库，
 * 避免每轮 assemble 都产生一次写放大。
 */
export declare function capturePersonaFromSections(repos: Repositories, companionId: string, sections: unknown, nowMs: number, id?: string): {
    captured: boolean;
    revision: string | null;
};
/** 渲染成可注入的一段；没有启用的人设时返回空串。 */
export declare function renderPersonaSection(repos: Repositories, companionId: string): string;
