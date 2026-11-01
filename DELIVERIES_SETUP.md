# 收货自动入库功能安装说明

这个安装包给现有 Brewlytics 项目增加 Receive deliveries 页面。它连接已批准的 AI 采购草稿、待到货数据和现有库存。

流程：在 AI Forecast 批准采购草稿 → 用户自行向供应商下单 → 登记待到货 → 实际收货后填写数量并确认 → 自动增加库存并减少待到货数量。

批准草稿和登记待到货都不会增加库存；程序也不会联系供应商或发出采购订单。

## 1. 安装前提

- 项目已经有库存功能，Supabase 已执行 `supabase/inventory-feature.sql`。
- Supabase 已执行 `supabase/automated-ordering-drafts.sql`，AI Forecast 页面可以保存、批准草稿。
- 保留现有服务端 `SUPABASE_URL` 和 `SUPABASE_SECRET_KEY`。不需要新密钥或新运行依赖。
- 收货功能可以与已安装的销售扣库存功能并存，不要求重新安装销售包。

## 2. 在 Codespaces 安装代码

把 `inventory-deliveries-feature.zip` 上传到项目根目录（与 `package.json` 同级）。在终端运行：

```bash
unzip inventory-deliveries-feature.zip
python3 inventory-deliveries-feature/install-in-codespace.py
```

安装程序会增加独立文件和 Inventory 页面的 Receive deliveries 链接。原导航文件保存为 `page.tsx.before-deliveries.bak`。它保留已有的 Record sale 链接。发现同名文件内容不同或无法识别的导航时，会在修改前停止，不会直接覆盖你的改动。

## 3. 在 Supabase 执行 SQL

打开 `supabase/inventory-deliveries.sql`，将全部内容复制到同一个 Supabase 项目的 SQL Editor 中运行。也可以使用随包提供的独立 SQL 文件，内容相同。

SQL 新增收货和采购登记表、相关字段及两个事务函数。已有库存数量不变，不会导入测试数据。已有待到货行会保留，其当前数量记录为初始订单量，当前原料单位记录为收货校验单位；以前发生的收货无法由此倒推。

如果 incoming_deliveries 尚未建立，SQL 会创建空表，不需要运行演示数据脚本。

## 4. 启动并使用

```bash
npm run dev
```

在现有私有 Codespaces 开发预览中打开 Inventory → Receive deliveries，也可以访问 `/inventory/deliveries`。

### 已有待到货记录

在 Expected deliveries 中找到原料，核对数量和单位，填写实际到货量、送货单号或核对人，勾选已验收，点击 Confirm receipt & update stock。

### 新采购

1. 在 AI Forecast 生成、审核并批准草稿。
2. 自行向供应商下单，并确认实际订单与草稿的原料及数量一致。
3. 在 Receive deliveries 页面的 Register a placed order 展开该草稿。
4. 填写预计到货日期和采购参考号，勾选已向供应商下单，点击 Register expected delivery。
5. 到货后，逐项核对并确认实际到货数量。

登记的所有原料行共用输入的预计到货日期。第一版不支持在此修改草稿数量、为每行设置不同日期或新增任意手工采购单。

## 5. 验证示例

假设牛奶现有库存 20,000 mL、订单 5,000 mL：

| 操作 | 实际库存 | 待到货 |
| --- | ---: | ---: |
| 登记已下单 | 20,000 mL | 5,000 mL |
| 第一次实际收到 3,000 mL | 23,000 mL | 2,000 mL |
| 后续收到剩余 2,000 mL | 25,000 mL | 0 mL |

每次收货都会生成 delivery_receipts 记录和现有 inventory_movements 中的 delivery 记录。全部到货后，该行不再出现在 Expected deliveries 中；历史记录保留。AI 下次运行时会读取更新后的实际库存及剩余待到货量，不会重复计算同一批货。已生成的旧草稿仍是历史快照，需要重新运行预测才能得到新建议。

数量必须按页面显示的原料单位填写。例如单位是 mL 时，5 L 填 5000；单位是 g 时，1 kg 填 1000。系统不自动换算单位，不允许负数、零、超出待到货量或超过六位小数的收货数量。原料单位在登记后发生变化时，收货会被阻止，需要先核对数据。

如果界面提示网络不确定，先查看 Recent receipts。未刷新页面时可以使用原表单重试，同一请求编号不会重复入库；旧的待到货数量也会阻止陈旧表单重复提交。不要将已确认的同一批货重新作为新收货录入。

不要再通过原库存页的手动 Delivery 给同一批收货重复加库存，也不要在收货后重跑 `automated-ordering-demo-data.sql`：旧演示脚本会重置演示待到货数量。

## 6. 当前范围

- 部分收货的余量继续待到货。供应商确定少送、取消余量、超额送货或退货时，本版没有专门处理按钮，不能当作全部正常收货。
- 同一个已批准草稿只能登记一次，重复点击不会创建第二批待到货。
- 采购参考号便于核对，但系统无法识别两个不同草稿是否代表同一笔真实采购；登记前需核对。
- 延续原项目限制：写入只在私有开发演示（`npm run dev`）中开放。生产构建只读；正式上线仍需员工登录和服务端权限校验。
- 本地制作与测试没有连接或修改你们的线上 Supabase。

## 7. 本地验证

11 项独立数据库场景通过，包括重复安装、登记幂等、非法订单、分批收货、重复收货请求、陈旧表单、异常数量、写入失败回滚、单位变更、API 角色权限和队列重复请求。

本地浏览器使用独立合成测试数据库，验证了采购登记、分批收货、库存与待到货同步、历史记录和收货完成。TypeScript 检查、完整 Next.js 生产构建通过；加入之前的销售功能后，TypeScript 集成检查也通过。

数据库测试使用 PGlite，不能替代真实 PostgreSQL 多连接并发测试。安装后仍需在你们的演示项目中验证实际表结构和 Codespaces 环境。

## 8. 提交到 Git

审查并提交新增的 `app/inventory/deliveries/`、`lib/inventory-deliveries/`、`supabase/inventory-deliveries.sql`、本说明和 Inventory 导航改动。不要提交 ZIP、安装器文件夹、备份文件或环境密钥。
