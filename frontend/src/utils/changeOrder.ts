import { db } from '@/utils/db'
import type { Turbine } from '@/types/turbine'
import type { Blade } from '@/types/blade'
import type { Segment } from '@/types/segment'
import type { Defect } from '@/types/defect'
import type { WorkOrder } from '@/types/workOrder'
import {
  initialAliasId,
  mappingKeyOf,
  orderAliasId,
  type ChangeOrder,
  type ChangeOrderIssue,
  type ChangeOrderSnapshot,
  type CodeAlias,
  type RenumberEntityType,
  type RenumberMapping
} from '@/types/changeOrder'

/** 校验 / 冻结 / 应用共用的全量数据视图 */
export interface RenumberContext {
  turbines: Turbine[]
  blades: Blade[]
  segments: Segment[]
  defects: Defect[]
  workOrders: WorkOrder[]
  aliases: CodeAlias[]
}

/** 从 IndexedDB 读出全量关联数据（冻结与应用前都重新读取，避免基于过期状态判断） */
export async function loadRenumberContext(): Promise<RenumberContext> {
  const [turbines, blades, segments, defects, workOrders, aliases] = await Promise.all([
    db.turbines.toArray(),
    db.blades.toArray(),
    db.segments.toArray(),
    db.defects.toArray(),
    db.workOrders.toArray(),
    db.codeAliases.toArray()
  ])
  return { turbines, blades, segments, defects, workOrders, aliases }
}

/** 映射是否已被本变更单应用过（在册编号已等于新编号且本单的新编号别名已在册） */
function isMappingApplied(mapping: RenumberMapping, ctx: RenumberContext, orderId: string): boolean {
  const entity =
    mapping.entityType === 'turbine'
      ? ctx.turbines.find((turbine) => turbine.id === mapping.targetId)
      : ctx.blades.find((blade) => blade.id === mapping.targetId)
  if (!entity) return false
  const currentCode = mapping.entityType === 'turbine' ? (entity as Turbine).code : (entity as Blade).serial
  if (currentCode !== mapping.newCode) return false
  return ctx.aliases.some(
    (alias) =>
      alias.targetId === mapping.targetId &&
      alias.code === mapping.newCode &&
      alias.validTo === null &&
      alias.orderId === orderId
  )
}

/**
 * 校验改号映射：撞车（与他人历史 / 在册编号冲突、单内重复）、引用漏项（目标不存在、
 * 旧编号与在册不符）、空编号等。已被本单应用过的映射自动跳过（断点续跑时不会因
 * 「旧编号不符」误伤自己）。返回空数组表示通过。
 */
