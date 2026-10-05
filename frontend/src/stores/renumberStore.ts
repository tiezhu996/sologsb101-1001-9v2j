import { defineStore } from 'pinia'
import { computed } from 'vue'
import { useIdbTable } from '@/hooks/useIdbTable'
import type { CodeHistory } from '@/types/codeHistory'
import type {
  CreateRenumberOrderInput,
  RenumberItem,
  RenumberOrder,
  RenumberValidation
} from '@/types/renumber'
import { CodeIndex } from '@/utils/codes'
import {
  RenumberValidationError,
  confirmRenumberOrder,
  createRenumberOrder,
  findBlockingOrder,
  removeRenumberOrder,
  updateDraftItems,
  validateOrder
} from '@/utils/renumber'

export interface ConfirmOutcome {
  ok: boolean
  order: RenumberOrder | null
  validation: RenumberValidation | null
  error: string | null
}

/**
 * 资产变更单 store：变更单与编号时间线的响应式订阅，
 * 提供冻结建单、校验、确认（可续跑）、草稿改号、删除等动作。
 */
export const useRenumberStore = defineStore('renumber', () => {
  const ordersTable = useIdbTable<RenumberOrder>((database) => database.renumberOrders)
  const historiesTable = useIdbTable<CodeHistory>((database) => database.codeHistories, {
    sortByUpdatedAt: false
  })

  const orders = computed<RenumberOrder[]>(() =>
    [...ordersTable.rows.value].sort((a, b) => b.createdAt - a.createdAt)
  )
  const histories = computed<CodeHistory[]>(() => historiesTable.rows.value)
  const loading = computed(() => ordersTable.loading.value || historiesTable.loading.value)
  const ready = computed(() => ordersTable.ready.value && historiesTable.ready.value)

  const draftOrders = computed(() => orders.value.filter((order) => order.status !== 'confirmed'))
  const confirmedOrders = computed(() => orders.value.filter((order) => order.status === 'confirmed'))

  /** 编号时间线索引：按日期解析「当时编号」、按旧编号检索别名 */
  const codeIndex = computed<CodeIndex>(() => {
    const map = new Map<string, CodeHistory[]>()
    histories.value.forEach((row) => {
      const key = CodeIndex.key(row.assetType, row.assetId)
      const list = map.get(key)
      if (list) list.push(row)
      else map.set(key, [row])
    })
    map.forEach((list, key) =>
      map.set(
        key,
        [...list].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
      )
    )
    return new CodeIndex(map)
  })

  function orderById(id: string): RenumberOrder | undefined {
    return orders.value.find((order) => order.id === id)
  }

  /** 机组当前编号（优先时间线，时间线缺失时回退传入值） */
  function turbineCodeAt(turbineId: string, date: string, fallback = ''): string {
    return codeIndex.value.at('turbine', turbineId, date, fallback)
  }

  /** 叶片当时编号（序号） */
  function bladeCodeAt(bladeId: string, date: string, fallback = ''): string {
    return codeIndex.value.at('blade', bladeId, date, fallback)
  }

  function currentTurbineCode(turbineId: string, fallback = ''): string {
    return codeIndex.value.current('turbine', turbineId, fallback)
  }

  function currentBladeCode(bladeId: string, fallback = ''): string {
    return codeIndex.value.current('blade', bladeId, fallback)
  }

  /** 旧编号（别名）集合：供缺陷 / 工单关键字兼容检索 */
  function turbineAliases(turbineId: string): string[] {
    return codeIndex.value.aliases('turbine', turbineId)
  }

  function bladeAliases(bladeId: string): string[] {
    return codeIndex.value.aliases('blade', bladeId)
  }

  /** 变更单进度：已生效项 / 总项数 */
  function progressOf(order: RenumberOrder): { applied: number; total: number; percent: number } {
    const applied = order.items.filter((item) => item.applied).length
    const total = order.items.length
    return { applied, total, percent: total === 0 ? 0 : Math.round((applied / total) * 100) }
  }

  /** 受影响记录计数（冻结快照） */
  function affectedCountOf(item: RenumberItem): { blades: number; segments: number; defects: number; workOrders: number } {
    const affected = orderItemsSnapshot(item)
    return {
      blades: affected?.blades.length ?? 0,
      segments: affected?.segments.length ?? 0,
      defects: affected?.defects.length ?? 0,
      workOrders: affected?.workOrders.length ?? 0
    }
  }

  /** 改号项对应的冻结受影响记录（快照键为 assetType:assetId） */
  function orderItemsSnapshot(item: RenumberItem) {
    const order = orders.value.find((candidate) => candidate.items.some((row) => row.itemId === item.itemId))
    if (!order) return undefined
    return order.snapshot.affectedByItem[`${item.assetType}:${item.assetId}`]
  }

  /** 冻结建单：先检查是否有资产已被其他未确认单占用 */
  async function createOrder(input: CreateRenumberOrderInput): Promise<RenumberOrder> {
    const blocking = await findBlockingOrder(input.changes)
    if (blocking) {
      throw new Error(`资产已存在于未确认变更单 ${blocking.code} 中，请先确认或删除该单后再建单`)
    }
    return createRenumberOrder(input)
  }

  async function revalidate(orderId: string): Promise<RenumberValidation> {
    const order = orderById(orderId)
    if (!order) throw new Error('变更单不存在')
    const validation = await validateOrder(order)
    await updateValidationOnly(orderId, validation)
    return validation
  }

  async function updateValidationOnly(orderId: string, validation: RenumberValidation): Promise<void> {
    await ordersTable.update(orderId, { validation })
  }

  /**
   * 确认生效；写入中断（刷新 / 崩溃）后再次调用即为续跑：
   * 已 applied 的项跳过，从首个未生效项继续，重复提交不会多出叶片 / 时间段。
   */
  async function confirm(orderId: string): Promise<ConfirmOutcome> {
    try {
      const order = await confirmRenumberOrder(orderId)
      return { ok: true, order, validation: order.validation, error: null }
    } catch (error) {
      if (error instanceof RenumberValidationError) {
        return { ok: false, order: orderById(orderId) ?? null, validation: error.validation, error: error.message }
      }
      const latest = orderById(orderId) ?? null
      return {
        ok: false,
        order: latest,
        validation: latest?.validation ?? null,
        error: error instanceof Error ? error.message : '确认失败，可从确认进度继续'
      }
    }
  }

  async function saveDraftItems(orderId: string, updates: Array<{ itemId: string; newCode: string }>): Promise<void> {
    await updateDraftItems(orderId, updates)
  }

  async function remove(orderId: string): Promise<void> {
    await removeRenumberOrder(orderId)
  }

  return {
    orders,
    draftOrders,
    confirmedOrders,
    histories,
    loading,
    ready,
    codeIndex,
    orderById,
    turbineCodeAt,
    bladeCodeAt,
    currentTurbineCode,
    currentBladeCode,
    turbineAliases,
    bladeAliases,
    progressOf,
    affectedCountOf,
    createOrder,
    revalidate,
    confirm,
    saveDraftItems,
    remove
  }
})
