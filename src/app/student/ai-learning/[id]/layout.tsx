// 学生 AI 学习页：注入 OpenMAIC 完整 CSS 变量与字体样式
// （root globals.css 仅含 CoTeach 极简变量，OpenMAIC Stage 依赖完整 token 体系）
import '@openmaic/renderer/fonts.css';
import 'animate.css';
import 'katex/dist/katex.min.css';
import '@/app/openmaic/globals.css';

export const dynamic = 'force-dynamic';

export default function StudentAiLearningLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
