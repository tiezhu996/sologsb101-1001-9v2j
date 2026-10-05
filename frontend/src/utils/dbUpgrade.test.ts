/**
 * 结构版本 v2 → v3 迁移测试：旧库打开后自动建变更单 / 别名表，
 * 并为存量机组与叶片回填初始登记别名（validFrom 取记录创建时间）。
 */
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { describe, expect, it } from 'vitest'
import { DB_NAME } from '@/utils/db'

/** 应用 v2 时期的表结构（与 utils/db.ts 的 version(2) 一致） */
const V2_SCHEMA = {
  turbines: 'id, code, model, commissionDate, updatedAt',
  blades: 'id, turbineId, serial, material, updatedAt',
  segments: 'id, bladeId, index, face, updatedAt',
  defects: 'id, segmentId, type, severity, face, state, foundAt, updatedAt',
  workOrders: 'id, defectId, team, state, dueDate, updatedAt'
}

describe('DB v2 → v3 迁移', () => {
  it('回填存量机组 / 叶片的初始编号别名', async () => {
    // 先以 v2 结构建库并写入存量数据
    const legacy = new Dexie(DB_NAME)
    legacy.version(2).stores(V2_SCHEMA)
    await legacy.open()
    const createdAt = Date.now() - 30 * 24 * 60 * 60 * 1000
    await legacy.table('turbines').put({
      id: 'tbn_legacy',
      code: 'WT-OLD1',
      model: 'GW155-4.5MW',
      hubHeightM: 110,
      commissionDate: '2020-01-01',
      bladeCount: 1,
      createdAt,
      updatedAt: createdAt
    })
    await legacy.table('blades').put({
      id: 'bld_legacy',
      turbineId: 'tbn_legacy',
      serial: 'A',
      lengthM: 68.5,
      material: '玻璃纤维',
      segmentCount: 3,
      createdAt,
      updatedAt: createdAt
    })
    legacy.close()

    // 以应用当前版本（v3）重新打开，触发 upgrade 迁移
    const { db, DB_VERSION } = await import('@/utils/db')
    expect(DB_VERSION).toBe(3)
    await db.open()

    const aliases = await db.codeAliases.toArray()
    const turbineAlias = aliases.find((alias) => alias.targetId === 'tbn_legacy')
    const bladeAlias = aliases.find((alias) => alias.targetId === 'bld_legacy')
    expect(turbineAlias).toMatchObject({
      entityType: 'turbine',
      code: 'WT-OLD1',
      validFrom: createdAt,
      validTo: null,
      orderId: ''
    })
    expect(bladeAlias).toMatchObject({
      entityType: 'blade',
      parentId: 'tbn_legacy',
      code: 'A',
      validFrom: createdAt,
      validTo: null
    })

    // 迁移后变更单流程可用：改号 → 旧编号成为别名
    const { confirmChangeOrder, freezeChangeOrder } = await import('@/utils/changeOrder')
    const { buildMapping } = await import('@/utils/changeOrder')
    const now = Date.now()
    await db.changeOrders.put({
      id: 'aco_legacy',
      code: 'AC-LEGACY-1',
      title: '迁移后改号',
      reason: '',
      state: 'draft',
      mappings: [buildMapping('turbine', 'tbn_legacy', null, 'WT-OLD1', 'WT-NEW1')],
      snapshot: null,
      issues: [],
      progress: { appliedKeys: [], total: 1 },
      effectiveAt: null,
      frozenAt: null,
      confirmedAt: null,
      appliedAt: null,
      createdAt: now,
      updatedAt: now
    })
    expect((await freezeChangeOrder('aco_legacy')).ok).toBe(true)
    expect((await confirmChangeOrder('aco_legacy')).ok).toBe(true)
    expect((await db.turbines.get('tbn_legacy'))?.code).toBe('WT-NEW1')

    const after = await db.codeAliases.toArray()
    const { resolveByCode } = await import('@/types/changeOrder')
    expect(resolveByCode(after, 'turbine', 'WT-OLD1')).toBe('tbn_legacy')
    expect(resolveByCode(after, 'turbine', 'WT-NEW1')).toBe('tbn_legacy')
  })
})
