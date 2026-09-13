# CoTeach

![CoTeach 横版标识](public/brand/coteach/horizontal-color.png)

CoTeach 是面向项目式学习（PBL）的 AI 协同教学平台。名称中的 “Co” 代表共同参与，系统让教师、学生与 AI 围绕真实问题共同设计、实践、反馈与反思，并把长期课程、课堂活动、AI 备课、五阶段项目课堂、学习成果与研究数据连接在同一条教学链路中。

横版、深蓝横版、图形标与竖版组合的使用规则见[品牌资源说明](docs/brand.md)。

当前版本以 **V2 课程平台**为唯一业务入口，面向“单台云服务器、2–3 名教师、50–80 名学生同时在线”的部署规模设计。生产环境采用模块化单体：Next.js 应用和代码运行器由 systemd 托管，PostgreSQL、Redis、Nginx、监控与备份组件由 Docker Compose 管理。

> V2 是全新的数据库模型。迁移 `20260908090000_v2_database_rebuild` 会删除旧业务表；旧用户、旧课程、旧 ID 和旧 JSON 数据不会自动迁移。升级已有环境前必须先备份，并阅读[数据库说明](docs/database-v2.md)和[生产部署文档](deploy/README.md)。

## 2026-09-09 版本摘要

- **统一 V2 门户**：教师从 `/teacher/classes` 管理教学班，学生从 `/student` 查看已加入课程；旧版 `/api/courses` 等课程接口已退役并返回 `410 V2_ROUTE_REQUIRED`。
- **长期课程结构**：课程由教学班、章节和活动组成，活动支持课堂、作业、测验、问卷和资料；活动开放状态与学生进度独立保存。
- **课堂库与真实开课分离**：教师在课程库生成或编辑可复用课堂模板，发布后形成不可变版本；每次开课创建独立课堂场次与学生参与记录。
- **结构化问卷闭环**：教师可编排单选题和简答题、调整顺序并设置必答；学生在沉浸式答题页提交或更新回答；教师端准实时展示完成率、选项比例和简答词云，并支持全屏轮播。
- **V2 五阶段课堂**：AI 学习、项目实践、成果提交、展示评价和学习反思已绑定课堂场次与参与记录，避免把运行状态写回课堂模板。
- **AI 与过程证据留存**：AI 对话、任务、操作确认、动态支架、教学干预、成果版本和评价分别持久化，失败不会伪造成模型回答。
- **研究数据导出**：学习事件、普通活动提交、成果、AI 交互和领域事件可按教学班分页导出；默认不包含姓名、用户 ID 和自由文本。
- **单系统部署**：旧版并行版本与蓝绿应用容器已移除。生产应用使用不可变 systemd 发布目录，Docker 只承载基础设施。

## 核心能力

### 教师端

- 创建和管理教学班、课程主页、学期、日期、封面与开放状态。
- 生成课程邀请码，管理学生名单和课程访问，按需重置学生密码。
- 按章节组织课堂、作业、测验、问卷和学习资料，并分别控制开放状态。
- 在独立课程库中创建普通课堂或完整 PBL 课堂，通过 AI 生成、导入、预览、资源检查和版本发布完成备课。
- 启动和结束课堂场次，查看学生参与、阶段进度、学习信号、AI 协作过程、成果和评价。
- 创建结构化问卷并在课堂中查看准实时统计、选项分布、简答内容和关键词词云。
- 在设置页管理模型、搜索、语音和媒体 Provider；凭据加密保存在 PostgreSQL。
- 按教学班导出可分页、可限定时间窗口的研究数据。

### 学生端

- 注册或登录学生账号，使用邀请码加入一个或多个课程。
- 在课程主页查看章节路径、开放活动、学习进度和待继续任务。
- 完成作业、测验、问卷、资料学习和课堂活动；提交后仍可按活动规则更新回答。
- 进入 AI 授知课堂，使用项目工作台与 AI 组员协作文档或代码成果。
- 保存过程证据、成果版本、展示材料、评价确认和个人反思。
- 断线重连后恢复活动与课堂状态，学习事件继续写入所属课程和参与记录。

### 结构化问卷

问卷作为 `FORM` 活动保存，不新增独立业务表：题目定义存入 `Activity.config`，学生当前回答存入 `ActivityProgress.progressData`，提交历史由 `ActivitySubmission` 留存。

