export function TracerSymbol({ size = 32, tone = "brand" }) {
	const color = tone === "bone" ? "var(--ink-strong)" : "var(--brand)";
	return (
		<svg aria-hidden="true" className="tracer-symbol" height={size} viewBox="0 0 32 32" width={size}>
			<path
				d="M3 20h6.5l4-11 6.5 18 4-11H29"
				fill="none"
				stroke={color}
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="3.2"
			/>
			<circle cx="29" cy="16" fill={color} r="2.6" />
		</svg>
	);
}
