import { z } from "zod";

export const CourseReferenceLinkSchema = z.object({
  id: z.string().trim().min(1).max(128),
  title: z.string().trim().min(1).max(200),
  url: z.string().trim().url().refine(
    (value) => value.startsWith("http://") || value.startsWith("https://"),
    "仅支持 HTTP(S) 链接",
  ),
});

export const CourseReferenceLinksSchema = z.array(CourseReferenceLinkSchema).max(50);

export type CourseReferenceLink = z.infer<typeof CourseReferenceLinkSchema>;