- 每份问卷支持 1–30 题。
- 题型支持单选题和简答题；单选题支持 2–10 个选项。
- 题目可排序、删除，并可单独设置是否必答。
- 服务端校验题目标识、选项标识和学生选项，拒绝缺失必答题或伪造选项。
- 教师统计页每 4 秒刷新；单选题显示人数与比例，简答题生成高频词云并保留原始回答查看入口。

### 课堂、AI 与成果

系统保留完整 PBL 五阶段学习路径：

1. **项目启动**：理解情境、驱动问题和项目目标。
2. **AI 授知**：通过 AI 课件、问答、检测和自适应资源建立基础知识。
3. **项目实践**：在文档或代码工作台中与 AI 组员协作，迭代方案和作品。
4. **成果汇报与评价**：提交成果版本、申请展示并完成教师、同伴或 AI 辅助评价。
5. **学习反思**：回顾学习证据、AI 使用决策和可迁移经验。

模板设计、课堂场次、学生参与、成果版本和评价采用独立实体。已发布的模板版本不可被授课操作静默覆盖，再次开课会保留上一场课堂历史。

### 数据、安全与研究留存

- V2 使用统一 `User` 身份、课程选课关系和数据库会话版本；教师与学生接口按角色和资源归属校验。
- 教学班、章节、活动和课堂场次使用版本或事务锁保护关键写入，避免并发覆盖和重复提交。
- Provider 密钥使用 AES-256-GCM 加密，密码使用 Argon2id，JWT 固定算法、issuer、audience 和会话版本。
- 上传文件经过大小、类型、文件头和资源归属校验；下载使用受权资源地址。
- `LearningEvent`、`AiInteractionEvent` 和 `DomainEvent` 采用追加写入，研究键是可关联的假名标识，不应视为完全匿名数据。
- 研究导出默认排除姓名、用户 ID 和自由文本；只有明确使用 `includeContent=true` 时才包含回答或事件正文。

## 业务数据主链

```mermaid
flowchart LR
    U["User 用户"] --> E["Enrollment 选课"]
    E --> O["CourseOffering 教学班"]
    O --> C["Chapter 章节"]
    C --> A["Activity 活动"]
    A --> P["ActivityProgress / ActivitySubmission"]
    T["ClassroomTemplate 课堂模板"] --> V["不可变模板版本"]
    V --> I["ClassroomInstance 课堂场次"]
    A --> I
    E --> CP["ClassroomParticipation 课堂参与"]
    I --> CP
    CP --> R["成果 · AI · 评价 · 反思 · 事件"]
```

PostgreSQL 当前包含 45 张正式业务/基础设施表。完整表清单、字段职责、唯一约束和关系说明见 [CoTeach V2 数据库设计](docs/database-v2.md)。

## 系统架构

```mermaid
flowchart LR
    B["教师端 / 学生端"] --> N["Nginx · HTTPS"]
    N --> A["Next.js 16 应用 · systemd"]
    N --> W["WebSocket / tldraw 同步"]
    A --> D["PostgreSQL 16"]
    A --> R["Redis 7"]
    W --> R
    A --> F["上传、课堂与媒体文件"]
    A --> C["代码运行器 · systemd"]
    D --> PB["pgBackRest / S3"]
    F --> RB["Restic / S3"]
    A --> M["Prometheus / Grafana"]
```

生产环境只有 Nginx 对公网开放 `80/443`。应用、数据库、Redis、WebSocket、代码运行器和监控端口均应限制在内部网络或服务器回环地址。

## 技术栈

| 层级 | 主要技术 |
| --- | --- |
| Web | Next.js 16.2、React 19、TypeScript、Tailwind CSS 4 |
| UI | Radix UI、Plate、Monaco Editor、ECharts、Visx、tldraw |
| 数据 | PostgreSQL 16、Prisma 6、Redis 7 |
| AI | Vercel AI SDK、OpenAI/Anthropic/Google/Azure/Bedrock 适配器、兼容 OpenAI 的 Provider |
| 课堂内容 | OpenMAIC DSL / Importer / Renderer、PptxGenJS、PDF/PPTX 预览、持久生成任务与检查点 |
| 实时协作 | WebSocket、Redis Pub/Sub、课程事件、tldraw sync |
| 验证 | Vitest、Playwright、k6、ESLint、TypeScript |
| 运维 | systemd、Docker Compose、Nginx、Prometheus、Grafana、pgBackRest、Restic |

## 目录结构

