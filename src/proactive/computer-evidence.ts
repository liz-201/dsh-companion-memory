import type { Repositories } from '../storage/repositories.js'

export interface ComputerEvidence { id: string; principalId: string; conversationId: string; summary: string; expiresAtMs: number }
export function computerEvidence(repos: Repositories, id: string, principalId: string, conversationId: string, nowMs: number): ComputerEvidence | null {
  if (!id.startsWith('computer:')) return null
  try {
    const evidence = JSON.parse(repos.getSetting(`local.computer-evidence:${id}`) ?? 'null') as ComputerEvidence | null
    return evidence && evidence.id === id && evidence.principalId === principalId && evidence.conversationId === conversationId && evidence.expiresAtMs > nowMs ? evidence : null
  } catch { return null }
}
