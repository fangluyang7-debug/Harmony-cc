# 图片 App 本机/协作切换与展示连接修复

## 问题与处理

协作轮次由协调中心观测接口提供，本机轮次由手机的独立展示通道提供。旧版本只接通前一条时，切换本机并不会自动获得展示连接；展示传输失败后也一直停止发送，直到手动重新连接。

- Windows 中心新增经过 App 身份验证的 `GET /v2/apps/me/photo-display`。仅对声明照片增强能力的 App 返回本机展示服务的连接码；只查询回环地址 `/session`，核对展示主机与当前中心一致，不注册设备或派发任务。
- 图片 App 在协作连接成功、切换本机之前衔接独立展示通道；保存已有连接，本机选图/开始前尝试恢复中断。显式“断开”仍生效，不自动推翻用户操作。旧协调中心未实现接口时，可继续手动扫码连接。
- 切换本机立即同步已选照片；选图草稿不新增执行历史。实际开始后沿用 `START → PROGRESS → RESULT → FINISH`，处理阶段来自手机执行器，成品完成后发送。协作轮次继续使用协调中心回执，不额外伪造本机执行记录。
- 修复附带发现的 `HOST_STOPPED`：成功暂停协作后的本机执行不再反复暂停旧宿主。若宿主已经停止，先通过原结算检查退出，不能绕过未结算任务直接丢弃账本。本机运行不会依赖旧中心继续在线。

## 修改位置

- `apps/harmony-photo/entry/src/main/ets/PhotoDisplay.ets`
- `apps/harmony-photo/entry/src/main/ets/PhotoSession.ets`
- `apps/harmony-photo/entry/src/main/ets/pages/Index.ets`
- `services/coordinator/src/app.ts`
- `services/coordinator/src/photo-display-connection.ts`
- `tests/sdk/native-photo-display.test.cjs`
- `tests/sdk/native-photo-session.test.cjs`
- `services/coordinator/test/photo-display-connection.test.cjs`

## 验证与安装

21 项定向回归通过，覆盖连接持久化、断线恢复、事件顺序、显式断开、继承连接不产生假轮次，以及已停止宿主和未结算任务的区别。协调中心 TypeScript 编译、手机 API 24 签名构建通过。

本机协调中心已经加载新增接口并重启，健康检查 200；无凭据访问新接口返回 401。手机已覆盖安装新版图片 App。设备 B、鸿蒙电脑的节点程序不需要因本次修复更新。

实际手机验证：

1. 使用已保存的展示连接，进入协作模式再改用本机，连接保持可用。
2. 更新后的最终包在本机模式选择手机相册中的树莓样图，192×128；选图即显示在电脑左侧。
3. 手机真实处理生成 768×512 成品，耗时 8039 ms。展示端收到 22 条 PROGRESS，随后 RESULT、FINISH，终态 SUCCEEDED，Windows 不参与计算。
4. 电脑原生展示窗口实际观察到增强阶段高亮、结束后各阶段完成和 1/1 成品。不是预制图片、模拟进度或性能对照结论。

真机轮次 ID：`5cd1e927-2e08-41a7-8875-b6e5fa49670f`。本地证据在 `.test/gpu-execution-view-20261113/local-mode-real-evidence.json`，不包含原图/成品内容。最终安装 HAP 在 `.test/photo-api24-harmony-photo/entry/build/default/outputs/default/entry-default-signed.hap`。

首次继承中心连接码的协议通过回归验证；此次实机使用已有保存的展示连接。此轮没有再次完成多设备协作计算基准，不能据此宣称协作性能变化。检查中产生的一条 HOST_STOPPED 失败记录保留，成功记录不会掩盖失败记录。

## 用户操作

电脑打开协调中心的“真机任务展示”，保持页面打开。手机图片 App 的“仅展示连接”显示已连接后，可直接选图开始本机处理。连接协作空间后再点“改用本机处理”，同一展示连接继续使用。展示页若正在回看历史，点“跟随最新一轮”。只有主动清空并断开/更换展示端时才需要新二维码。

此次更新重启了 Windows 中心，遵循已确定的每次启动重新配对流程。继续协作测试前，各设备重新配对当前中心，图片 App 重新授权当前空间；仅展示连接不等于参与协作计算。

## 合并注意

中心发布必须同时包含 `app.js` 与 `photo-display-connection.js`；不可只拷贝新增路由的调用方。不要重新把展示身份绑定到计算模式；不要在每次模式切换时清空展示邀请。不能把断开后的旧进度恢复宣称为完整实时记录：网络中断期间丢失的事件不会伪造补齐，下次选图/开始建立新一轮。