```text
CoTeach/
├─ src/
│  ├─ app/
│  │  ├─ teacher/                 # 教师门户、课程库、教学班与课堂
│  │  ├─ student/                 # 学生课程、活动、AI 学习与项目工作台
│  │  └─ api/platform/            # V2 账号、教学班、活动、模板和课堂 API
│  ├─ components/platform/        # V2 门户、问卷、课堂和通用反馈组件
│  └─ lib/
│     ├─ platform/                # V2 权限、仓储、提交、问卷和研究导出
│     ├─ course-design/           # AI 课程设计与恢复任务
│     ├─ course-generation/       # 课堂生成、资源审计与检查点
│     ├─ openmaic/                # OpenMAIC 生成、播放和 Provider 服务
│     ├─ realtime/                # WebSocket、事件游标与白板同步
│     └─ uploads/                 # 文件校验、归属与清理
├─ prisma/                        # V2 Schema 与数据库迁移
├─ packages/@openmaic/            # DSL、PPTX 导入与课堂渲染器
├─ tests/load/                    # k6 并发与稳定性测试
├─ e2e/                           # Playwright 浏览器流程
├─ deploy/                        # systemd、Nginx、证书、监控与备份
├─ scripts/                       # 数据库、验证、初始化和清理脚本
├─ docker-compose.yml             # 本地完整容器环境
├─ docker-compose.prod.yml        # 生产基础设施
└─ Dockerfile                     # 应用和迁移镜像
```

`.next-build/`、`.openpbl-runtime/`、`.openpbl-data/`、`data/classrooms/`、测试报告和其他运行期产物不应提交到版本库。

## 环境要求

- Node.js 22
- pnpm 10.4.1
- PostgreSQL 16
- Redis 7
- Docker Engine / Docker Desktop（推荐用于本地数据库和 Redis）
- LibreOffice（可选，仅用于受控的 PPTX → PDF 预览转换）

生产建议使用 Ubuntu 24.04、4 vCPU、8 GB 内存和 100 GB 以上 SSD，并配置 S3 兼容对象存储用于异地备份。

## 本地开发

### 1. 安装依赖

```bash
pnpm install --frozen-lockfile
```

`postinstall` 会构建工作区包、同步 OpenMAIC 浏览器导入器并生成 Prisma Client。

### 2. 配置环境变量

Linux/macOS：

```bash
cp .env.example .env.local
```

Windows PowerShell：

```powershell
Copy-Item .env.example .env.local
```

本地最小配置：

```dotenv
POSTGRES_PASSWORD=replace-with-a-local-password
DATABASE_URL=postgresql://openpbl:replace-with-a-local-password@localhost:5432/openpbl
REDIS_URL=redis://localhost:6379
PUBLIC_BASE_URL=http://localhost:3000
JWT_SECRET=replace-with-a-long-random-secret
PROVIDER_ENCRYPTION_KEY=replace-with-a-base64-encoded-32-byte-key
INTERNAL_MONITOR_TOKEN=replace-with-at-least-32-characters
TRUST_PROXY_HEADERS=false

COURSE_GENERATION_BACKGROUND_ENABLED=false
PARALLEL_SCENE_CONCURRENCY=4
COURSE_GENERATION_LLM_CONCURRENCY=4
OPENMAIC_NATIVE_CLASSROOM_TOOLS=true

ENABLE_WEBSOCKET=true
WEBSOCKET_PORT=3001
NEXT_PUBLIC_WEBSOCKET_URL=ws://localhost:3001
```

可用以下命令分别生成 JWT 密钥和 32 字节 Provider 加密密钥：

```bash
openssl rand -base64 48
openssl rand -base64 32
```

真实 AI 生成可在教师设置页配置 Provider，也可在 `.env.local` 中设置 `OPENPBL_LLM_ENDPOINT`、`OPENPBL_LLM_API_KEY` 和 `OPENPBL_LLM_MODEL`。未配置模型时，账号、课程、普通活动、问卷和数据库流程仍可开发验证。

### 3. 启动基础设施并应用迁移

```bash
docker compose --env-file .env.local up -d postgres redis
pnpm db:generate
pnpm db:migrate:prod
pnpm db:status
```

V2 需要 PostgreSQL；旧 JSON 兼容存储不构成可用的 V2 开发环境。不要运行 `docker compose down -v`，除非已经确认可以删除数据库和所有持久卷。

### 4. 启动应用

```bash
pnpm dev
```

常用入口：

- 首页：<http://localhost:3000>
- 教师登录：<http://localhost:3000/teacher/login>
- 首次教师注册：<http://localhost:3000/teacher/register>
- 学生入口：<http://localhost:3000/student>

数据库中没有教师时，可以通过注册页创建首个教师并自动登录。也可以使用命令行初始化：

