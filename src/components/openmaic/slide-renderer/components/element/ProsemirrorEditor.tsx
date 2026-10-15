'use client';

import { useRef, useEffect, useCallback, useMemo, useImperativeHandle, forwardRef } from 'react';
import { flushSync } from 'react-dom';
import { debounce } from 'lodash';
import { useKeyboardStore, useCanvasStore } from '@openmaic/lib/store';
import { useSceneHistory } from '@openmaic/lib/contexts/scene-context';
import type { EditorView } from 'prosemirror-view';
import { toggleMark, wrapIn, lift } from 'prosemirror-commands';
import { initProsemirrorEditor, createDocument } from '@openmaic/lib/prosemirror';
import {
  isActiveOfParentNodeType,
  findNodesWithSameMark,
  getTextAttrs,
  autoSelectAll,
  addMark,
  markActive,
  getFontsize,
} from '@openmaic/lib/prosemirror/utils';
import emitter, {
  EmitterEvents,
  type RichTextAction,
  type RichTextCommand,
} from '@openmaic/lib/utils/emitter';
import { alignmentCommand } from '@openmaic/lib/prosemirror/commands/setTextAlign';
import { indentCommand, textIndentCommand } from '@openmaic/lib/prosemirror/commands/setTextIndent';
import { toggleList } from '@openmaic/lib/prosemirror/commands/toggleList';
import { setListStyle } from '@openmaic/lib/prosemirror/commands/setListStyle';
import { replaceText } from '@openmaic/lib/prosemirror/commands/replaceText';
import {
  registerActiveTextEditor,
  type TextCommandPayload,
} from '@openmaic/lib/prosemirror/active-editor-registry';
import { shouldPushAttrs } from '@openmaic/lib/prosemirror/selection-sync';
import type { TextFormatPainterKeys } from '@openmaic/lib/types/edit';

const EXTERNAL_CONTENT_SYNC = 'external-content-sync';

export interface ProsemirrorEditorProps {
  elementId: string;
  defaultColor: string;
  defaultFontName: string;
  value: string;
  editable?: boolean;
  autoFocus?: boolean;
  onUpdate?: (payload: { value: string; ignore: boolean }) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onMouseDown?: (e: React.MouseEvent) => void;
}

export interface ProsemirrorEditorRef {
  focus: () => void;
}

/**
 * ProseMirror rich text Editor component
 * Handles complex text editing with support for formatting, lists, links, etc.
 */
