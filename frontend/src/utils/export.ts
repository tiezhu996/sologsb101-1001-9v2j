import {
  clearAllTables,
  createId,
  db,
  DB_VERSION,
  dateFromTs,
  stampBackupTime,
  type BackupPayload
} from '@/utils/db'
import type { CodeHistory } from '@/types/codeHistory'
import { reportFileName, type TurbineReport } from '@/utils/report'

const COLLECTIONS = [
  'turbines',
  'blades',
  'segments',
  'defects',
  'workOrders',
  'codeHistories',
  'renumberOrders'
] as const

type CollectionKey = (typeof COLLECTIONS)[number]

/** 校验备份对象的必备字段，返回错误信息数组（为空表示通过） */
export function validateBackup(input: unknown): {
  ok: boolean
  errors: string[]
  payload: BackupPayload | null
} {
  const errors: string[] = []
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], payload: null }
  }
  const obj = input as Partial<BackupPayload>
  if (obj.app !== 'gbwindblade') errors.push('app 字段应为 gbwindblade，文件来源不明')
  for (const key of COLLECTIONS) {
    if (!Array.isArray(obj[key])) errors.push(`${key} 字段缺失或不是数组`)
  }
  if (errors.length > 0) return { ok: false, errors, payload: null }

  const payload: BackupPayload = {
    app: 'gbwindblade',
    dbVersion: typeof obj.dbVersion === 'number' ? obj.dbVersion : DB_VERSION,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    turbines: obj.turbines ?? [],
    blades: obj.blades ?? [],
    segments: obj.segments ?? [],
    defects: obj.defects ?? [],
    workOrders: obj.workOrders ?? []
  }
  return { ok: true, errors, payload }
}

/** 组装当前本地数据的全量备份对象 */
export async function buildBackupPayload(): Promise<BackupPayload> {
  const [turbines, blades, segments, defects, workOrders, codeHistories, renumberOrders] = await Promise.all([
    db.turbines.toArray(),
    db.blades.toArray(),
    db.segments.toArray(),
    db.defects.toArray(),
    db.workOrders.toArray(),
    db.codeHistories.toArray(),
    db.renumberOrders.toArray()
  ])
  return {
    app: 'gbwindblade',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    turbines,
    blades,
    segments,
    defects,
    workOrders,
    codeHistories,
    renumberOrders
  }
}

/** 触发浏览器下载 */
function download(fileName: string, content: string): void {
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function countPayload(payload: BackupPayload): Record<CollectionKey, number> {
  return {
    turbines: payload.turbines.length,
    blades: payload.blades.length,
    segments: payload.segments.length,
    defects: payload.defects.length,
    workOrders: payload.workOrders.length,
    codeHistories: payload.codeHistories?.length ?? 0,
    renumberOrders: payload.renumberOrders?.length ?? 0
  }
}

/** 导出全量 JSON 备份到浏览器下载目录 */
export async function exportBackupJson(): Promise<{
  fileName: string
  counts: Record<CollectionKey, number>
}> {
  const payload = await buildBackupPayload()
  const fileName = `gbwindblade-backup-v${payload.dbVersion}-${payload.exportedAt
    .slice(0, 19)
    .replace(/[:T]/g, '')}.json`
  download(fileName, JSON.stringify(payload, null, 2))
  stampBackupTime(payload.exportedAt)
  return { fileName, counts: countPayload(payload) }
}

/** 导出单台机组的巡检报告 JSON */
export function exportReportJson(report: TurbineReport): string {
  const fileName = reportFileName(report)
  download(fileName, JSON.stringify(report, null, 2))
  return fileName
}

/** 读取用户选择的文件文本 */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsText(file, 'utf-8')
  })
}

/**
 * 为资产补齐初始编号时间段：旧版本备份（v2 及以前）没有 codeHistories，
 * 导入后若不补录，「按旧编号兼容读取 / 报告显示当时编号」就没有时间线可用。
 * 已存在时间段的资产跳过，保持幂等。
 */
