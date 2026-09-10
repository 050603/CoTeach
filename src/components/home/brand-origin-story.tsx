import { PraixisOriginWord } from "@/components/brand/praixis-origin-word";

export function BrandOriginStory() {
  return (
    <section
      aria-labelledby="brand-origin-title"
      className="praixis-origin border-b border-[var(--pbl-border)]"
    >
      <div className="pbl-wide-container px-6 py-24 md:px-10 md:py-32">
        <div className="mx-auto max-w-5xl text-center">
          <p className="praixis-origin__eyebrow">FROM PRAXIS TO PRAIXIS</p>
          <h2
            id="brand-origin-title"
            className="mt-4 text-[length:clamp(1.75rem,4vw,3rem)] font-extrabold tracking-tight text-[var(--pbl-text-strong)] [text-wrap:balance]"
          >
            实践，是起点
          </h2>

          <div className="praixis-origin__stage mt-14" aria-label="Praxis 演变为 PrAIxis">
            <PraixisOriginWord />

            <div className="praixis-origin__meaning">
              <article className="praixis-origin__praxis-copy">
                <span className="praixis-origin__step">01 · PRAXIS</span>
                <span className="praixis-origin__greek">πρᾶξις · praxis</span>
                <p>
                  源自古希腊语 <strong>prassein</strong>，意为“做、行动”
                </p>
                <div className="praixis-origin__taxonomy-group">
                  <div className="praixis-origin__taxonomy">
                    <span>
                      <strong>Theoria</strong>
                      <small>理论 · 追求真理</small>
                    </span>
                    <span>
                      <strong>Poiesis</strong>
                      <small>创造 · 生产制作</small>
                    </span>
                    <span className="is-praxis">
                      <strong>Praxis</strong>
                      <small>实践 · 具体行动</small>
                    </span>
                  </div>
                  <div className="praixis-origin__aristotle">
                    <span>思想来源</span>
                    <strong>Aristotle · 亚里士多德</strong>
                    <small>人类活动的三种基本方式</small>
                  </div>
                </div>
              </article>

              <div className="praixis-origin__bridge" aria-hidden="true">
                <span>+</span>
                <small>AI 参与其中</small>
              </div>

              <article className="praixis-origin__praixis-copy">
                <span className="praixis-origin__step">02 · PRAIXIS</span>
                <p className="praixis-origin__thesis">AI 进入实践，不替代实践</p>
                <div className="praixis-origin__roles" aria-label="PrAIxis 的角色关系">
                  <span>AI · 参与者</span>
                  <span>AI · 支架</span>
                  <span>AI · 协作者</span>
                </div>
                <p>
                  学生始终拥有
                  <strong>判断、行动、证据与反思</strong>
                </p>
              </article>
            </div>
          </div>

          <p className="praixis-origin__closing">
            Pr<span>AI</span>xis 所代表的，不是“用 AI 完成项目”，
            <strong>而是“与 AI 一起实践，并通过实践真正学习”。</strong>
          </p>
        </div>
      </div>
    </section>
  );
}
