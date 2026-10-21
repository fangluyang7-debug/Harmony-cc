# 本地历史归档

`legacy-submission-packages/` 完整保存迁移前 `提交文件/competition-deliverables/` 中的子目录和旧 ZIP，包括多轮 `clean`、`final`、`v2`、`v3` 源码副本。

为使 Git 主线只有一份当前源码，这些重复快照不进入 Git。它们保留在本次迁移的本机目录中，原目录也未删除。文件映射、大小和 SHA-256 保存在 `docs/migration/Harmony-cc-copy-manifest.json`。需要转移这些历史包时单独复制本目录。

当前源码和构建以仓库根目录为准；参赛正式文档、视频与保留的 HAP/HAR 见 `提交文件/`。
