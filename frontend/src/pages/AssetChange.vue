<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { CircleCheck, Plus, RefreshRight, WarningFilled } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useTurbineStore } from '@/stores/turbineStore'
import { useRenumberStore } from '@/stores/renumberStore'
import { AFFECTED_KINDS, type AssetType, type RenumberOrder } from '@/types/renumber'
import { dateFromTs } from '@/utils/db'

const turbineStore = useTurbineStore()
const renumberStore = useRenumberStore()

/* ---------------- 列表 ---------------- */
const orders = computed(() => renumberStore.orders)
const openCount = computed(() => renumberStore.draftOrders.length)
const confirmingOrders = computed(() =>
  renumberStore.draftOrders.filter((order) => order.status === 'confirming')
)

function formatTime(ts: number | null): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

function frozenDate(order: RenumberOrder): string {
  return dateFromTs(order.snapshot.frozenAt)
}

function statusTag(order: RenumberOrder): { type: 'info' | 'warning' | 'success'; text: string } {
  if (order.status === 'confirmed') return { type: 'success', text: '已确认生效' }
  if (order.status === 'confirming') return { type: 'warning', text: `确认中断 · ${renumberStore.progressOf(order).applied}/${order.items.length}` }
  return { type: 'info', text: '草稿（已冻结）' }
}

/* ---------------- 新建变更单 ---------------- */
const createVisible = ref(false)
const submitting = ref(false)
const createForm = reactive({
  title: '风电场增容资产改号',
  reason: ''
})

interface ChangeRow {
  key: number
  assetType: AssetType
  turbineId: string
  bladeId: string
  newCode: string
}

let rowSeed = 0
const changeRows = ref<ChangeRow[]>([])

function makeRow(assetType: AssetType = 'turbine'): ChangeRow {
  rowSeed += 1
  const firstTurbine = turbineStore.turbines[0]?.id ?? ''
  return { key: rowSeed, assetType, turbineId: firstTurbine, bladeId: '', newCode: '' }
}

function openCreate(): void {
  createForm.title = '风电场增容资产改号'
  createForm.reason = ''
  changeRows.value = [makeRow('turbine')]
  createVisible.value = true
}

function addRow(assetType: AssetType): void {
  changeRows.value.push(makeRow(assetType))
}

function removeRow(key: number): void {
  if (changeRows.value.length === 1) {
    ElMessage.info('至少保留一条改号记录')
    return
  }
  changeRows.value = changeRows.value.filter((row) => row.key !== key)
}

/** 切换改号类型时清空对侧的选择，避免残留无效引用 */
function handleTypeChange(row: ChangeRow): void {
  row.bladeId = ''
  row.newCode = ''
}

function oldCodeOf(row: ChangeRow): string {
  if (row.assetType === 'turbine') {
    return turbineStore.turbineById(row.turbineId)?.code ?? '—'
  }
  const blade = turbineStore.bladeById(row.bladeId)
  return blade ? blade.serial : '—'
}

/** 单内即时检查：空行 / 新编号缺失 / 同一资产重复选择 */
const createFormErrors = computed<string[]>(() => {
  const errors: string[] = []
  const seen = new Set<string>()
  changeRows.value.forEach((row, index) => {
    const assetId = row.assetType === 'turbine' ? row.turbineId : row.bladeId
    if (!assetId) {
      errors.push(`第 ${index + 1} 行未选择${row.assetType === 'turbine' ? '机组' : '叶片'}`)
      return
    }
    const key = `${row.assetType}:${assetId}`
    if (seen.has(key)) errors.push(`第 ${index + 1} 行选择的资产与前面重复`)
    seen.add(key)
    if (!row.newCode.trim()) errors.push(`第 ${index + 1} 行未填写新编号`)
  })
  return errors
})

async function submitCreate(): Promise<void> {
  if (createFormErrors.value.length > 0) {
    ElMessage.error(createFormErrors.value[0])
    return
  }
  submitting.value = true
  try {
    const order = await renumberStore.createOrder({
      title: createForm.title,
      reason: createForm.reason,
      changes: changeRows.value.map((row) => ({
        assetType: row.assetType,
        assetId: row.assetType === 'turbine' ? row.turbineId : row.bladeId,
        newCode: row.newCode
      }))
    })
    createVisible.value = false
    detailId.value = order.id
    detailVisible.value = true
    ElMessage.success(`变更单 ${order.code} 已创建：关联已冻结，请核对新旧编号与受影响记录后确认生效`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '创建变更单失败')
  } finally {
    submitting.value = false
  }
}

