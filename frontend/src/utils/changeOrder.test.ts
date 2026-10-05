/**
 * 资产变更单核心逻辑测试：
 * 冻结快照 → 确认生效 → 旧编号别名 / 兼容读取 / 报告当时编号，
 * 撞车与引用漏项不提交、写入中断续跑、重复提交幂等（不多出叶片与别名）。
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearAllTables, createId, db, seedDemoData } from '@/utils/db'
import {
  buildMapping,
  confirmChangeOrder,
  freezeChangeOrder,
  loadRenumberContext,
  resumeInterruptedOrders,
  validateMappings
} from '@/utils/changeOrder'
import {
  codeAt,
  previousCodesOf,
  resolveByCode,
  type ChangeOrder,
  type RenumberMapping
} from '@/types/changeOrder'
import { buildTurbineReport } from '@/utils/report'
import type { Turbine } from '@/types/turbine'
import type { Blade } from '@/types/blade'

/** 直接落库一份草稿变更单（绕过 store，聚焦落库逻辑） */
async function makeDraft(mappings: RenumberMapping[]): Promise<ChangeOrder> {
  const now = Date.now()
  const order: ChangeOrder = {
    id: createId('aco'),
    code: `AC-TEST-${Math.random().toString(36).slice(2, 6)}`,
    title: '增容改造重编号',
    reason: '测试',
    state: 'draft',
    mappings,
    snapshot: null,
    issues: [],
    progress: { appliedKeys: [], total: mappings.length },
    effectiveAt: null,
    frozenAt: null,
    confirmedAt: null,
    appliedAt: null,
    createdAt: now,
    updatedAt: now
  }
  await db.changeOrders.put(order)
  return order
}

async function seedTurbines(): Promise<{ wtA01: Turbine; wtB07: Turbine; bladesA: Blade[] }> {
  const turbines = await db.turbines.toArray()
  const wtA01 = turbines.find((turbine) => turbine.code === 'WT-A01') as Turbine
  const wtB07 = turbines.find((turbine) => turbine.code === 'WT-B07') as Turbine
  const bladesA = (await db.blades.where('turbineId').equals(wtA01.id).toArray()).sort((a, b) =>
    a.serial.localeCompare(b.serial)
  )
  return { wtA01, wtB07, bladesA }
}

/** WT-A01 → WT-101，叶片 A/B → 01/02 的三条映射 */
function renumberMappings(wtA01: Turbine, bladesA: Blade[]): RenumberMapping[] {
  return [
    buildMapping('turbine', wtA01.id, null, 'WT-A01', 'WT-101'),
    buildMapping('blade', bladesA[0].id, wtA01.id, 'A', '01'),
    buildMapping('blade', bladesA[1].id, wtA01.id, 'B', '02')
  ]
}

beforeEach(async () => {
  await clearAllTables()
  await seedDemoData()
})

describe('冻结：锁定关联并列出受影响记录', () => {
  it('冻结后快照包含机组 / 叶片 / 分段 / 缺陷 / 工单，重复冻结幂等', async () => {
    const { wtA01, bladesA } = await seedTurbines()
    const order = await makeDraft(renumberMappings(wtA01, bladesA))

    const frozen = await freezeChangeOrder(order.id)
    expect(frozen.ok).toBe(true)

    const saved = (await db.changeOrders.get(order.id)) as ChangeOrder
    expect(saved.state).toBe('frozen')
    expect(saved.frozenAt).not.toBeNull()
    // 演示数据：WT-A01 子树 = 1 机组 + 2 叶片 + 6 分段 + 9 缺陷 + 3 工单
    expect(saved.snapshot?.turbineIds).toEqual([wtA01.id])
    expect(saved.snapshot?.bladeIds.sort()).toEqual(bladesA.map((blade) => blade.id).sort())
    expect(saved.snapshot?.segmentIds).toHaveLength(6)
    expect(saved.snapshot?.defectIds).toHaveLength(9)
    expect(saved.snapshot?.workOrderIds).toHaveLength(3)

    const again = await freezeChangeOrder(order.id)
    expect(again.ok).toBe(true)
    expect((await db.changeOrders.get(order.id))?.snapshot?.defectIds).toHaveLength(9)
  })
})

