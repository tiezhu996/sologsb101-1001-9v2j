/**
 * 资产变更单：风电场增容后机组 / 叶片重新编号的变更载体。
 * 流程：草稿 → 已冻结（锁定关联、列出受影响记录）→ 应用中（逐映射落库、可断点续跑）→ 已生效。
 * 旧编号以 CodeAlias 别名形式保留，历史数据按原编号兼容读取，
 * 报告按记录发生时间从别名的时间区间解析「当时编号」。
 */

/** 变更单状态机 */
export type ChangeOrderState = 'draft' | 'frozen' | 'applying' | 'applied' | 'cancelled'

/** 可改号的实体类型：机组按 code、叶片按机组内 serial */
export type RenumberEntityType = 'turbine' | 'blade'

/** 单条改号映射：旧编号 → 新编号 */
export interface RenumberMapping {
  /** 映射键 `${entityType}:${targetId}`，应用进度按它登记，保证幂等 */
  key: string
  entityType: RenumberEntityType
  /** 目标记录 id（机组 id / 叶片 id） */
  targetId: string
  /** 叶片映射所属机组 id；机组映射为 null */
  parentId: string | null
  /** 旧编号（冻结时的在册编号） */
  oldCode: string
  /** 新编号 */
  newCode: string
}

/** 冻结时锁定的受影响记录范围（机组 → 叶片 → 分段 → 缺陷 → 工单） */
export interface ChangeOrderSnapshot {
  frozenAt: number
  turbineIds: string[]
  bladeIds: string[]
  segmentIds: string[]
  defectIds: string[]
  workOrderIds: string[]
}

/** 校验问题：撞车、引用漏项等；存在问题时变更单不允许提交 */
export interface ChangeOrderIssue {
  /** 相关映射键；全局问题为空串 */
  mappingKey: string
  message: string
}

/** 应用进度：每完成一条映射登记其 key，写入中断后从这里继续 */
export interface ChangeOrderProgress {
  appliedKeys: string[]
  total: number
}

/** 资产变更单 */
export interface ChangeOrder {
  id: string
  /** 变更单号，如 AC-20261005-8f3k */
  code: string
  title: string
  /** 变更原因（如：增容改造后全场重编号） */
  reason: string
  state: ChangeOrderState
  mappings: RenumberMapping[]
  /** 冻结时的受影响记录快照，未冻结为 null */
  snapshot: ChangeOrderSnapshot | null
  /** 最近一次校验发现的问题 */
  issues: ChangeOrderIssue[]
  progress: ChangeOrderProgress
  /**
   * 生效基准时间：确认时固定，重试 / 断点续跑复用同一值，
   * 保证别名时间区间与「当时编号」解析结果稳定。
   */
  effectiveAt: number | null
  frozenAt: number | null
  confirmedAt: number | null
  appliedAt: number | null
  createdAt: number
  updatedAt: number
}

/**
 * 编号别名：一个实体的一段编号有效期（含当前在册编号，validTo 为 null）。
 * 初始登记的别名 orderId 为空串；改号产生的别名记录来源变更单。
 */
export interface CodeAlias {
  id: string
  entityType: RenumberEntityType
  /** 当前实体 id */
  targetId: string
  /** 叶片别名所属机组 id（叶片序号只在机组内唯一）；机组别名为 null */
  parentId: string | null
  /** 编号文本：机组 code / 叶片 serial */
  code: string
  /** 该编号生效起点（时间戳） */
  validFrom: number
  /** 该编号失效时间；仍在册为 null */
  validTo: number | null
  /** 来源变更单 id；初始登记为 '' */
  orderId: string
  createdAt: number
  updatedAt: number
}

export const CHANGE_ORDER_STATES: ChangeOrderState[] = [
  'draft',
  'frozen',
  'applying',
  'applied',
  'cancelled'
]

export const CHANGE_ORDER_STATE_LABEL: Record<ChangeOrderState, string> = {
  draft: '草稿',
  frozen: '已冻结',
  applying: '应用中',
  applied: '已生效',
  cancelled: '已取消'
}

