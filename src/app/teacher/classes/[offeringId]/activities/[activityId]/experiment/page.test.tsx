import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Page from "./page";

vi.mock("next/navigation", () => ({ useParams: () => ({ offeringId: "course-1", activityId: "classroom-1" }), usePathname: () => "/teacher/classes/course-1/activities/classroom-1/experiment" }));

const target = { id: "classroom-1", title: "设计课堂", type: "Classroom", version: 3, config: { schemaVersion: 1, content: "课堂说明", customSetting: { sample: "preserve" } } };
const sourceExperiment = {
  enabled: true,
  sharedQuestions: [{ id: "source-shared", type: "single-choice", prompt: "学习意愿", options: ["愿意", "暂时不愿意"] }],
  pretest: [{ id: "source-pre", type: "short-answer", prompt: "课前看法" }],
  posttest: [{ id: "source-post", type: "scale", prompt: "协作体验", scale: { min: 1, max: 5 } }],
  scenarioPair: { a: { id: "scenario-a", type: "short-answer", prompt: "情境 A" }, b: { id: "scenario-b", type: "short-answer", prompt: "情境 B" } },
  randomizeQuestionOrder: true,
  randomizeOptionOrder: true,
};
const offerings = [
  { id: "course-1", name: "当前教学班", chapters: [{ id: "chapter-1", title: "第一章", activities: [target] }] },
  { id: "course-2", name: "往期教学班", chapters: [{ id: "chapter-2", title: "第二章", activities: [{ id: "classroom-2", title: "实验示范课", type: "Classroom", version: 2, config: { experiment: sourceExperiment } }] }] },
];

let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === "PATCH") return new Response(JSON.stringify({ activity: { ...target, version: 4 } }));
    return new Response(JSON.stringify({ offerings }));
  });
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function savedExperiment() {
  const request = fetcher.mock.calls.find(([url, options]) => url === "/api/platform/activities/classroom-1/manage" && options?.method === "PATCH");
  return JSON.parse(String(request?.[1]?.body));
}

