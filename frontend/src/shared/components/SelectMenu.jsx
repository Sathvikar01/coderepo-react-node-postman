import { useEffect, useId, useRef, useState } from "react";
import { MaterialIcon } from "./MaterialIcon.jsx";

export function SelectMenu({ ariaLabel, className = "", disabled = false, id, onChange, options, value }) {
	const [open, setOpen] = useState(false);
	const reference = useRef(null);
	const optionReferences = useRef([]);
	const listId = useId();
	const selected = options.find((option) => String(option.value) === String(value)) || options[0];
	const selectedIndex = Math.max(
		0,
		options.findIndex((option) => String(option.value) === String(value)),
	);
	const openAndFocus = (index = selectedIndex) => {
		setOpen(true);
		requestAnimationFrame(() => optionReferences.current[index]?.focus());
	};
	const closeAndFocusTrigger = () => {
		setOpen(false);
		reference.current?.querySelector('[role="combobox"]')?.focus();
	};
	useEffect(() => {
		if (!open) return undefined;
		const closeOutside = (event) => {
			if (!reference.current?.contains(event.target)) setOpen(false);
		};
		document.addEventListener("pointerdown", closeOutside);
		return () => document.removeEventListener("pointerdown", closeOutside);
	}, [open]);
	const move = (delta) => {
		const focusedIndex = optionReferences.current.findIndex((node) => node === document.activeElement);
		const origin = focusedIndex >= 0 ? focusedIndex : selectedIndex;
		const next = (origin + delta + options.length) % options.length;
		onChange?.(options[next].value);
		requestAnimationFrame(() => optionReferences.current[next]?.focus());
	};
	return (
		<div className={`select-menu ${className}`} ref={reference}>
			<button
				aria-controls={open ? listId : undefined}
				aria-expanded={open}
				aria-haspopup="listbox"
				aria-label={ariaLabel}
				className="select-menu-trigger"
				disabled={disabled}
				id={id}
				role="combobox"
				title={selected?.label}
				type="button"
				onClick={() => (open ? closeAndFocusTrigger() : openAndFocus())}
				onKeyDown={(event) => {
					if (event.key === "ArrowDown") {
						event.preventDefault();
						open ? move(1) : openAndFocus();
					}
					if (event.key === "ArrowUp") {
						event.preventDefault();
						open ? move(-1) : openAndFocus(Math.max(0, options.length - 1));
					}
				}}
			>
				<span className="select-menu-value">{selected?.label ?? ""}</span>
				<MaterialIcon size={18}>{open ? "arrow_drop_up" : "arrow_drop_down"}</MaterialIcon>
			</button>
			{open && (
				<ul className="select-menu-list" id={listId} role="listbox">
					{options.map((option, index) => (
						<li key={String(option.value)}>
							<button
								aria-selected={String(option.value) === String(value)}
								className={`select-menu-option ${String(option.value) === String(value) ? "selected" : ""}`}
								ref={(node) => {
									optionReferences.current[index] = node;
								}}
								role="option"
								type="button"
								onClick={() => {
									onChange?.(option.value);
									closeAndFocusTrigger();
								}}
								onKeyDown={(event) => {
									if (event.key === "Escape") {
										event.preventDefault();
										closeAndFocusTrigger();
									}
									if (event.key === "ArrowDown") {
										event.preventDefault();
										move(1);
									}
									if (event.key === "ArrowUp") {
										event.preventDefault();
										move(-1);
									}
								}}
							>
								<span>{option.label}</span>
								{option.hint && <small>{option.hint}</small>}
								{String(option.value) === String(value) && <MaterialIcon size={16}>check</MaterialIcon>}
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
