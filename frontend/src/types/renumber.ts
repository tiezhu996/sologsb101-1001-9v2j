/**
 * 资产编号时间线：记录机组 / 叶片编号在每一个时间段内的取值。
 * 改号确认后旧编号不删除：把旧时间段 endDate 关闭，再开一条新时间段，
 * 因此历史数据可按旧编号（别名）兼容读取，报告也能按记录发生日期还原当时编号。
 */
export type AssetType = 'turbine' | 'blade'

/** 变更单状态：草稿 → 已确认（生效）；确认中断时保持 confirming 以便下次续跑 */
export type RenumberStatus = 'draft' | 'confirming' | 'confirmed'

/** 单条改号项：一个机组或一片叶片的新旧编号对照 */
export interface RenumberItem {
  /** 变更单内的行 id（非资产 id） */
  itemId: string
  assetType: AssetType
  /** 被改号资产主键（turbines.id / blades.id） */
  assetId: string
  /** 机组改号时冗余机组名；叶片改号时冗余所属机组 id，便于分组展示 */
  turbineId: string
  /** 叶片序号（assetType=blade 时使用，机组行为空串） */
  bladeSerial: string
  oldCode: string
  newCode: string
  /** 执行状态：待确认 → 已生效，用于中断后逐项续跑（幂等） */
  applied: boolean
  appliedAt: number | null
}

/** 受影响记录：冻结时逐类登记 id，并在确认前复核是否有增删 / 断链 */
export interface AffectedRecord {
  blades: string[]
  segments: string[]
  defects: string[]
  workOrders: string[]
}

/** 冻结快照：建单（冻结）时刻的关联链与编号，确认前逐项比对 */
export interface FrozenSnapshot {
  frozenAt: number
  /** 机组 id → 机组编号（冻结当时） */
  turbineCodes: Record<string, string>
  /** 叶片 id → { 所属机组 id, 序号 } */
  bladeOwners: Record<string, { turbineId: string; serial: string }>
  /** 分段 id → 所属叶片 id */
  segmentBlades: Record<string, string>
  /** 缺陷 id → 所属分段 id */
  defectSegments: Record<string, string>
  /** 工单 id → 缺陷 id */
  workOrderDefects: Record<string, string>
  /** 每个改号项影响到的下级记录 id 集合（叶片/分段/缺陷/工单） */
  affectedByItem: Record<string, AffectedRecord>
  /** 全库计数，用于发现冻结后的旁路改动 */
  totals: { turbines: number; blades: number; segments: number; defects: number; workOrders: number }
}

/**
 * 资产变更单：风电场增容后统一改号的凭据。
 * 先冻结关联 → 列出新旧编号与受影响记录 → 校验通过后确认生效。
 */
export interface RenumberOrder {
  id: string
  /** 单号，如 ACC-20261005-001 */
  code: string
  title: string
  reason: string
  status: RenumberStatus
  items: RenumberItem[]
  snapshot: FrozenSnapshot
  /** 冻结时的阻断性问题（快照生成异常等），通常为空 */
  frozenErrors: string[]
  /** 最近一次校验结果（确认前每次都会重新校验） */
  validation: RenumberValidation | null
  createdAt: number
  updatedAt: number
  /** 确认生效日期（YYYY-MM-DD）：编号时间线以此为分界 */
  effectiveDate: string | null
  confirmedAt: number | null
}

/** 变更单校验结果 */
export interface RenumberValidation {
  ok: boolean
  /** 阻断问题：存在任何一条都不允许提交确认 */
  errors: string[]
  /** 提醒项：不阻断（例如新编号与更早的历史别名相同） */
  warnings: string[]
  checkedAt: number
}

/** 新建变更单的入参（仅改号项，单号 / 快照由服务层补齐） */
export interface CreateRenumberOrderInput {
  title: string
  reason: string
  /** 改号项：assetType + assetId + newCode */
  changes: Array<{ assetType: AssetType; assetId: string; newCode: string }>
}

/** 资产类型中文标签 */
export const ASSET_TYPE_LABEL: Record<AssetType, string> = {
  turbine: '机组',
  blade: '叶片'
}

export const RENUMBER_STATUS_LABEL: Record<RenumberStatus, string> = {
  draft: '草稿（已冻结）',
  confirming: '确认中断（可续跑）',
  confirmed: '已确认生效'
}

/** 受影响记录分类的展示顺序与中文名 */
export const AFFECTED_KINDS: Array<{ key: keyof AffectedRecord; label: string }> = [
  { key: 'blades', label: '叶片' },
  { key: 'segments', label: '分段' },
  { key: 'defects', label: '缺陷' },
  { key: 'workOrders', label: '工单' }
]
