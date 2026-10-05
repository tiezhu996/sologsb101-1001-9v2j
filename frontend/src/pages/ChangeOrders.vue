<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { CircleClose, Delete, Document, Lock, Plus, Refresh, Select } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useTurbineStore } from '@/stores/turbineStore'
import { useChangeOrderStore } from '@/stores/changeOrderStore'
import {
  buildMapping,
  computeAffected,
  validateMappings,
  type RenumberContext
} from '@/utils/changeOrder'
import {
  CHANGE_ORDER_STATE_LABEL,
  CHANGE_ORDER_STATE_TAG,
  affectedCountsOf,
  type ChangeOrder,
  type RenumberMapping
} from '@/types/changeOrder'

const turbineStore = useTurbineStore()
const changeOrderStore = useChangeOrderStore()

function fmtTime(ts: number | null): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 全量数据视图：冻结前的实时校验与受影响预览共用 */
const liveCtx = computed<RenumberContext>(() => ({
  turbines: turbineStore.turbines,
  blades: turbineStore.blades,
  segments: turbineStore.segments,
  defects: turbineStore.defects,
  workOrders: turbineStore.workOrders,
  aliases: turbineStore.aliases
}))

/* ---------------- 新建变更单 ---------------- */

/** 对话框里一台机组的改号卡片：机组新编号 + 各叶片新序号（默认与旧编号一致，改动才纳入映射） */
interface TurbineEditCard {
  turbineId: string
  newCode: string
  bladeRows: Array<{ bladeId: string; oldSerial: string; newSerial: string }>
}

const createVisible = ref(false)
const createSubmitting = ref(false)
const createForm = reactive({ title: '', reason: '' })
const cards = ref<TurbineEditCard[]>([])
const pickedTurbineId = ref('')

const pickableTurbines = computed(() =>
  turbineStore.turbines.filter((turbine) => !cards.value.some((card) => card.turbineId === turbine.id))
)

function openCreate(): void {
  createForm.title = ''
  createForm.reason = ''
  cards.value = []
  pickedTurbineId.value = ''
  createVisible.value = true
}

function addTurbineCard(): void {
  const turbine = turbineStore.turbineById(pickedTurbineId.value)
  if (!turbine) {
    ElMessage.warning('请先选择要改号的机组')
    return
  }
  cards.value.push({
    turbineId: turbine.id,
    newCode: turbine.code,
    bladeRows: turbineStore.bladesOfTurbine(turbine.id).map((blade) => ({
      bladeId: blade.id,
      oldSerial: blade.serial,
      newSerial: blade.serial
    }))
  })
  pickedTurbineId.value = ''
}

function removeCard(turbineId: string): void {
  cards.value = cards.value.filter((card) => card.turbineId !== turbineId)
}

/** 由卡片派生改号映射：只收集新编号与旧编号不同的行 */
const draftMappings = computed<RenumberMapping[]>(() => {
  const mappings: RenumberMapping[] = []
  for (const card of cards.value) {
    const turbine = turbineStore.turbineById(card.turbineId)
    if (!turbine) continue
    if (card.newCode.trim() && card.newCode.trim() !== turbine.code) {
      mappings.push(buildMapping('turbine', turbine.id, null, turbine.code, card.newCode))
    }
    for (const row of card.bladeRows) {
      if (row.newSerial.trim() && row.newSerial.trim() !== row.oldSerial) {
        mappings.push(buildMapping('blade', row.bladeId, card.turbineId, row.oldSerial, row.newSerial))
      }
    }
  }
  return mappings
})

/** 实时校验：撞车 / 引用漏项在冻结前就暴露 */
const liveIssues = computed(() => validateMappings(draftMappings.value, liveCtx.value, ''))
const liveAffected = computed(() => computeAffected(draftMappings.value, liveCtx.value))

async function submitCreate(): Promise<void> {
  if (!createForm.title.trim()) {
    ElMessage.warning('请填写变更单标题')
    return
  }
  if (draftMappings.value.length === 0) {
    ElMessage.warning('请至少添加一条改号映射（新编号需与旧编号不同）')
    return
  }
  if (liveIssues.value.length > 0) {
    ElMessage.error('存在校验问题，请先修正后再保存')
    return
  }
  createSubmitting.value = true
  try {
    const order = await changeOrderStore.createOrder({
      title: createForm.title,
      reason: createForm.reason,
      mappings: draftMappings.value
    })
    createVisible.value = false
    ElMessage.success(`变更单 ${order.code} 已保存为草稿，冻结后方可确认生效`)
  } finally {
    createSubmitting.value = false
  }
}