```bash
OPENPBL_INITIAL_TEACHER_PASSWORD='replace-with-a-strong-password' \
  pnpm admin:init-teacher --username teacher --display-name '教师'
```

该命令只允许在数据库中尚无教师时执行，密码长度必须为 12–256 个字符。

## 基本使用流程

### 教师

1. 登录后进入 `/teacher/classes`，创建教学班并完善课程主页。
2. 在“访问设置”中生成课程邀请码，将邀请码发送给学生。
3. 建立章节，并添加课堂、作业、测验、问卷或资料活动。
4. 课堂活动先在 `/teacher/templates` 创建并发布模板版本，再关联到教学班章节。
5. 开放教学班、章节和活动；课堂活动开始后进入教师控制台查看参与情况。
6. 问卷活动从教学班页面进入实时统计；普通课堂从场次页面查看阶段、成果与学习记录。
7. 实验或研究结束后，从教学班研究接口分页导出所需数据。

### 学生

1. 在 `/student/register` 创建账号，或在 `/student/login` 登录。
2. 在 `/student` 输入教师提供的邀请码加入课程。
3. 从课程主页进入已开放的活动，完成作业、测验、问卷、资料或课堂学习。
4. 在课堂内完成 AI 学习、项目协作、成果提交、展示评价和个人反思。
5. 返回课程主页查看已完成项目和下一项开放任务。

## V2 平台 API

| 接口 | 用途 |
| --- | --- |
| `/api/platform/auth/*` | 学生/教师登录注册、邀请码加入和密码重置 |
| `GET/POST /api/platform/offerings` | 查询或创建教学班 |
| `PATCH /api/platform/offerings/:id` | 更新课程主页与开放状态 |
| `/api/platform/offerings/:id/chapters` | 创建章节与章节活动 |
| `/api/platform/activities/:id` | 读取、更新、归档活动 |
| `POST /api/platform/activities/:id/submit` | 提交或更新普通活动、测验和问卷回答 |
| `GET /api/platform/activities/:id/survey-results` | 获取教师可见的问卷实时统计 |
| `/api/platform/templates` | 管理课堂模板、PBL 模板和不可变版本 |
| `/api/platform/classroom-instances/:id/*` | 进入、开始、结束课堂并读取参与者 |
| `/api/platform/participations/:id/*` | 保存课堂参与、AI 协作和成果 |
| `POST /api/platform/events` | 追加学生学习事件 |
| `GET /api/platform/offerings/:id/research-export` | 分页导出研究数据 |

业务客户端应使用 `/api/platform/*`。旧 `/api/auth/login|register|join`、`/api/courses/*` 和旧压测写入接口属于退役入口，不应重新接入；`/api/auth/me` 等仍被 V2 设置页使用的身份接口不在此列。

## 数据库迁移说明

V2 主链为 `User → Enrollment → CourseOffering → Chapter → Activity`，课堂链路为 `ClassroomTemplate → ClassroomTemplateVersion → ClassroomInstance → ClassroomParticipation`。

- `20260908090000_v2_database_rebuild`：删除旧模型并建立 45 张 V2 表，是破坏性迁移。
- `20260908120000_research_integrity`：补充活动提交、学习事件和研究数据完整性。
- `20260908150000_v2_classroom_research`：补充课堂、AI、领域事件的研究键、索引和删除保护。
- 结构化问卷复用 `Activity`、`ActivityProgress` 和 `ActivitySubmission`，无需新增迁移。

生产迁移前必须备份 PostgreSQL、上传文件、课堂数据和环境 Secret，并保留原 `PROVIDER_ENCRYPTION_KEY` 与 `JWT_SECRET`。V2 不提供旧用户、旧课程或旧 JSON 导入命令。

## 测试与质量检查

常规检查：

```bash
pnpm typecheck
pnpm lint:ci
pnpm test:ci
pnpm exec prisma validate
pnpm build
```

V2 数据与浏览器链路：

```bash
pnpm test:db:research
OPENPBL_VERIFY_BROWSER=1 pnpm test:db:research
pnpm playwright:install
pnpm test:e2e
```

问卷相关定向回归：

```bash
pnpm exec vitest run \
  src/lib/platform/survey.test.ts \
  src/lib/platform/submissions.test.ts \
  'src/app/student/activities/[activityId]/page.test.tsx' \
  'src/app/teacher/classes/[offeringId]/page.test.tsx'
```

