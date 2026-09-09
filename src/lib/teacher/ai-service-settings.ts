export type ProviderSavedState = {
  hasApiKey?: boolean;
  enabled?: boolean;
  defaultModel?: string;
  models?: string[];
  priority?: number;
};

export type ProviderStatePresentation = {
  label: "默认" | "已配置" | "无需密钥" | "未配置";
  tone: "success" | "info" | "neutral";
  model?: string;
};

export type ProviderConnectionPresentation = {
  mode: "official" | "compatible";
  label: string;
  protocol: string;
  tone: "success" | "warning" | "info";
  credentialHint: string;
};

const ALIBABA_MODEL_STUDIO_HOST = /(^|\.)(aliyuncs\.com|alibabacloud\.com)$/i;

function normalizedEndpoint(value?: string): string {
  return (value ?? "").trim().replace(/\/+$/, "");
}

function endpointHost(value?: string): string {
  try {
    return new URL(value ?? "").hostname;
  } catch {
    return "";
  }
}

function protocolLabel(providerType?: string): string {
  switch (providerType) {
    case "azure":
      return "Azure OpenAI";
    case "anthropic":
      return "Anthropic Messages";
    case "bedrock":
      return "AWS Bedrock Converse";
    case "google":
      return "Google Gemini";
    default:
      return "OpenAI 兼容";
  }
}

/**
 * Explain who owns the endpoint and therefore which API key it accepts.
 * A model brand and an OpenAI-compatible gateway are separate concerns: for
 * example, a DeepSeek model hosted by Alibaba Model Studio needs an Alibaba
 * credential, not a key issued by platform.deepseek.com.
 */
export function getProviderConnectionPresentation({
  providerId,
  providerType,
  baseUrl,
  defaultBaseUrl,
}: {
  providerId: string;
  providerType?: string;
  baseUrl?: string;
  defaultBaseUrl?: string;
}): ProviderConnectionPresentation {
  const effectiveUrl = normalizedEndpoint(baseUrl || defaultBaseUrl);
  const officialUrl = normalizedEndpoint(defaultBaseUrl);
  const host = endpointHost(effectiveUrl);

  if (providerId === "bedrock") {
    return {
      mode: "official",
      label: "AWS 凭据链",
      protocol: protocolLabel(providerType),
      tone: "success",
      credentialHint: "由服务端 BEDROCK_REGION 和 AWS 凭据链提供认证；浏览器不会保存 AWS Access Key。",
    };
  }

  if (providerId === "azure") {
    return {
      mode: "official",
      label: "Azure 资源端点",
      protocol: protocolLabel(providerType),
      tone: effectiveUrl ? "success" : "info",
      credentialHint: "填写 Azure 门户中的资源端点、API Key，并在模型列表中填写部署名称。",
    };
  }

  if (providerId === "deepseek" && ALIBABA_MODEL_STUDIO_HOST.test(host)) {
    return {
      mode: "compatible",
      label: "阿里云 Model Studio 专属部署",
      protocol: protocolLabel(providerType),
      tone: "warning",
      credentialHint:
        "这是通过 OpenAI 兼容协议调用阿里云托管的 DeepSeek 模型；请使用与该专属部署、账号和地域匹配的 Model Studio API Key。",
    };
  }

  if (effectiveUrl && officialUrl && effectiveUrl === officialUrl) {
    return {
      mode: "official",
      label: "官方直连",
      protocol: protocolLabel(providerType),
      tone: "success",
      credentialHint: `密钥必须由 ${providerId === "deepseek" ? "DeepSeek 开放平台" : "该服务商"}签发，并与当前服务地址匹配。`,
    };
  }

  return {
    mode: "compatible",
    label: "自定义兼容网关",
    protocol: protocolLabel(providerType),
    tone: "info",
    credentialHint: "密钥必须由当前服务地址所属的平台签发；模型品牌相同并不代表密钥可以跨平台使用。",
  };
}

export function getProviderCredentialError({
  providerId,
  baseUrl,
  errorMessage,
}: {
  providerId?: string;
  baseUrl?: string;
  errorMessage: string;
}): { message: string; details: string } | null {
  const looksLikeCredentialError = /invalid api[-_ ]?key|unauthorized|authentication|\b401\b/i.test(
    errorMessage,
  );
  if (!looksLikeCredentialError) return null;

  const host = endpointHost(baseUrl);
  if (providerId === "deepseek" && ALIBABA_MODEL_STUDIO_HOST.test(host)) {
    return {
      message: "阿里云 Model Studio 拒绝了当前密钥。",
      details:
        "请重新保存与该专属部署、阿里云账号和地域匹配的 Model Studio API Key。数据库重构不会保留旧版 ProviderCredential。",
    };
  }

  return {
    message: "API Key 无效、已过期，或与当前服务地址不匹配。",
    details: "请确认密钥由当前服务地址所属的平台签发。",
  };
}

export function getProviderStatePresentation({
  requiresApiKey,
  saved,
}: {
  requiresApiKey: boolean;
  saved?: ProviderSavedState;
}): ProviderStatePresentation {
  const isConfigured = Boolean(saved?.hasApiKey || saved?.enabled !== undefined);

  if (isConfigured) {
    return {
      label: saved?.priority === 0 ? "默认" : "已配置",
      tone: "success",
      model: saved?.defaultModel || saved?.models?.[0],
    };
  }

  if (!requiresApiKey) {
    return {
      label: "无需密钥",
      tone: "info",
      model: undefined,
    };
  }

  return {
    label: "未配置",
    tone: "neutral",
    model: undefined,
  };
}
