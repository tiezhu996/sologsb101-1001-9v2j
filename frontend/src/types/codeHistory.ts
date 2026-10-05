import type { AssetType } from '@/types/renumber'

/**
 * 资产编号时间线段：表示某资产在 [effectiveFrom, effectiveTo) 内使用 code。
 * - 首次建档时补一条 from=投运/建档日期、to=null 的时间段
 * - 改号确认：旧段补 effectiveTo=生效日期，插入新段 from=生效日期、to=null
 * - effectiveTo=null 即当前编号；所有历史 code 都是可按旧编号检索的别名
 */
export interface CodeHistory {
  id: string
  assetType: AssetType
  assetId: string
  code: string
  /** YYYY-MM-DD（含） */
  effectiveFrom: string
  /** YYYY-MM-DD（不含），null 表示当前仍生效 */
  effectiveTo: string | null
  /** 来源变更单 id；初始补录为 null */
  sourceOrderId: string | null
  createdAt: number
}