/* ---------------- 状态流转 ---------------- */

async function handleFreeze(order: ChangeOrder): Promise<void> {
  const result = await changeOrderStore.freeze(order.id)
  if (result.ok) {
    ElMessage.success(`变更单 ${order.code} 已冻结，受影响记录已锁定，请核对后确认生效`)
  } else {
    ElMessage.error(result.issues[0]?.message ?? '冻结失败')
  }
}

async function handleConfirm(order: ChangeOrder): Promise<void> {
  const isResume = order.state === 'applying'
  try {
    await ElMessageBox.confirm(
      isResume
        ? '该变更单此前应用中断，将从已登记的进度继续，已完成的映射不会重复写入。继续？'
        : '确认后新编号立即生效，旧编号保留为别名，历史数据仍可按原编号读取。确认生效？',
      isResume ? '继续应用变更单' : '确认变更单生效',
      { type: 'warning', confirmButtonText: isResume ? '继续应用' : '确认生效', cancelButtonText: '再想想' }
    )
  } catch {
    return
  }
  const result = await changeOrderStore.confirm(order.id)
  if (result.ok) {
    ElMessage.success(
      result.already ? '该变更单此前已生效，本次未重复写入' : `变更单 ${order.code} 已生效，旧编号已保留为别名`
    )
  } else {
    ElMessage.error(result.issues[0]?.message ?? '确认失败')
  }
}

async function handleCancel(order: ChangeOrder): Promise<void> {
  try {
    await ElMessageBox.confirm('取消后变更单不再生效，已冻结的关联快照将释放。确认取消？', '取消变更单', {
      type: 'warning',
      confirmButtonText: '确认取消',
      cancelButtonText: '返回'
    })
  } catch {
    return
  }
  if (await changeOrderStore.cancel(order.id)) ElMessage.success('变更单已取消')
}

async function handleRemove(order: ChangeOrder): Promise<void> {
  try {
    await ElMessageBox.confirm('删除后不可恢复（仅草稿 / 已取消可删除）。确认删除？', '删除变更单', {
      type: 'warning',
      confirmButtonText: '确认删除',
      cancelButtonText: '返回'
    })
  } catch {
    return
  }
  if (await changeOrderStore.remove(order.id)) ElMessage.success('变更单已删除')
}

/* ---------------- 详情抽屉 ---------------- */

const detailVisible = ref(false)
const detailId = ref('')
const detail = computed<ChangeOrder | null>(() => changeOrderStore.orderById(detailId.value) ?? null)

function openDetail(order: ChangeOrder): void {
  detailId.value = order.id
  detailVisible.value = true
}

function mappingTargetLabel(mapping: RenumberMapping): string {
  if (mapping.entityType === 'turbine') return `机组 ${mapping.oldCode}`
  const turbine = mapping.parentId ? turbineStore.turbineById(mapping.parentId) : undefined
  return `叶片 ${turbine?.code ?? '?'} / ${mapping.oldCode}`
}

const detailAffected = computed(() => affectedCountsOf(detail.value?.snapshot ?? null))
const detailProgress = computed(() => {
  const order = detail.value
  if (!order || order.progress.total === 0) return 0
  return Math.round((order.progress.appliedKeys.length / order.progress.total) * 100)
})
const detailAliases = computed(() => (detail.value ? changeOrderStore.aliasesOfOrder(detail.value.id) : []))

const snapshotPanels = computed(() => {
  const snapshot = detail.value?.snapshot
  if (!snapshot) return []
  return [
    { label: '机组', ids: snapshot.turbineIds },
    { label: '叶片', ids: snapshot.bladeIds },
    { label: '展向分段', ids: snapshot.segmentIds },
    { label: '缺陷', ids: snapshot.defectIds },
    { label: '维修工单', ids: snapshot.workOrderIds }
  ]
})

/* ---------------- 中断续跑 ---------------- */

onMounted(async () => {
  // 写入中断的变更单（应用中状态）从已登记的确认进度继续
  const resumed = await changeOrderStore.resumeInterrupted()
  if (resumed > 0) ElMessage.success(`检测到 ${resumed} 份中断的变更单，已从确认进度继续应用并生效`)
})
</script>

