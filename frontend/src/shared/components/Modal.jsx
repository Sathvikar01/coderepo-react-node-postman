import { useEffect, useRef } from "react";
import { popDialog, pushDialog } from "./dialog-stack.js";

export function Modal({ children, className = "", label = "Tracer dialog", labelledBy, onClose }) {
	const reference = useRef(null);
	const closeReference = useRef(onClose);
	useEffect(() => {
		closeReference.current = onClose;
	}, [onClose]);
	useEffect(() => {
		const dialog = reference.current;
		const opener = document.activeElement;
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
			if (opener instanceof HTMLElement && document.contains(opener)) opener.focus();
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
