# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: brand-logo-animation.spec.ts >> home hero replays on refresh and client navigation back to home
- Location: e2e/brand-logo-animation.spec.ts:164:5

# Error details

```
Error: locator.evaluate: TypeError: Cannot read properties of undefined (reading 'currentTime')
    at eval (eval at evaluate (:303:30), <anonymous>:1:45)
    at UtilityScript.evaluate (<anonymous>:305:16)
    at UtilityScript.<anonymous> (<anonymous>:1:44)
```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - generic [ref=e2]:
    - generic [ref=e3]:
      - banner [ref=e4]:
        - generic [ref=e5]:
          - link "CoTeach 首页" [ref=e6] [cursor=pointer]:
            - /url: /
            - img "CoTeach" [ref=e8]
          - navigation [ref=e9]:
            - link "协同教学" [ref=e10] [cursor=pointer]:
              - /url: "#features"
            - link "课堂教学" [ref=e11] [cursor=pointer]:
              - /url: "#workflow"
            - link "开始学习" [ref=e12] [cursor=pointer]:
              - /url: /student/login
              - img [ref=e13]
              - text: 开始学习
      - generic [ref=e17]:
        - generic [ref=e18]:
          - img "CoTeach" [ref=e21]:
            - generic [ref=e58]:
              - img [ref=e60]
              - img [ref=e63]
              - img [ref=e65]
          - heading "共同教、共同学、共同创造" [level=1] [ref=e68]:
            - generic [ref=e69]: 共同教 · 共同学
            - text: · 共同创造
          - paragraph [ref=e70]: AI 协同教学平台
          - link "开始学习" [ref=e72] [cursor=pointer]:
            - /url: /student/login
            - img [ref=e73]
            - text: 开始学习
            - img [ref=e77]
        - generic [ref=e80]:
          - generic [ref=e81]: 向下探索
          - img [ref=e82]
      - region "每一种智慧，都在课堂中相遇" [ref=e85]:
        - generic [ref=e87]:
          - heading "每一种智慧，都在课堂中相遇" [level=2] [ref=e88]
          - paragraph [ref=e89]: 教师引导、学生探索、AI 讲授，共同推动学习发生。
          - generic [ref=e90]:
            - img "CoTeach" [ref=e93]:
              - generic [ref=e130]:
                - img [ref=e132]
                - img [ref=e135]
                - img [ref=e137]
            - generic "CoTeach 课堂参与角色" [ref=e140]:
              - article [ref=e141]:
                - img [ref=e143]
                - generic [ref=e146]:
                  - heading "教师" [level=3] [ref=e147]
                  - generic [ref=e148]: 教学主导
                - paragraph [ref=e149]: 设计课程与学习任务，组织课堂节奏，观察并评价学习过程。
                - list "教师的参与方式" [ref=e150]:
                  - listitem [ref=e151]: 课程设计
                  - listitem [ref=e152]: ·课堂引导
                  - listitem [ref=e153]: ·学习评价
              - article [ref=e154]:
                - img [ref=e156]
                - generic [ref=e159]:
                  - heading "学生" [level=3] [ref=e160]
                  - generic [ref=e161]: 学习主体
                - paragraph [ref=e162]: 主动探究、参与互动，在实践与交流中形成自己的理解和成果。
                - list "学生的参与方式" [ref=e163]:
                  - listitem [ref=e164]: 主动学习
                  - listitem [ref=e165]: ·协作实践
                  - listitem [ref=e166]: ·成果表达
              - article [ref=e167]:
                - img [ref=e169]
                - generic [ref=e170]:
                  - heading "AI" [level=3] [ref=e171]
                  - generic [ref=e172]: 共同教学者
                - paragraph [ref=e173]: 参与知识讲授与互动答疑，根据学习进展提供反馈，并与师生协作。
                - list "AI的参与方式" [ref=e174]:
                  - listitem [ref=e175]: 知识讲授
                  - listitem [ref=e176]: ·互动答疑
                  - listitem [ref=e177]: ·协作反馈
      - generic [ref=e179]:
        - heading "协同教学" [level=2] [ref=e181]
        - generic [ref=e182]:
          - article [ref=e184]:
            - generic [ref=e185]:
              - img [ref=e187]
              - heading "协同备课" [level=3] [ref=e191]
              - paragraph [ref=e192]: 教师与 AI 共同编排课程大纲、课件与教学活动。
          - article [ref=e194]:
            - generic [ref=e195]:
              - img [ref=e197]
              - heading "AI 授课" [level=3] [ref=e199]
              - paragraph [ref=e200]: AI 讲授课程知识，结合小测开展讲解与答疑。
          - article [ref=e202]:
            - generic [ref=e203]:
              - img [ref=e205]
              - heading "课堂协作" [level=3] [ref=e208]
              - paragraph [ref=e209]: 教师组织课堂，学生与 AI 开展学习互动和实践创作。
          - article [ref=e211]:
            - generic [ref=e212]:
              - img [ref=e214]
              - heading "学习记录与评价" [level=3] [ref=e218]
              - paragraph [ref=e219]: 查看学习成果、过程记录与评价反馈。
      - generic [ref=e221]:
        - heading "课堂教学" [level=2] [ref=e223]
        - generic "课堂教学环节：从课堂导入依次推进至学习反思" [ref=e225]:
          - generic [ref=e227]:
            - generic [ref=e228]:
              - img [ref=e231]
              - generic [ref=e234]:
                - img [ref=e235]
                - generic [ref=e237]: "1"
              - heading "课堂导入" [level=3] [ref=e238]
              - paragraph [ref=e239]: 教师明确学习主题、目标与任务
            - generic [ref=e240]:
              - img [ref=e243]
              - generic [ref=e246]:
                - img [ref=e247]
                - generic [ref=e249]: "2"
              - heading "知识讲授" [level=3] [ref=e250]
              - paragraph [ref=e251]: 教师与 AI 参与讲授，结合小测开展讲解与答疑
            - generic [ref=e252]:
              - img [ref=e255]
              - generic [ref=e258]:
                - img [ref=e259]
                - generic [ref=e264]: "3"
              - heading "协作实践" [level=3] [ref=e265]
              - paragraph [ref=e266]: 学生运用所学开展创作，与 AI 协作完成学习任务
            - generic [ref=e267]:
              - img [ref=e270]
              - generic [ref=e273]:
                - img [ref=e274]
                - generic [ref=e277]: "4"
              - heading "成果交流" [level=3] [ref=e278]
              - paragraph [ref=e279]: 展示学习成果，开展交流与评价
            - generic [ref=e280]:
              - generic [ref=e282]:
                - img [ref=e283]
                - generic [ref=e286]: "5"
              - heading "学习反思" [level=3] [ref=e287]
              - paragraph [ref=e288]: 回顾学习过程，梳理收获与问题
      - generic [ref=e290]:
        - heading "进入学习空间" [level=2] [ref=e292]
        - link "开始学习" [ref=e294] [cursor=pointer]:
          - /url: /student/login
          - img [ref=e295]
          - text: 开始学习
          - img [ref=e299]
      - contentinfo [ref=e301]:
        - generic [ref=e303]:
          - img "CoTeach" [ref=e306]
          - generic [ref=e307]: © 2026 CoTeach
    - region "Notifications alt+T"
  - alert [ref=e308]: CoTeach｜AI 协同教学平台
```