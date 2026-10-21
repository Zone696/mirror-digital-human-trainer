# 镜界 MIRROR · AI 数字人陪练（Windows Demo）

一个可本地运行的 AI 数字人语音陪练 Demo：**麦克风输入 → ASR 语音识别 → LLM 对话处理 → TTS 语音合成 → 数字人口型驱动输出**，形成完整闭环。

同时覆盖两条业务方向：

| 方向 | 场景 |
| --- | --- |
| 英语口语陪练 | 日常闲聊、雅思口语模拟、发音纠错 |
| 企业内部培训 | 新员工入职引导、客户异议处理（销售演练） |

---

## 一、功能总览

- **语音全链路**：浏览器录音/识别 → 大模型流式回复 → 语音播报 → 数字人实时口型同步
- **数字人渲染**：纯前端 SVG 实时驱动（呼吸、眨眼、注视、眉毛、口型），无需 D-ID / 硅基等付费服务
- **对话业务**：英语陪练场景切换（日常 / 面试 / 发音纠错）+ 企业培训脚本（角色约束、分环节推进）
- **会话上下文**：多轮上下文管理，自动裁剪最近 24 条消息
- **能力评估**：结束时由 LLM 按场景维度打分（0-100）、给优点/待改进/逐句纠正/下一步建议
- **本地存储**：会话记录以 JSON 落盘，支持历史回放、导出
- **双重降级**：ASR/TTS 支持「浏览器原生」与「云端 OpenAI 兼容 API」两种模式，任一路失败可回退，也可纯文字输入完成训练

---

## 二、技术选型

| 模块 | 方案 |
| --- | --- |
| UI 层 | 原生 HTML / CSS / JavaScript（无构建步骤） |
| 后端服务 | Python 3.9+ 标准库 `http.server`（零第三方依赖） |
| ASR 语音识别 | 默认 Chrome/Edge `Web Speech API`；可切换任意 OpenAI 兼容 `/audio/transcriptions` |
| LLM 大模型 | OpenAI 兼容协议，默认 `gpt-6-luna`（流式 SSE） |
| TTS 语音合成 | 默认浏览器 `SpeechSynthesis`；可切换 OpenAI 兼容 `/audio/speech` |
| 数字人方案 | 本地 SVG + WebAudio 实时渲染（可扩展接入 D-ID / 硅基 / 即梦视频流） |
| 数据存储 | 本地 `data/sessions/*.json` |
| 桌面壳（可选） | Electron（`npm run electron` / `npm run dist`） |

> 说明：当前提供的 API 网关（`https://api.a6api.com/v1`）经实测**不支持** `/audio/speech` 与 `/audio/transcriptions`，因此 Demo 默认使用浏览器原生语音能力；如你有支持这两个接口的服务，可在「设置 → ASR / TTS」切换为云端 API。

---

## 三、快速开始

### 环境要求

- Windows 10 / 11
- Python 3.9+（安装时勾选 *Add Python to PATH*）
- Chrome 或 Edge（推荐，语音识别支持最好）

### 方式 1：双击启动（推荐）

1. 双击 `start.bat`
2. 浏览器自动打开 `http://127.0.0.1:8765`
3. 首次启动会自动生成 `data/config.json`（压缩包内不含任何 API Key）
4. 点击右上角「设置」填写：

   | 字段 | 示例 |
   | --- | --- |
   | Base URL | `https://api.a6api.com/v1` |
   | API Key | `sk-...` |
   | 模型名称 | `gpt-6-luna` |

5. 点击「测试连接」，成功后保存
6. 允许浏览器麦克风权限，点击麦克风（或按空格）开始对话

### 方式 2：命令行

```bash
# 无需安装依赖
python main.py
# 或
npm run server
```

自定义端口：`set PORT=9000 && python main.py`

### 方式 3：Electron 桌面壳（可选，需要 Node.js）

```bash
npm install
npm run electron     # 开发态运行
npm run dist         # 打包为 dist/MirrorTrainer.exe（portable）
```

> Electron 壳只是启动本地 Python 服务并加载页面，因此打包后的 exe 运行环境仍需安装 Python 3.9+。

---

## 四、使用说明

| 操作 | 说明 |
| --- | --- |
| 麦克风 / 空格 | 开始或结束录音；说完停顿 1.4 秒自动提交（云端 ASR 模式） |
| 文字 | 展开输入框，可直接打字发送（Enter 发送 / Shift+Enter 换行） |
| 重播 | 重播最近一句 AI 语音 |
| 结束评估 | 生成能力评估报告（对话至少 1 轮） |
| 重置 | 清空当前对话并重新开始（当前记录已自动保存） |
| 切换场景 | 五个内置场景任选；切换即开启新会话 |
| 历史会话 | 点击任意记录回放、导出 JSON，或载入对话区查看 |
| 设置 | 配置 LLM / ASR / TTS、数字人形象（Ava / Leo）、自动接听、字幕 |

自动接听开启时，数字人说完会自动再次进入聆听状态，实现免手动的连续对话。

