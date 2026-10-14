# 文档与 PDF 解析适配

本模块提供 PDF Provider 注册和解析实现。当前对外 PDF 接口为 [POST /api/openmaic/parse-pdf](../../../app/api/openmaic/parse-pdf/route.ts)，通过 [document](../document/index.ts) 的统一文档提取边界处理，再投影成兼容的 `ParsedPdfContent`。教材 DOCX 入库由 [textbook](../../textbook) 管理。

## Provider

| ID | 运行方式 | 配置 |
| --- | --- | --- |
| `unpdf` | 服务器本地 PDF 解析，提供文字、图片与元数据 | 无需密钥。 |
| `mineru` | 调用运营方部署的 MinerU 服务，读取 Markdown、图片、表格与公式等提取结果 | 必须配置服务 Base URL；按服务需要设置密钥。 |
| `mineru-cloud` | 创建上传批次、上传文件、轮询完成并读取结果 ZIP | 需要密钥；默认 API 根为 `https://mineru.net/api/v4`。 |

能力以 [constants.ts](constants.ts) 和具体返回结果为准，不能把 Provider 的声明等同于每份文件都有完整 OCR、页码或版面定位。

MinerU 自托管实现调用配置地址下的 `/file_parse`；Cloud 使用独立异步上传协议，二者的地址和返回格式不可互换。Cloud 解析器也被文档提取边界用于支持的 DOCX/PPTX 输入，当前 PDF 路由仍按 PDF 请求处理。

## 配置与调用

教师的“个人中心 → AI 服务”及服务器 Provider 配置管理地址与凭据。服务器托管的 Provider 忽略请求中自带的密钥和 Base URL；非托管地址在生产请求中进行 SSRF 校验。所有远程解析通过服务器出口发送，浏览器无需持有托管密钥。

兼容 PDF 路由接收 `multipart/form-data`，`pdf` 为文件，`providerId` 可选，缺省使用 `unpdf`。解析失败返回实际错误，配置完成后用实际文件核对提取结果。

```ts
import { extractDocument } from '@openmaic/lib/document';

const artifact = await extractDocument({
  buffer,
  fileName: 'material.pdf',
  fileSize: buffer.byteLength,
  mimeType: 'application/pdf',
  config: { providerId: 'unpdf' },
});
```

`DocumentArtifact` 保存 `metadata`、`blocks`、`assets`、可选引用及诊断；需要旧 PDF 结果时调用 `documentArtifactToParsedPdfContent`。图片标识、页码、原文块与真实图片映射用于生成来源绑定，不应把 Markdown 图片名当成已可访问的文件 URL。

## 故障与扩展

排查时分别核对实际 Provider、已保存配置、上传响应、解析任务状态和结果文件。Cloud 超时和下载失败是技术错误；图片缺失应核对原文引用与图片映射，不能靠更换页面短句掩盖来源问题。

新增提取器需同步 Provider 类型和注册表、MIME 能力、配置解析、文档结果投影及相关回归。测试按 [开发工作流](../../../../docs/agent-workflow.md)执行，实际服务连通性和解析质量另行报告。
