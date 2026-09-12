import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResilientImage } from "./resilient-image";
import { CourseCover } from "./platform/student-shell";
import { AvatarDisplay } from "./openmaic/ui/avatar-display";

afterEach(cleanup);

describe("image loading recovery", () => {
  it("retains the supplied dimensions for a non-fill image without overriding caller sizing", () => {
    const { rerender } = render(<ResilientImage src="/sized.webp" alt="封面" width={320} height={180} unoptimized />);
    fireEvent.error(screen.getByRole("img", { name: "封面" }));
    const fallback = screen.getByRole("img", { name: "封面（图片暂不可用）" });
    expect(fallback).toHaveStyle({ "--image-fallback-width": "320px", aspectRatio: "320 / 180" });
    expect(fallback).toHaveClass("w-[var(--image-fallback-width)]", "max-w-full");
    rerender(<ResilientImage src="/sized.webp" alt="封面" width={320} height={180} className="h-full w-full" unoptimized />);
    expect(fallback).toHaveClass("h-full", "w-full");
    expect(fallback).not.toHaveClass("w-[var(--image-fallback-width)]");
  });

  it("reserves the intrinsic dimensions for a static image import", () => {
    render(<ResilientImage src={{ src: "/static.webp", width: 480, height: 270 }} alt="静态封面" unoptimized />);
    fireEvent.error(screen.getByRole("img", { name: "静态封面" }));
    expect(screen.getByRole("img", { name: "静态封面（图片暂不可用）" })).toHaveStyle({ "--image-fallback-width": "480px", aspectRatio: "480 / 270" });
  });

  it("replaces an unavailable image with network-independent artwork in the reserved space", () => {
    const onError = vi.fn();
    const { container } = render(<ResilientImage src="/missing-cover.webp" alt="课程封面" fill unoptimized onError={onError} />);
    fireEvent.error(screen.getByRole("img", { name: "课程封面" }));
    const fallback = screen.getByRole("img", { name: "课程封面（图片暂不可用）" });
    expect(fallback).toHaveStyle({ position: "absolute", width: "100%", height: "100%" });
    expect(fallback.querySelector("svg")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("attempts the new URL and allows returning to a previously unavailable URL", () => {
    const { rerender } = render(<ResilientImage src="/first.webp" alt="课程封面" width={320} height={180} unoptimized />);
    fireEvent.error(screen.getByRole("img", { name: "课程封面" }));
    rerender(<ResilientImage src="/second.webp" alt="课程封面" width={320} height={180} unoptimized />);
    expect(screen.getByRole("img", { name: "课程封面" })).toHaveAttribute("src", expect.stringMatching(/\/second\.webp$/));
    rerender(<ResilientImage src="/first.webp" alt="课程封面" width={320} height={180} unoptimized />);
    expect(screen.getByRole("img", { name: "课程封面" })).toHaveAttribute("src", expect.stringMatching(/\/first\.webp$/));
  });

  it("preserves the platform teaching illustration when the stored course cover fails", () => {
    const { container } = render(<CourseCover url="/missing.webp" name="河流调查" className="aspect-video" />);
    fireEvent.error(screen.getByRole("img", { name: "河流调查课程封面" }));
    expect(container.querySelector(".pbl-learning-art")).toBeTruthy();
    expect(container.firstChild).toHaveClass("aspect-video");
  });

  it("loads blob avatars and shows a readable initial after a failed request", () => {
    const { rerender } = render(<AvatarDisplay src="blob:https://example.test/avatar" alt="李老师" />);
    expect(screen.getByRole("img", { name: "李老师" })).toHaveAttribute("src", "blob:https://example.test/avatar");
    fireEvent.error(screen.getByRole("img", { name: "李老师" }));
    expect(screen.getByRole("img", { name: "李老师（图片暂不可用）" })).toHaveTextContent("李");
    rerender(<AvatarDisplay src="🌿" alt="学习伙伴" />);
    expect(screen.getByRole("img", { name: "学习伙伴" })).toHaveTextContent("🌿");
  });
});
