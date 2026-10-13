# MediaHub

Windows 本地媒体工具工作台：先安装平台，再按需安装工具。界面和 Agent 使用同一套工具、项目、素材、任务与成果管理入口。

这是未签名的 Windows x64 预览版。安装器和 ZIP 在 [Releases](https://github.com/jerryrenjianxing-sys/MediaHub/releases) 下载；平台安装包不包含四套工具。

## 首轮接入

| 工具 | 首轮管理方式 |
| --- | --- |
| MediaFlow | 识别已有安装、下载原发行包、检查实际安装身份及版本、打开；更新和卸载进入原软件 |
| Media Deep Researcher | 同上；保留原软件的非商业学习许可 |
| MediaSail | 同上；保留原账号、浏览器会话和业务数据 |
| HyperFrames | 独立下载的完整组件；平台负责安装、启动、更新、恢复和卸载 |

三个旧工具继续独立发行。MediaHub 不自动移动它们的数据库或登录资料。界面明确标明“由原软件管理”，不会把打开入口当作更新或卸载成功。

## 使用

1. 安装平台或解压 ZIP，打开 MediaHub，选择共享工作空间。
2. 在“工具”中按需安装。下载完成后校验哈希、实际文件与健康状态。
3. 首页复制 Agent 接入说明，或下载总 Skill 给自己使用的 Agent。首次连接只读检查，不自动改写全局配置。
4. 创建项目、登记素材、调用已安装工具。HyperFrames 支持横屏和竖屏、源文件编辑后刷新、静态及浏览器检查、1080p / 30fps SDR MP4 导出。

HyperFrames 工具包自带 Node、Chrome headless shell、FFmpeg / FFprobe、本地 GSAP 和中文字体。安装后创建、预览、检查和导出使用本地文件。首版一次只运行一个渲染任务。Studio 提供工程预览、播放控制和源文件编辑；上游完整可视化时间线编辑器不属于此版功能。

关闭窗口会进入托盘。明确退出时可以等待任务完成，或取消后退出；任务取消必须收到实际进程停止回执。异常退出后未知任务标记为中断，不自动重放。卸载 HyperFrames 保留工作空间、素材和成果。

## 数据与 Agent

- 平台配置、SQLite 索引及组件：`%LOCALAPPDATA%\MediaHub`。
- 工作空间独立选择，默认建议 Documents 下 `MediaHubWorkspace`；项目、素材和成果元数据为 JSON。
- 主进程集中管理；渲染界面通过有限 preload 调用，Agent 通过当前用户专用本地命名管道和随包 PowerShell 客户端调用。
- 总 Skill 的 `policy.allow_implicit_invocation: false` 保持不变。详细工具资料按需读取。
- Studio、生成页面与平台界面隔离来源和会话；生成内容没有平台管理凭据或接口。

参见 [总设计](docs/architecture.md)、[Agent 协议](agent-skill/mediahub/references/platform.md)、[HyperFrames 工具包](tools/hyperframes/README.md) 和 [验收记录](docs/acceptance.md)。

## 开发

固定 Electron 44.7.0、electron-builder 26.17.0、electron-updater 6.8.10、React 19.2.6、Vite 8.0.13、TypeScript 5.9.3，提交锁文件。开发需 Windows x64 与 Node 24.21.0；Win32 辅助程序由 Windows CI / MSVC 编译。

```powershell
npm ci
./scripts/build-native.ps1 -OutputDirectory ./build/native
npm test
npm run dist
```

HyperFrames 独立工具包的构建需要它自己的锁文件和已核验的运行环境；不能把本机任意 FFmpeg 直接打入公开包。FFmpeg 对应源码、固定提交、构建脚本和许可证随组件分发，详见 [构建说明](tools/ffmpeg-source/README.md)。

平台与工具包使用独立发行标签。`distribution` 分支提供签名工具目录和独立平台更新源；发布工具不改变平台最新版本。平台启动检查更新，由用户选择下载与安装。见 [发行流程](docs/releases.md)。

MediaHub 自有代码为 MIT。各工具及依赖保留各自许可，详见 [第三方说明](THIRD_PARTY_NOTICES.md)。
