/**
 * Stage API - Whiteboard Management
 *
 * Factory function that creates the whiteboard namespace of the Stage API.
 * Handles whiteboard CRUD and whiteboard element operations.
 */

import type { Whiteboard } from '@openmaic/lib/types/stage';
import type { PPTElement } from '@openmaic/dsl';
import type { StageStore, APIResult } from './stage-api-types';
import { generateId } from './stage-api-defaults';
import {
  removeWhiteboardElement,
  resolveWhiteboardElementAnchors,
  upsertWhiteboardElement,
} from '@openmaic/lib/whiteboard/projection';

const SCENE_WHITEBOARD_PREFIX = 'whiteboard-scene:';

/** Stable page scope for whiteboard content. */
export function whiteboardIdForScene(sceneId: string | null | undefined): string | undefined {
  return sceneId ? `${SCENE_WHITEBOARD_PREFIX}${sceneId}` : undefined;
}

/**
 * Create the whiteboard management API
 *
 * @param store - Zustand store instance
 * @returns Whiteboard namespace API
 */
export function createWhiteboardAPI(store: StageStore) {
  const whiteboardAPI = {
    /**
     * Create a whiteboard
     *
     * @returns Whether successful
     */
    create(whiteboardId?: string): APIResult<Whiteboard> {
      try {
        const state = store.getState();
        const existing = whiteboardId
          ? state.stage?.whiteboard?.find((item) => item.id === whiteboardId)
          : undefined;
        if (existing) return { success: true, data: existing };
        const whiteboard: Whiteboard = {
          id: whiteboardId ?? generateId('whiteboard'),
          viewportSize: 1000,
          viewportRatio: 16 / 9,
          elements: [],
          background: {
            type: 'solid',
            color: '#ffffff',
          },
          animations: [],
        };
        const whiteboardList = state.stage?.whiteboard
          ? [...state.stage.whiteboard, whiteboard]
          : [whiteboard];
        store.setState({
          stage: { ...state.stage, whiteboard: whiteboardList },
        });
        return { success: true, data: whiteboard };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    /**
     * Get a whiteboard
     *
     * @returns The most recently created whiteboard object
     */
    get(whiteboardId?: string): APIResult<Whiteboard> {
      try {
        const state = store.getState();
        if (whiteboardId) {
          const scoped = state.stage?.whiteboard?.find((item) => item.id === whiteboardId);
          return scoped ? { success: true, data: scoped } : whiteboardAPI.create(whiteboardId);
        }
        if (!state.stage?.whiteboard || state.stage.whiteboard.length === 0) {
          return whiteboardAPI.create();
        }
        return { success: true, data: state.stage.whiteboard.at(-1) };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    /**
     * Update a whiteboard
     *
     * @param updates - Fields to update
     * @param whiteboardId - Whiteboard ID
     * @returns Whether successful
     */
    update(updates: Partial<Whiteboard>, whiteboardId: string): APIResult<boolean> {
      try {
        const state = store.getState();
        const whiteboard = state.stage?.whiteboard?.find((wb) => wb.id === whiteboardId);
        if (!whiteboard) return { success: false, error: 'Whiteboard not found' };
        const newWhiteboard = {
          ...whiteboard,
          ...updates,
          ...(updates.elements ? { elements: resolveWhiteboardElementAnchors(updates.elements) } : {}),
        };
        const whiteboardList = state.stage!.whiteboard!.map((wb) =>
          wb.id === whiteboardId ? newWhiteboard : wb,
        );
        store.setState({
          stage: { ...state.stage, whiteboard: whiteboardList },
        });
        return { success: true, data: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    /**
     * Delete a whiteboard
     *
     * @param whiteboardId - Whiteboard ID
     * @returns Whether successful
     */
    delete(whiteboardId: string): APIResult<boolean> {
      try {
        const state = store.getState();
        const whiteboardList = state.stage!.whiteboard!.filter((wb) => wb.id !== whiteboardId);
        store.setState({
          stage: { ...state.stage, whiteboard: whiteboardList },
        });
        return { success: true, data: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    /**
     * Get all whiteboards
     *
     * @returns List of all whiteboards
     */
    list(): APIResult<Whiteboard[]> {
      try {
        const state = store.getState();
        return { success: true, data: state.stage!.whiteboard! };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    /**
     * Get a whiteboard element
     *
     * @param elementId - Element ID
     * @param whiteboardId - Whiteboard ID
     * @returns Element object
     */
    getElement(elementId: string, whiteboardId: string): APIResult<PPTElement> {
      try {
        const state = store.getState();
        const whiteboard = state.stage!.whiteboard!.find((wb) => wb.id === whiteboardId);
        if (!whiteboard) return { success: false, error: 'Whiteboard not found' };
        return {
          success: true,
          data: whiteboard.elements.find((el) => el.id === elementId),
        };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    /**
     * Add or replace a whiteboard element by its stable ID
     *
     * @param element - Element object
     * @param whiteboardId - Whiteboard ID
     * @returns Whether successful
     */
    addElement(element: PPTElement, whiteboardId: string): APIResult<boolean> {
      try {
        const state = store.getState();
        const whiteboard = state.stage!.whiteboard!.find((wb) => wb.id === whiteboardId);
        if (!whiteboard) return { success: false, error: 'Whiteboard not found' };
        const newElement = {
          ...element,
          id: element.id || generateId(element.type),
        };
        const newWhiteboard = {
          ...whiteboard,
          elements: upsertWhiteboardElement(whiteboard.elements, newElement),
        };
        const whiteboardList = state.stage!.whiteboard!.map((wb) =>
          wb.id === whiteboardId ? newWhiteboard : wb,
        );
        store.setState({
          stage: { ...state.stage, whiteboard: whiteboardList },
        });
        return { success: true, data: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    /**
     * Delete a whiteboard element
     *
     * @param elementId - Element ID
     * @param whiteboardId - Whiteboard ID
     * @returns Whether successful
     */
    deleteElement(elementId: string, whiteboardId: string): APIResult<boolean> {
      try {
        const state = store.getState();
        const whiteboard = state.stage!.whiteboard!.find((wb) => wb.id === whiteboardId);
        if (!whiteboard) return { success: false, error: 'Whiteboard not found' };
        const newWhiteboard = {
          ...whiteboard,
          elements: removeWhiteboardElement(whiteboard.elements, elementId),
        };
        const whiteboardList = state.stage!.whiteboard!.map((wb) =>
          wb.id === whiteboardId ? newWhiteboard : wb,
        );
        store.setState({
          stage: { ...state.stage, whiteboard: whiteboardList },
        });
        return { success: true, data: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    /**
     * Update a whiteboard element
     *
     * @param element - Element object
     * @param whiteboardId - Whiteboard ID
     * @returns Whether successful
     */
    updateElement(element: PPTElement, whiteboardId: string): APIResult<boolean> {
      try {
        const state = store.getState();
        const whiteboard = state.stage!.whiteboard!.find((wb) => wb.id === whiteboardId);
        if (!whiteboard) return { success: false, error: 'Whiteboard not found' };
        const newWhiteboard = {
          ...whiteboard,
          elements: resolveWhiteboardElementAnchors(
            whiteboard.elements.map((el) => (el.id === element.id ? element : el)),
          ),
        };
        const whiteboardList = state.stage!.whiteboard!.map((wb) =>
          wb.id === whiteboardId ? newWhiteboard : wb,
        );
        store.setState({
          stage: { ...state.stage, whiteboard: whiteboardList },
        });
        return { success: true, data: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    /**
     * Get whiteboard element list
     *
     * @param whiteboardId - Whiteboard ID
     * @returns Element list
     */
    listElements(whiteboardId: string): APIResult<PPTElement[]> {
      try {
        const state = store.getState();
        const whiteboard = state.stage!.whiteboard!.find((wb) => wb.id === whiteboardId);
        if (!whiteboard) return { success: false, error: 'Whiteboard not found' };
        return { success: true, data: whiteboard.elements };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  };

  return whiteboardAPI;
}