云端 k6 压测套件及固定负载场景见 [tests/load/README.md](tests/load/README.md)。不要在开发电脑或正式生产数据上直接运行并发、压力或长稳场景。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 启动本地开发服务器 |
| `pnpm build` / `pnpm start` | 创建并启动生产构建 |
| `pnpm typecheck` | 生成 Next 类型并执行 TypeScript 检查 |
| `pnpm lint:ci` | 执行 ESLint，禁止警告 |
| `pnpm test:ci` | 使用最多两个 worker 运行 Vitest |
| `pnpm test:e2e` | 运行 Playwright 浏览器测试 |
| `pnpm test:db:research` | 在隔离 PostgreSQL 中验证 V2 数据与研究链路 |
| `pnpm db:generate` | 生成 Prisma Client |
| `pnpm db:migrate` | 创建或应用开发迁移 |
| `pnpm db:migrate:prod` | 应用已有生产迁移 |
| `pnpm db:status` | 检查迁移状态 |
| `pnpm db:studio` | 打开 Prisma Studio |
| `pnpm admin:init-teacher` | 初始化首个教师账号 |
| `pnpm cleanup:uploads` | 清理孤立上传文件 |

## 生产部署

生产环境只运行一套应用。推荐流程：

1. 备份 PostgreSQL、上传文件、课堂数据和部署配置。
2. 执行 `pnpm install --frozen-lockfile` 和 `pnpm build`。
3. 执行 `pnpm db:migrate:prod` 并确认 `pnpm db:status` 无待处理迁移。
4. 启动或更新 PostgreSQL、Redis 和 Nginx 基础设施。
5. 安装或更新 `deploy/systemd/` 中的应用与代码运行器服务，执行 `systemctl --user daemon-reload` 后重启。
6. 检查 `/api/health/live`，再完成教师登录、学生加入、问卷提交和五阶段课堂冒烟测试。

`pnpm start` 会从 `.next-build` 创建 `.openpbl-runtime/releases/<BUILD_ID>` 不可变运行目录，避免后续构建覆盖当前服务。完整 Secret、证书、监控、备份、CI/CD 和恢复要求见 [deploy/README.md](deploy/README.md)。

## 常见问题

### 旧接口返回 `410 V2_ROUTE_REQUIRED`

浏览器或代码仍在调用旧 `/api/auth/login|register|join` 或 `/api/courses/*`。刷新已打开的旧页面并重新登录；自定义客户端需要迁移到 `/api/platform/*`，不要恢复已经删除的旧数据模型。

### Prisma 报错 P6001

本项目使用普通 PostgreSQL URL，不应把 `DATABASE_URL` 改为 `prisma://`。重新生成带本地查询引擎的客户端：

```bash
pnpm db:generate
pnpm db:status
```

### 表或字段不存在

先确认 `DATABASE_URL` 指向预期数据库，再执行：

```bash
pnpm db:migrate:prod
pnpm db:status
```

不要手工建表绕过 `prisma/migrations/`。

### 教师或学生页面持续返回 401

V2 JWT 包含数据库会话版本。数据库重建、密码重置或旧 Cookie 都可能使会话失效；退出后从对应的 V2 登录页重新登录即可。

### AI 生成或 Provider 测试失败

- 检查教师设置页是否显示“密钥已保存”，并确认 Provider 地址、模型标识和 API 权限。
- 本地确认 `DATABASE_URL`、`PROVIDER_ENCRYPTION_KEY` 和模型环境变量正确。
- 生产环境必须保留原 `PROVIDER_ENCRYPTION_KEY`；更换后已有密钥无法解密。
- 本地默认 `COURSE_GENERATION_BACKGROUND_ENABLED=false`；需要验证离页恢复时再显式启用。

### 问卷没有统计数据

依次确认活动类型为问卷、题目配置完整、教学班/章节/活动均已开放，并且学生已提交。统计只计入当前教学班中状态有效且已完成该活动的学生；教师必须拥有该教学班权限。

## 进一步文档

- [V2 数据库设计](docs/database-v2.md)
- [V2 功能适配与验证](docs/database/v2-function-adaptation.md)
- [研究数据完整性](docs/database/research-integrity.md)
- [研究数据导出](docs/database/research-export.md)
- [生产部署](deploy/README.md)
- [备份与恢复](deploy/backup/README.md)
- [开发与验证工作流](docs/agent-workflow.md)
- [设计系统](DESIGN-SYSTEM.md)
- [OpenMAIC 上游同步说明](docs/openmaic-upstream.md)
- [架构决策记录](docs/adr)
