import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "tracer-split-ratio";
const MIN = 0.22;
const MAX = 0.78;
const DEFAULT_RATIO = 0.45;

function readStoredRatio() {
    const stored = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(stored) && stored >= MIN && stored <= MAX ? stored : DEFAULT_RATIO;
}

export function useSplitPane(containerRef) {
    const [ratio, setRatio] = useState(readStoredRatio);
    const ratioRef = useRef(ratio);
    const dragging = useRef(false);

    const onPointerDown = useCallback((event) => {
        event.preventDefault();
        dragging.current = true;
        event.currentTarget.setPointerCapture?.(event.pointerId);
    }, []);

    useEffect(() => {
        const onMove = (event) => {
            if (!dragging.current || !containerRef.current) return;
            const bounds = containerRef.current.getBoundingClientRect();
            if (bounds.height < 80) return;
            const next = Math.min(MAX, Math.max(MIN, (event.clientY - bounds.top) / bounds.height));
            ratioRef.current = next;
            setRatio(next);
        };
        const onUp = () => {
            if (!dragging.current) return;
            dragging.current = false;
            localStorage.setItem(STORAGE_KEY, String(ratioRef.current));
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onUp);
        return () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            window.removeEventListener("pointercancel", onUp);
        };
    }, [containerRef]);

    const onKeyDown = useCallback((event) => {
        const step = event.shiftKey ? 0.08 : 0.02;
        let next = null;
        if (event.key === "ArrowUp") next = Math.max(MIN, ratioRef.current - step);
        else if (event.key === "ArrowDown") next = Math.min(MAX, ratioRef.current + step);
        else if (event.key === "Enter") next = DEFAULT_RATIO;
        if (next === null) return;
        event.preventDefault();
        ratioRef.current = next;
        setRatio(next);
        localStorage.setItem(STORAGE_KEY, String(next));
    }, []);

    return { ratio, onPointerDown, onKeyDown };
}
