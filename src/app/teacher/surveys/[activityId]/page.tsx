"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BarChart3, ChevronLeft, ChevronRight, Clock3, ClipboardList, Maximize2, Minimize2, Pause, Play, Quote, RefreshCw, UserRound, UsersRound } from "lucide-react";
import { SurveyWordCloud } from "@/components/platform/survey-word-cloud";
import { teacherPlatformFetch } from "@/lib/platform/client";
import { TeacherPlatformHeader, TeacherPlatformPage } from "@/components/platform/teacher-shell";

type Respondent = { studentId: string; displayName: string; detail?: string };
type ChoiceQuestion = { id: string; title: string; type: "single-choice" | "multiple-choice"; chartType: "donut" | "bar" | "column"; required: boolean; responseCount: number; options: Array<{ id: string; label: string; count: number; percentage: number; respondents: Respondent[] }> };
type TextQuestion = { id: string; title: string; type: "short-text"; required: boolean; responseCount: number; responses: Array<Respondent & { content: string }>; terms: Array<{ label: string; value: number }> };
type SurveyResult = {
  activity: { id: string; title: string; description?: string | null; isOpen: boolean; chapter: { id: string; title: string }; offering: { id: string; name: string } };
  analytics: { submittedCount: number; totalStudents: number; completionRate: number; questions: Array<ChoiceQuestion | TextQuestion> };
  updatedAt: string;
};

const COLORS = ["#2563eb", "#0f766e", "#7c3aed", "#0891b2", "#c2410c", "#be185d", "#475569", "#4f46e5"];

function choiceGradient(options: ChoiceQuestion["options"]) {
  let cursor = 0;
  const stops = options.map((option, index) => {
    const start = cursor;
    cursor += option.percentage;
    return `${COLORS[index % COLORS.length]} ${start}% ${cursor}%`;
  });
  if (cursor < 100) stops.push(`#e8edf6 ${cursor}% 100%`);
  return `conic-gradient(${stops.join(",")})`;
}

function ChoiceChart({ question, selectedOptionId, onSelect }: { question: ChoiceQuestion; selectedOptionId: string | null; onSelect: (optionId: string) => void }) {
  if (question.chartType === "bar") return <div aria-label="选项比例条形图" className="survey-bar-chart" role="group">
    {question.options.map((option, index) => <button aria-label={`${option.label}，${option.percentage}%，${option.count} 人`} aria-pressed={selectedOptionId === option.id} className={selectedOptionId === option.id ? "is-selected" : ""} onClick={() => onSelect(option.id)} type="button" key={option.id}>
      <span><strong>{option.label}</strong><em>{option.percentage}%</em></span>
      <i><b style={{ backgroundColor: COLORS[index % COLORS.length], width: `${option.percentage}%` }} /></i>
    </button>)}
  </div>;
  if (question.chartType === "column") return <div aria-label="选项比例柱状图" className="survey-column-chart" role="group">
    {question.options.map((option, index) => <button aria-label={`${option.label}，${option.percentage}%，${option.count} 人`} aria-pressed={selectedOptionId === option.id} className={selectedOptionId === option.id ? "is-selected" : ""} onClick={() => onSelect(option.id)} type="button" key={option.id}>
      <strong>{option.percentage}%</strong><span><i style={{ backgroundColor: COLORS[index % COLORS.length], height: `${Math.max(option.percentage, option.count ? 5 : 1)}%` }} /></span><small>{option.label}</small>
    </button>)}
  </div>;
  return <div className="survey-donut-wrap"><div className="survey-donut" style={{ background: choiceGradient(question.options) }}><div><strong>{question.responseCount}</strong><span>有效回答</span></div></div><small className="survey-chart-hint">点击右侧选项查看实名学生</small></div>;
}

