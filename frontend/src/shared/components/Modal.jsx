import { useEffect, useRef } from "react";

export function Modal({ children, className = "", label = "Request Desk dialog", labelledBy, onClose }) {
    const reference = useRef(null);
    const closeReference = useRef(onClose);
    useEffect(() => {
        closeReference.current = onClose;
    }, [onClose]);
    useEffect(() => {
        const dialog = reference.current;
        if (!dialog.open) dialog.showModal();
        window.requestAnimationFrame(() => dialog.querySelector("[autofocus], [data-autofocus]")?.focus());
        const cancel = (event) => {
            event.preventDefault();
            closeReference.current();
        };
        dialog.addEventListener("cancel", cancel);
        return () => dialog.removeEventListener("cancel", cancel);
    }, []);
    return (
        <dialog
            aria-label={labelledBy ? undefined : label}
            aria-labelledby={labelledBy}
            className={className}
            ref={reference}
            onMouseDown={(event) => {
                if (event.target === reference.current) closeReference.current();
            }}
        >
            {children}
        </dialog>
    );
}
