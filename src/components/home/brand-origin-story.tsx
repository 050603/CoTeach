import { CoTeachLogoAnimation } from "@/components/brand/coteach-logo-animation";

export function BrandOriginStory() {
  return (
    <section
      aria-labelledby="brand-origin-title"
      className="coteach-origin border-b border-[var(--pbl-border)]"
    >
      <div className="pbl-wide-container px-6 py-24 md:px-10 md:py-32">
        <div className="mx-auto max-w-5xl text-center">
          <p className="coteach-origin__eyebrow">CO · TEACH · LEARN</p>
          <h2
            id="brand-origin-title"
            className="mt-4 text-[length:clamp(1.75rem,4vw,3rem)] font-extrabold tracking-tight text-[var(--pbl-text-strong)] [text-wrap:balance]"
          >
            教学，不再是一场独奏
          </h2>

          <div className="coteach-origin__stage mt-14" aria-label="CoTeach 协同教学理念">
            <div className="coteach-origin__word">
              <CoTeachLogoAnimation playback="once" />
            </div>

            <div className="coteach-origin__meaning">
              <article className="coteach-origin__co-copy">
                <span className="coteach-origin__step">01 · CO</span>
                <span className="coteach-origin__concept">CO · 共同参与</span>
                <p>
                  让课堂中的每个角色都成为<strong>学习共同体</strong>的一员
                </p>
                <div className="coteach-origin__taxonomy-group">
                  <div className="coteach-origin__taxonomy">
                    <span>
                      <strong>教师</strong>
                      <small>设计 · 引导判断</small>
                    </span>
                    <span>
                      <strong>学生</strong>
                      <small>探究 · 付诸行动</small>
                    </span>
                    <span className="is-co">
                      <strong>AI</strong>
                      <small>支架 · 协同反馈</small>
                    </span>
                  </div>
                  <div className="coteach-origin__community">
                    <span>共同目标</span>
                    <strong>Teaching Community · 教学共同体</strong>
                    <small>围绕真实问题共同设计、实践与反思</small>
                  </div>
                </div>
              </article>

              <div className="coteach-origin__bridge" aria-hidden="true">
                <span>+</span>
                <small>共同设计</small>
              </div>

              <article className="coteach-origin__coteach-copy">
                <span className="coteach-origin__step">02 · TEACH</span>
                <p className="coteach-origin__thesis">协同教学，不替代人的判断</p>
                <div className="coteach-origin__roles" aria-label="CoTeach 的协同关系">
                  <span>共同备课</span>
                  <span>共同实践</span>
                  <span>共同评价</span>
                </div>
                <p>
                  教师与学生始终拥有
                  <strong>判断、行动、证据与反思</strong>
                </p>
              </article>
            </div>
          </div>

          <p className="coteach-origin__closing">
            Co<span>Teach</span> 所代表的，不是让 AI 接管课堂，
            <strong>而是让教师、学生与 AI 在真实问题中共同教、共同学、共同创造。</strong>
          </p>
        </div>
      </div>
    </section>
  );
}
