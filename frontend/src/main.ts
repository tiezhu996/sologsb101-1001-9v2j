import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import App from '@/App.vue'
import router from '@/router'
import { ensureSeeded, stampDbVersion } from '@/utils/db'
import { resumeInterruptedOrders } from '@/utils/changeOrder'
import '@/styles/main.css'

const app = createApp(App)

Object.entries(ElementPlusIconsVue).forEach(([key, component]) => {
  app.component(key, component)
})

app.use(createPinia())
app.use(router)
app.use(ElementPlus, { locale: zhCn })

stampDbVersion()

// 首次进入自动播种演示数据（幂等：机组表非空时不做任何写入），完成后再挂载，避免首屏空白
ensureSeeded()
  // 上次写入中断的资产变更单（应用中状态）从已登记的确认进度继续，幂等
  .then((seeded) => resumeInterruptedOrders().then((resumed) => ({ seeded, resumed })))
  .then(({ resumed }) => {
    if (resumed.length > 0) {
      console.info(`[gbwindblade] 已续跑 ${resumed.length} 份中断的资产变更单`)
    }
  })
  .catch((error) => {
    console.error('[gbwindblade] 启动初始化失败：', error)
  })
  .finally(() => {
    app.mount('#app')
  })
