# Linglish

Linglish 是一个可自行部署的英语学习项目，包含桌面和移动端页面：视频跟读、字幕练习、生词复习、学习统计、学习小组，以及可选的 AI 发音指导与角色对话。

本仓库提供应用源码、测试、数据库结构迁移和虚构的演示种子数据。示例音频是合成测试音，实际练习素材由部署者自行导入。外部 AI、OAuth、邮件、支付和视频服务需要部署者自行配置。

## 项目结构

- `app/backend/`：Node.js HTTP 服务、PostgreSQL 数据层、任务和 API。
- `app/frontend/`：HTML、CSS、JavaScript 页面，由后端直接提供。
- `docs/db/migrations/`：数据库结构迁移。
- `docs/api/openapi.yaml`：早期核心 API 的参考契约；新增功能以当前路由为准。

## 本地运行

需要 Node.js 22 或更新版本，以及一个空的 PostgreSQL 数据库（本地验证使用 PostgreSQL 16）。

```bash
cd app/backend
npm ci
cp .env.example .env
```

编辑 `.env`：

- `DATABASE_URL`：你的数据库连接串。
- `AUTH_TOKEN_SECRET`：自行生成的随机密钥。可使用 `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`。
- 保留本地地址 `SITE_URL=http://localhost:4000`、`FRONTEND_BASE_URL=http://localhost:4000`。

然后运行：

```bash
npm run db:init
npm start
```

浏览器打开 <http://localhost:4000>。

`db:init` 在空数据库中以事务方式创建基础表；基础表已存在时跳过，在不完整的现有数据库中拒绝运行。服务启动时补充当前辅助表，并插入不含用户账号的虚构种子数据。历史迁移存在重复版本号和可选分支，不要把目录中的所有 SQL 按文件名字典顺序一次性执行。

如果已有 PostgreSQL，可以先创建一个空的 `linglish` 数据库。也可以自行运行官方 PostgreSQL 容器，再把本地连接串填写到 `.env`。数据库密码与签名密钥应由各部署者独立生成。

## 可选服务

- AI：设置 `OPENAI_API_KEY`；默认 API 地址为官方 OpenAI 地址，可通过 `OPENAI_API_BASE` 自行指定兼容服务。
- 邮件：设置 `SMTP_*` 和 `EMAIL_FROM`，用于邮箱验证及密码重置。没有邮件服务时，界面提供部署者支持邮箱作为回退方式；请自行配置 `SUPPORT_EMAIL`。
- Google OAuth：设置自己的客户端 ID、密钥、回调地址，然后启用相应开关。
- 音视频：安装 FFmpeg/FFprobe，或使用依赖提供的 FFmpeg；可通过 `FFPROBE_PATH` 指定 FFprobe。YouTube 导入需要部署者能访问相关服务。
- 单词发音：安装 Python 版 `edge-tts==7.3.1`（例如 `pipx install edge-tts==7.3.1`），并确保服务可以访问 Microsoft Edge 语音服务。支持 `~/.local/bin/edge-tts`、系统路径和独立环境 `/opt/linglish-edge-tts/bin/edge-tts`。词卡默认使用 Ava 美式女声，并跟随会员页选择的朗读音色；手机系统朗读仅在合成或播放失败时备用，且会匹配所选音色的口音。
- OCR / 自定义语音识别：相应服务需要自行部署并填写地址。
- 支付：设置自己的 LemonSqueezy 配置，示例默认不包含商店、产品或支付凭据。

生产部署时请配置自己的 `SITE_URL`、前端地址、允许来源、邮件信息和 HTTPS。服务当前使用内联脚本、兼容旧版密码格式及多项外部集成，公开源码不意味着已经完成生产安全加固；欢迎通过安全报告流程改进。

## 测试

```bash
cd app/backend
npm test
```

多数测试可在没有外部服务的情况下运行。字典相关 PostgreSQL 集成测试在显式设置 `TEST_POSTGRES_URL` 后运行；游戏持久化测试在本机 Docker 可用时自动启动可丢弃的 PostgreSQL 容器，否则跳过。使用可丢弃的本地测试实例，因为测试会创建临时数据库或表。

## 贡献与许可

参见 [贡献指南](CONTRIBUTING.md)、[安全报告](SECURITY.md) 和 [第三方资源说明](THIRD_PARTY_NOTICES.md)。项目源码按 MIT 许可证发布；第三方资源保留各自的许可及署名。
