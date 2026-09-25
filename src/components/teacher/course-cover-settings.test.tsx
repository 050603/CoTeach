import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ success: vi.fn() }));
vi.mock("@/components/ui", () => ({ toast: { success: mocks.success } }));
vi.mock("@/components/resilient-image", () => ({
  ResilientImage: ({ src, alt }: { src: string; alt: string }) => <span role="img" aria-label={alt} data-src={src} />,
}));

import { CourseCoverSettings } from "./course-cover-settings";

const coverUrl = "/api/openmaic/classroom-media/template-cover-course-1/media/cover.webp";

beforeEach(() => {
  mocks.success.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("course cover settings", () => {
  it("shows the missing cover and regenerates it through the course cover API", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ coverImageUrl: coverUrl }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const onUpdated = vi.fn().mockResolvedValue(undefined);
    render(<CourseCoverSettings courseId="course-1" courseName="人工智能教育" onUpdated={onUpdated} />);

    expect(screen.getByText("尚无课程封面")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "生成封面" }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/courses/course-1/cover", expect.objectContaining({ method: "POST" })));
    expect(await screen.findByRole("img", { name: "人工智能教育课程封面" })).toHaveAttribute("data-src", coverUrl);
    await waitFor(() => expect(onUpdated).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "重新生成封面" })).toBeInTheDocument();
  });

  it("uploads a replacement and keeps the old image visible when the upload fails", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ message: "图片无法读取" }), { status: 422 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ coverImageUrl: coverUrl }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    render(<CourseCoverSettings courseId="course-1" courseName="人工智能教育" coverImageUrl="/old.webp" onUpdated={vi.fn().mockResolvedValue(undefined)} />);
    const input = screen.getByLabelText("选择课程封面图片");
    const file = new File(["image"], "cover.png", { type: "image/png" });

    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("图片无法读取");
    expect(screen.getByRole("img", { name: "人工智能教育课程封面" })).toHaveAttribute("data-src", "/old.webp");

    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fetcher.mock.calls[1][1]).toMatchObject({ method: "PUT", body: expect.any(FormData) });
    await waitFor(() => expect(screen.getByRole("img", { name: "人工智能教育课程封面" })).toHaveAttribute("data-src", coverUrl));
  });
});
