'use client';

import type { TComment } from '@/components/ui/comment';

import { createPlatePlugin } from 'platejs/react';

import { BlockDiscussion } from '@/components/ui/block-discussion';

export type TDiscussion = {
  id: string;
  comments: TComment[];
  createdAt: Date;
  isResolved: boolean;
  userId: string;
  documentContent?: string;
  isUnread?: boolean;
  source?: 'ai-proactive' | 'student';
};

export type AiDiscussionReplyHandler = (input: {
  discussionId: string;
  message: string;
}) => Promise<void>;

export type AiDiscussionReadHandler = (input: {
  discussionId: string;
}) => Promise<void>;

export type AiSuggestionDecisionHandler = (decision: 'accepted' | 'rejected') => void;

export type AiPendingCommentSuggestion = {
  threadId: string;
  assistantCommentId?: string;
  title: string;
  targetText: string;
  replacement: string;
  reason: string;
  error?: string | null;
};

const BLOCK_SUGGESTION_SELECTOR = '[data-block-suggestion="true"]';

const getTargetElement = (target: EventTarget | null) => {
  if (target instanceof HTMLElement) return target;
  if (target instanceof Node) return target.parentElement;

  return null;
};

export const getDiscussionClickTarget = ({
  selector,
  target,
}: {
  selector: string;
  target: EventTarget | null;
}) => {
  const element = getTargetElement(target);

  if (!element) return null;

  return element.closest(selector) as HTMLElement | null;
};

export const getDiscussionBlockClickTarget = ({
  selector = BLOCK_SUGGESTION_SELECTOR,
  target,
}: {
  selector?: string;
  target: EventTarget | null;
}) =>
  getDiscussionClickTarget({
    selector,
    target,
  });

const usersData: Record<
  string,
  { id: string; avatarUrl: string; name: string; hue?: number }
> = {
  student: {
    id: 'student',
    avatarUrl: '/openmaic/avatars/user.png',
    name: '我',
  },
  'ai-member': {
    id: 'ai-member',
    avatarUrl: '/openmaic/avatars/assist.png',
    name: 'AI 组员',
  },
};

// Plate owns the native discussion UI state. CoTeach hydrates the actual
// paragraph threads from its server store instead of shipping demo comments.
export const discussionPlugin = createPlatePlugin({
  key: 'discussion',
  options: {
    currentUserId: 'student',
    discussions: [] as TDiscussion[],
    onAiRead: undefined as AiDiscussionReadHandler | undefined,
    onAiReply: undefined as AiDiscussionReplyHandler | undefined,
    onAiSuggestionDecision: undefined as AiSuggestionDecisionHandler | undefined,
    pendingAiCommentSuggestion: undefined as AiPendingCommentSuggestion | undefined,
    users: usersData,
  },
})
  .configure({
    render: { aboveNodes: BlockDiscussion },
  })
  .extendSelectors(({ getOption }) => ({
    currentUser: () => getOption('users')[getOption('currentUserId')],
    user: (id: string) => getOption('users')[id],
  }));

export const DiscussionKit = [discussionPlugin];
