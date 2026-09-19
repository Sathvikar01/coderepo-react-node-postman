import { MaterialIcon } from "../../shared/components/MaterialIcon.jsx";

const newRow = () => ({ id: crypto.randomUUID(), key: "", value: "", enabled: true });

export function KeyValueEditor({ label, onChange, rows = [], keyPlaceholder = "Key", valuePlaceholder = "Value" }) {
	const update = (id, patch) => onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
	const remove = (id) => onChange(rows.filter((row) => row.id !== id));
	const move = (index, delta) => {
		const next = [...rows];
		const target = index + delta;
		if (target < 0 || target >= next.length) return;
		[next[index], next[target]] = [next[target], next[index]];
		onChange(next);
	};
	return (
		<div className="kv-editor" role="group" aria-label={label}>
			<div className="kv-head" aria-hidden="true">
				<span />
				<span>{keyPlaceholder}</span>
				<span>{valuePlaceholder}</span>
				<span />
			</div>
			{rows.length === 0 && <p className="kv-empty">No {label.toLowerCase()} yet. Add a row to include one in the request.</p>}
			{rows.map((row, index) => (
				<div className="kv-row" key={row.id}>
					<label className="kv-check">
						<input
							aria-label={`Include ${row.key || `row ${index + 1}`}`}
							checked={row.enabled}
							type="checkbox"
							onChange={(event) => update(row.id, { enabled: event.target.checked })}
						/>
					</label>
					<input
						aria-label={`${keyPlaceholder} ${index + 1}`}
						placeholder={keyPlaceholder}
						type="text"
						value={row.key}
						onChange={(event) => update(row.id, { key: event.target.value })}
					/>
					<input
						aria-label={`${valuePlaceholder} ${index + 1}`}
						placeholder={valuePlaceholder}
						type="text"
						value={row.value}
						onChange={(event) => update(row.id, { value: event.target.value })}
					/>
					<span className="field-row" style={{ gap: 0 }}>
						<button
							aria-label="Move row up"
							className="icon-button small"
							disabled={index === 0}
							type="button"
							onClick={() => move(index, -1)}
						>
							<MaterialIcon size={16}>expand_less</MaterialIcon>
						</button>
						<button aria-label="Remove row" className="icon-button small" type="button" onClick={() => remove(row.id)}>
							<MaterialIcon size={16}>close</MaterialIcon>
						</button>
					</span>
				</div>
			))}
			<div>
				<button className="text-button" type="button" onClick={() => onChange([...rows, newRow()])}>
					<MaterialIcon size={16}>add</MaterialIcon> Add row
				</button>
			</div>
		</div>
	);
}
