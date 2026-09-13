import Image from "next/image";
import type { CSSProperties } from "react";

/**
 * CoTeach 品牌标识。
 *
 * - horizontal：彩色横版，适合首页主视觉
 * - horizontalSolid：深蓝横版，适合小尺寸顶栏
 * - horizontalCompact：紧凑彩色横版，适合页脚与内容区
 * - icon：彩色方形标志，适合应用侧栏与头像位
 * - vertical：竖版组合，适合独立品牌场景
 */
export type CoTeachLogoVariant =
  | "horizontal"
  | "horizontalSolid"
  | "horizontalCompact"
  | "icon"
  | "vertical";

export type CoTeachLogoProps = {
  variant?: CoTeachLogoVariant;
  height?: number;
  className?: string;
  style?: CSSProperties;
  glow?: boolean;
  priority?: boolean;
};

const RATIOS: Record<CoTeachLogoVariant, number> = {
  horizontal: 2048 / 683,
  horizontalSolid: 2048 / 683,
  horizontalCompact: 2048 / 683,
  icon: 1,
  vertical: 1122 / 1402,
};

const SOURCES: Record<CoTeachLogoVariant, string> = {
  horizontal: "/brand/coteach/horizontal-color.png",
  horizontalSolid: "/brand/coteach/horizontal-solid.png",
  horizontalCompact: "/brand/coteach/horizontal-color.png",
  icon: "/brand/coteach/icon-color.png",
  vertical: "/brand/coteach/vertical-color.png",
};

export function CoTeachLogo({
  variant = "horizontal",
  height = 40,
  className,
  style,
  glow = false,
  priority = false,
}: CoTeachLogoProps) {
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
        alt="CoTeach"
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

export function CoTeachLogoMark({
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
    <CoTeachLogo
      variant="icon"
      height={size}
      className={className}
      style={style}
      glow={glow}
    />
  );
}