export function validateMappings(
  mappings: RenumberMapping[],
  ctx: RenumberContext,
  orderId: string
): ChangeOrderIssue[] {
  const issues: ChangeOrderIssue[] = []
  if (mappings.length === 0) {
    issues.push({ mappingKey: '', message: '变更单至少需要一条改号映射' })
    return issues
  }

  const seenKeys = new Set<string>()
  const seenNewCodes = new Map<string, RenumberMapping>()

  for (const mapping of mappings) {
    const key = mapping.key
    const label = mapping.entityType === 'turbine' ? '机组' : '叶片'
    const newCode = mapping.newCode.trim()

    if (seenKeys.has(key)) {
      issues.push({ mappingKey: key, message: `映射重复：同一${label}出现多条改号记录` })
      continue
    }
    seenKeys.add(key)

    const entity =
      mapping.entityType === 'turbine'
        ? ctx.turbines.find((turbine) => turbine.id === mapping.targetId)
        : ctx.blades.find((blade) => blade.id === mapping.targetId)
    if (!entity) {
      // 引用漏项：映射指向的记录已不存在
      issues.push({ mappingKey: key, message: `引用漏项：${label}记录（${mapping.oldCode}）已不存在` })
      continue
    }
    if (mapping.entityType === 'blade' && (entity as Blade).turbineId !== mapping.parentId) {
      issues.push({ mappingKey: key, message: `引用漏项：叶片 ${mapping.oldCode} 不属于指定机组` })
      continue
    }
    if (newCode.length === 0) {
      issues.push({ mappingKey: key, message: `${label} ${mapping.oldCode} 的新编号不能为空` })
      continue
    }

    // 断点续跑：已被本单应用的映射不再参与撞车 / 旧编号校验
    if (isMappingApplied(mapping, ctx, orderId)) continue

    const currentCode =
      mapping.entityType === 'turbine' ? (entity as Turbine).code : (entity as Blade).serial
    if (currentCode !== mapping.oldCode) {
      issues.push({
        mappingKey: key,
        message: `引用漏项：${label}在册编号为 ${currentCode}，与映射旧编号 ${mapping.oldCode} 不符`
      })
      continue
    }
    if (newCode === mapping.oldCode) {
      issues.push({ mappingKey: key, message: `${label}新编号与旧编号相同（${newCode}），无需改号` })
      continue
    }

    // 撞车：新编号与他人任意时期的别名（在册或历史）冲突
    const aliasHit = ctx.aliases.find((alias) => {
      if (alias.entityType !== mapping.entityType) return false
      if (alias.code !== newCode) return false
      if (alias.targetId === mapping.targetId) return false
      if (mapping.entityType === 'blade') return alias.parentId === mapping.parentId
      return true
    })
    if (aliasHit) {
      issues.push({
        mappingKey: key,
        message: `新编号撞车：${newCode} 已被其他${label}使用（${aliasHit.validTo === null ? '在册' : '历史'}编号）`
      })
      continue
    }

    // 撞车：新编号等于其他实体的在册编号（兜底，覆盖别名缺失的极端情况）
    const codeTaken =
      mapping.entityType === 'turbine'
        ? ctx.turbines.some((turbine) => turbine.id !== mapping.targetId && turbine.code === newCode)
        : ctx.blades.some(
            (blade) =>
              blade.id !== mapping.targetId &&
              blade.turbineId === mapping.parentId &&
              blade.serial === newCode
          )
    if (codeTaken) {
      issues.push({ mappingKey: key, message: `新编号撞车：${newCode} 与其他${label}在册编号重复` })
      continue
    }

    // 撞车：同一变更单内两条映射改到同一个新编号
    const dupScope = `${mapping.entityType}:${mapping.parentId ?? ''}:${newCode}`
    const dup = seenNewCodes.get(dupScope)
    if (dup) {
      issues.push({
        mappingKey: key,
        message: `新编号撞车：${newCode} 在本变更单内被 ${dup.oldCode} 与 ${mapping.oldCode} 同时使用`
      })
      continue
    }
    seenNewCodes.set(dupScope, mapping)
  }
  return issues
}

/** 计算受影响记录：机组映射牵连整棵子树，叶片映射牵连该叶片子树 */
export function computeAffected(
  mappings: RenumberMapping[],
  ctx: RenumberContext
): Omit<ChangeOrderSnapshot, 'frozenAt'> {
  const turbineIds = new Set<string>()
  const bladeIds = new Set<string>()

  for (const mapping of mappings) {
    if (mapping.entityType === 'turbine') {
      turbineIds.add(mapping.targetId)
      ctx.blades
        .filter((blade) => blade.turbineId === mapping.targetId)
        .forEach((blade) => bladeIds.add(blade.id))
    } else {
      bladeIds.add(mapping.targetId)
    }
  }

  const segmentIds = new Set(
    ctx.segments.filter((segment) => bladeIds.has(segment.bladeId)).map((segment) => segment.id)
  )
  const defectIds = new Set(
    ctx.defects.filter((defect) => segmentIds.has(defect.segmentId)).map((defect) => defect.id)
  )
  const workOrderIds = new Set(
    ctx.workOrders.filter((order) => defectIds.has(order.defectId)).map((order) => order.id)
  )

  return {
    turbineIds: Array.from(turbineIds),
    bladeIds: Array.from(bladeIds),
    segmentIds: Array.from(segmentIds),
    defectIds: Array.from(defectIds),
    workOrderIds: Array.from(workOrderIds)
  }
}

export interface ChangeOrderResult {
  ok: boolean
  /** 重复提交：变更单此前已生效，本次未做任何写入 */
  already?: boolean
  issues: ChangeOrderIssue[]
}

function now(): number {
  return Date.now()
}

/**
 * 冻结变更单：校验通过后锁定机组 / 叶片 / 分段 / 缺陷 / 工单的关联快照，
 * 供确认前列出新旧编号与受影响记录。校验不通过则停留在草稿并回写问题列表。
 * 幂等：已冻结的变更单重复冻结直接返回成功。
 */
