import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react';

const MIN_PANEL_WIDTH = 390;
const MIN_DIAGRAM_WIDTH = 280;
const DIVIDER_WIDTH = 8;

export function useQueryPanelResize(editorOpen: boolean, sidebarOpen: boolean) {
    const workspaceRef = useRef<HTMLDivElement>(null);
    const drag = useRef<{ pointerId: number; target: HTMLDivElement; startX: number; startWidth: number } | null>(null);
    const [workspaceWidth, setWorkspaceWidth] = useState(0);
    const [preferredWidth, setPreferredWidth] = useState<number | null>(null);
    const [resizing, setResizing] = useState(false);
    const maxWidth = Math.max(MIN_PANEL_WIDTH, workspaceWidth - MIN_DIAGRAM_WIDTH - DIVIDER_WIDTH);
    const clampWidth = (width: number) => Math.min(maxWidth, Math.max(MIN_PANEL_WIDTH, width));
    const panelWidth = clampWidth(preferredWidth ?? Math.min(580, workspaceWidth * .44));

    const stopResizing = useCallback(() => {
        const active = drag.current;
        drag.current = null;
        setResizing(false);
        if (active?.target.hasPointerCapture(active.pointerId)) active.target.releasePointerCapture(active.pointerId);
    }, []);

    useLayoutEffect(() => {
        const workspace = workspaceRef.current;
        if (!workspace) return;
        const measure = () => {
            setWorkspaceWidth(workspace.clientWidth);
            // A window or sidebar resize changes the coordinate space of an active drag.
            stopResizing();
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(workspace);
        return () => observer.disconnect();
    }, [stopResizing]);

    useEffect(stopResizing, [editorOpen, sidebarOpen, stopResizing]);
    useEffect(() => {
        window.addEventListener('blur', stopResizing);
        return () => window.removeEventListener('blur', stopResizing);
    }, [stopResizing]);

    const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
        if (!event.isPrimary || event.button !== 0 || drag.current) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId, target: event.currentTarget, startX: event.clientX, startWidth: panelWidth };
        setResizing(true);
    };
    const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
        if (!drag.current || drag.current.pointerId !== event.pointerId) return;
        setPreferredWidth(clampWidth(drag.current.startWidth + drag.current.startX - event.clientX));
    };
    const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
        // Commit the release position even if the browser coalesced the last move.
        onPointerMove(event);
        if (drag.current?.pointerId === event.pointerId) stopResizing();
    };
    const onPointerCancel = (event: PointerEvent<HTMLDivElement>) => {
        if (drag.current?.pointerId === event.pointerId) stopResizing();
    };
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        const step = event.shiftKey ? 96 : 24;
        switch (event.key) {
            case 'ArrowLeft': setPreferredWidth(clampWidth(panelWidth + step)); break;
            case 'ArrowRight': setPreferredWidth(clampWidth(panelWidth - step)); break;
            case 'Home': setPreferredWidth(MIN_PANEL_WIDTH); break;
            case 'End': setPreferredWidth(maxWidth); break;
            case 'Enter': setPreferredWidth(null); break;
            default: return;
        }
        event.preventDefault();
    };

    return {
        workspaceRef,
        resizing,
        style: { '--query-panel-width': `${panelWidth}px` } as CSSProperties,
        dividerProps: {
            role: 'separator',
            tabIndex: 0,
            'aria-label': 'Resize SQL editor panel',
            'aria-controls': 'sql-query-panel',
            'aria-orientation': 'vertical' as const,
            'aria-valuemin': MIN_PANEL_WIDTH,
            'aria-valuemax': Math.round(maxWidth),
            'aria-valuenow': Math.round(panelWidth),
            'aria-valuetext': `${Math.round(panelWidth)} pixels wide`,
            title: 'Drag to resize. Use Left/Right arrows; Home/End for limits. Double-click or press Enter to reset.',
            onPointerDown,
            onPointerMove,
            onPointerUp,
            onPointerCancel,
            onLostPointerCapture: onPointerCancel,
            onDoubleClick: () => setPreferredWidth(null),
            onKeyDown,
        },
    };
}
