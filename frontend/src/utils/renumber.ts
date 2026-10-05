import { createId, dateFromTs, db } from '@/utils/db'
import type { Blade } from '@/types/blade'
import type { Defect } from '@/types/defect'
import type { Segment } from '@/types/segment'
import type { Turbine } from '@/types/turbine'
import type { WorkOrder } from '@/types/workOrder'
import type {
  AffectedRecord,
  CreateRenumberOrderInput,
  FrozenSnapshot,
  RenumberItem,
  RenumberOrder,
  RenumberValidation
} from '@/types/renumber'

/**
 * 资产变更单服务：冻结关联 → 校验（撞车 / 引用漏项）→ 逐项幂等确认。
 * 纯函数 + Dexie 读写，不放响应式状态；状态由 stores/renumberStore.ts 维护。
 */

const emptyAffected = (): AffectedRecord => ({ blades: [], segments: [], defects: [], workOrders: [] })

/** 当日 YYYY-MM-DD */
function today(): string {
  return dateFromTs(Date.now())
}

/** 受影响记录在冻结快照中的键：资产类型 + 资产 id（天然稳定，不依赖行 id） */
function affectedKey(assetType: 'turbine' | 'blade', assetId: string): string {
  return `${assetType}:${assetId}`
}

interface ChainRows {
  blades: Blade[]
  segments: Segment[]
  defects: Defect[]
  workOrders: WorkOrder[]
}

function collectDownstream(bladeIds: string[], rows: ChainRows, affected: AffectedRecord): void {
  const bladeSet = new Set(bladeIds)
  rows.segments
    .filter((segment) => bladeSet.has(segment.bladeId))
    .forEach((segment) => affected.segments.push(segment.id))
  const segmentSet = new Set(affected.segments)
  rows.defects
    .filter((defect) => segmentSet.has(defect.segmentId))
    .forEach((defect) => affected.defects.push(defect.id))
  const defectSet = new Set(affected.defects)
  rows.workOrders
    .filter((order) => defectSet.has(order.defectId))
    .forEach((order) => affected.workOrders.push(order.id))
}

/** 计算一台机组受影响的叶片 / 分段 / 缺陷 / 工单 */
export function affectedOfTurbine(turbineId: string, rows: ChainRows): AffectedRecord {
  const bladeIds = rows.blades.filter((blade) => blade.turbineId === turbineId).map((blade) => blade.id)
  const affected: AffectedRecord = { ...emptyAffected(), blades: bladeIds }
  collectDownstream(bladeIds, rows, affected)
  return affected
}

/** 计算一片叶片受影响的分段 / 缺陷 / 工单 */
export function affectedOfBlade(
  bladeId: string,
  rows: Pick<ChainRows, 'segments' | 'defects' | 'workOrders'>
): AffectedRecord {
  const affected: AffectedRecord = { ...emptyAffected(), blades: [bladeId] }
  collectDownstream([bladeId], { blades: [], segments: rows.segments, defects: rows.defects, workOrders: rows.workOrders }, affected)
  return affected
}

/**
 * 冻结机组 → 叶片 → 分段 → 缺陷 → 工单的关联链，
 * 并按改号资产登记受影响记录 id 与全库计数，供确认前复核。
 */