export async function freezeChangeOrder(orderId: string): Promise<ChangeOrderResult> {
  const order = await db.changeOrders.get(orderId)
  if (!order) return { ok: false, issues: [{ mappingKey: '', message: '变更单不存在' }] }
  if (order.state === 'frozen') return { ok: true, issues: [] }
  if (order.state !== 'draft') {
    return { ok: false, issues: [{ mappingKey: '', message: '当前状态不允许冻结' }] }
  }

  const ctx = await loadRenumberContext()
  const issues = validateMappings(order.mappings, ctx, order.id)
  if (issues.length > 0) {
    await db.changeOrders.update(orderId, { issues, updatedAt: now() })
    return { ok: false, issues }
  }

  const snapshot: ChangeOrderSnapshot = { frozenAt: now(), ...computeAffected(order.mappings, ctx) }
  await db.changeOrders.update(orderId, {
    state: 'frozen',
    snapshot,
    issues: [],
    frozenAt: snapshot.frozenAt,
    progress: { appliedKeys: [], total: order.mappings.length },
    updatedAt: now()
  })
  return { ok: true, issues: [] }
}

/** 确认 / 应用过程的并发锁：同一变更单同时只允许一个应用流程 */
const applyingLocks = new Set<string>()

/** 测试 / 续跑钩子：每完成一条映射回调，可在此抛错模拟写入中断 */
export interface ApplyHooks {
  onMappingApplied?: (mappingKey: string) => void
}

/** 单条映射落库（在事务内调用）：关闭旧编号别名 → 登记新编号别名 → 改在册编号 → 登记进度 */
async function applyMappingInTx(order: ChangeOrder, mapping: RenumberMapping, effectiveAt: number): Promise<void> {
  const table = mapping.entityType === 'turbine' ? db.turbines : db.blades
  const entity = (await table.get(mapping.targetId)) as Turbine | Blade | undefined
  if (!entity) {
    throw new Error(`引用漏项：映射 ${mapping.oldCode} → ${mapping.newCode} 的目标记录已不存在，应用中止`)
  }

  const openAliases = await db.codeAliases
    .where('targetId')
    .equals(mapping.targetId)
    .filter((alias) => alias.validTo === null)
    .toArray()

  // 旧编号作为别名保留：关闭仍在册且不等于新编号的别名区间
  for (const alias of openAliases) {
    if (alias.code !== mapping.newCode) {
      await db.codeAliases.update(alias.id, { validTo: effectiveAt, updatedAt: now() })
    }
  }

  // 登记新编号别名：确定性 id，同一变更单重复应用只会覆盖不会新增
  const alreadyOpen = openAliases.some((alias) => alias.code === mapping.newCode)
  if (!alreadyOpen) {
    await db.codeAliases.put({
      id: orderAliasId(order.id, mapping.targetId),
      entityType: mapping.entityType,
      targetId: mapping.targetId,
      parentId: mapping.parentId,
      code: mapping.newCode,
      validFrom: effectiveAt,
      validTo: null,
      orderId: order.id,
      createdAt: now(),
      updatedAt: now()
    })
  }

  // 新编号生效
  const patch =
    mapping.entityType === 'turbine' ? { code: mapping.newCode } : { serial: mapping.newCode as Blade['serial'] }
  await table.update(mapping.targetId, { ...patch, updatedAt: now() })

  // 登记进度：同事务写入，中断后按 appliedKeys 续跑
  const latest = await db.changeOrders.get(order.id)
  const appliedKeys = latest?.progress.appliedKeys ?? []
  if (!appliedKeys.includes(mapping.key)) {
    await db.changeOrders.update(order.id, {
      progress: { appliedKeys: [...appliedKeys, mapping.key], total: order.mappings.length },
      updatedAt: now()
    })
  }
}

/**
 * 确认变更单：重新校验（撞车 / 引用漏项则不提交），通过后逐映射应用。
 * - 每条映射一个事务并登记进度，写入中断后再次调用即从断点继续；
 * - 幂等：已生效的变更单重复提交直接返回 already，不会多出别名或叶片；
 * - effectiveAt 在首次确认时固定，重试 / 续跑复用，保证按时间解析稳定。
 */
