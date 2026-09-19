import { useRef } from "react";

export function useRovingTabs({ orientation = "horizontal" } = {}) {
    const listRef = useRef(null);
    const onKeyDown = (event) => {
        const list = listRef.current;
        if (!list) return;
        const tabs = [...list.querySelectorAll('[role="tab"]:not([disabled])')];
        const index = tabs.indexOf(document.activeElement);
        if (index === -1) return;
        const previous = orientation === "vertical" ? ["ArrowUp", "ArrowLeft"] : ["ArrowLeft", "ArrowUp"];
        const next = orientation === "vertical" ? ["ArrowDown", "ArrowRight"] : ["ArrowRight", "ArrowDown"];
        let target = null;
        if (previous.includes(event.key)) target = tabs[(index - 1 + tabs.length) % tabs.length];
        else if (next.includes(event.key)) target = tabs[(index + 1) % tabs.length];
        else if (event.key === "Home") target = tabs[0];
        else if (event.key === "End") target = tabs[tabs.length - 1];
        if (!target) return;
        event.preventDefault();
        target.focus();
    };
    return { listRef, onKeyDown };
}