describe('确认生效：新编号启用，旧编号保留为别名', () => {
  it('确认后在册编号更新，旧编号可按原编号兼容读取，报告按时间显示当时编号', async () => {
    const { wtA01, bladesA } = await seedTurbines()
    const order = await makeDraft(renumberMappings(wtA01, bladesA))
    await freezeChangeOrder(order.id)

    const before = Date.now()
    const result = await confirmChangeOrder(order.id)
    const after = Date.now()
    expect(result.ok).toBe(true)

    // 新编号生效
    const turbine = (await db.turbines.get(wtA01.id)) as Turbine
    expect(turbine.code).toBe('WT-101')
    const bladeNew = await db.blades.where('turbineId').equals(wtA01.id).toArray()
    expect(bladeNew.map((blade) => blade.serial).sort()).toEqual(['01', '02'])

    // 旧编号作为别名保留：初始别名关闭、变更单别名在册
    const aliases = await db.codeAliases.toArray()
    expect(previousCodesOf(aliases, 'turbine', wtA01.id)).toEqual(['WT-A01'])
    expect(previousCodesOf(aliases, 'blade', bladesA[0].id)).toEqual(['A'])
    const orderAliases = aliases.filter((alias) => alias.orderId === order.id)
    expect(orderAliases).toHaveLength(3)
    expect(orderAliases.every((alias) => alias.validTo === null)).toBe(true)

    // 兼容读取：旧铭牌编号仍能定位当前记录
    expect(resolveByCode(aliases, 'turbine', 'WT-A01')).toBe(wtA01.id)
    expect(resolveByCode(aliases, 'turbine', 'WT-101')).toBe(wtA01.id)
    expect(resolveByCode(aliases, 'blade', 'A', wtA01.id)).toBe(bladesA[0].id)

    // 按时间解析：生效前是旧编号，生效后是新编号
    const saved = (await db.changeOrders.get(order.id)) as ChangeOrder
    const effectiveAt = saved.effectiveAt as number
    expect(effectiveAt).toBeGreaterThanOrEqual(before)
    expect(effectiveAt).toBeLessThanOrEqual(after)
    expect(codeAt(aliases, 'turbine', wtA01.id, effectiveAt - 1)).toBe('WT-A01')
    expect(codeAt(aliases, 'turbine', wtA01.id, effectiveAt)).toBe('WT-101')
    expect(codeAt(aliases, 'blade', bladesA[0].id, effectiveAt - 1)).toBe('A')
    expect(codeAt(aliases, 'blade', bladesA[0].id, effectiveAt)).toBe('01')

    // 报告：缺陷发现日期早于改号，显示当时（旧）编号；表头展示曾用编号
    const report = buildTurbineReport(
      {
        id: turbine.id,
        code: turbine.code,
        model: turbine.model,
        hubHeightM: turbine.hubHeightM,
        commissionDate: turbine.commissionDate,
        bladeCount: turbine.bladeCount,
        previousCodes: previousCodesOf(aliases, 'turbine', wtA01.id)
      },
      {
        blades: await db.blades.toArray(),
        segments: await db.segments.toArray(),
        defects: await db.defects.toArray(),
        workOrders: await db.workOrders.toArray(),
        aliases
      },
      3
    )
    expect(report.turbine.previousCodes).toEqual(['WT-A01'])
    const allRows = report.blades.flatMap((section) => section.segments.flatMap((line) => line.defects))
    expect(allRows.length).toBe(9)
    expect(allRows.every((row) => row.turbineCode === 'WT-A01')).toBe(true)
    const serialsOfFirstBlade = report.blades
      .find((section) => section.blade.id === bladesA[0].id)
      ?.segments.flatMap((line) => line.defects)
      .map((row) => row.bladeSerial)
    expect(new Set(serialsOfFirstBlade)).toEqual(new Set(['A']))
    // 工单定位同样按创建时间显示当时编号
    expect(report.workOrders.length).toBe(3)
    expect(report.workOrders.every((line) => line.turbineCodeAt === 'WT-A01')).toBe(true)
  })
})