/* ---------------- 详情 / 确认 ---------------- */
const detailVisible = ref(false)
const detailId = ref<string | null>(null)
const detailOrder = computed<RenumberOrder | null>(() =>
  detailId.value ? renumberStore.orderById(detailId.value) ?? null : null
)
const confirming = ref(false)

function openDetail(order: RenumberOrder): void {
  detailId.value = order.id
  detailVisible.value = true
}

const editableDraft = computed(() => detailOrder.value?.status === 'draft')

/** 受影响记录计数汇总（整单） */
const detailTotals = computed(() => {
  const order = detailOrder.value
  if (!order) return { blades: 0, segments: 0, defects: 0, workOrders: 0 }
  const sum = { blades: 0, segments: 0, defects: 0, workOrders: 0 }
  const union = { blades: new Set<string>(), segments: new Set<string>(), defects: new Set<string>(), workOrders: new Set<string>() }
  order.items.forEach((item) => {
    const affected = order.snapshot.affectedByItem[`${item.assetType}:${item.assetId}`]
    if (!affected) return
    affected.blades.forEach((id) => union.blades.add(id))
    affected.segments.forEach((id) => union.segments.add(id))
    affected.defects.forEach((id) => union.defects.add(id))
    affected.workOrders.forEach((id) => union.workOrders.add(id))
  })
  sum.blades = union.blades.size
  sum.segments = union.segments.size
  sum.defects = union.defects.size
  sum.workOrders = union.workOrders.size
  return sum
})

async function handleValidate(): Promise<void> {
  const order = detailOrder.value
  if (!order) return
  const result = await renumberStore.revalidate(order.id)
  if (result.ok) {
    ElMessage.success(result.warnings.length > 0 ? `校验通过；提醒：${result.warnings.join('；')}` : '校验通过：无撞车、无引用漏项，可以确认生效')
  } else {
    ElMessage.error(`校验未通过：${result.errors[0]}`)
  }
}

async function saveNewCodes(): Promise<void> {
  const order = detailOrder.value
  if (!order) return
  await renumberStore.saveDraftItems(
    order.id,
    order.items.map((item) => ({ itemId: item.itemId, newCode: item.newCode }))
  )
  ElMessage.success('新编号已暂存，请重新校验后确认')
}

async function handleConfirm(): Promise<void> {
  const order = detailOrder.value
  if (!order) return
  const validation = await renumberStore.revalidate(order.id)
  if (!validation.ok) {
    ElMessage.error(`存在 ${validation.errors.length} 项问题（撞车 / 引用漏项），变更单未提交`)
    return
  }
  try {
    await ElMessageBox.confirm(
      `确认后新编号将于 ${new Date().toLocaleDateString('zh-CN')} 生效，旧编号作为别名保留；历史缺陷与工单按其发生日期显示当时编号。共 ${order.items.length} 项改号，确认提交？`,
      `确认变更单 ${order.code}`,
      { type: 'warning', confirmButtonText: '确认提交', cancelButtonText: '再核对一下' }
    )
  } catch {
    return
  }
  confirming.value = true
  try {
    const outcome = await renumberStore.confirm(order.id)
    if (outcome.ok) {
      ElMessage.success(`变更单 ${order.code} 已全部生效：${order.items.length} 项改号完成，旧编号已转为别名`)
    } else if (outcome.order?.status === 'confirming') {
      ElMessage.warning(`写入中断，已完成 ${renumberStore.progressOf(outcome.order).applied}/${order.items.length} 项，可点「继续确认」从断点续跑`)
    } else {
      ElMessage.error(outcome.error ?? '确认失败，变更单未提交')
    }
  } finally {
    confirming.value = false
  }
}

async function handleResume(): Promise<void> {
  const order = detailOrder.value
  if (!order) return
  confirming.value = true
  try {
    const outcome = await renumberStore.confirm(order.id)
    if (outcome.ok) {
      ElMessage.success('已从确认进度继续并全部生效，重复提交未产生多余叶片或时间段')
    } else {
      ElMessage.error(outcome.error ?? '续跑失败')
    }
  } finally {
    confirming.value = false
  }
}