export async function buildSnapshot(changes: CreateRenumberOrderInput['changes']): Promise<FrozenSnapshot> {
  const rows: ChainRows = {
    blades: await db.blades.toArray(),
    segments: await db.segments.toArray(),
    defects: await db.defects.toArray(),
    workOrders: await db.workOrders.toArray()
  }
  const turbines: Turbine[] = await db.turbines.toArray()

  const turbineCodes: FrozenSnapshot['turbineCodes'] = {}
  const bladeOwners: FrozenSnapshot['bladeOwners'] = {}
  const segmentBlades: FrozenSnapshot['segmentBlades'] = {}
  const defectSegments: FrozenSnapshot['defectSegments'] = {}
  const workOrderDefects: FrozenSnapshot['workOrderDefects'] = {}

  turbines.forEach((turbine) => {
    turbineCodes[turbine.id] = turbine.code
  })
  rows.blades.forEach((blade) => {
    bladeOwners[blade.id] = { turbineId: blade.turbineId, serial: blade.serial }
  })
  rows.segments.forEach((segment) => {
    segmentBlades[segment.id] = segment.bladeId
  })
  rows.defects.forEach((defect) => {
    defectSegments[defect.id] = defect.segmentId
  })
  rows.workOrders.forEach((order) => {
    workOrderDefects[order.id] = order.defectId
  })

  const affectedByItem: FrozenSnapshot['affectedByItem'] = {}
  changes.forEach((change) => {
    affectedByItem[affectedKey(change.assetType, change.assetId)] =
      change.assetType === 'turbine'
        ? affectedOfTurbine(change.assetId, rows)
        : affectedOfBlade(change.assetId, rows)
  })

  return {
    frozenAt: Date.now(),
    turbineCodes,
    bladeOwners,
    segmentBlades,
    defectSegments,
    workOrderDefects,
    affectedByItem,
    totals: {
      turbines: turbines.length,
      blades: rows.blades.length,
      segments: rows.segments.length,
      defects: rows.defects.length,
      workOrders: rows.workOrders.length
    }
  }
}

const TOTALS_LABEL: Record<keyof FrozenSnapshot['totals'], string> = {
  turbines: '机组',
  blades: '叶片',
  segments: '分段',
  defects: '缺陷',
  workOrders: '工单'
}

const KIND_LABEL: Record<keyof AffectedRecord, string> = {
  blades: '叶片',
  segments: '分段',
  defects: '缺陷',
  workOrders: '工单'
}

/**
 * 确认前校验（冻结后 / 续跑前都会重新执行）：
 * 1. 新编号非空、与旧编号不同、资产仍存在；
 * 2. 不撞车——单内重复、或与未参与本单的当前编号重复（机组全库唯一、叶片机组内唯一）；
 * 3. 引用不漏项——冻结后关联链与计数未发生变化、受影响记录无丢失。
 * warnings 不阻断（如与历史别名重号）。
 */
