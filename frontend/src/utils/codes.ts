import { db } from '@/utils/db'
import type { CodeHistory } from '@/types/codeHistory'
import type { AssetType } from '@/types/renumber'

/**
 * 编号时间线读服务：所有页面都通过它把资产 id 解析为编号，
 * 不再直接假设 turbine.code / blade.serial 就是唯一编号——
 * 当前编号取 effectiveTo=null 的时间段；历史编号按发生日期命中对应时间段。
 */

function sortByFrom(list: CodeHistory[]): CodeHistory[] {
  return [...list].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
}

/** 某资产的全部编号时间段（按生效日期升序） */
export async function historyOf(assetType: AssetType, assetId: string): Promise<CodeHistory[]> {
  const rows = await db.codeHistories.where('assetId').equals(assetId).toArray()
  return sortByFrom(rows.filter((row) => row.assetType === assetType))
}

/** 某资产当前编号（effectiveTo=null）；无时间线时返回兜底值 */
export async function currentCodeOf(
  assetType: AssetType,
  assetId: string,
  fallback = ''
): Promise<string> {
  const open = await db.codeHistories
    .where('assetId')
    .equals(assetId)
    .filter((row) => row.assetType === assetType && row.effectiveTo === null)
    .first()
  return open?.code ?? fallback
}

/** 按日期（YYYY-MM-DD）还原资产当时的编号：命中 effectiveFrom <= date < effectiveTo 的时间段 */
export function codeAtDate(history: CodeHistory[], date: string, fallback = ''): string {
  const hit = sortByFrom(history)
    .reverse()
    .find((row) => row.effectiveFrom <= date && (row.effectiveTo === null || date < row.effectiveTo))
  return hit?.code ?? fallback
}

/** 某资产的全部曾用编号（别名，不含当前编号） */
export function aliasesOf(history: CodeHistory[]): string[] {
  const current = history.find((row) => row.effectiveTo === null)?.code
  return sortByFrom(history)
    .filter((row) => row.code !== current)
    .map((row) => row.code)
}

/** 某资产当前编号 + 全部别名（按旧→新），用于关键字按旧编号兼容检索 */
export function codeAndAliases(history: CodeHistory[]): string[] {
  const aliases = aliasesOf(history)
  const current = history.find((row) => row.effectiveTo === null)?.code
  return current ? [...aliases, current] : aliases
}

/** 批量取编号时间线：key 为 `${assetType}:${assetId}` */
export async function loadHistoryMap(
  refs: Array<{ assetType: AssetType; assetId: string }>
): Promise<Map<string, CodeHistory[]>> {
  const uniq = new Set(refs.map((ref) => `${ref.assetType}:${ref.assetId}`))
  const all = await db.codeHistories.toArray()
  const map = new Map<string, CodeHistory[]>()
  all.forEach((row) => {
    const key = `${row.assetType}:${row.assetId}`
    if (!uniq.has(key)) return
    const list = map.get(key)
    if (list) list.push(row)
    else map.set(key, [row])
  })
  map.forEach((list, key) => map.set(key, sortByFrom(list)))
  return map
}

/** 历史时间线索引：供页面在内存中解析「某日期当时的编号」 */
export class CodeIndex {
  private readonly map: Map<string, CodeHistory[]>

  constructor(map: Map<string, CodeHistory[]>) {
    this.map = map
  }

  static key(assetType: AssetType, assetId: string): string {
    return `${assetType}:${assetId}`
  }

  history(assetType: AssetType, assetId: string): CodeHistory[] {
    return this.map.get(CodeIndex.key(assetType, assetId)) ?? []
  }

  current(assetType: AssetType, assetId: string, fallback = ''): string {
    const open = this.history(assetType, assetId).find((row) => row.effectiveTo === null)
    return open?.code ?? fallback
  }

  at(assetType: AssetType, assetId: string, date: string, fallback = ''): string {
    return codeAtDate(this.history(assetType, assetId), date, fallback)
  }

  aliases(assetType: AssetType, assetId: string): string[] {
    return aliasesOf(this.history(assetType, assetId))
  }

  allCodes(assetType: AssetType, assetId: string): string[] {
    return codeAndAliases(this.history(assetType, assetId))
  }
}

/**
 * 确保资产存在一条「当前」时间段；导入旧备份（无 codeHistories）后补齐。
 * 已存在当前段时不写入，保持幂等。
 */
export async function ensureInitialHistory(params: {
  assetType: AssetType
  assetId: string
  code: string
  effectiveFrom: string
}): Promise<boolean> {
  const existing = await db.codeHistories
    .where('assetId')
    .equals(params.assetId)
    .filter((row) => row.assetType === params.assetType && row.effectiveTo === null)
    .first()
  if (existing) return false
  await db.codeHistories.add({
    id: `ch-init-${params.assetType}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    assetType: params.assetType,
    assetId: params.assetId,
    code: params.code,
    effectiveFrom: params.effectiveFrom,
    effectiveTo: null,
    sourceOrderId: null,
    createdAt: Date.now()
  })
  return true
}