async function handleDelete(order: RenumberOrder): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除草稿变更单 ${order.code}？已冻结的关联快照将一并删除（资产编号不变）。`, '删除变更单', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  await renumberStore.remove(order.id)
  if (detailId.value === order.id) detailVisible.value = false
  ElMessage.success('变更单已删除')
}

/** 页签加载时自动提示可续跑的中断单 */
if (confirmingOrders.value.length > 0) {
  // 仅初始化，不弹消息打断
}

function affectedText(order: RenumberOrder): string {
  const totals = { blades: new Set<string>(), segments: new Set<string>(), defects: new Set<string>(), workOrders: new Set<string>() }
  order.items.forEach((item) => {
    const affected = order.snapshot.affectedByItem[`${item.assetType}:${item.assetId}`]
    if (!affected) return
    affected.blades.forEach((id) => totals.blades.add(id))
    affected.segments.forEach((id) => totals.segments.add(id))
    affected.defects.forEach((id) => totals.defects.add(id))
    affected.workOrders.forEach((id) => totals.workOrders.add(id))
  })
  return `叶片 ${totals.blades.size} · 分段 ${totals.segments.size} · 缺陷 ${totals.defects.size} · 工单 ${totals.workOrders.size}`
}

function validationIconType(order: RenumberOrder): 'success' | 'danger' | 'info' {
  if (!order.validation) return 'info'
  return order.validation.ok ? 'success' : 'danger'
}

const turbineOptions = computed(() =>
  turbineStore.turbines.map((turbine) => ({
    label: `${turbine.code}（${turbine.model}）`,
    value: turbine.id
  }))
)

function bladeOptions(turbineId: string) {
  return turbineStore.bladesOfTurbine(turbineId).map((blade) => ({
    label: `叶片 ${blade.serial}`,
    value: blade.id
  }))
}
</script>

<template>
  <div>
    <div class="page-title">
      <div>
        <h2>资产变更单 · 增容改号</h2>
        <p>先冻结机组、叶片、分段、缺陷与工单的关联，列出新旧编号与受影响记录；校验通过后确认生效，旧编号作为别名保留。</p>
      </div>
      <div class="toolbar">
        <el-button type="primary" :icon="Plus" @click="openCreate">新建变更单（冻结）</el-button>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="变更单总数" :value="orders.length" suffix="张" tone="primary" icon="Document" />
      <StatBadge label="待确认 / 中断" :value="openCount" suffix="张" tone="warning" icon="VideoPause" />
      <StatBadge
        label="可续跑中断单"
        :value="confirmingOrders.length"
        suffix="张"
        tone="danger"
        icon="RefreshRight"
      />
      <StatBadge label="已确认生效" :value="renumberStore.confirmedOrders.length" suffix="张" tone="default" icon="CircleCheck" />
    </div>

    <el-alert
      v-if="confirmingOrders.length > 0"
      class="resume-banner"
      type="warning"
      show-icon
      :closable="false"
      title="检测到确认中断的变更单"
      :description="`${confirmingOrders.map((order) => order.code).join('、')} 已有部分改号写入，打开单据点「继续确认」即可从确认进度续跑，重复提交不会多出叶片。`"
    />

    <el-empty v-if="orders.length === 0" description="暂无变更单：增容后需要重排机组 / 叶片编号时，新建一张变更单" />

    <el-table v-else :data="orders" border class="section-card">
      <el-table-column label="单号" prop="code" width="170" />
      <el-table-column label="标题" min-width="180" show-overflow-tooltip>
        <template #default="{ row }: { row: RenumberOrder }">
          <el-link type="primary" @click="openDetail(row)">{{ row.title }}</el-link>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="190">
        <template #default="{ row }: { row: RenumberOrder }">
          <el-tag :type="statusTag(row).type" size="small">{{ statusTag(row).text }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="改号项" width="80" prop="items.length" align="center">
        <template #default="{ row }: { row: RenumberOrder }">{{ row.items.length }}</template>
      </el-table-column>
      <el-table-column label="受影响记录（去重）" min-width="260">
        <template #default="{ row }: { row: RenumberOrder }">{{ affectedText(row) }}</template>
      </el-table-column>
      <el-table-column label="冻结日期" width="110">
        <template #default="{ row }: { row: RenumberOrder }">{{ frozenDate(row) }}</template>
      </el-table-column>
      <el-table-column label="生效日期" width="110">
        <template #default="{ row }: { row: RenumberOrder }">{{ row.effectiveDate ?? '—' }}</template>
      </el-table-column>
      <el-table-column label="校验" width="90" align="center">
        <template #default="{ row }: { row: RenumberOrder }">
          <el-icon v-if="validationIconType(row) === 'success'" color="#1e8449" :size="16"><CircleCheck /></el-icon>
          <el-icon v-else-if="validationIconType(row) === 'danger'" color="#c0392b" :size="16"><WarningFilled /></el-icon>
          <span v-else class="muted">未校验</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="160" fixed="right">
        <template #default="{ row }: { row: RenumberOrder }">
          <el-button link type="primary" @click="openDetail(row)">查看</el-button>
          <el-button v-if="row.status !== 'confirmed'" link type="danger" @click="handleDelete(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 新建变更单对话框 -->
    <el-dialog v-model="createVisible" title="新建资产变更单（冻结关联）" width="860px" destroy-on-close>
      <el-form label-width="92px">
        <el-form-item label="变更单标题">
          <el-input v-model="createForm.title" placeholder="如：风电场三期增容后机组重编号" />
        </el-form-item>
        <el-form-item label="变更原因">
          <el-input v-model="createForm.reason" type="textarea" :rows="2" placeholder="如：增容后全场编号重排，现场旧铭牌仍在使用" />
        </el-form-item>
      </el-form>

      <div class="freeze-note">
        保存即冻结：系统会快照当前「机组 → 叶片 → 分段 → 缺陷 → 工单」关联与计数；
        冻结后若这些记录再被增删，确认时将以「引用漏项」拦截，不会提交。
      </div>

      <el-table :data="changeRows" border size="small">
        <el-table-column label="类型" width="110">
          <template #default="{ row }: { row: ChangeRow }">
            <el-select v-model="row.assetType" @change="handleTypeChange(row)">
              <el-option label="机组" value="turbine" />
              <el-option label="叶片" value="blade" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="机组" min-width="200">
          <template #default="{ row }: { row: ChangeRow }">
            <el-select
              v-model="row.turbineId"
              filterable
              class="full-width"
              @change="row.bladeId = ''"
            >
              <el-option v-for="option in turbineOptions" :key="option.value" :label="option.label" :value="option.value" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="叶片" width="150">
          <template #default="{ row }: { row: ChangeRow }">
            <el-select v-if="row.assetType === 'blade'" v-model="row.bladeId" class="full-width">
              <el-option
                v-for="option in bladeOptions(row.turbineId)"
                :key="option.value"
                :label="option.label"
                :value="option.value"
              />
            </el-select>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="旧编号（冻结值）" width="150">
          <template #default="{ row }: { row: ChangeRow }">
            <span class="mono">{{ oldCodeOf(row) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="新编号" min-width="160">
          <template #default="{ row }: { row: ChangeRow }">
            <el-input v-model="row.newCode" :placeholder="row.assetType === 'turbine' ? '如 WT-C12' : '如 A'" />
          </template>
        </el-table-column>
        <el-table-column label="" width="70" align="center">
          <template #default="{ $index }">
            <el-button link type="danger" @click="removeRow(changeRows[$index].key)">移除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="row-actions">
        <el-button size="small" @click="addRow('turbine')">+ 机组改号</el-button>
        <el-button size="small" @click="addRow('blade')">+ 叶片改号</el-button>
      </div>

      <el-alert
        v-for="(error, index) in createFormErrors.slice(0, 3)"
        :key="index"
        :title="error"
        type="error"
        :closable="false"
        show-icon
        class="inline-alert"
      />

      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitCreate">冻结并生成变更单</el-button>
      </template>
    </el-dialog>

    <!-- 变更单详情 -->
    <el-dialog v-model="detailVisible" :title="detailOrder ? `变更单 ${detailOrder.code}` : '变更单'" width="1000px" destroy-on-close>
      <template v-if="detailOrder">
        <el-descriptions :column="3" size="small" border>
          <el-descriptions-item label="标题" :span="3">{{ detailOrder.title }}</el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag :type="statusTag(detailOrder).type" size="small">{{ statusTag(detailOrder).text }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="冻结时间">{{ formatTime(detailOrder.snapshot.frozenAt) }}</el-descriptions-item>
          <el-descriptions-item label="生效时间">{{ formatTime(detailOrder.confirmedAt) }}</el-descriptions-item>
          <el-descriptions-item v-if="detailOrder.reason" label="变更原因" :span="3">{{ detailOrder.reason }}</el-descriptions-item>
        </el-descriptions>

        <div class="affected-summary">
          <el-tag v-for="kind in AFFECTED_KINDS" :key="kind.key" type="info" effect="plain">
            受影响{{ kind.label }} {{ detailTotals[kind.key] }}
          </el-tag>
          <el-tag type="warning" effect="plain">改号项 {{ detailOrder.items.length }}</el-tag>
          <el-tag v-if="detailOrder.effectiveDate" type="success" effect="plain">
            生效日期 {{ detailOrder.effectiveDate }}：此前记录按旧编号显示
          </el-tag>
        </div>

        <el-alert
          v-if="detailOrder.status === 'confirming'"
          type="warning"
          show-icon
          :closable="false"
          class="inline-alert"
          :title="`写入中断：已生效 ${renumberStore.progressOf(detailOrder).applied}/${detailOrder.items.length} 项`"
          description="已写入项保持幂等不会重复，点「继续确认」从首个未生效项继续。"
        />

        <el-table :data="detailOrder.items" border size="small" max-height="320">
          <el-table-column label="类型" width="70">
            <template #default="{ row }">{{ row.assetType === 'turbine' ? '机组' : '叶片' }}</template>
          </el-table-column>
          <el-table-column label="旧编号" width="140">
            <template #default="{ row }"><span class="mono">{{ row.oldCode }}</span></template>
          </el-table-column>
          <el-table-column label="新编号" width="180">
            <template #default="{ row }">
              <el-input
                v-if="editableDraft"
                v-model="row.newCode"
                size="small"
                @change="saveNewCodes"
              />
              <span v-else class="mono">{{ row.newCode }}</span>
            </template>
          </el-table-column>
          <el-table-column label="受影响记录" min-width="240">
            <template #default="{ row }">
              <span v-for="kind in AFFECTED_KINDS" :key="kind.key" class="affected-chip">
                {{ kind.label }} {{ renumberStore.affectedCountOf(row)[kind.key] }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="110" align="center">
            <template #default="{ row }">
              <el-tag v-if="row.applied" type="success" size="small">已生效</el-tag>
              <el-tag v-else type="info" size="small" effect="plain">待确认</el-tag>
            </template>
          </el-table-column>
        </el-table>

        <div v-if="detailOrder.validation" class="validation-panel">
          <el-alert
            v-if="detailOrder.validation.ok"
            type="success"
            :closable="false"
            show-icon
            title="校验通过：新编号无撞车，冻结关联无引用漏项，可以提交确认"
          />
          <template v-else>
            <el-alert
              v-for="(error, index) in detailOrder.validation.errors"
              :key="`e-${index}`"
              type="error"
              :closable="false"
              show-icon
              class="inline-alert"
              :title="error"
            />
          </template>
          <el-alert
            v-for="(warning, index) in detailOrder.validation.warnings"
            :key="`w-${index}`"
            type="warning"
            :closable="false"
            show-icon
            class="inline-alert"
            :title="warning"
          />
        </div>
      </template>

      <template #footer>
        <template v-if="detailOrder">
          <el-button @click="detailVisible = false">关闭</el-button>
          <el-button
            v-if="detailOrder.status === 'draft'"
            :loading="confirming"
            @click="handleValidate"
          >
            校验撞车 / 漏项
          </el-button>
          <el-button
            v-if="detailOrder.status === 'confirming'"
            type="warning"
            :icon="RefreshRight"
            :loading="confirming"
            @click="handleResume"
          >
            继续确认（{{ renumberStore.progressOf(detailOrder).applied }}/{{ detailOrder.items.length }}）
          </el-button>
          <el-button
            v-if="detailOrder.status !== 'confirmed'"
            type="primary"
            :loading="confirming"
            @click="handleConfirm"
          >
            确认提交，新编号生效
          </el-button>
          <el-tag v-else type="success" effect="dark">已确认生效 · 旧编号保留为别名</el-tag>
        </template>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.resume-banner {
  margin: 12px 0 16px;
}

.freeze-note {
  margin: 8px 0 12px;
  padding: 8px 12px;
  font-size: 12px;
  line-height: 1.6;
  color: #7b8c95;
  background: #f5f7fa;
  border-left: 3px solid #1f8fa8;
  border-radius: 4px;
}

.row-actions {
  display: flex;
  gap: 8px;
  margin: 10px 0;
}

.inline-alert {
  margin-top: 8px;
}

.affected-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 14px 0 10px;
}

.affected-chip {
  display: inline-block;
  margin-right: 10px;
  font-size: 12px;
  color: #4a5b63;
}

.validation-panel {
  margin-top: 12px;
}

.full-width {
  width: 100%;
}

.muted {
  color: #909399;
}
</style>