/** Element Plus tag type 映射 */
export const CHANGE_ORDER_STATE_TAG: Record<ChangeOrderState, 'info' | 'warning' | 'primary' | 'success' | 'danger'> = {
  draft: 'info',
  frozen: 'warning',
  applying: 'primary',
  applied: 'success',
  cancelled: 'danger'
}

/** 生成映射键：与 utils/changeOrder.ts 的进度登记保持一致 */
export function mappingKeyOf(entityType: RenumberEntityType, targetId: string): string {
  return `${entityType}:${targetId}`
}

/** 受影响记录统计（快照卡片的回显结构） */
export interface AffectedCounts {
  turbines: number
  blades: number
  segments: number
  defects: number
  workOrders: number
}

export function affectedCountsOf(snapshot: ChangeOrderSnapshot | null): AffectedCounts {
  return {
    turbines: snapshot?.turbineIds.length ?? 0,
    blades: snapshot?.bladeIds.length ?? 0,
    segments: snapshot?.segmentIds.length ?? 0,
    defects: snapshot?.defectIds.length ?? 0,
    workOrders: snapshot?.workOrderIds.length ?? 0
  }
}

/** 初始登记别名 id（每台机组 / 每片叶片唯一，重复写入互相覆盖，天然幂等） */
export function initialAliasId(targetId: string): string {
  return `als_init_${targetId}`
}

/** 变更单产生的别名 id：同一变更单对同一目标重复应用时覆盖而非新增 */
export function orderAliasId(orderId: string, targetId: string): string {
  return `als_${orderId}_${targetId}`
}

/**
 * 按时间解析编号：返回 at 时刻在册的编号。
 * at 早于首段有效期时取最早编号（记录先于台账登记的场景）。
 */
export function codeAt(
  aliases: CodeAlias[],
  entityType: RenumberEntityType,
  targetId: string,
  at: number
): string | null {
  const rows = aliases
    .filter((alias) => alias.entityType === entityType && alias.targetId === targetId)
    .sort((a, b) => a.validFrom - b.validFrom)
  if (rows.length === 0) return null
  const hit = rows.find((alias) => alias.validFrom <= at && (alias.validTo === null || at < alias.validTo))
  return (hit ?? rows[0]).code
}

/** 当前在册编号（无别名记录时返回 null，调用方回退到实体字段） */
export function currentCodeOf(
  aliases: CodeAlias[],
  entityType: RenumberEntityType,
  targetId: string
): string | null {
  const open = aliases.find(
    (alias) => alias.entityType === entityType && alias.targetId === targetId && alias.validTo === null
  )
  return open?.code ?? null
}

/** 曾用编号列表（已关闭的别名，按失效时间倒序） */
export function previousCodesOf(
  aliases: CodeAlias[],
  entityType: RenumberEntityType,
  targetId: string
): string[] {
  return aliases
    .filter((alias) => alias.entityType === entityType && alias.targetId === targetId && alias.validTo !== null)
    .sort((a, b) => (b.validTo ?? 0) - (a.validTo ?? 0))
    .map((alias) => alias.code)
}

/**
 * 按编号反查实体（兼容读取）：拿着旧铭牌编号也能定位当前记录。
 * 优先命中仍在册的别名，其次取最近失效的；叶片需带 parentId 限定机组。
 */
export function resolveByCode(
  aliases: CodeAlias[],
  entityType: RenumberEntityType,
  code: string,
  parentId: string | null = null
): string | null {
  const trimmed = code.trim()
  if (!trimmed) return null
  const rows = aliases.filter((alias) => {
    if (alias.entityType !== entityType || alias.code !== trimmed) return false
    if (entityType === 'blade' && parentId !== null) return alias.parentId === parentId
    return true
  })
  const open = rows.find((alias) => alias.validTo === null)
  if (open) return open.targetId
  const closed = rows
    .filter((alias) => alias.validTo !== null)
    .sort((a, b) => (b.validTo ?? 0) - (a.validTo ?? 0))
  return closed[0]?.targetId ?? null
}
