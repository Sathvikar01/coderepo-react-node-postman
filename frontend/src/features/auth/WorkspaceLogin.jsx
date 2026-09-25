import { useState } from "react";
import { TracerSymbol } from "../../shared/components/TracerBrand.jsx";

export function WorkspaceLogin({ error = "", loading = false, onLogin = () => {} }) {
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const submit = (event) => {
		event.preventDefault();
		onLogin(email.trim(), password);
	};
	return (
		<main className="workspace-login-page">
			<section aria-labelledby="workspace-login-title" className="workspace-login-card">
				<div className="workspace-login-mark">
					<span className="brand-mark">
						<TracerSymbol size={26} />
					</span>
				</div>
				<h1 id="workspace-login-title">Sign in</h1>
				<p className="workspace-login-subtitle">to continue to Tracer</p>
				<form onSubmit={submit}>
					<div className="outlined-input">
						<input
							autoComplete="username"
							disabled={loading}
							id="workspace-email"
							inputMode="email"
							placeholder=" "
							required
							type="email"
							value={email}
							onChange={(event) => setEmail(event.target.value)}
						/>
						<label htmlFor="workspace-email">Email</label>
					</div>
					<div className="outlined-input">
						<input
							autoComplete="current-password"
							disabled={loading}
							id="workspace-password"
							name="password"
							placeholder=" "
							required
							type="password"
							value={password}
							onChange={(event) => setPassword(event.target.value)}
						/>
						<label htmlFor="workspace-password">Password</label>
					</div>
					{error && (
						<p className="workspace-login-error" role="alert">
							{error}
						</p>
					)}
					<aside className="workspace-login-hint">
						Seeded demo sign-in: <strong>alex.morgan@example.test</strong> with password <strong>password123</strong>. This
						account exists only for local evaluation.
					</aside>
					<div className="workspace-login-actions">
						<button className="primary-button" disabled={loading} type="submit">
							{loading ? "Signing in…" : "Next"}
						</button>
					</div>
				</form>
			</section>
			<footer className="workspace-login-footer">
				<span>English (United States)</span>
				<span>Local evaluation build</span>
			</footer>
		</main>
	);
}
