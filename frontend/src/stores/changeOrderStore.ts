import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useIdbTable } from '@/hooks/useIdbTable'
import {
  cancelChangeOrder,
  confirmChangeOrder,
  freezeChangeOrder,
  resumeInterruptedOrders,
  type ChangeOrderResult
} from '@/utils/changeOrder'
import {
  affectedCountsOf,
  type AffectedCounts,
  type ChangeOrder,
  type RenumberMapping
} from '@/types/changeOrder'
import type { CodeAlias } from '@/types/changeOrder'

export interface CreateChangeOrderInput {
  title: string
  reason: string
  mappings: RenumberMapping[]
}

/** 变更单号：AC-日期-随机串，本地单库足够唯一 */
function nextOrderCode(): string {
  const date = new Date()
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(
    date.getDate()
  ).padStart(2, '0')}`
  const rand = Math.random().toString(36).slice(2, 6)
  return `AC-${stamp}-${rand}`
}

/**
 * 资产变更单 store：维护变更单与编号别名列表，
 * 冻结 / 确认 / 取消的具体落库逻辑在 utils/changeOrder.ts。
 */
export const useChangeOrderStore = defineStore('changeOrder', () => {
  const ordersTable = useIdbTable<ChangeOrder>((database) => database.changeOrders)
  const aliasesTable = useIdbTable<CodeAlias>((database) => database.codeAliases, {
    sortByUpdatedAt: false
  })

  const orders = computed<ChangeOrder[]>(() => ordersTable.rows.value)
  const aliases = computed<CodeAlias[]>(() => aliasesTable.rows.value)
  const ready = computed(() => ordersTable.ready.value)
  /** 是否有待处理（未生效也未取消）的变更单，用于导航徽标 */
  const pendingCount = computed(
    () => orders.value.filter((order) => ['draft', 'frozen', 'applying'].includes(order.state)).length
  )
  /** 处于「应用中」的变更单：页面加载时提示并自动续跑 */
  const interruptedOrders = computed(() => orders.value.filter((order) => order.state === 'applying'))

  const busy = ref(false)
  /** 续跑结果提示，页面挂载后展示一次 */
  const lastResumeCount = ref(0)

  function orderById(id: string): ChangeOrder | undefined {
    return orders.value.find((order) => order.id === id)
  }

  function affectedOf(order: ChangeOrder): AffectedCounts {
    return affectedCountsOf(order.snapshot)
  }

  /** 新建草稿变更单 */
  async function createOrder(input: CreateChangeOrderInput): Promise<ChangeOrder> {
    const order = await ordersTable.create(
      {
        code: nextOrderCode(),
        title: input.title.trim(),
        reason: input.reason.trim(),
        state: 'draft',
        mappings: input.mappings,
        snapshot: null,
        issues: [],
        progress: { appliedKeys: [], total: input.mappings.length },
        effectiveAt: null,
        frozenAt: null,
        confirmedAt: null,
        appliedAt: null
      },
      'aco'
    )
    return order
  }

  /** 更新草稿的映射与说明（仅草稿可改） */
  async function updateDraft(id: string, patch: Partial<Pick<ChangeOrder, 'title' | 'reason' | 'mappings'>>): Promise<void> {
    const order = orderById(id)
    if (!order || order.state !== 'draft') return
    await ordersTable.update(id, {
      ...patch,
      issues: [],
      progress: { appliedKeys: [], total: (patch.mappings ?? order.mappings).length }
    })
  }

  async function freeze(id: string): Promise<ChangeOrderResult> {
    busy.value = true
    try {
      return await freezeChangeOrder(id)
    } finally {
      busy.value = false
    }
  }

  /** 确认生效：撞车 / 引用漏项不提交；重复提交幂等；中断后调用即续跑 */
  async function confirm(id: string): Promise<ChangeOrderResult> {
    busy.value = true
    try {
      return await confirmChangeOrder(id)
    } finally {
      busy.value = false
    }
  }

  async function cancel(id: string): Promise<boolean> {
    return cancelChangeOrder(id)
  }

  /** 删除变更单：仅草稿 / 已取消可删，避免误删已生效的编号历史 */
  async function remove(id: string): Promise<boolean> {
    const order = orderById(id)
    if (!order || (order.state !== 'draft' && order.state !== 'cancelled')) return false
    await ordersTable.remove(id)
    return true
  }

  /** 页面加载时续跑中断的变更单（从已登记的确认进度继续） */
  async function resumeInterrupted(): Promise<number> {
    const resumed = await resumeInterruptedOrders()
    lastResumeCount.value = resumed.length
    return resumed.length
  }

  /** 变更单产生的别名对照（详情页展示旧编号 → 新编号） */
  function aliasesOfOrder(orderId: string): CodeAlias[] {
    return aliases.value
      .filter((alias) => alias.orderId === orderId)
      .sort((a, b) => a.validFrom - b.validFrom)
  }

  return {
    orders,
    aliases,
    ready,
    busy,
    pendingCount,
    interruptedOrders,
    lastResumeCount,
    orderById,
    affectedOf,
    aliasesOfOrder,
    createOrder,
    updateDraft,
    freeze,
    confirm,
    cancel,
    remove,
    resumeInterrupted
  }
})