async function backfillCodeHistories(payload: BackupPayload): Promise<CodeHistory[]> {
  const existing = await db.codeHistories.toArray()
  const openByAsset = new Set(
    existing.filter((row) => row.effectiveTo === null).map((row) => `${row.assetType}:${row.assetId}`)
  )
  const now = Date.now()
  const added: CodeHistory[] = []
  payload.turbines.forEach((turbine) => {
    const key = `turbine:${turbine.id}`
    if (openByAsset.has(key)) return
    added.push({
      id: createId('ch'),
      assetType: 'turbine',
      assetId: turbine.id,
      code: turbine.code,
      effectiveFrom: turbine.commissionDate || dateFromTs(turbine.createdAt ?? now),
      effectiveTo: null,
      sourceOrderId: null,
      createdAt: now
    })
  })
  payload.blades.forEach((blade) => {
    const key = `blade:${blade.id}`
    if (openByAsset.has(key)) return
    added.push({
      id: createId('ch'),
      assetType: 'blade',
      assetId: blade.id,
      code: blade.serial,
      effectiveFrom: dateFromTs(blade.createdAt ?? now),
      effectiveTo: null,
      sourceOrderId: null,
      createdAt: now
    })
  })
  if (added.length > 0) await db.codeHistories.bulkAdd(added)
  return added
}

/** 导入备份：overwrite=true 先清空全部表，否则按主键合并（同 id 覆盖） */
export async function importBackup(
  payload: BackupPayload,
  overwrite: boolean
): Promise<Record<CollectionKey, number>> {
  if (overwrite) await clearAllTables()
  await db.transaction(
    'rw',
    [
      db.turbines,
      db.blades,
      db.segments,
      db.defects,
      db.workOrders,
      db.codeHistories,
      db.renumberOrders
    ],
    async () => {
      await db.turbines.bulkPut(payload.turbines)
      await db.blades.bulkPut(payload.blades)
      await db.segments.bulkPut(payload.segments)
      await db.defects.bulkPut(payload.defects)
      await db.workOrders.bulkPut(payload.workOrders)
      if (payload.codeHistories && payload.codeHistories.length > 0) {
        await db.codeHistories.bulkPut(payload.codeHistories)
      }
      if (payload.renumberOrders && payload.renumberOrders.length > 0) {
        await db.renumberOrders.bulkPut(payload.renumberOrders)
      }
    }
  )
  // 旧版备份（无编号时间线）导入后补录初始段，保证历史数据仍可按原编号读取
  if (!payload.codeHistories || payload.codeHistories.length === 0) {
    await backfillCodeHistories(payload)
  }
  return countPayload(payload)
}

/**
 * 追加式导入：为导入数据重新分配 id 并重建外键关系，避免覆盖现有档案。
 * 编号时间线按新资产 id 一并重映射；变更单快照含旧 id，追加场景不导入（仅资产数据）。
 */
export function remapIds(payload: BackupPayload): BackupPayload {
  const turbineIdMap = new Map<string, string>()
  const bladeIdMap = new Map<string, string>()
  const segmentIdMap = new Map<string, string>()
  const defectIdMap = new Map<string, string>()

  const turbines = payload.turbines.map((turbine) => {
    const id = createId('tbn')
    turbineIdMap.set(turbine.id, id)
    return { ...turbine, id }
  })
  const blades = payload.blades.map((blade) => {
    const id = createId('bld')
    bladeIdMap.set(blade.id, id)
    return { ...blade, id, turbineId: turbineIdMap.get(blade.turbineId) ?? blade.turbineId }
  })
  const segments = payload.segments.map((segment) => {
    const id = createId('seg')
    segmentIdMap.set(segment.id, id)
    return { ...segment, id, bladeId: bladeIdMap.get(segment.bladeId) ?? segment.bladeId }
  })
  const defects = payload.defects.map((defect) => {
    const id = createId('dfc')
    defectIdMap.set(defect.id, id)
    return { ...defect, id, segmentId: segmentIdMap.get(defect.segmentId) ?? defect.segmentId }
  })
  const workOrders = payload.workOrders.map((order) => ({
    ...order,
    id: createId('wo'),
    defectId: defectIdMap.get(order.defectId) ?? order.defectId
  }))
  const codeHistories = (payload.codeHistories ?? []).map((history) => {
    const newAssetId =
      history.assetType === 'turbine'
        ? turbineIdMap.get(history.assetId)
        : bladeIdMap.get(history.assetId)
    return { ...history, id: createId('ch'), assetId: newAssetId ?? history.assetId }
  })

  return { ...payload, turbines, blades, segments, defects, workOrders, codeHistories, renumberOrders: [] }
}
