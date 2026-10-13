# 第三方软件说明

MediaHub 自有平台代码采用 MIT。该许可不覆盖通过平台安装的工具及其运行环境。

首页布局和部分 Agent 标识资源参考 MediaFlow（MIT，Copyright 2026 jerryrenjianxing-sys）；对应许可在本仓库 LICENSE 中保留。Electron（MIT）及 Chromium 第三方许可随平台安装包分发。React（MIT）、Vite（MIT）、TypeScript（Apache-2.0）、electron-builder/electron-updater（MIT）、semver（ISC）、yauzl（MIT）保留原包中的许可。

旧工具使用各自官方发行包，MediaHub 不重新打包这些二进制。MediaFlow 为 MIT；Media Deep Researcher 上游存在非商业学习许可；MediaSail 和捆绑依赖的许可分别适用。使用这些工具前应阅读原项目的许可和说明。

HyperFrames 工具包独立维护逐文件 SHA256、运行环境版本和第三方许可。HyperFrames 上游为 Apache-2.0；Node、Chromium、FFmpeg、GSAP 和字体不被统一重新授权。相应说明见工具包内 licenses 和 manifest.json。平台通过独立进程调用 FFmpeg。