---

## 五、目录结构

```
digital-human-trainer/
├─ main.py                 # 零依赖后端：静态托管 + LLM/ASR/TTS 代理 + 会话存储
├─ start.bat               # Windows 一键启动
├─ package.json            # npm run server / electron / dist
├─ requirements.txt        # 仅说明：使用标准库，无第三方依赖
├─ desktop/main.js         # Electron 外壳（可选）
├─ public/
│  ├─ index.html           # 界面结构 + 内联数字人 SVG
│  ├─ css/style.css        # 演播室风格视觉系统
│  └─ js/
│     ├─ avatar.js         # 数字人渲染：口型 / 眨眼 / 注视 / 呼吸
│     ├─ speech.js         # ASR / TTS 引擎（浏览器 + 云端双模式）
│     └─ app.js            # 会话编排、流式渲染、评估、历史、设置
└─ data/
   ├─ config.json          # 本地配置（含密钥，已被 .gitignore 排除）
   ├─ config.example.json
   ├─ scenarios/*.json     # 场景脚本（可直接新增）
   └─ sessions/*.json      # 会话记录
```

---

## 六、扩展场景脚本

在 `data/scenarios/` 下新增一个 JSON 即可被自动加载（`order` 控制排序）：

```json
{
  "id": "my-scene",
  "category": "enterprise",
  "order": 3,
  "name": "门店投诉处理",
  "subtitle": "Complaint Handling",
  "description": "一句话说明训练内容",
  "level": "企业内训",
  "duration": "10 分钟",
  "avatar": { "name": "周店长", "variant": "leo", "role": "门店店长", "accent": "普通话" },
  "asrLang": "zh-CN",
  "ttsLang": "zh-CN",
  "opening": "数字人的第一句话",
  "systemPrompt": "角色设定 + 环节节奏 + 约束（不跳戏、不代答、每次 2-3 句）",
  "goals": ["目标 1", "目标 2"],
  "quickReplies": ["建议话术 1", "建议话术 2"],
  "evaluation": {
    "dimensions": [
      { "key": "empathy", "label": "共情", "weight": 0.4 },
      { "key": "solution", "label": "方案", "weight": 0.6 }
    ]
  }
}
```

`evaluation.dimensions` 的 `key/label` 会直接用于评估提示词与前端展示。

---

## 七、接口一览

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查、配置状态 |
| GET/POST | `/api/config` | 读取（密钥脱敏）/ 保存配置 |
| GET | `/api/scenarios` | 场景列表 |
| GET | `/api/models` | 上游模型列表（用于设置页提示） |
| POST | `/api/chat/stream` | 流式对话（SSE） |
| POST | `/api/chat` | 非流式对话（连接测试） |
| POST | `/api/evaluate` | 生成能力评估 JSON |
| POST | `/api/asr` | 语音识别代理（multipart 转发） |
| POST | `/api/tts` | 语音合成代理（返回音频流） |
| GET/POST | `/api/sessions` | 会话列表 / 保存（upsert） |
| GET/DELETE | `/api/sessions/{id}` | 读取 / 删除单个会话 |

---

## 八、常见问题

**1. 点击麦克风提示「语音识别服务连接失败（网络受限）」**
Chrome 的语音识别依赖 Google 服务，国内网络可能不可用。可改用文字输入，或在「设置 → ASR → 云端 API」配置支持 `/audio/transcriptions` 的服务（如 Whisper 兼容接口）。

**2. 数字人不出声 / 没有口型**
确认系统音量与 Chrome 站点声音未被静音；TTS 使用系统语音，可在「设置」里换一个音色。若系统未安装英文语音包，Windows「设置 → 时间和语言 → 语音」中添加即可。

**3. 语音播报有延迟或卡顿**
浏览器 TTS 为逐句合成，长回复会分段播放；属正常现象。云端 TTS 模式下数字人口型由真实音频能量驱动，会更自然。

**4. 端口被占用**
`set PORT=9000 && python main.py`，再访问 `http://127.0.0.1:9000`。

**5. 评估报「结果解析失败」**
模型偶发返回非 JSON。重试一次即可；也可在设置中换用指令遵循更强的模型。

---

## 九、数据与隐私

- 服务仅监听 `127.0.0.1`，不对局域网开放
- API Key 保存在本机 `data/config.json`，接口返回时已脱敏，不会回显明文
- 对话记录保存在本机 `data/sessions/*.json`，可随时删除
- 音频不会落盘：浏览器识别直接由浏览器处理；云端 ASR 模式仅内存转发
- `.gitignore` 已排除 `config.json` 与会话数据，公开仓库不会泄露密钥

---

## 十、已验证环境

- Windows 11 · Python 3.14 · Chrome/Edge
- LLM：`gpt-6-luna`（`https://api.a6api.com/v1`），流式与非流式、评估 JSON 均通过
- ASR/TTS：浏览器原生模式通过；该网关的 `/audio/*` 接口返回 400（不支持），已做自动回退