export async function confirmChangeOrder(orderId: string, hooks?: ApplyHooks): Promise<ChangeOrderResult> {
  if (applyingLocks.has(orderId)) {
    return { ok: false, issues: [{ mappingKey: '', message: '该变更单正在应用中，请勿重复提交' }] }
  }
  applyingLocks.add(orderId)
  try {
    const order = await db.changeOrders.get(orderId)
    if (!order) return { ok: false, issues: [{ mappingKey: '', message: '变更单不存在' }] }
    if (order.state === 'applied') return { ok: true, already: true, issues: [] }
    if (order.state !== 'frozen' && order.state !== 'applying') {
      return { ok: false, issues: [{ mappingKey: '', message: '只有已冻结的变更单才能确认生效' }] }
    }

    // 提交前基于最新数据重新校验：撞车或引用漏项则不提交
    const ctx = await loadRenumberContext()
    const issues = validateMappings(order.mappings, ctx, order.id)
    if (issues.length > 0) {
      await db.changeOrders.update(orderId, { issues, updatedAt: now() })
      return { ok: false, issues }
    }

    const effectiveAt = order.effectiveAt ?? now()
    if (order.state !== 'applying' || order.effectiveAt === null) {
      await db.changeOrders.update(orderId, {
        state: 'applying',
        confirmedAt: order.confirmedAt ?? now(),
        effectiveAt,
        issues: [],
        updatedAt: now()
      })
    }

    try {
      for (const mapping of order.mappings) {
        const latest = await db.changeOrders.get(orderId)
        if (latest?.progress.appliedKeys.includes(mapping.key)) continue
        await db.transaction('rw', [db.turbines, db.blades, db.codeAliases, db.changeOrders], async () => {
          await applyMappingInTx(order, mapping, effectiveAt)
        })
        hooks?.onMappingApplied?.(mapping.key)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '应用变更单失败'
      await db.changeOrders.update(orderId, {
        issues: [{ mappingKey: '', message }],
        updatedAt: now()
      })
      return { ok: false, issues: [{ mappingKey: '', message }] }
    }

    await db.changeOrders.update(orderId, { state: 'applied', appliedAt: now(), updatedAt: now() })
    return { ok: true, issues: [] }
  } finally {
    applyingLocks.delete(orderId)
  }
}

/** 取消变更单：仅草稿 / 已冻结可取消；已取消不触碰任何业务数据 */
export async function cancelChangeOrder(orderId: string): Promise<boolean> {
  const order = await db.changeOrders.get(orderId)
  if (!order || (order.state !== 'draft' && order.state !== 'frozen')) return false
  await db.changeOrders.update(orderId, { state: 'cancelled', updatedAt: now() })
  return true
}

/**
 * 续跑中断的变更单：找出所有「应用中」的变更单，从各自已登记的进度继续。
 * 页面加载时调用，返回成功续跑到生效的变更单 id。
 */
export async function resumeInterruptedOrders(hooks?: ApplyHooks): Promise<string[]> {
  const interrupted = await db.changeOrders.where('state').equals('applying').toArray()
  const resumed: string[] = []
  for (const order of interrupted) {
    const result = await confirmChangeOrder(order.id, hooks)
    if (result.ok) resumed.push(order.id)
  }
  return resumed
}

/** 登记初始别名（新建机组 / 叶片时调用；确定性 id，重复调用互相覆盖） */
export async function registerInitialAlias(
  entityType: RenumberEntityType,
  targetId: string,
  parentId: string | null,
  code: string,
  validFrom: number
): Promise<void> {
  await db.codeAliases.put({
    id: initialAliasId(targetId),
    entityType,
    targetId,
    parentId,
    code,
    validFrom,
    validTo: null,
    orderId: '',
    createdAt: now(),
    updatedAt: now()
  })
}

/** 级联清理别名：机组 / 叶片删除时同步移除其编号历史 */
export async function removeAliasesFor(targetIds: string[]): Promise<void> {
  if (targetIds.length === 0) return
  await db.codeAliases.where('targetId').anyOf(targetIds).delete()
}

/** 构造映射对象（页面收集录入后统一补齐 key 与 parentId） */
export function buildMapping(
  entityType: RenumberEntityType,
  targetId: string,
  parentId: string | null,
  oldCode: string,
  newCode: string
): RenumberMapping {
  return {
    key: mappingKeyOf(entityType, targetId),
    entityType,
    targetId,
    parentId,
    oldCode,
    newCode: newCode.trim()
  }
}
