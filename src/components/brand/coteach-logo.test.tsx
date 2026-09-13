import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CoTeachLogo, CoTeachLogoMark } from "./coteach-logo";

describe("CoTeachLogo", () => {
  it("maps the horizontal and solid variants to the supplied brand assets", () => {
    const { rerender } = render(<CoTeachLogo height={60} variant="horizontal" />);
    expect(screen.getByRole("img", { name: "CoTeach" })).toHaveAttribute(
      "src",
      "/brand/coteach/horizontal-color.png",
    );

    rerender(<CoTeachLogo height={60} variant="horizontalSolid" />);
    expect(screen.getByRole("img", { name: "CoTeach" })).toHaveAttribute(
      "src",
      "/brand/coteach/horizontal-solid.png",
    );
  });

  it("uses the symbol-only artwork for compact brand marks", () => {
    render(<CoTeachLogoMark size={36} />);
    expect(screen.getByRole("img", { name: "CoTeach" })).toHaveAttribute(
      "src",
      "/brand/coteach/icon-color.png",
    );
  });

  it("preserves the supplied vertical artwork ratio", () => {
    render(<CoTeachLogo height={1402} variant="vertical" />);
    expect(screen.getByRole("img", { name: "CoTeach" })).toHaveAttribute(
      "width",
      "1122",
    );
  });
});
