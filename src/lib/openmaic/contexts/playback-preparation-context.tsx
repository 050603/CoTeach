'use client';

import { createContext, useContext } from 'react';

/** Refresh durable assets before starting a generated-preview scene. */
export const PlaybackPreparationContext = createContext<((sceneId: string) => Promise<boolean>) | undefined>(undefined);
export const usePlaybackPreparation = () => useContext(PlaybackPreparationContext);
