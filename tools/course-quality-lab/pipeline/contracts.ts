export const V5_PIPELINE_VERSION = "course-quality-lab-v5-first-pass-v26";

export const V5_MODULE_CONTRACTS = {
  plan: {
    version: "explanation-first-teaching-contract-v5",
    dependencies: [],
  },
  slides: {
    version: "explicit-semantic-slide-v3",
    dependencies: ["plan"],
  },
  narration: {
    version: "explanation-first-narration-v11",
    dependencies: ["plan"],
  },
  actions: {
    version: "explicit-action-binding-v3",
    dependencies: ["slides", "narration"],
  },
  review: {
    version: "first-pass-evidence-review-v8",
    dependencies: ["plan", "slides", "narration", "actions"],
  },
  quiz: {
    version: "taught-content-quiz-v1",
    dependencies: ["narration", "review"],
  },
  audio: {
    version: "playback-bound-segment-audio-v2",
    dependencies: ["narration", "review"],
  },
  export: {
    version: "playable-course-export-v2",
    // Export intentionally does not depend on audio, so both can proceed once
    // their own prerequisites are ready.
    dependencies: ["slides", "actions", "quiz", "review"],
  },
} as const;

export type V5ModuleName = keyof typeof V5_MODULE_CONTRACTS;
