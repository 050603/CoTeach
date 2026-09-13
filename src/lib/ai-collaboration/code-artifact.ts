import type { CollaborationArtifactType } from "@/lib/ai-collaboration/artifact-types";

export type CodeArtifactLanguage = Exclude<CollaborationArtifactType, "document">;

export type CodeArtifactFile = {
  id: string;
  path: string;
  content: string;
};

export type CodeArtifact = {
  version: 1;
  language: CodeArtifactLanguage;
  activeFileId: string;
  files: CodeArtifactFile[];
};

const DEFAULT_SOURCE: Record<CodeArtifactLanguage, { path: string; content: string }> = {
  python: {
    path: "main.py",
    content: "# 在这里开始你的项目\n\n\ndef main():\n    print(\"你好，CoTeach！\")\n\n\nif __name__ == \"__main__\":\n    main()\n",
  },
  c: {
    path: "main.c",
    content: "#include <stdio.h>\n\nint main(void) {\n    printf(\"你好，CoTeach！\\n\");\n    return 0;\n}\n",
  },
};

export function createCodeArtifact(language: CodeArtifactLanguage): CodeArtifact {
  const source = DEFAULT_SOURCE[language];
  return {
    version: 1,
    language,
    activeFileId: "main",
    files: [{ id: "main", path: source.path, content: source.content }],
  };
}

function isFile(value: unknown): value is CodeArtifactFile {
  if (!value || typeof value !== "object") return false;
  const file = value as Partial<CodeArtifactFile>;
  return typeof file.id === "string"
    && file.id.length > 0
    && typeof file.path === "string"
    && file.path.length > 0
    && typeof file.content === "string";
}

export function parseCodeArtifact(
  content: string,
  expectedLanguage?: CodeArtifactLanguage,
): CodeArtifact | null {
  try {
    const parsed = JSON.parse(content) as Partial<CodeArtifact>;
    if (parsed.version !== 1 || (parsed.language !== "python" && parsed.language !== "c")) return null;
    if (expectedLanguage && parsed.language !== expectedLanguage) return null;
    if (!Array.isArray(parsed.files) || !parsed.files.length || !parsed.files.every(isFile)) return null;
    const activeFileId = typeof parsed.activeFileId === "string"
      && parsed.files.some((file) => file.id === parsed.activeFileId)
      ? parsed.activeFileId
      : parsed.files[0].id;
    return {
      version: 1,
      language: parsed.language,
      activeFileId,
      files: parsed.files.map((file) => ({ ...file })),
    };
  } catch {
    return null;
  }
}

export function serializeCodeArtifact(artifact: CodeArtifact): string {
  return JSON.stringify(artifact);
}

export function normalizeCodeFileName(name: string, language: CodeArtifactLanguage): string | null {
  const trimmed = name.trim().replaceAll("\\", "/");
  if (!trimmed || trimmed.startsWith("/") || trimmed.includes("..")) return null;
  if (!/^[\p{L}\p{N}_./ -]+$/u.test(trimmed)) return null;
  const lowerName = trimmed.toLowerCase();
  if (language === "python") return lowerName.endsWith(".py") ? trimmed : `${trimmed}.py`;
  return lowerName.endsWith(".c") || lowerName.endsWith(".h") ? trimmed : `${trimmed}.c`;
}
