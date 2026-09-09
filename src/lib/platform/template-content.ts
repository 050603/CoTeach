import { z } from "zod";

export const templateBriefSchema = z.object({
  title: z.string().trim().min(1).max(160),
  subject: z.string().trim().max(100).default(""),
  grade: z.string().trim().max(100).default(""),
  durationMinutes: z.number().int().min(5).max(600),
  brief: z.string().trim().min(1).max(12_000),
});

export const templateContentSchema = z.object({
  schemaVersion: z.literal(1),
  title: z.string().trim().min(1).max(160),
  subject: z.string().max(100),
  grade: z.string().max(100),
  durationMinutes: z.number().int().min(5).max(600),
  summary: z.string().trim().min(1).max(10_000),
  learningObjectives: z.array(z.string().trim().min(1).max(1000)).min(1).max(20),
  outline: z.array(z.object({
    title: z.string().trim().min(1).max(160),
    durationMinutes: z.number().int().positive().max(600),
    description: z.string().trim().min(1).max(5000),
  })).min(1).max(30),
  resources: z.array(z.object({
    title: z.string().trim().min(1).max(300),
    url: z.string().max(2000).refine((value) => !value || /^https?:\/\//i.test(value), "请填写 http 或 https 链接"),
  })).max(30),
});

export type TemplateContent = z.infer<typeof templateContentSchema>;

export function readTemplateContent(snapshot: unknown): TemplateContent | null {
  const result = templateContentSchema.safeParse(snapshot);
  return result.success ? result.data : null;
}
