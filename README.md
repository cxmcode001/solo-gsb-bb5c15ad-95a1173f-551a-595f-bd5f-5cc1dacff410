# 地震台站到时拾取审阅台

FastAPI + SQLite + **原生 TypeScript**（无前端框架）实现的单页 Web 应用，用于审阅地震台站
P / S 波到时拾取：导入带时间戳的波形采样 JSON，按台站绘制可缩放波形，人工添加/调整到时及
±不确定窗，系统按**区间重叠规则**自动标出冲突，并对每个 `(台站, 相型)` 给出
**逆方差加权共识到时**，支持逐条接受 / 拒绝 / 撤销，最后导出审阅结果（JSON / CSV）。

## 一条命令启动

```bash
docker compose up --build
```

打开浏览器访问 <http://localhost:8000>，点击右上角 **「内置样例」** 即可加载一个
4 台站、12 道波形、预置 14 条拾取（含一致共识、区间冲突、已拒绝离群值）的演示数据集。

SQLite 数据库持久化在 Docker 卷 `picker-data`（容器内 `/data/picker.db`）。

> 停止：`docker compose down`；连同数据一起清除：`docker compose down -v`

## 功能一览

| 区域 | 能力 |
| --- | --- |
| 波形视图 | 每个台站一张卡片，同站多道（BHZ/BHN/BHE）堆叠、共享时间轴；滚轮以光标为中心缩放，拖拽平移；顶部按钮缩放/复位；勾选「联动」后所有台站窗口同步 |
| 添加拾取 | 选择 **+ P / + S** 放置模式，在波形上点击创建（Esc 或再按按钮取消）；作者名与默认 ±不确定窗在工具栏配置（localStorage 记忆） |
| 编辑拾取 | 拖线移动到时，拖两端短柄调整 ±不确定窗（松手自动保存）；双击拾取线在右栏打开详情，可精确编辑相对秒数、不确定窗、相型、通道、作者 |
| 审阅 | 每条拾取可 **✓ 接受 / ✗ 拒绝 / 撤销决定 / 删除**；状态用实线/虚线与颜色区分 |
| 冲突检测 | 同一 `(台站, 相型)` 下，若两条非拒绝拾取的不确定窗**互不相交**（`|Δt| > u₁+u₂`，端点相触算重叠），即判为冲突，波形上标红，右栏列出间隔秒数并可跳转 |
| 加权共识 | 右栏给出每个 `(台站, 相型)` 的共识到时、±标准差、基集大小、每条拾取的归一化权重与偏差 |
| 导入/导出 | 上传波形 JSON（可携带预置拾取）；导出完整审阅 JSON 或 CSV（含状态、权重、是否在基集/冲突中、共识到时） |

## 共识与冲突规则

- **基集（basis）**：若该组存在「已接受」拾取，则只以已接受拾取为基集；否则以所有
  「待审」拾取为基集；已拒绝拾取永不参与。`n` 基集 / `N` 总数直接显示在徽章上。
- **权重**：逆方差（不确定窗）权重 `wᵢ = 1 / max(uᵢ, ε)²`，归一化后展示百分比。
- **共识到时**：加权均值 `t̄ = Σwᵢtᵢ / Σwᵢ`。
- **不确定度**：内误差 `σ_in = 1/√Σwᵢ`；当拾取间离散度大于各自不确定窗预期时，按
  Birge 比率 `R = √(χ²/(n−1))` 放大，报告 `σ = σ_in · max(1, R)`（单条时 `R=1`）。
- **一致性**：基集内是否存在区间冲突。非基集拾取参与冲突列表展示（标记「非基」），
  但不影响共识一致性结论。

## 波形 JSON 格式

导入文件（`POST /api/datasets/import`）示例：

```json
{
  "name": "事件 2026-09-22T08:00Z",
  "source": "可选来源说明",
  "startTime": "2026-09-22T08:00:00Z",
  "channels": [
    {
      "station": "STA01",
      "channel": "BHZ",
      "startTime": "2026-09-22T08:00:00Z",
      "sampleRate": 100.0,
      "samples": [0.0012, -0.0034, 0.0051]
    }
  ],
  "picks": [
    {
      "station": "STA01",
      "channel": "BHZ",
      "phase": "P",
      "time": "2026-09-22T08:00:04.02Z",
      "uncertainty": 0.15,
      "author": "STA/LTA-auto",
      "status": "pending"
    }
  ]
}
```

说明：

- `startTime` 支持 ISO-8601（建议 UTC 带 `Z`）；顶层可省略，取各道最早起始时间。
- `samples` 为等间隔浮点采样，道时长 = `(nSamples − 1) / sampleRate`。
- `picks` 可省略；`channel` 可省略（视为台站级拾取）；`status` 默认 `pending`。
- 同数据集内 `(station, channel)` 不可重复；拾取引用的台站必须存在对应道。
- 仓库内置样例由 `python backend/scripts/generate_sample.py` 重新生成（Ricker
  子波 + 低通噪声，确定性随机种子）。

## HTTP API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/samples` | 内置样例列表 |
| POST | `/api/samples/{file}/import` | 导入内置样例 |
| GET | `/api/datasets` | 数据集列表 |
| POST | `/api/datasets/import` | 导入波形 JSON |
| GET | `/api/datasets/{id}` | 数据集详情（含全部道与拾取） |
| DELETE | `/api/datasets/{id}` | 删除数据集（级联删除） |
| POST | `/api/datasets/{id}/picks` | 新建拾取 |
| PATCH | `/api/picks/{id}` | 修改到时/不确定窗/相型/通道/作者/状态 |
| DELETE | `/api/picks/{id}` | 删除拾取 |
| GET | `/api/datasets/{id}/consensus` | 分组共识 + 全部冲突 |
| GET | `/api/datasets/{id}/export?format=json|csv` | 导出审阅结果 |

交互式文档：服务启动后访问 <http://localhost:8000/docs>。

## 本地开发（不用 Docker）

```bash
# 后端
python -m venv .venv && source .venv/bin/activate
pip install -r backend/requirements.txt
PICKER_DATA_DIR=./data uvicorn app.main:app --app-dir backend --reload --port 8000

# 前端（另一个终端）
cd frontend
npm install
npm run watch        # esbuild 监听，输出到 frontend/dist
```

环境变量：`PICKER_DATA_DIR`（数据库目录，默认 `/data`）、
`PICKER_DB_PATH`、`PICKER_STATIC_DIR`、`PICKER_SAMPLES_DIR`。

## 目录结构

```
.
├── Dockerfile                # 多阶段：node 构建前端 → python-slim 运行
├── docker-compose.yml        # 一条命令启动，SQLite 落卷
├── backend/
│   ├── app/
│   │   ├── main.py           # FastAPI 路由、导入、导出、静态托管
│   │   ├── db.py             # SQLite 连接/建表（datasets/channels/picks）
│   │   ├── schemas.py        # Pydantic 模型（wire 上 camelCase）
│   │   ├── consensus.py      # 区间冲突检测 + 加权共识（Birge 放大）
│   │   └── config.py
│   ├── requirements.txt
│   └── scripts/generate_sample.py
├── frontend/
│   ├── index.html
│   ├── package.json          # 仅 typescript + esbuild，无运行时框架
│   ├── tsconfig.json
│   ├── build.mjs
│   └── src/ (main.ts, waveform.ts, api.ts, timeutil.ts, types.ts, style.css)
└── samples/sample_review.json
```
