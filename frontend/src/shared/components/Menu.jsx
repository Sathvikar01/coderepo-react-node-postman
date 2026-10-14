import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MaterialIcon } from "./MaterialIcon.jsx";
import { menuPlacement, menuPlacementStyle } from "./menu-placement.js";

const enabledItems = (menu) => [...(menu?.querySelectorAll('[role="menuitem"]:not(:disabled)') ?? [])];

export function Menu({
	items,
	label = "Open menu",
	side = "bottom",
	trigger = "more_vert",
	triggerClassName = "icon-button small",
}) {
	const [open, setOpen] = useState(false);
	const [placement, setPlacement] = useState(null);
	const reference = useRef(null);
	const triggerReference = useRef(null);
	const menuReference = useRef(null);
	// "first" or "last" when the menu was opened from the keyboard and focus
	// should move into it once it has been placed.
	const pendingFocus = useRef(null);

	const close = ({ restoreFocus = false } = {}) => {
		setOpen(false);
		if (restoreFocus) triggerReference.current?.focus();
	};

	const openMenu = (focusTarget = null) => {
		pendingFocus.current = focusTarget;
		setOpen(true);
	};

	useLayoutEffect(() => {
		if (!open) {
			setPlacement(null);
			return;
		}
		const menu = menuReference.current;
		const triggerNode = triggerReference.current;
		if (!menu || !triggerNode) return;
		setPlacement(
			menuPlacement(
				triggerNode.getBoundingClientRect(),
				{ width: menu.offsetWidth, height: menu.scrollHeight },
				{ width: window.innerWidth, height: window.innerHeight },
				side,
			),
		);
	}, [open, side]);

	useEffect(() => {
		if (!open || !placement || !pendingFocus.current) return;
		const candidates = enabledItems(menuReference.current);
		(pendingFocus.current === "last" ? candidates.at(-1) : candidates[0])?.focus();
		pendingFocus.current = null;
	}, [open, placement]);

	useEffect(() => {
		if (!open) return undefined;
		const closeOutside = (event) => {
			if (!reference.current?.contains(event.target)) setOpen(false);
		};
		const escape = (event) => {
			if (event.key !== "Escape") return;
			close({ restoreFocus: Boolean(menuReference.current?.contains(document.activeElement)) });
		};
		// The placement is measured once on open; a resize would leave it stale.
		const dismiss = () => setOpen(false);
		document.addEventListener("pointerdown", closeOutside);
		document.addEventListener("keydown", escape);
		window.addEventListener("resize", dismiss);
		return () => {
			document.removeEventListener("pointerdown", closeOutside);
			document.removeEventListener("keydown", escape);
			window.removeEventListener("resize", dismiss);
		};
	}, [open]);

	const moveFocus = (event) => {
		if (event.key === "Tab") {
			setOpen(false);
			return;
		}
		const candidates = enabledItems(menuReference.current);
		const index = candidates.indexOf(document.activeElement);
		const next = {
			ArrowDown: candidates[(index + 1) % candidates.length],
			ArrowUp: candidates[(index - 1 + candidates.length) % candidates.length],
			Home: candidates[0],
			End: candidates.at(-1),
		}[event.key];
		if (next) {
			event.preventDefault();
			next.focus();
		}
	};

	return (
		<span className="menu-anchor" ref={reference} style={{ position: "relative", display: "inline-flex" }}>
			<button
				aria-expanded={open}
				aria-haspopup="menu"
				aria-label={label}
				className={triggerClassName}
				ref={triggerReference}
				type="button"
				onClick={(event) => {
					event.stopPropagation();
					// Enter/Space report click detail 0; the menu-button pattern then moves
					// focus to the first item.
					if (open) close();
					else openMenu(event.detail === 0 ? "first" : null);
				}}
				onKeyDown={(event) => {
					if (event.key === "ArrowDown" || event.key === "ArrowUp") {
						event.preventDefault();
						openMenu(event.key === "ArrowDown" ? "first" : "last");
					}
				}}
			>
				<MaterialIcon size={18}>{trigger}</MaterialIcon>
			</button>
			{open && (
				<div
					aria-label={label}
					className="menu"
					ref={menuReference}
					role="menu"
					style={menuPlacementStyle(placement)}
					onKeyDown={moveFocus}
				>
					{items.filter(Boolean).map((item, index) =>
						item.separator ? (
							<div className="menu-separator" key={`separator-${index}`} role="separator" />
						) : (
							<button
								className={item.danger ? "danger" : ""}
								disabled={item.disabled}
								key={item.label}
								role="menuitem"
								tabIndex={-1}
								type="button"
								onClick={(event) => {
									event.stopPropagation();
									// Focus goes back to the trigger first, so a dialog this item opens
									// returns focus there when it closes.
									close({ restoreFocus: true });
									item.onSelect?.();
								}}
							>
								{item.icon && <MaterialIcon size={18}>{item.icon}</MaterialIcon>}
								{item.label}
							</button>
						),
					)}
				</div>
			)}
		</span>
	);
}
