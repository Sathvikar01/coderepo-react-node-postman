// LIFO registry of open modal dialogs. Chrome dispatches one Escape key as a
// `cancel` event to every open dialog, and React unmount timing can reorder those
// events, so a naive "only the top dialog closes" guard still lets two dialogs
// close for one keypress. Instead Escape is consumed exactly once here: the
// dialog stack closes its top entry and every Modal only prevents the browser's
// own close. The logic stays DOM-light so it is regression-testable.

const TRANSIENT_SURFACES = ".menu, .select-menu-list";

const stack = [];
let listening = false;

function handleEscapeKey(event) {
	if (event?.key !== "Escape") return;
	// An open menu or select listbox (or similar transient surface) consumes the
	// Escape first, so closing a select inside a dialog leaves the dialog open.
	if (typeof document !== "undefined" && document.querySelector && document.querySelector(TRANSIENT_SURFACES)) return;
	const top = stack[stack.length - 1];
	if (!top) return;
	event.preventDefault?.();
	top.onClose?.();
}

function listen() {
	if (listening || typeof document === "undefined") return;
	document.addEventListener("keydown", handleEscapeKey, true);
	listening = true;
}

export function pushDialog(token) {
	stack.push(token);
	listen();
}

export function popDialog(token) {
	const index = stack.lastIndexOf(token);
	if (index !== -1) stack.splice(index, 1);
}

export function isTopDialog(token) {
	return stack.length > 0 && stack[stack.length - 1] === token;
}

export function dialogStackSize() {
	return stack.length;
}

export { handleEscapeKey };
