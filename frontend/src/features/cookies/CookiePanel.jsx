import { useEffect, useRef, useState } from "react";
import { ConfirmationDialog } from "../../shared/components/ConfirmationDialog.jsx";
import { MaterialIcon } from "../../shared/components/MaterialIcon.jsx";
import { cookieApi } from "./cookie.api.js";
import { cookieBadges, cookieScope, expiryLabel } from "./cookie-summary.js";

export function CookiePanel({ refreshToken = 0 }) {
	const [cookies, setCookies] = useState([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [busyId, setBusyId] = useState(null);
	const [confirmingClear, setConfirmingClear] = useState(false);
	const [clearing, setClearing] = useState(false);
	const requestId = useRef(0);

	useEffect(() => {
		const id = ++requestId.current;
		setLoading(true);
		cookieApi
			.list()
			.then((data) => {
				if (id !== requestId.current) return;
				setCookies(data.cookies ?? []);
				setError("");
			})
			.catch((loadError) => {
				if (id !== requestId.current) return;
				setError(loadError.message);
			})
			.finally(() => {
				if (id === requestId.current) setLoading(false);
			});
	}, [refreshToken]);

	const remove = async (cookieId) => {
		setBusyId(cookieId);
		try {
			await cookieApi.remove(cookieId);
			setCookies((current) => current.filter((cookie) => cookie.id !== cookieId));
			setError("");
		} catch (removeError) {
			setError(removeError.message);
		} finally {
			setBusyId(null);
		}
	};

	const clear = async () => {
		setClearing(true);
		try {
			await cookieApi.clear();
			setCookies([]);
			setConfirmingClear(false);
			setError("");
		} catch (clearError) {
			setError(clearError.message);
		} finally {
			setClearing(false);
		}
	};

	return (
		<div className="sidebar-panel">
			<div className="sidebar-section-label">
				<span>Cookies · {cookies.length}</span>
				<button
					aria-label="Clear this profile's cookie jar"
					className="icon-button small"
					disabled={cookies.length === 0 || clearing}
					title="Clear jar"
					type="button"
					onClick={() => setConfirmingClear(true)}
				>
					<MaterialIcon size={18}>delete_sweep</MaterialIcon>
				</button>
			</div>
			{error && (
				<p className="dialog-error" role="alert">
					{error}
				</p>
			)}
			<div className="sidebar-scroll">
				{loading ? (
					<p className="kv-empty">Loading cookies…</p>
				) : cookies.length === 0 ? (
					<p className="kv-empty">No stored cookies for this profile. Send a request whose response sets a cookie.</p>
				) : (
					<div className="cookie-list">
						{cookies.map((cookie) => (
							<div className="cookie-row" key={cookie.id}>
								<div className="cookie-head">
									<code className="cookie-name">{cookie.name}</code>
									<button
										aria-label={`Delete cookie ${cookie.name}`}
										className="icon-button small"
										disabled={busyId === cookie.id}
										type="button"
										onClick={() => remove(cookie.id)}
									>
										<MaterialIcon size={16}>delete</MaterialIcon>
									</button>
								</div>
								<code className="cookie-value" title={cookie.value}>
									{cookie.value === "" ? "(empty)" : cookie.value}
								</code>
								<div className="cookie-scope">{cookieScope(cookie)}</div>
								<div className="cookie-flags">
									{cookieBadges(cookie).map((badge) => (
										<span className="cookie-badge" key={badge}>
											{badge}
										</span>
									))}
								</div>
								<div className="cookie-scope">{expiryLabel(cookie)}</div>
							</div>
						))}
					</div>
				)}
			</div>
			{confirmingClear && (
				<ConfirmationDialog
					busy={clearing}
					confirmLabel="Clear jar"
					message={`Delete all ${cookies.length} stored cookies for this profile? Future sends will go without them.`}
					title="Clear this cookie jar?"
					onCancel={() => setConfirmingClear(false)}
					onConfirm={clear}
				/>
			)}
		</div>
	);
}
