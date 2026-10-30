# 流水线说明（heihu520/beayy_heihu-）

本 fork 的 GitHub Actions 覆盖：**CI 检查**、**上游同步**、**桌面构建/发版**、**服务端 Docker 镜像**、**iOS TestFlight 骨架**。  
**不改应用品牌与业务代码**（bundle id、产品名等仍与上游一致；产品化改造另开 PR）。

## 工作流一览

| 文件 | 触发 | 作用 |
|------|------|------|
| `.github/workflows/ci.yml` | PR、push `main` | macOS + Windows：`fmt` / `clippy` / `test`；Ubuntu：Python 服务端轻量检查 |
| `.github/workflows/upstream-sync.yml` | 每 6 小时 cron + 手动 | 拉 `hengfengliya/beayy` → 分支 `upstream-main` → 开/更新进 `main` 的 PR；冲突会失败并评论 |
| `.github/workflows/build-desktop.yml` | 手动、push `main`、tag `v*` | 未签名 macOS `.app` zip + Windows exe zip；**tag 时**建 GitHub Release |
| `.github/workflows/docker.yml` | push `main`/`v*`（`server/**`）+ 手动 | 推 `ghcr.io/<owner>/beayy-server` |
| `.github/workflows/ios-testflight.yml` | 仅手动 | Secrets 未齐则跳过；齐了可 dry-run 生成 Xcode 工程 |

## 相对上游的变化

上游只有手动触发的 [`.github/workflows/windows.yml`](https://github.com/hengfengliya/beayy/blob/main/.github/workflows/windows.yml)（`cargo build -p beayy` + zip）。  
**合并本流水线时请删除 `windows.yml`**：能力已由 `build-desktop.yml` 的 Windows job 覆盖（同样打 `Beayy-windows-x64-*.zip`，并增加版本号与 Release）。

上游 `src-tauri/tauri.conf.json` 里 **`bundle.active: false`**，正式产物不靠 `tauri build`，而是 `cargo build --release -p beayy` 再自组安装包（见根目录 `build.sh`）。因此桌面流水线**不用** `tauri-apps/tauri-action`；若以后打开 bundle，再改接 `@v1` 即可。

## CI 细节

- **不做 Linux 桌面构建/测试**：`beayy-capture` 仅有 macOS / Windows 实现。
- Clippy / test 使用 `--workspace --exclude beayy-mobile`（`mobile` 是给 iOS 的 staticlib）。
- Python：安装 `server/requirements.txt`，`compileall` + 导入 `server` / `syncapi` / `usage` / `admin`。

## 上游同步与 GH_PAT

默认 `GITHUB_TOKEN` **不能**推送会改写 `.github/workflows/*` 的提交。若上游改了 workflow，同步 push 会失败。

1. 在 GitHub → Settings → Developer settings → Personal access tokens（classic）新建 token，勾选 **`repo`** + **`workflow`**。
2. 在本仓库 Settings → Secrets and variables → Actions 新增 **`GH_PAT`**。
3. `upstream-sync` 会优先用 `GH_PAT`；未配置时打 warning，仅适合不含 workflow 变更的同步。

冲突策略：`upstream-main` 强制对齐上游 tip，对 `main` 开 PR。若不可合并，job **失败**并在 PR 留评论（不静默成功）。

## 桌面发版

```text
git tag v0.2.40
git push origin v0.2.40
```

会跑 `build-desktop`，创建 Release，挂上：

- `Beayy-macos-x64-<version>.zip`
- `Beayy-windows-x64-<version>.zip`

默认**未签名**。可选配置 macOS 签名 Secrets：

- `APPLE_CERTIFICATE`（p12 的 base64）
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`（如 `Developer ID Application: …`）
- `APPLE_TEAM_ID`

## Docker

镜像：`ghcr.io/heihu520/beayy-server`（owner 会按仓库所有者小写生成）。  
上下文：`server/`，Dockerfile：`server/Dockerfile`，端口 8770。  
首次拉取若 403：在 GitHub Packages 确认包可见性，或 `docker login ghcr.io`。

## iOS TestFlight（骨架）

配置齐后再手动跑：

- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER_ID`
- `APPLE_API_KEY_P8`
- 可选 `IOS_TEAM_ID`

默认 `dry_run=true`：XcodeGen 生成工程，不上传。实际上传步骤仍是占位，需按你们的签名与 bundle id 补全。

## 建议的下一步（产品化，不在本 PR）

1. 换 bundle id / 团队 ID / 域名与自动更新地址。  
2. 厘清 LICENSE（根目录 MIT vs `Cargo.toml` 的 UNLICENSED）。  
3. 打开 Tauri bundle 或保留自组包策略，并接上真正的公证 / Windows 签名。  
4. 把 iOS 骨架补成可上传 TestFlight 的 fastlane / `xcodebuild`。
