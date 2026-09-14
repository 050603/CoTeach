import { CoTeachLogoAnimation } from "@/components/brand/coteach-logo-animation";
import { AudioLines, Compass, Presentation } from "lucide-react";

export function BrandOriginStory() {
  const roles = [
    {
      name: "教师",
      key: "teacher",
      icon: Presentation,
      identity: "教学主导",
      description: "设计课程与学习任务，组织课堂节奏，观察并评价学习过程。",
      abilities: ["课程设计", "课堂引导", "学习评价"],
    },
    {
      name: "学生",
      key: "student",
      icon: Compass,
      identity: "学习主体",
      description: "主动探究、参与互动，在实践与交流中形成自己的理解和成果。",
      abilities: ["主动学习", "协作实践", "成果表达"],
    },
    {
      name: "AI",
      key: "ai",
      icon: AudioLines,
      identity: "共同教学者",
      description: "参与知识讲授与互动答疑，根据学习进展提供反馈，并与师生协作。",
      abilities: ["知识讲授", "互动答疑", "协作反馈"],
    },
  ] as const;

  return (
    <section
      aria-labelledby="brand-origin-title"
      className="coteach-origin border-b border-[var(--pbl-border)]"
    >
      <div className="pbl-wide-container px-6 py-24 md:px-10 md:py-32">
        <div className="mx-auto max-w-5xl text-center">
          <h2
            id="brand-origin-title"
            className="pbl-section-title text-[length:clamp(1.75rem,4vw,3rem)] font-extrabold tracking-tight [text-wrap:balance]"
          >
            每一种智慧，都在课堂中相遇
          </h2>
          <p className="coteach-origin__intro">
            教师引导、学生探索、AI 讲授，共同推动学习发生。
          </p>

          <div className="coteach-origin__stage mt-14">
            <div className="coteach-origin__word">
              <CoTeachLogoAnimation playback="once" />
            </div>

            <div className="coteach-origin__role-list" aria-label="CoTeach 课堂参与角色">
              {roles.map((role) => {
                const Icon = role.icon;
                return (
                  <article
                    className="coteach-origin__role"
                    data-role={role.key}
                    key={role.name}
                  >
                    <div className="coteach-origin__role-symbol" aria-hidden="true">
                      <Icon size={44} strokeWidth={1.35} />
                    </div>
                    <div className="coteach-origin__role-heading">
                      <h3>{role.name}</h3>
                      <span>{role.identity}</span>
                    </div>
                    <p>{role.description}</p>
                    <ul aria-label={`${role.name}的参与方式`}>
                      {role.abilities.map((ability) => <li key={ability}>{ability}</li>)}
                    </ul>
                  </article>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
