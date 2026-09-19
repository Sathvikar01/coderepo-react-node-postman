import { useMemo, useState } from "react";

const LINES_PER_PAGE = 500;
const MAX_LINE_CHARS = 2000;

function chunkLine(line) {
	if (line.length <= MAX_LINE_CHARS) return [line];
	const chunks = [];
	for (let index = 0; index < line.length; index += MAX_LINE_CHARS) chunks.push(line.slice(index, index + MAX_LINE_CHARS));
	return chunks;
}

export function RawView({ search = "", text = "" }) {
	const [page, setPage] = useState(0);
	const lines = useMemo(() => text.split(/\r?\n/).flatMap(chunkLine), [text]);
	const pages = Math.max(1, Math.ceil(lines.length / LINES_PER_PAGE));
	const current = Math.min(page, pages - 1);
	const visible = lines.slice(current * LINES_PER_PAGE, (current + 1) * LINES_PER_PAGE);
	const needle = search.trim().toLowerCase();
	return (
		<div className="raw-view">
			{needle && (
				<p className="field-hint">
					{lines.filter((line) => line.toLowerCase().includes(needle)).length} matching line(s) for “{search.trim()}”.
				</p>
			)}
			<pre>
				{visible.map((line, index) => {
					const matchIndex = needle ? line.toLowerCase().indexOf(needle) : -1;
					return (
						<div key={`${current}-${index}`}>
							{matchIndex === -1 || !needle ? (
								line || " "
							) : (
								<>
									{line.slice(0, matchIndex)}
									<mark>{line.slice(matchIndex, matchIndex + needle.length)}</mark>
									{line.slice(matchIndex + needle.length)}
								</>
							)}
						</div>
					);
				})}
			</pre>
			{pages > 1 && (
				<div className="raw-pager">
					<button className="text-button" disabled={current === 0} type="button" onClick={() => setPage(current - 1)}>
						Previous
					</button>
					<span>
						Lines {current * LINES_PER_PAGE + 1}–{Math.min(lines.length, (current + 1) * LINES_PER_PAGE)} of {lines.length}
					</span>
					<button className="text-button" disabled={current >= pages - 1} type="button" onClick={() => setPage(current + 1)}>
						Next
					</button>
				</div>
			)}
		</div>
	);
}
