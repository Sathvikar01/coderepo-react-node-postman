import { MaterialIcon } from "../../shared/components/MaterialIcon.jsx";
import { SelectMenu } from "../../shared/components/SelectMenu.jsx";
import {
	ASSERTION_LIMIT,
	ASSERTION_OPERATORS,
	ASSERTION_TARGETS,
	ASSERTION_VALUE_TYPES,
	describeAssertion,
	newAssertion,
	operatorDefaults,
	targetDefaults,
} from "./assertions.js";

const usesPath = (target) => target === "header" || target === "json";
const usesExpected = (assertion) => {
	if (assertion.target === "status") return assertion.operator === "equals";
	if (assertion.target === "header") return assertion.operator !== "exists";
	if (assertion.target === "json") return assertion.operator === "equals";
	return true;
};
const expectedLabel = (target) => (target === "status" ? "Status code" : target === "header" ? "Header value" : "Expected value");

export function AssertionEditor({ assertions, onChange }) {
	const rows = Array.isArray(assertions) ? assertions : [];
	const update = (id, patch) => onChange(rows.map((assertion) => (assertion.id === id ? { ...assertion, ...patch } : assertion)));
	const remove = (id) => onChange(rows.filter((assertion) => assertion.id !== id));
	return (
		<div className="assertion-editor" role="group" aria-label="Assertions">
			<p className="field-hint">
				Assertions run after a response arrives and record a deterministic pass, fail, or error. They never change the sent request
				or the stored result.
			</p>
			{rows.length === 0 && <p className="kv-empty">No assertions yet. Add one to check the status, headers, body, or JSON of a response.</p>}
			{rows.map((assertion, index) => (
				<div className="assertion-row" key={assertion.id}>
					<div className="assertion-row-top">
						<label className="kv-check">
							<input
								aria-label={`Include assertion ${index + 1}`}
								checked={assertion.enabled !== false}
								type="checkbox"
								onChange={(event) => update(assertion.id, { enabled: event.target.checked })}
							/>
						</label>
						<input
							aria-label={`Assertion ${index + 1} name`}
							className="assertion-name"
							placeholder="Assertion name"
							type="text"
							value={assertion.name}
							onChange={(event) => update(assertion.id, { name: event.target.value })}
						/>
						<span className="assertion-summary">{describeAssertion(assertion)}</span>
						<button aria-label={`Remove assertion ${index + 1}`} className="icon-button small" type="button" onClick={() => remove(assertion.id)}>
							<MaterialIcon size={16}>close</MaterialIcon>
						</button>
					</div>
					<div className="assertion-row-fields">
						<SelectMenu
							ariaLabel={`Assertion ${index + 1} target`}
							className="assertion-select"
							options={ASSERTION_TARGETS}
							value={assertion.target}
							onChange={(target) => update(assertion.id, { target, ...targetDefaults(target) })}
						/>
						<SelectMenu
							ariaLabel={`Assertion ${index + 1} operator`}
							className="assertion-select"
							options={ASSERTION_OPERATORS[assertion.target] ?? []}
							value={assertion.operator}
							onChange={(operator) => update(assertion.id, { operator, ...operatorDefaults({ ...assertion, operator }) })}
						/>
						{usesPath(assertion.target) && (
							<input
								aria-label={`Assertion ${index + 1} ${assertion.target === "header" ? "header name" : "JSON path"}`}
								className="assertion-path"
								placeholder={assertion.target === "header" ? "X-Header-Name" : "data.items[0].id"}
								type="text"
								value={assertion.path}
								onChange={(event) => update(assertion.id, { path: event.target.value })}
							/>
						)}
						{assertion.target === "status" && assertion.operator === "range" ? (
							<>
								<input
									aria-label={`Assertion ${index + 1} minimum status`}
									className="assertion-number"
									max={599}
									min={100}
									type="number"
									value={assertion.min ?? 200}
									onChange={(event) => update(assertion.id, { min: Number(event.target.value) })}
								/>
								<span className="assertion-dash" aria-hidden="true">to</span>
								<input
									aria-label={`Assertion ${index + 1} maximum status`}
									className="assertion-number"
									max={599}
									min={100}
									type="number"
									value={assertion.max ?? 299}
									onChange={(event) => update(assertion.id, { max: Number(event.target.value) })}
								/>
							</>
						) : (
							usesExpected(assertion) && (
								<>
									{assertion.target === "json" && (
										<SelectMenu
											ariaLabel={`Assertion ${index + 1} value type`}
											className="assertion-select"
											options={ASSERTION_VALUE_TYPES}
											value={assertion.valueType}
											onChange={(valueType) => update(assertion.id, { valueType })}
										/>
									)}
									{!(assertion.target === "json" && assertion.valueType === "null") && (
										<input
											aria-label={`Assertion ${index + 1} ${expectedLabel(assertion.target)}`}
											className="assertion-expected"
											placeholder={expectedLabel(assertion.target)}
											type="text"
											value={assertion.expected}
											onChange={(event) => update(assertion.id, { expected: event.target.value })}
										/>
									)}
								</>
							)
						)}
					</div>
				</div>
			))}
			<div>
				<button
					className="text-button"
					disabled={rows.length >= ASSERTION_LIMIT}
					type="button"
					onClick={() => onChange([...rows, newAssertion()])}
				>
					<MaterialIcon size={16}>add</MaterialIcon> Add assertion
				</button>
				{rows.length >= ASSERTION_LIMIT && <span className="field-hint">A request may define at most {ASSERTION_LIMIT} assertions.</span>}
			</div>
		</div>
	);
}