describe('校验：撞车或引用漏项不提交', () => {
  it('新编号与他机在册 / 历史编号撞车 → 冻结即拦截', async () => {
    const { wtA01, wtB07 } = await seedTurbines()
    // 他机在册编号
    const clash = await makeDraft([buildMapping('turbine', wtA01.id, null, 'WT-A01', 'WT-B07')])
    const result = await freezeChangeOrder(clash.id)
    expect(result.ok).toBe(false)
    expect(result.issues[0].message).toContain('撞车')
    expect(((await db.changeOrders.get(clash.id)) as ChangeOrder).state).toBe('draft')

    // 他机历史编号：B07 先改成 WT-107，A01 再抢 WT-B07 也不行
    const first = await makeDraft([buildMapping('turbine', wtB07.id, null, 'WT-B07', 'WT-107')])
    await freezeChangeOrder(first.id)
    await confirmChangeOrder(first.id)
    const second = await makeDraft([buildMapping('turbine', wtA01.id, null, 'WT-A01', 'WT-B07')])
    const blocked = await freezeChangeOrder(second.id)
    expect(blocked.ok).toBe(false)
    expect(blocked.issues[0].message).toContain('撞车')
  })

  it('冻结后他机抢注新编号 → 确认时拦截，不提交任何写入', async () => {
    const { wtA01, wtB07 } = await seedTurbines()
    const order = await makeDraft([buildMapping('turbine', wtA01.id, null, 'WT-A01', 'WT-100')])
    expect((await freezeChangeOrder(order.id)).ok).toBe(true)

    // 冻结与确认之间，WT-100 被他机占用
    const now = Date.now()
    await db.turbines.put({
      id: 'tbn_outsider',
      code: 'WT-100',
      model: 'GW136-3.6MW',
      hubHeightM: 100,
      commissionDate: '2024-01-01',
      bladeCount: 0,
      createdAt: now,
      updatedAt: now
    })
    await db.codeAliases.put({
      id: 'als_init_tbn_outsider',
      entityType: 'turbine',
      targetId: 'tbn_outsider',
      parentId: null,
      code: 'WT-100',
      validFrom: now,
      validTo: null,
      orderId: '',
      createdAt: now,
      updatedAt: now
    })

    const result = await confirmChangeOrder(order.id)
    expect(result.ok).toBe(false)
    expect(result.issues[0].message).toContain('撞车')
    // 不提交：在册编号与状态均未变化
    expect(((await db.turbines.get(wtA01.id)) as Turbine).code).toBe('WT-A01')
    expect(((await db.changeOrders.get(order.id)) as ChangeOrder).state).toBe('frozen')
    expect(((await db.turbines.get(wtB07.id)) as Turbine).code).toBe('WT-B07')
  })

  it('引用漏项：映射目标不存在 → 拦截', async () => {
    const { wtA01 } = await seedTurbines()
    const order = await makeDraft([buildMapping('blade', 'bld_missing', wtA01.id, 'C', '03')])
    const result = await freezeChangeOrder(order.id)
    expect(result.ok).toBe(false)
    expect(result.issues[0].message).toContain('引用漏项')
  })

  it('同一变更单内两条映射改到同一新编号 → 拦截', async () => {
    const { wtA01, bladesA } = await seedTurbines()
    const ctx = await loadRenumberContext()
    const issues = validateMappings(
      [
        buildMapping('blade', bladesA[0].id, wtA01.id, 'A', '01'),
        buildMapping('blade', bladesA[1].id, wtA01.id, 'B', '01')
      ],
      ctx,
      'aco_x'
    )
    expect(issues.some((issue) => issue.message.includes('撞车'))).toBe(true)
  })
})

describe('幂等与断点续跑', () => {
  it('重复提交同一份变更单：不多出叶片、不多出别名', async () => {
    const { wtA01, bladesA } = await seedTurbines()
    const order = await makeDraft(renumberMappings(wtA01, bladesA))
    await freezeChangeOrder(order.id)
    await confirmChangeOrder(order.id)

    const bladesBefore = await db.blades.count()
    const aliasesBefore = await db.codeAliases.count()

    const again = await confirmChangeOrder(order.id)
    expect(again.ok).toBe(true)
    expect(again.already).toBe(true)
    expect(await db.blades.count()).toBe(bladesBefore)
    expect(await db.blades.count()).toBe(4)
    expect(await db.codeAliases.count()).toBe(aliasesBefore)
    expect(((await db.turbines.get(wtA01.id)) as Turbine).code).toBe('WT-101')
  })

  it('写入中断后从确认进度继续：已应用映射不重复写入', async () => {
    const { wtA01, bladesA } = await seedTurbines()
    const order = await makeDraft(renumberMappings(wtA01, bladesA))
    await freezeChangeOrder(order.id)

    // 第一条映射落库后模拟崩溃（事务已提交，进程中断）
    const crashed = await confirmChangeOrder(order.id, {
      onMappingApplied: () => {
        throw new Error('模拟写入中断')
      }
    })
    expect(crashed.ok).toBe(false)

    const interrupted = (await db.changeOrders.get(order.id)) as ChangeOrder
    expect(interrupted.state).toBe('applying')
    expect(interrupted.progress.appliedKeys).toHaveLength(1)
    // 第一条映射（机组）已生效
    expect(((await db.turbines.get(wtA01.id)) as Turbine).code).toBe('WT-101')
    expect(((await db.blades.get(bladesA[0].id)) as Blade).serial).toBe('A')

    const aliasesAfterCrash = await db.codeAliases.count()

    // 续跑：从已登记的进度继续，跳过已应用映射
    const resumed = await resumeInterruptedOrders()
    expect(resumed).toContain(order.id)

    const finished = (await db.changeOrders.get(order.id)) as ChangeOrder
    expect(finished.state).toBe('applied')
    expect(finished.progress.appliedKeys).toHaveLength(3)
    expect(((await db.blades.get(bladesA[0].id)) as Blade).serial).toBe('01')
    expect(((await db.blades.get(bladesA[1].id)) as Blade).serial).toBe('02')

    // 续跑只补写了缺失的两条别名，没有重复
    expect(await db.codeAliases.count()).toBe(aliasesAfterCrash + 2)
    // 叶片数量始终不变
    expect(await db.blades.count()).toBe(4)
    // 已应用映射的生效时间保持首次确认的基准时间
    const aliases = await db.codeAliases.toArray()
    const turbineAlias = aliases.find((alias) => alias.orderId === order.id && alias.targetId === wtA01.id)
    expect(turbineAlias?.validFrom).toBe(finished.effectiveAt)
  })
})
