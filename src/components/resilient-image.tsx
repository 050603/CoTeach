"use client";

import Image, { type ImageProps } from "next/image";
import { useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";

type ResilientImageProps = ImageProps & { fallback?: ReactNode };

/** Keep a cover's reserved space when a stored or remote image is unavailable. */
export function ResilientImage(props: ResilientImageProps) {
  const source = typeof props.src === "string"
    ? props.src
    : "default" in props.src ? props.src.default.src : props.src.src;
  // Remount the attempt on source changes, including returning to a previous URL.
  return <ImageAttempt key={source} {...props} />;
}

function ImageAttempt({ fallback, onError, ...props }: ResilientImageProps) {
  const [failed, setFailed] = useState(false);
  const staticSource = typeof props.src === "string" ? undefined : "default" in props.src ? props.src.default : props.src;
  const width = props.width ?? staticSource?.width;
  const height = props.height ?? staticSource?.height;
  if (failed) {
    return (
      <span
        role={props.alt ? "img" : undefined}
        aria-label={props.alt ? `${props.alt}（图片暂不可用）` : undefined}
        aria-hidden={props.alt ? undefined : true}
        className={cn(!props.fill && width && "w-[var(--image-fallback-width)] max-w-full", props.className)}
        style={{
          display: "block",
          overflow: "hidden",
          background: "var(--pbl-surface-soft, #edf1ed)",
          ...(props.fill
            ? { position: "absolute", inset: 0, width: "100%", height: "100%" }
            : {
              "--image-fallback-width": width ? `${width}px` : undefined,
              aspectRatio: width && height ? `${width} / ${height}` : undefined,
            }),
          ...props.style,
        } as CSSProperties}
      >
        {fallback ?? (
          <svg aria-hidden="true" width="100%" height="100%" viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice">
            <rect width="320" height="180" fill="#edf1ed" />
            <circle cx="275" cy="25" r="95" fill="#dce6df" />
            <path d="M115 65h35l10 8 10-8h35v62h-35l-10 8-10-8h-35z" fill="#fcfbf8" stroke="#658578" strokeWidth="3" strokeLinejoin="round" />
            <path d="M160 75v48m-33-41h19m-19 13h19m28-13h19m-19 13h19" stroke="#658578" strokeWidth="3" strokeLinecap="round" />
          </svg>
        )}
      </span>
    );
  }
  return <Image {...props} alt={props.alt} onError={(event) => { setFailed(true); onError?.(event); }} />;
}