export const ProsemirrorEditor = forwardRef<ProsemirrorEditorRef, ProsemirrorEditorProps>(
  (
    {
      elementId,
      defaultColor,
      defaultFontName,
      value,
      editable = false,
      autoFocus = false,
      onUpdate,
      onFocus,
      onBlur,
      onMouseDown,
    },
    ref,
  ) => {
    const editorViewRef = useRef<HTMLDivElement>(null);
    const editorView = useRef<EditorView | null>(null);
    // Mutable refs so the single-init dispatchTransaction always reads fresh values
    const editableRef = useRef(editable);
    const pushTextAttrsRef = useRef<((view: EditorView) => void) | null>(null);
    const valueRef = useRef(value);
    const onUpdateRef = useRef(onUpdate);
    const lastEmittedValueRef = useRef<string | null>(null);
    const sceneHistory = useSceneHistory();
    valueRef.current = value;
    onUpdateRef.current = onUpdate;

    const handleElementId = useCanvasStore.use.handleElementId();
    const editingElementId = useCanvasStore.use.editingElementId();
    const textFormatPainter = useCanvasStore.use.textFormatPainter();
    const richTextAttrs = useCanvasStore.use.richTextAttrs();
    const activeElementIdList = useCanvasStore.use.activeElementIdList();
    const setDisableHotkeysState = useCanvasStore.use.setDisableHotkeysState();
    const setRichtextAttrs = useCanvasStore.use.setRichtextAttrs();
    const setTextFormatPainter = useCanvasStore.use.setTextFormatPainter();
    const ctrlOrShiftKeyActive = useKeyboardStore((state) => state.ctrlOrShiftKeyActive());

    // Handle input with debounce

    const handleInput = useMemo(
      () =>
        debounce(
          (isHandleHistory = false) => {
            if (!editorView.current) return;
            if (
              valueRef.current.replace(/ style=""/g, '') ===
              editorView.current.dom.innerHTML.replace(/ style=""/g, '')
            )
              return;
            const nextValue = editorView.current.dom.innerHTML;
            lastEmittedValueRef.current = nextValue;
            onUpdateRef.current?.({
              value: nextValue,
              ignore: isHandleHistory,
            });
          },
          300,
          { trailing: true },
        ),
      [],
    );

    // Handle focus
    const handleFocus = useCallback(() => {
      // Don't disable hotkeys if ctrl/shift is pressed and multiple elements are selected
      if (!ctrlOrShiftKeyActive || activeElementIdList.length <= 1) {
        setDisableHotkeysState(true);
      }
      if (editorView.current) pushTextAttrsRef.current?.(editorView.current);
      onFocus?.();
    }, [ctrlOrShiftKeyActive, activeElementIdList.length, setDisableHotkeysState, onFocus]);

    // Handle blur
    const handleBlur = useCallback(() => {
      handleInput.flush();
      setDisableHotkeysState(false);
      onBlur?.();
    }, [handleInput, setDisableHotkeysState, onBlur]);

    // Handle click
    // eslint-disable-next-line react-hooks/exhaustive-deps -- debounce returns a stable function reference
    const handleClick = useCallback(
      debounce(
        () => {
          if (!editorView.current) return;
          const attrs = getTextAttrs(editorView.current, {
            color: defaultColor,
            fontname: defaultFontName,
          });
          setRichtextAttrs(attrs);
        },
        30,
        { trailing: true },
      ),
      [defaultColor, defaultFontName, setRichtextAttrs],
    );

    const handleKeydown = useCallback((event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (sceneHistory && (event.ctrlKey || event.metaKey) && !event.altKey && !event.isComposing
        && (key === 'z' || key === 'y')) {
        event.preventDefault();
        // Flush the pending text before moving the shared history cursor.
        // Restoring a snapshot must also restore its original HTML and size.
        flushSync(() => handleInput.flush());
        if (key === 'y' || event.shiftKey) sceneHistory.redo();
        else sceneHistory.undo();
        return true;
      }
      handleClick();
      return false;
    }, [sceneHistory, handleInput, handleClick]);

    // Stable attrs push used by the selection-sync dispatchTransaction guard
    const pushTextAttrs = useCallback(
      (view: EditorView) => {
        setRichtextAttrs(getTextAttrs(view, { color: defaultColor, fontname: defaultFontName }));
      },
      [defaultColor, defaultFontName, setRichtextAttrs],
    );
    // Keep mutable refs current on every render so the once-init dispatchTransaction reads fresh values
    editableRef.current = editable;
    pushTextAttrsRef.current = pushTextAttrs;

    // Execute rich text command
    const execCommand = useCallback(
      ({ target, action }: RichTextCommand) => {
        if (!editorView.current) return;
        if (!target && handleElementId !== elementId) return;
        if (target && target !== elementId) return;

        const actions = 'command' in action ? [action] : action;

        for (const item of actions) {
          if (item.command === 'fontname' && item.value !== undefined) {
            const mark = editorView.current.state.schema.marks.fontname.create({
              fontname: item.value,
            });
            autoSelectAll(editorView.current);
            addMark(editorView.current, mark);
          } else if (item.command === 'fontsize' && item.value) {
            const mark = editorView.current.state.schema.marks.fontsize.create({
              fontsize: item.value,
            });
            autoSelectAll(editorView.current);
            addMark(editorView.current, mark);
            setListStyle(editorView.current, {
              key: 'fontsize',
              value: item.value,
            });
          } else if (item.command === 'fontsize-add') {
            const step = item.value ? +item.value : 2;
            autoSelectAll(editorView.current);
            const fontsize = getFontsize(editorView.current) + step + 'px';
            const mark = editorView.current.state.schema.marks.fontsize.create({
              fontsize,
            });
            addMark(editorView.current, mark);
            setListStyle(editorView.current, {
              key: 'fontsize',
              value: fontsize,
            });
          } else if (item.command === 'fontsize-reduce') {
            const step = item.value ? +item.value : 2;
            autoSelectAll(editorView.current);
            let fontsize = getFontsize(editorView.current) - step;
            if (fontsize < 12) fontsize = 12;
            const mark = editorView.current.state.schema.marks.fontsize.create({
              fontsize: fontsize + 'px',
            });
            addMark(editorView.current, mark);
            setListStyle(editorView.current, {
              key: 'fontsize',
              value: fontsize + 'px',
            });
          } else if (item.command === 'color' && item.value) {
            const mark = editorView.current.state.schema.marks.forecolor.create({
              color: item.value,
            });
            autoSelectAll(editorView.current);
            addMark(editorView.current, mark);
            setListStyle(editorView.current, {
              key: 'color',
              value: item.value,
            });
          } else if (item.command === 'backcolor' && item.value) {
            const mark = editorView.current.state.schema.marks.backcolor.create({
              backcolor: item.value,
            });
            autoSelectAll(editorView.current);
            addMark(editorView.current, mark);
          } else if (item.command === 'bold') {
            autoSelectAll(editorView.current);
            toggleMark(editorView.current.state.schema.marks.strong)(
              editorView.current.state,
              editorView.current.dispatch,
            );
          } else if (item.command === 'em') {
            autoSelectAll(editorView.current);
            toggleMark(editorView.current.state.schema.marks.em)(
              editorView.current.state,
              editorView.current.dispatch,
            );
          } else if (item.command === 'underline') {
            autoSelectAll(editorView.current);
            toggleMark(editorView.current.state.schema.marks.underline)(
              editorView.current.state,
              editorView.current.dispatch,
            );
          } else if (item.command === 'strikethrough') {
            autoSelectAll(editorView.current);
            toggleMark(editorView.current.state.schema.marks.strikethrough)(
              editorView.current.state,
              editorView.current.dispatch,
            );
          } else if (item.command === 'subscript') {
            toggleMark(editorView.current.state.schema.marks.subscript)(
              editorView.current.state,
              editorView.current.dispatch,
            );
          } else if (item.command === 'superscript') {
            toggleMark(editorView.current.state.schema.marks.superscript)(
              editorView.current.state,
              editorView.current.dispatch,
            );
          } else if (item.command === 'blockquote') {
            const isBlockquote = isActiveOfParentNodeType('blockquote', editorView.current.state);
            if (isBlockquote) lift(editorView.current.state, editorView.current.dispatch);
            else
              wrapIn(editorView.current.state.schema.nodes.blockquote)(
                editorView.current.state,
                editorView.current.dispatch,
              );
          } else if (item.command === 'code') {
            toggleMark(editorView.current.state.schema.marks.code)(
              editorView.current.state,
              editorView.current.dispatch,
            );
          } else if (item.command === 'align' && item.value) {
            alignmentCommand(editorView.current, item.value);
          } else if (item.command === 'indent' && item.value) {
            indentCommand(editorView.current, +item.value);
          } else if (item.command === 'textIndent' && item.value) {
            textIndentCommand(editorView.current, +item.value);
          } else if (item.command === 'bulletList') {
            const listStyleType = item.value || '';
            const { bullet_list: bulletList, list_item: listItem } =
              editorView.current.state.schema.nodes;
            const textStyle = {
              color: richTextAttrs.color,
              fontsize: richTextAttrs.fontsize,
            };
            toggleList(
              bulletList,
              listItem,
              listStyleType,
              textStyle,
            )(editorView.current.state, editorView.current.dispatch);
          } else if (item.command === 'orderedList') {
            const listStyleType = item.value || '';
            const { ordered_list: orderedList, list_item: listItem } =
              editorView.current.state.schema.nodes;
            const textStyle = {
              color: richTextAttrs.color,
              fontsize: richTextAttrs.fontsize,
            };
            toggleList(
              orderedList,
              listItem,
              listStyleType,
              textStyle,
            )(editorView.current.state, editorView.current.dispatch);
          } else if (item.command === 'clear') {
            autoSelectAll(editorView.current);
            const { $from, $to } = editorView.current.state.selection;
            editorView.current.dispatch(editorView.current.state.tr.removeMark($from.pos, $to.pos));
            setListStyle(editorView.current, [
              { key: 'fontsize', value: '' },
              { key: 'color', value: '' },
            ]);
          } else if (item.command === 'link') {
            const markType = editorView.current.state.schema.marks.link;
            const { from, to } = editorView.current.state.selection;
            const result = findNodesWithSameMark(editorView.current.state.doc, from, to, markType);
            if (result) {
              if (item.value) {
                const mark = editorView.current.state.schema.marks.link.create({
                  href: item.value,
                  title: item.value,
                });
                addMark(editorView.current, mark, {
                  from: result.from.pos,
                  to: result.to.pos + 1,
                });
              } else
                editorView.current.dispatch(
                  editorView.current.state.tr.removeMark(
                    result.from.pos,
                    result.to.pos + 1,
                    markType,
                  ),
                );
            } else if (markActive(editorView.current.state, markType)) {
              if (item.value) {
                const mark = editorView.current.state.schema.marks.link.create({
                  href: item.value,
                  title: item.value,
                });
                addMark(editorView.current, mark);
              } else toggleMark(markType)(editorView.current.state, editorView.current.dispatch);
            } else if (item.value) {
              autoSelectAll(editorView.current);
              toggleMark(markType, { href: item.value, title: item.value })(
                editorView.current.state,
                editorView.current.dispatch,
              );
            }
          } else if (item.command === 'insert' && item.value) {
            editorView.current.dispatch(editorView.current.state.tr.insertText(item.value));
          } else if (item.command === 'replace' && item.value) {
            replaceText(editorView.current, item.value);
          }
        }

        editorView.current.focus();
        handleClick();
      },
      [handleElementId, elementId, richTextAttrs, handleClick],
    );

    // Additive bridge: map a surface-driven TextCommandPayload onto the SAME
    // existing RichTextAction switch (execCommand). This reuses the renderer's
    // existing ProseMirror command implementations verbatim — no new schema,
    // no behavior change. `target: elementId` routes to THIS element exactly
    // like the existing targeted-command semantics already in execCommand.
    const runCommand = useCallback(
      (payload: TextCommandPayload) => {
        if (!editorView.current) return;
        switch (payload.command) {
          case 'bold':
          case 'em':
          case 'underline':
          // bulletList: undefined value → execCommand defaults to the standard bullet (item.value || '')
          case 'bulletList':
          case 'fontname':
          case 'fontsize':
            execCommand({
              target: elementId,
              action: { command: payload.command, value: payload.value },
            });
            break;
          case 'forecolor':
            execCommand({
              target: elementId,
              action: { command: 'color', value: payload.value },
            });
            break;
          case 'align-left':
          case 'align-center':
          case 'align-right':
            execCommand({
              target: elementId,
              action: {
                command: 'align',
                value: payload.command.replace('align-', ''),
              },
            });
            break;
          default: {
            const _exhaustive: never = payload.command;
            void _exhaustive;
          }
        }
      },
      [execCommand, elementId],
    );

    // Register the runner only while this element is editable. Playback uses
    // editable=false → this effect early-returns → nothing registers, so the
    // renderer is byte-unchanged on the playback/uncontrolled path (PR1-shaped).
    useEffect(() => {
      if (!editable) return;
      const off = registerActiveTextEditor(elementId, runCommand, () => editorView.current?.focus());
      return off;
    }, [editable, elementId, runCommand]);

    // Handle mouseup for format painter
    const handleMouseup = useCallback(() => {
      if (!textFormatPainter || !editorView.current) return;
      const { keep, ...newProps } = textFormatPainter;

      const actions: RichTextAction[] = [{ command: 'clear' }];
      for (const key of Object.keys(newProps) as TextFormatPainterKeys[]) {
        const command = key;
        const value = textFormatPainter[key];
        if (value === true) actions.push({ command });
        else if (value) actions.push({ command, value });
      }
      execCommand({ action: actions });
      if (!keep) setTextFormatPainter(null);
    }, [textFormatPainter, execCommand, setTextFormatPainter]);

    // Sync attrs to store
    const syncAttrsToStore = useCallback(() => {
      if (handleElementId !== elementId) return;
      handleClick();
    }, [handleElementId, elementId, handleClick]);

    // The EditorView is mounted once. Its DOM listeners must still use the
    // current callbacks after a selection, formatting or content change.
    const handlersRef = useRef({ handleFocus, handleBlur, handleKeydown, handleClick, handleMouseup });
    handlersRef.current = { handleFocus, handleBlur, handleKeydown, handleClick, handleMouseup };

    // Initialize ProseMirror Editor
    useEffect(() => {
      if (!editorViewRef.current) return;

      editorView.current = initProsemirrorEditor(editorViewRef.current, value, {
        handleDOMEvents: {
          focus: () => { handlersRef.current.handleFocus(); },
          blur: () => {
            handlersRef.current.handleClick.cancel();
            handlersRef.current.handleBlur();
          },
          keydown: (_view, event) => handlersRef.current.handleKeydown(event),
          click: () => { handlersRef.current.handleClick(); },
          mouseup: () => { handlersRef.current.handleMouseup(); },
        },
        editable: () => editable,
        dispatchTransaction(this: EditorView, tr) {
          // Apply the transaction (replicates ProseMirror's default dispatch)
          const newState = this.state.apply(tr);
          this.updateState(newState);
          if (editableRef.current && tr.docChanged && !tr.getMeta(EXTERNAL_CONTENT_SYNC)) {
            handleInput();
          }
          // Additive: push toolbar attrs on selection/doc/marks change — editable only.
          // Playback path (editable=false) is never reached → byte-unchanged.
          if (editableRef.current && shouldPushAttrs(tr)) {
            pushTextAttrsRef.current?.(this);
          }
        },
      });

      if (autoFocus) {
        editorView.current.focus();
      }

      return () => {
        handleInput.flush();
        handleInput.cancel();
        handlersRef.current.handleClick.cancel();
        if (editorView.current?.hasFocus()) setDisableHotkeysState(false);
        editorView.current?.destroy();
        editorView.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Sync content to DOM
    useEffect(() => {
      if (!editorView.current) return;
      // A saved value can return through the canvas after typing has already
      // continued. Its acknowledgement must not replace the newer input.
      if (value === lastEmittedValueRef.current) {
        lastEmittedValueRef.current = null;
        return;
      }
      lastEmittedValueRef.current = null;

      const { doc, tr } = editorView.current.state;
      const nextDoc = createDocument(value);
      if (doc.eq(nextDoc)) return;
      handleInput.cancel();
      editorView.current.dispatch(tr.replaceRangeWith(0, doc.content.size, nextDoc)
        .setMeta(EXTERNAL_CONTENT_SYNC, true).setMeta('addToHistory', false));
    }, [value, handleInput]);

    // Toggle editable mode
    useEffect(() => {
      if (!editorView.current) return;
      if (!editable) {
        handleInput.flush();
        if (editorView.current.hasFocus()) editorView.current.dom.blur();
      }
      editorView.current.setProps({ editable: () => editable });
    }, [editable, handleInput]);

    // Setup emitter listeners
    useEffect(() => {
      emitter.on(EmitterEvents.RICH_TEXT_COMMAND, execCommand);
      emitter.on(EmitterEvents.SYNC_RICH_TEXT_ATTRS_TO_STORE, syncAttrsToStore);

      return () => {
        emitter.off(EmitterEvents.RICH_TEXT_COMMAND, execCommand);
        emitter.off(EmitterEvents.SYNC_RICH_TEXT_ATTRS_TO_STORE, syncAttrsToStore);
      };
    }, [execCommand, syncAttrsToStore]);

    // Auto-focus when the surface picks this element as the editing
    // target. Fixes "insert a text element from the floating toolbar →
    // have to click inside again to type" — after the insert, the slide
    // surface's `useEditingTextElementId` mirrors the new element's id
    // into `canvasStore.editingElementId`. This effect catches that
    // transition and pushes focus into the freshly mounted ProseMirror
    // view. The `hasFocus()` guard avoids re-focusing on every render
    // for an already-active editor.
    useEffect(() => {
      if (!editable) return;
      if (editingElementId !== elementId) return;
      const view = editorView.current;
      if (!view || view.hasFocus()) return;
      view.focus();
    }, [editingElementId, elementId, editable]);

    // Expose focus method
    useImperativeHandle(ref, () => ({
      focus: () => {
        if (editorView.current) {
          editorView.current.focus();
        }
      },
    }));

    return (
      <div
        ref={editorViewRef}
        className={`prosemirror-editor cursor-text ${textFormatPainter ? 'format-painter' : ''}`}
        onMouseDown={(e) => onMouseDown?.(e)}
      />
    );
  },
);

ProsemirrorEditor.displayName = 'ProsemirrorEditor';