export default function SurveyDashboardPage() {
  const { activityId } = useParams<{ activityId: string }>();
  const stageRef = useRef<HTMLDivElement>(null);
  const [result, setResult] = useState<SurveyResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [presentation, setPresentation] = useState(false);
  const [autoPlay, setAutoPlay] = useState(false);
  const [selectedTerm, setSelectedTerm] = useState<string | null>(null);
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setRefreshing(true);
    try {
      const response = await teacherPlatformFetch(`/api/platform/activities/${activityId}/survey-results`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "无法加载问卷数据");
      setResult(data); setError("");
    } catch (reason) {
      if (!quiet) setError(reason instanceof Error ? reason.message : "加载失败");
    } finally {
      setLoading(false); if (!quiet) setRefreshing(false);
    }
  }, [activityId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const timer = window.setInterval(() => void load(true), 4_000); return () => window.clearInterval(timer); }, [load]);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("display") === "1") setPresentation(true);
    const sync = () => { if (!document.fullscreenElement) setPresentation(false); };
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);
  useEffect(() => {
    const count = result?.analytics.questions.length ?? 0;
    if (!presentation || !autoPlay || count < 2) return;
    const timer = window.setInterval(() => { setQuestionIndex((current) => (current + 1) % count); setSelectedTerm(null); setSelectedOptionId(null); }, 10_000);
    return () => window.clearInterval(timer);
  }, [autoPlay, presentation, result?.analytics.questions.length]);

  const questions = result?.analytics.questions ?? [];
  const current = questions[Math.min(questionIndex, Math.max(0, questions.length - 1))];
  const selectedResponses = useMemo(() => current?.type === "short-text" && selectedTerm
    ? current.responses.filter((response) => response.content.toLocaleLowerCase("zh-CN").includes(selectedTerm.toLocaleLowerCase("zh-CN")))
    : [], [current, selectedTerm]);
  const selectedOption = current?.type === "single-choice" || current?.type === "multiple-choice"
    ? current.options.find((option) => option.id === selectedOptionId) ?? null
    : null;

  async function togglePresentation() {
    if (presentation) {
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
      setPresentation(false); return;
    }
    setPresentation(true);
    await stageRef.current?.requestFullscreen?.().catch(() => undefined);
  }

  function selectQuestion(index: number) { setQuestionIndex(index); setSelectedTerm(null); setSelectedOptionId(null); }
  function step(offset: number) {
    if (!questions.length) return;
    selectQuestion((questionIndex + offset + questions.length) % questions.length);
  }

  const dashboard = (
    <div className={`survey-dashboard ${presentation ? "survey-dashboard--presentation" : "survey-dashboard--workspace"}`} ref={stageRef}>
      <div aria-hidden="true" className="survey-dashboard-grid" />
      <div className="survey-dashboard-frame">
        <header className="survey-board-heading">
          <div className="min-w-0">
            <div className="survey-board-kicker">
              <span>课堂问卷 · 实名数据简报</span>
              <span className={`survey-collection-state ${result?.activity.isOpen ? "is-live" : ""}`}>
                <i aria-hidden="true" />
                {result?.activity.isOpen ? "正在收集" : "已暂停收集"}
              </span>
            </div>
            <h1>{result?.activity.title ?? "问卷数据看板"}</h1>
            <p>{result ? `${result.activity.offering.name} · ${result.activity.chapter.title}` : "正在连接课堂数据…"}</p>
          </div>
          <div className="survey-board-actions">
            {presentation && questions.length > 1 ? (
              <button className="survey-screen-button" onClick={() => setAutoPlay((value) => !value)} type="button">
                {autoPlay ? <Pause size={16} /> : <Play size={16} />}
                {autoPlay ? "暂停轮播" : "开始轮播"}
              </button>
            ) : null}
            <button aria-label="刷新问卷数据" className="survey-screen-button" disabled={refreshing} onClick={() => void load()} type="button">
              <RefreshCw className={refreshing ? "animate-spin" : ""} size={16} />
              刷新
            </button>
            <button className="survey-screen-button survey-screen-button-primary" onClick={() => void togglePresentation()} type="button">
              {presentation ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
              {presentation ? "退出大屏" : "大屏显示"}
            </button>
          </div>
        </header>

        {error ? (
          <div className="survey-board-error">
            <p>{error}</p>
            <button onClick={() => void load()} type="button">重新加载</button>
          </div>
        ) : (
          <>
            <section aria-label="问卷概览" className="survey-overview-strip">
              <div className="survey-overview-lead">
                <span>课堂参与率</span>
                <strong>{loading ? "—" : result?.analytics.completionRate ?? 0}<small>%</small></strong>
                <div aria-hidden="true" className="survey-completion-track"><i style={{ width: `${result?.analytics.completionRate ?? 0}%` }} /></div>
              </div>
              <div className="survey-overview-item">
                <UsersRound size={18} />
                <span>已提交</span>
                <strong>{loading ? "—" : result?.analytics.submittedCount ?? 0}<small> / {result?.analytics.totalStudents ?? 0} 人</small></strong>
              </div>
              <div className="survey-overview-item">
                <ClipboardList size={18} />
                <span>问卷题目</span>
                <strong>{loading ? "—" : questions.length}<small> 题</small></strong>
              </div>
              <div className="survey-overview-item">
                <Clock3 size={18} />
                <span>最近更新</span>
                <strong className="survey-overview-time">{result ? new Date(result.updatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—"}</strong>
              </div>
            </section>

            {questions.length ? (
              <div className="survey-workbench">
                <aside className="survey-question-rail">
                  <div className="survey-question-rail-heading">
                    <div><span>题目目录</span><strong>{questions.length} 题</strong></div>
                    <small>{String(questionIndex + 1).padStart(2, "0")} / {String(questions.length).padStart(2, "0")}</small>
                  </div>
                  <nav aria-label="选择问卷题目" className="survey-question-list">
                    {questions.map((question, index) => (
                      <button aria-current={index === questionIndex ? "true" : undefined} className="survey-question-tab" onClick={() => selectQuestion(index)} type="button" key={question.id}>
                        <span className="survey-question-number">{String(index + 1).padStart(2, "0")}</span>
                        <span className="survey-question-copy"><strong>{question.title}</strong><small>{question.type === "single-choice" ? "单项选择" : question.type === "multiple-choice" ? "多项选择" : "简答观点"} · {question.responseCount} 份回答</small></span>
                      </button>
                    ))}
                  </nav>
                  {questions.length > 1 ? (
                    <div className="survey-question-controls">
                      <button aria-label="上一题" onClick={() => step(-1)} type="button"><ChevronLeft size={17} /></button>
                      <span>{autoPlay && presentation ? "每 10 秒自动轮播" : "手动浏览题目"}</span>
                      <button aria-label="下一题" onClick={() => step(1)} type="button"><ChevronRight size={17} /></button>
                    </div>
                  ) : null}
                </aside>

                <section className="survey-insight-canvas survey-chart-enter" key={current?.id}>
                  <header className="survey-insight-heading">
                    <div>
                      <p>问题 {String(questionIndex + 1).padStart(2, "0")} · {current?.type === "short-text" ? "观点聚合" : current?.type === "multiple-choice" ? "多选分布" : "选择分布"}</p>
                      <h2>{current?.title}</h2>
                    </div>
                    <div className="survey-insight-meta">
                      <span>{current?.responseCount ?? 0} 份回答</span>
                      {questions.length > 1 ? (
                        <nav aria-label="大屏题目切换" className="survey-display-pager">
                          <button aria-label="上一题" onClick={() => step(-1)} type="button"><ChevronLeft size={18} /></button>
                          <strong>{String(questionIndex + 1).padStart(2, "0")} / {String(questions.length).padStart(2, "0")}</strong>
                          <button aria-label="下一题" onClick={() => step(1)} type="button"><ChevronRight size={18} /></button>
                        </nav>
                      ) : null}
                    </div>
                  </header>

                  {current?.type === "single-choice" || current?.type === "multiple-choice" ? (
                    <div className="survey-choice-layout">
                      <ChoiceChart question={current} selectedOptionId={selectedOptionId} onSelect={(optionId) => setSelectedOptionId((selected) => selected === optionId ? null : optionId)} />
                      <div className="survey-choice-list">
                        {current.options.map((option, index) => (
                          <button aria-pressed={selectedOptionId === option.id} className={`survey-choice-row ${selectedOptionId === option.id ? "is-selected" : ""}`} onClick={() => setSelectedOptionId((selected) => selected === option.id ? null : option.id)} type="button" key={option.id}>
                            <div>
                              <span className="survey-choice-label"><i style={{ backgroundColor: COLORS[index % COLORS.length] }} />{option.label}</span>
                              <strong>{option.percentage}% <small>{option.count} 人</small></strong>
                            </div>
                            <div className="survey-choice-track"><i className="survey-choice-bar" style={{ backgroundColor: COLORS[index % COLORS.length], width: `${option.percentage}%` }} /></div>
                          </button>
                        ))}
                        <section aria-live="polite" className={`survey-choice-respondents ${selectedOption ? "is-visible" : ""}`}>
                          {selectedOption ? <>
                            <div className="survey-choice-respondents-heading"><div><UsersRound size={16} /><span>选择“{selectedOption.label}”的学生</span></div><strong>{selectedOption.respondents.length} 人</strong></div>
                            {selectedOption.respondents.length ? <div className="survey-student-name-list">{selectedOption.respondents.map((student) => <div className="survey-choice-response" key={student.studentId}><span><UserRound size={14} />{student.displayName}</span>{student.detail ? <p>{student.detail}</p> : null}</div>)}</div> : <p>当前没有学生选择此项。</p>}
                          </> : <p>点击任一选项，查看选择该答案的实名学生名单。</p>}
                        </section>
                      </div>
                    </div>
                  ) : current?.type === "short-text" ? (
                    <div className="survey-text-layout">
                      <SurveyWordCloud large={presentation} terms={current.terms} selected={selectedTerm} onSelect={(term) => setSelectedTerm((selected) => selected === term.label ? null : term.label)} />
                      <aside className="survey-response-echo">
                        <div className="survey-response-echo-heading">
                          <p>观点摘录</p>
                          <span>点击左侧关键词筛选</span>
                        </div>
                        {selectedTerm ? (
                          <>
                            <div className="survey-selected-term">
                              <h3>{selectedTerm}</h3>
                              <span>{current.terms.find((term) => term.label === selectedTerm)?.value ?? 0} 人提及</span>
                            </div>
                            <div className="survey-response-list">
                              {selectedResponses.length ? selectedResponses.map((response, index) => (
                                <blockquote key={`${response.studentId}-${index}`}><p>{response.content}</p><footer><Quote size={13} /><span>{response.displayName}</span></footer></blockquote>
                              )) : <p className="survey-response-empty">暂无包含该关键词的原回答。</p>}
                            </div>
                          </>
                        ) : (
                          <div className="survey-response-placeholder">
                            <BarChart3 size={26} />
                            <p>选择一个关键词</p>
                            <span>这里会展示相关的实名原回答，帮助教师理解词频背后的真实观点。</span>
                          </div>
                        )}
                      </aside>
                    </div>
                  ) : null}
                </section>
              </div>
            ) : !loading ? (
              <div className="survey-board-empty">
                <BarChart3 size={34} />
                <p>问卷还没有可统计的题目</p>
                <span>返回课程编辑问卷后，数据会自动出现在这里。</span>
              </div>
            ) : <div className="survey-board-loading" />}
          </>
        )}
      </div>
    </div>
  );

  if (presentation) return <main className="survey-teacher-page">{dashboard}</main>;
  return <TeacherPlatformPage><TeacherPlatformHeader active="classes" backHref={result ? `/teacher/classes/${result.activity.offering.id}` : "/teacher/classes"} backLabel="返回课程" /><div className="pbl-workspace-content"><div className="survey-teacher-page">{dashboard}</div></div></TeacherPlatformPage>;
}
