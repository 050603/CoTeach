const OFFERING_STATUS_LABELS: Record<string, string> = {
  draft: "草稿",
  open: "开放",
  finished: "已结课",
  archived: "已归档",
  DRAFT: "草稿",
  OPEN: "开放",
  FINISHED: "已结课",
  ARCHIVED: "已归档",
};

const ACTIVITY_TYPE_LABELS: Record<string, string> = {
  Classroom: "课堂",
  Assignment: "作业",
  Quiz: "测验",
  Form: "问卷",
  Resource: "参考资料",
  CLASSROOM: "课堂",
  ASSIGNMENT: "作业",
  QUIZ: "测验",
  FORM: "问卷",
  RESOURCE: "参考资料",
};

const INSTANCE_STATUS_LABELS: Record<string, string> = {
  scheduled: "待开始",
  teaching: "进行中",
  finished: "已结束",
  archived: "已归档",
  SCHEDULED: "待开始",
  TEACHING: "进行中",
  FINISHED: "已结束",
  ARCHIVED: "已归档",
};

const TEMPLATE_VERSION_STATUS_LABELS: Record<string, string> = {
  draft: "草稿",
  ready: "已就绪",
  archived: "已归档",
  DRAFT: "草稿",
  PUBLISHED: "已发布",
  ACTIVE: "使用中",
  ARCHIVED: "已归档",
};

const PROGRESS_STATUS_LABELS: Record<string, string> = {
  not_started: "未开始",
  in_progress: "进行中",
  completed: "已完成",
  NOT_STARTED: "未开始",
  IN_PROGRESS: "进行中",
  COMPLETED: "已完成",
};

export function offeringStatusLabel(status: string): string {
  return OFFERING_STATUS_LABELS[status] ?? "未知状态";
}

export function activityTypeLabel(type: string): string {
  return ACTIVITY_TYPE_LABELS[type] ?? "其他活动";
}

export function instanceStatusLabel(status: string): string {
  return INSTANCE_STATUS_LABELS[status] ?? "未知状态";
}

export function templateVersionStatusLabel(status: string): string {
  return TEMPLATE_VERSION_STATUS_LABELS[status] ?? "未知状态";
}

export function progressStatusLabel(status: string): string {
  return PROGRESS_STATUS_LABELS[status] ?? "未知状态";
}
