import { useEffect, useRef, useState } from "react";
import { MaterialIcon } from "./MaterialIcon.jsx";

export function Menu({ items, label = "Open menu", trigger = "more_vert", triggerClassName = "icon-button small" }) {
	const [open, setOpen] = useState(false);
	const reference = useRef(null);
	useEffect(() => {
		if (!open) return undefined;
		const close = (event) => {
			if (!reference.current?.contains(event.target)) setOpen(false);
		};
		const escape = (event) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", close);
		document.addEventListener("keydown", escape);
		return () => {
			document.removeEventListener("pointerdown", close);
			document.removeEventListener("keydown", escape);
		};
	}, [open]);
	return (
		<span className="menu-anchor" ref={reference} style={{ position: "relative", display: "inline-flex" }}>
			<button
				aria-expanded={open}
				aria-haspopup="menu"
				aria-label={label}
				className={triggerClassName}
				type="button"
				onClick={(event) => {
					event.stopPropagation();
					setOpen((current) => !current);
				}}
			>
				<MaterialIcon size={18}>{trigger}</MaterialIcon>
			</button>
			{open && (
				<div className="menu" role="menu" style={{ top: "calc(100% + 4px)", right: 0 }}>
					{items.filter(Boolean).map((item, index) =>
						item.separator ? (
							<div className="menu-separator" key={`separator-${index}`} />
						) : (
							<button
								className={item.danger ? "danger" : ""}
								disabled={item.disabled}
								key={item.label}
								role="menuitem"
								type="button"
								onClick={(event) => {
									event.stopPropagation();
									setOpen(false);
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