export async function validateOrder(order: RenumberOrder): Promise<RenumberValidation> {
  const errors: string[] = []
  const warnings: string[] = []
  const checkedAt = Date.now()

  const rows: ChainRows = {
    blades: await db.blades.toArray(),
    segments: await db.segments.toArray(),
    defects: await db.defects.toArray(),
    workOrders: await db.workOrders.toArray()
  }
  const turbines = await db.turbines.toArray()
  const histories = await db.codeHistories.toArray()

  const items = order.items
  const turbineItemIds = new Set(
    items.filter((item) => item.assetType === 'turbine').map((item) => item.assetId)
  )
  const bladeItemIds = new Set(items.filter((item) => item.assetType === 'blade').map((item) => item.assetId))

  /* ---------- 1. 行级合法性 ---------- */
  items.forEach((item) => {
    const code = item.newCode.trim()
    const typeLabel = item.assetType === 'turbine' ? '机组' : '叶片'
    if (!code) {
      errors.push(`${typeLabel}「${item.oldCode}」的新编号不能为空`)
      return
    }
    if (code === item.oldCode && !item.applied) {
      errors.push(`${typeLabel}「${item.oldCode}」新编号与旧编号相同，无需改号`)
    }
    if (item.assetType === 'turbine') {
      if (!turbines.some((turbine) => turbine.id === item.assetId)) {
        errors.push(`机组「${item.oldCode}」已不存在（冻结后被删除），引用漏项`)
      }
    } else if (!rows.blades.some((blade) => blade.id === item.assetId)) {
      errors.push(`叶片「${item.oldCode}」已不存在（冻结后被删除），引用漏项`)
    }
  })

  /* ---------- 2. 撞车：新编号单内相互重复 ---------- */
  const seenTurbine = new Map<string, string>()
  const seenBlade = new Map<string, string>()
  items.forEach((item) => {
    const code = item.newCode.trim()
    if (!code) return
    if (item.assetType === 'turbine') {
      const prev = seenTurbine.get(code)
      if (prev) errors.push(`机组新编号「${code}」在单内撞车：${prev} 与 ${item.oldCode} 都改为该编号`)
      else seenTurbine.set(code, item.oldCode)
    } else {
      const key = `${item.turbineId}::${code}`
      const prev = seenBlade.get(key)
      if (prev) errors.push(`叶片新编号「${code}」在同一机组内撞车：${prev} 与 ${item.oldCode} 都改为该编号`)
      else seenBlade.set(key, item.oldCode)
    }
  })

  /* ---------- 3. 撞车：与未参与本单的当前编号重复 ----------
   * 已生效项（中断续跑）的新编号已是资产当前编号，属于本单自身结果，不算撞车。 */
  const pendingItems = items.filter((item) => !item.applied)
  turbines.forEach((turbine) => {
    if (turbineItemIds.has(turbine.id)) return
    const conflict = pendingItems.find(
      (item) => item.assetType === 'turbine' && item.newCode.trim() === turbine.code
    )
    if (conflict) errors.push(`机组新编号「${turbine.code}」与未在单内的现有机组撞车`)
  })
  rows.blades.forEach((blade) => {
    if (bladeItemIds.has(blade.id)) return
    const conflict = pendingItems.find(
      (item) =>
        item.assetType === 'blade' &&
        item.turbineId === blade.turbineId &&
        item.newCode.trim() === blade.serial
    )
    if (conflict) errors.push(`叶片新编号「${blade.serial}」与同机组未在单内的现有叶片撞车`)
  })

  /* ---------- 4. 与历史别名重号：提醒但不阻断 ---------- */
  items.forEach((item) => {
    const code = item.newCode.trim()
    const reused = histories.some(
      (row) =>
        row.assetType === item.assetType &&
        row.assetId === item.assetId &&
        row.code === code &&
        row.effectiveTo !== null
    )
    if (reused) {
      warnings.push(`新编号「${code}」曾是「${item.oldCode}」的历史旧编号，将复用该别名`)
    }
  })

  /* ---------- 5. 引用漏项：冻结后全库计数与关联链复核 ---------- */
  const totals = order.snapshot.totals
  const currentTotals: FrozenSnapshot['totals'] = {
    turbines: turbines.length,
    blades: rows.blades.length,
    segments: rows.segments.length,
    defects: rows.defects.length,
    workOrders: rows.workOrders.length
  }
  ;(Object.keys(totals) as Array<keyof FrozenSnapshot['totals']>).forEach((key) => {
    if (totals[key] !== currentTotals[key]) {
      errors.push(
        `冻结后「${TOTALS_LABEL[key]}」数量发生变化（冻结 ${totals[key]} → 现在 ${currentTotals[key]}），关联已变动，引用漏项`
      )
    }
  })

  const segmentBladeNow = new Map(rows.segments.map((segment) => [segment.id, segment.bladeId]))
  const defectSegmentNow = new Map(rows.defects.map((defect) => [defect.id, defect.segmentId]))
  const workOrderDefectNow = new Map(rows.workOrders.map((order) => [order.id, order.defectId]))

  items.forEach((item) => {
    const typeLabel = item.assetType === 'turbine' ? '机组' : '叶片'
    const frozen = order.snapshot.affectedByItem[affectedKey(item.assetType, item.assetId)]
    if (!frozen) {
      errors.push(`${typeLabel}「${item.oldCode}」缺少冻结记录，无法核对受影响记录`)
      return
    }
    if (item.assetType === 'blade') {
      const blade = rows.blades.find((b) => b.id === item.assetId)
      const frozenOwner = order.snapshot.bladeOwners[item.assetId]
      if (blade && frozenOwner) {
        if (blade.turbineId !== frozenOwner.turbineId) {
          errors.push(`叶片「${item.oldCode}」在冻结后归属机组已变化，引用漏项`)
        }
        if (item.applied) {
          // 已生效项（可能来自中断续跑）：当前编号必须正是新编号
          if (blade.serial !== item.newCode.trim()) {
            errors.push(`叶片「${item.oldCode}」已标记生效，但当前编号不是新编号「${item.newCode}」，状态不一致`)
          }
        } else if (blade.serial !== frozenOwner.serial) {
          errors.push(`叶片「${item.oldCode}」在冻结后序号已被其他操作改动，引用漏项`)
        }
      }
    } else {
      const turbine = turbines.find((t) => t.id === item.assetId)
      if (turbine) {
        if (item.applied) {
          if (turbine.code !== item.newCode.trim()) {
            errors.push(`机组「${item.oldCode}」已标记生效，但当前编号不是新编号「${item.newCode}」，状态不一致`)
          }
        } else if (order.snapshot.turbineCodes[item.assetId] !== turbine.code) {
          errors.push(`机组「${item.oldCode}」在冻结后编号已被其他操作改动，引用漏项`)
        }
      }
    }

    frozen.segments.forEach((id) => {
      if (!segmentBladeNow.has(id)) errors.push(`「${item.oldCode}」受影响分段 ${id} 已丢失（冻结后被删除），引用漏项`)
    })
    frozen.defects.forEach((id) => {
      if (!defectSegmentNow.has(id)) errors.push(`「${item.oldCode}」受影响缺陷 ${id} 已丢失（冻结后被删除），引用漏项`)
    })
    frozen.workOrders.forEach((id) => {
      if (!workOrderDefectNow.has(id)) errors.push(`「${item.oldCode}」受影响工单 ${id} 已丢失（冻结后被删除），引用漏项`)
    })

    const recomputed =
      item.assetType === 'turbine'
        ? affectedOfTurbine(item.assetId, rows)
        : affectedOfBlade(item.assetId, rows)
    ;(['blades', 'segments', 'defects', 'workOrders'] as const).forEach((kind) => {
      const a = new Set(frozen[kind])
      const b = new Set(recomputed[kind])
      if (a.size !== b.size || [...a].some((id) => !b.has(id))) {
        errors.push(
          `「${item.oldCode}」受影响${KIND_LABEL[kind]}与冻结时不一致（冻结 ${a.size} → 现在 ${b.size}），引用漏项`
        )
      }
    })
  })

  return { ok: errors.length === 0, errors, warnings, checkedAt }
}

