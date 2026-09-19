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
            setRatio(next);
        };
        const onUp = () => {
            if (!dragging.current) return;
            dragging.current = false;
            setRatio((current) => {
                localStorage.setItem(STORAGE_KEY, String(current));
                return current;
            });
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
        if (event.key === "ArrowUp") setRatio((current) => Math.max(MIN, current - step));
        else if (event.key === "ArrowDown") setRatio((current) => Math.min(MAX, current + step));
        else if (event.key === "Enter") setRatio(DEFAULT_RATIO);
        else return;
        event.preventDefault();
        setRatio((current) => {
            localStorage.setItem(STORAGE_KEY, String(current));
            return current;
        });
    }, []);

    return { ratio, onPointerDown, onKeyDown };
}
