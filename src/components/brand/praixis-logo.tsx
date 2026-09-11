import Image from "next/image";
import type { CSSProperties } from "react";

/**
 * PrAIxis 品牌标识。
 *
 * - horizontal：彩色横版，适合首页主视觉
 * - horizontalSolid：深蓝横版，适合小尺寸顶栏
 * - horizontalCompact：紧凑彩色横版，适合页脚与内容区
 * - icon：彩色方形标志，适合应用侧栏与头像位
 * - vertical：竖版组合，适合独立品牌场景
 */
export type PraixisLogoVariant =
  | "horizontal"
  | "horizontalSolid"
  | "horizontalCompact"
  | "icon"
  | "vertical";

export type PraixisLogoProps = {
  variant?: PraixisLogoVariant;
  height?: number;
  className?: string;
  style?: CSSProperties;
  glow?: boolean;
  priority?: boolean;
};

const RATIOS: Record<PraixisLogoVariant, number> = {
  horizontal: 3,
  horizontalSolid: 3,
  horizontalCompact: 3,
  icon: 1,
  vertical: 1,
};

const SOURCES: Record<PraixisLogoVariant, string> = {
  horizontal: "/brand/PrAIxis/PrAIxis.png",
  horizontalSolid: "/brand/PrAIxis/PrAIxis2.png",
  horizontalCompact: "/brand/PrAIxis/PrAIxis3.png",
  icon: "/brand/PrAIxis/PrAIxis4.png",
  vertical: "/brand/PrAIxis/PrAIxis5.png",
};

export function PraixisLogo({
  variant = "horizontal",
  height = 40,
  className,
  style,
  glow = false,
  priority = false,
}: PraixisLogoProps) {
  const width = Math.round(height * RATIOS[variant]);

  return (
    <span
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        lineHeight: 0,
        ...style,
      }}
    >
      <Image
        src={SOURCES[variant]}
        alt="PrAIxis"
        width={width}
        height={height}
        priority={priority}
        unoptimized
        style={{
          display: "block",
          height,
          width,
          filter: glow
            ? "drop-shadow(0 0 24px rgba(14, 165, 164, 0.34)) drop-shadow(0 0 48px rgba(37, 99, 235, 0.2))"
            : undefined,
          objectFit: "contain",
          transition: "filter 0.4s ease",
        }}
        draggable={false}
      />
    </span>
  );
}

export function PraixisLogoMark({
  size = 32,
  className,
  style,
  glow = false,
}: {
  size?: number;
  className?: string;
  style?: CSSProperties;
  glow?: boolean;
}) {
  return (
    <PraixisLogo
      variant="icon"
      height={size}
      className={className}
      style={style}
      glow={glow}
    />
  );
}
