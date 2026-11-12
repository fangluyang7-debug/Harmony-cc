# 照片展示服务启动失败恢复

检查时协调中心 7443 与启动器 53308 正常，但展示服务 7460 没有监听。此前 C 盘耗尽，展示目录中最新 run JSON 的 `.tmp` 在启动器启动时留下零字节文件；正式 run/session JSON 均完整。这与启动时回写已有成品遇到 ENOSPC 后退出相符，不是清理操作移走页面文件。持久目录 `~/HarmonyRuntime/photo-display` 未被清理。

原 `scripts/runtime-desktop.cjs` 仅在启动器初始化时尝试 startDisplay，失败后 `/display/open` 永久返回 DISPLAY_UNAVAILABLE，磁盘恢复后也不能重试。本轮增加 ensureDisplay：点击打开按钮时按需恢复，复用已运行服务及进行中的启动 Promise，失败后允许重试；保留鉴权、角色、只读展示、options.display=false 语义。返回 display 使用 getter，关闭时也能清理后来恢复的服务。没有修改照片计算、模型或删除历史记录。

新增 `tests/sdk/photo-display-recovery.test.cjs`，模拟首次 ENOSPC 后通过真实 HTTP 打开入口恢复，核对旧成绩保留、不启动计算中心、重复打开不重复监听。展示回归 7 项、启动器回归 8 项，共 15 项通过。

安装目录的 `scripts/runtime-desktop.cjs` 已更新并核对哈希。备份 `.test/photo-display-startup-recovery-backup-20261112/` 包括旧代码和原 display session。安装标记 `PATCH-PHOTO-DISPLAY-RECOVERY.json`。正常关闭并重启桌面应用；重启前没有进行中任务，已接入的设备需要重新配对。

桌面应用内已打开“真机任务演示 · 单机与协同”，历史图片显示正常，页面及主要 JS/CSS 全部 HTTP 200。手机原有仅展示连接 key、最后 runId 和历史隐藏范围均保留。协调中心 PID 32560、新会话 `desktop-172.20.10.6-riszbo`，证书校验健康返回 ready:true；展示 `/runs` 已自动连接新中心，connected:true、error 为空。

页面：`http://127.0.0.1:7460/`。以后遇到可恢复的启动失败，释放空间或端口后点击启动器“打开真机任务展示”即可重试，无需再重启中心。本轮未提交或推送。