/** 生成单号：ACC-YYYYMMDD-序号（当日已有单数 + 1） */
export async function nextOrderCode(now = new Date()): Promise<string> {
  const day = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
    now.getDate()
  ).padStart(2, '0')}`
  const prefix = `ACC-${day}-`
  const sameDay = await db.renumberOrders.where('code').startsWith(prefix).toArray()
  return `${prefix}${String(sameDay.length + 1).padStart(3, '0')}`
}

/** 同一资产不允许出现在两张未确认单里（否则冻结关联会互相覆盖） */
export async function findBlockingOrder(
  changes: CreateRenumberOrderInput['changes']
): Promise<RenumberOrder | null> {
  const open = await db.renumberOrders.where('status').anyOf(['draft', 'confirming']).toArray()
  const wanted = new Set(changes.map((change) => affectedKey(change.assetType, change.assetId)))
  return open.find((order) => order.items.some((item) => wanted.has(affectedKey(item.assetType, item.assetId)))) ?? null
}

/** 组装变更单：冻结关联并生成新旧编号对照行（此时状态为草稿） */
export async function createRenumberOrder(input: CreateRenumberOrderInput): Promise<RenumberOrder> {
  const changes = input.changes
    .map((change) => ({ assetType: change.assetType, assetId: change.assetId, newCode: change.newCode.trim() }))
    .filter((change) => change.newCode.length > 0)
  if (changes.length === 0) throw new Error('请至少填写一条改号记录')

  const snapshot = await buildSnapshot(changes)
  const [turbines, blades] = await Promise.all([db.turbines.toArray(), db.blades.toArray()])
  const turbineMap = new Map(turbines.map((turbine) => [turbine.id, turbine]))
  const bladeMap = new Map(blades.map((blade) => [blade.id, blade]))

  const items: RenumberItem[] = changes.map((change) => {
    if (change.assetType === 'turbine') {
      const turbine = turbineMap.get(change.assetId)
      return {
        itemId: createId('rit'),
        assetType: 'turbine',
        assetId: change.assetId,
        turbineId: change.assetId,
        bladeSerial: '',
        oldCode: turbine?.code ?? '',
        newCode: change.newCode,
        applied: false,
        appliedAt: null
      }
    }
    const blade = bladeMap.get(change.assetId)
    return {
      itemId: createId('rit'),
      assetType: 'blade',
      assetId: change.assetId,
      turbineId: blade?.turbineId ?? '',
      bladeSerial: blade?.serial ?? '',
      oldCode: blade?.serial ?? '',
      newCode: change.newCode,
      applied: false,
      appliedAt: null
    }
  })

  const now = Date.now()
  const order: RenumberOrder = {
    id: createId('acc'),
    code: await nextOrderCode(),
    title: input.title.trim() || '风电场增容资产改号',
    reason: input.reason.trim(),
    status: 'draft',
    items,
    snapshot,
    frozenErrors: [],
    validation: null,
    createdAt: now,
    updatedAt: now,
    effectiveDate: null,
    confirmedAt: null
  }
  await db.renumberOrders.add(order)
  return order
}

/**
 * 确认变更单：逐项执行、逐项落进度。
 * - 每项一个 rw 事务（更新当前编号 + 关闭旧时间段 + 开新时间段 + 回写 applied），
 *   写入中断后再次调用会跳过 applied=true 的项，从确认进度继续；
 * - 每个 applied 都在事务内按资产当前编号二次校验，重复提交不会新建任何叶片 / 时间段；
 * - 全部完成后置 confirmed；中途失败保持 confirming 并抛出，供界面提示续跑。
 */
export async function confirmRenumberOrder(orderId: string): Promise<RenumberOrder> {
  const order = await db.renumberOrders.get(orderId)
  if (!order) throw new Error('变更单不存在或已被删除')
  if (order.status === 'confirmed' && order.items.every((item) => item.applied)) return order

  // 确认前重新校验：撞车或引用漏项则不提交
  const validation = await validateOrder(order)
  if (!validation.ok) {
    await db.renumberOrders.update(orderId, { validation, updatedAt: Date.now() })
    throw new RenumberValidationError(validation)
  }

  const effectiveDate = today()
  await db.renumberOrders.update(orderId, {
    status: 'confirming',
    validation,
    effectiveDate,
    updatedAt: Date.now()
  })

  for (const item of order.items) {
    if (item.applied) continue
    await applyItem(orderId, item.itemId, effectiveDate)
  }

  const finishedAt = Date.now()
  await db.renumberOrders.update(orderId, {
    status: 'confirmed',
    confirmedAt: finishedAt,
    effectiveDate,
    updatedAt: finishedAt
  })
  const finished = await db.renumberOrders.get(orderId)
  if (!finished) throw new Error('变更单确认完成后读取失败')
  return finished
}

/** 单个改号项生效（独立事务，可安全重放，不会多出叶片 / 时间段） */
async function applyItem(orderId: string, itemId: string, effectiveDate: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.turbines, db.blades, db.codeHistories, db.renumberOrders],
    async () => {
      const latest = await db.renumberOrders.get(orderId)
      const liveItem = latest?.items.find((row) => row.itemId === itemId)
      if (!latest || !liveItem) throw new Error(`改号项 ${itemId} 在确认过程中丢失`)
      if (liveItem.applied) return // 进度已写入：并发 / 重放直接跳过，不多写数据

      const newCode = liveItem.newCode.trim()
      if (liveItem.assetType === 'turbine') {
        const turbine = await db.turbines.get(liveItem.assetId)
        if (!turbine) throw new Error(`机组「${liveItem.oldCode}」不存在，引用漏项`)
        if (turbine.code !== newCode) {
          await db.turbines.update(turbine.id, { code: newCode, updatedAt: Date.now() })
        }
      } else {
        const blade = await db.blades.get(liveItem.assetId)
        if (!blade) throw new Error(`叶片「${liveItem.oldCode}」不存在，引用漏项`)
        if (blade.serial !== newCode) {
          await db.blades.update(blade.id, { serial: newCode as Blade['serial'], updatedAt: Date.now() })
        }
      }

      // 编号时间线：关闭当前段（endDate=生效日），再开新段；当前编号已为新值时幂等跳过
      const openSegment = await db.codeHistories
        .where('assetId')
        .equals(liveItem.assetId)
        .filter((row) => row.assetType === liveItem.assetType && row.effectiveTo === null)
        .first()
      if (!openSegment) throw new Error(`资产「${liveItem.oldCode}」缺少当前编号时间段，无法改号`)
      if (openSegment.code !== newCode) {
        await db.codeHistories.update(openSegment.id, { effectiveTo: effectiveDate })
        await db.codeHistories.add({
          id: createId('ch'),
          assetType: liveItem.assetType,
          assetId: liveItem.assetId,
          code: newCode,
          effectiveFrom: effectiveDate,
          effectiveTo: null,
          sourceOrderId: orderId,
          createdAt: Date.now()
        })
      }

      // 回写进度（同一事务内）：中断后从下一个 applied=false 的项继续
      const updatedItems = latest.items.map((row) =>
        row.itemId === liveItem.itemId ? { ...row, newCode, applied: true, appliedAt: Date.now() } : row
      )
      await db.renumberOrders.update(orderId, { items: updatedItems, updatedAt: Date.now() })
    }
  )
}

/** 校验不通过错误：界面直接展示 errors / warnings */
export class RenumberValidationError extends Error {
  validation: RenumberValidation

  constructor(validation: RenumberValidation) {
    super(`资产变更单校验失败：${validation.errors.join('；')}`)
    this.name = 'RenumberValidationError'
    this.validation = validation
  }
}

/** 草稿调整新编号（未确认前可改）；改后清空旧校验结果，需重新校验 */
export async function updateDraftItems(
  orderId: string,
  updates: Array<{ itemId: string; newCode: string }>
): Promise<void> {
  const order = await db.renumberOrders.get(orderId)
  if (!order) throw new Error('变更单不存在')
  if (order.status !== 'draft') throw new Error('仅草稿状态可调整新编号')
  const patchMap = new Map(updates.map((update) => [update.itemId, update.newCode.trim()]))
  const items = order.items.map((item) =>
    patchMap.has(item.itemId) ? { ...item, newCode: patchMap.get(item.itemId) ?? item.newCode } : item
  )
  await db.renumberOrders.update(orderId, { items, validation: null, updatedAt: Date.now() })
}

/** 删除变更单：已确认的单据作为历史凭据不可删除 */
export async function removeRenumberOrder(orderId: string): Promise<void> {
  const order = await db.renumberOrders.get(orderId)
  if (!order) return
  if (order.status === 'confirmed') throw new Error('已确认生效的变更单不可删除')
  await db.renumberOrders.delete(orderId)
}