describe("独立实验模式配置页", () => {
  it("saves an opinion choice question without an answer key and preserves lesson settings", async () => {
    render(<Page />);
    fireEvent.click(await screen.findByRole("switch", { name: "开启实验模式" }));
    fireEvent.click(screen.getByRole("button", { name: "添加共用题目" }));
    fireEvent.change(screen.getByLabelText("共用第 1 题题干"), { target: { value: "你愿意参加这项任务吗？" } });
    fireEvent.change(screen.getByLabelText("共用第 1 题选项 1"), { target: { value: "愿意" } });
    fireEvent.change(screen.getByLabelText("共用第 1 题选项 2"), { target: { value: "不愿意" } });
    fireEvent.click(screen.getAllByRole("button", { name: "保存实验配置" })[0]);

    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/platform/activities/classroom-1/manage", expect.objectContaining({ method: "PATCH" })));
    const body = savedExperiment();
    expect(body.version).toBe(3);
    expect(body.config).toMatchObject({ content: "课堂说明", customSetting: { sample: "preserve" }, experiment: { enabled: true, sharedQuestions: [{ prompt: "你愿意参加这项任务吗？", options: ["愿意", "不愿意"] }] } });
    expect(body.config.experiment.sharedQuestions[0]).not.toHaveProperty("correctAnswer");
  });

  it("duplicates questions with fresh IDs and shows a student view for both phases", async () => {
    render(<Page />);
    fireEvent.click(await screen.findByRole("switch", { name: "开启实验模式" }));
    fireEvent.click(screen.getByRole("button", { name: "添加共用题目" }));
    fireEvent.change(screen.getByLabelText("共用第 1 题题干"), { target: { value: "你的选择？" } });
    fireEvent.change(screen.getByLabelText("共用第 1 题选项 1"), { target: { value: "A" } });
    fireEvent.change(screen.getByLabelText("共用第 1 题选项 2"), { target: { value: "B" } });
    fireEvent.click(screen.getByRole("button", { name: "复制共用第 1 题" }));
    expect(screen.getByLabelText("共用第 2 题题干")).toHaveValue("你的选择？");
    fireEvent.click(screen.getByRole("tab", { name: "学生视角预览" }));
    expect(screen.getByLabelText("前测题目预览")).toHaveTextContent("你的选择？");
    fireEvent.click(screen.getByRole("tab", { name: "后测" }));
    expect(screen.getByLabelText("后测题目预览")).toHaveTextContent("你的选择？");
    fireEvent.click(screen.getAllByRole("button", { name: "保存实验配置" })[0]);
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/platform/activities/classroom-1/manage", expect.objectContaining({ method: "PATCH" })));
    const ids = savedExperiment().config.experiment.sharedQuestions.map((question: { id: string }) => question.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("imports pasted spreadsheet rows together and reports invalid row numbers", async () => {
    render(<Page />);
    fireEvent.click(await screen.findByRole("tab", { name: "批量添加与复用" }));
    fireEvent.change(screen.getByLabelText("粘贴题目表格"), { target: { value: "单选题\t学习意愿？\t愿意|不愿意\t\t学习信心\n量表题\t我有信心\t1-5\t\t任务信心" } });
    fireEvent.click(screen.getByRole("button", { name: "批量添加题目" }));
    expect(screen.getByRole("tab", { name: "共用题 2" })).toBeInTheDocument();
    expect(screen.getByLabelText("共用第 1 题题干")).toHaveValue("学习意愿？");
    fireEvent.click(screen.getByRole("tab", { name: "批量添加与复用" }));
    fireEvent.change(screen.getByLabelText("粘贴题目表格"), { target: { value: "单选题\t缺少选项\t只有一个\n简答题\t可用题" } });
    fireEvent.click(screen.getByRole("button", { name: "批量添加题目" }));
    expect(screen.getByRole("alert")).toHaveTextContent("第 1 行");
    fireEvent.click(screen.getByRole("tab", { name: "编辑题目" }));
    expect(screen.getByRole("tab", { name: "共用题 2" })).toBeInTheDocument();
  });

  it("copies a whole configuration from another course with new question IDs", async () => {
    render(<Page />);
    fireEvent.click(await screen.findByRole("tab", { name: "批量添加与复用" }));
    fireEvent.change(screen.getByLabelText("选择已有课堂"), { target: { value: "classroom-2" } });
    fireEvent.click(screen.getByRole("button", { name: "复制整套配置" }));
    expect(screen.getByRole("tab", { name: "共用题 1" })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "保存实验配置" })[0]);
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/platform/activities/classroom-1/manage", expect.objectContaining({ method: "PATCH" })));
    const copied = savedExperiment().config.experiment;
    expect(copied).toMatchObject({ sharedQuestions: [{ prompt: "学习意愿" }], scenarioPair: { a: { prompt: "情境 A" }, b: { prompt: "情境 B" } } });
    expect(copied.sharedQuestions[0].id).not.toBe("source-shared");
    expect(copied.scenarioPair.a.id).not.toBe("scenario-a");
  });

  it("copies a single question from another course into the chosen bank", async () => {
    render(<Page />);
    fireEvent.click(await screen.findByRole("tab", { name: "批量添加与复用" }));
    fireEvent.change(screen.getByLabelText("选择已有课堂"), { target: { value: "classroom-2" } });
    fireEvent.change(screen.getByLabelText("复制题目到"), { target: { value: "sharedQuestions" } });
    fireEvent.click(screen.getAllByRole("button", { name: "复制此题" })[0]);
    expect(screen.getByLabelText("共用第 1 题题干")).toHaveValue("学习意愿");
    fireEvent.click(screen.getAllByRole("button", { name: "保存实验配置" })[0]);
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/platform/activities/classroom-1/manage", expect.objectContaining({ method: "PATCH" })));
    expect(savedExperiment().config.experiment.sharedQuestions[0].id).not.toBe("source-shared");
    expect(savedExperiment().config.experiment.sharedQuestions[0]).not.toHaveProperty("correctAnswer");
  });

  it("configures a titled scale group once and shows it in both student previews", async () => {
    render(<Page />);
    fireEvent.click(await screen.findByRole("switch", { name: "开启实验模式" }));
    fireEvent.click(screen.getByRole("button", { name: "添加量表题组" }));
    fireEvent.change(screen.getByLabelText("共用题组 1 标题"), { target: { value: "任务信心" } });
    fireEvent.change(screen.getByLabelText("共用题组 1 作答说明"), { target: { value: "请根据当前感受，选择最符合的一项。" } });
    fireEvent.change(screen.getByLabelText("共用第 1 题题干"), { target: { value: "我能完成任务" } });
    fireEvent.change(screen.getByLabelText("共用第 2 题题干"), { target: { value: "我能解决问题" } });
    fireEvent.click(screen.getByRole("tab", { name: "学生视角预览" }));
    expect(screen.getByRole("region", { name: "任务信心" })).toHaveTextContent("请根据当前感受，选择最符合的一项。");
    fireEvent.click(screen.getByRole("tab", { name: "后测" }));
    expect(screen.getByRole("region", { name: "任务信心" })).toHaveTextContent("我能解决问题");
    fireEvent.click(screen.getAllByRole("button", { name: "保存实验配置" })[0]);
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/platform/activities/classroom-1/manage", expect.objectContaining({ method: "PATCH" })));
    const questions = savedExperiment().config.experiment.sharedQuestions;
    expect(questions).toHaveLength(2);
    expect(questions[0].group).toMatchObject({ title: "任务信心", instruction: "请根据当前感受，选择最符合的一项。" });
    expect(questions[1].group).toEqual(questions[0].group);
  });

  it("copies an entire titled group from another lesson with fresh question and group IDs", async () => {
    const group = { id: "source-group", title: "协作体验", instruction: "根据课堂体验作答" };
    const groupedOfferings = [offerings[0], {
      ...offerings[1], chapters: [{ ...offerings[1].chapters[0], activities: [{ ...offerings[1].chapters[0].activities[0], config: {
        experiment: { ...sourceExperiment, posttest: [
          { id: "source-scale-1", type: "scale", prompt: "合作顺利", scale: { min: 1, max: 5 }, group },
          { id: "source-scale-2", type: "scale", prompt: "沟通清楚", scale: { min: 1, max: 5 }, group },
        ] },
      } }] }],
    }];
    fetcher.mockImplementation(async (_url: string, options?: RequestInit) => new Response(JSON.stringify(options?.method === "PATCH" ? { activity: { ...target, version: 4 } } : { offerings: groupedOfferings })));
    render(<Page />);
    fireEvent.click(await screen.findByRole("tab", { name: "批量添加与复用" }));
    fireEvent.change(screen.getByLabelText("选择已有课堂"), { target: { value: "classroom-2" } });
    fireEvent.click(screen.getByRole("button", { name: "复制整个题组" }));
    expect(screen.getByLabelText("共用第 1 题题干")).toHaveValue("合作顺利");
    expect(screen.getByLabelText("共用第 2 题题干")).toHaveValue("沟通清楚");
    fireEvent.click(screen.getAllByRole("button", { name: "保存实验配置" })[0]);
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/platform/activities/classroom-1/manage", expect.objectContaining({ method: "PATCH" })));
    const questions = savedExperiment().config.experiment.sharedQuestions;
    expect(questions[0].id).not.toBe("source-scale-1");
    expect(questions[0].group.id).not.toBe("source-group");
    expect(questions[0].group).toEqual(questions[1].group);
  });
});
