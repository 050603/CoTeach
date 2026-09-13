import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "CoTeach",
    short_name: "CoTeach",
    description: "连接教师、学生与 AI 的项目式学习协同教学平台。",
    start_url: "/",
    display: "standalone",
    background_color: "#F4F2ED",
    theme_color: "#0B4A92",
    icons: [
      {
        src: "/brand/coteach/icon-color.png",
        sizes: "1254x1254",
        type: "image/png",
      },
    ],
  };
}
