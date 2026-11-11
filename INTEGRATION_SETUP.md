# Inventory + Daily Brief 整合说明

本包基于你提供的 `INFS3605-CafeProject-main-3` 和 `INFS3605-CafeProject-inventory-check` 两个文件夹。它是给新版 main 使用的增量补丁，不是可以单独运行的完整项目。

## 这次完成的内容

- 保留 Record sale：确认销售后按数据库配方扣库存，保存销售及配方用量快照，同一销售 reference 重试不会再次扣库存。
- 保留 Receive deliveries：按实际收到的数量增加库存，支持部分收货；页面和 Agent 共用同一收货账本。
- 统一待收数量：`原订购数量 − 累计实收数量`。迁移只恢复 incoming_deliveries 的原订购量表达，不增加、扣减或重置库存，也不删除历史。
- Today 导航接入 Inventory、Record sale、Receive deliveries；底部 Recorded activity 展示所选悉尼日期的手动销售、原料用量和已确认收货。
- 聊天 Agent 新增只读 `get_recorded_operations` 工具，可查询以上数据。
- Daily Brief 读取缓存前校验数据库来源指纹；销售、收货、损耗等来源变化后，下次打开或刷新简报会重新计算。页面不会实时推送到其他已打开的浏览器。
- 销售、收货及库存修改沿用 main 的签名登录 session；每个 server action 都单独验证。登录后生产环境也可操作。这是现有共享口令工作区权限，不是个人账号或管理员分级。

## 1. 在新版 main 上开整合分支

在你平时使用的 Codespaces / 项目终端中执行；不是在下载的 ZIP 文件夹里执行：

```bash
git status
git switch main
git pull --ff-only
git switch -c inventory-agent-integration
```

先确认 `git status` 没有未保存修改。你的 `inventory-check` 分支仍保留原提交。补丁以你提供的 main 文件为基准；如果远端 main 有新改动，安装器会在冲突文件处停止，不能强行覆盖。

## 2. 解压并安装补丁

把 `inventory-agent-integration.zip` 放进 Codespaces 的 `/tmp`（或解压后调整下方路径）。在项目根目录运行：

```bash
unzip /tmp/inventory-agent-integration.zip -d /tmp
python3 /tmp/inventory-agent-integration/apply.py . --check
python3 /tmp/inventory-agent-integration/apply.py . --apply
```

安装器先验证所有目标文件和关键依赖，再写文件；发现不同版本时不会覆盖。重复安装同一包会跳过已安装文件。不要在旧 `inventory-check` 分支直接套这个补丁；不要复制整个 ZIP 到仓库并提交压缩包、备份、node_modules 或 .env。

## 3. 执行一次整合 SQL

**代码复制、Git commit 和 Vercel 部署都不会执行 SQL。**

这个迁移适用于已经安装了你原来的销售/收货 SQL，而且 Jodet 新版 Agent 已经正常工作的同一个 Supabase 项目。`inventory_sales`、`inventory_sale_ingredients`、`delivery_batches`、`delivery_receipts`、`sales_history`、`daily_briefs` 等必须已存在。

在 Supabase → SQL Editor → New query，粘贴项目中的：

```text
supabase/inventory-agent-integration.sql
```

检查项目选对后运行。迁移使用事务，可重复执行；前置表缺失或历史原订购量无法确认时会报错并回滚。不要为了消除错误重新运行旧 demo/setup SQL 或手动猜测数量；先核对错误和实际表结构。

本包同时保留 `inventory-sales.sql`、新版 `inventory-deliveries.sql` 作为完整功能源码和隔离测试所需文件；**在已安装功能的共享数据库上，本次只需要运行 inventory-agent-integration.sql**。不要在迁移后运行旧分支的收货 SQL，否则会重新装回旧的扣待收数量逻辑。约束会阻止它错误写入，但旧页面可能因此报错。

迁移完成后停止使用旧版本的收货页面，并让整合版本与这份数据库配套运行。数据库恢复原订购量后，旧页面会把它误当剩余量；不要混用旧页面和新页面。

## 4. 本地运行和验证

保留团队现有环境变量：`SUPABASE_URL`、`SUPABASE_SECRET_KEY`、`AGENT_PASSCODE`、`GOOGLE_GENERATIVE_AI_API_KEY` 和已有 `GEMINI_MODEL`。确认本地和部署环境连接的是同一目标数据库。不要把真实值提交到 Git。

```bash
npm ci
node --test tests/*.test.mjs
npx tsc --noEmit
npm run dev
```

单元测试使用 Node 24（测试直接导入 TypeScript）。原项目依赖版本未改。

使用隔离测试数据库或团队已同意使用的 demo 数据，走以下三步：

1. Record sale 记录 2 杯 Flat White。若当前配方为每杯牛奶 160 ml / 咖啡豆 18 g，应该分别扣 320 ml / 36 g。销售回执显示前后库存。
2. Receive deliveries 对 5,000 ml 牛奶订单确认实际收到 1,000 ml。牛奶库存增加 1,000 ml，待收 4,000 ml。不要再通过 Inventory 或聊天把同一到货录一遍。
3. 打开 Today，展开 Recorded activity：查看 2 drinks / 1 sale、320 ml 牛奶、36 g 咖啡豆，以及 +1,000 ml 收货。必要时点 Refresh brief。它汇总该悉尼自然日内所有记录，不只这三步的测试记录。

聊天可试：`What sales, ingredient usage and delivery receipts were recorded today?` 应调用 `get_recorded_operations` 并基于返回值作答。真实 Gemini 工具选择需要在团队配置好的环境验证；本次没有使用真实 API key 调用 Gemini。

### 可选：独立数据库回归测试

只在本地创建内存数据库，不连接 Supabase。需要临时测试依赖：

```bash
npm install --no-save --package-lock=false @electric-sql/pglite@0.5.11
node scripts/verify-integration-db.mjs
```

不需要提交这项临时依赖。本次使用 PGlite 0.5.11。此测试覆盖迁移、销售扣库存、页面和 Agent 交替收货、重复请求、写入失败回滚、权限、日期边界及缓存指纹。

## 当前边界

- Today 的 Approve 只记录补货决策，不下单、不联系供应商，也不会自动出现在收货页面。现有收货登记针对 AI Forecast 的已批准 draft_orders；两条审批流程尚未打通。
- Sales 仍手动填写；没有接 POS。收货仍需核对并输入实际数量。
- 同一个 reference 重试不会重复写入；把同一真实交易作为一个全新 reference 再录入，仍需要员工避免。
- 当天手动销售可能只录了一部分，因此只作为已记录活动展示，不直接混入历史预测数据。订单批准或到货预期均不会提前加库存。
- 没有新增退货/撤销销售或自动采购功能。
- 全量数据库指纹适合目前的小型原型；数据规模大时应改为事务内递增的来源版本，避免扫描全部历史。
- 已完成隔离数据库和本地生产模式页面测试；未连接或迁移团队 Supabase，未提交 Git、推送、合并或部署 Vercel。

## 5. 验证通过后交给小组审核

```bash
git status --short
git diff --stat
git diff
```

确认只包含本次功能文件和文档后，再提交整合分支并创建 PR。不要直接覆盖 main。完整验证记录见 `INTEGRATION_TEST_RESULTS.md`。
