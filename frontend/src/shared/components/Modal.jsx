import { useEffect, useRef } from "react";
import { popDialog, pushDialog } from "./dialog-stack.js";

export function Modal({ children, className = "", label = "Tracer dialog", labelledBy, onClose }) {
	const reference = useRef(null);
	const closeReference = useRef(onClose);
	const openerReference = useRef(null);
	useEffect(() => {
		closeReference.current = onClose;
	}, [onClose]);
	useEffect(() => {
		const dialog = reference.current;
		// Capture the trigger once per dialog instance. This effect runs twice under
		// StrictMode, and on the second run focus has already moved into the dialog,
		// so re-reading activeElement would return the dialog's own field.
		if (openerReference.current === null && document.activeElement instanceof HTMLElement) {
			openerReference.current = document.activeElement;
		}
		const token = { onClose: () => closeReference.current() };
		pushDialog(token);
		if (!dialog.open) dialog.showModal();
		window.requestAnimationFrame(() => dialog.querySelector("[autofocus], [data-autofocus]")?.focus());
		const cancel = (event) => {
			// One Escape reaches every open dialog as a cancel event; the dialog stack
			// consumes the key once and closes the top dialog, so this only stops the
			// browser from closing any dialog on its own.
			event.preventDefault();
		};
		dialog.addEventListener("cancel", cancel);
		return () => {
			popDialog(token);
			dialog.removeEventListener("cancel", cancel);
			// Returning focus to the trigger keeps keyboard users where they were.
			const opener = openerReference.current;
			if (opener && document.contains(opener) && opener !== document.activeElement) opener.focus();
		};
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