<template>
  <div>
    <div class="page-title">
      <div>
        <h2>资产变更单</h2>
        <p>增容改造后机组 / 叶片重新编号：冻结关联 → 核对受影响记录 → 确认生效，旧编号保留为别名。</p>
      </div>
      <div class="toolbar">
        <el-button type="primary" :icon="Plus" @click="openCreate">新建变更单</el-button>
      </div>
    </div>

    <el-alert
      v-if="changeOrderStore.interruptedOrders.length > 0"
      type="warning"
      show-icon
      :closable="false"
      class="resume-alert"
      :title="`有 ${changeOrderStore.interruptedOrders.length} 份变更单处于应用中（可能写入中断），打开详情或点击「继续应用」可从确认进度继续。`"
    />

    <EmptyPanel
      v-if="changeOrderStore.orders.length === 0"
      title="暂无资产变更单"
      description="增容改造需要重编号时，新建变更单：先冻结机组、叶片、分段、缺陷与工单的关联，核对受影响记录后再确认生效。"
      action-text="新建变更单"
      @action="openCreate"
    />

    <div v-else class="section-card">
      <el-table :data="changeOrderStore.orders" size="small" border>
        <el-table-column label="变更单号" width="170">
          <template #default="{ row }">
            <span class="mono">{{ row.code }}</span>
          </template>
        </el-table-column>
        <el-table-column label="标题" prop="title" min-width="180" />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="CHANGE_ORDER_STATE_TAG[row.state as ChangeOrder['state']]" size="small">
              {{ CHANGE_ORDER_STATE_LABEL[row.state as ChangeOrder['state']] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="改号映射" width="90">
          <template #default="{ row }">{{ row.mappings.length }} 条</template>
        </el-table-column>
        <el-table-column label="应用进度" width="150">
          <template #default="{ row }">
            <el-progress
              v-if="row.state === 'applying' || row.state === 'applied'"
              :percentage="row.progress.total === 0 ? 100 : Math.round((row.progress.appliedKeys.length / row.progress.total) * 100)"
              :stroke-width="8"
            />
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="生效时间" width="170">
          <template #default="{ row }">
            <span class="mono">{{ fmtTime(row.appliedAt) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="300" fixed="right">
          <template #default="{ row }">
            <el-button size="small" :icon="Document" @click="openDetail(row)">详情</el-button>
            <el-button
              v-if="row.state === 'draft'"
              size="small"
              type="warning"
              plain
              :icon="Lock"
              :loading="changeOrderStore.busy"
              @click="handleFreeze(row)"
            >
              冻结
            </el-button>
            <el-button
              v-if="row.state === 'frozen' || row.state === 'applying'"
              size="small"
              type="primary"
              :icon="row.state === 'applying' ? Refresh : Select"
              :loading="changeOrderStore.busy"
              @click="handleConfirm(row)"
            >
              {{ row.state === 'applying' ? '继续应用' : '确认生效' }}
            </el-button>
            <el-button
              v-if="row.state === 'draft' || row.state === 'frozen'"
              size="small"
              :icon="CircleClose"
              @click="handleCancel(row)"
            >
              取消
            </el-button>
            <el-button
              v-if="row.state === 'draft' || row.state === 'cancelled'"
              size="small"
              type="danger"
              plain
              :icon="Delete"
              @click="handleRemove(row)"
            />
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 新建变更单 -->
    <el-dialog v-model="createVisible" title="新建资产变更单" width="880px" destroy-on-close>
      <el-form label-width="90px">
        <el-form-item label="标题" required>
          <el-input v-model="createForm.title" placeholder="如：一期增容改造后机组重编号" maxlength="60" />
        </el-form-item>
        <el-form-item label="变更原因">
          <el-input
            v-model="createForm.reason"
            type="textarea"
            :rows="2"
            placeholder="如：增容后机位调整，全场机组与叶片按新规则统一编号"
            maxlength="200"
          />
        </el-form-item>
        <el-form-item label="改号对象">
          <div class="picker-row">
            <el-select v-model="pickedTurbineId" placeholder="选择要改号的机组" class="picker-select">
              <el-option
                v-for="turbine in pickableTurbines"
                :key="turbine.id"
                :label="`${turbine.code}（${turbine.model}）`"
                :value="turbine.id"
              />
            </el-select>
            <el-button :icon="Plus" @click="addTurbineCard">添加机组</el-button>
          </div>
        </el-form-item>
      </el-form>

      <div v-for="card in cards" :key="card.turbineId" class="renumber-card">
        <div class="renumber-card__head">
          <strong>机组 {{ turbineStore.turbineById(card.turbineId)?.code }}</strong>
          <el-button size="small" text type="danger" :icon="Delete" @click="removeCard(card.turbineId)" />
        </div>
        <div class="renumber-card__row">
          <span class="renumber-card__label">机组新编号</span>
          <el-input v-model="card.newCode" size="small" class="renumber-card__input" placeholder="留空或不变则不改号" />
        </div>
        <div v-for="row in card.bladeRows" :key="row.bladeId" class="renumber-card__row">
          <span class="renumber-card__label">叶片 {{ row.oldSerial }} 新序号</span>
          <el-input v-model="row.newSerial" size="small" class="renumber-card__input" placeholder="留空或不变则不改号" />
        </div>
      </div>

      <el-alert
        v-if="liveIssues.length > 0"
        type="error"
        show-icon
        :closable="false"
        title="存在校验问题，修正后才能保存："
        class="issue-alert"
      >
        <ul class="issue-list">
          <li v-for="issue in liveIssues" :key="issue.mappingKey + issue.message">{{ issue.message }}</li>
        </ul>
      </el-alert>

      <div v-if="draftMappings.length > 0" class="preview-block">
        <p class="preview-block__title">
          将生成 {{ draftMappings.length }} 条改号映射，冻结后受影响记录：
          机组 {{ liveAffected.turbineIds.length }} 台 · 叶片 {{ liveAffected.bladeIds.length }} 片 ·
          分段 {{ liveAffected.segmentIds.length }} 段 · 缺陷 {{ liveAffected.defectIds.length }} 条 ·
          工单 {{ liveAffected.workOrderIds.length }} 张
        </p>
      </div>

      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="createSubmitting"
          :disabled="draftMappings.length === 0 || liveIssues.length > 0"
          @click="submitCreate"
        >
          保存为草稿
        </el-button>
      </template>
    </el-dialog>

    <!-- 变更单详情 -->
    <el-drawer v-model="detailVisible" size="720px" :title="detail ? `变更单 ${detail.code}` : '变更单详情'">
      <template v-if="detail">
        <el-descriptions :column="2" size="small" border>
          <el-descriptions-item label="状态">
            <el-tag :type="CHANGE_ORDER_STATE_TAG[detail.state]" size="small">
              {{ CHANGE_ORDER_STATE_LABEL[detail.state] }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="标题">{{ detail.title }}</el-descriptions-item>
          <el-descriptions-item label="变更原因" :span="2">{{ detail.reason || '—' }}</el-descriptions-item>
          <el-descriptions-item label="创建时间">{{ fmtTime(detail.createdAt) }}</el-descriptions-item>
          <el-descriptions-item label="冻结时间">{{ fmtTime(detail.frozenAt) }}</el-descriptions-item>
          <el-descriptions-item label="确认时间">{{ fmtTime(detail.confirmedAt) }}</el-descriptions-item>
          <el-descriptions-item label="生效时间">{{ fmtTime(detail.appliedAt) }}</el-descriptions-item>
          <el-descriptions-item label="生效基准时间" :span="2">
            {{ fmtTime(detail.effectiveAt) }}
            <span class="muted">（报告按此时间划分新旧编号）</span>
          </el-descriptions-item>
        </el-descriptions>

        <el-alert
          v-if="detail.issues.length > 0"
          type="error"
          show-icon
          :closable="false"
          title="校验未通过，未提交任何写入："
          class="issue-alert"
        >
          <ul class="issue-list">
            <li v-for="issue in detail.issues" :key="issue.mappingKey + issue.message">{{ issue.message }}</li>
          </ul>
        </el-alert>

        <div v-if="detail.state === 'applying'" class="progress-block">
          <p class="progress-block__label">
            应用进度 {{ detail.progress.appliedKeys.length }} / {{ detail.progress.total }}（中断后从已登记进度继续）
          </p>
          <el-progress :percentage="detailProgress" :stroke-width="10" />
        </div>

        <h4 class="drawer-subtitle">新旧编号映射（{{ detail.mappings.length }} 条）</h4>
        <el-table :data="detail.mappings" size="small" border>
          <el-table-column label="对象" min-width="150">
            <template #default="{ row }">{{ mappingTargetLabel(row) }}</template>
          </el-table-column>
          <el-table-column label="旧编号" width="110">
            <template #default="{ row }"><span class="mono">{{ row.oldCode }}</span></template>
          </el-table-column>
          <el-table-column label="新编号" width="110">
            <template #default="{ row }"><span class="mono strong">{{ row.newCode }}</span></template>
          </el-table-column>
          <el-table-column label="进度" width="90">
            <template #default="{ row }">
              <el-tag v-if="detail.progress.appliedKeys.includes(row.key)" size="small" type="success">已应用</el-tag>
              <el-tag v-else size="small" type="info">待应用</el-tag>
            </template>
          </el-table-column>
        </el-table>

        <h4 class="drawer-subtitle">受影响记录（冻结快照）</h4>
        <template v-if="detail.snapshot">
          <div class="stat-row">
            <StatBadge label="机组" :value="detailAffected.turbines" suffix="台" tone="primary" icon="Odometer" />
            <StatBadge label="叶片" :value="detailAffected.blades" suffix="片" tone="info" icon="Grid" />
            <StatBadge label="展向分段" :value="detailAffected.segments" suffix="段" tone="default" icon="Histogram" />
            <StatBadge label="缺陷" :value="detailAffected.defects" suffix="条" tone="warning" icon="WarningFilled" />
            <StatBadge label="维修工单" :value="detailAffected.workOrders" suffix="张" tone="danger" icon="Tools" />
          </div>
          <el-collapse class="snapshot-collapse">
            <el-collapse-item
              v-for="panel in snapshotPanels"
              :key="panel.label"
              :title="`${panel.label}记录（${panel.ids.length}）`"
              :name="panel.label"
            >
              <p v-for="id in panel.ids" :key="id" class="mono snapshot-id">{{ id }}</p>
            </el-collapse-item>
          </el-collapse>
        </template>
        <p v-else class="muted">尚未冻结：冻结后锁定机组、叶片、分段、缺陷与工单的关联快照。</p>

        <template v-if="detailAliases.length > 0">
          <h4 class="drawer-subtitle">编号别名（旧编号保留，历史数据按原编号兼容读取）</h4>
          <el-table :data="detailAliases" size="small" border>
            <el-table-column label="类型" width="80">
              <template #default="{ row }">{{ row.entityType === 'turbine' ? '机组' : '叶片' }}</template>
            </el-table-column>
            <el-table-column label="新编号（在册）" width="130">
              <template #default="{ row }"><span class="mono strong">{{ row.code }}</span></template>
            </el-table-column>
            <el-table-column label="生效时间" width="170">
              <template #default="{ row }"><span class="mono">{{ fmtTime(row.validFrom) }}</span></template>
            </el-table-column>
          </el-table>
        </template>

        <div class="drawer-actions">
          <el-button
            v-if="detail.state === 'draft'"
            type="warning"
            plain
            :icon="Lock"
            :loading="changeOrderStore.busy"
            @click="handleFreeze(detail)"
          >
            冻结变更单
          </el-button>
          <el-button
            v-if="detail.state === 'frozen' || detail.state === 'applying'"
            type="primary"
            :icon="detail.state === 'applying' ? Refresh : Select"
            :loading="changeOrderStore.busy"
            @click="handleConfirm(detail)"
          >
            {{ detail.state === 'applying' ? '继续应用' : '确认生效' }}
          </el-button>
        </div>
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
.resume-alert {
  margin-bottom: 14px;
}

.picker-row {
  display: flex;
  gap: 8px;
  width: 100%;
}

.picker-select {
  flex: 1;
}

.renumber-card {
  margin-bottom: 10px;
  padding: 10px 12px;
  border: 1px solid var(--line, #d5e2ea);
  border-radius: 8px;
  background: #f7fbfd;
}

.renumber-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.renumber-card__row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 6px;
}

.renumber-card__label {
  width: 130px;
  font-size: 13px;
  color: #4a5b63;
}

.renumber-card__input {
  width: 220px;
}

.issue-alert {
  margin-top: 12px;
}

.issue-list {
  margin: 4px 0 0;
  padding-left: 18px;
}

.preview-block {
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  background: #eef6fb;
}

.preview-block__title {
  margin: 0;
  font-size: 13px;
  color: #1c2b33;
}

.progress-block {
  margin-top: 14px;
}

.progress-block__label {
  margin: 0 0 6px;
  font-size: 13px;
  color: #4a5b63;
}

.drawer-subtitle {
  margin: 18px 0 8px;
  font-size: 14px;
}

.snapshot-collapse {
  margin-top: 10px;
}

.snapshot-id {
  margin: 2px 0;
  font-size: 12px;
  color: #4a5b63;
}

.mono {
  font-family: 'JetBrains Mono', 'SFMono-Regular', Consolas, monospace;
}

.strong {
  font-weight: 700;
  color: #0f5c7a;
}

.muted {
  color: #7b8c95;
  font-size: 12px;
}

.drawer-actions {
  display: flex;
  gap: 8px;
  margin-top: 20px;
}
</style>
